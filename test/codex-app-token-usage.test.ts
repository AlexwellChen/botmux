/**
 * Unit tests for the per-turn codex token-usage accumulator — the total-delta
 * algorithm that turns cumulative `thread/tokenUsage/updated` notifications into
 * a single turn's four-bucket usage.
 *
 * Run: pnpm vitest run test/codex-app-token-usage.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  TurnTokenUsageAccumulator,
  parseCodexTokenBreakdown,
  toFourBucket,
  type CodexTokenBreakdown,
} from '../src/services/codex-app-token-usage.js';

function bd(p: Partial<CodexTokenBreakdown>): CodexTokenBreakdown {
  return {
    totalTokens: 0, inputTokens: 0, cachedInputTokens: 0,
    cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, ...p,
  };
}

describe('toFourBucket', () => {
  it('splits codex input into fresh/cacheRead/cacheCreate and keeps output', () => {
    // Official example: input=100 total (incl cache), cached=40, cacheWrite=60.
    const u = toFourBucket(bd({ inputTokens: 100, cachedInputTokens: 40, cacheWriteInputTokens: 60, outputTokens: 20, reasoningOutputTokens: 8 }));
    expect(u).toEqual({ inputTokens: 0, outputTokens: 20, cacheReadTokens: 40, cacheCreateTokens: 60 });
  });

  it('does NOT add reasoningOutputTokens to output (it is a subset)', () => {
    const u = toFourBucket(bd({ inputTokens: 10, outputTokens: 30, reasoningOutputTokens: 25 }));
    expect(u?.outputTokens).toBe(30);
  });

  it('returns null when buckets exceed input (incoherent split)', () => {
    expect(toFourBucket(bd({ inputTokens: 50, cachedInputTokens: 40, cacheWriteInputTokens: 60 }))).toBeNull();
  });
});

describe('parseCodexTokenBreakdown', () => {
  it('parses a complete breakdown', () => {
    expect(parseCodexTokenBreakdown({ totalTokens: 5, inputTokens: 5, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 3, reasoningOutputTokens: 1 }))
      .toMatchObject({ totalTokens: 5, inputTokens: 5, outputTokens: 3 });
  });
  it('rejects non-numeric present fields', () => {
    expect(parseCodexTokenBreakdown({ totalTokens: 'x' })).toBeNull();
  });
  it('rejects negative or fractional token counts (protocol boundary)', () => {
    const full = { totalTokens: 5, inputTokens: 5, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 3, reasoningOutputTokens: 1 };
    expect(parseCodexTokenBreakdown({ ...full, inputTokens: -1 })).toBeNull();
    expect(parseCodexTokenBreakdown({ ...full, outputTokens: 1.5 })).toBeNull();
  });
  it('rejects non-object', () => {
    expect(parseCodexTokenBreakdown(null)).toBeNull();
  });
});

describe('TurnTokenUsageAccumulator — total-delta', () => {
  it('single completion: baseline = total - last, turn = latestTotal - baseline', () => {
    const acc = new TurnTokenUsageAccumulator();
    // first (only) completion of this turn: total jumped by `last`
    acc.update(bd({ totalTokens: 130, inputTokens: 100, cachedInputTokens: 40, cacheWriteInputTokens: 0, outputTokens: 30 }),
               bd({ totalTokens: 130, inputTokens: 100, cachedInputTokens: 40, cacheWriteInputTokens: 0, outputTokens: 30 }));
    // baseline = 0 → whole total is this turn
    expect(acc.result()).toEqual({ inputTokens: 60, outputTokens: 30, cacheReadTokens: 40, cacheCreateTokens: 0 });
  });

  it('mid-session turn: prior session total excluded via baseline', () => {
    const acc = new TurnTokenUsageAccumulator();
    // session already had 1000 total; this turn's first completion added 130 (last)
    acc.update(bd({ totalTokens: 1130, inputTokens: 900, outputTokens: 230 }),
               bd({ totalTokens: 130, inputTokens: 100, outputTokens: 30 }));
    // baseline = 1130-130 = 1000 total / 800 input / 200 output → turn = last so far
    expect(acc.result()).toEqual({ inputTokens: 100, outputTokens: 30, cacheReadTokens: 0, cacheCreateTokens: 0 });
  });

  it('multiple completions in one turn accumulate via total, not last-sum', () => {
    const acc = new TurnTokenUsageAccumulator();
    // completion 1: session base 1000, +130
    acc.update(bd({ totalTokens: 1130, inputTokens: 900, outputTokens: 230 }), bd({ totalTokens: 130, inputTokens: 100, outputTokens: 30 }));
    // completion 2 (tool loop): total advances to 1300; last is only completion-2's usage
    acc.update(bd({ totalTokens: 1300, inputTokens: 1040, outputTokens: 260 }), bd({ totalTokens: 170, inputTokens: 140, outputTokens: 30 }));
    // turn = 1300-baseline(1000) → input 1040-800=240, output 260-200=60
    expect(acc.result()).toEqual({ inputTokens: 240, outputTokens: 60, cacheReadTokens: 0, cacheCreateTokens: 0 });
  });

  it('idempotent against a duplicated notification (same total)', () => {
    const acc = new TurnTokenUsageAccumulator();
    const total = bd({ totalTokens: 1130, inputTokens: 900, outputTokens: 230 });
    const last = bd({ totalTokens: 130, inputTokens: 100, outputTokens: 30 });
    acc.update(total, last);
    acc.update(total, last); // duplicate delivery
    expect(acc.result()).toEqual({ inputTokens: 100, outputTokens: 30, cacheReadTokens: 0, cacheCreateTokens: 0 });
  });

  it('fail-closed: total regression → null + warning', () => {
    const acc = new TurnTokenUsageAccumulator();
    acc.update(bd({ totalTokens: 1130, inputTokens: 900, outputTokens: 230 }), bd({ totalTokens: 130, inputTokens: 100, outputTokens: 30 }));
    acc.update(bd({ totalTokens: 1000, inputTokens: 800, outputTokens: 200 }), bd({ totalTokens: 10, inputTokens: 8, outputTokens: 2 }));
    expect(acc.result()).toBeNull();
    expect(acc.warning).toBeTruthy();
  });

  it('no notifications → null (caller omits usage, never writes zeros)', () => {
    expect(new TurnTokenUsageAccumulator().result()).toBeNull();
  });

  it('poison() is sticky: a later valid update cannot resurrect usage', () => {
    // Models malformed-then-valid within one turn: the runner poisons on the
    // malformed notification; a subsequent valid one must NOT rebuild a baseline
    // and report only that completion (a plausible-looking undercount).
    const acc = new TurnTokenUsageAccumulator();
    acc.poison('malformed tokenUsage notification');
    acc.update(bd({ totalTokens: 130, inputTokens: 100, outputTokens: 30 }), bd({ totalTokens: 130, inputTokens: 100, outputTokens: 30 }));
    expect(acc.result()).toBeNull();
    expect(acc.warning).toBeTruthy();
  });

  it('fail-closed: negative baseline (total < last) → null + warning (not inflated turn)', () => {
    // codex review repro: total.input=50 but last.input=100 → baseline would be
    // -50 and the turn would wrongly read input=100. Must reject.
    const acc = new TurnTokenUsageAccumulator();
    acc.update(bd({ totalTokens: 50, inputTokens: 50, outputTokens: 20 }), bd({ totalTokens: 100, inputTokens: 100, outputTokens: 40 }));
    expect(acc.result()).toBeNull();
    expect(acc.warning).toBeTruthy();
  });

  it('fail-closed: a regression in a NON-total field (cacheRead) is caught', () => {
    const acc = new TurnTokenUsageAccumulator();
    acc.update(
      bd({ totalTokens: 200, inputTokens: 150, cachedInputTokens: 50, outputTokens: 50 }),
      bd({ totalTokens: 100, inputTokens: 80, cachedInputTokens: 20, outputTokens: 20 }),
    );
    // total/input/output all advance, but cachedInputTokens regresses 50→10
    acc.update(
      bd({ totalTokens: 260, inputTokens: 200, cachedInputTokens: 10, outputTokens: 60 }),
      bd({ totalTokens: 60, inputTokens: 50, cachedInputTokens: 0, outputTokens: 10 }),
    );
    expect(acc.result()).toBeNull();
    expect(acc.warning).toBeTruthy();
  });
});

describe('parseCodexTokenBreakdown — required fields', () => {
  const full = { totalTokens: 1, inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 };
  it('rejects a missing REQUIRED field (not defaulted to 0)', () => {
    for (const k of ['totalTokens', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens']) {
      const { [k]: _omit, ...partial } = full as Record<string, number>;
      expect(parseCodexTokenBreakdown(partial)).toBeNull();
    }
  });
  it('accepts a missing cacheWriteInputTokens (back-compat → 0)', () => {
    const { cacheWriteInputTokens: _omit, ...compat } = full;
    expect(parseCodexTokenBreakdown(compat)?.cacheWriteInputTokens).toBe(0);
  });
});
