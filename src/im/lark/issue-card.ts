/**
 * Issue Board 卡片：`/issue` 的飞书原生入口。
 *
 * 三个视图，同一张卡片就地切换（不新发消息，避免刷屏）：
 *   看板 board  → 点「领取」→ 确认 confirm（选仓库）→ 点「确认领取」→ 结果 result
 *
 * 领取由**你 @ 的那个 bot** 承接：`larkAppId` 就是承接方，不需要再选。想让别的 bot 干，
 * 就去 @ 它发 `/issue`。少一次选择，语义也天然。
 *
 * 仓库不新造配置：候选来自 `scanMultipleProjects(configuredWorkingDirs(bot))` —— 现有仓库
 * 选择卡片用的同一套扫描。注意**不能**直接用 `workingDirs` 原值：实测发现它常常配的是一个
 * 工作区父目录（`~/claude-code-workspace`）而不是仓库列表，直接拿来当候选，选中的会是工作区
 * 根目录，等于让 agent 在错误的位置动手。扫描一层才拿得到真正的仓库和 worktree。
 *
 * 平台只存展示用的 `targetRepoLabel`，这里按仓库名做一次匹配把它预选上，匹配不上就让人在
 * 下拉里挑——不拦人，也不猜。
 *
 * Security（沿用 groups-card 的约定）：
 *  - `action.value` 不经 Lark 校验，**绝不**从里面读身份字段；调用者身份只认 operator.*
 *  - 权限门在命令入口和每次回调都要跑一遍
 *
 * 只吃纯数据，不反向依赖 store / platform client，避免循环依赖。
 */

import type { Locale } from '../../i18n/index.js';

export const ISSUE_ACTION_REFRESH = 'issue_refresh' as const;
export const ISSUE_ACTION_PAGE = 'issue_page' as const;
export const ISSUE_ACTION_TEAM = 'issue_team' as const;
export const ISSUE_ACTION_CLAIM_OPEN = 'issue_claim_open' as const;
export const ISSUE_ACTION_CLAIM_DIR = 'issue_claim_dir' as const;
export const ISSUE_ACTION_CLAIM_CONFIRM = 'issue_claim_confirm' as const;
export const ISSUE_ACTION_CLAIM_CANCEL = 'issue_claim_cancel' as const;

/** 一页放几条。看板是给人扫的，多了反而看不动；和 groups-card 保持一致。 */
const PAGE_SIZE = 5;

/** Lark 的 select_static 选项数上限（与 groups-card 的 JUMP_PAGE_MAX_OPTIONS 同源）。
 *  实测一个工作区能扫出 58 个仓库/worktree，不截断会直接超限。 */
const MAX_REPO_OPTIONS = 50;

export interface IssueRowData {
  issueId: string;
  title: string;
  repoLabel?: string;
  /** CAS 基线，随卡片往返——领取时要拿它做 expectedStateRev。 */
  stateRev: number;
  /** 已被领取时展示领取人；本机领的还会有 chatId。 */
  claimedByName?: string;
  chatId?: string;
}

export interface IssueBoardCardData {
  teamId: string;
  teamName: string;
  teams: Array<{ teamId: string; teamName: string }>;
  sections: {
    needsAttention: IssueRowData[];
    todo: IssueRowData[];
    inProgress: IssueRowData[];
    inReview: IssueRowData[];
    done: IssueRowData[];
  };
  /** todo 段的页码（只有待领取需要翻页，其它段是概览计数）。 */
  page: number;
  /**
   * 发起人的 `ou_*`。会被打进**每一个** action.value，回调时与 Lark 校验过的
   * operator.open_id 比对——群里别人点了不算。
   *
   * 不是洁癖：平台的 claim 按**本机 owner** 记，不按点击者记。谁点都能领的话，任务记在
   * owner 头上而实际点的是别人，归属直接错位。
   */
  invokerOpenId: string;
}

/** 一个可选仓库。来自 project-scanner 的 `ProjectInfo`，只取卡片用得到的三个字段。 */
export interface RepoChoice {
  name: string;
  path: string;
  branch?: string;
}

export interface ClaimConfirmCardData {
  teamId: string;
  issueId: string;
  title: string;
  repoLabel?: string;
  stateRev: number;
  /** 扫出来的候选仓库。空数组时不给确认按钮并说明原因。 */
  repos: RepoChoice[];
  /** 当前选中的仓库路径（首次进入由 matchRepo 预选）。 */
  selectedDir?: string;
  /** 见 IssueBoardCardData.invokerOpenId。 */
  invokerOpenId: string;
}

export type ClaimResultCardData =
  | { ok: true; title: string; chatId: string; chatName: string; shareLink?: string }
  | { ok: false; title: string; stage: string; reason: string; hint?: string };

/**
 * 把平台的展示标签匹配到本机某个仓库，返回它的路径。
 *
 * 平台只有 `targetRepoLabel`（"botmux"、"botmux 平台"…），是给人看的，没有路径。这里做的
 * 是**预选**不是决定：匹配上就把下拉默认值设好省一次点击，匹配不上返回 undefined，让人自己
 * 在下拉里挑。刻意不做模糊匹配——猜错仓库会让 agent 在错误的地方动手，代价远大于多点一下。
 *
 * 优先精确命中仓库名，再退一步允许去掉空格/下划线/连字符后相等（"botmux 平台" 这种带空格
 * 的标签能对上 `botmux-platform`）。前缀不算命中：`bot` 不该选中 `botmux`。
 */
export function matchRepo(label: string | undefined, repos: RepoChoice[]): string | undefined {
  if (!label) return undefined;
  const want = label.trim().toLowerCase();
  if (!want) return undefined;
  const exact = repos.find((r) => r.name.toLowerCase() === want);
  if (exact) return exact.path;
  const norm = (s: string) => s.replace(/[\s_-]+/g, '');
  return repos.find((r) => norm(r.name.toLowerCase()) === norm(want))?.path;
}

/**
 * 按与标签的相关度给候选仓库排序并截断到 Lark 的选项上限。
 *
 * 与 {@link matchRepo} 分工明确：那个决定**选中谁**（严格，宁缺毋滥），这个只决定**先显示
 * 谁**（宽松，含子串即可）。排序永远不会替人做选择，所以这里放宽是安全的——而不放宽的话，
 * 标签没精确命中时人得在几十个仓库里自己翻，实测一个工作区能扫出 58 个。
 *
 * 截断是必要的：超过上限 Lark 会拒绝或静默丢弃。被截掉的部分由调用方在卡片上说明，
 * 不能让人以为"没有就是不存在"。
 */
export function rankRepos(
  label: string | undefined,
  repos: RepoChoice[],
  limit: number = MAX_REPO_OPTIONS,
): { options: RepoChoice[]; truncated: number } {
  const want = (label ?? '').trim().toLowerCase();
  const norm = (s: string) => s.replace(/[\s_-]+/g, '');
  const score = (r: RepoChoice): number => {
    if (!want) return 3;
    const n = r.name.toLowerCase();
    if (n === want) return 0;
    if (norm(n) === norm(want)) return 1;
    if (norm(n).includes(norm(want)) || norm(want).includes(norm(n))) return 2;
    return 3;
  };
  const sorted = [...repos].sort((a, b) => {
    const d = score(a) - score(b);
    return d !== 0 ? d : a.name.localeCompare(b.name);
  });
  return { options: sorted.slice(0, limit), truncated: Math.max(0, sorted.length - limit) };
}

function h(content: string): any {
  return { tag: 'div', text: { tag: 'lark_md', content } };
}

function pageOf<T>(rows: T[], page: number): { slice: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const p = Math.min(Math.max(0, page), pages - 1);
  return { slice: rows.slice(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE), page: p, pages };
}

/** 看板视图。只有「待领取」列出可操作的行，其余段给计数——卡片要能一眼扫完。 */
export function buildIssueBoardCard(data: IssueBoardCardData, _locale?: Locale): string {
  const s = data.sections;
  const { slice, page, pages } = pageOf(s.todo, data.page);
  const elements: any[] = [];

  elements.push(h(`**📋 ${data.teamName}**`));
  if (data.teams.length > 1) {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'select_static',
          placeholder: { tag: 'plain_text', content: '切换团队' },
          initial_option: data.teamId,
          options: data.teams.map((t) => ({
            text: { tag: 'plain_text', content: t.teamName },
            value: t.teamId,
          })),
          value: { action: ISSUE_ACTION_TEAM, invoker_open_id: data.invokerOpenId },
        },
      ],
    });
  }
  elements.push({ tag: 'hr' });

  if (s.needsAttention.length) {
    elements.push(h(`🔴 **需要关注 (${s.needsAttention.length})**`));
    for (const r of s.needsAttention) elements.push(h(`　${r.title}`));
  }

  elements.push(h(`⚪️ **待领取 (${s.todo.length})**`));
  if (!slice.length) {
    elements.push(h('　_没有待领取的任务_'));
  }
  for (const r of slice) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `　${r.title}${r.repoLabel ? `　\`${r.repoLabel}\`` : ''}` },
      extra: {
        tag: 'button',
        text: { tag: 'plain_text', content: '领取' },
        type: 'primary',
        value: {
          action: ISSUE_ACTION_CLAIM_OPEN,
          invoker_open_id: data.invokerOpenId,
          teamId: data.teamId,
          issueId: r.issueId,
          // stateRev 随卡片往返：领取时作为 expectedStateRev，别人先改过就会 409，
          // 好过拿一个卡片渲染那一刻的陈旧值去覆盖。
          stateRev: String(r.stateRev),
        },
      },
    });
  }

  elements.push(
    h(`🔵 **进行中 (${s.inProgress.length})**　🟡 **待验收 (${s.inReview.length})**　✅ **已完成 (${s.done.length})**`),
  );

  const actions: any[] = [];
  if (pages > 1) {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '‹ 上一页' },
      disabled: page <= 0,
      value: { action: ISSUE_ACTION_PAGE, invoker_open_id: data.invokerOpenId, teamId: data.teamId, page: String(page - 1) },
    });
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: `${page + 1}/${pages}` },
      disabled: true,
      value: { action: ISSUE_ACTION_PAGE, invoker_open_id: data.invokerOpenId, teamId: data.teamId, page: String(page) },
    });
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '下一页 ›' },
      disabled: page >= pages - 1,
      value: { action: ISSUE_ACTION_PAGE, invoker_open_id: data.invokerOpenId, teamId: data.teamId, page: String(page + 1) },
    });
  }
  actions.push({
    tag: 'button',
    text: { tag: 'plain_text', content: '🔄 刷新' },
    value: { action: ISSUE_ACTION_REFRESH, invoker_open_id: data.invokerOpenId, teamId: data.teamId, page: String(page) },
  });
  elements.push({ tag: 'action', actions });

  return JSON.stringify({ config: { wide_screen_mode: true }, elements });
}

/** 领取确认视图：选仓库 + 确认/取消。就地替换看板，不新发卡片。 */
export function buildClaimConfirmCard(data: ClaimConfirmCardData, _locale?: Locale): string {
  const elements: any[] = [];
  elements.push(h(`**领取「${data.title}」**`));

  const base = {
    invoker_open_id: data.invokerOpenId,
    teamId: data.teamId,
    issueId: data.issueId,
    stateRev: String(data.stateRev),
  };

  if (!data.repos.length) {
    // 扫不到仓库就领，agent 起来也不知道该在哪动手——与其领了再报错，不如在这里说清楚。
    elements.push(h('⚠️ 在这个 bot 的工作目录下没有扫到任何仓库，无法领取。'));
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '返回' },
          value: { action: ISSUE_ACTION_CLAIM_CANCEL, ...base },
        },
      ],
    });
    return JSON.stringify({ config: { wide_screen_mode: true }, elements });
  }

  const { options, truncated } = rankRepos(data.repoLabel, data.repos);
  // 选中项必须在选项里，否则 initial_option 落空、下拉显示为未选。
  const selected =
    data.selectedDir && options.some((r) => r.path === data.selectedDir)
      ? data.selectedDir
      : options[0].path;
  elements.push(
    h(
      data.repoLabel
        ? `平台标注仓库：\`${data.repoLabel}\`${data.selectedDir ? '（已自动匹配）' : '（未匹配到本地仓库，请手动选择）'}`
        : '平台未标注仓库，请选择工作仓库',
    ),
  );
  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'select_static',
        placeholder: { tag: 'plain_text', content: '选择仓库' },
        initial_option: selected,
        // 下拉里显示仓库名 + 分支，比一串绝对路径好认——同名 worktree 靠分支区分。
        options: options.map((r) => ({
          text: { tag: 'plain_text', content: r.branch ? `${r.name} (${r.branch})` : r.name },
          value: r.path,
        })),
        value: { action: ISSUE_ACTION_CLAIM_DIR, ...base },
      },
    ],
  });
  elements.push(h(`　\`${selected}\``));
  if (truncated > 0) {
    // 说清楚被截了，别让人以为"下拉里没有就是不存在"。
    elements.push(h(`_候选较多，仅列出最相关的 ${options.length} 个（另有 ${truncated} 个未显示）_`));
  }
  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '确认领取' },
        type: 'primary',
        value: { action: ISSUE_ACTION_CLAIM_CONFIRM, ...base, dir: selected },
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '取消' },
        value: { action: ISSUE_ACTION_CLAIM_CANCEL, ...base },
      },
    ],
  });
  return JSON.stringify({ config: { wide_screen_mode: true }, elements });
}

/** 结果视图。失败时**明说失败在哪一步**——不同阶段的补救方式完全不同（见 issue-claim-flow）。 */
export function buildClaimResultCard(data: ClaimResultCardData, _locale?: Locale): string {
  const elements: any[] = [];
  if (data.ok) {
    elements.push(h(`✅ **已领取「${data.title}」**`));
    elements.push(h(`群：${data.chatName}`));
    if (data.shareLink) {
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '进入群' },
            type: 'primary',
            url: data.shareLink,
            value: {},
          },
        ],
      });
    }
    return JSON.stringify({ config: { wide_screen_mode: true }, elements });
  }
  elements.push(h(`❌ **领取「${data.title}」失败**`));
  elements.push(h(`失败在：\`${data.stage}\`　原因：\`${data.reason}\``));
  if (data.hint) elements.push(h(data.hint));
  return JSON.stringify({ config: { wide_screen_mode: true }, elements });
}

/** 失败阶段 → 给人的下一步提示。措辞对应 issue-claim-flow 里那张「失败留下什么」表。 */
export function claimFailureHint(stage: string): string | undefined {
  switch (stage) {
    case 'claim':
      return '本地没有留下任何痕迹，可以直接重试。';
    case 'group':
      return '平台上已经领取但群没建成。领取记录还在本机，启动对账会接手（补建群或释放领取）。';
    case 'bind':
      return '群已建好但平台拒绝了绑定（可能被回收或已被别人领走）。绑定已作废，群留着待人处理。';
    case 'activate':
      return '群和绑定都已就绪，只差把 bot 叫起来。可以直接在群里 @ 它，不必重新领取。';
    default:
      return undefined;
  }
}
