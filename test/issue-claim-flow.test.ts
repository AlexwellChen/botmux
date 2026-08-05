import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claimIssueIntoGroup,
  claimMarker,
  matchesClaimMarker,
  type ClaimFlowDeps,
} from '../src/services/issue-claim-flow.js';
import {
  createBinding,
  getBinding,
  getClaimIntent,
  listBindings,
  listClaimIntents,
  listDanglingClaimIntents,
} from '../src/services/issue-board-store.js';

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'issue-claim-flow-'));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const ISSUE = { _id: 'iss-1', title: '修一个 bug', stateRev: 1, targetRepoLabel: 'botmux' };
const ARGS = {
  issue: ISSUE,
  teamId: 't1',
  larkAppId: 'cli_worker',
  creatorLarkAppId: 'cli_creator',
  ownerUnionIds: ['on_alice'],
  kickoffPrompt: '接手这个 issue',
};

/** 记录调用序列的假依赖；每一步都能单独打成失败。 */
function deps(over: Partial<ClaimFlowDeps> = {}) {
  const calls: string[] = [];
  const groupOpts: any[] = [];
  const base: ClaimFlowDeps = {
    dataDir,
    platformBaseUrl: 'https://platform.example',
    newClaimId: () => 'c'.repeat(32),
    claim: async () => {
      calls.push('claim');
      return { ok: true, value: { claim: { claimEpoch: 3 }, issue: { ...ISSUE, stateRev: 2 } } } as any;
    },
    bind: async () => {
      calls.push('bind');
      return { ok: true, value: { issue: { ...ISSUE, stateRev: 3 } } } as any;
    },
    createGroup: async (opts) => {
      calls.push('createGroup');
      groupOpts.push(opts);
      opts.onChatCreated?.('oc_new');
      return { ok: true, chatId: 'oc_new' } as any;
    },
    activate: async () => {
      calls.push('activate');
      return 'om_kickoff';
    },
    ...over,
  };
  return { d: base, calls, groupOpts };
}

describe('领取标记', () => {
  it('取 claimId 前 8 位，能从群名反查', () => {
    const id = 'abcdef0123456789abcdef0123456789';
    expect(claimMarker(id)).toBe('#abcdef01');
    expect(matchesClaimMarker(`修一个 bug ${claimMarker(id)}`, id)).toBe(true);
    expect(matchesClaimMarker('修一个 bug #deadbeef', id)).toBe(false);
  });
});

describe('顺利路径', () => {
  it('按 claim→建群→bind→activate 的顺序走完，意图退休、binding 转 bound', async () => {
    const { d, calls } = deps();
    const r = await claimIssueIntoGroup(d, ARGS);
    expect(r.ok).toBe(true);
    expect(calls).toEqual(['claim', 'createGroup', 'bind', 'activate']);
    if (!r.ok) return;
    expect(r.chatId).toBe('oc_new');
    expect(r.kickoffMessageId).toBe('om_kickoff');
    expect(r.binding.bindState).toBe('bound');
    expect(r.binding.localTaskRef).toBe('oc_new::cli_worker');
    expect(r.binding.platformStateRev).toBe(3);
    // 意图只在窗口期存在，走完就该清掉
    expect(listClaimIntents(dataDir)).toEqual([]);
  });

  // held 是「群已建、binding 未写」那个窗口的唯一兜底：没 kickoff 就没有 agent 在跑。
  it('建群必须是 held —— 不传 kickoffBot/kickoffPrompt', async () => {
    const { d, groupOpts } = deps();
    await claimIssueIntoGroup(d, ARGS);
    expect(groupOpts[0].kickoffBotLarkAppId).toBeUndefined();
    expect(groupOpts[0].kickoffPrompt).toBeUndefined();
  });

  it('群名带 claimId 标记，人被按 union_id 拉进来', async () => {
    const { d, groupOpts } = deps();
    await claimIssueIntoGroup(d, ARGS);
    expect(groupOpts[0].name).toContain(claimMarker('c'.repeat(32)));
    expect(groupOpts[0].ownerUnionIds).toEqual(['on_alice']);
    expect(groupOpts[0].larkAppIds).toContain('cli_worker');
  });
});

describe('失败留下的状态必须可对账', () => {
  it('claim 失败 → 本地一片干净，重试安全', async () => {
    const { d, calls } = deps({ claim: async () => ({ ok: false, reason: 'conflict' }) as any });
    const r = await claimIssueIntoGroup(d, ARGS);
    expect(r).toMatchObject({ ok: false, stage: 'claim', reason: 'conflict' });
    expect(calls).toEqual([]);
    expect(listClaimIntents(dataDir)).toEqual([]);
    expect(listBindings(dataDir)).toEqual([]);
  });

  // 这是设计里最危险的窗口：平台已 claim、群还没有。意图必须留在盘上，否则 claimId 丢了。
  it('建群抛错 → 意图仍在盘上（悬空），claimId 没丢', async () => {
    const { d } = deps({
      createGroup: async () => {
        throw new Error('lark 5xx');
      },
    });
    const r = await claimIssueIntoGroup(d, ARGS);
    expect(r).toMatchObject({ ok: false, stage: 'group', reason: 'lark 5xx', claimId: 'c'.repeat(32) });
    const dangling = listDanglingClaimIntents(dataDir);
    expect(dangling).toHaveLength(1);
    expect(dangling[0].issueId).toBe('iss-1');
    expect(dangling[0].anchorId).toBeUndefined(); // 群没建出来，anchor 自然没有
  });

  // 群建出来了但后续步骤炸：onChatCreated 已经把 binding 和 anchor 落盘，群认得回来。
  it('建群中途炸（onChatCreated 已跑）→ binding 与 anchor 都在，群不会变孤儿', async () => {
    const { d } = deps({
      createGroup: async (opts) => {
        opts.onChatCreated?.('oc_half');
        throw new Error('邀人超时');
      },
    });
    const r = await claimIssueIntoGroup(d, ARGS);
    expect(r).toMatchObject({ ok: false, stage: 'group' });
    expect(getBinding(dataDir, 'oc_half')?.bindState).toBe('pending');
    expect(getClaimIntent(dataDir, 'c'.repeat(32))?.anchorId).toBe('oc_half');
  });

  it('bind 被平台拒 → binding 置 void，不删（群还在，要留得下痕迹）', async () => {
    const { d, calls } = deps({ bind: async () => ({ ok: false, reason: 'conflict' }) as any });
    const r = await claimIssueIntoGroup(d, ARGS);
    expect(r).toMatchObject({ ok: false, stage: 'bind', reason: 'conflict', chatId: 'oc_new' });
    expect(getBinding(dataDir, 'oc_new')?.bindState).toBe('void');
    expect(calls).not.toContain('activate'); // 没 bind 成就绝不能激活
  });

  it('activate 失败 → binding 已 bound，重试激活即可，不必重建群', async () => {
    const { d } = deps({
      activate: async () => {
        throw new Error('发消息失败');
      },
    });
    const r = await claimIssueIntoGroup(d, ARGS);
    expect(r).toMatchObject({ ok: false, stage: 'activate', chatId: 'oc_new' });
    expect(getBinding(dataDir, 'oc_new')?.bindState).toBe('bound');
    // 意图还没清——activate 没完成，领取流程还没走完
    expect(getClaimIntent(dataDir, 'c'.repeat(32))).not.toBeNull();
  });
});

describe('重复领取', () => {
  // 同 issue 两个群 = 两个 agent 同时开工，平台只认最后一次 claim，另一个群变孤儿。
  it('同 issue 已有活跃 binding → 连 claim 都不发', async () => {
    createBinding(dataDir, {
      anchorId: 'oc_old',
      larkAppId: 'cli_worker',
      scope: 'chat',
      issueId: 'iss-1',
      teamId: 't1',
      platformBaseUrl: 'https://platform.example',
      claimId: 'old-claim',
      claimEpoch: 1,
    });
    const { d, calls } = deps();
    const r = await claimIssueIntoGroup(d, ARGS);
    expect(r).toMatchObject({ ok: false, stage: 'claim', reason: 'already_claimed_locally' });
    expect(calls).toEqual([]); // 不白占一次平台代次
    if (!r.ok && r.stage === 'claim') expect(r.alreadyLocal?.anchorId).toBe('oc_old');
  });
});
