import type { DaemonSession } from './types.js';

// Turn-exact suppression of the daemon-rendered final_output for loud external
// triggers whose owner opted into "no trailing final notice" (connector
// suppressFinalOutput). Unlike silent scheduled fires this leaves the streaming
// card and start notice alone — only the transcript-driven final_output reply
// is dropped. Keyed on the trigger's turn id so a normal user turn queued on the
// same session can neither inherit nor un-hush the suppression. Entries outlive
// turn_terminal briefly to cover trailing worker events and are pruned by
// age/size when new suppressions are armed.
const SUPPRESS_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SUPPRESSED_TURNS_PER_SESSION = 256;

function pruneTriggerFinalSuppression(ds: DaemonSession, now: number): void {
  const turns = ds.suppressedTriggerFinalTurns;
  if (!turns) return;
  for (const [turnId, armedAt] of turns) {
    if (now - armedAt > SUPPRESS_TTL_MS) turns.delete(turnId);
  }
  while (turns.size >= MAX_SUPPRESSED_TURNS_PER_SESSION) {
    const oldest = turns.keys().next().value as string | undefined;
    if (!oldest) break;
    turns.delete(oldest);
  }
  if (turns.size === 0) ds.suppressedTriggerFinalTurns = undefined;
}

export function armTriggerFinalSuppression(
  ds: DaemonSession,
  turnId: string,
  now = Date.now(),
): void {
  pruneTriggerFinalSuppression(ds, now);
  const turns = ds.suppressedTriggerFinalTurns ??= new Map<string, number>();
  turns.set(turnId, now);
}

export function isTriggerFinalSuppressed(
  ds: DaemonSession,
  turnId?: string,
  now = Date.now(),
): boolean {
  if (!turnId) return false;
  const armedAt = ds.suppressedTriggerFinalTurns?.get(turnId);
  if (armedAt === undefined) return false;
  if (now - armedAt <= SUPPRESS_TTL_MS) return true;
  ds.suppressedTriggerFinalTurns?.delete(turnId);
  if (ds.suppressedTriggerFinalTurns?.size === 0) ds.suppressedTriggerFinalTurns = undefined;
  return false;
}

export function disarmTriggerFinalSuppression(ds: DaemonSession, turnId: string): void {
  ds.suppressedTriggerFinalTurns?.delete(turnId);
  if (ds.suppressedTriggerFinalTurns?.size === 0) ds.suppressedTriggerFinalTurns = undefined;
}
