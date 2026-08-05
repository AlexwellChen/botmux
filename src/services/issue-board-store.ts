/**
 * Issue Board 本地状态：binding（issue ↔ 本机会话）与 outbox（状态回写发件箱）。
 *
 * 平台侧契约见 platform 仓 DESIGN-issue-board.md §六/§七。那份设计是按 Desktop 写的，
 * Desktop 有 SQLite、能把「建本地任务」和「写 binding」放进**同一个事务**。botmux 没有
 * SQLite（全仓都是 JSON + 原子写），所以这里换一套等价的崩溃安全约定：
 *
 *   **先写 binding（bindState='pending'），再建群/开会话。**
 *
 * 顺序不能反。反了就是「群建出来了但没人知道它属于哪个 issue」的孤儿——重启后既补不了
 * bind、也认不出该撤回哪个群。反过来「binding 写了但群没建成」是安全的：启动对账看到
 * pending 且无 chatId，重建或作废即可，此刻**本机还没有任何 agent 在跑**。
 *
 * 单写者假设：claim 流程与 outbox pump 都只跑在 dashboard 进程（machineToken 与隧道都在
 * 那儿），故 read-modify-write 不加文件锁——与 [[invite-store]] 同一部署模型。真出现多
 * dashboard 并发写，这里需要补 file-lock。
 *
 * 存储：`{dataDir}/issue-bindings.json`、`{dataDir}/issue-outbox.json`。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

/** 平台 IssueStatus 的线上取值（回写目标只用得到其中一部分，但解析要认全）。 */
export type IssueStatus =
  | 'open'
  | 'claimed'
  | 'in_progress'
  | 'in_review'
  | 'done'
  | 'cancelling'
  | 'needs_attention'
  | 'reopened';

export type AttentionReason =
  | 'cancel_delivery_timeout'
  | 'claim_activate_timeout'
  | 'task_blocked'
  | 'run_timeout';

/**
 * 一条 issue ↔ 本机会话的绑定。
 *
 * `bindState` 三态对应 §六 的三个崩溃恢复分支：
 *  - `pending`：claim 成功、binding 已落盘，但还没向平台 bind（群可能还没建出来）
 *  - `bound`  ：平台已接受 bind，本地会话可以 activate（发 kickoff @ bot）
 *  - `void`   ：补 bind 被平台拒（issue 被回收 / 别人领走 / 代次过期），这条作废
 */
export interface IssueBinding {
  /** 本机会话 id —— 主键，也是「本地任务」。 */
  sessionId: string;
  /** 平台契约的 localTaskRef = `<larkAppId>::<sessionId>`。localTaskId 只在其所属
   *  runtime 内有意义，必须带命名空间；botmux 的 runtime 边界就是 bot（larkAppId）。 */
  localTaskRef: string;
  larkAppId: string;
  issueId: string;
  teamId: string;
  /** 绑到哪个平台（换绑/多平台时区分该往哪回写）。 */
  platformBaseUrl: string;
  /** 领取幂等键，必须是高熵随机（禁止由 issueId 派生）。全表唯一。 */
  claimId: string;
  /** 领取代次快照——回写栅栏，旧代次的迟到回写会被平台按 stale_epoch 丢弃。 */
  claimEpoch: number;
  bindState: 'pending' | 'bound' | 'void';
  /** 拉群模式下为这个 issue 建的群。崩溃恢复据此复用而不是再建一个。 */
  chatId?: string;
  /** 本 binding 的 sourceSeq 分配计数器：单调、每 binding 唯一，平台的线上幂等只认它。 */
  nextSourceSeq: number;
  /** 已成功回写的状态（离线期间不动——去重合并要拿它和「最新未完成目标」一起比）。 */
  lastSyncedStatus?: IssueStatus;
  /** 上次回写后平台返回的 issue.stateRev，下次状态 CAS 用。 */
  platformStateRev?: number;
  createdAt: number;
  updatedAt: number;
}

export interface IssueOutboxRow {
  /** 仅本地行主键（去重发送用），不上送平台——平台幂等只认 sourceSeq。 */
  writeId: string;
  sessionId: string;
  sourceSeq: number;
  targetStatus: IssueStatus;
  attentionReason?: AttentionReason;
  claimId: string;
  claimEpoch: number;
  expectedStateRev?: number;
  state: 'pending' | 'inflight' | 'done' | 'failed';
  attempts: number;
  nextRetryAt?: number;
  lastError?: string;
  createdAt: number;
}

function bindingsPath(dataDir: string): string {
  return join(dataDir, 'issue-bindings.json');
}
function outboxPath(dataDir: string): string {
  return join(dataDir, 'issue-outbox.json');
}

function readJson<T>(fp: string, fallback: T): T {
  if (!existsSync(fp)) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8'));
    if (parsed && typeof parsed === 'object') return parsed as T;
  } catch {
    // 文件损坏 → fallback。binding 丢了会让在跑的会话失去 issue 关联（人工 force-detach
    // 兜底），但绝不能因为一个坏文件让整个 daemon 起不来。
  }
  return fallback;
}

// ── bindings ────────────────────────────────────────────────────────────────

export function listBindings(dataDir: string): IssueBinding[] {
  return Object.values(readJson<Record<string, IssueBinding>>(bindingsPath(dataDir), {}));
}

export function getBinding(dataDir: string, sessionId: string): IssueBinding | null {
  return readJson<Record<string, IssueBinding>>(bindingsPath(dataDir), {})[sessionId] ?? null;
}

/** 按 claimId 反查——崩溃恢复的入口（§六：不依赖平台「按 claimId 查 issue」的接口，那个接口不存在）。 */
export function findBindingByClaimId(dataDir: string, claimId: string): IssueBinding | null {
  return listBindings(dataDir).find((b) => b.claimId === claimId) ?? null;
}

/** 某 issue 当前在本机的活跃 binding（void 的不算）。用于「这个 issue 是不是我已经领了」。 */
export function findActiveBindingByIssue(dataDir: string, issueId: string): IssueBinding | null {
  return listBindings(dataDir).find((b) => b.issueId === issueId && b.bindState !== 'void') ?? null;
}

function writeBindings(dataDir: string, all: Record<string, IssueBinding>): void {
  atomicWriteFileSync(bindingsPath(dataDir), JSON.stringify(all, null, 2) + '\n');
}

export type CreateBindingInput = Omit<
  IssueBinding,
  'nextSourceSeq' | 'createdAt' | 'updatedAt' | 'bindState'
> & { bindState?: IssueBinding['bindState'] };

/**
 * 写入一条 pending binding。**必须在建群/开会话之前调用**（见文件头）。
 *
 * claimId 唯一：同 claimId 重入直接返回既有行（本地幂等，对应 Desktop 侧的
 * `UNIQUE(claim_id)`）——领取重试不会产生第二条 binding、也不会重复建群。
 */
export function createBinding(
  dataDir: string,
  input: CreateBindingInput,
  now: number = Date.now(),
): IssueBinding {
  const all = readJson<Record<string, IssueBinding>>(bindingsPath(dataDir), {});
  const existing = Object.values(all).find((b) => b.claimId === input.claimId);
  if (existing) return existing;
  const binding: IssueBinding = {
    ...input,
    bindState: input.bindState ?? 'pending',
    nextSourceSeq: 1,
    createdAt: now,
    updatedAt: now,
  };
  all[binding.sessionId] = binding;
  writeBindings(dataDir, all);
  return binding;
}

/** 局部更新一条 binding（read-modify-write，保住并发写入的其它字段）。 */
export function updateBinding(
  dataDir: string,
  sessionId: string,
  patch: Partial<Omit<IssueBinding, 'sessionId' | 'createdAt'>>,
  now: number = Date.now(),
): IssueBinding | null {
  const all = readJson<Record<string, IssueBinding>>(bindingsPath(dataDir), {});
  const cur = all[sessionId];
  if (!cur) return null;
  const next: IssueBinding = { ...cur, ...patch, sessionId: cur.sessionId, createdAt: cur.createdAt, updatedAt: now };
  all[sessionId] = next;
  writeBindings(dataDir, all);
  return next;
}

/** 删除一条 binding（会话彻底结束且 issue 已终态后清理）。返回是否删掉。 */
export function removeBinding(dataDir: string, sessionId: string): boolean {
  const all = readJson<Record<string, IssueBinding>>(bindingsPath(dataDir), {});
  if (!(sessionId in all)) return false;
  delete all[sessionId];
  writeBindings(dataDir, all);
  return true;
}

// ── outbox ──────────────────────────────────────────────────────────────────

function readOutbox(dataDir: string): IssueOutboxRow[] {
  const raw = readJson<IssueOutboxRow[] | Record<string, never>>(outboxPath(dataDir), []);
  return Array.isArray(raw) ? raw : [];
}

function writeOutbox(dataDir: string, rows: IssueOutboxRow[]): void {
  atomicWriteFileSync(outboxPath(dataDir), JSON.stringify(rows, null, 2) + '\n');
}

export function listOutbox(dataDir: string, sessionId?: string): IssueOutboxRow[] {
  const rows = readOutbox(dataDir);
  return sessionId === undefined ? rows : rows.filter((r) => r.sessionId === sessionId);
}

/**
 * 投影一次「本会话应达的 issue 状态」到发件箱（§七 去重合并）。
 *
 * 合并规则（**与最新未完成目标比，不是与 lastSyncedStatus 比**）：
 *  - 该 binding 已有 `pending` 行 → **就地覆盖**它的 targetStatus 并重分配 sourceSeq，不新增行；
 *  - 否则仅当 desired 与「最新目标 ∪ lastSyncedStatus」都不同才排一条新行。
 *
 * 为什么必须这样：离线期间 30s 一次的 tick 会反复投影，若每次都追加，恢复后会把一长串
 * 早已过时的中间态依次发给平台——既刷无效自迁移，又让**最新**状态排在队尾迟迟到不了。
 *
 * 返回排出的行；无需回写时返回 null。
 */
export function enqueueDesiredStatus(
  dataDir: string,
  sessionId: string,
  desired: IssueStatus,
  opts: { attentionReason?: AttentionReason; expectedStateRev?: number } = {},
  now: number = Date.now(),
): IssueOutboxRow | null {
  const bindings = readJson<Record<string, IssueBinding>>(bindingsPath(dataDir), {});
  const binding = bindings[sessionId];
  if (!binding || binding.bindState === 'void') return null;

  const rows = readOutbox(dataDir);
  const mine = rows.filter((r) => r.sessionId === sessionId);
  const pendingIdx = rows.findIndex((r) => r.sessionId === sessionId && r.state === 'pending');
  const latestUnsettled = mine
    .filter((r) => r.state === 'pending' || r.state === 'inflight')
    .sort((a, b) => b.sourceSeq - a.sourceSeq)[0];

  // 已经在追同一个目标（或已经同步到位）→ 无事可做。
  if (pendingIdx < 0) {
    const latestTarget = latestUnsettled?.targetStatus;
    if (desired === latestTarget || (latestTarget === undefined && desired === binding.lastSyncedStatus)) {
      return null;
    }
  } else if (rows[pendingIdx].targetStatus === desired && rows[pendingIdx].attentionReason === opts.attentionReason) {
    return null;
  }

  const sourceSeq = binding.nextSourceSeq;
  const row: IssueOutboxRow = {
    writeId: randomUUID(),
    sessionId,
    sourceSeq,
    targetStatus: desired,
    ...(opts.attentionReason ? { attentionReason: opts.attentionReason } : {}),
    claimId: binding.claimId,
    claimEpoch: binding.claimEpoch,
    ...(opts.expectedStateRev !== undefined
      ? { expectedStateRev: opts.expectedStateRev }
      : binding.platformStateRev !== undefined
        ? { expectedStateRev: binding.platformStateRev }
        : {}),
    state: 'pending',
    attempts: 0,
    createdAt: now,
  };
  if (pendingIdx >= 0) rows[pendingIdx] = row; // 就地覆盖未发送行
  else rows.push(row);
  writeOutbox(dataDir, rows);

  bindings[sessionId] = { ...binding, nextSourceSeq: sourceSeq + 1, updatedAt: now };
  writeBindings(dataDir, bindings);
  return row;
}

/**
 * 领取该 binding 的下一条待发行（`pending → inflight` 的 CAS）。
 *
 * **串行**：同一 binding 已有 inflight 行时返回 null——平台侧要求同一 issue 的 sourceSeq
 * 单调到达，并发发送会让顺序乱掉。`nextRetryAt` 未到的行也不返回（退避）。
 */
export function claimNextOutboxRow(
  dataDir: string,
  sessionId: string,
  now: number = Date.now(),
): IssueOutboxRow | null {
  const rows = readOutbox(dataDir);
  const mine = rows.filter((r) => r.sessionId === sessionId);
  if (mine.some((r) => r.state === 'inflight')) return null;
  const idx = rows.findIndex(
    (r) => r.sessionId === sessionId && r.state === 'pending' && (r.nextRetryAt ?? 0) <= now,
  );
  if (idx < 0) return null;
  rows[idx] = { ...rows[idx], state: 'inflight', attempts: rows[idx].attempts + 1 };
  writeOutbox(dataDir, rows);
  return rows[idx];
}

/** 发送成功：标 done，并把平台返回的 stateRev / 已同步状态写回 binding。 */
export function settleOutboxRow(
  dataDir: string,
  writeId: string,
  result: { platformStateRev?: number },
  now: number = Date.now(),
): void {
  const rows = readOutbox(dataDir);
  const idx = rows.findIndex((r) => r.writeId === writeId);
  if (idx < 0) return;
  const row = rows[idx];
  rows[idx] = { ...row, state: 'done' };
  writeOutbox(dataDir, rows);
  updateBinding(
    dataDir,
    row.sessionId,
    {
      lastSyncedStatus: row.targetStatus,
      ...(result.platformStateRev !== undefined ? { platformStateRev: result.platformStateRev } : {}),
    },
    now,
  );
}

/** 发送失败：退回 pending + 指数退避（上限 5min）。`fatal` 用于平台明确拒绝、重试无意义的情况。 */
export function failOutboxRow(
  dataDir: string,
  writeId: string,
  error: string,
  opts: { fatal?: boolean } = {},
  now: number = Date.now(),
): void {
  const rows = readOutbox(dataDir);
  const idx = rows.findIndex((r) => r.writeId === writeId);
  if (idx < 0) return;
  const row = rows[idx];
  const backoff = Math.min(1_000 * 2 ** Math.max(0, row.attempts - 1), 5 * 60_000);
  rows[idx] = {
    ...row,
    state: opts.fatal ? 'failed' : 'pending',
    lastError: error.slice(0, 500),
    ...(opts.fatal ? {} : { nextRetryAt: now + backoff }),
  };
  writeOutbox(dataDir, rows);
}

/**
 * 启动对账：把本机所有 `inflight` 退回 `pending`。
 *
 * 进程在「标 inflight 后、记录响应前」崩溃时，那一行会永远停在 inflight 并**堵死该
 * binding 的串行 pump**（claimNextOutboxRow 见到 inflight 就返回 null）。平台侧的
 * sourceSeq 单调 + 终态幂等保证重复投递是安全的，所以无脑退回即可，不需要发送租约。
 *
 * 返回被退回的行数。
 */
export function resetInflightToPending(dataDir: string): number {
  const rows = readOutbox(dataDir);
  let n = 0;
  const next = rows.map((r) => {
    if (r.state !== 'inflight') return r;
    n += 1;
    return { ...r, state: 'pending' as const };
  });
  if (n > 0) writeOutbox(dataDir, next);
  return n;
}

/** 清理已完成的发件箱行（保留最近 `keep` 条便于排查）。返回清掉的行数。 */
export function pruneOutbox(dataDir: string, keep = 50): number {
  const rows = readOutbox(dataDir);
  const settled = rows.filter((r) => r.state === 'done');
  if (settled.length <= keep) return 0;
  const drop = new Set(
    settled.sort((a, b) => a.createdAt - b.createdAt).slice(0, settled.length - keep).map((r) => r.writeId),
  );
  writeOutbox(dataDir, rows.filter((r) => !drop.has(r.writeId)));
  return drop.size;
}
