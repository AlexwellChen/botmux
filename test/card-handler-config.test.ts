/**
 * `/botconfig` 交互卡片：默认开启的布尔字段必须按“有效值”翻转，而不是按
 * bots.json 中是否显式存在 true 翻转。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

const deps = {
  activeSessions: new Map(),
  sessionReply: vi.fn(async () => 'om_reply'),
  lastRepoScan: new Map(),
} as any;

let root: string;
let configPath: string;

async function fresh() {
  vi.resetModules();
  const registry = await import('../src/bot-registry.js');
  const handler = await import('../src/im/lark/card-handler.js');
  registry.loadBotConfigs().forEach(cfg => registry.registerBot(cfg));
  return { registry, handler };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'botmux-card-config-'));
  configPath = join(root, 'bots.json');
  writeFileSync(configPath, JSON.stringify([{
    larkAppId: 'app_config',
    larkAppSecret: 'secret',
    cliId: 'claude-code',
    allowedUsers: ['ou_owner'],
  }], null, 2));
  process.env.BOTS_CONFIG = configPath;
});

afterEach(() => {
  delete process.env.BOTS_CONFIG;
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('/botconfig default-on toggle', () => {
  it('first click turns showUsageInCardFooter off and persists false', async () => {
    const { registry, handler } = await fresh();
    const result = await handler.handleCardAction({
      operator: { open_id: 'ou_owner' },
      action: {
        value: {
          action: 'config_toggle',
          field: 'showUsageInCardFooter',
          loc: 'en',
        },
      },
    }, deps, 'app_config');

    expect(result?.toast).toMatchObject({
      type: 'success',
      content: '✓ showUsageInCardFooter = off',
    });
    expect(JSON.parse(readFileSync(configPath, 'utf-8'))[0].showUsageInCardFooter).toBe(false);
    expect(registry.getBot('app_config').config.showUsageInCardFooter).toBe(false);

    const rerendered = JSON.stringify(result?.card?.data ?? {});
    expect(rerendered).toContain('Usage in card footer');
    expect(rerendered).toContain('⚪');
  });
});
