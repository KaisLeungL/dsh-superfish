import { canonical } from '../../sessions/origin.js';
import type { ChatModelSelection } from '../health/chat-input.js';
import { scrubSensitiveText } from '../sentinel/scrubber.js';
import type { WorkerObservation, WorkerSessionHost } from './worker-session.js';
import { WorkerCreateRejected } from './worker-session.js';

interface Event { type: string; seq: number; time?: number; data: { reason?: { kind?: string }; message?: { content?: readonly { type: string; text?: string }[] } } }
interface InboxMessage { id: string; source?: { rpcId?: string } }
interface Session { id: string; header: { cwd?: string; agentPreset?: string }; snapshotEvents(): readonly Event[] }
interface Controller {
  create(request: { sessionId: string; workspaceId: string; agentPreset: string }): Promise<{ sessionId: string }>;
  resolveAgent(id: string): Promise<{ agent: { session: Session; inbox: { nextTurn: readonly InboxMessage[]; nextStep: readonly InboxMessage[] }; model: { select(selection: ChatModelSelection): void | Promise<void> } } } | { error: unknown }>;
  rename(request: { sessionId: string; title: string }): Promise<unknown>;
  prompt(request: { requestId: string; sessionId: string; mode: 'queue'; content: readonly { type: 'text'; text: string }[] }, signal: AbortSignal): Promise<{ accepted: true }>;
  state(request: { sessionId: string }, signal: AbortSignal): Promise<{ active: boolean; running: boolean; queue: readonly unknown[] | null; pendingInput: readonly unknown[] }>;
  events(request: { address: { kind: 'session'; sessionId: string }; maxMessages: number }, signal: AbortSignal): Promise<{ records: readonly { type: 'event'; event: Event }[]; cursor: number }>;
  cancel(request: { sessionId: string }): unknown;
  updateQueue(request: { sessionId: string; itemId: string; action: { kind: 'remove' } }): Promise<unknown>;
}

export interface WorkerExecution {
  readonly agentPreset?: string;
  readonly permission?: 'read-only' | 'workspace-write';
  readonly model?: ChatModelSelection;
}

/** 使用大肥鱼配置的执行后端，复用原生工具、文件沙盒和审批。 */
export function nativeWorkerSessionHost(ctx: { get(name: string): unknown }, workspaceId: string, workspacePath: string,
  assertCurrent: (owner: string) => void, execution: WorkerExecution = {}): WorkerSessionHost {
  const executionPreset = execution.agentPreset ?? 'standard';
  const permission = execution.permission ?? 'workspace-write';
  const controller = ctx.get('sessionController') as Controller;
  const presets = ctx.get('agentPresets') as { resolve(id: string): Promise<{ id: string; broken?: string }> };
  const permissions = ctx.get('permissionPresets') as { resolve(name: string): { sandbox: string; approval: string }; set(session: Session, name: string): void };
  const persistence = ctx.get('sessionPersistence') as { stat(id: string): Promise<{ header: Session['header'] } | undefined> };
  const sessions = ctx.get('sessions') as { get(id: string): Session | undefined; flush(session: Session): Promise<boolean> };
  const workspace = (ctx.get('workspaceRegistry') as { get(id: string): { attachSession(id: string): Promise<void> } }).get(workspaceId);
  const current = () => {
    if (canonical(ctx.get('sessionController')) !== canonical(controller) ||
        canonical(ctx.get('agentPresets')) !== canonical(presets) ||
        canonical(ctx.get('permissionPresets')) !== canonical(permissions) ||
        canonical(ctx.get('sessionPersistence')) !== canonical(persistence)) throw Error('WORKER_HOST_CHANGED');
  };
  const assertSession = (header: Session['header']) => {
    if (header.cwd !== workspacePath || header.agentPreset?.startsWith('workspace-superagent-')) throw Error('WORKER_SESSION_SCOPE_MISMATCH');
  };
  const ordinaryPreset = async () => {
    current();
    if (!executionPreset.trim() || executionPreset.startsWith('workspace-superagent-')) throw Error('WORKER_EXECUTION_PRESET_REQUIRED');
    const preset = await presets.resolve(executionPreset);
    if (preset.id !== executionPreset || preset.broken !== undefined) throw Error('WORKER_EXECUTION_PRESET_UNAVAILABLE');
    return preset.id;
  };
  const assertPermission = () => {
    if (permission !== 'read-only' && permission !== 'workspace-write') throw Error('WORKER_PERMISSION_UNAVAILABLE');
    const spec = permissions.resolve(permission);
    if (spec.sandbox !== permission || spec.approval !== 'ask') throw Error('WORKER_PERMISSION_UNAVAILABLE');
  };
  return {
    assertCurrent(owner) { current(); assertCurrent(owner); },
    async exists(id) {
      current(); const found = await persistence.stat(id); current();
      if (!found) return false;
      assertSession(found.header); await workspace.attachSession(id); current(); return true;
    },
    async create(id) {
      let preset: string;
      try {
        preset = await ordinaryPreset(); current();
        assertPermission();
      } catch (error) {
        throw new WorkerCreateRejected(error instanceof Error ? error.message : 'WORKER_PREFLIGHT_REJECTED');
      }
      return controller.create({ sessionId: id, workspaceId, agentPreset: preset });
    },
    async prepare(id, title) {
      current();
      const found = await controller.resolveAgent(id); current();
      if ('error' in found) throw Error('WORKER_SESSION_UNAVAILABLE');
      assertSession(found.agent.session.header);
      assertPermission();
      permissions.set(found.agent.session, permission);
      if (execution.model) await found.agent.model.select(execution.model);
      current();
      await controller.rename({ sessionId: id, title }); current();
      if (await sessions.flush(found.agent.session) !== true) throw Error('WORKER_DURABILITY_REQUIRED');
    },
    async submit(id, requestId, instruction, signal) {
      current(); signal.throwIfAborted();
      const response = await controller.prompt({ requestId, sessionId: id, mode: 'queue', content: [{ type: 'text',
        text: '你是大肥鱼委派的独立执行 Worker。请在当前工作区和宿主授权范围内完成下面的任务，实际执行并验证，汇报结果、证据和未完成项。不要自行扩大任务范围。\n\n' + instruction }] }, signal);
      current(); if (response.accepted !== true) throw Error('WORKER_SUBMIT_UNKNOWN');
    },
    async observe(id, signal): Promise<WorkerObservation> {
      current();
      const state = await controller.state({ sessionId: id }, signal); current();
      const page = await controller.events({ address: { kind: 'session', sessionId: id }, maxMessages: 32 }, signal); current();
      const events = page.records.map(record => record.event);
      const end = events.findLast(event => event.type === 'turn/end');
      const message = events.findLast(event => event.type === 'assistant/message');
      const summary = scrubSensitiveText((message?.data.message?.content ?? []).filter(part => part.type === 'text')
        .map(part => part.text ?? '').join('\n').slice(0, 4000)).text;
      const quiescent = !state.running && Array.isArray(state.queue) && state.queue.length === 0 && state.pendingInput.length === 0;
      const status: WorkerObservation['status'] = state.pendingInput.length ? 'needs_input'
        : state.running || (state.queue?.length ?? 0) > 0 ? 'running'
        : end?.data.reason?.kind === 'completed' ? 'completed'
        : end?.data.reason?.kind === 'aborted' ? 'cancelled'
        : end?.data.reason?.kind === 'blocked' ? 'needs_input'
        : end ? 'failed' : 'unknown';
      return { status, ...(summary ? { summary } : {}), cursor: end?.seq ?? page.cursor, quiescent,
        ...(end?.time ? { observedAt: end.time } : message?.time ? { observedAt: message.time } : {}) };
    },
    async cancel(id, requestId, signal) {
      current(); signal.throwIfAborted();
      const found = await controller.resolveAgent(id); current();
      if ('error' in found) throw Error('WORKER_SESSION_UNAVAILABLE');
      assertSession(found.agent.session.header);
      for (const message of [...found.agent.inbox.nextTurn, ...found.agent.inbox.nextStep]) {
        if (message.source?.rpcId !== requestId) continue;
        signal.throwIfAborted();
        try { await controller.updateQueue({ sessionId: id, itemId: message.id, action: { kind: 'remove' } }); }
        catch (error) { if ((error as { code?: string })?.code !== 'session/queue-item-not-found') throw error; }
        current();
      }
      controller.cancel({ sessionId: id });
    },
  };
}
