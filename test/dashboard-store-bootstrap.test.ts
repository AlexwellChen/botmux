import { afterEach, describe, expect, it, vi } from 'vitest';

type Listener = (event: { data: string }) => void;

class FakeEventSource {
  static instance: FakeEventSource | null = null;
  readonly listeners = new Map<string, Listener>();
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instance = this;
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, listener);
  }

  emit(type: string, body: unknown): void {
    this.listeners.get(type)?.({
      data: JSON.stringify({ body }),
    });
  }

  open(): void {
    this.onopen?.();
  }

  close(): void {
    this.closed = true;
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>(done => { resolve = done; }),
    resolve,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeEventSource.instance = null;
});

describe('dashboard store bootstrap', () => {
  it('waits for SSE open, buffers snapshot races, and reconciles reconnect gaps', async () => {
    const initialSessions = deferred<Response>();
    const initialSchedules = deferred<Response>();
    const reconnectSessions = deferred<Response>();
    const reconnectSchedules = deferred<Response>();
    const sessionResponses = [initialSessions.promise, reconnectSessions.promise];
    const scheduleResponses = [initialSchedules.promise, reconnectSchedules.promise];
    vi.stubGlobal('EventSource', FakeEventSource);
    const fetchMock = vi.fn((path: string) => (
      path === '/api/sessions'
        ? sessionResponses.shift()!
        : scheduleResponses.shift()!
    ));
    vi.stubGlobal('fetch', fetchMock);
    const { bootstrap, store } = await import('../src/dashboard/web/store.js');

    const boot = bootstrap();
    const events = FakeEventSource.instance;
    expect(events?.url).toBe('/events');
    expect(fetchMock).not.toHaveBeenCalled();
    events?.open();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    events?.emit('session.spawned', {
      session: {
        sessionId: 'race-session',
        status: 'idle',
        repoName: 'botmux',
        gitBranch: 'feat/live',
      },
    });

    initialSessions.resolve(new Response(JSON.stringify({
      sessions: [{
        sessionId: 'race-session',
        status: 'working',
        repoName: 'botmux',
        gitBranch: 'main',
      }, {
        sessionId: 'removed-while-offline',
        status: 'idle',
      }],
    })));
    initialSchedules.resolve(new Response(JSON.stringify({
      schedules: [{ id: 'deleted-schedule' }],
    })));
    await boot;

    expect(store.sessions.get('race-session')).toMatchObject({
      status: 'idle',
      gitBranch: 'feat/live',
    });
    expect(store.sessions.has('removed-while-offline')).toBe(true);
    expect(store.schedules.has('deleted-schedule')).toBe(true);

    events?.open();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    events?.emit('session.update', {
      sessionId: 'race-session',
      patch: { status: 'idle', gitBranch: 'feat/reconnected' },
    });
    reconnectSessions.resolve(new Response(JSON.stringify({
      sessions: [{
        sessionId: 'race-session',
        status: 'working',
        repoName: 'botmux',
        gitBranch: 'main',
      }],
    })));
    reconnectSchedules.resolve(new Response(JSON.stringify({ schedules: [] })));

    await vi.waitFor(() => {
      expect(store.sessions.get('race-session')).toMatchObject({
        status: 'idle',
        gitBranch: 'feat/reconnected',
      });
      expect(store.sessions.has('removed-while-offline')).toBe(false);
      expect(store.schedules.has('deleted-schedule')).toBe(false);
    });
  });
});
