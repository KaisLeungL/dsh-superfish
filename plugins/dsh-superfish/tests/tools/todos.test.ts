import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { StewardStore } from '../../src/storage/store.js';
import {
  CallerAuthority,
  CallerDenied,
  CONTEXT_TOOLS,
  PERSONAL_TOOLS,
  READ_TOOLS,
  SCHEDULE_PRESET,
  SESSION_TOOLS,
  TODO_WRITE_TOOLS,
  WORKER_PRESET,
  type CallerHost,
} from '../../src/tools/authority.js';
import { BOARD_CONTEXT, contextToolDefinitions } from '../../src/tools/context.js';
import { ScopedSessionReads, withSessionContext, type RawSessionEvent, type SessionReadPage } from '../../src/tools/sessions.js';
import { ScopedTodoReads, todoToolDefinitions, todoWriteToolDefinitions, withTodoContext, type TodoCounts, type TodoSummaryItem } from '../../src/tools/todos.js';
import type { PublicTodo } from '../../src/app/personal/service.js';
import { ROUTER_PRESET } from '../../src/sessions/manager.js';
import { scheduled } from '../../src/sessions/preset.js';

const root = process.env.B03_RUN_DIR;
assert.ok(root?.includes('/.superagent-product-lab/b03/runs/'));

function fixture(t: TestContext) {
  const identity = { instanceId: randomUUID(), domainId: 'todo-and-schedule-read-tools' };
  const store = StewardStore.initializeFresh(resolve(root!, randomUUID() + '.sqlite'), identity);
  t.after(() => store.close());
  store.registerResource('R', { workspaceId: 'W1', repositoryId: 'P1' });
  store.appendPolicy(0, { resources: ['R'], audiences: [], mandate: { actions: ['read'], expiresAt: 9999999999999 }, proofRef: 'human' });
  const reserved = store.reserveManager(store.manager().revision, 'router-session', 'W1', ROUTER_PRESET);
  store.bindManager(reserved.revision, { sessionId: 'router-session', workspaceId: 'W1', preset: ROUTER_PRESET, nativeLogRef: 'native:router' });
  store.recordLifecycle(store.manager().revision, 'running', false);

  let routerAgent = { id: 'router-session' };
  const scheduledAgent = { id: 'scheduled-summary-1' };
  const workerAgent = { id: 'worker-session' };
  let foreground = true;
  let scheduledAllowed = true;
  const fixedNow = new Date(2026, 10, 14, 9, 0, 0).getTime(); // 2026-11-14 local time

  const host: CallerHost<{ id: string }> = {
    identity,
    agent: id => {
      if (id === routerAgent.id) return routerAgent;
      if (id === scheduledAgent.id) return scheduledAgent;
      if (id === workerAgent.id) return workerAgent;
      return undefined;
    },
    isRuntimeRoot: () => true,
    preset: candidate => {
      if (candidate === routerAgent) return ROUTER_PRESET;
      if (candidate === scheduledAgent) return SCHEDULE_PRESET;
      return WORKER_PRESET;
    },
    workspace: () => 'W1',
    policy: () => ({
      revision: 'host-todos',
      backend: 'native',
      resources: ['R'],
      tools: [...READ_TOOLS, ...CONTEXT_TOOLS, ...SESSION_TOOLS, ...PERSONAL_TOOLS],
      actions: ['read'],
      audiences: [],
      maxTokens: 2048,
      allBoardProjects: true,
    }),
    admission: () => undefined,
    task: () => undefined,
    defaultPermission: () => 'read-only',
    hasForegroundInput: candidate => foreground && candidate === routerAgent,
    isScheduledSession: candidate => scheduledAllowed && candidate === scheduledAgent,
    assertAvailable() {},
    now: () => fixedNow,
  };

  let todos: PublicTodo[] = [
    { id: 'todo-today-1', title: '完成早报与晚报只读总结接口', localDate: '2026-11-14', done: false, revision: 1, boardTaskId: 'task-1' },
    { id: 'todo-overdue-1', title: '补齐登录页异常兜底测试', localDate: '2026-11-12', done: false, revision: 2 },
    { id: 'todo-upcoming-1', title: '准备下周版本发布清单', localDate: '2026-11-16', done: false, revision: 1 },
    { id: 'todo-done-today', title: '核对昨日线上告警日志', localDate: '2026-11-14', done: true, revision: 3 },
    { id: 'todo-done-old', title: '初始化工作区配置', localDate: '2026-11-10', done: true, revision: 2 },
  ];

  const authority = new CallerAuthority(store, host);
  const todoReads = new ScopedTodoReads(authority, {
    assertAvailable() {},
    workspaceId: () => 'W1',
    listTodos: () => todos,
    now: () => fixedNow,
  });
  t.after(() => todoReads.dispose());

  const liveSessions = new Map<string, {
    id: string;
    header: Record<string, unknown>;
    snapshotEvents: () => RawSessionEvent[];
  }>([
    ['s-recent-1', {
      id: 's-recent-1',
      header: { id: 's-recent-1', createdAt: fixedNow - 3600_000, cwd: '/ws/one' },
      snapshotEvents: () => [
        { seq: 1, time: fixedNow - 3500_000, type: 'session/title', data: { title: '个人待办面板联调' } },
        { seq: 2, time: fixedNow - 3400_000, type: 'turn/start', data: { turn: 1 } },
        { seq: 3, time: fixedNow - 3300_000, type: 'user/message', data: { content: [{ type: 'text', text: '帮我检查个人待办与看板卡片关联逻辑' }] } },
        { seq: 4, time: fixedNow - 3200_000, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '已确认关联看板卡片归档时会自动脱敏标题，接下来需要补齐只读总结工具。' }] } } },
        { seq: 5, time: fixedNow - 3100_000, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      ],
    }],
    ['scheduled-summary-1', {
      id: 'scheduled-summary-1',
      header: { id: 'scheduled-summary-1', createdAt: fixedNow - 1000, cwd: '/ws/one', agentPreset: SCHEDULE_PRESET },
      snapshotEvents: () => [
        { seq: 1, time: fixedNow - 500, type: 'user/message', data: { content: [{ type: 'text', text: '生成今日早报' }] } },
      ],
    }],
  ]);

  const sessionReads = new ScopedSessionReads(authority, {
    assertAvailable() {},
    managerSessionId: () => 'router-session',
    workspaces: () => [{ id: 'W1', path: '/ws/one', title: '主工作区', sessionIds: ['s-recent-1', 'router-session', 'scheduled-summary-1'] }],
    archivedSessionIds: () => [],
    agentStatus: () => 'idle',
    liveSession: id => liveSessions.get(id),
    listStoredSessions: async () => [],
  });
  t.after(() => sessionReads.dispose());

  const callTodo = (agent = routerAgent, name: string = PERSONAL_TOOLS[0]) => ({
    agent,
    signal: new AbortController().signal,
    name,
  });

  return {
    store,
    authority,
    todoReads,
    sessionReads,
    routerAgent: () => routerAgent,
    scheduledAgent,
    workerAgent,
    callTodo,
    setTodos: (next: PublicTodo[]) => { todos = next; },
    setForeground: (value: boolean) => { foreground = value; },
    setScheduledAllowed: (value: boolean) => { scheduledAllowed = value; },
    replaceRouterAgent: () => { routerAgent = { id: 'router-session' }; },
  };
}

test('steward_list_todos 支持按状态、日期区间与关键词筛选，并返回统计概览与分页游标', async t => {
  const f = fixture(t);
  const defs = todoToolDefinitions(f.todoReads);
  assert.deepEqual(defs.map(d => d.name), [...PERSONAL_TOOLS]);

  const all = await f.todoReads.execute({}, f.callTodo()) as {
    readScope: string;
    workspaceId: string;
    localToday: string;
    total: number;
    counts: TodoCounts;
    items: TodoSummaryItem[];
    complete: boolean;
  };
  assert.equal(all.readScope, 'workspace-personal-todos');
  assert.equal(all.workspaceId, 'W1');
  assert.equal(all.localToday, '2026-11-14');
  assert.equal(all.total, 5);
  assert.deepEqual(all.counts, {
    total: 5,
    pending: 3,
    overdue: 1,
    todayPending: 1,
    upcomingPending: 1,
    done: 2,
    doneToday: 1,
  });
  assert.deepEqual(all.items.map(i => [i.id, i.timingStatus]), [
    ['todo-overdue-1', 'overdue'],
    ['todo-today-1', 'today'],
    ['todo-upcoming-1', 'upcoming'],
    ['todo-done-today', 'done'],
    ['todo-done-old', 'done'],
  ]);

  const pendingOnly = await f.todoReads.execute({ selector: { status: 'pending' } }, f.callTodo()) as {
    items: TodoSummaryItem[];
  };
  assert.deepEqual(pendingOnly.items.map(i => i.id), ['todo-overdue-1', 'todo-today-1', 'todo-upcoming-1']);

  const todayOnly = await f.todoReads.execute({ selector: { localDate: '2026-11-14' } }, f.callTodo()) as {
    items: TodoSummaryItem[];
  };
  assert.deepEqual(todayOnly.items.map(i => i.id), ['todo-today-1', 'todo-done-today']);

  const rangeAndQuery = await f.todoReads.execute({
    selector: { dateFrom: '2026-11-12', dateTo: '2026-11-15', query: '只读总结' },
  }, f.callTodo()) as { items: TodoSummaryItem[] };
  assert.deepEqual(rangeAndQuery.items.map(i => i.id), ['todo-today-1']);

  const page1 = await f.todoReads.execute({ selector: { status: 'pending' }, limit: 2 }, f.callTodo()) as {
    items: TodoSummaryItem[];
    complete: boolean;
    nextCursor?: string;
  };
  assert.equal(page1.items.length, 2);
  assert.equal(page1.complete, false);
  assert.ok(page1.nextCursor);

  const page2 = await f.todoReads.execute({
    selector: { status: 'pending' },
    limit: 2,
    cursor: page1.nextCursor,
  }, f.callTodo()) as {
    items: TodoSummaryItem[];
    complete: boolean;
  };
  assert.deepEqual(page2.items.map(i => i.id), ['todo-upcoming-1']);
  assert.equal(page2.complete, true);

  await assert.rejects(
    f.todoReads.execute({ selector: { status: 'done' }, limit: 2, cursor: page1.nextCursor }, f.callTodo()),
    { code: 'cursor_stale' },
  );
});

test('withTodoContext 与 withSessionContext 联合为 dsh_context_catalog 与 dsh_context_query 提供 personal.todos 与 session.list', async t => {
  const f = fixture(t);
  const withSessions = withSessionContext(() => undefined, () => f.sessionReads);
  const service = withTodoContext(() => withSessions, () => f.todoReads);
  const [catalogTool, queryTool] = contextToolDefinitions(f.authority, {
    grants: BOARD_CONTEXT,
    service: () => service,
  }, 'W1');

  const call = { agent: f.routerAgent(), signal: new AbortController().signal };
  const catalog = await catalogTool!.execute({}, call) as {
    status: string;
    capabilities: { id: string; status: string }[];
  };
  assert.equal(catalog.status, 'ok');
  const todoCap = catalog.capabilities.find(c => c.id === 'personal.todos');
  assert.ok(todoCap);
  assert.equal(todoCap.status, 'available');

  const queried = await queryTool!.execute(
    { capability: 'personal.todos', filter: { done: false }, limit: 2 },
    call,
  ) as {
    status: string;
    localToday: string;
    counts: TodoCounts;
    items: { id: string; timingStatus: string }[];
    complete: boolean;
    nextCursor?: string;
  };
  assert.equal(queried.status, 'ok');
  assert.equal(queried.localToday, '2026-11-14');
  assert.equal(queried.counts.pending, 3);
  assert.deepEqual(queried.items.map(i => [i.id, i.timingStatus]), [
    ['todo-overdue-1', 'overdue'],
    ['todo-today-1', 'today'],
  ]);
  assert.equal(queried.complete, false);
  assert.ok(queried.nextCursor);

  const page2 = await queryTool!.execute(
    { capability: 'personal.todos', filter: { done: false }, limit: 2, cursor: queried.nextCursor },
    call,
  ) as {
    status: string;
    items: { id: string }[];
    complete: boolean;
  };
  assert.equal(page2.status, 'ok');
  assert.deepEqual(page2.items.map(i => i.id), ['todo-upcoming-1']);
  assert.equal(page2.complete, true);
});

test('定时会话（workspace-superagent-scheduled）在主理 paused 时可调用只读总结工具，并从用户会话列表中自动排除自身', async t => {
  const f = fixture(t);
  // 主理在前台轮次结束后处于 paused 状态，定时会话异步触发仍可基于只读授权工作。
  f.store.recordLifecycle(f.store.manager().revision, 'paused', false);
  f.setForeground(false);

  const scheduledTodoRes = await f.todoReads.execute(
    { selector: { status: 'pending' } },
    f.callTodo(f.scheduledAgent),
  ) as { items: TodoSummaryItem[]; counts: TodoCounts };
  assert.equal(scheduledTodoRes.counts.overdue, 1);
  assert.equal(scheduledTodoRes.counts.todayPending, 1);
  assert.equal(scheduledTodoRes.items.length, 3);

  const scheduledSessionsRes = await f.sessionReads.execute(
    {},
    { agent: f.scheduledAgent, signal: new AbortController().signal, name: SESSION_TOOLS[0] },
  ) as { total: number; items: { sessionId: string; title: string }[] };
  assert.equal(scheduledSessionsRes.total, 1);
  assert.deepEqual(scheduledSessionsRes.items.map(i => i.sessionId), ['s-recent-1']);

  const sessionDetail = await f.sessionReads.execute(
    { sessionId: 's-recent-1', order: 'recent' },
    { agent: f.scheduledAgent, signal: new AbortController().signal, name: SESSION_TOOLS[1] },
  ) as SessionReadPage;
  assert.equal(sessionDetail.messages[0]!.role, 'assistant');
  assert.match(sessionDetail.messages[0]!.text, /补齐只读总结工具/u);

  // 撤销定时会话归属或停止主理后立即拒绝
  f.setScheduledAllowed(false);
  await assert.rejects(
    f.todoReads.execute({}, f.callTodo(f.scheduledAgent)),
    { code: 'NOT_RUNNING' },
  );
  f.setScheduledAllowed(true);
  f.store.stop(f.store.manager().revision, 'human');
  await assert.rejects(
    f.todoReads.execute({}, f.callTodo(f.scheduledAgent)),
    { code: 'NOT_RUNNING' },
  );
});

test('scheduled preset 挂载只读总结系统提示词并委托运行时守卫与安装作用域', () => {
  let restricted: readonly string[] | undefined;
  let guardFn: ((exec: unknown) => string | undefined) | undefined;
  let promptSection: { name: string; order: number; text: string } | undefined;
  let installedScope: unknown;

  const fakeRuntime = {
    checkScheduledTool: (exec: { name?: string }) =>
      exec.name === 'steward_list_todos' ? undefined : '拒绝非只读工具',
    installScheduledScope: (scope: unknown) => {
      installedScope = scope;
    },
  };

  const fakeCtx = {
    effect: () => () => {},
    get: (name: string) => (name === 'workspaceSuperagentRuntime' ? fakeRuntime : undefined),
    inject: (_names: string[], cb: (scope: unknown) => void) => cb(fakeCtx),
    tools: {
      register: () => () => {},
      restrict: (filter: { allow: readonly string[] }) => {
        restricted = filter.allow;
        return () => {};
      },
      guard: (check: (exec: unknown) => string | undefined) => {
        guardFn = check;
        return () => {};
      },
    },
    systemPrompt: {
      section: (value: { name: string; order: number; text: string }) => {
        promptSection = value;
        return () => {};
      },
    },
    on: () => () => {},
  };

  scheduled(fakeCtx as unknown as Parameters<typeof scheduled>[0]);
  assert.deepEqual(restricted, []);
  assert.equal(installedScope, fakeCtx);
  assert.ok(promptSection);
  assert.equal(promptSection.name, 'workspace-superagent-scheduled');
  assert.match(promptSection.text, /steward_list_todos/u);
  assert.ok(guardFn);
  assert.equal(guardFn({ name: 'steward_list_todos' }), undefined);
  assert.equal(guardFn({ name: 'bash' }), '拒绝非只读工具');
});

test('前台主理可通过 steward_create_todo / steward_update_todo 直接增改待办并去重，定时会话拒绝写入', async t => {
  const f = fixture(t);
  let storeTodos: PublicTodo[] = [
    { id: 'todo-existing', title: '既有待办', localDate: '2026-11-14', done: false, revision: 1, boardTaskId: 'board-1' },
  ];
  let foreground = true;
  const writeTools = todoWriteToolDefinitions(
    {
      listTodos: () => storeTodos,
      createTodo: async (_session, input) => {
        storeTodos = [
          ...storeTodos,
          {
            id: 'todo-' + (storeTodos.length + 1),
            title: input.title,
            localDate: input.localDate,
            done: false,
            revision: 1,
            ...(input.boardTaskId ? { boardTaskId: input.boardTaskId } : {}),
          },
        ];
        return storeTodos;
      },
      updateTodo: async (_session, input) => {
        storeTodos = storeTodos.map(item => item.id === input.id
          ? {
              ...item,
              revision: item.revision + 1,
              ...(input.title !== undefined ? { title: input.title } : {}),
              ...(input.localDate !== undefined ? { localDate: input.localDate } : {}),
              ...(typeof input.done === 'boolean' ? { done: input.done } : {}),
            }
          : item);
        return storeTodos;
      },
      now: () => Date.UTC(2026, 10, 14, 10, 0, 0),
    },
    exec => {
      if (!foreground || exec.agent !== f.routerAgent()) throw new CallerDenied('TODO_WRITE_NOT_ADMITTED');
      return { session: 'router', turn: 1 };
    },
  );
  const createTool = writeTools.find(tool => tool.name === TODO_WRITE_TOOLS[0])!;
  const updateTool = writeTools.find(tool => tool.name === TODO_WRITE_TOOLS[1])!;
  const callRouter = (name: string) => ({ agent: f.routerAgent(), signal: new AbortController().signal, name });

  // 单条直接写入 + 同标题去重 + 关联看板卡同日去重 + 批量写入
  const batchRes = await createTool.execute(
    {
      items: [
        { title: '完成方案 2 联调验证' },
        { title: '完成方案 2 联调验证', localDate: '2026-11-14' },
        { title: '看板同卡同日重复标题不同', localDate: '2026-11-14', boardTaskId: 'board-1' },
        { title: '整理明日发布清单', localDate: '2026-11-15' },
      ],
    },
    callRouter(TODO_WRITE_TOOLS[0]),
  ) as { status: string; createdCount: number; dedupedCount: number; totalTodos: number };
  assert.equal(batchRes.status, 'ok');
  assert.equal(batchRes.createdCount, 2);
  assert.equal(batchRes.dedupedCount, 2);
  assert.equal(batchRes.totalTodos, 3);

  // 直接更新待办完成状态与日期
  const updated = await updateTool.execute(
    { id: 'todo-existing', done: true, localDate: '2026-11-15' },
    callRouter(TODO_WRITE_TOOLS[1]),
  ) as { status: string; action: string; item: PublicTodo };
  assert.equal(updated.status, 'ok');
  assert.equal(updated.action, 'updated');
  assert.equal(updated.item.done, true);
  assert.equal(updated.item.localDate, '2026-11-15');
  assert.equal(updated.item.revision, 2);

  // 相同值重复更新返回 unchanged
  const unchanged = await updateTool.execute(
    { id: 'todo-existing', done: true },
    callRouter(TODO_WRITE_TOOLS[1]),
  ) as { action: string; item: PublicTodo };
  assert.equal(unchanged.action, 'unchanged');
  assert.equal(unchanged.item.revision, 2);

  // 非前台主理拒绝写入
  foreground = false;
  await assert.rejects(
    createTool.execute({ title: '越权待办' }, { agent: f.scheduledAgent, signal: new AbortController().signal, name: TODO_WRITE_TOOLS[0] }),
    { code: 'TODO_WRITE_NOT_ADMITTED' },
  );
});
