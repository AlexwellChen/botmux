/**
 * `/issue` 的命令入口与卡片回调。
 *
 * 卡片渲染在 [[issue-card]]（纯数据、无副作用），这里负责取数、鉴权、跑领取流程。
 *
 * ## 谁能操作
 *
 * 两道门，都 fail-closed：
 *  1. **allowedUsers**——`/issue` 会真的领任务、建群、起 agent，不是只读命令，按 bot 的
 *     管理员名单来（与 `/skills attach` 同一套）。
 *  2. **invoker lock**——卡片带 `invoker_open_id`，只有发起那个人能点。群里别人点了不算。
 *     这条不是洁癖：平台的 claim 是按**本机 owner** 记的，不是按点击者记的。谁点都能领的
 *     话，任务会记在 owner 头上而点的人是别人，归属直接错位。
 *
 * 身份只认 `operator.*`（Lark 校验过），绝不从 `action.value` 里读——那份是卡片里带回来的，
 * 未经校验。
 */
import { logger } from '../../utils/logger.js';
import { scanMultipleProjects } from '../../services/project-scanner.js';
import { configuredWorkingDirs, expandHomePath } from '../../utils/working-dir.js';
import {
  ISSUE_ACTION_CLAIM_CANCEL,
  ISSUE_ACTION_CLAIM_CONFIRM,
  ISSUE_ACTION_CLAIM_DIR,
  ISSUE_ACTION_CLAIM_OPEN,
  ISSUE_ACTION_PAGE,
  ISSUE_ACTION_REFRESH,
  ISSUE_ACTION_TEAM,
  buildClaimConfirmCard,
  buildClaimResultCard,
  buildIssueBoardCard,
  claimFailureHint,
  matchRepo,
  type IssueBoardCardData,
  type IssueRowData,
  type RepoChoice,
} from './issue-card.js';
import type { CardActionData } from './card-handler.js';
import type { PlatformIssue, PlatformIssueSections } from '../../platform/issue-client.js';

export interface IssueCommandDeps {
  fetchTeams: () => Promise<{ ok: boolean; value?: Array<{ teamId: string; teamName: string }>; reason?: string }>;
  fetchIssues: (teamId: string) => Promise<{ ok: boolean; value?: PlatformIssueSections; reason?: string }>;
  /** 跑 [[issue-claim-flow]]。返回值直接喂给结果卡。 */
  runClaim: (args: {
    issue: PlatformIssue;
    teamId: string;
    larkAppId: string;
    workingDir: string;
    invokerOpenId: string;
  }) => Promise<
    | { ok: true; chatId: string; chatName: string; shareLink?: string }
    | { ok: false; stage: string; reason: string }
  >;
  /** 该 bot 的管理员 open_id 名单（`resolvedAllowedUsers`）。 */
  allowedUsers: (larkAppId: string) => string[];
  /** 该 bot 配置的工作目录（未展开 `~`）。 */
  workingDirs: (larkAppId: string) => string[];
}

/** 命令入口的返回：card 是卡片 JSON 字符串，直接喂 `sessionReply(..., 'interactive')`。 */
export type IssueCardResult = { card: string } | { toast: { type: 'error' | 'info'; content: string } };

/**
 * 卡片回调的返回。**结构与命令入口不同**：Lark 的 callback 响应要求
 * `card: { type: 'raw', data: <对象> }`，直接回一个 JSON 字符串会被判非法，
 * 客户端报 `code 200672`（实测踩过：卡片能发出来，但一点按钮就报错）。
 */
export type IssueCardCallbackResult =
  | { card: { type: 'raw'; data: Record<string, unknown> } }
  | { toast: { type: 'error' | 'info'; content: string } };

function toast(content: string): IssueCardResult {
  return { toast: { type: 'error', content } };
}

/** 把内部统一产出的卡片字符串包成 Lark 回调要的信封。 */
function asCallback(r: IssueCardResult): IssueCardCallbackResult {
  if ('toast' in r) return r;
  return { card: { type: 'raw', data: JSON.parse(r.card) as Record<string, unknown> } };
}

/** 平台 issue → 卡片行。只留卡片用得到的字段，别把整个 doc 塞进 action.value。 */
function toRow(i: PlatformIssue): IssueRowData {
  return {
    issueId: i._id,
    title: i.title,
    ...(i.targetRepoLabel ? { repoLabel: i.targetRepoLabel } : {}),
    stateRev: i.stateRev,
    ...(i.claim?.name ? { claimedByName: i.claim.name } : {}),
  };
}

/**
 * 扫出该 bot 可选的仓库。
 *
 * 不能直接用 `workingDirs`：它常常配的是一个工作区父目录（`~/claude-code-workspace`），
 * 直接当候选，选中的会是工作区根目录。扫一层才拿得到真正的仓库和 worktree。
 */
export function reposFor(larkAppId: string, deps: IssueCommandDeps): RepoChoice[] {
  const dirs = configuredWorkingDirs({ workingDirs: deps.workingDirs(larkAppId) }).map(expandHomePath);
  if (!dirs.length) return [];
  try {
    return scanMultipleProjects(dirs, 3, { includeWorktrees: true }).map((p) => ({
      name: p.name,
      path: p.path,
      ...(p.branch ? { branch: p.branch } : {}),
    }));
  } catch (e) {
    // 扫描失败不该让整个命令挂掉：回落到空候选，确认卡会说明"没扫到仓库"。
    logger.warn(`[issue] 扫描仓库失败: ${String((e as Error)?.message ?? e)}`);
    return [];
  }
}

async function buildBoard(
  larkAppId: string,
  deps: IssueCommandDeps,
  opts: { teamId?: string; page?: number; invokerOpenId: string },
): Promise<IssueCardResult> {
  const teams = await deps.fetchTeams();
  if (!teams.ok || !teams.value) {
    return toast(teams.reason === 'unbound' ? '本机还没有绑定 botmux 平台' : `拉取团队失败：${teams.reason}`);
  }
  if (!teams.value.length) return toast('你不在任何 botmux 平台团队里');

  const teamId = opts.teamId && teams.value.some((t) => t.teamId === opts.teamId) ? opts.teamId : teams.value[0].teamId;
  const team = teams.value.find((t) => t.teamId === teamId)!;
  const issues = await deps.fetchIssues(teamId);
  if (!issues.ok || !issues.value) return toast(`拉取任务失败：${issues.reason}`);

  const s = issues.value;
  const data: IssueBoardCardData = {
    teamId,
    teamName: team.teamName,
    teams: teams.value,
    sections: {
      needsAttention: (s.needsAttention ?? []).map(toRow),
      todo: (s.todo ?? []).map(toRow),
      inProgress: (s.inProgress ?? []).map(toRow),
      inReview: (s.inReview ?? []).map(toRow),
      done: (s.done ?? []).map(toRow),
    },
    page: opts.page ?? 0,
    invokerOpenId: opts.invokerOpenId,
  };
  return { card: buildIssueBoardCard(data) };
}

/** `/issue`（裸）→ 看板卡片。 */
export async function handleIssueCommand(
  larkAppId: string,
  senderOpenId: string | undefined,
  deps: IssueCommandDeps,
): Promise<IssueCardResult> {
  if (!senderOpenId) return toast('无法识别操作者身份');
  const admins = deps.allowedUsers(larkAppId);
  if (!admins.length) return toast('这个 bot 还没有配置管理员');
  if (!admins.includes(senderOpenId)) return toast('只有管理员可以操作 Issue Board');
  return buildBoard(larkAppId, deps, { invokerOpenId: senderOpenId });
}

/** 卡片回调。所有 `issue_*` action 都走这里。 */
export async function handleIssueCardAction(
  data: CardActionData,
  larkAppId: string,
  deps: IssueCommandDeps,
): Promise<IssueCardCallbackResult> {
  return asCallback(await handleIssueCardActionInner(data, larkAppId, deps));
}

async function handleIssueCardActionInner(
  data: CardActionData,
  larkAppId: string,
  deps: IssueCommandDeps,
): Promise<IssueCardResult> {
  const value = (data.action?.value ?? {}) as Record<string, string>;
  const operatorOpenId = data.operator?.open_id;
  const action = value.action;

  // ── invoker lock（fail-closed）─────────────────────────────────────────
  const invokerOpenId = value.invoker_open_id;
  if (!invokerOpenId || !operatorOpenId || invokerOpenId !== operatorOpenId) {
    return toast('这张卡片只有发起人能操作');
  }
  // 每次回调都重跑权限门：发卡之后管理员名单可能已经改了。
  const admins = deps.allowedUsers(larkAppId);
  if (!admins.includes(operatorOpenId)) return toast('只有管理员可以操作 Issue Board');

  const teamId = value.teamId;

  if (action === ISSUE_ACTION_REFRESH || action === ISSUE_ACTION_PAGE || action === ISSUE_ACTION_TEAM) {
    // 团队切换的新 teamId 来自下拉的选中值，不在 value 里。
    const picked = action === ISSUE_ACTION_TEAM ? selectedOption(data) ?? teamId : teamId;
    const page = action === ISSUE_ACTION_PAGE ? Number(value.page) || 0 : 0;
    return buildBoard(larkAppId, deps, { teamId: picked, page, invokerOpenId });
  }

  if (action === ISSUE_ACTION_CLAIM_CANCEL) {
    return buildBoard(larkAppId, deps, { teamId, invokerOpenId });
  }

  if (action === ISSUE_ACTION_CLAIM_OPEN || action === ISSUE_ACTION_CLAIM_DIR) {
    const issue = await findIssue(teamId, value.issueId, deps);
    if (!issue) return toast('这条任务已经不在待领取列表里了，刷新看看');
    const repos = reposFor(larkAppId, deps);
    // 下拉切换时以人选的为准；首次打开才用标签自动匹配。
    const picked = action === ISSUE_ACTION_CLAIM_DIR ? selectedOption(data) : matchRepo(issue.targetRepoLabel, repos);
    return {
      card: buildClaimConfirmCard({
        teamId,
        issueId: issue._id,
        title: issue.title,
        ...(issue.targetRepoLabel ? { repoLabel: issue.targetRepoLabel } : {}),
        stateRev: issue.stateRev,
        repos,
        ...(picked ? { selectedDir: picked } : {}),
        invokerOpenId,
      }),
    };
  }

  if (action === ISSUE_ACTION_CLAIM_CONFIRM) {
    const workingDir = value.dir;
    if (!workingDir) return toast('没有选择工作仓库');
    // 重新拉一次而不是用卡片里的 stateRev：卡片可能已经放了很久，用陈旧的 CAS 基线
    // 只会白白撞一次 409。拉不到就说明这条已经不可领了。
    const issue = await findIssue(teamId, value.issueId, deps);
    if (!issue) return toast('这条任务已经不在待领取列表里了，刷新看看');

    const r = await deps.runClaim({ issue, teamId, larkAppId, workingDir, invokerOpenId });
    if (r.ok) {
      logger.info(`[issue] 领取成功 issue=${issue._id} chat=${r.chatId}`);
      return {
        card: buildClaimResultCard({
          ok: true,
          title: issue.title,
          chatId: r.chatId,
          chatName: r.chatName,
          ...(r.shareLink ? { shareLink: r.shareLink } : {}),
        }),
      };
    }
    logger.warn(`[issue] 领取失败 issue=${issue._id} stage=${r.stage} reason=${r.reason}`);
    return {
      card: buildClaimResultCard({
        ok: false,
        title: issue.title,
        stage: r.stage,
        reason: r.reason,
        ...(claimFailureHint(r.stage) ? { hint: claimFailureHint(r.stage)! } : {}),
      }),
    };
  }

  return toast(`未知操作：${action}`);
}

/** 从回调里取下拉选中值。Lark 在不同卡片版本下字段名不一致，两种都认。 */
function selectedOption(data: CardActionData): string | undefined {
  const opt = (data.action as { option?: unknown })?.option;
  if (typeof opt === 'string' && opt) return opt;
  const opts = (data.action as { options?: unknown })?.options;
  if (Array.isArray(opts) && typeof opts[0] === 'string' && opts[0]) return opts[0];
  return undefined;
}

/** 按 issueId 在最新的分段列表里找。平台没有「按 id 单查」的机器入口，只能从列表里捞。 */
async function findIssue(
  teamId: string,
  issueId: string | undefined,
  deps: IssueCommandDeps,
): Promise<PlatformIssue | null> {
  if (!teamId || !issueId) return null;
  const r = await deps.fetchIssues(teamId);
  if (!r.ok || !r.value) return null;
  for (const list of Object.values(r.value)) {
    const hit = (list as PlatformIssue[]).find((i) => i._id === issueId);
    if (hit) return hit;
  }
  return null;
}
