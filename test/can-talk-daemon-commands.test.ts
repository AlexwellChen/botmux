/**
 * canTalkDaemonCommands：把选定的 daemon 命令的权限闸从 canOperate 降到 canTalk。
 * - 解析：parseBotConfigsFromText 归一化（小写/补斜杠/仅认 DAEMON_COMMANDS/去重）
 * - 闸：canRunDaemonCommand = canOperate ∪ (cmd ∈ 名单 && canTalk)
 * Run: pnpm vitest run test/can-talk-daemon-commands.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}));

import { parseBotConfigsFromText, registerBot, getBot, __testOnly_resetBotRegistry } from '../src/bot-registry.js';
import { canRunDaemonCommand, canOperate, canTalk } from '../src/im/lark/event-dispatcher.js';
import { parseCanTalkDaemonCommandsInput } from '../src/core/passthrough-commands.js';
import { config } from '../src/config.js';
import { recordTeamBot } from '../src/services/team-bots-store.js';

describe('parseCanTalkDaemonCommandsInput (/botconfig input path)', () => {
  it('normalizes and keeps ONLY daemon commands (inverse of passthrough parser)', () => {
    // 默认的 parseCustomPassthroughInput 会拒绝 daemon 命令——本字段必须用自己的解析器
    expect(parseCanTalkDaemonCommandsInput('status, Help /STATUS')).toEqual(['/status', '/help']);
    expect(parseCanTalkDaemonCommandsInput('/compact /goal status')).toEqual(['/status']);
    expect(parseCanTalkDaemonCommandsInput('')).toEqual([]);
  });
});

describe('canTalkDaemonCommands parsing', () => {
  const parse = (v: unknown) =>
    parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'p1', larkAppSecret: 's', canTalkDaemonCommands: v }]))[0]
      .canTalkDaemonCommands;

  it('normalizes case and adds leading slash', () => {
    expect(parse(['STATUS', '/Help'])).toEqual(['/status', '/help']);
  });

  it('drops entries that are not daemon commands (passthrough or unknown)', () => {
    // /compact 是 passthrough、/nope 不存在 —— 都不属于 DAEMON_COMMANDS
    expect(parse(['/status', '/compact', '/nope'])).toEqual(['/status']);
  });

  it('dedupes', () => {
    expect(parse(['/status', 'status', '/STATUS'])).toEqual(['/status']);
  });

  it('undefined when absent / empty / all-invalid', () => {
    expect(parse(undefined)).toBeUndefined();
    expect(parse([])).toBeUndefined();
    expect(parse(['/compact', 42, ''])).toBeUndefined();
  });
});

describe('canRunDaemonCommand gate', () => {
  beforeEach(() => {
    __testOnly_resetBotRegistry();
    const bot = registerBot({
      larkAppId: 'ct1', larkAppSecret: 's', cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
    } as any);
    bot.resolvedAllowedUsers = ['ou_owner'];
    bot.config.chatGrants = { oc_1: ['ou_guest'] };
    bot.config.oncallChats = [{ chatId: 'oc_oncall', workingDir: '/tmp' }];
    bot.config.canTalkDaemonCommands = ['/status', '/help'];
  });

  it('owner always passes regardless of the list', () => {
    expect(canRunDaemonCommand('ct1', 'oc_1', 'ou_owner', undefined, '/restart')).toBe(true);
    expect(canRunDaemonCommand('ct1', 'oc_1', 'ou_owner', undefined, '/status')).toBe(true);
  });

  it('listed command + canTalk-granted sender passes', () => {
    // chatGrant 放行 canTalk 但不放行 canOperate —— 名单把 /status 降到 canTalk
    expect(canTalk('ct1', 'oc_1', 'ou_guest')).toBe(true);
    expect(canOperate('ct1', 'oc_1', 'ou_guest')).toBe(false);
    expect(canRunDaemonCommand('ct1', 'oc_1', 'ou_guest', undefined, '/status')).toBe(true);
  });

  it('listed command + oncall-chat member passes', () => {
    expect(canRunDaemonCommand('ct1', 'oc_oncall', 'ou_stranger', undefined, '/help')).toBe(true);
  });

  it('unlisted command + canTalk-granted sender is denied', () => {
    expect(canRunDaemonCommand('ct1', 'oc_1', 'ou_guest', undefined, '/restart')).toBe(false);
    expect(canRunDaemonCommand('ct1', 'oc_1', 'ou_guest', undefined, '/cd')).toBe(false);
  });

  it('listed command + sender without canTalk is denied', () => {
    expect(canRunDaemonCommand('ct1', 'oc_other', 'ou_stranger', undefined, '/status')).toBe(false);
  });

  it('no list configured → behaves exactly like canOperate', () => {
    getBot('ct1').config.canTalkDaemonCommands = undefined;
    expect(canRunDaemonCommand('ct1', 'oc_1', 'ou_guest', undefined, '/status')).toBe(false);
    expect(canRunDaemonCommand('ct1', 'oc_1', 'ou_owner', undefined, '/status')).toBe(true);
  });

  it('p2pOpen leg works only when chatType is passed (fail-closed without)', () => {
    const bot = getBot('ct1');
    bot.config.p2pOpen = true;
    expect(canRunDaemonCommand('ct1', 'p2p_chat', 'ou_p2p_user', undefined, '/status', undefined, 'p2p', false, false)).toBe(true);
    // chatType 省略 → p2pOpen 腿 fail-closed，不放行
    expect(canRunDaemonCommand('ct1', 'p2p_chat', 'ou_p2p_user', undefined, '/status')).toBe(false);
    // p2p 里名单外的命令仍拒
    expect(canRunDaemonCommand('ct1', 'p2p_chat', 'ou_p2p_user', undefined, '/restart', undefined, 'p2p')).toBe(false);
  });
});

describe('canRunDaemonCommand /repo trusted same-deployment peer exception', () => {
  let prevDataDir: string;
  let tmp: string;

  const newTopicRoute = (senderOpenId: string, cmd = '/repo', botSender = true) =>
    canRunDaemonCommand('repo1', 'oc_repo', senderOpenId, undefined, cmd, undefined, 'group', botSender, botSender);
  const threadReplyRoute = (senderOpenId: string, cmd = '/repo', botSender = true) =>
    canRunDaemonCommand('repo1', 'oc_repo', senderOpenId, undefined, cmd, undefined, 'group', botSender, botSender);

  beforeEach(() => {
    __testOnly_resetBotRegistry();
    prevDataDir = config.session.dataDir;
    tmp = mkdtempSync(join(tmpdir(), 'repo-peer-gate-'));
    config.session.dataDir = tmp;

    const bot = registerBot({
      larkAppId: 'repo1',
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
    });
    bot.resolvedAllowedUsers = ['ou_owner'];
    bot.config.chatGrants = { oc_repo: ['ou_granted'] };
    writeFileSync(join(tmp, 'bot-openids-repo1.json'), JSON.stringify({ Codex: 'ou_sibling' }));
  });

  afterEach(() => {
    config.session.dataDir = prevDataDir;
    rmSync(tmp, { recursive: true, force: true });
    __testOnly_resetBotRegistry();
  });

  it('allows a known sibling bot to run /repo through both daemon routes', () => {
    expect(canOperate('repo1', 'oc_repo', 'ou_sibling')).toBe(false);

    expect(newTopicRoute('ou_sibling', '/repo', true)).toBe(true);
    expect(threadReplyRoute('ou_sibling', '/repo', true)).toBe(true);
  });

  it('does not give the sibling bot general daemon-command authority', () => {
    for (const cmd of ['/cd', '/restart', '/botconfig', '/term']) {
      expect(newTopicRoute('ou_sibling', cmd, true), `new-topic ${cmd}`).toBe(false);
      expect(threadReplyRoute('ou_sibling', cmd, true), `thread-reply ${cmd}`).toBe(false);
    }
  });

  it('requires the sender to be Lark-stamped as a bot', () => {
    expect(newTopicRoute('ou_sibling', '/repo', false)).toBe(false);
    expect(threadReplyRoute('ou_sibling', '/repo', false)).toBe(false);
    expect(
      canRunDaemonCommand('repo1', 'oc_repo', 'ou_sibling', undefined, '/repo', undefined, 'group', true, false),
    ).toBe(false);
  });

  it('keeps /repo denied for human owners only when they are not allowed users, chat grants, and unknown external bots', () => {
    expect(newTopicRoute('ou_owner', '/repo', false)).toBe(true);
    expect(threadReplyRoute('ou_owner', '/repo', false)).toBe(true);

    expect(newTopicRoute('ou_human', '/repo', false)).toBe(false);
    expect(threadReplyRoute('ou_human', '/repo', false)).toBe(false);
    expect(newTopicRoute('ou_granted', '/repo', false)).toBe(false);
    expect(threadReplyRoute('ou_granted', '/repo', false)).toBe(false);
    expect(newTopicRoute('ou_external_bot', '/repo', true)).toBe(false);
    expect(threadReplyRoute('ou_external_bot', '/repo', true)).toBe(false);
  });

  it('preserves existing cross-deployment team bot operate semantics', () => {
    recordTeamBot(tmp, { unionId: 'on_team_bot', name: 'TeamBot' });
    expect(canRunDaemonCommand('repo1', 'oc_elsewhere', 'ou_team_bot', 'on_team_bot', '/repo', undefined, 'group', true)).toBe(true);
    expect(canRunDaemonCommand('repo1', 'oc_elsewhere', 'ou_team_bot', 'on_team_bot', '/restart', undefined, 'group', true)).toBe(true);
  });
});
