/** 卡片授权默认限制：任一条件先到即失效。 */
export const DEFAULT_GRANT_DURATION_MS = 60 * 60 * 1000;
export const DEFAULT_GRANT_QUOTA = 3;

export const GRANT_DURATION_OPTIONS = [
  60 * 60 * 1000,
  8 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000,
] as const;

export function normalizeGrantDurationOption(raw: unknown): number | undefined | null {
  if (raw === 'permanent') return undefined;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return GRANT_DURATION_OPTIONS.includes(value as (typeof GRANT_DURATION_OPTIONS)[number])
    ? value
    : null;
}

export function normalizeGrantQuotaOption(raw: unknown): number | undefined | null {
  if (raw === 'unlimited' || raw === '') return undefined;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 && value <= 1000 ? value : null;
}
