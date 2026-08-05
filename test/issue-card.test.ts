import { describe, it, expect } from 'vitest';
import {
  ISSUE_ACTION_CLAIM_CONFIRM,
  ISSUE_ACTION_CLAIM_OPEN,
  buildClaimConfirmCard,
  buildClaimResultCard,
  buildIssueBoardCard,
  claimFailureHint,
  matchWorkingDir,
  type IssueBoardCardData,
} from '../src/im/lark/issue-card.js';

const DIRS = [
  '/root/claude-code-workspace/botmux',
  '/root/claude-code-workspace/botmux-platform',
  '/root/work/other-repo',
];

describe('仓库标签 → 本地目录', () => {
  it('按目录名精确命中', () => {
    expect(matchWorkingDir('botmux', DIRS)).toBe('/root/claude-code-workspace/botmux');
  });

  it('大小写与首尾空白不影响命中', () => {
    expect(matchWorkingDir('  BotMux  ', DIRS)).toBe('/root/claude-code-workspace/botmux');
  });

  it('空格/连字符差异可归一（"botmux 平台" 这类标签的现实写法）', () => {
    expect(matchWorkingDir('botmux platform', DIRS)).toBe('/root/claude-code-workspace/botmux-platform');
    expect(matchWorkingDir('botmux_platform', DIRS)).toBe('/root/claude-code-workspace/botmux-platform');
  });

  // 猜错目录 = agent 在错误的仓库里动手，代价远大于让人多点一下下拉。
  it('匹配不上就返回 undefined，绝不模糊猜一个', () => {
    expect(matchWorkingDir('完全不相干的仓库', DIRS)).toBeUndefined();
    expect(matchWorkingDir('bot', DIRS)).toBeUndefined(); // 前缀不算命中
    expect(matchWorkingDir(undefined, DIRS)).toBeUndefined();
    expect(matchWorkingDir('   ', DIRS)).toBeUndefined();
  });

  it('没有可选目录时返回 undefined，不抛', () => {
    expect(matchWorkingDir('botmux', [])).toBeUndefined();
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
      workingDirs: DIRS,
      selectedDir: '/root/claude-code-workspace/botmux',
    });
    expect(card).toContain('已自动匹配');
    expect(card).toContain(ISSUE_ACTION_CLAIM_CONFIRM);
    expect(JSON.parse(card).elements.some((e: any) => JSON.stringify(e).includes('"initial_option":"/root/claude-code-workspace/botmux"'))).toBe(true);
  });

  it('没匹配上时明确要求手动选择', () => {
    const card = buildClaimConfirmCard({
      teamId: 't1', issueId: 'iss-1', title: 'x', repoLabel: '未知仓库', stateRev: 1, workingDirs: DIRS,
    });
    expect(card).toContain('未匹配到本地目录，请手动选择');
  });

  // 没配工作目录就领，agent 起来也不知道在哪动手；与其领了再报错，不如这里就拦住。
  it('该 bot 没有任何 workingDirs → 不给确认按钮，直接说明原因', () => {
    const card = buildClaimConfirmCard({
      teamId: 't1', issueId: 'iss-1', title: 'x', stateRev: 1, workingDirs: [],
    });
    expect(card).toContain('还没有配置任何工作目录');
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
