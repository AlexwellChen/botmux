import { describe, expect, it } from 'vitest';
import { applyAllowedUsersResolve } from '../src/utils/allowed-users-apply.js';

describe('applyAllowedUsersResolve', () => {
  it('uses a fresh successful resolve', () => {
    const map = new Map([['on_owner', 'ou_owner']]);
    const out = applyAllowedUsersResolve({
      rawEntries: ['on_owner'],
      previousResolvedOpenIds: ['ou_stale'],
      resolveResult: { resolved: ['ou_owner'], map },
    });

    expect(out.resolved).toEqual(['ou_owner']);
    expect(out.usedFallback).toBe(false);
    expect(out.failed).toBe(false);
    expect(out.notice).toBeNull();
  });

  it('falls back to last-known open_ids when resolve returns empty (transient lockout)', () => {
    const out = applyAllowedUsersResolve({
      rawEntries: ['on_928c2db360e48084f1ff72ebe161b1d6'],
      previousResolvedOpenIds: ['ou_8a744395b1a13034de3e5e8ba6ba9715'],
      resolveResult: { resolved: [], map: new Map(), errored: true },
    });

    expect(out.resolved).toEqual(['ou_8a744395b1a13034de3e5e8ba6ba9715']);
    expect(out.usedFallback).toBe(true);
    expect(out.failed).toBe(true);
    expect(out.notice).toContain('reusing');
    expect(out.notice).toContain('on_928c2db360e48084f1ff72ebe161b1d6');
  });

  it('reports hard failure with empty list when there is no cache', () => {
    const out = applyAllowedUsersResolve({
      rawEntries: ['on_owner'],
      previousResolvedOpenIds: ['on_not_an_open_id', ''],
      resolveResult: { resolved: [], map: new Map(), errored: true },
    });

    expect(out.resolved).toEqual([]);
    expect(out.usedFallback).toBe(false);
    expect(out.failed).toBe(true);
    expect(out.notice).toContain('runtime allowlist is empty');
  });

  it('keeps empty config as a non-failure open path', () => {
    const out = applyAllowedUsersResolve({
      rawEntries: [],
      previousResolvedOpenIds: ['ou_stale'],
      resolveResult: { resolved: [], map: new Map() },
    });

    expect(out.resolved).toEqual([]);
    expect(out.failed).toBe(false);
    expect(out.notice).toBeNull();
  });

  it('never leaves bare on_ entries in the runtime list after a failed resolve', () => {
    const out = applyAllowedUsersResolve({
      rawEntries: ['on_owner'],
      // Memory still holds the pre-resolve raw list — must not be reused as-is.
      previousResolvedOpenIds: ['on_owner'],
      resolveResult: { resolved: [], map: new Map(), errored: true },
    });

    expect(out.resolved).toEqual([]);
    expect(out.resolved.every(id => id.startsWith('ou_'))).toBe(true);
    expect(out.failed).toBe(true);
  });

  it('surfaces notice when fresh resolve partially succeeds with errored=true', () => {
    const out = applyAllowedUsersResolve({
      rawEntries: ['on_a', 'on_b'],
      previousResolvedOpenIds: [],
      resolveResult: {
        resolved: ['ou_a'],
        map: new Map([['on_a', 'ou_a']]),
        errored: true,
      },
    });

    expect(out.resolved).toEqual(['ou_a']);
    expect(out.usedFallback).toBe(false);
    expect(out.failed).toBe(true);
    expect(out.notice).toContain('transient errors');
  });
});
