/**
 * Unit tests for StuckDetector.
 *
 * Covers arm/disarm, timeout firing, isActuallyStuck gating, pattern matching
 * (level 1 hooks browser + level 2 per-hook review, using official Codex TUI
 * snapshots), dispose, and re-arming behavior.
 *
 * Run:  pnpm vitest run test/stuck-detector.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StuckDetector } from '../src/utils/stuck-detector.js';

// Official Codex TUI snapshot — level 1 hooks browser (the screen that blocks
// on startup when a new PreToolUse hook needs review).
// Source: openai/codex codex-rs/tui/src/bottom_pane/snapshots/...hooks_browser_events_with_review_column.snap
const LEVEL_1_SNAPSHOT = [
  'Hooks',
  '',
  'Lifecycle hooks from config and enabled plugins.',
  '',
  '',
  '',
  '⚠ 1 hook needs review before it can run.',
  '',
  '',
  '',
  'Event              Installed  Active  Review  Description',
  '',
  'PreToolUse         1          0       1       Before a tool executes',
  '',
  '...',
  '',
  '',
  '',
  'Press t to trust all; enter to review hooks; esc to close',
].join('\n');

// Official Codex TUI snapshot — level 2 per-hook review (after pressing Enter
// on level 1). No Enter here; only t=trust and Esc=go back.
// Source: openai/codex codex-rs/tui/src/bottom_pane/snapshots/...hooks_browser_review_needed_handler.snap
const LEVEL_2_SNAPSHOT = [
  'PreToolUse hooks',
  '',
  '1 hook needs review before it can run.',
  '',
  '',
  '',
  '[!] Hook 1 · new',
  '',
  '...',
  '',
  'Trust  New hook - review required',
  '',
  '',
  '',
  'Press t to trust; esc to go back',
].join('\n');

describe('StuckDetector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onStuck after timeout when isActuallyStuck returns true (level 1)', () => {
    const onStuck = vi.fn();
    const detector = new StuckDetector(1000, {
      isActuallyStuck: () => true,
      onStuck,
      getSnapshot: () => LEVEL_1_SNAPSHOT,
    });

    detector.arm();
    vi.advanceTimersByTime(1000);

    expect(onStuck).toHaveBeenCalledTimes(1);
    const [elapsedMs, matchedLabel] = onStuck.mock.calls[0];
    expect(elapsedMs).toBeGreaterThanOrEqual(1000);
    expect(matchedLabel).toBe('hook review level 1');
    detector.dispose();
  });

  it('fires onStuck for level 2 per-hook review screen', () => {
    const onStuck = vi.fn();
    const detector = new StuckDetector(1000, {
      isActuallyStuck: () => true,
      onStuck,
      getSnapshot: () => LEVEL_2_SNAPSHOT,
    });

    detector.arm();
    vi.advanceTimersByTime(1000);

    expect(onStuck).toHaveBeenCalledTimes(1);
    expect(onStuck.mock.calls[0][1]).toBe('hook review level 2');
    detector.dispose();
  });

  it('does not fire when isActuallyStuck returns false', () => {
    const onStuck = vi.fn();
    const detector = new StuckDetector(1000, {
      isActuallyStuck: () => false,
      onStuck,
      getSnapshot: () => LEVEL_1_SNAPSHOT,
    });

    detector.arm();
    vi.advanceTimersByTime(1000);

    expect(onStuck).not.toHaveBeenCalled();
    detector.dispose();
  });

  it('re-arms when isActuallyStuck returns false', () => {
    let stuck = false;
    const onStuck = vi.fn();
    const detector = new StuckDetector(1000, {
      isActuallyStuck: () => stuck,
      onStuck,
      getSnapshot: () => LEVEL_1_SNAPSHOT,
    });

    detector.arm();
    // First tick: not stuck → re-arms
    vi.advanceTimersByTime(1000);
    expect(onStuck).not.toHaveBeenCalled();

    // Second tick: now stuck → fires
    stuck = true;
    vi.advanceTimersByTime(1000);
    expect(onStuck).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('disarm cancels the pending timer', () => {
    const onStuck = vi.fn();
    const detector = new StuckDetector(1000, {
      isActuallyStuck: () => true,
      onStuck,
      getSnapshot: () => LEVEL_1_SNAPSHOT,
    });

    detector.arm();
    detector.disarm();
    vi.advanceTimersByTime(2000);

    expect(onStuck).not.toHaveBeenCalled();
    detector.dispose();
  });

  it('arm resets the firedThisWindow flag so a new window can fire', () => {
    const onStuck = vi.fn();
    const detector = new StuckDetector(1000, {
      isActuallyStuck: () => true,
      onStuck,
      getSnapshot: () => LEVEL_1_SNAPSHOT,
    });

    detector.arm();
    vi.advanceTimersByTime(1000);
    expect(onStuck).toHaveBeenCalledTimes(1);

    // Re-arm without disarm (simulating a new write)
    detector.arm();
    vi.advanceTimersByTime(1000);
    expect(onStuck).toHaveBeenCalledTimes(2);
    detector.dispose();
  });

  it('silently re-arms when snapshot does not match hook-review (no false warning)', () => {
    const onStuck = vi.fn();
    const detector = new StuckDetector(1000, {
      isActuallyStuck: () => true,
      onStuck,
      getSnapshot: () => 'Proceed? [Y/n]\nPress space or enter to toggle',
    });

    detector.arm();
    // First tick: isActuallyStuck=true but no pattern match → silently re-arms
    vi.advanceTimersByTime(1000);
    expect(onStuck).not.toHaveBeenCalled();

    // Second tick: still no match → still no warning
    vi.advanceTimersByTime(1000);
    expect(onStuck).not.toHaveBeenCalled();
    detector.dispose();
  });

  it.each([
    ['ordinary chat quoting the title', 'I am investigating PreToolUse hooks today.'],
    ['pasted incident text without controls', 'PreToolUse hooks\n1 hook needs review before it can run.'],
    ['level 1 control hint without title and pending state', 'Press t to trust all; enter to review hooks; esc to close'],
    ['level 2 control hint without title and pending state', 'Press t to trust; esc to go back'],
    ['mixed: level 2 title with level 1 controls (does not exist in real UI)', 'PreToolUse hooks\n1 hook needs review before it can run.\nPress t to trust all; enter to review hooks; esc to close'],
    ['mixed: level 1 title with level 2 controls (does not exist in real UI)', 'Hooks\n1 hook needs review before it can run.\nPress t to trust; esc to go back'],
  ])('does not fire for %s', (_name, snapshot) => {
    const onStuck = vi.fn();
    const detector = new StuckDetector(1000, {
      isActuallyStuck: () => true,
      onStuck,
      getSnapshot: () => snapshot,
    });

    detector.arm();
    vi.advanceTimersByTime(1000);

    expect(onStuck).not.toHaveBeenCalled();
    detector.dispose();
  });

  it('dispose prevents any further firing', () => {
    const onStuck = vi.fn();
    const detector = new StuckDetector(1000, {
      isActuallyStuck: () => true,
      onStuck,
      getSnapshot: () => LEVEL_1_SNAPSHOT,
    });

    detector.arm();
    detector.dispose();
    vi.advanceTimersByTime(5000);

    expect(onStuck).not.toHaveBeenCalled();
  });

  it('does not fire twice within the same window', () => {
    const onStuck = vi.fn();
    const detector = new StuckDetector(1000, {
      isActuallyStuck: () => true,
      onStuck,
      getSnapshot: () => LEVEL_1_SNAPSHOT,
    });

    detector.arm();
    vi.advanceTimersByTime(1000);
    // Advance more time without re-arming — should NOT fire again
    vi.advanceTimersByTime(5000);

    expect(onStuck).toHaveBeenCalledTimes(1);
    detector.dispose();
  });
});
