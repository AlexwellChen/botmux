import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { BackendType } from '../src/adapters/backend/types.js';
import type { CliId } from '../src/adapters/cli/types.js';

vi.mock('../src/services/session-store.js', () => ({
  updateSessionPid: vi.fn(),
  updateSession: vi.fn(),
}));
vi.mock('../src/core/dashboard-events.js', () => ({
  dashboardEventBus: { publish: vi.fn() },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import { detachWorker, suspendWorker } from '../src/core/worker-pool.js';
import { isSuspendableBackendType } from '../src/core/persistent-backend.js';
import { dashboardEventBus } from '../src/core/dashboard-events.js';

const CLI_IDS: CliId[] = [
  'claude-code',
  'seed',
  'aiden',
  'coco',
  'codex',
  'codex-app',
  'cursor',
  'gemini',
  'opencode',
  'antigravity',
  'mtr',
  'hermes',
  'mira',
  'traex',
  'pi',
  'copilot',
];

const BACKENDS: BackendType[] = ['pty', 'tmux', 'herdr', 'zellij'];

describe('worker suspend backend gating', () => {
  it.each(BACKENDS)('classifies %s correctly', (backend) => {
    expect(isSuspendableBackendType(backend)).toBe(backend !== 'pty');
  });

  it.each(CLI_IDS)('does not special-case CLI adapter %s', (_cliId) => {
    expect(isSuspendableBackendType('tmux')).toBe(true);
    expect(isSuspendableBackendType('herdr')).toBe(true);
    expect(isSuspendableBackendType('zellij')).toBe(true);
    expect(isSuspendableBackendType('pty')).toBe(false);
  });
});

function fakeWorker() {
  return {
    killed: false,
    pid: 12345,
    send: vi.fn(),
    once: vi.fn(),
    kill: vi.fn(),
    exitCode: null,
    signalCode: null,
  } as any;
}

describe('detachWorker', () => {
  it('worker detach IPC disconnects the observer without destroying the persistent pane', () => {
    const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    const start = source.indexOf("case 'detach':");
    const end = source.indexOf("case 'suspend':", start);
    const handler = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(handler).toContain('backend?.kill()');
    expect(handler).not.toMatch(/backend\?\.destroySession|destroySession\?\./);
  });

  it('asks a persistent worker to detach and clears only Botmux runtime ownership', () => {
    const worker = fakeWorker();
    const ds: any = {
      session: {
        sessionId: 'sid-detach',
        status: 'active',
        backendType: 'herdr',
        persistentBackendTarget: { backendType: 'herdr', sessionName: 'botmux', agentName: 'botmux-sid' },
        webPort: 3456,
      },
      initConfig: { backendType: 'herdr' },
      worker,
      workerPort: 3456,
      workerToken: 'token',
      workerViewToken: 'view-token',
      managedTurnOrigin: { capability: 'cap-live', turnId: 'om-live' },
      lastScreenStatus: 'idle',
    };

    expect(detachWorker(ds)).toBe(true);
    expect(worker.send).toHaveBeenCalledWith({ type: 'detach' });
    expect(ds.worker).toBe(null);
    expect(ds.workerPort).toBe(null);
    expect(ds.workerToken).toBe(null);
    expect(ds.workerViewToken).toBe(null);
    expect(ds.managedTurnOrigin).toBeUndefined();
    expect(ds.session.persistentBackendTarget).toEqual({
      backendType: 'herdr', sessionName: 'botmux', agentName: 'botmux-sid',
    });
    expect(ds.session.suspendedColdResume).toBeUndefined();
  });

  it('refuses to detach a PTY session', () => {
    const worker = fakeWorker();
    const ds: any = {
      session: { sessionId: 'sid-pty', status: 'active', backendType: 'pty' },
      initConfig: { backendType: 'pty' },
      worker,
    };

    expect(detachWorker(ds)).toBe(false);
    expect(worker.send).not.toHaveBeenCalled();
    expect(ds.worker).toBe(worker);
  });
});

describe('suspendWorker', () => {
  it('suspends a persistent worker without closing the active session', () => {
    const worker = fakeWorker();
    const ds: any = {
      session: { sessionId: 'sid-1', status: 'active' },
      initConfig: { backendType: 'tmux' },
      worker,
      workerPort: 3456,
      workerToken: 'token',
      managedTurnOrigin: { capability: 'cap-live', turnId: 'om-live' },
      lastScreenStatus: 'idle',
      exitEventEmitted: false,
    };

    const didSuspend = suspendWorker(ds, 'idle_budget');

    expect(didSuspend).toBe(true);
    expect(worker.send).toHaveBeenCalledWith({ type: 'suspend' });
    expect(ds.session.status).toBe('active');
    expect(ds.worker).toBe(null);
    expect(ds.workerPort).toBe(null);
    expect(ds.workerToken).toBe(null);
    expect(ds.managedTurnOrigin).toBeUndefined();
    expect(ds.lastScreenStatus).toBeUndefined();
    // The worker's suspend handler destroys the backing session + CLI, so the
    // next turn must cold-resume: mark history (→ forkWorker resume=true builds
    // --resume) and persist the suspend intent (→ restore won't zombie-close it).
    expect(ds.hasHistory).toBe(true);
    expect(ds.session.suspendedColdResume).toBe(true);
    expect(dashboardEventBus.publish).toHaveBeenCalledWith({
      type: 'session.update',
      body: {
        sessionId: 'sid-1',
        patch: { status: 'dormant', webPort: null, workerPid: null },
      },
    });
  });

  it('does not suspend pty workers', () => {
    const worker = fakeWorker();
    const ds: any = {
      session: { sessionId: 'sid-pty', status: 'active' },
      initConfig: { backendType: 'pty' },
      worker,
      workerPort: 3456,
      workerToken: 'token',
      managedTurnOrigin: { capability: 'cap-pty', turnId: 'om-pty' },
    };

    expect(suspendWorker(ds, 'idle_budget')).toBe(false);
    expect(worker.send).not.toHaveBeenCalled();
    expect(ds.worker).toBe(worker);
    expect(ds.managedTurnOrigin).toEqual({ capability: 'cap-pty', turnId: 'om-pty' });
  });

  it.each([
    ['missing', null],
    ['already killed', { killed: true }],
  ])('clears managed-turn authority when the worker generation is %s', (_state, worker) => {
    const ds: any = {
      session: { sessionId: 'sid-absent', status: 'active' },
      initConfig: { backendType: 'tmux' },
      worker,
      managedTurnOrigin: { capability: 'cap-stale', turnId: 'om-stale' },
    };

    expect(suspendWorker(ds, 'idle_budget')).toBe(false);
    expect(ds.managedTurnOrigin).toBeUndefined();
  });
});
