/**
 * Stuck-warning key-injection guard.
 *
 * Extracted from worker.ts's `tui_keys` message handler so the fail-closed
 * boundary (lifetime pre-check, fresh capture, backend/lifetime re-check,
 * page-type re-match, write success/failure → delivered/expired) can be unit
 * tested in isolation. The production handler delegates to this function.
 *
 * Fail-closed contract:
 *   - expected lifetime missing / unequal → no keys written, send expired
 *   - fresh capture returns null or throws  → no keys written, send expired
 *   - backend/lifetime changed after capture, OR page type no longer matches
 *     → no keys written, send expired
 *   - write success → send delivered; write returns false or throws → send expired
 */
import type { SessionBackend } from '../adapters/backend/types.js';

export interface StuckKeyGuardMessage {
  stuckNonce: number;
  stuckPageType: string;
  stuckCliLifetime?: number;
  keys: string[];
  isFinal: boolean;
}

export interface StuckKeyGuardResult {
  /** What was sent back to the daemon, if anything. */
  sent: 'delivered' | 'expired' | 'none';
  /** Whether keys were actually written to the backend. */
  wroteKeys: boolean;
}

export interface StuckKeyGuardDeps {
  /** Current CLI lifetime nonce (incremented on every backend replacement). */
  currentLifetime: number;
  /** Current backend (may be null if CLI died). */
  backend: SessionBackend | null;
  renderCols: number;
  renderRows: number;
  turnId: string | undefined;
  dispatchAttempt: number | undefined;
  /** Fresh PTY capture. Returns null on no-screenshot; may throw. */
  capture: (
    backend: SessionBackend,
    cols: number,
    rows: number,
    opts: { filter: boolean },
  ) => Promise<{ content: string | null } | null>;
  /** Classifier: returns the page type label or undefined if no match. */
  match: (snap: string) => string | undefined;
  /** Writes keys to the backend. Returns true on success, false on failure. */
  writeKeys: (keys: string[], isFinal: boolean) => Promise<boolean>;
  /** Sends a message back to the daemon. */
  sendExpired: (nonce: number, turnId: string | undefined, dispatchAttempt: number | undefined) => void;
  sendDelivered: (nonce: number, turnId: string | undefined, dispatchAttempt: number | undefined) => void;
  log: (msg: string) => void;
}

/**
 * Process a stuck-warning card's tui_keys click with full fail-closed guards.
 *
 * Returns a result describing what happened (for testing); production callers
 * ignore the return value and rely on the side effects (sendExpired/sendDelivered
 * callbacks + writeKeys).
 */
export async function processStuckWarningTuiKeys(
  msg: StuckKeyGuardMessage,
  deps: StuckKeyGuardDeps,
): Promise<StuckKeyGuardResult> {
  const { stuckNonce, stuckPageType, stuckCliLifetime, keys, isFinal } = msg;
  const { currentLifetime, backend, renderCols, renderRows, turnId, dispatchAttempt, capture, match, writeKeys, sendExpired, sendDelivered, log } = deps;

  // P1-2: validate the CLI lifetime the card was issued for BEFORE doing
  // anything else. If the CLI restarted between card post and click,
  // currentLifetime has changed and the card's expected lifetime won't match —
  // fail-closed, do not inject keys into the new CLI. A missing expected
  // lifetime is also rejected (stuck cards must always carry it).
  if (stuckCliLifetime === undefined || stuckCliLifetime !== currentLifetime) {
    log(`TUI keys from stale stuck-warning card (nonce=${stuckNonce}, expectedLifetime=${stuckCliLifetime ?? 'none'}, currentLifetime=${currentLifetime}) — CLI replaced since card issued, dropping`);
    sendExpired(stuckNonce, turnId, dispatchAttempt);
    return { sent: 'expired', wroteKeys: false };
  }

  // Freeze the backend identity + CLI lifetime BEFORE capture. If the CLI
  // restarts (new backend object / new cliLifetimeNonce) while we await the
  // capture, the frozen values won't match the live ones and we drop the keys.
  const frozenBackend = backend;
  const frozenLifetime = currentLifetime;
  let currentSnap: string | null = null;
  if (frozenBackend) {
    try {
      const fresh = await capture(frozenBackend, renderCols, renderRows, { filter: false });
      currentSnap = fresh?.content ?? null;
    } catch {
      currentSnap = null;
    }
  }

  // Fail-closed: no fresh snapshot OR backend/lifetime changed → expired.
  if (!currentSnap || frozenBackend !== backend || frozenLifetime !== currentLifetime) {
    log(`TUI keys from stale stuck-warning card (nonce=${stuckNonce}, expected=${stuckPageType}) — fresh capture failed or backend replaced, dropping`);
    sendExpired(stuckNonce, turnId, dispatchAttempt);
    return { sent: 'expired', wroteKeys: false };
  }

  const currentMatch = match(currentSnap);
  if (currentMatch !== stuckPageType) {
    log(`TUI keys from stale stuck-warning card (nonce=${stuckNonce}, expected=${stuckPageType}, current=${currentMatch ?? 'none'}) — dropped, notifying daemon`);
    sendExpired(stuckNonce, turnId, dispatchAttempt);
    return { sent: 'expired', wroteKeys: false };
  }

  let writeOk = false;
  try {
    writeOk = await writeKeys(keys, isFinal);
  } catch {
    writeOk = false;
  }
  if (writeOk) {
    sendDelivered(stuckNonce, turnId, dispatchAttempt);
    return { sent: 'delivered', wroteKeys: true };
  }
  sendExpired(stuckNonce, turnId, dispatchAttempt);
  return { sent: 'expired', wroteKeys: false };
}
