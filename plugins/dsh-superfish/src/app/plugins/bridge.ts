import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scrubSensitiveText } from '../sentinel/scrubber.js';
import { CallerDenied, type CallerAgent, type Invocation } from '../../tools/authority.js';
import type { ContextAccess, ContextService, RegisteredContextCapability } from '../../tools/context.js';

export type DynamicBridgeMode = 'auto' | 'tool' | 'service' | 'http';

export interface DynamicBridgeSpec {
  readonly mode: DynamicBridgeMode;
  readonly toolName?: string;
  readonly toolReadArgs?: Readonly<Record<string, unknown>>;
  readonly serviceName?: string;
  readonly serviceMethod?: string;
  readonly serviceReadArgs?: Readonly<Record<string, unknown>>;
  readonly httpPath?: string;
  readonly actionToolName?: string;
  readonly actionDescription?: string;
  readonly actionParameters?: Readonly<Record<string, unknown>>;
}

export interface DiscoveredLocalPlugin {
  readonly packageName: string;
  readonly title: string;
  readonly description: string;
  readonly capabilityId: string;
  readonly bridgeMode: 'native' | 'dynamic';
  readonly bridgeKind: 'tool' | 'service' | 'http' | 'manifest';
  readonly bridgeSpec: DynamicBridgeSpec;
  readonly contextFilterSchema?: Readonly<Record<string, unknown>>;
  readonly actionToolNames: readonly string[];
  readonly genuiIds: readonly string[];
  readonly available: boolean;
}

export interface GlobalToolDefinitionLike {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly output?: {
    readonly schema: Readonly<Record<string, unknown>>;
    readonly render: (args: unknown, value: unknown) => readonly { readonly type: 'text'; readonly text: string }[];
  };
  execute(input: unknown, exec?: unknown): Promise<unknown> | unknown;
}

export interface DynamicPluginRuntimeHost {
  get?(name: string): unknown;
  readonly registry?: {
    values?(): Iterable<{
      readonly runtime?: { readonly name?: string; readonly callback?: { readonly name?: string } };
    }>;
  };
}

export interface DynamicPluginBridgeOptions {
  readonly host?: () => DynamicPluginRuntimeHost | undefined;
  readonly workspacePath?: () => string | undefined;
  readonly isPluginEnabled?: (packageName: string) => boolean;
  readonly getManualBridgeSpecs?: () => ReadonlyMap<string, {
    readonly packageName: string;
    readonly capabilityId: string;
    readonly title: string;
    readonly description: string;
    readonly bridge?: DynamicBridgeSpec;
  }>;
  readonly extraPluginDirs?: readonly string[];
  readonly scanFilesystem?: boolean;
}

interface KnownThirdPartyAdapter {
  readonly packageName: string;
  readonly title: string;
  readonly description: string;
  readonly capabilityId: string;
  readonly capabilityDescription: string;
  readonly contextFilterSchema: Readonly<Record<string, unknown>>;
  readonly serviceName: string;
  readonly toolName: string;
  readonly httpPath: string;
  readonly defaultBridgeSpec: DynamicBridgeSpec;
  readonly genuiIds?: readonly string[];
  readFromService(service: Record<string, unknown>, filter: Record<string, unknown>): Promise<unknown>;
  executeToolViaService(service: Record<string, unknown>, args: Record<string, unknown>): Promise<unknown>;
  readonly synthesizedToolDefinition: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  };
}

const CORE_EXCLUDED_PACKAGES = new Set<string>([
  '@local/dsh-superfish',
  '@local/dsh-superfish/genui',
  '@local/dsh-superfish-genui',
  '@local/dsh-input-admission-cap4',
  '@local/dsh-superfish/workspace-context',
  '@local/dsh-superfish/workspace-context/task-board',
  '@local/dsh-superfish/workspace-context/session',
  '@local/dsh-superfish/workspace-context/schedule',
  '@local/dsh-superfish/schedule-host',
  '@local/dsh-superfish/schedule-ui',
  '@local/dsh-workspace-context',
  '@local/dsh-workspace-context/task-board',
  '@local/dsh-workspace-context/session',
  '@local/dsh-workspace-context/schedule',
  '@local/dsh-quick-actions-schedule-host',
  '@local/dsh-quick-actions-schedule-ui',
  '@local/dsh-superfish/personal-todos',
  '@local/dsh-superfish/personal-memory',
  '@linxin666/dsh-client-ui-task-board',
  '@zaimokuza/dsh-acp-adapter',
]);

export function isExcludedCorePluginPackage(packageName: string): boolean {
  const pkg = packageName.trim();
  if (!pkg) return true;
  if (CORE_EXCLUDED_PACKAGES.has(pkg)) return true;
  if (pkg === '@linxin666/dsh-client-ui-task-board' || pkg.startsWith('@linxin666/dsh-client-ui-task-board/')) {
    return true;
  }
  return false;
}

const CORE_AGENT_TOOLS = new Set<string>([
  'bash',
  'read',
  'write',
  'edit',
  'multiedit',
  'glob',
  'grep',
  'ls',
  'webfetch',
  'websearch',
  'todowrite',
  'todoread',
  'subagent',
  'skill',
  'apply_patch',
  'lsp',
  'dsh_context_catalog',
  'dsh_context_query',
  'steward_propose_action',
  'steward_create_schedule',
  'steward_load_quick_actions_skill',
  'steward_render_genui',
  'steward_load_genui_skill',
  'delegate_task',
]);

const isCoreToolName = (name: string): boolean => {
  if (!name || CORE_AGENT_TOOLS.has(name)) return true;
  return (
    name.startsWith('task_') ||
    name.startsWith('session_') ||
    name.startsWith('personal_') ||
    name.startsWith('steward_') ||
    name.startsWith('dsh_') ||
    name.startsWith('worker_') ||
    name.startsWith('external_')
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const sanitizeValue = (value: unknown, depth = 0): unknown => {
  if (depth > 6) return '[Truncated]';
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === 'string') {
    const trimmed = value.length > 2000 ? value.slice(0, 2000) + '…' : value;
    return scrubSensitiveText(trimmed).text;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 50)
      .map(entry => (entry === undefined ? null : sanitizeValue(entry, depth + 1)));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
      out[k] = sanitizeValue(v, depth + 1);
    }
    return out;
  }
  return String(value);
};

const KNOWN_ADAPTERS: Readonly<Record<string, KnownThirdPartyAdapter>> = {
  '@local/dsh-pomodoro-clock': {
    packageName: '@local/dsh-pomodoro-clock',
    title: '番茄钟专注计时器',
    description: '感知番茄钟专注/休息倒计时状态，并支持大肥鱼直接启动、暂停、继续、重置或切换专注模式',
    capabilityId: 'pomodoro.status',
    capabilityDescription: '读取 DSH 番茄钟当前计时状态（mode、status、remainingMs、remainingSeconds）。',
    contextFilterSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['focus', 'break'] },
      },
    },
    serviceName: 'localPomodoro',
    toolName: 'pomodoro',
    httpPath: '/api/local-pomodoro',
    defaultBridgeSpec: {
      mode: 'auto',
      serviceName: 'localPomodoro',
      serviceMethod: 'operate',
      serviceReadArgs: { action: 'status' },
      toolName: 'pomodoro',
      toolReadArgs: { action: 'status' },
      httpPath: '/api/local-pomodoro',
      actionToolName: 'pomodoro',
    },
    async readFromService(service, _filter) {
      if (typeof service.operate === 'function') {
        const res = await (service.operate as (input: unknown) => Promise<unknown>)({ action: 'status' });
        if (isRecord(res)) {
          const endsAt = typeof res.endsAt === 'number' ? res.endsAt : null;
          const serverNow = typeof res.serverNow === 'number' ? res.serverNow : Date.now();
          const remainingMs =
            res.status === 'running' && endsAt !== null
              ? Math.max(0, endsAt - serverNow)
              : typeof res.remainingMs === 'number'
                ? res.remainingMs
                : 0;
          return {
            id: 'pomodoro-active',
            ...res,
            remainingMs,
            remainingSeconds: Math.ceil(remainingMs / 1000),
          };
        }
        return res;
      }
      if (typeof service.getState === 'function') {
        return await (service.getState as () => Promise<unknown>)();
      }
      return { status: 'unavailable' };
    },
    async executeToolViaService(service, args) {
      const action = typeof args.action === 'string' ? args.action : 'status';
      const mode = typeof args.mode === 'string' ? args.mode : undefined;
      if (typeof service.operate === 'function') {
        const res = await (service.operate as (input: unknown) => Promise<unknown>)({
          action,
          ...(mode ? { mode } : {}),
        });
        if (isRecord(res)) {
          const endsAt = typeof res.endsAt === 'number' ? res.endsAt : null;
          const serverNow = typeof res.serverNow === 'number' ? res.serverNow : Date.now();
          const remainingMs =
            res.status === 'running' && endsAt !== null
              ? Math.max(0, endsAt - serverNow)
              : typeof res.remainingMs === 'number'
                ? res.remainingMs
                : 0;
          return {
            ...res,
            remainingMs,
            remainingSeconds: Math.ceil(remainingMs / 1000),
          };
        }
        return res;
      }
      throw new CallerDenied('PLUGIN_SERVICE_UNAVAILABLE', '番茄钟宿主服务当前不可用。');
    },
    synthesizedToolDefinition: {
      name: 'pomodoro',
      description:
        '读取或控制 DSH 侧边栏番茄钟计时器（插件动态注入工具）。action 支持 status（查询当前状态与剩余秒数）、start（启动专注或休息计时）、pause（暂停）、resume（继续）、reset（重置）、select（切换 focus 25分钟专注 / break 5分钟休息模式）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'start', 'pause', 'resume', 'reset', 'select'],
            description: '操作类型：status（仅查看状态）、start（开始计时）、pause（暂停）、resume（恢复计时）、reset（重置）、select（切换模式）。',
          },
          mode: {
            type: 'string',
            enum: ['focus', 'break'],
            description: '计时模式：focus（25分钟专注）或 break（5分钟休息）。select 时必填，start/reset 时可选。',
          },
        },
        required: ['action'],
      },
    },
  },
  '@local/dsh-workspace-atlas': {
    packageName: '@local/dsh-workspace-atlas',
    title: 'All-In-One Workspace',
    description: '多仓架构拓扑全景可视化、Git 分支状态、跨仓依赖与构建门禁，并支持切换/关联工作区目录',
    capabilityId: 'workspace-atlas.snapshot',
    capabilityDescription: '读取多仓库全景星图拓扑快照（已挂载仓库、分支脏状态、架构分层、跨仓库依赖关系与构建命令）。',
    contextFilterSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        repoId: { type: 'string', maxLength: 120 },
        lens: { type: 'string', enum: ['all', 'mounted', 'aigc', 'monetization', 'cloud', 'input'] },
      },
    },
    serviceName: 'workspaceAtlas',
    toolName: 'workspace_atlas',
    httpPath: '/api/workspace-atlas',
    defaultBridgeSpec: {
      mode: 'auto',
      serviceName: 'workspaceAtlas',
      serviceMethod: 'getSnapshot',
      toolName: 'workspace_atlas',
      httpPath: '/api/workspace-atlas',
      actionToolName: 'workspace_atlas',
    },
    async readFromService(service, filter) {
      if (typeof service.getSnapshot !== 'function') {
        return { status: 'unavailable' };
      }
      const snap = (await (service.getSnapshot as (wsPath?: string, force?: boolean) => Promise<unknown>)(
        undefined,
        false,
      )) as Record<string, unknown> | undefined;
      if (!snap || typeof snap !== 'object') return [];
      const repos = Array.isArray(snap.repos) ? (snap.repos as Record<string, unknown>[]) : [];
      const repoId = typeof filter.repoId === 'string' && filter.repoId.trim() ? filter.repoId.trim() : undefined;
      const lens = typeof filter.lens === 'string' && filter.lens.trim() ? filter.lens.trim() : undefined;
      const filtered = repos.filter(r => {
        if (repoId && r.id !== repoId && r.path !== repoId) return false;
        if (!lens || lens === 'all') return true;
        if (lens === 'mounted') return Boolean(r.mounted);
        return Array.isArray(r.lenses) && r.lenses.includes(lens);
      });
      if (filtered.length > 0) {
        return filtered.map(r => ({
          id: typeof r.id === 'string' ? r.id : String(r.path ?? 'repo'),
          path: r.path ?? '',
          col: r.col ?? null,
          mounted: Boolean(r.mounted),
          branch: r.branch ?? null,
          dirtyLabel: r.dirtyLabel ?? null,
          stack: r.stack ?? '',
          summary: r.summary ?? '',
          ...(repoId && r.commands !== undefined ? { commands: r.commands } : {}),
          ...(repoId && r.paths !== undefined ? { paths: r.paths } : {}),
        }));
      }
      return [
        {
          id: 'workspace-atlas-overview',
          linked: Boolean(snap.linked),
          workspace: snap.workspace ?? null,
          availableWorkspaces: snap.availableWorkspaces ?? snap.workspaces ?? [],
          repoCount: repos.length,
        },
      ];
    },
    async executeToolViaService(service, args) {
      const action = typeof args.action === 'string' ? args.action : 'snapshot';
      if (action === 'selectWorkspace' && typeof args.workspacePath === 'string' && typeof service.selectWorkspace === 'function') {
        const nextPath = (service.selectWorkspace as (p: string) => string)(args.workspacePath);
        if (typeof service.getSnapshot === 'function') {
          return await (service.getSnapshot as (p?: string, force?: boolean) => Promise<unknown>)(nextPath, true);
        }
        return { activeWorkspacePath: nextPath };
      }
      if (action === 'linkDirectory' && typeof args.path === 'string' && typeof service.linkDirectory === 'function') {
        const targetPath = (service.linkDirectory as (p: string, append?: boolean) => string)(
          args.path,
          Boolean(args.appendToCurrent),
        );
        if (typeof service.getSnapshot === 'function') {
          return await (service.getSnapshot as (p?: string, force?: boolean) => Promise<unknown>)(targetPath, true);
        }
        return { linkedPath: targetPath };
      }
      if (action === 'linkRemote' && typeof args.remoteUrl === 'string' && typeof service.linkRemote === 'function') {
        const targetPath = (service.linkRemote as (u: string) => string)(args.remoteUrl);
        if (typeof service.getSnapshot === 'function') {
          return await (service.getSnapshot as (p?: string, force?: boolean) => Promise<unknown>)(targetPath, true);
        }
        return { linkedRemote: targetPath };
      }
      if (action === 'unlinkWorkspace' && typeof service.unlinkWorkspace === 'function') {
        const nextPath = (service.unlinkWorkspace as (p?: string) => string | null)(
          typeof args.workspacePath === 'string' ? args.workspacePath : undefined,
        );
        if (typeof service.getSnapshot === 'function') {
          return await (service.getSnapshot as (p?: string, force?: boolean) => Promise<unknown>)(
            nextPath ?? undefined,
            true,
          );
        }
        return { activeWorkspacePath: nextPath };
      }
      if (typeof service.getSnapshot === 'function') {
        const snap = (await (service.getSnapshot as (wsPath?: string, force?: boolean) => Promise<unknown>)(
          typeof args.workspacePath === 'string' ? args.workspacePath : undefined,
          Boolean(args.refresh),
        )) as Record<string, unknown>;
        if (!snap?.linked) {
          return {
            linked: false,
            availableWorkspaces: snap?.availableWorkspaces ?? snap?.workspaces ?? [],
            message: '当前 Workspace Atlas 尚未关联活跃多仓目录，可通过 action="linkDirectory" 或 "selectWorkspace" 关联。',
          };
        }
        const repos = Array.isArray(snap.repos) ? (snap.repos as Record<string, unknown>[]) : [];
        if (typeof args.repoId === 'string' && args.repoId.trim()) {
          const repo = repos.find(r => r.id === args.repoId || r.path === args.repoId);
          if (!repo) return { error: `Repository not found: ${args.repoId}` };
          const edges = Array.isArray(snap.edges) ? (snap.edges as Record<string, unknown>[]) : [];
          const relations = edges.filter(e => e.from === repo.id || e.to === repo.id);
          return {
            workspace: snap.workspace ?? null,
            repo,
            relations,
            sdkGates: snap.sdkGates ?? null,
          };
        }
        const lens = typeof args.lens === 'string' ? args.lens : 'all';
        return {
          linked: true,
          workspace: snap.workspace ?? null,
          availableWorkspaces: snap.availableWorkspaces ?? snap.workspaces ?? [],
          repos: repos
            .filter(r => {
              if (!lens || lens === 'all') return true;
              if (lens === 'mounted') return Boolean(r.mounted);
              return Array.isArray(r.lenses) && r.lenses.includes(lens);
            })
            .map(r => ({
              id: r.id ?? '',
              path: r.path ?? '',
              col: r.col ?? null,
              mounted: Boolean(r.mounted),
              branch: r.branch ?? null,
              dirtyLabel: r.dirtyLabel ?? null,
              stack: r.stack ?? '',
              summary: r.summary ?? '',
            })),
          edges: Array.isArray(snap.edges) ? snap.edges : [],
          sdkGates: snap.sdkGates ?? null,
        };
      }
      throw new CallerDenied('PLUGIN_SERVICE_UNAVAILABLE', 'Workspace Atlas 宿主服务当前不可用。');
    },
    synthesizedToolDefinition: {
      name: 'workspace_atlas',
      description:
        '查询或控制多仓库全景星图 Workspace Atlas（插件动态注入工具）。支持查看已挂载仓库拓扑、分支脏状态、跨仓依赖、构建测试门禁（action="snapshot"），或直接切换活跃工作区（action="selectWorkspace"）、关联本地目录（action="linkDirectory"）、关联远程仓库（action="linkRemote"）、取消关联（action="unlinkWorkspace"）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['snapshot', 'selectWorkspace', 'linkDirectory', 'linkRemote', 'unlinkWorkspace'],
            description: '操作类型：默认为 snapshot（读取星图全景或单仓详情）。',
          },
          repoId: {
            type: 'string',
            description: '可选仓库短 ID（如 simeji-global、ime-android-lib、TreasureBowl），传入后返回该仓库详情与上下游依赖边。',
          },
          lens: {
            type: 'string',
            enum: ['all', 'mounted', 'aigc', 'monetization', 'cloud', 'input'],
            description: '可选领域透镜过滤条件。',
          },
          workspacePath: {
            type: 'string',
            description: '当 action 为 selectWorkspace 或 unlinkWorkspace 时的目标工作区路径。',
          },
          path: {
            type: 'string',
            description: '当 action 为 linkDirectory 时要关联的本地目录路径。',
          },
          appendToCurrent: {
            type: 'boolean',
            description: '当 action 为 linkDirectory 时是否追加合并到当前自定义星图。',
          },
          remoteUrl: {
            type: 'string',
            description: '当 action 为 linkRemote 时要关联的 Git 远程地址。',
          },
          refresh: {
            type: 'boolean',
            description: '是否强制刷新 Git 状态缓存。',
          },
        },
      },
    },
  },
};

function deriveCapabilityId(packageName: string): string {
  const short = packageName
    .replace(/^@[^/]+\//, '')
    .replace(/^dsh-/, '')
    .replace(/[^a-z0-9-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `${short || 'plugin'}.context`;
}

function deriveServiceCandidates(packageName: string): string[] {
  const raw = packageName.replace(/^@[^/]+\//, '');
  const withoutDsh = raw.replace(/^dsh-/, '');
  const toCamel = (s: string) =>
    s.replace(/-([a-z0-9])/gi, (_, ch: string) => ch.toUpperCase());
  const candidates = new Set<string>([
    toCamel(withoutDsh),
    toCamel(raw),
    toCamel(`local-${withoutDsh}`),
    toCamel(withoutDsh.replace(/-clock$|-plugin$|-host$/, '')),
    toCamel(`local-${withoutDsh.replace(/-clock$|-plugin$|-host$/, '')}`),
  ]);
  return [...candidates].filter(Boolean);
}

function deriveToolCandidates(packageName: string): string[] {
  const withoutScope = packageName.replace(/^@[^/]+\//, '').replace(/^dsh-/, '');
  const trimmed = withoutScope.replace(/-clock$|-plugin$|-host$/, '');
  return [
    withoutScope.replace(/-/g, '_'),
    trimmed.replace(/-/g, '_'),
    withoutScope,
    trimmed,
  ].filter(Boolean);
}

interface ManifestMeta {
  readonly packageName: string;
  readonly title: string;
  readonly description: string;
  readonly dirPath?: string;
}

function readLocaleTitleAndDesc(pluginDir: string): { title?: string; description?: string } {
  const candidates = [
    join(pluginDir, 'locale', 'zh.json'),
    join(pluginDir, 'locales', 'zh.json'),
    join(pluginDir, 'locale', 'en.json'),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      for (const val of Object.values(parsed)) {
        if (isRecord(val)) {
          const title =
            typeof val.title === 'string'
              ? val.title
              : typeof val.pluginTitle === 'string'
                ? val.pluginTitle
                : typeof val.name === 'string'
                  ? val.name
                  : undefined;
          const description =
            typeof val.subtitle === 'string'
              ? val.subtitle
              : typeof val.pluginDescription === 'string'
                ? val.pluginDescription
                : typeof val.description === 'string'
                  ? val.description
                  : undefined;
          if (title || description) return { ...(title ? { title } : {}), ...(description ? { description } : {}) };
        }
      }
    } catch {
      // ignore invalid locale json
    }
  }
  return {};
}

interface CursorRecord {
  readonly binding: string;
  readonly capability: string;
  readonly filterKey: string;
  readonly offset: number;
  readonly expiresAt: number;
}

const CURSOR_TTL_MS = 300_000;
const MAX_PAYLOAD_BYTES = 16_384;

export class DynamicPluginBridge {
  private readonly getHost: () => DynamicPluginRuntimeHost | undefined;
  private readonly isPluginEnabledFn: (packageName: string) => boolean;
  private readonly getManualSpecsFn: () => ReadonlyMap<
    string,
    {
      readonly packageName: string;
      readonly capabilityId: string;
      readonly title: string;
      readonly description: string;
      readonly bridge?: DynamicBridgeSpec;
    }
  >;
  private readonly extraPluginDirs: readonly string[];
  private readonly scanFilesystem: boolean;
  private readonly cursors = new Map<string, CursorRecord>();

  constructor(options: DynamicPluginBridgeOptions = {}) {
    this.getHost = options.host ?? (() => undefined);
    this.isPluginEnabledFn = options.isPluginEnabled ?? (() => false);
    this.getManualSpecsFn = options.getManualBridgeSpecs ?? (() => new Map());
    this.extraPluginDirs = options.extraPluginDirs ?? [];
    this.scanFilesystem = options.scanFilesystem ?? true;
  }

  private readGlobalTools(): Map<string, GlobalToolDefinitionLike> {
    const map = new Map<string, GlobalToolDefinitionLike>();
    try {
      const host = this.getHost();
      const toolsSvc = host?.get?.('tools') as { definitions?(): readonly GlobalToolDefinitionLike[] } | undefined;
      const defs = typeof toolsSvc?.definitions === 'function' ? toolsSvc.definitions() : [];
      if (Array.isArray(defs)) {
        for (const def of defs) {
          if (def && typeof def.name === 'string' && typeof def.execute === 'function' && !isCoreToolName(def.name)) {
            map.set(def.name, def);
          }
        }
      }
    } catch {
      // ignore
    }
    return map;
  }

  private readStartedBundles(): Set<string> {
    const started = new Set<string>();
    try {
      const profileCtx = this.getHost()?.get?.('profileContext') as
        | { startedBundles?: Iterable<string> }
        | undefined;
      if (profileCtx?.startedBundles) {
        for (const name of profileCtx.startedBundles) {
          if (typeof name === 'string' && name.trim()) {
            started.add(name.trim());
          }
        }
      }
    } catch {
      // ignore
    }
    return started;
  }

  private scanManifestPackages(startedBundles: ReadonlySet<string>): Map<string, ManifestMeta> {
    const result = new Map<string, ManifestMeta>();
    if (!this.scanFilesystem) return result;

    const addPackageDir = (dir: string) => {
      const pkgJsonPath = join(dir, 'package.json');
      if (!existsSync(pkgJsonPath)) return;
      try {
        const raw = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as Record<string, unknown>;
        const name = typeof raw.name === 'string' ? raw.name.trim() : '';
        if (!name || name.startsWith('@deepseek-ai/') || isExcludedCorePluginPackage(name)) return;
        if (startedBundles.size > 0 && !startedBundles.has(name)) return;
        const isDshPlugin = Boolean(raw.dsh) || name.includes('dsh-');
        if (!isDshPlugin) return;
        const locale = readLocaleTitleAndDesc(dir);
        const known = KNOWN_ADAPTERS[name];
        const title = known?.title || locale.title || (typeof raw.title === 'string' ? raw.title : name);
        const description =
          known?.description ||
          locale.description ||
          (typeof raw.description === 'string' && raw.description.trim()
            ? raw.description.trim()
            : `本地已安装 DSH 插件（${name}）`);
        result.set(name, { packageName: name, title, description, dirPath: dir });
      } catch {
        // ignore invalid package.json
      }
    };

    try {
      const profileCtx = this.getHost()?.get?.('profileContext') as
        | { dir?: string; startedBundles?: readonly string[] }
        | undefined;
      if (typeof profileCtx?.dir === 'string' && profileCtx.dir.trim()) {
        const profDir = profileCtx.dir.trim();
        for (const pkgName of startedBundles) {
          if (pkgName.startsWith('@deepseek-ai/') || isExcludedCorePluginPackage(pkgName)) continue;
          const nmDir = join(profDir, 'node_modules', ...pkgName.split('/'));
          addPackageDir(nmDir);
        }
      }
    } catch {
      // ignore
    }

    for (const extra of this.extraPluginDirs) {
      addPackageDir(extra);
    }

    return result;
  }

  /**
   * Automatically discover only currently installed and loaded DSH third-party plugins.
   */
  discoverLocalPlugins(): readonly DiscoveredLocalPlugin[] {
    const host = this.getHost();
    const globalTools = this.readGlobalTools();
    const startedBundles = this.readStartedBundles();
    const manifests = this.scanManifestPackages(startedBundles);
    const discovered = new Map<string, DiscoveredLocalPlugin>();

    // 1. Check known third-party adapters — ONLY include if currently loaded in runtime (hasService || hasTool)
    for (const [pkgName, adapter] of Object.entries(KNOWN_ADAPTERS)) {
      const hasService = Boolean(host?.get?.(adapter.serviceName));
      const hasTool = globalTools.has(adapter.toolName);
      if (!hasService && !hasTool) continue;
      const manifest = manifests.get(pkgName);
      discovered.set(pkgName, {
        packageName: pkgName,
        title: adapter.title || manifest?.title || pkgName,
        description: adapter.description || manifest?.description || '',
        capabilityId: adapter.capabilityId,
        bridgeMode: 'dynamic',
        bridgeKind: hasService ? 'service' : 'tool',
        bridgeSpec: adapter.defaultBridgeSpec,
        contextFilterSchema: adapter.contextFilterSchema,
        actionToolNames: [adapter.toolName],
        genuiIds: adapter.genuiIds ?? [],
        available: true,
      });
    }

    // 2. Discover remaining loaded bundles in startedBundles that expose a runtime service or tool
    for (const [pkgName, meta] of manifests.entries()) {
      if (discovered.has(pkgName) || isExcludedCorePluginPackage(pkgName)) continue;
      const serviceCandidates = deriveServiceCandidates(pkgName);
      let matchedService: string | undefined;
      for (const candidate of serviceCandidates) {
        if (host?.get?.(candidate)) {
          matchedService = candidate;
          break;
        }
      }
      const toolCandidates = deriveToolCandidates(pkgName);
      let matchedTool: GlobalToolDefinitionLike | undefined;
      for (const candidate of toolCandidates) {
        const found = globalTools.get(candidate);
        if (found) {
          matchedTool = found;
          break;
        }
      }
      if (!matchedService && !matchedTool) continue;
      const capId = deriveCapabilityId(pkgName);
      const actionToolName = matchedTool?.name ?? (matchedService ? toolCandidates[0] : undefined);
      discovered.set(pkgName, {
        packageName: pkgName,
        title: meta.title,
        description: meta.description,
        capabilityId: capId,
        bridgeMode: 'dynamic',
        bridgeKind: matchedService ? 'service' : 'tool',
        bridgeSpec: {
          mode: 'auto',
          ...(matchedService ? { serviceName: matchedService } : {}),
          ...(matchedTool ? { toolName: matchedTool.name } : {}),
          ...(actionToolName ? { actionToolName } : {}),
        },
        actionToolNames: actionToolName ? [actionToolName] : [],
        genuiIds: [],
        available: true,
      });
    }

    // 3. Merge manually registered plugins that have dynamic bridge specs
    for (const manual of this.getManualSpecsFn().values()) {
      if (discovered.has(manual.packageName)) continue;
      const spec: DynamicBridgeSpec = manual.bridge ?? {
        mode: 'auto',
      };
      const serviceName = spec.serviceName || deriveServiceCandidates(manual.packageName).find(c => Boolean(host?.get?.(c)));
      const toolName = spec.toolName || deriveToolCandidates(manual.packageName).find(c => globalTools.has(c));
      const actionToolName =
        spec.actionToolName ||
        toolName ||
        (serviceName || spec.httpPath ? deriveToolCandidates(manual.packageName)[0] : undefined);
      const isAvail = Boolean(
        (serviceName && host?.get?.(serviceName)) ||
          (toolName && globalTools.has(toolName)) ||
          spec.httpPath,
      );
      discovered.set(manual.packageName, {
        packageName: manual.packageName,
        title: manual.title,
        description: manual.description,
        capabilityId: manual.capabilityId,
        bridgeMode: 'dynamic',
        bridgeKind: spec.mode === 'http' ? 'http' : serviceName ? 'service' : toolName ? 'tool' : 'manifest',
        bridgeSpec: {
          ...spec,
          ...(serviceName ? { serviceName } : {}),
          ...(toolName ? { toolName } : {}),
          ...(actionToolName ? { actionToolName } : {}),
        },
        actionToolNames: actionToolName ? [actionToolName] : [],
        genuiIds: [],
        available: isAvail,
      });
    }

    return [...discovered.values()];
  }

  /**
   * List synthesized `RegisteredContextCapability` descriptors for all discovered/manual dynamic plugins.
   */
  listSynthesizedCapabilities(): readonly RegisteredContextCapability[] {
    const plugins = this.discoverLocalPlugins();
    const out: RegisteredContextCapability[] = [];
    for (const plugin of plugins) {
      const known = KNOWN_ADAPTERS[plugin.packageName];
      out.push({
        protocol: 1,
        id: plugin.capabilityId,
        source: plugin.title,
        provider: plugin.packageName,
        description: known?.capabilityDescription || plugin.description,
        scope: 'workspace',
        ...(plugin.contextFilterSchema ? { filters: plugin.contextFilterSchema } : {}),
        ...(plugin.available ? { status: 'available' as const } : {}),
      });
    }
    return out;
  }

  hasCapability(capabilityId: string): boolean {
    return this.discoverLocalPlugins().some(p => p.capabilityId === capabilityId);
  }

  isCapabilityAvailable(capabilityId: string): boolean {
    const found = this.discoverLocalPlugins().find(p => p.capabilityId === capabilityId);
    return Boolean(found?.available);
  }

  private saveCursor(record: Omit<CursorRecord, 'expiresAt'>): string {
    const token = randomUUID();
    if (this.cursors.size >= 128) {
      const oldest = this.cursors.keys().next().value;
      if (oldest !== undefined) this.cursors.delete(oldest);
    }
    this.cursors.set(token, { ...record, expiresAt: Date.now() + CURSOR_TTL_MS });
    return token;
  }

  async querySynthesizedCapability(access: ContextAccess, rawInput: unknown): Promise<unknown> {
    access.assertCurrent();
    if (!isRecord(rawInput) || typeof rawInput.capability !== 'string') {
      return { status: 'invalid_query' };
    }
    if (Object.keys(rawInput).some(k => !['capability', 'filter', 'limit', 'cursor'].includes(k))) {
      return { status: 'invalid_query' };
    }
    const capabilityId = rawInput.capability;
    const plugin = this.discoverLocalPlugins().find(p => p.capabilityId === capabilityId);
    if (!plugin) {
      return { status: 'unavailable', capability: capabilityId };
    }
    const grantedProvider = access.grants[capabilityId];
    if (!grantedProvider || grantedProvider !== plugin.packageName) {
      return { status: 'denied', capability: capabilityId };
    }
    if (!plugin.available) {
      return { status: 'unavailable', capability: capabilityId };
    }

    const filter = isRecord(rawInput.filter) ? rawInput.filter : {};
    const limit =
      typeof rawInput.limit === 'number' && Number.isInteger(rawInput.limit)
        ? Math.min(20, Math.max(1, rawInput.limit))
        : 10;
    const filterKey = JSON.stringify(filter);
    let offset = 0;
    if (rawInput.cursor !== undefined) {
      if (typeof rawInput.cursor !== 'string') return { status: 'invalid_cursor', capability: capabilityId };
      const cursor = this.cursors.get(rawInput.cursor);
      if (
        !cursor ||
        cursor.expiresAt < Date.now() ||
        cursor.binding !== access.binding ||
        cursor.capability !== capabilityId ||
        cursor.filterKey !== filterKey
      ) {
        return { status: 'invalid_cursor', capability: capabilityId };
      }
      offset = cursor.offset;
    }

    let rawData: unknown;
    try {
      rawData = await this.readPluginContextPayload(plugin, filter, access.signal);
    } catch {
      return { status: 'unavailable', capability: capabilityId };
    }
    access.assertCurrent();

    const normalizedItems = this.normalizeContextItems(
      rawData,
      access.scope.workspaceId,
      plugin.capabilityId,
      filter,
    );

    const sliced = normalizedItems.slice(offset, offset + limit);
    const bounded: Record<string, unknown>[] = [];
    let bytes = 0;
    for (const item of sliced) {
      const encoded = Buffer.byteLength(JSON.stringify(item), 'utf8');
      if (bounded.length > 0 && bytes + encoded > MAX_PAYLOAD_BYTES) break;
      bounded.push(item);
      bytes += encoded;
    }
    const nextOffset = offset + bounded.length;
    const hasMore = nextOffset < normalizedItems.length;
    const nextCursor = hasMore
      ? this.saveCursor({
          binding: access.binding,
          capability: capabilityId,
          filterKey,
          offset: nextOffset,
        })
      : undefined;

    return {
      status: 'ok',
      protocol: 1,
      capability: capabilityId,
      source: plugin.title,
      provider: plugin.packageName,
      workspaceId: access.scope.workspaceId,
      readScope: 'workspace',
      readAt: new Date().toISOString(),
      items: bounded,
      complete: !hasMore,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  private async readPluginContextPayload(
    plugin: DiscoveredLocalPlugin,
    filter: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const host = this.getHost();
    const known = KNOWN_ADAPTERS[plugin.packageName];

    // 1. Known adapter with active Cordis service
    if (known) {
      const svc = host?.get?.(known.serviceName);
      if (isRecord(svc)) {
        return await known.readFromService(svc, filter);
      }
    }

    const spec = plugin.bridgeSpec;
    // 2. Generic Cordis service read
    if (spec.serviceName) {
      const svc = host?.get?.(spec.serviceName);
      if (isRecord(svc)) {
        const methodCandidates = [
          ...(spec.serviceMethod ? [spec.serviceMethod] : []),
          'getSnapshot',
          'getState',
          'status',
          'list',
          'read',
          'query',
          'operate',
        ];
        for (const methodName of methodCandidates) {
          const fn = svc[methodName];
          if (typeof fn === 'function') {
            const arg =
              methodName === 'operate'
                ? { action: 'status', ...(spec.serviceReadArgs ?? {}), ...filter }
                : { ...(spec.serviceReadArgs ?? {}), ...filter };
            return await (fn as (a?: unknown) => Promise<unknown>).call(svc, arg);
          }
        }
      }
    }

    // 3. Global tool read
    const globalTools = this.readGlobalTools();
    const toolName = spec.toolName || known?.toolName;
    if (toolName) {
      const tool = globalTools.get(toolName);
      if (tool) {
        const readArgs = {
          ...(known?.defaultBridgeSpec.toolReadArgs ?? {}),
          ...(spec.toolReadArgs ?? {}),
          ...filter,
        };
        return await tool.execute(readArgs, { signal, name: tool.name });
      }
    }

    throw new Error('PLUGIN_BRIDGE_SOURCE_UNAVAILABLE');
  }

  private normalizeContextItems(
    rawData: unknown,
    workspaceId: string,
    capabilityId: string,
    filter: Record<string, unknown>,
  ): Record<string, unknown>[] {
    const refKind = capabilityId.split('.')[0] || 'plugin';
    let list: unknown[];
    if (Array.isArray(rawData)) {
      list = rawData;
    } else if (isRecord(rawData)) {
      if (Array.isArray(rawData.items)) list = rawData.items;
      else if (Array.isArray(rawData.repos)) list = rawData.repos;
      else if (Array.isArray(rawData.workspaces)) list = rawData.workspaces;
      else if (Array.isArray(rawData.timers)) list = rawData.timers;
      else if (Array.isArray(rawData.records)) list = rawData.records;
      else list = [rawData];
    } else {
      list = [{ value: rawData }];
    }

    const out: Record<string, unknown>[] = [];
    for (let i = 0; i < list.length; i++) {
      const rawEntry = list[i];
      const sanitized = sanitizeValue(rawEntry);
      const record = isRecord(sanitized) ? sanitized : { value: sanitized };
      // Apply lightweight scalar filter matching if filter keys correspond to item fields
      let matches = true;
      for (const [fk, fv] of Object.entries(filter)) {
        if (fv === undefined || fv === null || fv === '' || fv === 'all') continue;
        if (fk in record && record[fk] !== undefined && record[fk] !== fv) {
          matches = false;
          break;
        }
      }
      if (!matches) continue;
      const itemId =
        typeof record.id === 'string' && record.id.trim()
          ? record.id.trim()
          : `${refKind}-${i + 1}`;
      out.push({
        ...record,
        id: itemId,
        workspaceId,
        ref: { kind: refKind, id: itemId },
      });
    }
    return out;
  }

  /**
   * Check whether a given tool name belongs to an enabled dynamically bridged plugin.
   */
  isEnabledPluginActionTool(toolName: string): boolean {
    for (const plugin of this.discoverLocalPlugins()) {
      if (!plugin.actionToolNames.includes(toolName)) continue;
      if (this.isPluginEnabledFn(plugin.packageName)) return true;
    }
    return false;
  }

  /**
   * Build native tool definitions for all currently enabled dynamic plugins so the Router can directly execute read & write/control actions.
   */
  buildEnabledActionToolDefinitions<A extends CallerAgent>(
    checkForegroundRouter: (exec: Invocation<A> & { readonly name: string }) => { session: string; turn: number },
  ) {
    const host = this.getHost();
    const globalTools = this.readGlobalTools();
    const definitions: {
      readonly name: string;
      readonly description: string;
      readonly parameters: Readonly<Record<string, unknown>>;
      readonly output: {
        readonly schema: Readonly<Record<string, unknown>>;
        readonly render: (_args: unknown, value: unknown) => readonly { readonly type: 'text'; readonly text: string }[];
      };
      execute(args: unknown, exec: Invocation<A> & { readonly name: string }): Promise<unknown>;
    }[] = [];
    const seenToolNames = new Set<string>();

    for (const plugin of this.discoverLocalPlugins()) {
      if (!this.isPluginEnabledFn(plugin.packageName) || !plugin.available) continue;
      const known = KNOWN_ADAPTERS[plugin.packageName];
      for (const toolName of plugin.actionToolNames) {
        if (!toolName || seenToolNames.has(toolName) || isCoreToolName(toolName)) continue;
        seenToolNames.add(toolName);
        const globalDef = globalTools.get(toolName);
        const description =
          known?.synthesizedToolDefinition.description ||
          plugin.bridgeSpec.actionDescription ||
          globalDef?.description ||
          `调用已启用插件「${plugin.title}」（${plugin.packageName}）的原生控制与查询工具。`;
        const parameters =
          known?.synthesizedToolDefinition.parameters ||
          plugin.bridgeSpec.actionParameters ||
          globalDef?.parameters || {
            type: 'object',
            additionalProperties: true,
            properties: {
              action: {
                type: 'string',
                description: '要执行的插件动作名称（例如 status、start、pause、reset、snapshot 等）。',
              },
            },
          };

        definitions.push({
          name: toolName,
          description,
          parameters,
          output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          execute: async (rawArgs: unknown, exec: Invocation<A> & { readonly name: string }) => {
            checkForegroundRouter(exec);
            if (!this.isPluginEnabledFn(plugin.packageName)) {
              throw new CallerDenied('PLUGIN_DISABLED', `插件「${plugin.title}」已在插件空间中关闭，无法调用工具 ${toolName}。`);
            }
            const args = isRecord(rawArgs) ? rawArgs : {};
            // Prefer known service adapter when service is active (supports rich control actions even if global tool is read-only)
            if (known) {
              const svc = host?.get?.(known.serviceName);
              if (isRecord(svc)) {
                const res = await known.executeToolViaService(svc, args);
                return sanitizeValue(res);
              }
            }
            // Otherwise delegate to global tool definition if registered
            const currentGlobal = this.readGlobalTools().get(toolName);
            if (currentGlobal) {
              const res = await currentGlobal.execute(args, exec);
              return sanitizeValue(res);
            }
            // Otherwise delegate to generic Cordis service
            if (plugin.bridgeSpec.serviceName) {
              const svc = host?.get?.(plugin.bridgeSpec.serviceName);
              if (isRecord(svc)) {
                const actionName = typeof args.action === 'string' ? args.action : plugin.bridgeSpec.serviceMethod;
                if (actionName && typeof svc[actionName] === 'function') {
                  const res = await (svc[actionName] as (a: unknown) => Promise<unknown>).call(svc, args);
                  return sanitizeValue(res);
                }
                if (typeof svc.operate === 'function') {
                  const res = await (svc.operate as (a: unknown) => Promise<unknown>)(args);
                  return sanitizeValue(res);
                }
              }
            }
            throw new CallerDenied('PLUGIN_UNAVAILABLE', `插件「${plugin.title}」的运行时服务当前不可用。`);
          },
        });
      }
    }

    return definitions;
  }

  /**
   * Render a dynamic System Prompt section describing currently enabled third-party plugins, their Context capabilities, and their injected Native Action Tools.
   */
  renderEnabledPluginsPromptSection(): string {
    const enabledPlugins = this.discoverLocalPlugins().filter(
      p => this.isPluginEnabledFn(p.packageName) && p.available,
    );
    if (enabledPlugins.length === 0) return '';
    const lines: string[] = [
      '## 已启用的 DSH 扩展插件与动态桥接工具',
      '用户在「大肥鱼插件空间」中启用了以下第三方扩展插件，你可以直接通过上下文工具读取其状态，或直接调用其注入的原生控制工具执行读写操作：',
    ];
    for (const plugin of enabledPlugins) {
      const toolPart =
        plugin.actionToolNames.length > 0
          ? `；可直接调用原生读写/控制工具：\`${plugin.actionToolNames.join('`, `')}\``
          : '';
      lines.push(
        `- **${plugin.title}** (\`${plugin.packageName}\`)：可通过 \`dsh_context_query({ capability: "${plugin.capabilityId}" })\` 读取上下文快照${toolPart}。`,
      );
    }
    return lines.join('\n');
  }
}

export function withDynamicPluginContext(
  base: () => ContextService | undefined,
  bridge: () => DynamicPluginBridge | undefined,
): ContextService {
  return {
    catalog(access: ContextAccess): unknown {
      access.assertCurrent();
      const baseService = base();
      const dynamic = bridge();
      const raw = baseService?.catalog(access);
      const synthMap = new Map<string, RegisteredContextCapability>();
      if (dynamic) {
        for (const cap of dynamic.listSynthesizedCapabilities()) {
          synthMap.set(cap.id, cap);
        }
      }

      const resolveCapEntry = (id: string, existing?: unknown) => {
        if (isRecord(existing) && existing.status === 'available') return existing;
        const synth = synthMap.get(id);
        if (synth && access.grants[id] === synth.provider && synth.status === 'available') {
          return {
            protocol: 1,
            id: synth.id,
            source: synth.source,
            provider: synth.provider,
            description: synth.description,
            scope: synth.scope,
            filters: synth.filters ?? null,
            status: 'available' as const,
          };
        }
        return existing ?? { id, status: 'unavailable' as const };
      };

      if (!isRecord(raw) || !Array.isArray(raw.capabilities)) {
        const capabilities = Object.keys(access.grants)
          .sort()
          .map(id => resolveCapEntry(id));
        return {
          status: 'ok',
          protocol: 1,
          workspaceId: access.scope.workspaceId,
          capabilities,
        };
      }

      const seen = new Set<string>();
      const replaced = raw.capabilities.map((item: unknown) => {
        if (isRecord(item) && typeof item.id === 'string') {
          seen.add(item.id);
          return resolveCapEntry(item.id, item);
        }
        return item;
      });

      for (const id of Object.keys(access.grants)) {
        if (!seen.has(id)) {
          replaced.push(resolveCapEntry(id));
        }
      }

      replaced.sort((a: unknown, b: unknown) =>
        String(isRecord(a) ? a.id : '').localeCompare(String(isRecord(b) ? b.id : '')),
      );
      return { ...raw, capabilities: replaced };
    },

    status(grants: ContextAccess['grants']): readonly { id: string; available: boolean }[] {
      const baseService = base();
      const dynamic = bridge();
      const baseStatus = baseService?.status(grants) ?? Object.keys(grants).map(id => ({ id, available: false }));
      if (!dynamic) return baseStatus;
      return baseStatus.map(entry => {
        if (entry.available) return entry;
        if (dynamic.isCapabilityAvailable(entry.id)) {
          return { id: entry.id, available: true };
        }
        return entry;
      });
    },

    listRegistered(): readonly RegisteredContextCapability[] {
      const baseList = base()?.listRegistered?.() ?? [];
      const dynamicList = bridge()?.listSynthesizedCapabilities() ?? [];
      const byId = new Map<string, RegisteredContextCapability>();
      for (const item of baseList) {
        if (item && typeof item.id === 'string') byId.set(item.id, item);
      }
      for (const item of dynamicList) {
        if (item && typeof item.id === 'string' && !byId.has(item.id)) {
          byId.set(item.id, item);
        }
      }
      return [...byId.values()];
    },

    async query(access: ContextAccess, input: unknown): Promise<unknown> {
      access.assertCurrent();
      const dynamic = bridge();
      if (isRecord(input) && typeof input.capability === 'string' && dynamic?.hasCapability(input.capability)) {
        const baseService = base();
        const baseRegistered = baseService?.listRegistered?.() ?? [];
        const hasNativeProvider = baseRegistered.some(r => r.id === input.capability);
        if (!hasNativeProvider) {
          return dynamic.querySynthesizedCapability(access, input);
        }
      }
      const baseService = base();
      if (!baseService) return { status: 'unavailable' };
      return baseService.query(access, input);
    },
  };
}
