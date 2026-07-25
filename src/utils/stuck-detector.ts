/**
 * Lightweight, AI-free "stuck" detector — fires a callback when a written input
 * has not produced a completed turn within a timeout window.
 *
 * Scope (intentionally narrow): this PR targets the specific Codex PreToolUse
 * hook-review blocking state, where the CLI renders a review screen and waits
 * for t/Enter/Esc (level 1) or t/Esc (level 2). Generic [Y/n]/permission/
 * Press-to-continue prompts are NOT handled here — they require semantic parsing
 * that cannot be safely inferred from a regex, and belong in a follow-up PR.
 *
 * The detector does NOT itself decide the CLI is stuck. It only tracks elapsed
 * time since the last write and asks the owner (worker) to confirm via the
 * `isActuallyStuck` callback — the worker knows whether inflight inputs exist,
 * whether a TUI prompt card is already posted, and whether the PTY has been
 * quiet. This avoids false positives from legitimately long turns.
 */

/**
 * Codex renders two distinct hook-review screens. We match each independently
 * because their titles and control hints differ, and the safe button set differs
 * (level 1 has Enter to drill in; level 2 has no Enter).
 *
 * Level 1 — hooks browser (the screen that actually blocks on startup):
 *   Title:  "Hooks"
 *   State:  "1 hook needs review before it can run."
 *   Footer: "Press t to trust all; enter to review hooks; esc to close"
 *
 * Level 2 — per-hook review (after pressing Enter on level 1):
 *   Title:  "PreToolUse hooks"
 *   State:  "1 hook needs review before it can run."
 *   Footer: "Press t to trust; esc to go back"
 *
 * Each match requires the title + pending-review state + control hint to appear
 * together. A keyword alone is not enough: users and model output can legitimately
 * quote the incident text. We use the full official snapshot strings as the
 * source of truth (see OpenAI codex-rs TUI snapshots).
 */
export function matchHookReviewScreen(snapshot: string): 'hook review level 1' | 'hook review level 2' | undefined {
  const hasPendingReview = /hook needs review|needs review before it can run/i.test(snapshot);
  if (!hasPendingReview) return undefined;

  // Level 1: hooks browser view
  const hasL1Title = /(^|\n)Hooks\s*\n/i.test(snapshot);
  const hasL1Controls = /Press t to trust all; enter to review hooks; esc to close/i.test(snapshot);
  if (hasL1Title && hasL1Controls) return 'hook review level 1';

  // Level 2: per-hook review view
  const hasL2Title = /PreToolUse hooks/i.test(snapshot);
  const hasL2Controls = /Press t to trust; esc to go back/i.test(snapshot);
  if (hasL2Title && hasL2Controls) return 'hook review level 2';

  return undefined;
}

export interface StuckDetectorCallbacks {
  /** Called when the timeout elapses. Return true to fire the warning; false
   *  to silently re-arm (e.g. the CLI just finished a long turn). */
  isActuallyStuck: () => boolean;
  /** Called once per armed window when isActuallyStuck returns true.
   *  `matchedLabel` is set when the snapshot matches a known hook-review
   *  pattern; undefined means the turn is stalled but the cause is unknown. */
  onStuck: (elapsedMs: number, matchedLabel?: string) => void;
  /** Optional: return the current terminal snapshot for pattern matching. */
  getSnapshot?: () => string;
}

export class StuckDetector {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private armedAt = 0;
  private firedThisWindow = false;
  private disposed = false;

  constructor(
    private readonly timeoutMs: number,
    private readonly callbacks: StuckDetectorCallbacks,
  ) {}

  /** Arm the detector — call right after writing input to the PTY. */
  arm(): void {
    if (this.disposed) return;
    this.disarm();
    this.armedAt = Date.now();
    this.firedThisWindow = false;
    this.timer = setTimeout(() => this.tick(), this.timeoutMs);
  }

  /** Disarm — call when the turn completes (prompt ready) or the CLI exits. */
  disarm(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.armedAt = 0;
    this.firedThisWindow = false;
  }

  dispose(): void {
    this.disposed = true;
    this.disarm();
  }

  private tick(): void {
    this.timer = null;
    if (this.disposed) return;
    if (this.firedThisWindow) return;
    if (!this.callbacks.isActuallyStuck()) {
      // CLI may have just finished — re-arm for the next window in case it
      // immediately blocks again on a follow-up prompt.
      this.arm();
      return;
    }
    // Only fire when the snapshot matches a known hook-review pattern.
    // A 15s PTY silence alone does NOT prove the turn is stuck — long model
    // thinking or tool calls can be quiet. Without a pattern match we silently
    // re-arm and keep waiting, never posting a false "CLI stuck" warning.
    const matched = this.matchSnapshot();
    if (!matched) {
      this.arm();
      return;
    }
    this.firedThisWindow = true;
    const elapsed = Date.now() - this.armedAt;
    this.callbacks.onStuck(elapsed, matched);
  }

  private matchSnapshot(): string | undefined {
    const snap = this.callbacks.getSnapshot?.();
    return snap ? matchHookReviewScreen(snap) : undefined;
  }
}
