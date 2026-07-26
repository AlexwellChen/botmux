/**
 * Worker restart follow-up policy — pure decision for whether an in-flight
 * `restartCliProcess()` must chain one more restart when its continuation
 * completes.
 *
 * Two independent hazards make a single restart insufficient:
 *
 *  1. **cwd-move landed after the config snapshot.** A role-switch `restart`
 *     that arrives after `restartCfg` was snapshotted (but before spawn
 *     finished) updated `lastInitConfig.workingDir` while the CLI is coming up
 *     in the OLD cwd — daemon record and process diverge. Detect by comparing
 *     the workingDir we actually spawned with the current `lastInitConfig`.
 *
 *  2. **The replacement generation exited during the in-flight window.** The
 *     `cliRestartInProgress` gate covers spawnCli() AND the trailing
 *     `prepareCodexNativeTitleGeneration()` (Codex resume + native title ≈
 *     several seconds). If the freshly-spawned CLI dies inside it, its onExit
 *     nulls `backend` and the daemon's auto-restart `restart` IPC is swallowed
 *     by the merge guard (which sets `restartRequestedDuringInFlight`). Either
 *     signal — a null backend (ground truth the replacement is gone) or the
 *     armed flag — must trigger recovery, or the session strands with no CLI
 *     and only a manual `/restart` recovers it.
 *
 * Extracted from worker.ts (a process entrypoint that can't be unit-tested
 * without installing IPC/signal handlers) so the branch order and the
 * budget-skip decision have an executable test surface — the same rationale
 * as inject-queue-policy.ts.
 */
export interface RestartFollowupInput {
  /** workingDir captured into `restartCfg` at spawn time (undefined if lastInitConfig was absent). */
  spawnedWorkingDir: string | undefined;
  /** current lastInitConfig.workingDir after the spawn (undefined if lastInitConfig absent). */
  currentWorkingDir: string | undefined;
  /** false once the replacement CLI's onExit ran during the in-flight window. */
  backendAlive: boolean;
  /** merge guard armed this when it swallowed a `restart` IPC during the in-flight window. */
  restartRequestedDuringInFlight: boolean;
}

export type RestartFollowupDecision =
  | { kind: 'none' }
  /** A merged cwd-move diverged from the spawned cwd — respawn to converge.
   *  User-initiated move, not crash recovery → skip the tier-2 FRESH budget. */
  | { kind: 'cwd-move'; skipRestartBudget: true }
  /** Replacement exited (or a restart was requested) during the in-flight
   *  window — recover. Genuine crash recovery → COUNTS toward tier-2 FRESH. */
  | { kind: 'replacement-recovery'; skipRestartBudget: false };

/**
 * Decide whether the just-finished in-flight restart must chain another.
 *
 * Order matters and is load-bearing:
 *  - cwd-move convergence is checked FIRST. It re-spawns with the newest
 *    workingDir and (being a fresh restartCliProcess call) resets the armed
 *    flag, so a replacement that also died will be re-evaluated by that new
 *    restart's own continuation. Running it first keeps the cwd authoritative.
 *  - Otherwise, a dead/again-requested replacement recovers via a plain
 *    restart (which reuses `{...lastInitConfig}`, preserving any converged cwd).
 */
export function decideRestartFollowup(input: RestartFollowupInput): RestartFollowupDecision {
  const cwdMoved =
    input.spawnedWorkingDir !== undefined &&
    input.currentWorkingDir !== undefined &&
    input.currentWorkingDir !== input.spawnedWorkingDir;
  if (cwdMoved) return { kind: 'cwd-move', skipRestartBudget: true };
  if (!input.backendAlive || input.restartRequestedDuringInFlight) {
    return { kind: 'replacement-recovery', skipRestartBudget: false };
  }
  return { kind: 'none' };
}
