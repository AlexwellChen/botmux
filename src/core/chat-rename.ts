export const CHAT_NAME_MAX_CODE_POINTS = 100;
export const CHAT_RENAME_COOLDOWN_MS = 10 * 60_000;

export function normalizeLarkChatName(input: unknown):
  | { ok: true; name: string }
  | { ok: false; error: 'invalid_chat_name' } {
  if (typeof input !== 'string') return { ok: false, error: 'invalid_chat_name' };
  const name = input.trim();
  if (
    !name
    || Array.from(name).length > CHAT_NAME_MAX_CODE_POINTS
    || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u.test(name)
  ) {
    return { ok: false, error: 'invalid_chat_name' };
  }
  return { ok: true, name };
}

export class ChatRenameCooldown {
  private readonly lastAt = new Map<string, number>();

  constructor(private readonly cooldownMs = CHAT_RENAME_COOLDOWN_MS) {}

  check(key: string, now = Date.now()):
    | { ok: true }
    | { ok: false; retryAfterSeconds: number } {
    const last = this.lastAt.get(key) ?? 0;
    if (now - last >= this.cooldownMs) return { ok: true };
    return {
      ok: false,
      retryAfterSeconds: Math.ceil((this.cooldownMs - (now - last)) / 1000),
    };
  }

  record(key: string, now = Date.now()): void {
    this.lastAt.set(key, now);
  }
}
