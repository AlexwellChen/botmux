import { describe, it, expect } from 'vitest';
import {
  ISSUE_ACTION_CLAIM_CONFIRM,
  ISSUE_ACTION_CLAIM_OPEN,
  buildClaimConfirmCard,
  buildClaimResultCard,
  buildIssueBoardCard,
  claimFailureHint,
  matchRepo,
  rankRepos,
  type IssueBoardCardData,
  type RepoChoice,
} from '../src/im/lark/issue-card.js';

// 候选来自 scanMultipleProjects：仓库名 + 路径 + 分支，而不是 workingDirs 原值。
// 实测过 workingDirs 常常只配了一个工作区父目录，直接拿来当候选会选中工作区根目录。
const REPOS: RepoChoice[] = [
  { name: 'botmux', path: '/root/claude-code-workspace/botmux', branch: 'master' },
  { name: 'botmux-platform', path: '/root/claude-code-workspace/botmux-platform', branch: 'master' },
  { name: 'other-repo', path: '/root/work/other-repo', branch: 'dev' },
];

describe('仓库标签 → 本地仓库', () => {
  it('按仓库名精确命中', () => {
    expect(matchRepo('botmux', REPOS)).toBe('/root/claude-code-workspace/botmux');
  });

  it('大小写与首尾空白不影响命中', () => {
    expect(matchRepo('  BotMux  ', REPOS)).toBe('/root/claude-code-workspace/botmux');
  });

  it('空格/连字符差异可归一（"botmux 平台" 这类标签的现实写法）', () => {
    expect(matchRepo('botmux platform', REPOS)).toBe('/root/claude-code-workspace/botmux-platform');
    expect(matchRepo('botmux_platform', REPOS)).toBe('/root/claude-code-workspace/botmux-platform');
  });

  // 猜错仓库 = agent 在错误的地方动手，代价远大于让人多点一下下拉。
  it('匹配不上就返回 undefined，绝不模糊猜一个', () => {
    expect(matchRepo('完全不相干的仓库', REPOS)).toBeUndefined();
    expect(matchRepo('bot', REPOS)).toBeUndefined(); // 前缀不算命中
    expect(matchRepo(undefined, REPOS)).toBeUndefined();
    expect(matchRepo('   ', REPOS)).toBeUndefined();
  });

  it('没有可选仓库时返回 undefined，不抛', () => {
    expect(matchRepo('botmux', [])).toBeUndefined();
  });
});

function board(over: Partial<IssueBoardCardData> = {}): IssueBoardCardData {
  return {
    teamId: 't1',
    teamName: 'Botmux Origin',
    teams: [{ teamId: 't1', teamName: 'Botmux Origin' }],
    sections: {
      needsAttention: [],
      todo: [{ issueId: 'iss-1', title: '修一个 bug', repoLabel: 'botmux', stateRev: 3 }],
      inProgress: [],
      inReview: [],
      done: [],
    },
    page: 0,
    ...over,
  };
}

describe('看板卡片', () => {
  it('待领取的每一行都带领取按钮，并把 stateRev 一起带回', () => {
    const card = JSON.parse(buildIssueBoardCard(board()));
    const btn = JSON.stringify(card).includes(ISSUE_ACTION_CLAIM_OPEN);
    expect(btn).toBe(true);
    // stateRev 必须随卡片往返：领取时作为 expectedStateRev，别人先改过就 409
    expect(JSON.stringify(card)).toContain('"stateRev":"3"');
  });

  it('单团队时不渲染切换下拉，多团队时渲染', () => {
    expect(buildIssueBoardCard(board())).not.toContain('切换团队');
    const multi = board({ teams: [{ teamId: 't1', teamName: 'A' }, { teamId: 't2', teamName: 'B' }] });
    expect(buildIssueBoardCard(multi)).toContain('切换团队');
  });

  it('待领取为空时给出说明而不是空白', () => {
    const empty = board({ sections: { ...board().sections, todo: [] } });
    expect(buildIssueBoardCard(empty)).toContain('没有待领取的任务');
  });

  it('超过一页才出翻页按钮，首页上一页置灰', () => {
    const many = board({
      sections: {
        ...board().sections,
        todo: Array.from({ length: 7 }, (_, i) => ({ issueId: `i${i}`, title: `t${i}`, stateRev: 1 })),
      },
    });
    const card = JSON.parse(buildIssueBoardCard(many));
    const flat = JSON.stringify(card);
    expect(flat).toContain('上一页');
    expect(flat).toContain('1/2');
    // 一页只放 5 条
    expect((flat.match(/issue_claim_open/g) ?? []).length).toBe(5);
  });

  it('页码越界被夹回合法范围，不抛也不出空页', () => {
    const card = buildIssueBoardCard(board({ page: 99 }));
    expect(card).toContain('修一个 bug');
  });
});

describe('领取确认卡片', () => {
  it('匹配到目录时预选，并说明是自动匹配的', () => {
    const card = buildClaimConfirmCard({
      teamId: 't1',
      issueId: 'iss-1',
      title: '修一个 bug',
      repoLabel: 'botmux',
      stateRev: 3,
      repos: REPOS,
      selectedDir: '/root/claude-code-workspace/botmux',
    });
    expect(card).toContain('已自动匹配');
    // 下拉显示仓库名 + 分支（同名 worktree 靠分支区分），而不是一串绝对路径
    expect(card).toContain('botmux (master)');
    expect(card).toContain(ISSUE_ACTION_CLAIM_CONFIRM);
    expect(JSON.parse(card).elements.some((e: any) => JSON.stringify(e).includes('"initial_option":"/root/claude-code-workspace/botmux"'))).toBe(true);
  });

  it('没匹配上时明确要求手动选择', () => {
    const card = buildClaimConfirmCard({
      teamId: 't1', issueId: 'iss-1', title: 'x', repoLabel: '未知仓库', stateRev: 1, repos: REPOS,
    });
    expect(card).toContain('未匹配到本地仓库，请手动选择');
  });

  // 扫不到仓库就领，agent 起来也不知道在哪动手；与其领了再报错，不如这里就拦住。
  it('工作目录下扫不到仓库 → 不给确认按钮，直接说明原因', () => {
    const card = buildClaimConfirmCard({
      teamId: 't1', issueId: 'iss-1', title: 'x', stateRev: 1, repos: [],
    });
    expect(card).toContain('没有扫到任何仓库');
    expect(card).not.toContain(ISSUE_ACTION_CLAIM_CONFIRM);
  });
});

describe('结果卡片', () => {
  it('成功时给群名与进群按钮', () => {
    const card = buildClaimResultCard({ ok: true, title: 'x', chatId: 'oc_1', chatName: 'x #abcd1234', shareLink: 'https://applink' });
    expect(card).toContain('已领取');
    expect(card).toContain('进入群');
    expect(card).toContain('https://applink');
  });

  it('没有分享链接时不渲染空按钮', () => {
    const card = buildClaimResultCard({ ok: true, title: 'x', chatId: 'oc_1', chatName: 'g' });
    expect(card).not.toContain('进入群');
  });

  // 不同阶段的补救方式完全不同，把阶段说出来才有用。
  it('失败时点明阶段与原因，并给对应的下一步提示', () => {
    const card = buildClaimResultCard({
      ok: false, title: 'x', stage: 'activate', reason: '发消息失败', hint: claimFailureHint('activate'),
    });
    expect(card).toContain('activate');
    expect(card).toContain('发消息失败');
    expect(card).toContain('可以直接在群里 @ 它，不必重新领取');
  });

  it('四个阶段都有各自的提示，未知阶段不编造', () => {
    for (const s of ['claim', 'group', 'bind', 'activate']) {
      expect(claimFailureHint(s)).toBeTruthy();
    }
    expect(claimFailureHint('无此阶段')).toBeUndefined();
  });
});

describe('候选排序与截断', () => {
  const many: RepoChoice[] = Array.from({ length: 58 }, (_, i) => ({
    name: `repo-${String(i).padStart(2, '0')}`,
    path: `/w/repo-${String(i).padStart(2, '0')}`,
  }));

  // Lark 的 select_static 有 50 个选项上限，实测一个工作区能扫出 58 个仓库。
  it('超过 50 个候选时截断，并报告被截掉多少', () => {
    const { options, truncated } = rankRepos(undefined, many);
    expect(options).toHaveLength(50);
    expect(truncated).toBe(8);
  });

  it('未超上限时不截断', () => {
    const { options, truncated } = rankRepos('botmux', REPOS);
    expect(options).toHaveLength(3);
    expect(truncated).toBe(0);
  });

  // 排序只决定「先显示谁」，不决定「选中谁」——所以这里可以放宽到子串。
  it('精确 > 归一化相等 > 含子串 > 其余，且不改变 matchRepo 的严格性', () => {
    const repos: RepoChoice[] = [
      { name: 'zzz', path: '/z' },
      { name: 'botmux-platform', path: '/p' },
      { name: 'botmux', path: '/b' },
    ];
    expect(rankRepos('botmux', repos).options.map((r) => r.name)).toEqual(['botmux', 'botmux-platform', 'zzz']);
    // 排序把 botmux-platform 排到了前面，但 matchRepo 仍然只认精确/归一命中
    expect(matchRepo('botmux', repos)).toBe('/b');
    expect(matchRepo('botmu', repos)).toBeUndefined();
  });

  it('无标签时按名字稳定排序，不随输入顺序抖动', () => {
    const a = rankRepos(undefined, [{ name: 'b', path: '/b' }, { name: 'a', path: '/a' }]);
    const b = rankRepos(undefined, [{ name: 'a', path: '/a' }, { name: 'b', path: '/b' }]);
    expect(a.options.map((r) => r.name)).toEqual(b.options.map((r) => r.name));
  });

  it('卡片上会说明被截断，不让人以为下拉里没有就是不存在', () => {
    const card = buildClaimConfirmCard({
      teamId: 't1', issueId: 'i', title: 'x', stateRev: 1, repos: many,
    });
    expect(card).toContain('另有 8 个未显示');
  });

  // 预选项被截断挤掉时，initial_option 会落空、下拉显示为未选。
  it('预选项不在截断后的选项里时，回落到第一个可选项', () => {
    const card = JSON.parse(buildClaimConfirmCard({
      teamId: 't1', issueId: 'i', title: 'x', stateRev: 1, repos: many, selectedDir: '/w/repo-57',
    }));
    const flat = JSON.stringify(card);
    expect(flat).not.toContain('"initial_option":"/w/repo-57"');
    expect(flat).toContain('"initial_option":"/w/repo-00"');
  });
});
