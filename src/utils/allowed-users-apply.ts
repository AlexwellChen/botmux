/**
 * Decide how to apply a startup / refresh resolve of allowedUsers.
 *
 * Runtime permission (canTalk/canOperate) only matches app-scoped open_ids
 * (`ou_…`). Config may store stable `on_…` / emails that must be resolved each
 * boot. A transient contact API failure used to overwrite the runtime list with
 * `[]`, which fail-closed locks out even the real owner with almost no signal.
 */

export interface AllowedUsersResolveResultLike {
  resolved: string[];
  map: Map<string, string>;
  /** True when contact API hit a transient failure (network / 5xx / rate limit). */
  errored?: boolean;
}

export interface ApplyAllowedUsersResolveInput {
  /** Raw bots.json entries (ou_ / on_ / email). */
  rawEntries: string[];
  /**
   * Last known-good open_ids (typically previous daemon descriptor or in-memory
   * list already filtered to `ou_`). Used only as a fallback.
   */
  previousResolvedOpenIds: string[];
  resolveResult: AllowedUsersResolveResultLike;
}

export interface ApplyAllowedUsersResolveOutput {
  resolved: string[];
  map: Map<string, string>;
  /** True when runtime list came from previousResolvedOpenIds, not this resolve. */
  usedFallback: boolean;
  /**
   * True when config has entries but we could not produce a fresh successful
   * resolve (empty result and/or errored). Callers must surface a notice.
   */
  failed: boolean;
  /** Human-readable notice for logs / owner DM; null when nothing to report. */
  notice: string | null;
}

function onlyOpenIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !id.startsWith('ou_') || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function needsContactResolve(rawEntries: string[]): boolean {
  return rawEntries.some(u => u.includes('@') || u.startsWith('on_') || u.startsWith('ou_'));
}

/**
 * Pure merge of resolve result + optional last-good open_id cache.
 * Never leaves bare `on_` / emails in the runtime list — those cannot match
 * message senders and would still lock the owner out.
 */
export function applyAllowedUsersResolve(
  input: ApplyAllowedUsersResolveInput,
): ApplyAllowedUsersResolveOutput {
  const rawEntries = input.rawEntries.filter(u => typeof u === 'string' && u.trim().length > 0);
  const previous = onlyOpenIds(input.previousResolvedOpenIds);
  const { resolved, map, errored } = input.resolveResult;
  const fresh = onlyOpenIds(resolved);

  if (rawEntries.length === 0) {
    return {
      resolved: [],
      map,
      usedFallback: false,
      failed: false,
      notice: null,
    };
  }

  if (fresh.length > 0 && !errored) {
    return {
      resolved: fresh,
      map,
      usedFallback: false,
      failed: false,
      notice: null,
    };
  }

  // Partial success with transient error: prefer fresh open_ids when present,
  // but still surface a notice so operators know contact API is unhealthy.
  if (fresh.length > 0 && errored) {
    return {
      resolved: fresh,
      map,
      usedFallback: false,
      failed: true,
      notice:
        `allowedUsers contact resolve reported transient errors; using ${fresh.length} freshly resolved open_id(s). ` +
        `Raw entries: ${rawEntries.join(', ')}`,
    };
  }

  // Total miss: keep last-good open_ids so owner is not fail-closed into silence.
  if (previous.length > 0) {
    return {
      resolved: previous,
      map,
      usedFallback: true,
      failed: true,
      notice:
        `allowedUsers resolve failed (empty runtime list from contact API` +
        `${errored ? ', transient error flagged' : ''}); ` +
        `temporarily reusing ${previous.length} last-known open_id(s). ` +
        `Raw entries: ${rawEntries.join(', ')}. ` +
        `Owner talk may work via cache; restart/retry after Feishu contact recovers.`,
    };
  }

  if (!needsContactResolve(rawEntries)) {
    return {
      resolved: [],
      map,
      usedFallback: false,
      failed: false,
      notice: null,
    };
  }

  return {
    resolved: [],
    map,
    usedFallback: false,
    failed: true,
    notice:
      `allowedUsers resolve failed and no last-known open_id cache is available; ` +
      `runtime allowlist is empty so everyone (including the real owner) is denied. ` +
      `Raw entries: ${rawEntries.join(', ')}. Check Feishu contact API / bot scopes, then restart the bot.`,
  };
}
