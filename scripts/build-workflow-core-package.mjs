#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = join(repoRoot, 'packages', 'workflow-core');
const sourceDir = join(packageDir, 'src');
const distDir = join(packageDir, 'dist');
const packageRequire = createRequire(join(packageDir, 'package.json'));
const { build } = packageRequire('esbuild');
const entryNames = [
  'index',
  'schema',
  'engine',
  'control',
  'gate-policy',
  'host-contract',
  'runtime',
  'events',
  'host-bindings',
];
const entryPoints = Object.fromEntries(
  entryNames.map((name) => [name, join(sourceDir, `${name}.ts`)]),
);

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

const common = {
  bundle: true,
  entryPoints,
  legalComments: 'none',
  logLevel: 'warning',
  platform: 'node',
  sourcemap: true,
  target: 'node22',
  treeShaking: true,
};

const [esmResult, cjsResult] = await Promise.all([
  build({
    ...common,
    format: 'esm',
    metafile: true,
    outdir: join(distDir, 'esm'),
  }),
  build({
    ...common,
    format: 'cjs',
    metafile: true,
    outdir: join(distDir, 'cjs'),
    outExtension: { '.js': '.cjs' },
  }),
]);

assertNoBundledThirdPartyModules(esmResult.metafile);
assertNoBundledThirdPartyModules(cjsResult.metafile);
assertNoBotmuxRuntimeAdapters(esmResult.metafile);
assertNoBotmuxRuntimeAdapters(cjsResult.metafile);

const tscPath = packageRequire.resolve('typescript/bin/tsc');
const declarations = spawnSync(
  process.execPath,
  [tscPath, '-p', join(packageDir, 'tsconfig.build.json')],
  { cwd: repoRoot, encoding: 'utf-8' },
);
if (declarations.status !== 0) {
  process.stderr.write(declarations.stdout);
  process.stderr.write(declarations.stderr);
  process.exit(declarations.status ?? 1);
}

await pruneTypeDeclarations();
await assertTypeBoundary();
await assertExportTargetsExist();
console.log(`[workflow-core] built ${entryNames.length} exports in ${distDir}`);

function assertNoBundledThirdPartyModules(metafile) {
  const bundled = Object.keys(metafile.inputs).filter((input) => input.includes('node_modules/'));
  if (bundled.length > 0) {
    throw new Error(
      `workflow-core must have zero bundled third-party runtime modules:\n${bundled.join('\n')}`,
    );
  }
}

function assertNoBotmuxRuntimeAdapters(metafile) {
  const forbidden = [
    '/src/adapters/',
    '/src/core/session-marker.ts',
    '/src/im/',
    '/src/workflows/v3/botmux-host-policy.ts',
    '/src/workflows/v3/daemon-run.ts',
    '/src/workflows/v3/ephemeral-pool.ts',
    '/src/workflows/v3/host.ts',
    '/src/workflows/v3/human-gate.ts',
    '/src/workflows/v3/runtime.ts',
    '/src/workflows/v3/worker-fence.ts',
  ];
  const contaminated = Object.keys(metafile.inputs).filter((input) => {
    const normalized = `/${input.replaceAll('\\', '/')}`;
    return forbidden.some((segment) => normalized.includes(segment));
  });
  if (contaminated.length > 0) {
    throw new Error(
      `workflow-core must not bundle daemon, Lark, session, or worker adapters:\n${contaminated.join('\n')}`,
    );
  }
}

async function pruneTypeDeclarations() {
  const typeRoot = join(distDir, 'types');
  const queue = entryNames.map((name) =>
    join(typeRoot, 'packages', 'workflow-core', 'src', `${name}.d.ts`)
  );
  const reachable = new Set();
  while (queue.length > 0) {
    const declaration = queue.pop();
    if (!declaration || reachable.has(declaration)) continue;
    const content = await readFile(declaration, 'utf-8');
    reachable.add(declaration);
    for (const specifier of relativeDeclarationSpecifiers(content)) {
      const target = resolveDeclarationSpecifier(declaration, specifier);
      if (!target.startsWith(`${typeRoot}${sep}`)) {
        throw new Error(`workflow-core declaration escapes type root: ${target}`);
      }
      queue.push(target);
    }
  }
  for (const file of await walk(typeRoot)) {
    if (file.endsWith('.d.ts') && !reachable.has(file)) {
      await rm(file);
    }
  }
  await rm(join(distDir, 'workflow-core.tsbuildinfo'), { force: true });
}

function relativeDeclarationSpecifiers(content) {
  const specifiers = new Set();
  const patterns = [
    /(?:from\s+|import\s*\()\s*['"](\.[^'"]+)['"]/g,
    /^\s*import\s*['"](\.[^'"]+)['"]/gm,
    /<reference\s+path=['"](\.[^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) specifiers.add(match[1]);
  }
  return specifiers;
}

function resolveDeclarationSpecifier(importer, specifier) {
  if (specifier.endsWith('.js')) {
    return resolve(dirname(importer), `${specifier.slice(0, -3)}.d.ts`);
  }
  if (specifier.endsWith('.d.ts')) return resolve(dirname(importer), specifier);
  return resolve(dirname(importer), `${specifier}.d.ts`);
}

async function assertTypeBoundary() {
  const typeRoot = join(distDir, 'types');
  const allowedSourceDeclarations = new Set([
    'src/workflows/v3/artifact-contract.d.ts',
    'src/workflows/v3/core-control.d.ts',
    'src/workflows/v3/dag.d.ts',
    'src/workflows/v3/event-contract.d.ts',
    'src/workflows/v3/gate-policy.d.ts',
    'src/workflows/v3/host-bindings.d.ts',
    'src/workflows/v3/in-process-attempt-lease.d.ts',
    'src/workflows/v3/orchestrator.d.ts',
    'src/workflows/v3/portable-final-outputs.d.ts',
    'src/workflows/v3/portable-runtime.d.ts',
    'src/workflows/v3/runtime-host-contract.d.ts',
    'src/workflows/v3/shared-runtime.d.ts',
  ]);
  const unexpected = (await walk(typeRoot))
    .filter((file) => file.endsWith('.d.ts'))
    .map((file) => relative(typeRoot, file).replaceAll('\\', '/'))
    .filter((file) =>
      file.startsWith('src/') && !allowedSourceDeclarations.has(file)
    );
  if (unexpected.length > 0) {
    throw new Error(
      `workflow-core public declarations crossed the supported boundary:\n${unexpected.join('\n')}`,
    );
  }
}

async function assertExportTargetsExist() {
  const packageJson = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf-8'));
  const targets = [];
  for (const value of Object.values(packageJson.exports)) {
    if (typeof value === 'string') continue;
    targets.push(value.types, value.import, value.require);
  }
  const files = new Set(await walk(distDir));
  const missing = targets
    .filter(Boolean)
    .map((target) => resolve(packageDir, target))
    .filter((target) => !files.has(target));
  if (missing.length > 0) {
    throw new Error(`workflow-core export target(s) missing:\n${missing.join('\n')}`);
  }
}

async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else files.push(path);
  }
  return files;
}
