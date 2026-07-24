/**
 * Shared "is this session a stopped zombie?" predicate — the same notion the
 * `botmux delete stopped` CLI subcommand uses (dead CLI process + no tmux pane),
 * factored out so the host-overload alert's "清僵尸" button can reuse the exact
 * semantics server-side without duplicating (or drifting from) the CLI logic.
 *
 * A zombie = a session the store still marks `active`, but whose CLI process is
 * gone and has no backing tmux session — i.e. nothing is actually running, it's
 * just a stale record holding a slot. Intentionally-suspended sessions are NOT
 * zombies: they're worker-less on purpose and cold-resume on the next message,
 * so callers must gate on `status === 'active'` (suspended sessions also read
 * as active in the store, so this predicate additionally requires the process
 * to be truly dead — a suspended session that still has a live detached CLI
 * would fail the pid/tmux check and be preserved).
 */
import { execFileSync } from 'node:child_process';
import type { Session } from '../types.js';

/** Liveness check for an arbitrary pid without signalling it (signal 0). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM = exists but not ours to signal (still alive); ESRCH = gone.
    return err?.code === 'EPERM';
  }
}

/** True when a `bmx-<prefix>` tmux session exists. Best-effort; tmux missing
 *  or any error → treated as "no pane". */
export function tmuxSessionExists(name: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', name], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function adoptedCliPid(s: Session): number | undefined {
  const pid = s.adoptedFrom && typeof s.adoptedFrom === 'object'
    ? (s.adoptedFrom as { originalCliPid?: number }).originalCliPid
    : undefined;
  return typeof pid === 'number' && pid > 0 ? pid : undefined;
}

/**
 * True when a session record is a stopped zombie: no live CLI process and no
 * tmux pane. Mirrors cli.ts `delete stopped`. For adopted sessions the original
 * CLI pid is authoritative (we never spawned a botmux worker); for normal
 * sessions, both the recorded worker pid and the `bmx-<id8>` tmux pane must be
 * dead. Caller is responsible for the `status === 'active'` gate.
 */
export function isSessionStopped(s: Session): boolean {
  const originalPid = adoptedCliPid(s);
  if (originalPid !== undefined) {
    return !isProcessAlive(originalPid);
  }
  const hasPid = !!(s.pid && isProcessAlive(s.pid));
  const hasTmux = tmuxSessionExists(`bmx-${s.sessionId.substring(0, 8)}`);
  return !hasPid && !hasTmux;
}
