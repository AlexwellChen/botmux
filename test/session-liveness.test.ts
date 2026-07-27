import { describe, expect, it } from 'vitest';
import { isSessionStopped } from '../src/core/session-liveness.js';
import type { Session } from '../src/types.js';

// Minimal Session stub — isSessionStopped only reads pid / adoptedFrom /
// sessionId / suspendedColdResume.
function session(over: Partial<Session>): Session {
  return { sessionId: '0123456789abcdef', status: 'active', ...over } as Session;
}

describe('isSessionStopped — botmux-suspended sessions are not zombies', () => {
  it('treats a cold-resume-suspended session (no pid, tmux destroyed) as NOT stopped', () => {
    // This is the data-loss guard: botmux cap-suspend clears the pid AND
    // destroys the backing CLI/tmux, so the generic zombie heuristic would
    // classify it as stopped and let the "清僵尸" sweep permanently close a
    // session that should cold-resume on the next message. The persisted
    // marker must beat the heuristic (mirrors the CLI list prune guard).
    expect(isSessionStopped(session({ suspendedColdResume: true, pid: undefined }))).toBe(false);
  });

  it('still reports a real zombie (dead pid, no marker) as stopped', () => {
    // pid 1 is init — alive but not ours; use an unused-high pid that is dead.
    // No suspendedColdResume marker → falls through to the pid/tmux heuristic.
    // With no pid and no bmx-* tmux pane, it is a stopped zombie.
    expect(isSessionStopped(session({ suspendedColdResume: undefined, pid: undefined }))).toBe(true);
  });
});
