export type CliUsageLimitKind = 'usage' | 'rate';

export interface CliUsageLimitState {
  limited: true;
  kind: CliUsageLimitKind;
  retryAtMs: number;
  retryLabel: string;
  retryReady: boolean;
}

export interface CliUsageLimitNotDetected {
  limited: false;
}

export type CliUsageLimitDetection = CliUsageLimitState | CliUsageLimitNotDetected;

const USAGE_LIMIT_PATTERNS = [
  /\bhit (?:your )?(?:usage )?limits?\b/i,
  /\busage limits?.*(?:reached|exceeded|try again)\b/i,
  /\b(?:quota|limit) (?:reached|exceeded)\b/i,
  /\b(?:reached|exceeded) (?:your )?(?:usage )?(?:limit|quota)\b/i,
];

const RATE_LIMIT_PATTERNS = [
  /\brate limits?.*(?:reached|exceeded)\b/i,
  /\brate limited\b/i,
  // HTTP-style hard rate limits from CLI/provider retries (Codex/OpenAI path).
  /\b429\b/,
  /\btoo many requests\b/i,
  /\bexceeded retry limit\b/i,
];

// Hard rate-limit signatures that often omit a wall-clock retry time.
// Only these get the fixed-cooldown fallback so generic "try again later"
// usage copy stays non-blocking (existing product decision).
const HARD_RATE_LIMIT_WITHOUT_TIME_PATTERNS = [
  /\b429\b/,
  /\btoo many requests\b/i,
  /\bexceeded retry limit\b/i,
];

// Quantized cooldown for hard 429-style errors without a parseable clock time.
// Bucketed so repeated screen ticks produce a stable usageLimitStateKey.
export const HARD_RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;

const RETRY_TIME_PATTERNS = [
  /\btry\s+again\s+at\s+(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)\b/i,
  /\bresets?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)\b/i,
];

function hasPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(text));
}

function parseMeridiemTime(text: string, now: Date): { retryAtMs: number; retryLabel: string } | null {
  for (const pattern of RETRY_TIME_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;

    const rawHour = Number(match[1]);
    const minute = match[2] === undefined ? 0 : Number(match[2]);
    const meridiem = match[3].toLowerCase().replace(/\./g, '');
    if (!Number.isInteger(rawHour) || rawHour < 1 || rawHour > 12) return null;
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

    let hour = rawHour % 12;
    if (meridiem === 'pm') hour += 12;

    const retryAt = new Date(now);
    retryAt.setHours(hour, minute, 0, 0);
    // CLI output only includes a wall-clock time, not a date. Roll passed AM
    // times into tomorrow because afternoon→midnight resets are common. Passed
    // PM times stay on today: they might mean "just reset" or "tomorrow PM",
    // and a wrong ready state self-heals when the CLI rejects the retry again.
    if (retryAt.getTime() < now.getTime() && hour < 12) {
      retryAt.setDate(retryAt.getDate() + 1);
    }

    return {
      retryAtMs: retryAt.getTime(),
      retryLabel: match[0].replace(/^(?:try\s+again\s+at|resets?(?:\s+at)?)\s+/i, '').trim(),
    };
  }
  return null;
}

/** Stable ~5 min cooldown pinned to wall-clock buckets for hard 429 fallbacks. */
function hardRateLimitFallbackTime(now: Date): { retryAtMs: number; retryLabel: string } {
  const nowMs = now.getTime();
  const bucketStart = Math.floor(nowMs / HARD_RATE_LIMIT_COOLDOWN_MS) * HARD_RATE_LIMIT_COOLDOWN_MS;
  // End of the *next* full bucket so the wait is always in (5min, 10min].
  // Within one bucket every screen tick returns the same retryAtMs/key.
  const retryAtMs = bucketStart + 2 * HARD_RATE_LIMIT_COOLDOWN_MS;
  return {
    retryAtMs,
    retryLabel: '~5 min',
  };
}

export function detectCliUsageLimit(text: string, now = new Date()): CliUsageLimitDetection {
  // Hot path: runs on every screen tick for every active session. Gate heavier
  // regex work behind one cheap scan for the >99% no-limit case.
  // Include 429 / retry-limit tokens — "retry" does not contain "again".
  if (!/again|reset|429|too many requests|rate limit|retry limit/i.test(text)) {
    return { limited: false };
  }

  const time = parseMeridiemTime(text, now);
  const isRate = hasPattern(text, RATE_LIMIT_PATTERNS);
  const isUsage = !isRate && hasPattern(text, USAGE_LIMIT_PATTERNS);
  if (!isRate && !isUsage) return { limited: false };

  if (time) {
    return {
      limited: true,
      kind: isRate ? 'rate' : 'usage',
      retryAtMs: time.retryAtMs,
      retryLabel: time.retryLabel,
      retryReady: now.getTime() >= time.retryAtMs,
    };
  }

  // Usage limits without a concrete clock time stay non-blocking (existing tests).
  // Hard HTTP 429 / exceeded-retry-limit paths get a stable cooldown fallback so
  // the session can still surface as limited → Dashboard「需要你」.
  if (isRate && hasPattern(text, HARD_RATE_LIMIT_WITHOUT_TIME_PATTERNS)) {
    const fallback = hardRateLimitFallbackTime(now);
    return {
      limited: true,
      kind: 'rate',
      retryAtMs: fallback.retryAtMs,
      retryLabel: fallback.retryLabel,
      retryReady: now.getTime() >= fallback.retryAtMs,
    };
  }

  return { limited: false };
}

export function usageLimitStateKey(state: CliUsageLimitState): string {
  return `${state.kind}:${state.retryAtMs}:${state.retryLabel}`;
}
