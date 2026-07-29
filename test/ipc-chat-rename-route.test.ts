import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  setIpcAuthSecret,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as groupsStore from '../src/services/groups-store.js';
import * as botRegistry from '../src/bot-registry.js';

const CAP = 'ab12cd34'.repeat(8);
let handle: IpcServerHandle | null = null;

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  setIpcAuthSecret(null);
  vi.restoreAllMocks();
});

async function postRename(name: string): Promise<Response> {
  if (!handle) handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
  return fetch(`http://127.0.0.1:${handle.port}/api/sessions/s-chat-rename/chat-rename`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, proactive: true, originCapability: CAP }),
  });
}

describe('POST /api/sessions/:sessionId/chat-rename', () => {
  it('returns an idempotent success for a proactive same-name retry before applying cooldown', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-chat-rename', chatDisplayName: 'old' },
      managedTurnOrigin: { capability: CAP },
      larkAppId: 'app-chat-rename-route-test',
      chatId: 'oc-chat-rename-route-test',
      chatType: 'group',
    } as any);
    vi.spyOn(workerPool, 'getActiveSessionsRegistry').mockReturnValue(new Map());
    vi.spyOn(botRegistry, 'getBotOpenId').mockReturnValue('ou_test_bot');

    let currentName = 'old';
    const beforeUpdateCalls: string[] = [];
    vi.spyOn(groupsStore, 'renameChat').mockImplementation(async (_appId, _chatId, newName, opts) => {
      if (currentName === newName) {
        return { ok: true, oldName: currentName, newName, changed: false };
      }
      beforeUpdateCalls.push(newName);
      const gate = opts?.beforeUpdate?.();
      if (gate && !gate.ok) return { ...gate, oldName: currentName, newName };
      const oldName = currentName;
      currentName = newName;
      return { ok: true, oldName, newName, changed: true };
    });

    const first = await postRename('new');
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, changed: true, oldName: 'old', newName: 'new' });

    const sameNameRetry = await postRename('new');
    expect(sameNameRetry.status).toBe(200);
    expect(await sameNameRetry.json()).toMatchObject({ ok: true, changed: false, oldName: 'new', newName: 'new' });

    const differentNameRetry = await postRename('different');
    expect(differentNameRetry.status).toBe(429);
    expect(await differentNameRetry.json()).toMatchObject({
      ok: false,
      error: 'rate_limited',
      oldName: 'new',
      newName: 'different',
    });
    expect(beforeUpdateCalls).toEqual(['new', 'different']);
  });
});
