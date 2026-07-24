/**
 * Unit tests for resolveAsyncTriggerState — the pure four-state resolver behind
 * GET /api/sessions/:id/trigger-result (async dispatch design A).
 *
 * Focus: the state contract riff branches on, and the restart guarantee
 * (already-completed / still-armed turns never degrade to not_found once the
 * in-memory Map is gone).
 *
 * Run:  pnpm vitest run test/async-trigger-state.test.ts
 */
import { describe, it, expect } from 'vitest';
import { resolveAsyncTriggerState } from '../src/services/async-trigger-state.js';

describe('resolveAsyncTriggerState — completed', () => {
  it('from live in-memory result', () => {
    const r = resolveAsyncTriggerState({
      sessionId: 's1',
      liveActive: true,
      chatId: 'http_async_x',
      memResult: { status: 'completed', content: 'BOTMUX_RUN_OK', completedAt: 5000 },
      memTriggerId: 'trg_a',
      storedStatus: 'open',
    });
    expect(r.state).toBe('completed');
    expect(r.output?.content).toBe('BOTMUX_RUN_OK');
    expect(r.finishedAt).toBe(new Date(5000).toISOString());
    expect(r.triggerId).toBe('trg_a');
  });

  it('rebuilt from durable result after restart (no live session)', () => {
    // Simulates daemon restart: no live ds, in-memory Map gone, but the
    // session record is closed and the durable result says completed.
    const r = resolveAsyncTriggerState({
      sessionId: 's1',
      liveActive: false,
      persisted: { triggerId: 'trg_a', result: { status: 'completed', content: 'survived', completedAt: 7000 } },
      storedStatus: 'closed',
      closedAt: new Date(8000).toISOString(),
    });
    expect(r.state).toBe('completed');
    expect(r.output?.content).toBe('survived');
    expect(r.finishedAt).toBe(new Date(7000).toISOString());
  });

  it('closed session WITH captured output is completed, not failed', () => {
    const r = resolveAsyncTriggerState({
      sessionId: 's1',
      liveActive: false,
      persisted: { triggerId: 'trg_a', result: { status: 'completed', content: 'done', completedAt: 100 } },
      storedStatus: 'closed',
    });
    expect(r.state).toBe('completed');
  });
});

describe('resolveAsyncTriggerState — running', () => {
  it('live session, pending in-memory', () => {
    const r = resolveAsyncTriggerState({
      sessionId: 's1',
      liveActive: true,
      memResult: { status: 'pending' },
      memTriggerId: 'trg_a',
      storedStatus: 'open',
    });
    expect(r.state).toBe('running');
  });

  it('durable pending after restart never degrades to not_found', () => {
    const r = resolveAsyncTriggerState({
      sessionId: 's1',
      liveActive: false,
      persisted: { triggerId: 'trg_a', result: { status: 'pending', content: undefined } },
      storedStatus: undefined, // record not found, but a pending trigger was armed
    });
    expect(r.state).toBe('running');
  });

  it('open session record with no result yet', () => {
    const r = resolveAsyncTriggerState({
      sessionId: 's1',
      liveActive: false,
      storedStatus: 'open',
    });
    expect(r.state).toBe('running');
  });
});

describe('resolveAsyncTriggerState — failed', () => {
  it('closed session, no captured output → failed(no_output)', () => {
    const r = resolveAsyncTriggerState({
      sessionId: 's1',
      liveActive: false,
      storedStatus: 'closed',
      closedAt: new Date(9000).toISOString(),
    });
    expect(r.state).toBe('failed');
    expect(r.errorCode).toBe('no_output');
    expect(r.finishedAt).toBe(new Date(9000).toISOString());
    expect(r.output).toBeUndefined();
  });

  it('closed session with a still-pending durable record → failed, NOT running (cancel path)', () => {
    // Regression: canceling (close) a running async session leaves its persisted
    // record at `pending`. The closed check must win over durable-pending, or the
    // poller loops on `running` forever after a cancel.
    const r = resolveAsyncTriggerState({
      sessionId: 's1',
      liveActive: false,
      persisted: { triggerId: 'trg_a', result: { status: 'pending' } },
      storedStatus: 'closed',
      closedAt: new Date(9000).toISOString(),
    });
    expect(r.state).toBe('failed');
    expect(r.errorCode).toBe('no_output');
  });
});

describe('resolveAsyncTriggerState — not_found', () => {
  it('no session record and no persisted result', () => {
    const r = resolveAsyncTriggerState({
      sessionId: 'ghost',
      liveActive: false,
      requestedTriggerId: 'trg_q',
    });
    expect(r.state).toBe('not_found');
    expect(r.errorCode).toBe('session_not_found');
    expect(r.triggerId).toBe('trg_q');
  });

  it('the restart-critical distinction: completed session never reads as not_found', () => {
    // Two lookups for the same id: one where nothing is known (not_found),
    // one where a durable completed result exists (completed). This is the
    // exact false-"task lost" the design guards against.
    const ghost = resolveAsyncTriggerState({ sessionId: 's1', liveActive: false });
    expect(ghost.state).toBe('not_found');

    const recovered = resolveAsyncTriggerState({
      sessionId: 's1',
      liveActive: false,
      persisted: { triggerId: 'trg_a', result: { status: 'completed', content: 'x', completedAt: 1 } },
      storedStatus: 'closed',
    });
    expect(recovered.state).toBe('completed');
  });
});

describe('resolveAsyncTriggerState — response is always ok:true for resolved queries', () => {
  it('every state carries ok:true (task state is in .state, not HTTP/ok)', () => {
    const inputs = [
      { sessionId: 's', liveActive: true, memResult: { status: 'completed' as const, content: 'c', completedAt: 1 }, memTriggerId: 't' },
      { sessionId: 's', liveActive: true, storedStatus: 'open' as const },
      { sessionId: 's', liveActive: false, storedStatus: 'closed' as const },
      { sessionId: 's', liveActive: false },
    ];
    for (const i of inputs) expect(resolveAsyncTriggerState(i).ok).toBe(true);
  });
});
