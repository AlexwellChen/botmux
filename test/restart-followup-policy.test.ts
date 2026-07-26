import { describe, expect, it } from 'vitest';

import { decideRestartFollowup } from '../src/core/restart-followup-policy.js';

/**
 * Pure decision for whether an in-flight restart must chain another. This is
 * the executable core of PR #507's two restart-race fixes:
 *  - cwd-move convergence (2nd commit): a role-switch restart landing after the
 *    restartCfg snapshot.
 *  - replacement-exit recovery (Codex P2): the freshly-spawned CLI dying inside
 *    the window cliRestartInProgress still covers (spawnCli +
 *    prepareCodexNativeTitleGeneration) → daemon auto-restart swallowed by the
 *    merge guard → session strands at backend=null without this.
 */
describe('decideRestartFollowup', () => {
  const healthy = {
    spawnedWorkingDir: '/roles/pm',
    currentWorkingDir: '/roles/pm',
    backendAlive: true,
    restartRequestedDuringInFlight: false,
  };

  it('no follow-up on a clean restart (backend alive, cwd unchanged, no request)', () => {
    expect(decideRestartFollowup(healthy)).toEqual({ kind: 'none' });
  });

  it('cwd-move: workingDir diverged after the snapshot → converge, skip FRESH budget', () => {
    const d = decideRestartFollowup({ ...healthy, currentWorkingDir: '/roles/after-sales' });
    expect(d).toEqual({ kind: 'cwd-move', skipRestartBudget: true });
  });

  it('replacement-recovery: backend died in the window → recover, COUNT FRESH budget', () => {
    const d = decideRestartFollowup({ ...healthy, backendAlive: false });
    expect(d).toEqual({ kind: 'replacement-recovery', skipRestartBudget: false });
  });

  it('replacement-recovery: a restart was requested (merge-guard-armed) during the window', () => {
    const d = decideRestartFollowup({ ...healthy, restartRequestedDuringInFlight: true });
    expect(d).toEqual({ kind: 'replacement-recovery', skipRestartBudget: false });
  });

  it('cwd-move wins over replacement-recovery when both hold (cwd must stay authoritative)', () => {
    // A cwd-move respawn whose replacement also died: converge cwd FIRST — the
    // fresh restart it triggers reuses {...lastInitConfig} (new cwd) and its own
    // continuation re-evaluates a still-dead backend. Ordering is load-bearing.
    const d = decideRestartFollowup({
      spawnedWorkingDir: '/roles/pm',
      currentWorkingDir: '/roles/after-sales',
      backendAlive: false,
      restartRequestedDuringInFlight: true,
    });
    expect(d).toEqual({ kind: 'cwd-move', skipRestartBudget: true });
  });

  it('no cwd-move when lastInitConfig was absent (workingDir undefined on either side)', () => {
    // A missing lastInitConfig must never be read as a divergence (undefined !==
    // "/x" would misfire); only two concrete, differing dirs count as a move.
    expect(decideRestartFollowup({
      spawnedWorkingDir: undefined,
      currentWorkingDir: '/roles/pm',
      backendAlive: true,
      restartRequestedDuringInFlight: false,
    })).toEqual({ kind: 'none' });
    expect(decideRestartFollowup({
      spawnedWorkingDir: '/roles/pm',
      currentWorkingDir: undefined,
      backendAlive: true,
      restartRequestedDuringInFlight: false,
    })).toEqual({ kind: 'none' });
  });

  it('backend death still recovers even when workingDir is undefined on both sides', () => {
    expect(decideRestartFollowup({
      spawnedWorkingDir: undefined,
      currentWorkingDir: undefined,
      backendAlive: false,
      restartRequestedDuringInFlight: false,
    })).toEqual({ kind: 'replacement-recovery', skipRestartBudget: false });
  });
});
