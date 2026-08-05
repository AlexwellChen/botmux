/**
 * 释放领取：把一个已领取的 issue 退回平台的待领取池。
 *
 * 是 [[issue-claim-flow]] 的逆操作，但**不是回滚**——领取过程中的失败靠「留下可对账的状态」
 * 收拾（见那边的注释），这里处理的是完全不同的场景：领取成功、干到一半、人决定不做了。
 *
 * ## 为什么写 `open` 而不是别的
 *
 * 平台侧只有转到 `open`/`reopened`/`done` 会清 claim（`clearsClaim`）。`open` 是唯一语义
 * 正确的那个：任务没做完，退回去让别人领。`done` 是撒谎，`reopened` 是"做完又被打回"。
 *
 * ## 平台先行，本地后写
 *
 * 顺序是**先让平台确认清掉 claim，再改本地 binding**，不能反：
 *  - 先本地后平台：中间崩溃 → 本机认为已释放（群不再回写）、平台仍记着这台机器持有，
 *    直到 lease 到期才回收。这段时间 issue 卡在 in_progress，谁也领不走。
 *  - 先平台后本地：中间崩溃 → 平台已放开可以被别人领，本机 binding 还在。下次回写会被
 *    平台按 claim 不匹配拒掉（stale_epoch / claim_mismatch），是**响的**失败，能查。
 *
 * 宁可留一条会报错的本地记录，也不要留一个静默卡死的平台状态。
 *
 * ## 409 的两种含义要分开
 *
 * 撞 409 时必须先弄清楚"平台还认不认我这个 claim"，两种情况的正确动作相反：
 *  - **stateRev 过期**（别人改了这条 issue）→ claim 还是我的，拿新 stateRev 重发一次即可
 *  - **claim 已经不是我的**（平台上被 force-detach / lease 过期 / 别人领走）→ 平台早就
 *    释放了，这里只需把本地补记成 released。这正是"我想撒手但平台一直拒绝我"的死结场景，
 *    不处理的话人只能去手改 JSON。
 */
import {
  clearClaimIntent,
  claimNextOutboxRow,
  enqueueDesiredStatus,
  failOutboxRow,
  getBinding,
  settleOutboxRow,
  updateBinding,
  type IssueBinding,
} from './issue-board-store.js';
import type { IssueClientResult, PlatformIssue } from '../platform/issue-client.js';

export interface ReleaseDeps {
  dataDir: string;
  writeStatus: (
    issueId: string,
    args: {
      claimId: string;
      claimEpoch: number;
      sourceSeq: number;
      status: 'open';
      expectedStateRev: number;
    },
  ) => Promise<IssueClientResult<{ issue: PlatformIssue }>>;
  /** 撞 409 时用来判断「平台还认不认这个 claim」。拿不到就当作无法判定，不猜。 */
  fetchIssue: (teamId: string, issueId: string) => Promise<PlatformIssue | null>;
  now?: () => number;
}

export type ReleaseResult =
  | { ok: true; binding: IssueBinding; issueId: string; alreadyReleasedOnPlatform: boolean }
  /** 这个锚点上没有 issue 绑定——不是错误，只是没什么可释放的。 */
  | { ok: false; reason: 'no_binding' }
  /** 之前就释放过（或绑定已作废）。幂等，不重复打平台。 */
  | { ok: false; reason: 'already_released'; binding: IssueBinding }
  /** 平台拒绝且 claim 仍归本机所有 —— 本地**不改**，让人重试。 */
  | { ok: false; reason: 'platform'; detail: string; binding: IssueBinding };

/**
 * 释放 `anchorId` 上绑定的 issue。
 *
 * 走 outbox 而不是裸调 `writeStatus`：`enqueueDesiredStatus` 是 sourceSeq 的**唯一**分配
 * 入口（含落后自愈，见那边注释），绕过它自己编号迟早会撞上平台的静默去重。发送失败时行留在
 * outbox 里，将来的 pump 会接着重投——释放不会因为一次网络抖动就丢。
 */
export async function releaseIssue(deps: ReleaseDeps, anchorId: string): Promise<ReleaseResult> {
  const now = deps.now ?? Date.now;
  const binding = getBinding(deps.dataDir, anchorId);
  if (!binding) return { ok: false, reason: 'no_binding' };
  if (binding.bindState === 'released' || binding.bindState === 'void') {
    return { ok: false, reason: 'already_released', binding };
  }

  enqueueDesiredStatus(deps.dataDir, anchorId, 'open', {}, now());
  const sending = claimNextOutboxRow(deps.dataDir, anchorId, now());

  let alreadyReleasedOnPlatform = false;
  if (!sending) {
    // 取不到待发行有两种可能，得分开：
    //  - 上一次释放已经发成功、只是崩在了改本地 binding 之前 → 平台早就放开了，这里补完
    //    本地那一半即可（幂等重入，正是"先平台后本地"写序留下的可恢复形态）；
    //  - 另有一条 inflight 正在发 → 串行约束不允许插队，让人稍后再来。
    if (binding.lastSyncedStatus !== 'open') {
      return { ok: false, reason: 'platform', detail: 'outbox_busy（上一条回写还在发送中，稍后重试）', binding };
    }
    alreadyReleasedOnPlatform = true;
  }

  if (sending) {
    let expectedStateRev = sending.expectedStateRev ?? binding.platformStateRev ?? 0;
    let res = await deps.writeStatus(binding.issueId, {
      claimId: binding.claimId,
      claimEpoch: binding.claimEpoch,
      sourceSeq: sending.sourceSeq,
      status: 'open',
      expectedStateRev,
    });

    if (!res.ok && res.reason === 'conflict') {
      const fresh = await deps.fetchIssue(binding.teamId, binding.issueId);
      if (fresh && fresh.claim?.claimId !== binding.claimId) {
        // 平台上这条已经不归本机了 —— 释放的目的已经达成，别再打了。
        alreadyReleasedOnPlatform = true;
        settleOutboxRow(deps.dataDir, sending.writeId, { platformStateRev: fresh.stateRev }, now());
      } else if (fresh) {
        // claim 还是我的，纯粹是 CAS 基线过期。拿新 stateRev 重发**同一条**行：它上一次没被
        // 应用，sourceSeq 复用是安全的（平台只在 `<= lastSourceSeq` 时才当重复丢弃）。
        expectedStateRev = fresh.stateRev;
        res = await deps.writeStatus(binding.issueId, {
          claimId: binding.claimId,
          claimEpoch: binding.claimEpoch,
          sourceSeq: sending.sourceSeq,
          status: 'open',
          expectedStateRev,
        });
      }
    }

    if (!alreadyReleasedOnPlatform) {
      if (!res.ok) {
        const detail = 'error' in res ? `${res.reason}: ${res.error}` : res.reason;
        failOutboxRow(deps.dataDir, sending.writeId, detail, {}, now());
        // 本地保持原状：平台还认为这台机器持有，本机也得继续这么认，否则就是分裂。
        return { ok: false, reason: 'platform', detail, binding };
      }
      settleOutboxRow(
        deps.dataDir,
        sending.writeId,
        {
          platformStateRev: res.value.issue.stateRev,
          ...(res.value.issue.claim ? { platformLastSourceSeq: res.value.issue.claim.lastSourceSeq } : {}),
        },
        now(),
      );
    }
  }

  // 平台已确认，现在才动本地。
  const released = updateBinding(deps.dataDir, anchorId, { bindState: 'released' }, now()) ?? binding;
  // 领取意图正常情况下在领取成功时就清了；这里兜底清一次，免得对账把一条已释放的领取
  // 当成悬空领取再去补建群。
  clearClaimIntent(deps.dataDir, binding.claimId);
  return { ok: true, binding: released, issueId: binding.issueId, alreadyReleasedOnPlatform };
}
