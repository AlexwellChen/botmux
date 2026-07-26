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
 *     nulls `backend` SYNCHRONOUSLY, so by continuation time `!backendAlive` is
 *     the ground truth that the replacement is gone. The daemon's auto-restart
 *     `restart` IPC (swallowed by the merge guard) is NOT needed as a signal —
 *     and must not be used: a `restart` message carries no trustworthy source,
 *     so a healthy duplicate `/restart` (double click, two `/restart`s) during
 *     the window is indistinguishable from a crash auto-restart. Treating a
 *     merged request as recovery would force a second restart on a HEALTHY
 *     generation, burn the tier-2 budget, and drop `--resume` → context lost —
 *     re-creating exactly what the merge guard exists to prevent. So recovery
 *     keys ONLY on `!backendAlive`.
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
  /** false once the replacement CLI's onExit ran during the in-flight window
   *  (onExit sets `backend = null` synchronously). The ONLY recovery signal. */
  backendAlive: boolean;
}

export type RestartFollowupDecision =
  | { kind: 'none' }
  /** A merged cwd-move diverged from the spawned cwd — respawn to converge.
   *  `skipRestartBudget` is true ONLY when the replacement is still alive (a
   *  pure user-initiated move). If the replacement also DIED, this is real
   *  crash recovery wearing a cwd-move hat: converge the cwd but still COUNT
   *  the budget so a crashing replacement can't hide behind a directory change. */
  | { kind: 'cwd-move'; skipRestartBudget: boolean }
  /** Replacement exited during the in-flight window — recover. Genuine crash
   *  recovery → COUNTS toward tier-2 FRESH (skipRestartBudget: false). */
  | { kind: 'replacement-recovery'; skipRestartBudget: false };

/**
 * Decide whether the just-finished in-flight restart must chain another.
 *
 * Order matters and is load-bearing:
 *  - cwd-move convergence is checked FIRST so the directory target stays
 *    authoritative. It re-spawns with the newest workingDir; a replacement
 *    that also died is re-evaluated by that new restart's own continuation.
 *    Budget is skipped only if the backend is alive (pure move); a dead
 *    backend means we must NOT lose the crash evidence, so count it.
 *  - Otherwise, a dead replacement recovers via a plain restart (which reuses
 *    `{...lastInitConfig}`, preserving any converged cwd), budgeted.
 *  - A healthy generation with no cwd move needs nothing — crucially, a merged
 *    duplicate restart is NOT a follow-up trigger (see the header note).
 */
export function decideRestartFollowup(input: RestartFollowupInput): RestartFollowupDecision {
  const cwdMoved =
    input.spawnedWorkingDir !== undefined &&
    input.currentWorkingDir !== undefined &&
    input.currentWorkingDir !== input.spawnedWorkingDir;
  if (cwdMoved) return { kind: 'cwd-move', skipRestartBudget: input.backendAlive };
  if (!input.backendAlive) return { kind: 'replacement-recovery', skipRestartBudget: false };
  return { kind: 'none' };
}
