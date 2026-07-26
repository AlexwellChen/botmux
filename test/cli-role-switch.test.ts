import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** 角色切换命令 `botmux role switch <目录>`（第一次上线，未保留旧 `botmux cd` 别名——
 *  干净迭代）：daemon 侧硬校验目录必须在 ~/botmux-roles 下，名字→目录的解析由调用方
 *  （模型读 _role-protocol.md）完成。这里用 spawn 冒烟锁住：帮助文本主推 role switch、
 *  role switch 用法文案带自己的命令名、旧 `botmux cd` 不再是已识别命令。真实切换需活跃
 *  daemon（自识别会话 → cd 路由 → 角色库校验 → respawn），属 live 验证范畴。 */
function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const home = mkdtempSync(join(tmpdir(), 'botmux-role-switch-'));
  try {
    const env = { ...process.env, HOME: home };
    delete env.BOTMUX_WORKFLOW;
    try {
      const stdout = execFileSync(
        process.execPath,
        ['--import', 'tsx', fileURLToPath(new URL('../src/cli.ts', import.meta.url)), ...args],
        { cwd: process.cwd(), env, encoding: 'utf-8' },
      );
      return { status: 0, stdout, stderr: '' };
    } catch (err: any) {
      // 非零退出（如缺参数用法提示 / 未知命令回退帮助）：execFileSync 抛异常，仍取输出。
      return {
        status: typeof err?.status === 'number' ? err.status : 1,
        stdout: err?.stdout?.toString() ?? '',
        stderr: err?.stderr?.toString() ?? '',
      };
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('botmux role switch (角色切换命令)', () => {
  it('根帮助收录 role switch 且不再出现 cd 作为角色切换命令', () => {
    const { stdout } = runCli(['--help']);
    expect(stdout).toContain('role switch <目录>');
    // cd 别名已移除：帮助里不应再把 cd 当作角色切换入口。
    expect(stdout).not.toContain('cd <目录>');
    expect(stdout).not.toContain('role switch 的别名');
  });

  it('role switch 缺目录 → 用法提示带 "role switch" 命令名', () => {
    const { status, stderr } = runCli(['role', 'switch']);
    expect(status).toBe(1);
    expect(stderr).toContain('botmux role switch <');
  });

  it('role 无子命令 / 未知子命令 → 落到 role switch 用法', () => {
    expect(runCli(['role']).stderr).toContain('botmux role switch <');
    expect(runCli(['role', 'bogus']).stderr).toContain('botmux role switch <');
  });

  it('旧 botmux cd 已不再是已识别命令（回退到根帮助，不执行角色切换）', () => {
    const { stdout, stderr } = runCli(['cd', '~/botmux-roles/x']);
    // 未知命令回退根帮助横幅；绝不能命中角色切换用法（证明 cd 分支确已移除）。
    const combined = stdout + stderr;
    expect(combined).not.toContain('botmux cd <');
    expect(combined).not.toContain('切换被拒绝');
  });
});
