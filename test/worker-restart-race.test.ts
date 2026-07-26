/**
 * worker.ts is a process entrypoint (installs IPC/signal handlers on import),
 * so — like worker-durable-expiry-order.test.ts — pin the exact wiring of
 * PR #507's two restart-race fixes by asserting source structure. The pure
 * decision they feed is executed in restart-followup-policy.test.ts; these
 * assertions guard the ordering/guards that a refactor could silently break.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

function restartCaseBranch(): string {
  const start = workerSource.indexOf("case 'restart': {");
  const end = workerSource.indexOf("case 'expire_durable_turn':", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return workerSource.slice(start, end);
}

describe('worker restart P1 — drain reliable terminal before ambiguous emit', () => {
  it('the restart case drains BEFORE emitting ambiguous for an in-flight durable turn', () => {
    const branch = restartCaseBranch();
    const durableGuard = branch.indexOf('if (durableTurnInFlight)');
    const drain = branch.indexOf('drainReliableTerminalBeforeInterrupt()', durableGuard);
    const emit = branch.indexOf("emitTurnTerminal(currentBotmuxTurnId, 'ambiguous'", drain);
    expect(durableGuard).toBeGreaterThanOrEqual(0);
    expect(drain).toBeGreaterThan(durableGuard);
    // drain must precede the ambiguous emit so an already-persisted completed
    // claims the deduper first (else a just-completed turn is re-dispatchable).
    expect(emit).toBeGreaterThan(drain);
  });

  it('the shared drain helper is gated on reliableTurnTerminal (matches onExit)', () => {
    const fn = workerSource.indexOf('function drainReliableTerminalBeforeInterrupt');
    expect(fn).toBeGreaterThanOrEqual(0);
    const body = workerSource.slice(fn, fn + 600);
    expect(body).toContain("cliAdapter?.reliableTurnTerminal !== true");
    expect(body).toContain('bridgeDrainAndMaybeEmit()');
    expect(body).toContain('codexBridgeDrainAndMaybeEmit');
  });

  it('onExit reuses the same shared drain helper (no divergent duplicate)', () => {
    // Both the CLI onExit path and the restart IPC path must drain identically;
    // the shared helper is the single source, so onExit calls it too.
    const onExitAmbiguous = workerSource.indexOf("'ambiguous',\n        'cli_exit'");
    expect(onExitAmbiguous).toBeGreaterThan(0);
    const before = workerSource.slice(onExitAmbiguous - 400, onExitAmbiguous);
    expect(before).toContain('drainReliableTerminalBeforeInterrupt()');
  });
});

describe('worker restart P2 — merge guard preserves replacement-exit recovery', () => {
  it('the merge guard arms pendingRestartAfterInFlight instead of silently dropping', () => {
    const branch = restartCaseBranch();
    const guard = branch.indexOf('if (cliRestartInProgress || tmuxRestartTimer)');
    const arm = branch.indexOf('pendingRestartAfterInFlight = true', guard);
    const brk = branch.indexOf('break;', arm);
    expect(guard).toBeGreaterThanOrEqual(0);
    // arm the follow-up flag before breaking out — otherwise a replacement that
    // died during the in-flight window loses its daemon auto-restart.
    expect(arm).toBeGreaterThan(guard);
    expect(brk).toBeGreaterThan(arm);
  });

  it('restartCliProcess consumes the flag at entry so only in-window requests count', () => {
    const start = workerSource.indexOf('async function restartCliProcess');
    const body = workerSource.slice(start, start + 1200);
    expect(body).toContain('pendingRestartAfterInFlight = false');
  });

  it('the continuation feeds backend liveness + armed flag into decideRestartFollowup', () => {
    const start = workerSource.indexOf('async function restartCliProcess');
    const end = workerSource.indexOf('// ─── HTTP', start);
    const body = workerSource.slice(start, end);
    const decide = body.indexOf('decideRestartFollowup({');
    expect(decide).toBeGreaterThan(0);
    const call = body.slice(decide, decide + 320);
    expect(call).toContain('backendAlive: !!backend');
    expect(call).toContain('restartRequestedDuringInFlight: pendingRestartAfterInFlight');
    expect(call).toContain('currentWorkingDir: lastInitConfig?.workingDir');
  });
});
