import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LifecycleCoordinator } from '../../src/app/lifecycle/coordinator.js';
import { CallerDenied } from '../../src/tools/authority.js';
import { StewardStore } from '../../src/storage/store.js';
import { InstallationError, InstallationOperation } from '../../src/sessions/installation.js';
import { StableSessionOwner } from '../../src/sessions/origin.js';
import { createRuntime, type NativeAgent, type RuntimeContext } from '../../src/sessions/runtime.js';

// 公开接缝等价适配；不宣称这些对象是原生 SDK、Host 或 browser。
function fixture(t: TestContext, autoCleanup = true) {
  const dir = process.env.F84_TEST_ROOT!;
  assert.ok(dir?.includes('/.superagent-product-lab/b04-f8-product/')); mkdirSync(dir, { recursive: true });
  const store = StewardStore.initializeFresh(resolve(dir, randomUUID() + '.sqlite'), { instanceId: randomUUID(), domainId: 'f84-runtime-adapter' });
  store.registerResource('board', { workspaceId: 'W', repositoryId: 'W' });
  store.appendPolicy(0, { resources: ['board'], audiences: [], mandate: { actions: ['read'], expiresAt: Date.now() + 60000 }, proofRef: 'component-fixture' });
  const registry = new Map<string, NativeAgent>(), sessions = new Map<string, NativeAgent['session']>();
  const calls = { create: 0, dispose: 0, mount: 0, attach: 0, pin: 0 };
  const hooks = new Map<string, ((...args: unknown[]) => unknown)[]>();
  const noop = () => {}; let policyRevision = 'one', policyMaxTokens = 10, policyRead: () => void = noop; let restrictCleanup: () => void | Promise<void> = noop, guardCleanup: () => void | Promise<void> = noop; let globalReleased = 0;
  const ctx = {
    get: (name: string) => services[name], provide: (name: string, value: unknown) => { services[name] = value; },
    on(name: string, callback: (...args: unknown[]) => unknown) { const list = hooks.get(name) ?? []; hooks.set(name, list); list.push(callback); return () => { if (name === 'session/event') globalReleased++; }; },
    effect() {}, tools: { register: () => noop, restrict: () => () => restrictCleanup(), guard: () => () => guardCleanup() }, systemPrompt: { section: () => noop },
  } as unknown as RuntimeContext;
  let selected: () => Promise<void> = async () => {}, maintenance: () => void = noop, agent: NativeAgent | undefined;
  const workspace = { id: 'W', path: process.cwd(), sessionIds: [] as string[], async attachSession(id: string) { calls.attach++; workspace.sessionIds.push(id); } };
  let currentWorkspace = workspace;
  const persistence = { identity: Symbol('first'), async stat() { throw Error('UNEXPECTED_AUDIT_READ'); }, async open(id: string) { return { header: sessions.get(id)!.header, inheritedEventCount: 0, async close() {} }; } };
  const services: Record<string, unknown> = {
    agents: {
      get: (id: string) => registry.get(id), roots: () => [...registry.values()],
      async create(request: { sessionId: string; meta: object; setup(context: RuntimeContext, agent: NativeAgent): Promise<void> }) {
        calls.create++;
        const candidate = {
          id: request.sessionId, ctx, session: { id: request.sessionId, header: { id: request.sessionId, version: 4, ...request.meta }, inheritedEventCount: 0, seq: 0 },
          status: 'idle', inputAdmissionVersion: 4, requireInputAdmission() {},
          inbox: { nextTurn: [], nextStep: [] }, model: { select: () => selected() },
          async runMaintenance(callback: (signal: AbortSignal) => Promise<void>) { maintenance(); return callback(new AbortController().signal); },
        } as unknown as NativeAgent;
        await request.setup(ctx, candidate); registry.set(candidate.id, candidate); sessions.set(candidate.id, candidate.session); agent = candidate;
        for (const listener of hooks.get('agent/created') ?? []) listener({ agent: candidate, source: 'startup' });
        return { agent: candidate, async dispose() { calls.dispose++; registry.delete(candidate.id); sessions.delete(candidate.id); } };
      },
    },
    sessions: { get: (id: string) => sessions.get(id), async flush() { return true; } },
    agentPresets: { async mount() { calls.mount++; } }, agentLoop: { inputAdmissionVersion: 4 },
    sessionController: {
      async state() {}, async events() { return { records: [], cursor: 0 }; },
      async resolveAgent(id: string) { return { agent: registry.get(id) }; },
    },
    workspaceRegistry: { get: () => currentWorkspace, list: () => [currentWorkspace], async pinSession() { calls.pin++; } },
    workspaceController: { async *follow() { yield { type: 'baseline', value: { pinnedSessionIds: [agent!.id] } }; } },
    sessionPersistence: persistence,
    taskBoard: {
      snapshot: () => ({ revision: 0, tasks: [] }), subscribe: () => noop, isExtensionEnabled: () => true,
      registerExtension(extension: { start(host: unknown): void }) { extension.start({ events: { onTaskDeleted: () => noop } }); return noop; },
    },
  };
  const owner = new StableSessionOwner(ctx);
  const runtime = createRuntime(ctx, store, { identity: store.identity, workspaceId: 'W', model: { provider: 'fixture', model: 'fixture' },
    currentPolicy: () => { policyRead(); return { revision: policyRevision, backend: 'native', resources: ['board'], tools: ['steward_list_tasks', 'steward_list_todos', 'steward_list_sessions'], actions: ['read'], audiences: [], maxTokens: policyMaxTokens }; },
    defaultPermission: () => 'read-only', auditReplay: { id: 'installation-only-fixture', validate() { throw Error('UNEXPECTED_AUDIT_READ'); }, describe() { throw Error('UNEXPECTED_AUDIT_READ'); } } }, owner);
  if (autoCleanup) t.after(async () => { await runtime.dispose(); await owner.dispose(); store.close(); });
  const operation = () => new InstallationOperation(store, new AbortController().signal, noop);
  return { store, calls, runtime, owner, operation, persistence, hooks, services, agent: () => agent!,
    policyRevision: (revision: string) => { policyRevision = revision; }, policyMaxTokens: (maxTokens: number) => { policyMaxTokens = maxTokens; }, policyRead: (callback: () => void) => { policyRead = callback; },
    restrictCleanup: (cleanup: () => void | Promise<void>) => { restrictCleanup = cleanup; }, guardCleanup: (cleanup: () => void | Promise<void>) => { guardCleanup = cleanup; }, globalReleased: () => globalReleased,
    replaceWorkspace: () => { currentWorkspace = { ...workspace }; },
    maintenance: (callback: () => void) => { maintenance = callback; },
    select: (callback: () => Promise<void>) => { selected = callback; } };
}
test('等价 runtime 安装合法正例经维护、持久头、被动观察与 Pin', async t => {
  const f = fixture(t), op = f.operation(), staged = await f.runtime.manager.ensure(op);
  op.preflight(staged); op.commit(staged);
  assert.equal(f.runtime.isPublished(f.agent()), true);
  assert.deepEqual(f.calls, { create: 1, dispose: 0, mount: 1, attach: 1, pin: 1 });
});
test('旧会话使用更高的模型默认额度时，按本次实际请求的额度放行', async t => {
  const f = fixture(t), op = f.operation(), staged = await f.runtime.manager.ensure(op);
  op.preflight(staged); op.commit(staged);
  const agent = f.agent(), signal = new AbortController().signal, requestId = randomUUID();
  const message = { id: randomUUID(), source: { kind: 'user', rpcId: requestId }, content: [{ type: 'text', text: '续聊' }] };
  Object.assign(agent, { options: { maxTokens: 10 } });
  Object.assign(agent.session, {
    deriveMessages: () => [],
    requestHeader: () => ({ config: { maxTokens: 256000 }, adapterDefaults: { maxTokens: true } }),
  });
  f.services.llm = { async resolveModelInfo() { return { defaultMaxTokens: 256000 }; } };
  Object.assign(f.services.sessionController as object, { async prompt() { return { accepted: true }; } });
  await f.runtime.submitRouterInput('续聊', signal, { requestId, assertCurrent() {} });
  const [claim] = f.hooks.get('agent/pre-claim')!;
  const [request] = f.hooks.get('agent/request')!;
  const [step] = f.hooks.get('agent/pre-step')!;
  const payload = { agent, signal, messages: [message], nextTurn: [message], nextStep: [] };
  assert.equal((claim!(payload) as { kind: string }).kind, 'claim');
  const selection = { provider: 'fixture', model: 'fixture' };
  const decision = await step!({ ...payload, turn: 5, step: 1, modelSelection: selection }, async () => ({
    kind: 'enter', messages: [message],
  })) as { kind: string; validate: (config: object, phase: object) => boolean };
  assert.equal(decision.kind, 'enter');
  const phase = { phase: 'config', turn: 5, step: 1, attempt: 0 };
  assert.deepEqual(await request!(payload, async () => selection), { ...selection, maxTokens: 10 });
  assert.deepEqual(await request!(payload, async () => ({ ...selection, maxTokens: 256000 })), { ...selection, maxTokens: 10 });
  assert.deepEqual(await request!(payload, async () => ({ ...selection, maxTokens: 5 })), { ...selection, maxTokens: 5 });
  assert.equal(decision.validate({ ...selection, maxTokens: 10 }, phase), true);
  assert.throws(() => decision.validate({ ...selection, maxTokens: 256000 }, phase),
    (error: unknown) => error instanceof CallerDenied && error.code === 'REQUEST_BUDGET_DENIED');
  assert.throws(() => decision.validate({ ...selection, maxTokens: 10, reasoningEffort: 'high' }, phase),
    (error: unknown) => error instanceof CallerDenied && error.code === 'REQUEST_EFFORT_MISMATCH');
});
for (const kind of ['workspace', 'persistence']) test('等价 ' + kind + ' 身份独立换代，原 signal 未 abort 仍拒发布', async t => {
  const f = fixture(t), op = f.operation(), staged = await f.runtime.manager.ensure(op);
  if (kind === 'workspace') f.replaceWorkspace(); else f.persistence.identity = Symbol('replacement');
  assert.equal(op.signal.aborted, false);
  assert.throws(() => op.preflight(staged), (error: unknown) => error instanceof CallerDenied && error.code === 'HOST_SERVICE_CHANGED');
  assert.equal(op.signal.aborted, false); assert.equal(f.runtime.isPublished(f.agent()), false);
});
for (const moment of ['maintenance-entry', 'model-await']) test('等价安装竞争在 ' + moment + ' 出现 pending 时拒绝且不清 inbox', async t => {
  const f = fixture(t), op = f.operation();
  const addPending = () => { (f.agent().inbox.nextTurn as unknown[]).push({ id: 'untouched-pending' }); };
  if (moment === 'maintenance-entry') f.maintenance(addPending); else f.select(async () => { await Promise.resolve(); addPending(); });
  await assert.rejects(f.runtime.manager.ensure(op), (error: unknown) => error instanceof CallerDenied && error.code === 'PENDING_INPUT');
  assert.equal(f.agent().inbox.nextTurn.length, 1); assert.equal(f.runtime.isPublished(f.agent()), false);
  assert.equal(f.store.manager().bindingState, 'unknown'); assert.equal(f.calls.pin, 0);
  await op.cancel(); assert.equal(f.calls.dispose, 1);
});
for (const kind of ['positive', 'pending', 'workspace', 'persistence']) test('最终 caller 回调之后纯事实封口：' + kind, async t => {
  const f = fixture(t), signal = new AbortController().signal; let staged = false, checks = 0, injected = false, resumeCalls = 0;
  let captured: unknown;
  const coordinator = new LifecycleCoordinator(f.store, [], { pause() {}, cancel() {}, dispose() {}, resume() { resumeCalls++; } },
    async operation => { const capsule = await f.runtime.manager.ensure(operation); captured = f.store.manager(); staged = true; return capsule; }, () => {}, () => {});
  coordinator.initialize();
  const pending = coordinator.resume(f.store.manager().revision, 'trusted-fixture', { signal, assertCurrent() {
    if (!staged || ++checks !== 4 || kind === 'positive') return;
    injected = true; assert.equal(signal.aborted, false); assert.deepEqual(f.store.manager(), captured);
    if (kind === 'pending') (f.agent().inbox.nextTurn as unknown[]).push({ id: 'late-pending' });
    if (kind === 'workspace') f.replaceWorkspace();
    if (kind === 'persistence') f.persistence.identity = Symbol('late-persistence');
    assert.deepEqual(f.store.manager(), captured);
  } });
  if (kind === 'positive') { await pending; assert.equal(resumeCalls, 1); assert.equal(f.runtime.isPublished(f.agent()), true); }
  else {
    await assert.rejects(pending, (error: unknown) => error instanceof CallerDenied && error.code === (kind === 'pending' ? 'PENDING_INPUT' : 'HOST_SERVICE_CHANGED'));
    assert.equal(injected, true); assert.equal(resumeCalls, 0); assert.equal(f.runtime.isPublished(f.agent()), false);
    assert.deepEqual(f.store.manager(), captured); assert.equal(f.agent().inbox.nextTurn.length, kind === 'pending' ? 1 : 0);
  }
  assert.equal(signal.aborted, false);
});
for (const fail of [false, true]) test('runtime 首次清理 gate 与全部尾部释放：' + (fail ? '附件失败' : '合法对照'), async t => {
  const f = fixture(t, false), op = f.operation(), capsule = await f.runtime.manager.ensure(op); op.preflight(capsule); op.commit(capsule);
  let release!: () => void, entered!: () => void; const gate = new Promise<void>(ok => { release = ok; }), started = new Promise<void>(ok => { entered = ok; });
  const failure = Error('ATTACHMENT_CLEANUP_FAILURE'); let restrictCalls = 0, reads = 0, source = 0, settled = false;
  const disposeReads = f.runtime.reads.dispose.bind(f.runtime.reads), disposeSource = f.runtime.source.dispose.bind(f.runtime.source);
  f.runtime.reads.dispose = () => { reads++; disposeReads(); }; f.runtime.source.dispose = () => { source++; disposeSource(); };
  f.restrictCleanup(async () => { restrictCalls++; entered(); await gate; if (fail) throw failure; });
  const first = f.runtime.dispose(); first.then(() => { settled = true; }, () => { settled = true; });
  assert.equal(first, f.runtime.dispose()); await started; assert.equal(settled, false); assert.equal(f.runtime.isPublished(f.agent()), false);
  release(); if (fail) await assert.rejects(first, error => error === failure); else await first;
  assert.equal(reads, 1); assert.equal(source, 1); assert.equal(f.globalReleased(), 1); assert.equal(restrictCalls, 1);
  if (fail) await assert.rejects(f.owner.dispose(), error => error === failure); else await f.owner.dispose();
  assert.equal(f.calls.dispose, 1); f.store.close();
});
for (const target of [3, 4]) test('末次 caller 改变 fresh 政策返回值必须拒绝：' + target, async t => {
  const f = fixture(t), signal = new AbortController().signal; let staged = false, checks = 0, injected = false, resumeCalls = 0;
  let captured = f.store.manager();
  const coordinator = new LifecycleCoordinator(f.store, [], { pause() {}, cancel() {}, dispose() {}, resume() { resumeCalls++; } },
    async operation => { const capsule = await f.runtime.manager.ensure(operation); captured = f.store.manager(); staged = true; return capsule; }, () => {}, () => {});
  coordinator.initialize();
  await assert.rejects(coordinator.resume(f.store.manager().revision, 'trusted-fixture', { signal, assertCurrent() {
    if (staged && ++checks === target) { injected = true; f.policyRevision('two'); assert.deepEqual(f.store.manager(), captured); }
  } }), (error: unknown) => error instanceof CallerDenied && error.code === 'INSTALLATION_POLICY_CHANGED');
  assert.equal(injected, true); assert.equal(signal.aborted, false); assert.equal(resumeCalls, 0);
  assert.equal(f.runtime.isPublished(f.agent()), false); assert.deepEqual(f.store.manager(), captured);
});
for (const kind of ['positive', 'pending', 'workspace', 'manager']) test('最终政策 getter 返回后再核所有纯事实：' + kind, async t => {
  const f = fixture(t), signal = new AbortController().signal; let staged = false, checks = 0, reads = 0, resumeCalls = 0;
  let captured = f.store.manager(), injectedManager = captured;
  const coordinator = new LifecycleCoordinator(f.store, [], { pause() {}, cancel() {}, dispose() {}, resume() { resumeCalls++; } },
    async operation => { const capsule = await f.runtime.manager.ensure(operation); captured = f.store.manager(); staged = true; return capsule; }, () => {}, () => {});
  coordinator.initialize();
  const pending = coordinator.resume(f.store.manager().revision, 'trusted-fixture', { signal, assertCurrent() {
    if (!staged || ++checks !== 4) return;
    f.policyRead(() => {
      reads++; f.policyRead(() => {});
      assert.deepEqual(f.store.manager(), captured);
      if (kind === 'pending') (f.agent().inbox.nextTurn as unknown[]).push({ id: 'getter-pending' });
      if (kind === 'workspace') f.replaceWorkspace();
      if (kind === 'manager') injectedManager = f.store.recordLifecycle(captured.revision, 'paused', captured.pin);
    });
  } });
  if (kind === 'positive') { await pending; assert.equal(resumeCalls, 1); assert.equal(f.runtime.isPublished(f.agent()), true); }
  else {
    await assert.rejects(pending, (error: unknown) => kind === 'manager'
      ? error instanceof InstallationError && error.code === 'INSTALLATION_CHANGED'
      : error instanceof CallerDenied && error.code === (kind === 'pending' ? 'PENDING_INPUT' : 'HOST_SERVICE_CHANGED'));
    assert.equal(resumeCalls, 0); assert.equal(f.runtime.isPublished(f.agent()), false);
    assert.deepEqual(f.store.manager(), kind === 'manager' ? injectedManager : captured);
    assert.equal(f.agent().inbox.nextTurn.length, kind === 'pending' ? 1 : 0);
  }
  assert.equal(reads, 1); assert.equal(signal.aborted, false);
});
test('同一 attachment 多个释放失败全部保留，仍完成 runtime 尾部', async t => {
  const f = fixture(t, false), op = f.operation(), capsule = await f.runtime.manager.ensure(op); op.preflight(capsule); op.commit(capsule);
  const firstError = Error('RESTRICT_CLEANUP_FAILURE'), secondError = Error('GUARD_CLEANUP_FAILURE'); let restrictCalls = 0, guardCalls = 0;
  f.restrictCleanup(() => { restrictCalls++; throw firstError; }); f.guardCleanup(() => { guardCalls++; throw secondError; });
  const matches = (error: unknown) => error instanceof AggregateError && error.errors.length === 2 && error.errors.includes(firstError) && error.errors.includes(secondError);
  const first = f.runtime.dispose(); assert.equal(first, f.runtime.dispose()); await assert.rejects(first, matches);
  assert.equal(restrictCalls, 1); assert.equal(guardCalls, 1); assert.equal(f.globalReleased(), 1); assert.equal(f.runtime.isPublished(f.agent()), false);
  await assert.rejects(f.owner.dispose(), matches); assert.equal(f.calls.dispose, 1); f.store.close();
});
test('旧 1000 额度自动升级至新上限，且 maxTokens 仅约束最终可见正文 token 而不被 thinking 挤占', async t => {
  const f = fixture(t);
  f.policyMaxTokens(16384);
  const op = f.operation(), staged = await f.runtime.manager.ensure(op);
  op.preflight(staged); op.commit(staged);
  const agent = f.agent(), signal = new AbortController().signal, requestId = randomUUID();
  Object.assign(agent.session, { deriveMessages: () => [] });
  Object.assign(f.services.sessionController as object, { async prompt() { return { accepted: true }; } });
  let wireMaxTokensSeen = 0;
  let streamScenario: 'long-thinking-short-text' | 'long-visible-text' = 'long-thinking-short-text';
  const adapter = {
    async prepareCall() {
      return {
        model: { defaultMaxTokens: 256000 },
        async *stream(options: { maxTokens?: number }) {
          wireMaxTokensSeen = options.maxTokens ?? 0;
          yield { type: 'block-start', index: 0, blockType: 'reasoning' };
          yield { type: 'reasoning-delta', index: 0, text: '思'.repeat(20000) };
          yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: '思'.repeat(20000) } };
          yield { type: 'block-start', index: 1, blockType: 'text' };
          if (streamScenario === 'long-thinking-short-text') {
            yield { type: 'text-delta', index: 1, text: '简明结论' };
            yield { type: 'block-end', index: 1, block: { type: 'text', text: '简明结论' } };
            yield { type: 'finish', reason: { kind: 'stop' } };
          } else {
            yield { type: 'text-delta', index: 1, text: '答'.repeat(16390) };
            yield { type: 'block-end', index: 1, block: { type: 'text', text: '答'.repeat(16390) } };
            yield { type: 'finish', reason: { kind: 'stop' } };
          }
        },
      };
    },
  };
  const llm = {
    adapters: new Map([['fixture', { adapter }]]),
    async prepareCall(config: { provider: string; model: string; reasoningEffort?: string; maxTokens?: number }, callSignal?: AbortSignal) {
      const adapterCall = await adapter.prepareCall();
      void callSignal;
      return {
        config,
        stream: (options: Record<string, unknown>) => adapterCall.stream(options),
      };
    },
  };
  f.services.llm = llm;
  await f.runtime.submitRouterInput('盘点今天会话', signal, { requestId, assertCurrent() {} });
  const [request] = f.hooks.get('agent/request')!;
  const selection = { provider: 'fixture', model: 'fixture', reasoningEffort: 'high' };
  const upgraded = await request!({ agent, signal }, async () => ({ ...selection, maxTokens: 1000 })) as {
    provider: string; model: string; reasoningEffort: string; maxTokens: number;
  };
  assert.equal(upgraded.maxTokens, 16384);

  const prepared1 = await llm.prepareCall(upgraded, signal);
  assert.equal(prepared1.config.maxTokens, 16384);
  const chunks1 = [];
  for await (const chunk of prepared1.stream({ ...upgraded })) chunks1.push(chunk);
  assert.equal(wireMaxTokensSeen, 256000);
  assert.deepEqual(chunks1.at(-1), { type: 'finish', reason: { kind: 'stop' } });

  streamScenario = 'long-visible-text';
  const proposed2 = await request!({ agent, signal }, async () => ({ ...selection })) as typeof upgraded;
  const prepared2 = await llm.prepareCall(proposed2, signal);
  const chunks2 = [];
  for await (const chunk of prepared2.stream({ ...proposed2 })) chunks2.push(chunk);
  const textDeltas = chunks2.filter(c => c.type === 'text-delta') as { text: string }[];
  assert.equal(textDeltas.map(c => c.text).join('').length, 16384);
  assert.deepEqual(chunks2.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } });
});

test('大肥鱼主会话接纳定时任务触发消息（source.kind=schedule）并支持调用只读盘点工具与清理 SCHEDULE CHANGE 通知', async t => {
  const f = fixture(t);
  f.policyMaxTokens(16384);
  const op = f.operation(), staged = await f.runtime.manager.ensure(op);
  op.preflight(staged); op.commit(staged);
  const agent = f.agent(), signal = new AbortController().signal;
  Object.assign(agent.session, { deriveMessages: () => [] });
  f.services.llm = { async resolveModelInfo() { return { defaultMaxTokens: 65536 }; } };

  // 1. 被动注入的 [SCHEDULE CHANGE] 通知可被自动清理，不阻塞后续输入或维护检查
  const changeNotice = {
    id: 'msg-schedule-change-1',
    source: { kind: 'schedule' },
    content: [{ type: 'text', text: '[SCHEDULE CHANGE]\nchange: updated' }],
  };
  (agent.inbox.nextStep as unknown[]).push(changeNotice);
  Object.assign(agent.inbox, {
    remove(id: string) {
      const idx = (agent.inbox.nextStep as { id: string }[]).findIndex(m => m.id === id);
      if (idx >= 0) {
        (agent.inbox.nextStep as unknown[]).splice(idx, 1);
        return true;
      }
      return false;
    },
  });
  Object.assign(f.services.sessionController as object, { async prompt() { return { accepted: true }; } });
  const reqId = randomUUID();
  await f.runtime.submitRouterInput('测试清理通知后发送', signal, { requestId: reqId, assertCurrent() {} });
  assert.equal(agent.inbox.nextStep.length, 0);

  // 模拟上一轮结束清空 routerInputs
  for (const fn of f.hooks.get('session/event') ?? []) {
    fn(agent.session, { type: 'turn/end', seq: 1, data: { turn: 1 } });
  }

  // 2. 定时任务触发投递 [SCHEDULE REMINDER] 到大肥鱼主会话，通过 pre-claim 与 pre-step 准入并获得前台只读权限
  const scheduleReminder = {
    id: 'msg-schedule-reminder-1',
    source: { kind: 'schedule' },
    content: [{ type: 'text', text: '[SCHEDULE REMINDER]\n每日 09:30 晨间工作简报' }],
  };
  const [claim] = f.hooks.get('agent/pre-claim')!;
  const [step] = f.hooks.get('agent/pre-step')!;
  const [request] = f.hooks.get('agent/request')!;
  const payload = {
    agent,
    signal,
    messages: [scheduleReminder],
    nextTurn: [scheduleReminder],
    nextStep: [],
  };
  const claimDecision = claim!(payload) as { kind: string; validate(): boolean };
  assert.equal(claimDecision.kind, 'claim');
  assert.equal(claimDecision.validate(), true);

  const selection = { provider: 'fixture', model: 'fixture' };
  const stepDecision = await step!({ ...payload, turn: 2, step: 1, modelSelection: selection }, async () => ({
    kind: 'enter',
    messages: [scheduleReminder],
  })) as { kind: string; validate: (config: object, phase: object) => boolean };
  assert.equal(stepDecision.kind, 'enter');

  // 定时触发轮次同样享有主理前台输出额度与全部只读工具授权
  const resolvedReq = await request!({ agent, signal }, async () => ({ ...selection, maxTokens: 1000 })) as { maxTokens: number };
  assert.equal(resolvedReq.maxTokens, 16384);
  const lease = f.runtime.authority.capture({ agent, signal });
  assert.equal(lease.role, 'router');
  assert.equal(lease.foreground, true);
  assert.ok(lease.tools.includes('steward_list_tasks'));
  assert.ok(lease.tools.includes('steward_list_todos'));
  assert.ok(lease.tools.includes('steward_list_sessions'));
});
