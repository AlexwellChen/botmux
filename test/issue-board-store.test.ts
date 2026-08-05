import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claimNextOutboxRow,
  createBinding,
  enqueueDesiredStatus,
  failOutboxRow,
  findActiveBindingByIssue,
  findBindingByClaimId,
  getBinding,
  listOutbox,
  pruneOutbox,
  removeBinding,
  resetInflightToPending,
  settleOutboxRow,
  updateBinding,
  type CreateBindingInput,
} from '../src/services/issue-board-store.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'issue-board-store-'));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

function seed(over: Partial<CreateBindingInput> = {}): CreateBindingInput {
  return {
    sessionId: 's-1',
    localTaskRef: 'cli_app::s-1',
    larkAppId: 'cli_app',
    issueId: 'iss-1',
    teamId: 't1',
    platformBaseUrl: 'https://platform.example',
    claimId: 'c-random-1',
    claimEpoch: 1,
    ...over,
  };
}

describe('bindings', () => {
  it('新建后可按 sessionId / claimId / issueId 查到，sourceSeq 从 1 起', () => {
    const b = createBinding(dataDir, seed());
    expect(b.bindState).toBe('pending');
    expect(b.nextSourceSeq).toBe(1);
    expect(getBinding(dataDir, 's-1')?.issueId).toBe('iss-1');
    expect(findBindingByClaimId(dataDir, 'c-random-1')?.sessionId).toBe('s-1');
    expect(findActiveBindingByIssue(dataDir, 'iss-1')?.sessionId).toBe('s-1');
  });

  // 领取重试必须幂等：否则一次网络重试就会多建一个群、多起一个会话。
  it('同 claimId 重入返回既有 binding，不新建第二条', () => {
    const first = createBinding(dataDir, seed());
    const again = createBinding(dataDir, seed({ sessionId: 's-2', localTaskRef: 'cli_app::s-2' }));
    expect(again.sessionId).toBe(first.sessionId);
    expect(getBinding(dataDir, 's-2')).toBeNull();
  });

  it('void 的 binding 不再算作该 issue 的活跃绑定', () => {
    createBinding(dataDir, seed());
    updateBinding(dataDir, 's-1', { bindState: 'void' });
    expect(findActiveBindingByIssue(dataDir, 'iss-1')).toBeNull();
    expect(findBindingByClaimId(dataDir, 'c-random-1')).not.toBeNull(); // 反查仍能拿到，供对账
  });

  it('updateBinding 不动 sessionId/createdAt，removeBinding 删得掉', () => {
    const b = createBinding(dataDir, seed());
    const p = updateBinding(dataDir, 's-1', { bindState: 'bound', chatId: 'oc_x' });
    expect(p?.bindState).toBe('bound');
    expect(p?.chatId).toBe('oc_x');
    expect(p?.createdAt).toBe(b.createdAt);
    expect(removeBinding(dataDir, 's-1')).toBe(true);
    expect(removeBinding(dataDir, 's-1')).toBe(false);
  });

  it('损坏的 bindings 文件不抛异常，按空表处理', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dataDir, 'issue-bindings.json'), '{ this is not json');
    expect(getBinding(dataDir, 's-1')).toBeNull();
    expect(() => createBinding(dataDir, seed())).not.toThrow();
  });
});

describe('outbox 去重合并', () => {
  beforeEach(() => createBinding(dataDir, seed()));

  it('首次投影排一条 pending，sourceSeq=1 且 binding 计数器前进', () => {
    const row = enqueueDesiredStatus(dataDir, 's-1', 'in_progress');
    expect(row?.sourceSeq).toBe(1);
    expect(row?.state).toBe('pending');
    expect(getBinding(dataDir, 's-1')?.nextSourceSeq).toBe(2);
  });

  it('重复投影同一目标 → 不新增行', () => {
    enqueueDesiredStatus(dataDir, 's-1', 'in_progress');
    expect(enqueueDesiredStatus(dataDir, 's-1', 'in_progress')).toBeNull();
    expect(listOutbox(dataDir, 's-1')).toHaveLength(1);
  });

  // 离线期间 30s 一次 tick 会反复投影。若每次追加，恢复后会把一串过时中间态依次发出去，
  // 最新状态还排在队尾——这正是设计里去重合并要解决的问题。
  it('pending 行被就地覆盖为最新目标，不产生一串中间态', () => {
    enqueueDesiredStatus(dataDir, 's-1', 'in_progress');
    enqueueDesiredStatus(dataDir, 's-1', 'in_review');
    const done = enqueueDesiredStatus(dataDir, 's-1', 'done');
    const rows = listOutbox(dataDir, 's-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].targetStatus).toBe('done');
    expect(done?.sourceSeq).toBe(3); // 每次覆盖都重分配序号，保持单调
    expect(getBinding(dataDir, 's-1')?.nextSourceSeq).toBe(4);
  });

  it('已发出（inflight）之后再投影新目标 → 追加新行而不是覆盖', () => {
    enqueueDesiredStatus(dataDir, 's-1', 'in_progress');
    claimNextOutboxRow(dataDir, 's-1');
    const next = enqueueDesiredStatus(dataDir, 's-1', 'in_review');
    expect(next).not.toBeNull();
    expect(listOutbox(dataDir, 's-1')).toHaveLength(2);
  });

  it('desired 与已同步状态相同 → 不排队', () => {
    updateBinding(dataDir, 's-1', { lastSyncedStatus: 'in_progress' });
    expect(enqueueDesiredStatus(dataDir, 's-1', 'in_progress')).toBeNull();
  });

  it('void 的 binding 不再排队回写', () => {
    updateBinding(dataDir, 's-1', { bindState: 'void' });
    expect(enqueueDesiredStatus(dataDir, 's-1', 'in_progress')).toBeNull();
  });

  it('expectedStateRev 缺省取 binding 上记录的平台 stateRev', () => {
    updateBinding(dataDir, 's-1', { platformStateRev: 7 });
    expect(enqueueDesiredStatus(dataDir, 's-1', 'in_progress')?.expectedStateRev).toBe(7);
    // 显式传入时以传入为准
    claimNextOutboxRow(dataDir, 's-1');
    expect(enqueueDesiredStatus(dataDir, 's-1', 'done', { expectedStateRev: 9 })?.expectedStateRev).toBe(9);
  });
});

describe('outbox 串行 pump', () => {
  beforeEach(() => createBinding(dataDir, seed()));

  // 平台要求同一 issue 的 sourceSeq 单调到达，并发发送会打乱顺序。
  it('同一 binding 已有 inflight 时不再领取下一条', () => {
    enqueueDesiredStatus(dataDir, 's-1', 'in_progress');
    claimNextOutboxRow(dataDir, 's-1');
    enqueueDesiredStatus(dataDir, 's-1', 'in_review');
    expect(claimNextOutboxRow(dataDir, 's-1')).toBeNull();
  });

  it('领取会把 pending 标 inflight 并累加 attempts', () => {
    enqueueDesiredStatus(dataDir, 's-1', 'in_progress');
    const row = claimNextOutboxRow(dataDir, 's-1');
    expect(row?.state).toBe('inflight');
    expect(row?.attempts).toBe(1);
  });

  it('settle 后写回 lastSyncedStatus 与 platformStateRev，且不再被领取', () => {
    enqueueDesiredStatus(dataDir, 's-1', 'in_progress');
    const row = claimNextOutboxRow(dataDir, 's-1')!;
    settleOutboxRow(dataDir, row.writeId, { platformStateRev: 12 });
    const b = getBinding(dataDir, 's-1')!;
    expect(b.lastSyncedStatus).toBe('in_progress');
    expect(b.platformStateRev).toBe(12);
    expect(claimNextOutboxRow(dataDir, 's-1')).toBeNull();
  });

  it('失败退回 pending 并按退避推迟；到点后可再领', () => {
    enqueueDesiredStatus(dataDir, 's-1', 'in_progress');
    const row = claimNextOutboxRow(dataDir, 's-1')!;
    const t0 = 1_000_000;
    failOutboxRow(dataDir, row.writeId, 'ECONNRESET', {}, t0);
    expect(claimNextOutboxRow(dataDir, 's-1', t0)).toBeNull(); // 退避未到
    const again = claimNextOutboxRow(dataDir, 's-1', t0 + 10_000);
    expect(again?.attempts).toBe(2);
  });

  it('fatal 失败标 failed，不再重试', () => {
    enqueueDesiredStatus(dataDir, 's-1', 'in_progress');
    const row = claimNextOutboxRow(dataDir, 's-1')!;
    failOutboxRow(dataDir, row.writeId, 'machine_mismatch', { fatal: true });
    expect(claimNextOutboxRow(dataDir, 's-1', Date.now() + 3_600_000)).toBeNull();
    expect(listOutbox(dataDir, 's-1')[0].state).toBe('failed');
  });
});

describe('崩溃对账', () => {
  // 「标 inflight 后、记录响应前」崩溃的行会永久堵死该 binding 的串行 pump。
  it('启动时把 inflight 全退回 pending，pump 恢复', () => {
    createBinding(dataDir, seed());
    enqueueDesiredStatus(dataDir, 's-1', 'in_progress');
    claimNextOutboxRow(dataDir, 's-1');
    expect(claimNextOutboxRow(dataDir, 's-1')).toBeNull(); // 崩溃前的堵塞态

    expect(resetInflightToPending(dataDir)).toBe(1);
    expect(claimNextOutboxRow(dataDir, 's-1')?.state).toBe('inflight');
  });

  it('没有 inflight 时不写文件、返回 0', () => {
    createBinding(dataDir, seed());
    expect(resetInflightToPending(dataDir)).toBe(0);
  });
});

describe('pruneOutbox', () => {
  it('只清 done、保留最近 N 条', () => {
    createBinding(dataDir, seed());
    for (let i = 0; i < 5; i++) {
      enqueueDesiredStatus(dataDir, 's-1', i % 2 === 0 ? 'in_progress' : 'in_review');
      const row = claimNextOutboxRow(dataDir, 's-1')!;
      settleOutboxRow(dataDir, row.writeId, {});
    }
    enqueueDesiredStatus(dataDir, 's-1', 'done');
    expect(pruneOutbox(dataDir, 2)).toBe(3);
    const rows = listOutbox(dataDir, 's-1');
    expect(rows.filter((r) => r.state === 'done')).toHaveLength(2);
    expect(rows.filter((r) => r.state === 'pending')).toHaveLength(1); // 未完成的绝不清
  });
});
