import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import type { RegisteredContextCapability, ContextService } from '../../tools/context.js';
import type { SuperagentGenuiHostPlugin } from '../../genui/service.js';
import { isExcludedCorePluginPackage, type DynamicBridgeMode, type DynamicBridgeSpec, type DynamicPluginBridge } from './bridge.js';

const isDisallowedPluginSpaceKey = (pkgOrId: string): boolean => {
  const k = pkgOrId.trim();
  return (
    k.startsWith('@local/dsh-tool-') ||
    k === '@linxin666/dsh-client-ui-task-board' ||
    k.startsWith('@linxin666/dsh-client-ui-task-board/')
  );
};

const CAPABILITY_ID_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const PACKAGE_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(?:\/[a-z0-9-._~]+)*$/i;

export interface PersonalPluginCapability {
  readonly kind: 'context' | 'genui' | 'action';
  readonly id: string;
  readonly description?: string;
  readonly scope?: 'workspace' | 'project';
  readonly available?: boolean;
}

export interface PersonalPluginItem {
  readonly id: string;
  readonly packageName: string;
  readonly title: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly source: 'builtin' | 'discovered' | 'manual';
  readonly bridgeMode?: 'native' | 'dynamic';
  readonly bridgeKind?: 'tool' | 'service' | 'http' | 'manifest';
  readonly bridge?: DynamicBridgeSpec;
  readonly capabilities: readonly PersonalPluginCapability[];
  readonly updatedAt: number;
}

export interface PersonalPluginsSnapshot {
  readonly available: true;
  readonly items: readonly PersonalPluginItem[];
  readonly policyRevision: string;
  readonly contextGrants: Readonly<Record<string, string>>;
  readonly genuiPackages: readonly string[];
}

export interface StoredManualPlugin {
  readonly id: string;
  readonly packageName: string;
  readonly title: string;
  readonly description: string;
  readonly capabilityId: string;
  readonly bridge?: DynamicBridgeSpec;
  readonly enabled: boolean;
  readonly updatedAt: number;
}

interface StoredPluginState {
  readonly version: 1;
  readonly toggles: Readonly<Record<string, { readonly enabled: boolean; readonly updatedAt: number }>>;
  readonly manual: readonly StoredManualPlugin[];
}

function sanitizeBridgeSpec(raw: unknown): DynamicBridgeSpec | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const rawMode = obj.mode;
  const mode: DynamicBridgeMode =
    rawMode === 'tool' || rawMode === 'service' || rawMode === 'http' ? rawMode : 'auto';
  const toolName = typeof obj.toolName === 'string' && obj.toolName.trim() ? obj.toolName.trim().slice(0, 80) : undefined;
  const serviceName =
    typeof obj.serviceName === 'string' && obj.serviceName.trim() ? obj.serviceName.trim().slice(0, 80) : undefined;
  const serviceMethod =
    typeof obj.serviceMethod === 'string' && obj.serviceMethod.trim()
      ? obj.serviceMethod.trim().slice(0, 80)
      : undefined;
  const httpPath =
    typeof obj.httpPath === 'string' && obj.httpPath.trim().startsWith('/')
      ? obj.httpPath.trim().slice(0, 160)
      : undefined;
  const actionToolName =
    typeof obj.actionToolName === 'string' && obj.actionToolName.trim()
      ? obj.actionToolName.trim().slice(0, 80)
      : undefined;
  const toolReadArgs =
    obj.toolReadArgs && typeof obj.toolReadArgs === 'object' && !Array.isArray(obj.toolReadArgs)
      ? (obj.toolReadArgs as Readonly<Record<string, unknown>>)
      : undefined;
  const serviceReadArgs =
    obj.serviceReadArgs && typeof obj.serviceReadArgs === 'object' && !Array.isArray(obj.serviceReadArgs)
      ? (obj.serviceReadArgs as Readonly<Record<string, unknown>>)
      : undefined;
  return {
    mode,
    ...(toolName ? { toolName } : {}),
    ...(toolReadArgs ? { toolReadArgs } : {}),
    ...(serviceName ? { serviceName } : {}),
    ...(serviceMethod ? { serviceMethod } : {}),
    ...(serviceReadArgs ? { serviceReadArgs } : {}),
    ...(httpPath ? { httpPath } : {}),
    ...(actionToolName ? { actionToolName } : {}),
  };
}

function defaultCapabilityIdForPackage(packageName: string): string {
  const short = packageName
    .replace(/^@[^/]+\//, '')
    .replace(/^dsh-/, '')
    .replace(/[^a-z0-9-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  const prefix = short && /^[a-z]/.test(short) ? short : `plugin-${short || 'custom'}`;
  return `${prefix}.status`;
}

const KNOWN_PLUGIN_META: Readonly<
  Record<
    string,
    {
      readonly title: string;
      readonly description: string;
      readonly extraCapabilities?: readonly PersonalPluginCapability[];
    }
  >
> = {
  '@local/dsh-superfish/workspace-context/task-board': {
    title: 'DSH 任务看板',
    description: '向大肥鱼暴露看板任务列表、跨项目状态统计与受控 Worker 派工能力',
    extraCapabilities: [
      { kind: 'genui', id: 'task-board:summary' },
      { kind: 'action', id: 'delegate_task' },
    ],
  },
  '@local/dsh-superfish/workspace-context/session': {
    title: 'DSH 会话上下文',
    description: '跨工作区汇总已完成会话摘要，支持主理盘点近期工作进展',
  },
  '@local/dsh-superfish/workspace-context/schedule': {
    title: '定时巡检与快捷动作',
    description: '提供早晚报定时触发器、Cron 巡检状态读取与定时任务管理',
    extraCapabilities: [{ kind: 'action', id: 'schedule.trigger' }],
  },
  '@local/dsh-superfish/schedule-host': {
    title: '定时巡检与快捷动作',
    description: '提供早晚报定时触发器、Cron 巡检状态读取与定时任务管理',
    extraCapabilities: [{ kind: 'action', id: 'schedule.trigger' }],
  },
  '@local/dsh-workspace-context/task-board': {
    title: 'DSH 任务看板',
    description: '向大肥鱼暴露看板任务列表、跨项目状态统计与受控 Worker 派工能力',
    extraCapabilities: [
      { kind: 'genui', id: 'task-board:summary' },
      { kind: 'action', id: 'delegate_task' },
    ],
  },
  '@local/dsh-workspace-context/session': {
    title: 'DSH 会话上下文',
    description: '跨工作区汇总已完成会话摘要，支持主理盘点近期工作进展',
  },
  '@local/dsh-workspace-context/schedule': {
    title: '定时巡检与快捷动作',
    description: '提供早晚报定时触发器、Cron 巡检状态读取与定时任务管理',
    extraCapabilities: [{ kind: 'action', id: 'schedule.trigger' }],
  },
  '@local/dsh-quick-actions-schedule-host': {
    title: '定时巡检与快捷动作',
    description: '提供早晚报定时触发器、Cron 巡检状态读取与定时任务管理',
    extraCapabilities: [{ kind: 'action', id: 'schedule.trigger' }],
  },
  '@local/dsh-superfish/personal-todos': {
    title: '个人今日待办',
    description: '同步大肥鱼个人工作台今日待办清单与完成进度',
  },
  '@local/dsh-superfish/personal-memory': {
    title: '个人长期记忆库',
    description: '跨会话持久化个人偏好、项目规范与常驻核心记忆',
  },
  '@local/dsh-pomodoro-clock': {
    title: '番茄钟专注计时器',
    description: '感知番茄钟专注/休息倒计时状态，并支持大肥鱼直接启动、暂停、继续、重置或切换专注模式',
    extraCapabilities: [{ kind: 'action', id: 'pomodoro' }],
  },
  '@local/dsh-workspace-atlas': {
    title: 'All-In-One Workspace',
    description: '多仓架构拓扑全景可视化、Git 分支状态、跨仓依赖与构建门禁，并支持切换/关联工作区目录',
    extraCapabilities: [{ kind: 'action', id: 'workspace_atlas' }],
  },
};

export interface PluginSpaceRegistryOptions {
  readonly filePath?: string;
  readonly baseGrants?: Readonly<Record<string, string>>;
  readonly contextService?: () => ContextService | undefined;
  readonly genuiPlugin?: () => SuperagentGenuiHostPlugin | undefined;
  readonly dynamicBridge?: () => DynamicPluginBridge | undefined;
  readonly policyRevision?: () => string;
  readonly onMutation?: () => void;
}

export class PluginSpaceRegistry {
  private readonly filePath: string | undefined;
  private readonly baseGrants: Readonly<Record<string, string>>;
  private readonly getContextService: () => ContextService | undefined;
  private readonly getGenuiPlugin: () => SuperagentGenuiHostPlugin | undefined;
  private readonly getDynamicBridge: () => DynamicPluginBridge | undefined;
  private readonly getPolicyRevision: () => string;
  private readonly mutationListeners = new Set<() => void>();
  private toggles = new Map<string, { enabled: boolean; updatedAt: number }>();
  private manual = new Map<string, StoredManualPlugin>();

  constructor(options: PluginSpaceRegistryOptions) {
    this.filePath = options.filePath;
    this.baseGrants = options.baseGrants ?? Object.freeze({});
    this.getContextService = options.contextService ?? (() => undefined);
    this.getGenuiPlugin = options.genuiPlugin ?? (() => undefined);
    this.getDynamicBridge = options.dynamicBridge ?? (() => undefined);
    this.getPolicyRevision = options.policyRevision ?? (() => 'rev-default');
    if (options.onMutation) {
      this.mutationListeners.add(options.onMutation);
    }
    this.loadFromDisk();
  }

  onMutation(listener: () => void): () => void {
    this.mutationListeners.add(listener);
    return () => {
      this.mutationListeners.delete(listener);
    };
  }

  private notifyMutation(): void {
    for (const listener of this.mutationListeners) {
      try {
        listener();
      } catch {
        // ignore listener failure
      }
    }
  }

  manualBridgeSpecs(): ReadonlyMap<string, StoredManualPlugin> {
    return this.manual;
  }

  isPluginEnabled(packageName: string): boolean {
    const toggle = this.toggles.get(packageName);
    if (toggle) return toggle.enabled;
    const manual = this.manual.get(packageName);
    if (manual) return manual.enabled;
    return Object.values(this.baseGrants).includes(packageName);
  }

  private loadFromDisk(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<StoredPluginState>;
      if (raw && typeof raw === 'object') {
        if (raw.toggles && typeof raw.toggles === 'object' && !Array.isArray(raw.toggles)) {
          for (const [key, val] of Object.entries(raw.toggles)) {
            if (isDisallowedPluginSpaceKey(key)) continue;
            if (val && typeof val === 'object' && typeof val.enabled === 'boolean') {
              this.toggles.set(key, {
                enabled: val.enabled,
                updatedAt: typeof val.updatedAt === 'number' ? val.updatedAt : Date.now(),
              });
            }
          }
        }
        if (Array.isArray(raw.manual)) {
          for (const item of raw.manual) {
            if (
              item &&
              typeof item === 'object' &&
              typeof item.packageName === 'string' &&
              PACKAGE_NAME_RE.test(item.packageName) &&
              typeof item.capabilityId === 'string' &&
              CAPABILITY_ID_RE.test(item.capabilityId)
            ) {
              if (isDisallowedPluginSpaceKey(item.packageName)) continue;
              const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : item.packageName;
              const bridge = sanitizeBridgeSpec((item as { bridge?: unknown }).bridge);
              this.manual.set(id, {
                id,
                packageName: item.packageName,
                title: typeof item.title === 'string' && item.title.trim() ? item.title.trim() : item.packageName,
                description:
                  typeof item.description === 'string' && item.description.trim()
                    ? item.description.trim()
                    : '前端手动关联并接入大肥鱼空间的自定义 DSH 插件',
                capabilityId: item.capabilityId,
                ...(bridge ? { bridge } : {}),
                enabled: typeof item.enabled === 'boolean' ? item.enabled : true,
                updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now(),
              });
            }
          }
        }
      }
    } catch {
      // ignore corrupted plugin state file
    }
  }

  private saveToDisk(): void {
    if (!this.filePath) return;
    try {
      const payload: StoredPluginState = {
        version: 1,
        toggles: Object.fromEntries(this.toggles.entries()),
        manual: [...this.manual.values()],
      };
      const tmp = `${this.filePath}.${randomUUID()}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
      renameSync(tmp, this.filePath);
    } catch {
      // keep in-memory state available
    }
  }

  hasMutations(): boolean {
    return this.toggles.size > 0 || this.manual.size > 0;
  }

  clearAll(): void {
    this.toggles.clear();
    this.manual.clear();
    if (this.filePath) {
      try {
        unlinkSync(this.filePath);
      } catch {
        // ignore missing file
      }
    }
    this.notifyMutation();
  }

  private readRegisteredCapabilities(): readonly RegisteredContextCapability[] {
    try {
      const svc = this.getContextService();
      if (svc && typeof svc.listRegistered === 'function') {
        const list = svc.listRegistered();
        if (Array.isArray(list)) return list;
      }
    } catch {
      // ignore
    }
    return [];
  }

  private readRegisteredGenuiIds(): readonly string[] {
    try {
      const genui = this.getGenuiPlugin() as { listPlugins?(): readonly { id?: string }[] | readonly string[] } | undefined;
      if (genui && typeof genui.listPlugins === 'function') {
        const list = genui.listPlugins();
        if (Array.isArray(list)) {
          return list
            .map(entry => (typeof entry === 'string' ? entry : typeof entry?.id === 'string' ? entry.id : ''))
            .filter(Boolean);
        }
      }
    } catch {
      // ignore
    }
    return [];
  }

  effectiveGrants(): Readonly<Record<string, string>> {
    if (!this.hasMutations()) {
      return this.baseGrants;
    }
    const items = this.buildItems();
    const next: Record<string, string> = {};
    for (const item of items) {
      if (!item.enabled) continue;
      for (const cap of item.capabilities) {
        if (cap.kind === 'context') {
          next[cap.id] = item.packageName;
        }
      }
    }
    return Object.freeze(next);
  }

  private buildItems(): PersonalPluginItem[] {
    const registered = this.readRegisteredCapabilities();
    const genuiIds = this.readRegisteredGenuiIds();
    const dynamicDiscovered = (() => {
      try {
        return this.getDynamicBridge()?.discoverLocalPlugins() ?? [];
      } catch {
        return [];
      }
    })();

    const byPkg = new Map<
      string,
      {
        id: string;
        packageName: string;
        title: string;
        description: string;
        source: 'builtin' | 'discovered' | 'manual';
        bridgeMode?: 'native' | 'dynamic';
        bridgeKind?: 'tool' | 'service' | 'http' | 'manifest';
        bridge?: DynamicBridgeSpec;
        defaultEnabled: boolean;
        capabilities: PersonalPluginCapability[];
        updatedAt: number;
      }
    >();

    // 1. Seed from baseGrants (builtin / configured grants)
    for (const [capId, pkg] of Object.entries(this.baseGrants)) {
      const known = KNOWN_PLUGIN_META[pkg];
      const existing = byPkg.get(pkg);
      if (existing) {
        if (!existing.capabilities.some(c => c.kind === 'context' && c.id === capId)) {
          existing.capabilities.push({ kind: 'context', id: capId, available: true });
        }
      } else {
        const caps: PersonalPluginCapability[] = [{ kind: 'context', id: capId, available: true }];
        if (known?.extraCapabilities) {
          for (const extra of known.extraCapabilities) {
            caps.push(extra);
          }
        }
        byPkg.set(pkg, {
          id: pkg,
          packageName: pkg,
          title: known?.title ?? pkg,
          description: known?.description ?? `内置上下文数据源（${capId}）`,
          source: 'builtin',
          bridgeMode: 'native',
          defaultEnabled: true,
          capabilities: caps,
          updatedAt: 0,
        });
      }
    }

    // 2. Merge auto-discovered capabilities from workspaceContext.listRegistered()
    for (const reg of registered) {
      if (!reg || typeof reg.provider !== 'string' || typeof reg.id !== 'string') continue;
      const pkg = reg.provider;
      if (isDisallowedPluginSpaceKey(pkg)) continue;
      const known = KNOWN_PLUGIN_META[pkg];
      const existing = byPkg.get(pkg);
      if (existing) {
        const capIdx = existing.capabilities.findIndex(c => c.kind === 'context' && c.id === reg.id);
        const capEntry: PersonalPluginCapability = {
          kind: 'context',
          id: reg.id,
          ...(reg.description ? { description: reg.description } : {}),
          ...(reg.scope ? { scope: reg.scope } : {}),
          available: true,
        };
        if (capIdx >= 0) {
          existing.capabilities[capIdx] = capEntry;
        } else {
          existing.capabilities.push(capEntry);
        }
        if (!known && reg.source) {
          existing.title = reg.source;
        }
        if (!known && reg.description) {
          existing.description = reg.description;
        }
      } else {
        const inBase = this.baseGrants[reg.id] === pkg;
        byPkg.set(pkg, {
          id: pkg,
          packageName: pkg,
          title: known?.title || reg.source || pkg,
          description: known?.description || reg.description || `宿主已安装插件，提供上下文能力 ${reg.id}`,
          source: inBase ? 'builtin' : 'discovered',
          bridgeMode: 'native',
          defaultEnabled: inBase,
          capabilities: [
            {
              kind: 'context',
              id: reg.id,
              ...(reg.description ? { description: reg.description } : {}),
              ...(reg.scope ? { scope: reg.scope } : {}),
              available: true,
            },
            ...(known?.extraCapabilities ?? []),
          ],
          updatedAt: 0,
        });
      }
    }

    // 2.5. Merge auto-discovered local third-party plugins via DynamicPluginBridge
    for (const disc of dynamicDiscovered) {
      const pkg = disc.packageName;
      if (isDisallowedPluginSpaceKey(pkg) || isExcludedCorePluginPackage(pkg)) continue;
      const known = KNOWN_PLUGIN_META[pkg];
      const existing = byPkg.get(pkg);
      if (existing) {
        // Do not overwrite an existing native context capability if the plugin already registered one,
        // but ensure action tool capabilities are attached.
        if (!existing.capabilities.some(c => c.kind === 'context')) {
          existing.capabilities.push({
            kind: 'context',
            id: disc.capabilityId,
            description: disc.description,
            scope: 'workspace',
            available: disc.available,
          });
        }
        for (const actionTool of disc.actionToolNames) {
          if (!existing.capabilities.some(c => c.kind === 'action' && c.id === actionTool)) {
            existing.capabilities.push({
              kind: 'action',
              id: actionTool,
              available: disc.available,
            });
          }
        }
      } else {
        const caps: PersonalPluginCapability[] = [
          {
            kind: 'context',
            id: disc.capabilityId,
            description: disc.description,
            scope: 'workspace',
            available: disc.available,
          },
        ];
        for (const actionTool of disc.actionToolNames) {
          if (!caps.some(c => c.kind === 'action' && c.id === actionTool)) {
            caps.push({
              kind: 'action',
              id: actionTool,
              available: disc.available,
            });
          }
        }
        for (const extra of known?.extraCapabilities ?? []) {
          if (!caps.some(c => c.kind === extra.kind && c.id === extra.id)) {
            caps.push(extra);
          }
        }
        byPkg.set(pkg, {
          id: pkg,
          packageName: pkg,
          title: known?.title || disc.title || pkg,
          description: known?.description || disc.description || `自动发现本地 DSH 插件（${disc.capabilityId}）`,
          source: 'discovered',
          bridgeMode: disc.bridgeMode,
          bridgeKind: disc.bridgeKind,
          bridge: disc.bridgeSpec,
          defaultEnabled: false,
          capabilities: caps,
          updatedAt: 0,
        });
      }
    }

    // 3. Merge auto-discovered GenUI packages
    for (const genuiId of genuiIds) {
      if (!genuiId || genuiId === 'builtin') continue;
      const existing = byPkg.get(genuiId);
      if (existing) {
        if (!existing.capabilities.some(c => c.kind === 'genui' && c.id === `${genuiId}:materials`)) {
          existing.capabilities.push({ kind: 'genui', id: `${genuiId}:materials`, available: true });
        }
      }
    }

    // 4. Merge manually registered plugins
    for (const man of this.manual.values()) {
      if (isDisallowedPluginSpaceKey(man.packageName)) continue;
      const existing = byPkg.get(man.packageName);
      const actionToolId = man.bridge?.actionToolName || man.bridge?.toolName;
      if (existing) {
        if (!existing.capabilities.some(c => c.kind === 'context' && c.id === man.capabilityId)) {
          existing.capabilities.push({ kind: 'context', id: man.capabilityId });
        }
        if (actionToolId && !existing.capabilities.some(c => c.kind === 'action' && c.id === actionToolId)) {
          existing.capabilities.push({ kind: 'action', id: actionToolId });
        }
        existing.title = man.title || existing.title;
        existing.description = man.description || existing.description;
        if (man.bridge) {
          existing.bridgeMode = 'dynamic';
          existing.bridge = man.bridge;
        }
        existing.updatedAt = Math.max(existing.updatedAt, man.updatedAt);
      } else {
        const caps: PersonalPluginCapability[] = [{ kind: 'context', id: man.capabilityId }];
        if (actionToolId) {
          caps.push({ kind: 'action', id: actionToolId });
        }
        byPkg.set(man.packageName, {
          id: man.id,
          packageName: man.packageName,
          title: man.title,
          description: man.description,
          source: 'manual',
          bridgeMode: man.bridge ? 'dynamic' : 'native',
          ...(man.bridge ? { bridge: man.bridge } : {}),
          defaultEnabled: man.enabled,
          capabilities: caps,
          updatedAt: man.updatedAt,
        });
      }
    }

    // 5. Apply toggle overrides and sort (manual/discovered recently updated, then builtin)
    const result: PersonalPluginItem[] = [];
    for (const entry of byPkg.values()) {
      const toggle = this.toggles.get(entry.id) ?? this.toggles.get(entry.packageName);
      const enabled = toggle ? toggle.enabled : entry.defaultEnabled;
      const updatedAt = toggle ? Math.max(entry.updatedAt, toggle.updatedAt) : entry.updatedAt;
      result.push({
        id: entry.id,
        packageName: entry.packageName,
        title: entry.title,
        description: entry.description,
        enabled,
        source: entry.source,
        ...(entry.bridgeMode ? { bridgeMode: entry.bridgeMode } : {}),
        ...(entry.bridgeKind ? { bridgeKind: entry.bridgeKind } : {}),
        ...(entry.bridge ? { bridge: entry.bridge } : {}),
        capabilities: entry.capabilities,
        updatedAt,
      });
    }

    return result.sort((a, b) => {
      if (a.source === 'manual' && b.source !== 'manual') return -1;
      if (b.source === 'manual' && a.source !== 'manual') return 1;
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return a.packageName.localeCompare(b.packageName);
    });
  }

  togglePlugin(idOrPkg: string, enabled: boolean): PersonalPluginsSnapshot {
    const key = idOrPkg.trim();
    if (!key || key.length > 240) throw Error('PLUGIN_INVALID');
    const now = Date.now();
    this.toggles.set(key, { enabled, updatedAt: now });
    const manualItem = this.manual.get(key);
    if (manualItem) {
      this.manual.set(key, { ...manualItem, enabled, updatedAt: now });
    }
    this.saveToDisk();
    this.notifyMutation();
    return this.snapshot();
  }

  registerManualPlugin(input: {
    packageName: string;
    capabilityId?: string;
    title?: string;
    description?: string;
    bridge?: DynamicBridgeSpec;
  }): PersonalPluginsSnapshot {
    const packageName = input.packageName.trim();
    const rawCapId = input.capabilityId?.trim() || defaultCapabilityIdForPackage(packageName);
    if (
      !packageName ||
      packageName.length > 240 ||
      !PACKAGE_NAME_RE.test(packageName) ||
      !rawCapId ||
      rawCapId.length > 100 ||
      !CAPABILITY_ID_RE.test(rawCapId)
    ) {
      throw Error('PLUGIN_INVALID');
    }
    const title = input.title?.trim() ? input.title.trim().slice(0, 80) : packageName;
    const description = input.description?.trim()
      ? input.description.trim().slice(0, 240)
      : '前端手动关联并接入大肥鱼空间的自定义 DSH 插件';
    const bridge = sanitizeBridgeSpec(input.bridge);
    const now = Date.now();
    this.manual.set(packageName, {
      id: packageName,
      packageName,
      title,
      description,
      capabilityId: rawCapId,
      ...(bridge ? { bridge } : {}),
      enabled: true,
      updatedAt: now,
    });
    this.toggles.set(packageName, { enabled: true, updatedAt: now });
    this.saveToDisk();
    this.notifyMutation();
    return this.snapshot();
  }

  removeManualPlugin(idOrPkg: string): PersonalPluginsSnapshot {
    const key = idOrPkg.trim();
    if (!key) throw Error('PLUGIN_INVALID');
    this.manual.delete(key);
    this.toggles.delete(key);
    this.saveToDisk();
    this.notifyMutation();
    return this.snapshot();
  }

  snapshot(): PersonalPluginsSnapshot {
    const items = this.buildItems();
    const contextGrants: Record<string, string> = {};
    const genuiPackages: string[] = [];
    for (const item of items) {
      if (!item.enabled) continue;
      for (const cap of item.capabilities) {
        if (cap.kind === 'context') {
          contextGrants[cap.id] = item.packageName;
        } else if (cap.kind === 'genui') {
          genuiPackages.push(`${item.packageName} -> ${cap.id}`);
        }
      }
    }
    let policyRevision = 'rev-local';
    try {
      policyRevision = this.getPolicyRevision();
    } catch {
      // ignore when lifecycle not ready
    }
    return {
      available: true,
      items,
      policyRevision,
      contextGrants,
      genuiPackages,
    };
  }
}
