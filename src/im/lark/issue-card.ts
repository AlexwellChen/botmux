/**
 * Issue Board 卡片：`/issue` 的飞书原生入口。
 *
 * 三个视图，同一张卡片就地切换（不新发消息，避免刷屏）：
 *   看板 board  → 点「领取」→ 确认 confirm（选仓库）→ 点「确认领取」→ 结果 result
 *
 * 领取由**你 @ 的那个 bot** 承接：`larkAppId` 就是承接方，不需要再选。想让别的 bot 干，
 * 就去 @ 它发 `/issue`。少一次选择，语义也天然。
 *
 * 仓库不新造配置：直接用该 bot 已有的 `workingDirs`（仓库选择卡片本来就在用它）。平台只
 * 存展示用的 `targetRepoLabel`，这里按目录名做一次匹配把它预选上，匹配不上就让人在下拉里挑
 * ——不拦人，也不猜。
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
}

export interface ClaimConfirmCardData {
  teamId: string;
  issueId: string;
  title: string;
  repoLabel?: string;
  stateRev: number;
  /** 该 bot 已配置的工作目录。空数组时确认按钮置灰并说明原因。 */
  workingDirs: string[];
  /** 当前选中的目录（首次进入由 matchWorkingDir 预选）。 */
  selectedDir?: string;
}

export type ClaimResultCardData =
  | { ok: true; title: string; chatId: string; chatName: string; shareLink?: string }
  | { ok: false; title: string; stage: string; reason: string; hint?: string };

/**
 * 把平台的展示标签匹配到本机某个工作目录。
 *
 * 平台只有 `targetRepoLabel`（"botmux"、"botmux 平台"…），是给人看的，没有路径。这里做的
 * 是**预选**不是决定：匹配上就把下拉默认值设好省一次点击，匹配不上返回 undefined，让人自己
 * 在下拉里挑。刻意不做模糊匹配——猜错目录会让 agent 在错误的仓库里动手，代价远大于多点一下。
 */
export function matchWorkingDir(label: string | undefined, dirs: string[]): string | undefined {
  if (!label) return undefined;
  const want = label.trim().toLowerCase();
  if (!want) return undefined;
  const basename = (d: string) => (d.replace(/\/+$/, '').split('/').pop() ?? '').toLowerCase();
  // 先精确命中目录名，再退一步允许目录名去掉分隔符后相等（"botmux-platform" ↔ "botmux platform"）。
  const exact = dirs.find((d) => basename(d) === want);
  if (exact) return exact;
  const norm = (s: string) => s.replace(/[\s_-]+/g, '');
  return dirs.find((d) => norm(basename(d)) === norm(want));
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
          value: { action: ISSUE_ACTION_TEAM },
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
      value: { action: ISSUE_ACTION_PAGE, teamId: data.teamId, page: String(page - 1) },
    });
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: `${page + 1}/${pages}` },
      disabled: true,
      value: { action: ISSUE_ACTION_PAGE, teamId: data.teamId, page: String(page) },
    });
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '下一页 ›' },
      disabled: page >= pages - 1,
      value: { action: ISSUE_ACTION_PAGE, teamId: data.teamId, page: String(page + 1) },
    });
  }
  actions.push({
    tag: 'button',
    text: { tag: 'plain_text', content: '🔄 刷新' },
    value: { action: ISSUE_ACTION_REFRESH, teamId: data.teamId, page: String(page) },
  });
  elements.push({ tag: 'action', actions });

  return JSON.stringify({ config: { wide_screen_mode: true }, elements });
}

/** 领取确认视图：选仓库 + 确认/取消。就地替换看板，不新发卡片。 */
export function buildClaimConfirmCard(data: ClaimConfirmCardData, _locale?: Locale): string {
  const elements: any[] = [];
  elements.push(h(`**领取「${data.title}」**`));

  const base = {
    teamId: data.teamId,
    issueId: data.issueId,
    stateRev: String(data.stateRev),
  };

  if (!data.workingDirs.length) {
    // 没配工作目录就领，agent 起来也不知道该在哪动手——与其领了再报错，不如在这里说清楚。
    elements.push(h('⚠️ 这个 bot 还没有配置任何工作目录（`workingDirs`），无法领取。'));
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

  const selected = data.selectedDir ?? data.workingDirs[0];
  elements.push(
    h(
      data.repoLabel
        ? `平台标注仓库：\`${data.repoLabel}\`${data.selectedDir ? '（已自动匹配）' : '（未匹配到本地目录，请手动选择）'}`
        : '平台未标注仓库，请选择工作目录',
    ),
  );
  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'select_static',
        placeholder: { tag: 'plain_text', content: '选择工作目录' },
        initial_option: selected,
        options: data.workingDirs.map((d) => ({ text: { tag: 'plain_text', content: d }, value: d })),
        value: { action: ISSUE_ACTION_CLAIM_DIR, ...base },
      },
    ],
  });
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
