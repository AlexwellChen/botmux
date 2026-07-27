import type { IncomingMessage, ServerResponse } from 'node:http';

import { readPlatformBinding } from '../platform/binding.js';
import { botmuxInstallRoot, botmuxVersion } from '../utils/install-info.js';
import { resolveEffectiveBotmuxVersion } from '../utils/version-info.js';
import { jsonRes } from './http.js';

export interface DashboardCompatModule {
  supported: boolean;
  route?: string;
}

export type DashboardCompatCapability =
  | 'asks.answer'
  | 'asks.read'
  | 'bots.configure'
  | 'bots.read'
  | 'connectors.manage'
  | 'connectors.read'
  | 'groups.manage'
  | 'groups.read'
  | 'insights.read'
  | 'monitoring.read'
  | 'office.read'
  | 'plugins.manage'
  | 'plugins.read'
  | 'roles.manage'
  | 'roles.read'
  | 'schedules.manage'
  | 'schedules.read'
  | 'sessions.manage'
  | 'sessions.read'
  | 'sessions.terminal'
  | 'settings.manage'
  | 'settings.read'
  | 'skills.manage'
  | 'skills.read'
  | 'team.manage'
  | 'team.read'
  | 'updates.manage'
  | 'updates.read'
  | 'whiteboards.manage'
  | 'whiteboards.read'
  | 'workflow.manage'
  | 'workflow.read';

export interface DesktopCompatManifest {
  schemaVersion: 1;
  product: 'botmux';
  runtimeVersion: string;
  dashboardProtocolVersion: 2;
  desktopShell: {
    supported: true;
    minAppVersion?: string;
  };
  runtimeIdentity?: {
    source: 'platform-binding';
    machineId: string;
  };
  features: string[];
  routes: string[];
  modules: Record<string, DashboardCompatModule>;
  capabilities: Record<DashboardCompatCapability, boolean>;
}

export interface BuildCompatManifestOptions {
  runtimeVersion?: string;
  /**
   * Override the machine identity used by tests or an embedding host.
   * `null` explicitly means that no reliable machine identity is available.
   */
  machineId?: string | null;
}

const DASHBOARD_CORE_ROUTES = [
  '#/',
  '#/sessions',
  '#/groups',
  '#/roles',
  '#/monitoring',
  '#/insights',
  '#/schedules',
  '#/whiteboards',
  '#/office',
  '#/bot-defaults',
  '#/skills',
  '#/plugins',
  '#/team',
  '#/connectors',
  '#/settings',
] as const;

const DASHBOARD_COMPAT_FEATURES = [
  'desktop-shell',
  'dashboard-protocol-v1',
  'dashboard-protocol-v2',
  'dashboard-modules',
  'dashboard-capabilities',
] as const;

const DASHBOARD_MODULES = {
  overview: { supported: true, route: '#/' },
  sessions: { supported: true, route: '#/sessions' },
  groups: { supported: true, route: '#/groups' },
  roles: { supported: true, route: '#/roles' },
  monitoring: { supported: true, route: '#/monitoring' },
  insights: { supported: true, route: '#/insights' },
  schedules: { supported: true, route: '#/schedules' },
  whiteboards: { supported: true, route: '#/whiteboards' },
  office: { supported: true, route: '#/office' },
  bots: { supported: true, route: '#/bot-defaults' },
  skills: { supported: true, route: '#/skills' },
  plugins: { supported: true, route: '#/plugins' },
  team: { supported: true, route: '#/team' },
  connectors: { supported: true, route: '#/connectors' },
  settings: { supported: true, route: '#/settings' },
  workflow: { supported: false },
} satisfies Record<string, DashboardCompatModule>;

const DASHBOARD_CAPABILITIES: Record<DashboardCompatCapability, boolean> = {
  'asks.answer': true,
  'asks.read': true,
  'bots.configure': true,
  'bots.read': true,
  'connectors.manage': true,
  'connectors.read': true,
  'groups.manage': true,
  'groups.read': true,
  'insights.read': true,
  'monitoring.read': true,
  'office.read': true,
  'plugins.manage': true,
  'plugins.read': true,
  'roles.manage': true,
  'roles.read': true,
  'schedules.manage': true,
  'schedules.read': true,
  'sessions.manage': true,
  'sessions.read': true,
  'sessions.terminal': true,
  'settings.manage': true,
  'settings.read': true,
  'skills.manage': true,
  'skills.read': true,
  'team.manage': true,
  'team.read': true,
  'updates.manage': true,
  'updates.read': true,
  'whiteboards.manage': true,
  'whiteboards.read': true,
  'workflow.manage': false,
  'workflow.read': false,
};

export function buildCompatManifest(options: BuildCompatManifestOptions = {}): DesktopCompatManifest {
  const machineId = normalizeMachineId(
    options.machineId === undefined
      ? readPlatformBinding()?.machineId
      : options.machineId,
  );

  return {
    schemaVersion: 1,
    product: 'botmux',
    runtimeVersion: options.runtimeVersion ?? resolveEffectiveBotmuxVersion({
      rawVersion: botmuxVersion(),
      rootDir: botmuxInstallRoot(),
    }),
    dashboardProtocolVersion: 2,
    desktopShell: { supported: true },
    ...(machineId
      ? { runtimeIdentity: { source: 'platform-binding' as const, machineId } }
      : {}),
    features: [...DASHBOARD_COMPAT_FEATURES],
    routes: [...DASHBOARD_CORE_ROUTES],
    modules: structuredClone(DASHBOARD_MODULES),
    capabilities: { ...DASHBOARD_CAPABILITIES },
  };
}

function normalizeMachineId(value: string | null | undefined): string | undefined {
  const machineId = value?.trim();
  return machineId ? machineId : undefined;
}

export function handleDesktopCompat(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  if (req.method !== 'GET' || url.pathname !== '/__desktop/compat') return false;
  jsonRes(res, 200, buildCompatManifest());
  return true;
}
