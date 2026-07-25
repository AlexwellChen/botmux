import { describe, expect, it } from 'vitest';
import { normalizeSandboxPaths } from '../src/services/sandbox-store.js';

// Regression for the dashboard sandbox-paths picker: what gets STORED must
// resolve a same-path cross-tier conflict the SAME way fs-policy's mergeFsRules
// does (deny > readOnly > readWrite), so the UI/tester never disagree with the
// sandbox the compiler builds. Tier-internal dedup alone left both entries.
describe('normalizeSandboxPaths (cross-tier dedup for the picker)', () => {
  it('trims + dedups within a tier', () => {
    expect(normalizeSandboxPaths({ readWrite: [' ~/a ', '~/a', '', '~/b'] }))
      .toEqual({ readWrite: ['~/a', '~/b'] });
  });

  it('a path in both readWrite and deny resolves to deny (more restrictive wins)', () => {
    expect(normalizeSandboxPaths({ readWrite: ['/repo'], deny: ['/repo'] }))
      .toEqual({ deny: ['/repo'] });
  });

  it('a path in both readWrite and readOnly resolves to readOnly', () => {
    expect(normalizeSandboxPaths({ readWrite: ['/x'], readOnly: ['/x'] }))
      .toEqual({ readOnly: ['/x'] });
  });

  it('a path in all three tiers resolves to deny only', () => {
    expect(normalizeSandboxPaths({ readWrite: ['/x'], readOnly: ['/x'], deny: ['/x'] }))
      .toEqual({ deny: ['/x'] });
  });

  it('trailing-slash variants are treated as the same path for cross-tier dedup', () => {
    expect(normalizeSandboxPaths({ readWrite: ['/repo/'], deny: ['/repo'] }))
      .toEqual({ deny: ['/repo'] });
  });

  it('keeps distinct paths across tiers untouched', () => {
    expect(normalizeSandboxPaths({ readWrite: ['/proj'], readOnly: ['/ref'], deny: ['/proj/secret'] }))
      .toEqual({ readWrite: ['/proj'], readOnly: ['/ref'], deny: ['/proj/secret'] });
  });

  it('all-empty (or whitespace-only) collapses to {} so the caller clears the field', () => {
    expect(normalizeSandboxPaths({ readWrite: ['  '], readOnly: [], deny: [] })).toEqual({});
    expect(normalizeSandboxPaths({})).toEqual({});
  });
});
