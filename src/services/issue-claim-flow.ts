/**
 * 拉群领取：把一个平台 issue 变成一个飞书群 + 一个跑着的 CLI 会话。
 *
 * 顺序在 [[issue-board-store]] 文件头定死，这里是它的可执行版本：
 *
 *   1. platform claim
 *   2. recordClaimIntent      ← 立刻。claim 已成功而意图未落盘时崩溃 = 丢 claimId
 *   3. createGroupWithBots    ← **held**：不传 kickoffBot/kickoffPrompt，群里没有 agent 在跑
 *   4. onChatCreated → createBinding + 回填意图   ← durable boundary
 *   5. platform bind(localTaskRef)
 *   6. kickoff（@bot）→ activate                  ← 到这一步 daemon 才真的起会话
 *   7. clearClaimIntent       ← 必须晚于 binding 落盘
 *
 * 每一步都可能崩，且崩了都不该产生「群在跑但平台不知道」或「平台以为在跑但本机没有」的
 * 不一致。这里的做法是：**任何一步失败都不回滚已完成的持久化**，而是把状态留在可对账的
 * 形态上（意图在 / binding pending / binding void），交给启动对账收拾。回滚才是危险的
 * ——撤销远端副作用本身也会失败，只会把状态搅得更不可辨认。
 *
 * 依赖全部注入：单测里不碰真实飞书、不打真实平台。
 */
import { randomBytes } from 'node:crypto';
import type { CreateGroupOpts, CreateGroupResult } from './group-creator.js';
import type { IssueClientResult, PlatformIssue } from '../platform/issue-client.js';
import {
  buildLocalTaskRef,
  clearClaimIntent,
  createBinding,
  findActiveBindingByIssue,
  recordClaimIntent,
  updateBinding,
  updateClaimIntent,
  type IssueBinding,
} from './issue-board-store.js';

/**
 * 群名里带的领取标记。对账时靠它把「平台上有 claim、本地没有 binding」的孤儿群认回来
 * ——本地意图是一条腿，这个标记是另一条腿，少哪条都会留下认不出的群。
 *
 * 只取前 8 位十六进制（32 bit）：群名是给人看的，不该被一串 32 字符的随机数占满；
 * 同时在手可数的候选群里，32 bit 足以唯一定位。
 */
export function claimMarker(claimId: string): string {
  return `#${claimId.slice(0, 8)}`;
}

export function matchesClaimMarker(groupName: string, claimId: string): boolean {
  return groupName.includes(claimMarker(claimId));
}

export interface ClaimFlowDeps {
  dataDir: string;
  platformBaseUrl: string;
  claim: (
    issueId: string,
    args: { claimId: string; agent?: string; repoLabel?: string; expectedStateRev: number },
  ) => Promise<IssueClientResult<{ claim: { claimEpoch: number }; issue: PlatformIssue }>>;
  bind: (
    issueId: string,
    args: { claimId: string; localTaskRef: string; expectedStateRev: number },
  ) => Promise<IssueClientResult<{ issue: PlatformIssue }>>;
  createGroup: (opts: CreateGroupOpts) => Promise<CreateGroupResult>;
  /** 发 kickoff（@ 目标 bot）把会话激活。返回 messageId。 */
  activate: (chatId: string, botLarkAppId: string, prompt: string) => Promise<string>;
  newClaimId?: () => string;
  now?: () => number;
}

export interface ClaimFlowArgs {
  issue: Pick<PlatformIssue, '_id' | 'title' | 'stateRev' | 'targetRepoLabel'>;
  teamId: string;
  /** 由哪个 bot 承接这个 issue —— 决定 localTaskRef 的 appId 段与 kickoff 目标。 */
  larkAppId: string;
  /** 建群者（通常是 dashboard 所属的那个 bot）。 */
  creatorLarkAppId: string;
  /** 一并拉进群的其它 bot。 */
  peerLarkAppIds?: string[];
  /** 把人按 union_id 拉进群（open_id 是 app-scoped 的，跨 bot 不通用）。 */
  ownerUnionIds?: string[];
  /**
   * agent 干活的目录。会作为 `bindWorkingDir` 绑到新群上（oncall 绑定），**必须传**——
   * 不传的话人在卡片里选的仓库根本不会生效，会话会起在 bot 的默认目录里，
   * 等于让 agent 在错误的仓库动手，而且没有任何报错。
   */
  workingDir: string;
  kickoffPrompt: string;
}

export type ClaimFlowResult =
  | { ok: true; binding: IssueBinding; chatId: string; kickoffMessageId: string }
  /** 领取本身没成功，本地没有留下任何痕迹，重试是安全的。 */
  | { ok: false; stage: 'claim'; reason: string; alreadyLocal?: IssueBinding }
  /** 已 claim 但群没建成：意图在盘上，对账会接手（释放 claim 或补建）。 */
  | { ok: false; stage: 'group'; reason: string; claimId: string }
  /** 群建好了、binding 也落盘了，但 bind 被平台拒 → binding 置 void，群留给人处理。 */
  | { ok: false; stage: 'bind'; reason: string; binding: IssueBinding; chatId: string }
  /** 前面全成，只差 kickoff。binding 已 bound，重试 activate 即可，不必重建群。 */
  | { ok: false; stage: 'activate'; reason: string; binding: IssueBinding; chatId: string };

export async function claimIssueIntoGroup(
  deps: ClaimFlowDeps,
  args: ClaimFlowArgs,
): Promise<ClaimFlowResult> {
  const newClaimId = deps.newClaimId ?? (() => randomBytes(16).toString('hex'));
  const now = deps.now ?? Date.now;

  // 先查本地：同一个 issue 已经有活跃 binding 就直接拦住。放到 store 里抛也拦得住，
  // 但那是最后一道；在这里挡住可以连平台 claim 都不发，不白占一次代次。
  const existing = findActiveBindingByIssue(deps.dataDir, args.issue._id);
  if (existing) {
    return { ok: false, stage: 'claim', reason: 'already_claimed_locally', alreadyLocal: existing };
  }

  // ── 1. claim ──────────────────────────────────────────────────────────────
  const claimId = newClaimId();
  const claimed = await deps.claim(args.issue._id, {
    claimId,
    agent: args.larkAppId,
    ...(args.issue.targetRepoLabel ? { repoLabel: args.issue.targetRepoLabel } : {}),
    expectedStateRev: args.issue.stateRev,
  });
  if (!claimed.ok) return { ok: false, stage: 'claim', reason: claimed.reason };
  const claimEpoch = claimed.value.claim.claimEpoch;
  let stateRev = claimed.value.issue.stateRev;

  // ── 2. 意图落盘（早于任何建群动作）──────────────────────────────────────
  recordClaimIntent(
    deps.dataDir,
    {
      claimId,
      issueId: args.issue._id,
      teamId: args.teamId,
      claimEpoch,
      platformBaseUrl: deps.platformBaseUrl,
      platformStateRev: stateRev,
      larkAppId: args.larkAppId,
      scope: 'chat',
    },
    now(),
  );

  // ── 3~4. 建群（held）+ onChatCreated 里写 binding ────────────────────────
  //
  // 群名带 claimId 标记，与本地意图构成双通道反查。
  // 刻意**不传** kickoffBotLarkAppId/kickoffPrompt：群里没有 bot 被 @ 起来，daemon 不会
  // 创建会话。这是「群已建、binding 未写」那个窗口的兜底——孤儿群里没有 agent 在跑。
  let binding: IssueBinding | null = null;
  let chatId = '';
  const botIds = Array.from(new Set([args.larkAppId, ...(args.peerLarkAppIds ?? [])]));
  try {
    const group = await deps.createGroup({
      creatorLarkAppId: args.creatorLarkAppId,
      larkAppIds: botIds,
      name: `${args.issue.title} ${claimMarker(claimId)}`,
      bindWorkingDir: args.workingDir,
      ...(args.ownerUnionIds?.length ? { ownerUnionIds: args.ownerUnionIds } : {}),
      onChatCreated: (createdChatId: string) => {
        // 同步钩子：createGroupWithBots 返回前这两次写就已经落盘。后面的邀人/转让/
        // 分享链接都是 best-effort，就算挂住或失败，这个群也已经认得回来了。
        chatId = createdChatId;
        updateClaimIntent(deps.dataDir, claimId, { anchorId: createdChatId, chatId: createdChatId }, now());
        binding = createBinding(
          deps.dataDir,
          {
            anchorId: createdChatId,
            larkAppId: args.larkAppId,
            scope: 'chat',
            issueId: args.issue._id,
            teamId: args.teamId,
            platformBaseUrl: deps.platformBaseUrl,
            claimId,
            claimEpoch,
            chatId: createdChatId,
          },
          now(),
        );
      },
    });
    chatId = group.chatId || chatId;
  } catch (e) {
    return { ok: false, stage: 'group', reason: String((e as Error)?.message ?? e), claimId };
  }
  if (!binding || !chatId) {
    return { ok: false, stage: 'group', reason: 'chat_created_but_binding_missing', claimId };
  }
  const bound: IssueBinding = binding;

  // ── 5. bind ───────────────────────────────────────────────────────────────
  const bindRes = await deps.bind(args.issue._id, {
    claimId,
    localTaskRef: buildLocalTaskRef(chatId, args.larkAppId),
    expectedStateRev: stateRev,
  });
  if (!bindRes.ok) {
    // 平台拒绝 = 这条领取作废（issue 被回收 / 别人领走 / 代次过期）。置 void 而不是删：
    // 群还在，留着记录才知道那个群是哪次失败领取的产物。
    const voided = updateBinding(deps.dataDir, bound.anchorId, { bindState: 'void' }, now()) ?? bound;
    return { ok: false, stage: 'bind', reason: bindRes.reason, binding: voided, chatId };
  }
  stateRev = bindRes.value.issue.stateRev;
  const readyBinding =
    updateBinding(deps.dataDir, bound.anchorId, { bindState: 'bound', platformStateRev: stateRev }, now()) ?? bound;

  // ── 6. activate ───────────────────────────────────────────────────────────
  let kickoffMessageId: string;
  try {
    kickoffMessageId = await deps.activate(chatId, args.larkAppId, args.kickoffPrompt);
  } catch (e) {
    // binding 已经是 bound，平台也知道 localTaskRef，重试 activate 即可，别重建群。
    return { ok: false, stage: 'activate', reason: String((e as Error)?.message ?? e), binding: readyBinding, chatId };
  }

  // ── 7. 意图退休（晚于 binding 落盘）───────────────────────────────────────
  clearClaimIntent(deps.dataDir, claimId);
  return { ok: true, binding: readyBinding, chatId, kickoffMessageId };
}
