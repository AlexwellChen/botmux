import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

describe('worker app-runner control-channel wiring', () => {
  it('uses the bounded decoder and resets it with worker turn state', () => {
    expect(workerSource).toContain('const appRunnerControlDecoder = new RunnerControlDecoder();');
    expect(workerSource).toContain('return appRunnerControlDecoder.push(');
    expect(workerSource).toContain('appRunnerControlDecoder.reset();');
    expect(workerSource).not.toContain('codexAppOscPending');
  });

  it('rejects marker identity mismatches and keeps dispatch authority worker-owned', () => {
    expect(workerSource).toContain('if (!identity.ok)');
    expect(workerSource).toContain('payload.dispatchAttempt !== currentBotmuxDispatchAttempt');
    expect(workerSource).toContain('const dispatchAttempt = currentBotmuxDispatchAttempt;');
    expect(workerSource).not.toContain('const dispatchAttempt = payload.dispatchAttempt');
  });

  it('keeps stale-busy normal and raw input queued until replacement readiness', () => {
    const flushStart = workerSource.indexOf('async function flushPending(): Promise<void>');
    const rawInputCase = workerSource.indexOf("case 'raw_input':");
    const normalInputGate = workerSource.indexOf(
      'holdForRunnerReload: shouldHoldCodexRunnerInput(codexRunnerFreshness)',
    );

    expect(workerSource.slice(flushStart, flushStart + 800)).toContain(
      'if (shouldHoldCodexRunnerInput(codexRunnerFreshness)) return;',
    );
    expect(workerSource.slice(rawInputCase, rawInputCase + 1_500)).toContain(
      'shouldHoldCodexRunnerInput(codexRunnerFreshness)',
    );
    expect(normalInputGate).toBeGreaterThan(0);
    expect(workerSource).toContain(
      "pendingRawInputs.push(msg);",
    );
    expect(workerSource).toContain(
      "void restartCliProcess('stale runner reached idle', { immediate: true, preservePending: true });",
    );
  });
});
