/**
 * One-time split of the legacy shared `data/schedules.json` into per-bot
 * stores (`<botmuxHome>/bots/<appId>/schedules.json`).
 *
 * Why: the shared file needed a sandbox policy special-case (single-file
 * readWrite grant) that could not cover the RMW sibling lock
 * (`schedules.json.lock`) — a sandboxed `botmux schedule add` failed EPERM —
 * and it exposed every bot's task prompts/routing to every other sandboxed
 * bot. Per-bot stores live inside each bot's BOT_HOME, which the sandbox
 * already grants readWrite to the owner and denies to siblings by
 * construction.
 *
 * Runs at daemon startup, BEFORE the scheduler and the external-write watcher
 * touch the store. Multiple per-bot daemons boot concurrently against the same
 * legacy file: the whole split runs under the legacy file's cross-process lock
 * and re-checks existence inside it, so exactly one daemon performs the split
 * and the rest see the file already gone (renamed to `schedules.json.bak-split-v1`).
 *
 * Routing: each task goes to its `larkAppId` owner's store; tasks with no
 * `larkAppId` (or an appId not in bots.json) go to the PRIMARY bot (index 0) —
 * the same fallback the scheduler's owner filter has always used for legacy
 * ownerless tasks. Id conflicts with an existing per-bot entry keep the
 * existing entry (the per-bot store is newer by definition) and are logged.
 *
 * Downgrade: the pre-split file survives verbatim as `*.bak-split-v1`; an
 * older build can be restored by renaming it back (documented in the PR).
 * Never throws — a failed/partial migration must not brick daemon startup;
 * the legacy file stays in place and the next boot retries.
 */
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { withFileLockSync } from '../utils/file-lock.js';
import * as scheduleStore from './schedule-store.js';
import type { ScheduledTask } from '../types.js';

function legacyFilePath(): string {
  return join(config.session.dataDir, 'schedules.json');
}

export function migrateSharedSchedulesAtStartup(
  knownAppIds: readonly string[],
  primaryAppId: string,
): void {
  const legacyFp = legacyFilePath();
  if (!existsSync(legacyFp)) return; // already split (or fresh install) — no-op
  try {
    withFileLockSync(legacyFp, () => {
      // Another daemon may have completed the split while we waited on the lock.
      if (!existsSync(legacyFp)) return;

      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(legacyFp, 'utf-8'));
      } catch (err) {
        // Malformed legacy file: leave it for a human — do NOT rename (that
        // would silently discard whatever tasks it held) and do not brick boot.
        logger.error(`[schedule-split] legacy schedules.json unreadable, split skipped: ${err}`);
        return;
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        logger.error('[schedule-split] legacy schedules.json root is not an object, split skipped');
        return;
      }

      const known = new Set(knownAppIds);
      const byBot = new Map<string, Array<[string, ScheduledTask]>>();
      for (const [id, task] of Object.entries(raw as Record<string, ScheduledTask>)) {
        if (!task || typeof task !== 'object') continue;
        const owner = task.larkAppId && known.has(task.larkAppId) ? task.larkAppId : primaryAppId;
        let bucket = byBot.get(owner);
        if (!bucket) { bucket = []; byBot.set(owner, bucket); }
        bucket.push([id, task]);
      }

      for (const [appId, entries] of byBot) {
        scheduleStore.importTasks(appId, entries);
      }

      const bak = `${legacyFp}.bak-split-v1`;
      renameSync(legacyFp, bak);
      const counts = [...byBot.entries()].map(([a, e]) => `${a}:${e.length}`).join(', ');
      logger.info(`[schedule-split] split legacy schedules.json into per-bot stores (${counts || 'empty'}); backup: ${bak}`);
    });
  } catch (err) {
    logger.warn(`[schedule-split] skipped (${err instanceof Error ? err.message : String(err)})`);
  }
}
