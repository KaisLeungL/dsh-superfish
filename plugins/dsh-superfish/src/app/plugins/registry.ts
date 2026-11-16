import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import type { RegisteredContextCapability, ContextService } from '../../tools/context.js';
import type { SuperagentGenuiHostPlugin } from '../../genui/service.js';

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

interface StoredManualPlugin {
  readonly id: string;
  readonly packageName: string;
  readonly title: string;
  readonly description: string;
  readonly capabilityId: string;
  readonly enabled: boolean;
  readonly updatedAt: number;
}

interface StoredPluginState {
  readonly version: 1;
  readonly toggles: Readonly<Record<string, { readonly enabled: boolean; readonly updatedAt: number }>>;
  readonly manual: readonly StoredManualPlugin[];
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
    description: '在盘点中感知专注时段并支持渲染番茄钟状态卡片',
  },
};

export interface PluginSpaceRegistryOptions {
  readonly filePath?: string;
  readonly baseGrants?: Readonly<Record<string, string>>;
  readonly contextService?: () => ContextService | undefined;
  readonly genuiPlugin?: () => SuperagentGenuiHostPlugin | undefined;
  readonly policyRevision?: () => string;
}

export class PluginSpaceRegistry {
  private readonly filePath: string | undefined;
  private readonly baseGrants: Readonly<Record<string, string>>;
  private readonly getContextService: () => ContextService | undefined;
  private readonly getGenuiPlugin: () => SuperagentGenuiHostPlugin | undefined;
  private readonly getPolicyRevision: () => string;
  private toggles = new Map<string, { enabled: boolean; updatedAt: number }>();
  private manual = new Map<string, StoredManualPlugin>();

  constructor(options: PluginSpaceRegistryOptions) {
    this.filePath = options.filePath;
    this.baseGrants = options.baseGrants ?? Object.freeze({});
    this.getContextService = options.contextService ?? (() => undefined);
    this.getGenuiPlugin = options.genuiPlugin ?? (() => undefined);
    this.getPolicyRevision = options.policyRevision ?? (() => 'rev-default');
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<StoredPluginState>;
      if (raw && typeof raw === 'object') {
        if (raw.toggles && typeof raw.toggles === 'object' && !Array.isArray(raw.toggles)) {
          for (const [key, val] of Object.entries(raw.toggles)) {
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
              const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : item.packageName;
              this.manual.set(id, {
                id,
                packageName: item.packageName,
                title: typeof item.title === 'string' && item.title.trim() ? item.title.trim() : item.packageName,
                description:
                  typeof item.description === 'string' && item.description.trim()
                    ? item.description.trim()
                    : '前端手动关联并接入大肥鱼空间的自定义 DSH 插件',
                capabilityId: item.capabilityId,
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
    const byPkg = new Map<
      string,
      {
        id: string;
        packageName: string;
        title: string;
        description: string;
        source: 'builtin' | 'discovered' | 'manual';
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
      const existing = byPkg.get(man.packageName);
      if (existing) {
        if (!existing.capabilities.some(c => c.kind === 'context' && c.id === man.capabilityId)) {
          existing.capabilities.push({ kind: 'context', id: man.capabilityId });
        }
        existing.title = man.title || existing.title;
        existing.description = man.description || existing.description;
        existing.updatedAt = Math.max(existing.updatedAt, man.updatedAt);
      } else {
        byPkg.set(man.packageName, {
          id: man.id,
          packageName: man.packageName,
          title: man.title,
          description: man.description,
          source: 'manual',
          defaultEnabled: man.enabled,
          capabilities: [{ kind: 'context', id: man.capabilityId }],
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
    return this.snapshot();
  }

  registerManualPlugin(input: {
    packageName: string;
    capabilityId: string;
    title?: string;
    description?: string;
  }): PersonalPluginsSnapshot {
    const packageName = input.packageName.trim();
    const capabilityId = input.capabilityId.trim();
    if (
      !packageName ||
      packageName.length > 240 ||
      !PACKAGE_NAME_RE.test(packageName) ||
      !capabilityId ||
      capabilityId.length > 100 ||
      !CAPABILITY_ID_RE.test(capabilityId)
    ) {
      throw Error('PLUGIN_INVALID');
    }
    const title = input.title?.trim() ? input.title.trim().slice(0, 80) : packageName;
    const description = input.description?.trim()
      ? input.description.trim().slice(0, 240)
      : '前端手动关联并接入大肥鱼空间的自定义 DSH 插件';
    const now = Date.now();
    this.manual.set(packageName, {
      id: packageName,
      packageName,
      title,
      description,
      capabilityId,
      enabled: true,
      updatedAt: now,
    });
    this.toggles.set(packageName, { enabled: true, updatedAt: now });
    this.saveToDisk();
    return this.snapshot();
  }

  removeManualPlugin(idOrPkg: string): PersonalPluginsSnapshot {
    const key = idOrPkg.trim();
    if (!key) throw Error('PLUGIN_INVALID');
    this.manual.delete(key);
    this.toggles.delete(key);
    this.saveToDisk();
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
