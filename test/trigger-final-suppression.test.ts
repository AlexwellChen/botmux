import { describe, expect, it } from 'vitest';

import {
  armTriggerFinalSuppression,
  disarmTriggerFinalSuppression,
  isTriggerFinalSuppressed,
} from '../src/core/trigger-final-suppression.js';
import type { DaemonSession } from '../src/core/types.js';

function session(): DaemonSession {
  return {} as DaemonSession;
}

describe('trigger final-output suppression', () => {
  it('arms and reads back suppression by exact turn id', () => {
    const ds = session();
    armTriggerFinalSuppression(ds, 'trg_1');
    expect(isTriggerFinalSuppressed(ds, 'trg_1')).toBe(true);
    // A different turn on the same session is untouched.
    expect(isTriggerFinalSuppressed(ds, 'trg_other')).toBe(false);
    // No turn id (a plain human turn) is never suppressed.
    expect(isTriggerFinalSuppressed(ds, undefined)).toBe(false);
  });

  it('disarm clears the entry and empties the map', () => {
    const ds = session();
    armTriggerFinalSuppression(ds, 'trg_1');
    disarmTriggerFinalSuppression(ds, 'trg_1');
    expect(isTriggerFinalSuppressed(ds, 'trg_1')).toBe(false);
    expect(ds.suppressedTriggerFinalTurns).toBeUndefined();
  });

  it('expires entries past the 24h TTL and self-prunes the map', () => {
    const ds = session();
    const armedAt = 1_000_000;
    armTriggerFinalSuppression(ds, 'trg_1', armedAt);
    const afterTtl = armedAt + 24 * 60 * 60 * 1000 + 1;
    expect(isTriggerFinalSuppressed(ds, 'trg_1', afterTtl)).toBe(false);
    expect(ds.suppressedTriggerFinalTurns).toBeUndefined();
  });

  it('bounds the map at 256 entries — best-effort, evicting the oldest under a storm', () => {
    const ds = session();
    const now = 2_000_000;
    // Arm 300 distinct turns well within TTL. Each arm prunes down to the cap, so
    // the oldest turns are evicted even though they are not yet TTL-expired.
    for (let i = 0; i < 300; i++) armTriggerFinalSuppression(ds, `trg_${i}`, now + i);
    expect(ds.suppressedTriggerFinalTurns!.size).toBeLessThanOrEqual(256);
    // The earliest turns lost their suppression (final would fire) — the tradeoff
    // is documented as best-effort, not a strong guarantee.
    expect(isTriggerFinalSuppressed(ds, 'trg_0', now + 300)).toBe(false);
    // The most recent turns are still suppressed.
    expect(isTriggerFinalSuppressed(ds, 'trg_299', now + 300)).toBe(true);
  });
});
