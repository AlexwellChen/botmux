/**
 * Pure four-state resolution for `GET /api/sessions/:id/trigger-result`
 * (async dispatch design A). Kept free of daemon/registry imports so it can be
 * unit-tested directly; dashboard-ipc-server gathers the three inputs (live
 * session, on-disk session record, persisted async result) and calls this.
 *
 * State contract (see docs/developer/platform/botmux-async-dispatch-design.md):
 *  - completed: final output captured (mem OR durable) → output.content + finishedAt
 *  - running:   live session in flight, or a session record still open
 *  - failed:    session record closed with no captured output (no_output; soft
 *               terminal — may be a genuine failure OR a caller-initiated close)
 *  - not_found: no session record anywhere (never existed / invalid id)
 *
 * Restart guarantee: as long as EITHER a session record OR a persisted result
 * exists, this never returns not_found — an already-completed turn resolves to
 * completed even after the in-memory Map is gone.
 */
import type { TriggerResponse } from './trigger-types.js';

export interface AsyncStateInputs {
  sessionId: string;
  /** Whether a live DaemonSession is currently registered for this id. */
  liveActive: boolean;
  /** chatId from the live session or the stored record, if known. */
  chatId?: string;
  /** In-memory async result for the resolved trigger, if the session is live. */
  memResult?: { status: 'pending' | 'completed'; content?: string; completedAt?: number };
  /** triggerId the in-memory result is keyed under (latest or explicit). */
  memTriggerId?: string;
  /** Durable persisted result (survives restart), if any. */
  persisted?: {
    triggerId: string;
    result: { status: 'pending' | 'completed'; content?: string; completedAt?: number };
  };
  /** On-disk session record status: 'open' (active), 'closed', or absent. */
  storedStatus?: 'open' | 'closed';
  /** closedAt ISO string from the stored record, for failed/finishedAt. */
  closedAt?: string;
  /** triggerId from the request query, if the caller pinned one. */
  requestedTriggerId?: string;
}

export function resolveAsyncTriggerState(inp: AsyncStateInputs): TriggerResponse {
  const { sessionId, chatId } = inp;

  // Precise-triggerId miss: the caller pinned ?triggerId= but no record (in
  // memory or durable) matches it, AND a session context exists for this id.
  // Preserve the legacy bad_request semantics — do NOT fall through to session
  // open/closed and misreport running/failed for a trigger this session never
  // had. (The caller only passes memResult/persisted that actually match the
  // requested id, so "both absent + session exists" == precise miss.) When no
  // session exists at all, this falls through to the not_found branch below.
  const sessionExists = inp.liveActive || inp.storedStatus !== undefined;
  if (inp.requestedTriggerId && !inp.memResult && !inp.persisted && sessionExists) {
    return {
      ok: false,
      state: 'not_found',
      triggerId: inp.requestedTriggerId,
      errorCode: 'bad_request',
      error: `async trigger not found for session: ${inp.requestedTriggerId}`,
      message: 'requested triggerId not found for this session',
    };
  }

  const completed =
    (inp.memResult?.status === 'completed' && inp.memTriggerId
      ? { triggerId: inp.memTriggerId, content: inp.memResult.content, completedAt: inp.memResult.completedAt }
      : undefined) ??
    (inp.persisted?.result.status === 'completed'
      ? { triggerId: inp.persisted.triggerId, content: inp.persisted.result.content, completedAt: inp.persisted.result.completedAt }
      : undefined);

  if (completed) {
    const finishedAt = completed.completedAt ? new Date(completed.completedAt).toISOString() : undefined;
    return {
      ok: true,
      state: 'completed',
      triggerId: completed.triggerId,
      action: 'completed',
      target: { kind: 'turn', sessionId, chatId },
      output: completed.content !== undefined ? { content: completed.content } : undefined,
      finishedAt,
      async: { status: 'completed', sessionId, completedAt: finishedAt },
      message: 'async trigger completed',
    };
  }

  // Closed record with no captured output → soft-terminal failed. Checked
  // BEFORE the durable-pending running branch: a closed session whose persisted
  // record is still `pending` was armed but never completed (a cancel/close or a
  // genuine failure), so it must resolve to failed, not loop as running forever.
  // The caller distinguishes its own cancel via intent, not this signal.
  if (inp.storedStatus === 'closed') {
    return {
      ok: true,
      state: 'failed',
      triggerId: inp.persisted?.triggerId ?? inp.requestedTriggerId,
      target: { kind: 'turn', sessionId, chatId },
      errorCode: 'no_output',
      error: '会话已终止但未捕获最终产出（可能失败或被取消）',
      finishedAt: inp.closedAt ?? undefined,
      message: 'async trigger terminated without output',
    };
  }

  // Running: a live session (worker in flight), a still-open session record,
  // or a durable pending result with NO session record on disk (restart edge:
  // the trigger was armed but its session file is momentarily unavailable —
  // never downgrade this to not_found).
  if (inp.liveActive || inp.storedStatus === 'open' || inp.persisted?.result.status === 'pending') {
    return {
      ok: true,
      state: 'running',
      triggerId: inp.persisted?.triggerId ?? inp.requestedTriggerId,
      action: 'queued',
      target: { kind: 'turn', sessionId, chatId },
      async: { status: 'pending', sessionId },
      message: 'async trigger running',
    };
  }

  // No session record anywhere, no persisted result.
  return {
    ok: true,
    state: 'not_found',
    triggerId: inp.requestedTriggerId,
    errorCode: 'session_not_found',
    error: `no session record for: ${sessionId}`,
    message: 'no session found',
  };
}
