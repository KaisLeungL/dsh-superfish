import { mandateExpired } from '../../storage/types.js';
import { BOARD, SCHEDULE_PRESET, type Proposal } from '../../actions/protocol.js';
import { ActionService } from '../../actions/service.js';
import { parseBoardTaskDraft, type TaskParseLlm } from '../../actions/parse-draft.js';
import { GenuiService, type GenuiView, type SuperagentGenuiHostPlugin } from '../../genui/service.js';
import { canonical } from '../../sessions/origin.js';
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { StableSessionOwner } from '../../sessions/origin.js';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import { createRuntime, type NativeBoard, type RuntimeConfig, type RuntimeContext } from '../../sessions/runtime.js';
import { BOARD_CONTEXT, type ContextAccess, type ContextService } from '../../tools/context.js';
import { withSessionContext } from '../../tools/sessions.js';
import { withTodoContext } from '../../tools/todos.js';
import { withMemoryContext } from '../../tools/memory.js';
import { WorkspaceMarkdownLoader } from '../../prompts/soul.js';
import { MemoryService } from '../memory/service.js';
import { MemoryConsolidator } from '../memory/consolidator.js';
import { DynamicSkillRegistry } from '../../skills/dynamic-skills.js';
import { GoalService } from '../goals/service.js';
import { PluginSpaceRegistry } from '../plugins/registry.js';
import { EventMonitor } from '../routines/event-monitor.js';
import { discoverDshOnboardingMemory, importDshOnboardingMemory, type OnboardingSessionBrief } from '../memory/onboarding.js';
import { fingerprint, type StewardStore } from '../../storage/store.js';
import { LifecycleCoordinator, type Dependency } from './coordinator.js';
import { EvalDeadlines } from './evals.js';
import { JobSupervisor } from './jobs.js';
import { capacityBlocks, unavailableHealth, type HealthView } from '../health/view.js';
import { readChatSoul, type ChatSoulConfig } from '../health/chat-input.js';
import { healthRoutes, type HealthConnection, type HealthControl, type HealthWebServer } from '../health/http.js';
import { createDailyMotto, type MottoLlm } from '../health/daily-motto.js';
import { createChatSuggestions } from '../health/suggestions.js';
import { PersonalService } from '../personal/service.js';
import { DelegationService } from '../delegation/service.js';
import { delegationActivities, type ScheduleDeliverySnapshot, type ScheduleTriggerSource } from '../delegation/activity.js';
import type { BoardLaunchFace } from '../delegation/launch.js';
import { delegationTargetRejection } from '../delegation/guard.js';
import type { CapturedTask } from '../projections/types.js';
export interface HostAssembly { readonly store: StewardStore; readonly runtimeConfig: RuntimeConfig; readonly workspaceName?: string; readonly mottoPath?: string; readonly soulPath?: string; readonly contextGrants?: ContextAccess['grants']; readiness?(): string | null }
function readStoredSoul(path: string | undefined): ChatSoulConfig | undefined {
  if (!path) return undefined;
  try {
    const parsed = readChatSoul(JSON.parse(readFileSync(path, 'utf8')));
    return parsed ? { ...parsed, syncSoulMarkdown: true } : undefined;
  }
  catch { return undefined; }
}
function writeStoredSoul(path: string | undefined, soul: ChatSoulConfig): void {
  if (!path) return;
  try {
    const tmp = path + '.' + randomUUID() + '.tmp';
    writeFileSync(tmp, JSON.stringify(soul) + '\n', { mode: 0o600 });
    renameSync(tmp, path);
  } catch { /* 保持内存中的 Soul 配置可用。 */ }
}
/** 只改变原可信policy的修订身份；既有权限/预算每次仍由原来源决定。 */
export function bindLifecyclePolicy(
  current: RuntimeConfig['currentPolicy'],
  coordinator: () => Pick<LifecycleCoordinator, 'generation'> | undefined,
): RuntimeConfig['currentPolicy'] {
  const nonce = randomUUID();
  return agent => {
    const lifecycle = coordinator();
    if (!lifecycle) throw Error('LIFECYCLE_NOT_READY');
    const policy = current(agent);
    return { ...policy, revision: fingerprint({ trustedRevision: policy.revision, lifecycleInstance: nonce, generation: lifecycle.generation }) };
  };
}
/** 只使用可信Host提供的已打开存储；请求不能指定路径、SQL或配置。 */
export function installHealthHost(ctx: Context): void {
  const owner = new StableSessionOwner(ctx as unknown as RuntimeContext);
  ctx.effect(() => () => owner.dispose());
  let active: HealthControl | undefined, lastStore: StewardStore | undefined;
  let failure = '未提供可信Host装配；保留原骨架与会话，不自动创建数据库。';
  const fallback: HealthControl = {
    read() {
      const view = unavailableHealth(failure);
      if (lastStore) {
        try { view.summary = lastStore.readHealthSummary(Date.now()); view.sampledAt = view.summary.sampledAt; view.available = true; }
        catch { /* 已关闭的拥有方存储不另开、不补空。 */ }
      }
      return view;
    },
    revision() { throw Error('HOST_UNAVAILABLE'); }, execute() { throw Error('HOST_UNAVAILABLE'); },
  };
  const routes = healthRoutes(() => ctx.get('connection') as unknown as HealthConnection | undefined, () => active ?? fallback,
    () => ctx.get('webServer') as unknown as HealthWebServer | undefined);
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/workspace-superagent/health',
    methods: ['GET'], requestBody: 'buffered', fetch: routes.read }));
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/workspace-superagent/control',
    methods: ['POST'], requestBody: 'buffered', fetch: routes.control }));
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/workspace-superagent/chat',
    methods: ['POST'], requestBody: 'buffered', fetch: routes.chat }));
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/workspace-superagent/actions',
    methods: ['POST'], requestBody: 'buffered', fetch: routes.actions }));
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/workspace-superagent/genui',
    methods: ['POST'], requestBody: 'buffered', fetch: routes.genui }));
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/workspace-superagent/personal',
    methods: ['GET', 'POST'], requestBody: 'buffered',
    fetch: request => request.method === 'GET' ? routes.personalRead(request) : routes.personalWrite(request) }));
  const stores = new Set<StewardStore>();
  ctx.effect(() => () => {
    for (const store of stores) {
      try { const manager = store.manager(); if (manager.lifecycle === 'running') store.recordLifecycle(manager.revision, 'paused', manager.pin); }
      catch { failure = '暂停持久化未确认；禁止重新准入，保留未决状态。'; }
    }
    stores.clear();
  });
  const required = ['workspaceSuperagentHostConfig', 'agents', 'sessionController', 'sessionPersistence', 'sessions', 'webServer', 'workspaceRegistry', 'agentLoop', 'agentPresets', 'workspaceController'];
  ctx.inject(required, scoped => {
    const assembly = scoped.get('workspaceSuperagentHostConfig') as HostAssembly | undefined;
    if (!assembly || typeof assembly.store?.readHealthSummary !== 'function') { failure = '可信存储或健康摘要能力未提供。'; return; }
    const store = assembly.store; lastStore = store; stores.add(store);
    if ((scoped.get('agentLoop') as { inputAdmissionVersion?: number } | undefined)?.inputAdmissionVersion !== 4) {
      failure = '输入准入能力4未提供；旧能力3不作为当前候选生效。'; return;
    }
    if (store.diagnostics().recoveryPending) store.recover();
    let coordinator: LifecycleCoordinator | undefined;
    const workspaceId = assembly.runtimeConfig.workspaceId;
    const registry = scoped.get('workspaceRegistry') as {
      get(id: string): { path: string; title?: string } | undefined;
      list?(): readonly { id: string; path: string; title?: string }[];
    };
    const workspace = registry.get(workspaceId);
    if (!workspace) { failure = '当前主理工作区不可用。'; return; }
    let runtime: ReturnType<typeof createRuntime>;
    let onBoardUpdated: (() => void) | undefined;
    let board: NativeBoard | undefined;
    scoped.inject(['taskBoard'], boardCtx => {
      board = boardCtx.get('taskBoard') as NativeBoard;
      runtime?.refreshBoard();
      const offBoardSub = typeof board?.subscribe === 'function'
        ? board.subscribe(() => {
            onBoardUpdated?.();
          })
        : undefined;
      boardCtx.effect(() => () => { offBoardSub?.(); board = undefined; runtime?.refreshBoard(); });
    });
    let contextService: ContextService | undefined;
    scoped.inject(['workspaceContext'], contextCtx => {
      contextService = contextCtx.get('workspaceContext') as ContextService;
      contextCtx.effect(() => () => { contextService = undefined; });
    });
    let schedule: unknown;
    scoped.inject(['schedule'], scheduleCtx => {
      schedule = scheduleCtx.get('schedule');
      const syncScheduleStates = () => {
        const sid = store.manager().sessionId;
        if (sid) void drafts.refreshScheduleStates(sid).catch(() => false);
      };
      syncScheduleStates();
      const offChanged = typeof (scheduleCtx as { on?(name: string, fn: () => void): () => void }).on === 'function'
        ? (scheduleCtx as { on(name: string, fn: () => void): () => void }).on('schedule/changed', syncScheduleStates)
        : undefined;
      scheduleCtx.effect(() => () => {
        offChanged?.();
        schedule = undefined;
      });
    });
    let genuiPlugin: SuperagentGenuiHostPlugin | undefined;
    scoped.inject(['superagentGenui'], genuiCtx => {
      genuiPlugin = genuiCtx.get('superagentGenui') as SuperagentGenuiHostPlugin;
      genuiCtx.effect(() => () => { genuiPlugin = undefined; });
    });
    const drafts = new ActionService(store.path + '.actions.sqlite', {
      workspaceId, workspacePath: workspace.path, board: () => board, schedule: () => schedule,
      projects: () => {
        const list = typeof registry.list === 'function' ? registry.list() : [];
        const items = list.map(item => {
          const raw = item.title?.trim() || item.path.split(/[\\/]/).filter(Boolean).at(-1) || item.id;
          return {
            id: item.id,
            label: raw === 'default-workspace' ? '默认工作区' : raw,
          };
        });
        return items.some(item => item.id === workspaceId)
          ? items
          : [{ id: workspaceId, label: assembly.workspaceName || workspace.path.split(/[\\/]/).filter(Boolean).at(-1) || workspaceId }, ...items];
      },
      model: () => assembly.runtimeConfig.model,
      delegate: (sessionId, operationId, taskId) => delegation.start(sessionId, operationId, taskId),
      parseTaskDraft: text => parseBoardTaskDraft(
        scoped.get('llm') as TaskParseLlm | undefined,
        runtime ? runtime.routerModel() : assembly.runtimeConfig.model,
        text,
        mottoLifetime.signal,
      ),
      isLegacyScheduledSession: async targetSessionId => {
        if (!targetSessionId || targetSessionId === store.manager().sessionId) return false;
        if (targetSessionId.startsWith('session-superagent-')) return true;
        try {
          const live = (scoped.get('sessions') as { get?(id: string): { header?: { agentPreset?: string; cwd?: string } } | undefined } | undefined)?.get?.(targetSessionId);
          if (live?.header) {
            return live.header.agentPreset === SCHEDULE_PRESET;
          }
          const persistence = scoped.get('sessionPersistence') as { stat?(id: string): Promise<{ header?: { agentPreset?: string; cwd?: string } } | undefined> } | undefined;
          const stored = await persistence?.stat?.(targetSessionId);
          return stored?.header?.agentPreset === SCHEDULE_PRESET;
        } catch {
          return false;
        }
      },
      cleanupLegacyScheduledSessions: async activeRouterSessionId => {
        try {
          const wsList = typeof registry.list === 'function'
            ? (registry.list() as readonly { id: string; sessionIds?: readonly string[] }[])
            : [];
          const rawArchived = (registry as { archivedSessionIds?: readonly string[] }).archivedSessionIds;
          const archived = new Set<string>(Array.isArray(rawArchived) ? rawArchived : []);
          const archiveFn = (registry as { archiveSession?(id: string): Promise<void> }).archiveSession;
          if (typeof archiveFn !== 'function') return;
          const sessionsHost = scoped.get('sessions') as { get?(id: string): { header?: { agentPreset?: string } } | undefined } | undefined;
          const persistence = scoped.get('sessionPersistence') as { stat?(id: string): Promise<{ header?: { agentPreset?: string } } | undefined> } | undefined;
          for (const ws of wsList) {
            for (const sid of ws.sessionIds ?? []) {
              if (!sid || sid === activeRouterSessionId || archived.has(sid)) continue;
              let isLegacy = sid.startsWith('session-superagent-');
              if (!isLegacy) {
                const live = sessionsHost?.get?.(sid);
                if (live?.header) {
                  isLegacy = live.header.agentPreset === SCHEDULE_PRESET;
                } else {
                  const stored = await persistence?.stat?.(sid).catch(() => undefined);
                  isLegacy = stored?.header?.agentPreset === SCHEDULE_PRESET;
                }
              }
              if (isLegacy) {
                await archiveFn.call(registry, sid).catch(() => undefined);
              }
            }
          }
        } catch {
          // ignore archive cleanup errors
        }
      },
      check() {
        const manager = store.manager(), scope = store.readAuthorizationSnapshot();
        if (assembly.readiness?.() || manager.lifecycle === 'stopped' || manager.workspaceId !== workspaceId ||
            canonical(registry.get(workspaceId)) !== canonical(workspace) ||
            !scope.resources.some(r => scope.policy.resources.includes(r.id) && r.workspaceId === workspaceId && r.repositoryId === workspaceId) ||
            !scope.policy.mandate.actions.includes('read') ||
            mandateExpired(scope.policy.mandate.expiresAt, Date.now())) throw Error('DRAFT_SCOPE_CHANGED');
      },
    });
    scoped.effect(() => () => drafts.close());
    const genuiViews = new GenuiService(store.path + '.genui.sqlite', {
      plugin: () => genuiPlugin,
      check() {
        const manager = store.manager(), scope = store.readAuthorizationSnapshot();
        if (assembly.readiness?.() || manager.lifecycle === 'stopped' || manager.workspaceId !== workspaceId ||
            canonical(registry.get(workspaceId)) !== canonical(workspace) ||
            !scope.resources.some(r => scope.policy.resources.includes(r.id) && r.workspaceId === workspaceId && r.repositoryId === workspaceId) ||
            !scope.policy.mandate.actions.includes('read') ||
            mandateExpired(scope.policy.mandate.expiresAt, Date.now())) throw Error('GENUI_SCOPE_CHANGED');
      },
    });
    scoped.effect(() => () => genuiViews.close());
    const scopeError = () => { throw Error('DELEGATION_SCOPE_CHANGED'); };
    const assertScope = () => {
      const manager = store.manager(), scope = store.readAuthorizationSnapshot();
      if (manager.workspaceId !== workspaceId || canonical(registry.get(workspaceId)) !== canonical(workspace) ||
          !scope.resources.some(r => scope.policy.resources.includes(r.id) && r.workspaceId === workspaceId && r.repositoryId === workspaceId) ||
          !scope.policy.mandate.actions.includes('read') || mandateExpired(scope.policy.mandate.expiresAt, Date.now())) scopeError();
    };
    const boardLaunchFace = (): BoardLaunchFace | undefined => {
      const face = board as {
        durableLaunchReceiptVersion?: unknown;
        startWithReceipt?(request: { operationId: string; taskId: string; workspaceId?: string; initiator: string }): unknown;
        readLaunchReceipt?(request: { operationId: string; taskId: string }): unknown;
      } | undefined;
      if (!face || !runtime.source.isAvailable() || face.durableLaunchReceiptVersion !== 1 ||
          typeof face.startWithReceipt !== 'function' || typeof face.readLaunchReceipt !== 'function') return undefined;
      const start = face.startWithReceipt.bind(face), read = face.readLaunchReceipt.bind(face);
      return {
        durableLaunchReceiptVersion: 1,
        async startWithReceipt(request) {
          if (canonical(board) !== canonical(face) || !runtime.source.isAvailable()) {
            return { state: 'rejected', operationId: request.operationId, taskId: request.taskId, reason: 'BOARD_UNAVAILABLE' };
          }
          const snapshot = (face as NativeBoard).snapshot();
          const rejection = delegationTargetRejection(snapshot, request);
          if (rejection) return rejection;
          const targetTask = snapshot.tasks?.find(item => item.id === request.taskId) as
            | { id: string; permission?: string; permissionConfirmedAt?: unknown }
            | undefined;
          if (
            targetTask &&
            targetTask.permission &&
            targetTask.permission !== 'read-only' &&
            targetTask.permissionConfirmedAt === undefined &&
            typeof (face as { apply?: unknown }).apply === 'function'
          ) {
            try {
              await (face as { apply(opId: string, action: unknown): unknown }).apply(
                `confirm-permission:${request.operationId}`,
                { kind: 'confirm-permission', taskId: request.taskId },
              );
            } catch {
              // ignore if board implementation does not require or support confirm-permission
            }
          }
          const allBoardProjects = (() => { try { return runtimeConfig.currentPolicy(undefined).allBoardProjects === true; } catch { return false; } })();
          return await start({ operationId: request.operationId, taskId: request.taskId, ...(allBoardProjects ? {} : { workspaceId: request.workspaceId }), initiator: request.routerSessionId }) as Awaited<ReturnType<BoardLaunchFace['startWithReceipt']>>;
        },
        async readLaunchReceipt(request) {
          return await read({ operationId: request.operationId, taskId: request.taskId }) as Awaited<ReturnType<BoardLaunchFace['readLaunchReceipt']>>;
        },
      };
    };
    const delegation = new DelegationService(store.path + '.delegation.sqlite', {
      workspaceId,
      assertScope,
      assertCurrent(sessionId) {
        const manager = store.manager();
        if (manager.bindingState !== 'bound' || manager.sessionId !== sessionId || manager.workspaceId !== workspaceId) scopeError();
        assertScope();
      },
      board: boardLaunchFace,
    });
    scoped.effect(() => () => delegation.close());
    const extractDeliveryAssistantSummary = (targetSessionId: string, messageId: string): string | undefined => {
      if (!targetSessionId) return undefined;
      try {
        const sessionsHost = scoped.get('sessions') as {
          get?(id: string): { deriveMessages?(): readonly { id?: string; role?: string; content?: readonly unknown[] }[] } | undefined;
        } | undefined;
        const live = sessionsHost?.get?.(targetSessionId);
        const messages = typeof live?.deriveMessages === 'function' ? live.deriveMessages() : [];
        if (messages.length === 0) return undefined;
        const userIdx = messageId ? messages.findIndex(m => m?.role === 'user' && m.id === messageId) : -1;
        const startIdx = userIdx >= 0 ? userIdx + 1 : 0;
        const parts: string[] = [];
        for (let i = startIdx; i < messages.length; i++) {
          const msg = messages[i];
          if (!msg) continue;
          if (userIdx >= 0 && msg.role === 'user') break;
          if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
          for (const raw of msg.content) {
            if (raw && typeof raw === 'object' && (raw as { type?: unknown }).type === 'text' && typeof (raw as { text?: unknown }).text === 'string') {
              const text = (raw as { text: string }).text.trim();
              if (text) parts.push(text);
            }
          }
        }
        const combined = parts.join('\n').trim();
        return combined ? combined.slice(0, 600) : undefined;
      } catch {
        return undefined;
      }
    };
    const readScheduleTriggers = async (sessionId: string): Promise<ScheduleTriggerSource[]> => {
      const source = schedule as {
        view?(request: { id: string }): Promise<Record<string, unknown>>;
        history?(request: { id: string; limit: number }): Promise<{ records?: readonly Record<string, unknown>[] }>;
      } | undefined;
      if (!source || typeof source.view !== 'function') return [];
      const ids = drafts.ownedScheduleIds(sessionId);
      if (ids.length === 0) return [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<ScheduleTriggerSource[]>(resolve => { timer = setTimeout(() => resolve([]), 2000); });
      try {
        return await Promise.race([
          (async () => {
            const items = await Promise.all(ids.map(async (id): Promise<ScheduleTriggerSource | undefined> => {
              try {
                const entry = await source.view!({ id });
                if (!entry || typeof entry.code === 'string' || typeof entry.id !== 'string') return undefined;
                const historyRes = typeof source.history === 'function'
                  ? await source.history({ id: entry.id, limit: 10 }).catch(() => undefined)
                  : undefined;
                const toDelivery = (raw: unknown): ScheduleDeliverySnapshot | undefined => {
                  if (!raw || typeof raw !== 'object') return undefined;
                  const rec = raw as Record<string, unknown>;
                  if (typeof rec.scheduledAt !== 'string' || typeof rec.deliveredAt !== 'string' || typeof rec.targetSessionId !== 'string') {
                    return undefined;
                  }
                  const messageId = typeof rec.messageId === 'string' ? rec.messageId : rec.deliveredAt;
                  const assistantSummary = extractDeliveryAssistantSummary(rec.targetSessionId, messageId);
                  return {
                    scheduledAt: rec.scheduledAt,
                    deliveredAt: rec.deliveredAt,
                    messageId,
                    targetSessionId: rec.targetSessionId,
                    ...(typeof rec.prompt === 'string' ? { prompt: rec.prompt } : {}),
                    ...(assistantSummary ? { assistantSummary } : {}),
                  };
                };
                const lastDelivery = toDelivery(entry.lastDelivery);
                const deliveries = Array.isArray(historyRes?.records)
                  ? historyRes.records.map(toDelivery).filter((d): d is ScheduleDeliverySnapshot => d !== undefined)
                  : [];
                const targetSessionId = lastDelivery?.targetSessionId;
                const agentStatus = targetSessionId
                  ? (scoped.get('agents') as { get?(id: string): { status?: string } | undefined } | undefined)?.get?.(targetSessionId)?.status
                  : undefined;
                const executionActive = entry.executionActive === true || (typeof agentStatus === 'string' && agentStatus !== 'idle');
                const status = entry.status === 'paused' || entry.status === 'ended' ? entry.status : 'active';
                return {
                  id: entry.id,
                  title: typeof entry.title === 'string' ? entry.title : entry.id,
                  ...(typeof entry.prompt === 'string' ? { prompt: entry.prompt } : {}),
                  status,
                  ...(executionActive ? { executionActive: true } : {}),
                  ...(lastDelivery ? { lastDelivery } : {}),
                  ...(deliveries.length > 0 ? { deliveries } : {}),
                } satisfies ScheduleTriggerSource;
              } catch {
                return undefined;
              }
            }));
            return items.filter((item): item is ScheduleTriggerSource => item !== undefined);
          })(),
          timeout,
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    const personalActivities = async (sessionId: string) => {
      const records = delegation.list(sessionId);
      const unresolved = records.filter(record => record.state === 'unknown');
      if (unresolved.length) {
        // 只对已登记但结果未知的原操作读回执；超时保留 unknown，不重发启动。
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.all(unresolved.map(record => delegation.reconcile(sessionId, record.operationId, record.taskId).catch(() => undefined))),
            new Promise(resolve => { timer = setTimeout(resolve, 2000); }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      const latest = delegation.list(sessionId);
      let tasks: readonly CapturedTask[] = [];
      try { tasks = runtime.source.capture().tasks; } catch { /* 回执本身仍可展示。 */ }
      const scheduleTriggers = await readScheduleTriggers(sessionId).catch(() => []);
      return { available: true, items: delegationActivities(latest, tasks, scheduleTriggers) };
    };
    const personal = new PersonalService(store.path + '.personal.sqlite', {
      workspaceId,
      allBoardProjects: () => {
        try { return runtimeConfig.currentPolicy(undefined).allBoardProjects === true; } catch { return false; }
      },
      sessionId: () => {
        const manager = store.manager();
        return manager.bindingState === 'bound' ? manager.sessionId : null;
      },
      assertCurrent() {
        const manager = store.manager(), scope = store.readAuthorizationSnapshot();
        if (mandateExpired(scope.policy.mandate.expiresAt, Date.now())) throw Error('PERSONAL_AUTH_EXPIRED');
        if ((manager.workspaceId !== null && manager.workspaceId !== workspaceId) || canonical(registry.get(workspaceId)) !== canonical(workspace) ||
            !scope.resources.some(r => scope.policy.resources.includes(r.id) && r.workspaceId === workspaceId && r.repositoryId === workspaceId) ||
            !scope.policy.mandate.actions.includes('read')) throw Error('PERSONAL_SCOPE_CHANGED');
      },
      tasks: () => runtime.source.capture().tasks,
      schedule: () => schedule as { view(request: { id: string }): Promise<never> } | undefined,
      scheduleIds: session => drafts.ownedScheduleIds(session),
      activities: personalActivities,
    });
    scoped.effect(() => () => personal.close());
    const markdownLoader = new WorkspaceMarkdownLoader(workspace.path);
    const assertPersonalScopeCurrent = () => {
      const manager = store.manager(), scope = store.readAuthorizationSnapshot();
      if (mandateExpired(scope.policy.mandate.expiresAt, Date.now())) throw Error('PERSONAL_AUTH_EXPIRED');
      if ((manager.workspaceId !== null && manager.workspaceId !== workspaceId) || canonical(registry.get(workspaceId)) !== canonical(workspace) ||
          !scope.resources.some(r => scope.policy.resources.includes(r.id) && r.workspaceId === workspaceId && r.repositoryId === workspaceId) ||
          !scope.policy.mandate.actions.includes('read')) throw Error('PERSONAL_SCOPE_CHANGED');
    };
    const memory = new MemoryService(store.path + '.memory.sqlite', {
      workspaceId,
      workspacePath: workspace.path,
      globalDbPath: store.path + '.global-memory.sqlite',
      autoRouteGlobalCategories: true,
      assertCurrent: assertPersonalScopeCurrent,
      readUserMemoryMarkdown: () => markdownLoader.readUserMemoryMarkdown(),
    });
    scoped.effect(() => () => memory.close());
    const dynamicSkills = new DynamicSkillRegistry(workspace.path);
    const goals = new GoalService(store.path + '.goals.sqlite', {
      workspaceId,
      assertCurrent: assertPersonalScopeCurrent,
    });
    scoped.effect(() => () => goals.close());
    const memoryConsolidator = new MemoryConsolidator({
      memoryService: memory,
      async listSessions() {
        const wsList = typeof registry.list === 'function'
          ? (registry.list() as readonly { id: string; path: string; title?: string; sessionIds?: readonly string[] }[])
          : [];
        const sessionsHost = scoped.get('sessions') as {
          get?(id: string): {
            id: string;
            header?: Record<string, unknown>;
            deriveMessages?(): readonly { role?: string; content?: readonly unknown[] }[];
          } | undefined;
        } | undefined;
        const managerSessionId = store.manager().sessionId;
        const summaries: { id: string; title: string; status: string; turnCount: number; updatedAt: number; workspacePath?: string }[] = [];
        for (const ws of wsList) {
          for (const sid of ws.sessionIds ?? []) {
            if (!sid || sid === managerSessionId || sid.startsWith('session-superagent-')) continue;
            const live = sessionsHost?.get?.(sid);
            if (!live) continue;
            const messages = typeof live.deriveMessages === 'function' ? live.deriveMessages() : [];
            const turnCount = messages.filter(m => m?.role === 'user').length;
            const rawTitle = typeof live.header?.title === 'string' ? live.header.title.trim() : sid;
            summaries.push({
              id: sid,
              title: rawTitle || sid,
              status: 'completed',
              turnCount,
              updatedAt: Date.now(),
              workspacePath: ws.path,
            });
          }
        }
        return summaries;
      },
      async readSession(sessionId: string) {
        const sessionsHost = scoped.get('sessions') as {
          get?(id: string): {
            id: string;
            header?: Record<string, unknown>;
            deriveMessages?(): readonly { role?: string; content?: readonly unknown[] }[];
          } | undefined;
        } | undefined;
        const live = sessionsHost?.get?.(sessionId);
        if (!live) return undefined;
        const messages = typeof live.deriveMessages === 'function' ? live.deriveMessages() : [];
        const turns: { turnNumber: number; user: { text: string }; assistant?: { text: string } }[] = [];
        let currentTurn = 0;
        for (const msg of messages) {
          if (!msg || !Array.isArray(msg.content)) continue;
          const text = msg.content
            .filter((p): p is { type: 'text'; text: string } => !!p && typeof p === 'object' && (p as { type?: unknown }).type === 'text' && typeof (p as { text?: unknown }).text === 'string')
            .map(p => p.text.trim())
            .filter(Boolean)
            .join('\n');
          if (!text) continue;
          if (msg.role === 'user') {
            currentTurn += 1;
            turns.push({ turnNumber: currentTurn, user: { text } });
          } else if (msg.role === 'assistant' && turns.length > 0) {
            const last = turns[turns.length - 1]!;
            turns[turns.length - 1] = { ...last, assistant: { text } };
          }
        }
        const rawTitle = typeof live.header?.title === 'string' ? live.header.title.trim() : sessionId;
        return {
          session: {
            id: sessionId,
            title: rawTitle || sessionId,
            status: 'completed',
            turnCount: turns.length,
            updatedAt: Date.now(),
          },
          turns,
        };
      },
    });
    const eventMonitor = new EventMonitor({
      goalService: goals,
      async delegateNextBoardTask(taskId: string, operationId: string) {
        const sid = store.manager().sessionId;
        if (!sid) return { state: 'rejected' };
        return delegation.start(sid, operationId, taskId);
      },
    });
    let lastConsolidationAt = 0;
    const syncRuntimeEvents = async (): Promise<void> => {
      try {
        const tasks = runtime?.source.capture().tasks ?? [];
        for (const task of tasks) {
          const lastExec = task.executions.at(-1);
          if (!lastExec) continue;
          if (lastExec.endedAt === null) {
            try {
              goals.onBoardTaskOutcome({ taskId: task.id, status: 'running' });
            } catch { /* ignore */ }
            continue;
          }
          if (lastExec.result === 'succeeded' || lastExec.result === 'failed') {
            await eventMonitor.handleBoardExecutionOutcome({
              taskId: task.id,
              taskTitle: task.title,
              executionId: lastExec.id,
              status: lastExec.result === 'succeeded' ? 'completed' : 'failed',
            }).catch(() => undefined);
          }
        }
      } catch {
        // ignore board snapshot errors
      }
      const now = Date.now();
      if (now - lastConsolidationAt >= 60_000) {
        lastConsolidationAt = now;
        void memoryConsolidator.consolidate({ maxSessions: 10 }).catch(() => undefined);
      }
    };
    onBoardUpdated = () => { void syncRuntimeEvents(); };
    let cachedBaseContext: ContextService | undefined;
    let cachedCompositeContext: ContextService | undefined;
    const resolveContextService = (): ContextService | undefined => {
      if (!contextService && !runtime?.sessionReads?.isAvailable() && !runtime?.todoReads?.isAvailable() && !runtime?.memoryReads?.isAvailable()) return undefined;
      if (cachedBaseContext !== contextService || !cachedCompositeContext) {
        cachedBaseContext = contextService;
        const boundBase = contextService;
        const withSessions = withSessionContext(() => boundBase, () => runtime?.sessionReads);
        const withTodos = withTodoContext(() => withSessions, () => runtime?.todoReads);
        cachedCompositeContext = withMemoryContext(() => withTodos, () => runtime?.memoryReads);
      }
      return cachedCompositeContext;
    };
    const pluginRegistry = new PluginSpaceRegistry({
      filePath: store.path + '.plugins.json',
      baseGrants: assembly.contextGrants ?? BOARD_CONTEXT,
      contextService: () => contextService,
      genuiPlugin: () => genuiPlugin,
      policyRevision: () => {
        try {
          return runtimeConfig.currentPolicy(undefined).revision;
        } catch {
          return `rev-${store.manager().revision}`;
        }
      },
    });
    const initialSoul = readStoredSoul(assembly.soulPath) ?? assembly.runtimeConfig.soul;
    const runtimeConfig: RuntimeConfig = { ...assembly.runtimeConfig, ...(initialSoul ? { soul: initialSoul } : {}), actionDrafts: drafts, genuiViews, board: () => board,
      todos: () => personal.listTodos(),
      todoWrites: {
        listTodos: () => personal.listTodos(),
        createTodo: async (sessionId, input) => {
          const snap = await personal.mutate(sessionId, {
            op: 'create',
            requestId: randomUUID(),
            title: input.title,
            localDate: input.localDate,
            ...(input.boardTaskId ? { boardTaskId: input.boardTaskId } : {}),
          });
          return snap.todos.items;
        },
        updateTodo: async (sessionId, input) => {
          const snap = await personal.mutate(sessionId, {
            op: 'update',
            requestId: randomUUID(),
            id: input.id,
            revision: input.revision,
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.localDate !== undefined ? { localDate: input.localDate } : {}),
            ...(typeof input.done === 'boolean' ? { done: input.done } : {}),
          });
          return snap.todos.items;
        },
      },
      markdownSoul: markdownLoader,
      memory,
      dynamicSkills: () => dynamicSkills,
      goals: () => goals,
      externalConnector: {},
      enableWorkerSandbox: true,
      ...(assembly.contextGrants && {
        context: {
          get grants() {
            return pluginRegistry.hasMutations() ? pluginRegistry.effectiveGrants() : assembly.contextGrants!;
          },
          service: resolveContextService,
        },
      }),
      delegation: { start: (sessionId: string, operationId: string, taskId: string) => delegation.start(sessionId, operationId, taskId) },
      currentPolicy: bindLifecyclePolicy(agent => {
        const base = assembly.runtimeConfig.currentPolicy(agent);
        if (!pluginRegistry.hasMutations()) return base;
        return {
          ...base,
          revision: fingerprint({
            baseRevision: base.revision,
            pluginGrants: pluginRegistry.effectiveGrants(),
          }),
        };
      }, () => coordinator) };
    try { runtime = createRuntime(scoped as unknown as RuntimeContext, store, runtimeConfig, owner); }
    catch { failure = '原生运行时装配失败，保持不可用。'; return; }
    let componentFault: string | null = null;
    const fault = (_error: unknown) => { componentFault = '存在未决组件故障，请核对原件和持久状态。'; };
    const evals = new EvalDeadlines(store, () => { if (!coordinator) throw Error('LIFECYCLE_NOT_READY'); return coordinator.lease(); }, fault);
    const jobs = new JobSupervisor(store, () => { if (!coordinator) throw Error('LIFECYCLE_NOT_READY'); return coordinator.lease(); }, () => {}, fault);
    const dependencies: Dependency[] = required.map(name => ({
      name, current: () => scoped.get(name),
      accepts: value => !!value && (name !== 'agentLoop' || (value as { inputAdmissionVersion?: number }).inputAdmissionVersion === 4),
    }));
    const safeCapacity = () => {
      if (componentFault || capacityBlocks(store.readHealthSummary(Date.now())).length) throw Error('CAPACITY_OR_COMPONENT_UNAVAILABLE');
    };
    const lifecycle = new LifecycleCoordinator(store, dependencies,
      { pause: () => evals.pause(), resume: () => evals.resume(),
        cancel: reason => jobs.cancelAll(reason), dispose() { evals.dispose(); jobs.dispose(); } },
      async operation => { operation.check(); const staged = await runtime.manager.ensure(operation); operation.check(); return staged; },
      () => runtime.dispose(), safeCapacity);
    coordinator = lifecycle;
    try { lifecycle.initialize(); }
    catch { lifecycle.dispose(); failure = '生命周期初始化失败，保持关闭准入。'; return; }
    if (store.manager().sessionId) {
      void drafts.refreshScheduleStates(store.manager().sessionId!).catch(() => false);
    }
    const collectRecentSessions = (): OnboardingSessionBrief[] => {
      try {
        const wsList = typeof registry.list === 'function'
          ? (registry.list() as readonly { id: string; path: string; title?: string; sessionIds?: readonly string[] }[])
          : [];
        const sessionsHost = scoped.get('sessions') as {
          get?(id: string): {
            id: string;
            header?: Record<string, unknown>;
            deriveMessages?(): readonly { role?: string; content?: readonly unknown[] }[];
          } | undefined;
        } | undefined;
        const managerSessionId = store.manager().sessionId;
        const briefs: OnboardingSessionBrief[] = [];
        for (const ws of wsList) {
          for (const sid of ws.sessionIds ?? []) {
            if (!sid || sid === managerSessionId || sid.startsWith('session-superagent-')) continue;
            const live = sessionsHost?.get?.(sid);
            const rawTitle = typeof live?.header?.title === 'string' ? live.header.title.trim() : '';
            const messages = typeof live?.deriveMessages === 'function' ? live.deriveMessages() : [];
            let lastUserText = '';
            for (let i = messages.length - 1; i >= 0; i--) {
              const msg = messages[i];
              if (msg?.role !== 'user' || !Array.isArray(msg.content)) continue;
              const part = msg.content.find(
                (p): p is { type: 'text'; text: string } =>
                  !!p && typeof p === 'object' && (p as { type?: unknown }).type === 'text' && typeof (p as { text?: unknown }).text === 'string',
              );
              if (part?.text.trim()) {
                lastUserText = part.text.trim();
                break;
              }
            }
            const title = rawTitle || lastUserText.slice(0, 36);
            if (!title) continue;
            briefs.push({
              title,
              workspaceTitle: ws.title ?? null,
              turnCount: messages.filter(m => m?.role === 'user').length,
              ...(lastUserText ? { lastUserMessage: lastUserText.slice(0, 120) } : {}),
            });
            if (briefs.length >= 6) break;
          }
          if (briefs.length >= 6) break;
        }
        return briefs;
      } catch {
        return [];
      }
    };
    const buildDiscoveryContext = () => {
      let tasks: readonly CapturedTask[] = [];
      try { tasks = runtime.source.capture().tasks; } catch { /* ignore */ }
      let todos: ReturnType<typeof personal.listTodos> = [];
      try { todos = personal.listTodos(); } catch { /* ignore */ }
      let projects: { path: string; name?: string }[] = [];
      try {
        const wsList = typeof registry.list === 'function'
          ? (registry.list() as readonly { id: string; path: string; title?: string }[])
          : [];
        const nonDefault = wsList.filter(
          ws => typeof ws.path === 'string' && ws.path.trim() && ws.title !== 'default-workspace' && !ws.path.endsWith('/deepseek-harness/default-workspace'),
        );
        const sourceList = nonDefault.length > 0 ? nonDefault : wsList.filter(ws => typeof ws.path === 'string' && ws.path.trim());
        projects = sourceList.map(ws => ({ path: ws.path, ...(ws.title ? { name: ws.title } : {}) }));
      } catch { /* ignore */ }
      return {
        workspacePath: workspace.path,
        ...(assembly.workspaceName ? { workspaceName: assembly.workspaceName } : {}),
        ...(projects.length > 0 ? { projects } : {}),
        tasks,
        todos,
        recentSessions: collectRecentSessions(),
      };
    };
    const isDailyReviewConfigured = (): boolean => {
      const session = store.manager().sessionId;
      if (!session) return false;
      try { return drafts.hasDailyReviewSchedule(session); }
      catch { return false; }
    };
    const chat = () => {
      const manager = store.manager(), agent = manager.sessionId && owner.owned(store, manager.sessionId);
      const reason = assembly.readiness?.() ?? componentFault;
      const boundSessionId = manager.bindingState === 'bound' ? manager.sessionId : null;
      return {
        sessionId: boundSessionId,
        ready: !!agent && manager.lifecycle !== 'stopped' && !reason && lifecycle.checkDependencies() && runtime.isPublished(agent),
        reason,
        workspace: assembly.workspaceName ?? '',
        model: runtime.routerModel(),
        soul: runtime.routerSoul(),
        dailyReviewConfigured: isDailyReviewConfigured(),
        onboardingDiscovery: discoverDshOnboardingMemory(buildDiscoveryContext()),
      };
    };
    const read = (): HealthView => {
      const automation = lifecycle.status(), summary = store.readHealthSummary(Date.now());
      const readiness = assembly.readiness?.() ?? null;
      const grants = pluginRegistry.hasMutations() ? pluginRegistry.effectiveGrants() : assembly.contextGrants;
      const contextSources = grants && (resolveContextService()?.status(grants) ?? Object.keys(grants).map(id => ({ id, available: false })));
      return { ...unavailableHealth('', summary.sampledAt), available: true, reason: componentFault ?? readiness,
        summary, automation, dependencies: lifecycle.dependencyStatus(), contextSources,
        handles: { evalTimers: evals.handles(), jobs: jobs.handles() },
        capacityBlocks: [...capacityBlocks(summary), ...(componentFault ? [componentFault] : [])],
        control: { enabled: true, reason: readiness }, chat: chat() };
    };
    const assertChatCurrent = (sessionId: string, caller: Parameters<NonNullable<HealthControl['send']>>[3]) => {
      caller.assertCurrent();
      const state = chat();
      if (state.sessionId !== sessionId) throw Error('CHAT_SESSION_CHANGED');
      if (!state.ready) throw Error('CHAT_NOT_CONNECTED');
      safeCapacity();
    };
    const mottoLifetime = new AbortController();
    const dailyMotto = assembly.mottoPath && createDailyMotto(assembly.mottoPath, mottoLifetime.signal);
    const chatSuggestions = createChatSuggestions(store.path + '.suggestions.json', mottoLifetime.signal);
    const control: HealthControl = { read, revision: () => store.manager().revision,
      async dailyMotto() {
        if (!dailyMotto || !chat().ready) return null;
        let pendingTodoCount = 0;
        try { pendingTodoCount = personal.listTodos().filter(t => !t.done).length; } catch { /* ignore */ }
        return dailyMotto(scoped.get('llm') as MottoLlm | undefined, runtime.routerModel(), {
          soul: runtime.routerSoul(),
          pendingTodoCount,
        });
      },
      async suggestions(dismiss) {
        if (!chat().ready) return null;
        const currentSessionId = store.manager().sessionId;
        const recentUserMessages: string[] = [];
        let lastAssistantReply = '';
        if (currentSessionId) {
          await drafts.refreshScheduleStates(currentSessionId).catch(() => false);
          try {
            const sessionsHost = scoped.get('sessions') as {
              get?(id: string): { deriveMessages?(): readonly { role?: string; content?: readonly unknown[] }[] } | undefined;
            } | undefined;
            const live = sessionsHost?.get?.(currentSessionId);
            const messages = typeof live?.deriveMessages === 'function' ? live.deriveMessages() : [];
            for (let i = messages.length - 1; i >= 0; i--) {
              const msg = messages[i];
              if (!msg || !Array.isArray(msg.content)) continue;
              const textParts = msg.content
                .filter(
                  (p): p is { type: 'text'; text: string } =>
                    !!p && typeof p === 'object' && (p as { type?: unknown }).type === 'text' && typeof (p as { text?: unknown }).text === 'string',
                )
                .map(p => p.text.trim())
                .filter(Boolean);
              if (textParts.length === 0) continue;
              const combined = textParts.join('\n');
              if (msg.role === 'user' && recentUserMessages.length < 8) {
                recentUserMessages.push(combined.slice(0, 120));
              } else if (msg.role === 'assistant' && !lastAssistantReply) {
                lastAssistantReply = combined.slice(-320);
              }
            }
          } catch { /* ignore */ }
        }
        let memories: ReturnType<typeof memory.listMemories> = [];
        try { memories = memory.listMemories(); } catch { /* ignore */ }
        const discoveryCtx = buildDiscoveryContext();
        return chatSuggestions(scoped.get('llm') as MottoLlm | undefined, runtime.routerModel(), {
          dailyReviewConfigured: isDailyReviewConfigured(),
          soul: runtime.routerSoul(),
          memories,
          todos: discoveryCtx.todos,
          tasks: discoveryCtx.tasks,
          recentSessions: discoveryCtx.recentSessions,
          ...(recentUserMessages.length > 0 ? { recentUserMessages } : {}),
          ...(lastAssistantReply ? { lastAssistantReply } : {}),
          ...(dismiss ? { dismiss } : {}),
        });
      },
      execute(action, revision, proofRef, caller) {
        caller.assertCurrent();
        if (store.manager().revision !== revision) throw Error('REVISION_CONFLICT');
        if (action === 'reconcile') return runtime.reconcileAllAudit(caller.signal, caller.assertCurrent);
        if (action === 'resume' && assembly.readiness?.()) throw Error('HOST_MODEL_OR_MANDATE_REQUIRED');
        if (action === 'pause') lifecycle.pause();
        else if (action === 'stop') lifecycle.stop();
        else return lifecycle.resume(revision, proofRef, caller);
      },
      reset(revision, proofRef, caller) {
        caller.assertCurrent();
        if (store.manager().revision !== revision) throw Error('REVISION_CONFLICT');
        lifecycle.pause('受信人工重置');
        store.resetManagerBinding(store.manager().revision, proofRef);
        try { memory.clearAll(); } catch { /* ignore */ }
        try { goals.clearAll(); } catch { /* ignore */ }
        try { personal.clearAll(); } catch { /* ignore */ }
        try { drafts.clearAll(); } catch { /* ignore */ }
        try { genuiViews.clearAll(); } catch { /* ignore */ }
        try { markdownLoader.clearGeneratedMarkdown(); } catch { /* ignore */ }
        try { chatSuggestions.clear?.(); } catch { /* ignore */ }
        try { pluginRegistry.clearAll(); } catch { /* ignore */ }
        for (const p of [assembly.soulPath, assembly.mottoPath, store.path + '.suggestions.json']) {
          if (p) {
            try { unlinkSync(p); } catch { /* ignore */ }
          }
        }
      },
      async connect(revision, proofRef, caller, options) {
        caller.assertCurrent();
        if (store.manager().revision !== revision) throw Error('REVISION_CONFLICT');
        const state = chat();
        if (state.reason) throw Error('HOST_MODEL_OR_MANDATE_REQUIRED');
        if (options?.model) {
          await runtime.presetRouterModel(options.model, caller.signal);
          caller.assertCurrent();
        }
        if (options?.soul) {
          const nextSoul: ChatSoulConfig = { ...options.soul, syncSoulMarkdown: true };
          runtime.selectRouterSoul(nextSoul);
          writeStoredSoul(assembly.soulPath, nextSoul);
          markdownLoader.syncWorkspaceSoulMarkdown(nextSoul);
        }
        if (options?.onboardingMemory || options?.soul) {
          try {
            importDshOnboardingMemory(memory, buildDiscoveryContext(), options?.onboardingMemory, options?.soul);
          } catch { /* 记忆预热异常不阻断主理连接 */ }
        }
        if (!state.ready || store.manager().lifecycle === 'paused') {
          await lifecycle.connect(revision, proofRef, caller);
        }
        if (store.manager().sessionId) {
          void drafts.refreshScheduleStates(store.manager().sessionId!).catch(() => false);
        }
        if (options?.model) {
          const next = chat();
          if (next.ready && next.sessionId) {
            await runtime.selectRouterModel(options.model, caller.signal, () => assertChatCurrent(next.sessionId!, caller));
          }
        }
      },
      async send(sessionId, requestId, text, caller) {
        assertChatCurrent(sessionId, caller);
        await drafts.refreshScheduleStates(sessionId).catch(() => false);
        await syncRuntimeEvents().catch(() => undefined);
        assertChatCurrent(sessionId, caller);
        await runtime.submitRouterInput(text, caller.signal, { requestId, assertCurrent: () => assertChatCurrent(sessionId, caller) });
      },
      async sendContent(sessionId, requestId, content, caller) {
        assertChatCurrent(sessionId, caller);
        await drafts.refreshScheduleStates(sessionId).catch(() => false);
        await syncRuntimeEvents().catch(() => undefined);
        assertChatCurrent(sessionId, caller);
        await runtime.submitRouterInput(content, caller.signal, { requestId, assertCurrent: () => assertChatCurrent(sessionId, caller) });
      },
      async actions(sessionId, value, caller) {
        const assertCurrent = () => assertChatCurrent(sessionId,caller);
        assertCurrent();
        return await drafts.handle(sessionId,value,assertCurrent);
      },
      async genui(sessionId, value, caller) {
        const assertCurrent = () => assertChatCurrent(sessionId, caller);
        assertCurrent();
        return await genuiViews.handle(sessionId, value, assertCurrent);
      },
      async personalRead(caller) {
        caller.assertCurrent();
        const session = store.manager().sessionId;
        if (!session) throw Error('CHAT_SESSION_CHANGED');
        await drafts.refreshScheduleStates(session).catch(() => false);
        await syncRuntimeEvents().catch(() => undefined);
        caller.assertCurrent();
        const result = await personal.read(session);
        caller.assertCurrent();
        let memItems: ReturnType<typeof memory.listMemories> = [];
        let memCounts: ReturnType<typeof memory.counts> | undefined;
        try {
          memItems = memory.listMemories('all');
          memCounts = memory.counts(memItems);
        } catch { /* ignore */ }
        let skillItems: ReturnType<typeof dynamicSkills.listSkillDetails> = [];
        try {
          skillItems = dynamicSkills.listSkillDetails('all', true);
        } catch { /* ignore */ }
        let goalItems: ReturnType<typeof goals.listGoals> = [];
        try {
          goalItems = goals.listGoals();
        } catch { /* ignore */ }
        return {
          ...result,
          memories: {
            available: true,
            items: memItems,
            ...(memCounts ? { counts: memCounts } : {}),
          },
          skills: {
            available: true,
            items: skillItems,
          },
          goals: {
            available: true,
            items: goalItems,
          },
          plugins: pluginRegistry.snapshot(),
        };
      },
      async personalWrite(sessionId, value, caller) {
        caller.assertCurrent();
        const enrichPersonalResult = (base: Awaited<ReturnType<typeof personal.read>>) => {
          let memItems: ReturnType<typeof memory.listMemories> = [];
          let memCounts: ReturnType<typeof memory.counts> | undefined;
          try {
            memItems = memory.listMemories('all');
            memCounts = memory.counts(memItems);
          } catch { /* ignore */ }
          let skillItems: ReturnType<typeof dynamicSkills.listSkillDetails> = [];
          try {
            skillItems = dynamicSkills.listSkillDetails('all', true);
          } catch { /* ignore */ }
          let goalItems: ReturnType<typeof goals.listGoals> = [];
          try {
            goalItems = goals.listGoals();
          } catch { /* ignore */ }
          return {
            ...base,
            memories: {
              available: true,
              items: memItems,
              ...(memCounts ? { counts: memCounts } : {}),
            },
            skills: {
              available: true,
              items: skillItems,
            },
            goals: {
              available: true,
              items: goalItems,
            },
            plugins: pluginRegistry.snapshot(),
          };
        };
        const req = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
        if (req?.op === 'plugin.toggle') {
          const targetSession = store.manager().sessionId || sessionId;
          if (!targetSession) throw Error('CHAT_SESSION_CHANGED');
          const id = typeof req.id === 'string' ? req.id.trim() : '';
          if (!id || typeof req.enabled !== 'boolean') throw Error('PLUGIN_INVALID');
          pluginRegistry.togglePlugin(id, req.enabled);
          const base = await personal.read(targetSession);
          caller.assertCurrent();
          return enrichPersonalResult(base);
        }
        if (req?.op === 'plugin.register') {
          const targetSession = store.manager().sessionId || sessionId;
          if (!targetSession) throw Error('CHAT_SESSION_CHANGED');
          const packageName = typeof req.packageName === 'string' ? req.packageName.trim() : '';
          const capabilityId = typeof req.capabilityId === 'string' ? req.capabilityId.trim() : '';
          const title = typeof req.title === 'string' ? req.title.trim() : undefined;
          const description = typeof req.description === 'string' ? req.description.trim() : undefined;
          pluginRegistry.registerManualPlugin({
            packageName,
            capabilityId,
            ...(title ? { title } : {}),
            ...(description ? { description } : {}),
          });
          const base = await personal.read(targetSession);
          caller.assertCurrent();
          return enrichPersonalResult(base);
        }
        if (req?.op === 'plugin.remove') {
          const targetSession = store.manager().sessionId || sessionId;
          if (!targetSession) throw Error('CHAT_SESSION_CHANGED');
          const id = typeof req.id === 'string' ? req.id.trim() : '';
          if (!id) throw Error('PLUGIN_INVALID');
          pluginRegistry.removeManualPlugin(id);
          const base = await personal.read(targetSession);
          caller.assertCurrent();
          return enrichPersonalResult(base);
        }
        if (req?.op === 'memory.save') {
          if (!sessionId || store.manager().sessionId !== sessionId) throw Error('CHAT_SESSION_CHANGED');
          const category = typeof req.category === 'string' ? req.category : 'preference';
          const title = typeof req.title === 'string' ? req.title.trim() : '';
          const content = typeof req.content === 'string' ? req.content.trim() : '';
          if (!title || !content) throw Error('PERSONAL_INVALID');
          memory.saveMemory(sessionId, {
            ...(typeof req.id === 'string' && req.id.trim() ? { id: req.id.trim() } : {}),
            category: category as Parameters<typeof memory.saveMemory>[1]['category'],
            title,
            content,
            ...(typeof req.pinned === 'boolean' ? { pinned: req.pinned } : {}),
            ...(req.scope === 'global' || req.scope === 'workspace' ? { scope: req.scope } : {}),
            ...(Array.isArray(req.tags) ? { tags: req.tags.filter((t): t is string => typeof t === 'string') } : {}),
          });
          const base = await personal.read(sessionId);
          caller.assertCurrent();
          return enrichPersonalResult(base);
        }
        if (req?.op === 'memory.delete') {
          if (!sessionId || store.manager().sessionId !== sessionId) throw Error('CHAT_SESSION_CHANGED');
          if (typeof req.id !== 'string' || !req.id.trim()) throw Error('PERSONAL_INVALID');
          memory.deleteMemory(req.id.trim());
          const base = await personal.read(sessionId);
          caller.assertCurrent();
          return enrichPersonalResult(base);
        }
        if (req?.op === 'skill.delete') {
          if (!sessionId || store.manager().sessionId !== sessionId) throw Error('CHAT_SESSION_CHANGED');
          if (typeof req.slug !== 'string' || !req.slug.trim()) throw Error('PERSONAL_INVALID');
          const scope = req.scope === 'global' || req.scope === 'workspace' ? req.scope : undefined;
          dynamicSkills.deleteSkill(req.slug.trim(), scope);
          const base = await personal.read(sessionId);
          caller.assertCurrent();
          return enrichPersonalResult(base);
        }
        if (req?.op === 'goal.delete') {
          const targetSession = store.manager().sessionId || sessionId;
          if (!targetSession) throw Error('CHAT_SESSION_CHANGED');
          const id = typeof req.id === 'string' && req.id.trim()
            ? req.id.trim()
            : typeof req.goalId === 'string'
              ? req.goalId.trim()
              : '';
          if (!id) throw Error('GOAL_INVALID');
          const existingGoal = goals.getGoal(id);
          await drafts.deleteBoardTasksForGoal(
            existingGoal ?? {
              ...(typeof req.title === 'string' ? { title: req.title } : {}),
              ...(Array.isArray(req.milestones)
                ? {
                    milestones: req.milestones.filter(
                      (m): m is { title?: string; boardTaskId?: string | null } => !!m && typeof m === 'object',
                    ),
                  }
                : {}),
            },
          ).catch(() => []);
          goals.deleteGoal(id);
          const base = await personal.read(targetSession);
          caller.assertCurrent();
          return enrichPersonalResult(base);
        }
        if (req?.op === 'goal.status') {
          const targetSession = store.manager().sessionId || sessionId;
          if (!targetSession) throw Error('CHAT_SESSION_CHANGED');
          const id = typeof req.id === 'string' && req.id.trim()
            ? req.id.trim()
            : typeof req.goalId === 'string'
              ? req.goalId.trim()
              : '';
          const status = req.status;
          if (!id || (status !== 'active' && status !== 'paused' && status !== 'completed' && status !== 'failed')) {
            throw Error('GOAL_INVALID');
          }
          if (goals.getGoal(id)) {
            goals.updateGoalStatus(id, status);
          }
          const base = await personal.read(targetSession);
          caller.assertCurrent();
          return enrichPersonalResult(base);
        }
        if (req?.op === 'goal.ensure_board_task') {
          if (!sessionId || store.manager().sessionId !== sessionId) throw Error('CHAT_SESSION_CHANGED');
          const rawBoardTaskId = typeof req.boardTaskId === 'string' ? req.boardTaskId.trim() : '';
          const goalId = typeof req.goalId === 'string' ? req.goalId.trim() : '';
          const milestoneId = typeof req.milestoneId === 'string' ? req.milestoneId.trim() : '';
          const goal = goalId ? goals.getGoal(goalId) : undefined;
          const ms = goal?.milestones.find(m => m.id === milestoneId) ?? goal?.milestones.find(m => m.boardTaskId === rawBoardTaskId);
          const resolvedTaskId = await drafts.ensureBoardTaskConfirmed(
            sessionId,
            rawBoardTaskId || ms?.boardTaskId || '',
            ms
              ? {
                  title: ms.title,
                  description: goal?.description || ms.title,
                  prompt: goal?.description ? `${ms.title}\n\n所属长周期目标：${goal.title}\n${goal.description}` : ms.title,
                  ...(ms.agentPreset ? { mode: ms.agentPreset } : {}),
                }
              : typeof req.title === 'string' && req.title.trim()
                ? { title: req.title.trim() }
                : undefined,
          );
          if (resolvedTaskId && goal && ms && resolvedTaskId !== ms.boardTaskId) {
            goals.updateMilestone({
              goalId: goal.id,
              milestoneId: ms.id,
              boardTaskId: resolvedTaskId,
            });
          }
          const base = await personal.read(sessionId);
          caller.assertCurrent();
          return {
            ...enrichPersonalResult(base),
            ...(resolvedTaskId ? { resolvedTaskId } : {}),
          };
        }
        const result = await personal.mutate(sessionId, value);
        caller.assertCurrent();
        return enrichPersonalResult(result);
      },
      async selectModel(sessionId, model, caller) {
        assertChatCurrent(sessionId, caller);
        await runtime.selectRouterModel(model, caller.signal, () => assertChatCurrent(sessionId, caller));
      },
      async selectSoul(sessionId, soul, caller, onboardingMemory) {
        assertChatCurrent(sessionId, caller);
        const nextSoul: ChatSoulConfig = { ...soul, syncSoulMarkdown: true };
        runtime.selectRouterSoul(nextSoul);
        writeStoredSoul(assembly.soulPath, nextSoul);
        markdownLoader.syncWorkspaceSoulMarkdown(nextSoul);
        if (onboardingMemory) {
          try {
            importDshOnboardingMemory(memory, buildDiscoveryContext(), onboardingMemory, nextSoul);
          } catch { /* ignore */ }
        }
      } };
    active = control;
    const offResolveScheduleAgent = typeof (scoped as { on?(name: string, fn: (sessionId: unknown, next: () => Promise<unknown>) => Promise<unknown>): () => void }).on === 'function'
      ? (scoped as { on(name: string, fn: (sessionId: unknown, next: () => Promise<unknown>) => Promise<unknown>): () => void }).on('schedule/resolve-agent', async (sessionId, next) => {
          if (typeof sessionId === 'string' && sessionId === store.manager().sessionId) {
            const existing = owner.owned(store, sessionId);
            if (existing && runtime?.isPublished(existing)) return existing;
            if (store.manager().bindingState === 'bound' && store.manager().lifecycle === 'paused' && !assembly.readiness?.() && coordinator) {
              try {
                await coordinator.resume(store.manager().revision, 'schedule-resolve-auto-resume', {
                  signal: mottoLifetime.signal,
                  assertCurrent() { mottoLifetime.signal.throwIfAborted(); },
                });
              } catch { /* fallback below */ }
              const resumed = owner.owned(store, sessionId);
              if (resumed && runtime?.isPublished(resumed)) return resumed;
            }
          }
          return typeof next === 'function' ? next() : undefined;
        })
      : undefined;
    if (store.manager().bindingState === 'bound' && store.manager().lifecycle === 'paused' && !assembly.readiness?.()) {
      void lifecycle.resume(store.manager().revision, 'host-startup-auto-resume', {
        signal: mottoLifetime.signal,
        assertCurrent() { mottoLifetime.signal.throwIfAborted(); },
      }).then(() => {
        const sid = store.manager().sessionId;
        if (sid) void drafts.refreshScheduleStates(sid).catch(() => false);
        void runtime.reconcileAllAudit(mottoLifetime.signal, () => { mottoLifetime.signal.throwIfAborted(); }).catch(() => {});
      }).catch(() => {});
    } else {
      void runtime.reconcileAllAudit(mottoLifetime.signal, () => { mottoLifetime.signal.throwIfAborted(); }).catch(() => {});
    }
    // Host私有服务，未注册模型工具或外部任意计算入口。
    scoped.provide('workspaceSuperagentLifecycle', { coordinator: lifecycle, jobs, evals, memoryConsolidator, eventMonitor });
    scoped.effect(() => async () => {
      offResolveScheduleAgent?.();
      mottoLifetime.abort();
      if (active === control) active = undefined;
      try { await lifecycle.dispose('detach'); }
      finally { coordinator = undefined; failure = '依赖已卸载或替换；保留持久状态，需要人工恢复。'; }
    });
  });
}
