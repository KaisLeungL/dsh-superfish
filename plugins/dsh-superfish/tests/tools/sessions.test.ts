import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { StewardStore } from '../../src/storage/store.js';
import { CallerAuthority, CONTEXT_TOOLS, READ_TOOLS, SESSION_TOOLS, WORKER_PRESET, type CallerHost } from '../../src/tools/authority.js';
import { BOARD_CONTEXT, contextToolDefinitions } from '../../src/tools/context.js';
import { ScopedSessionReads, sessionToolDefinitions, withSessionContext, type RawSessionEvent, type SessionReadPage } from '../../src/tools/sessions.js';
import { ROUTER_PRESET } from '../../src/sessions/manager.js';

const root = process.env.B03_RUN_DIR;
assert.ok(root?.includes('/.superagent-product-lab/b03/runs/'));

function fixture(t: TestContext) {
  const identity = { instanceId: randomUUID(), domainId: 'session-read-tools' };
  const store = StewardStore.initializeFresh(resolve(root!, randomUUID() + '.sqlite'), identity);
  t.after(() => store.close());
  store.registerResource('R', { workspaceId: 'W1', repositoryId: 'P1' });
  store.appendPolicy(0, { resources: ['R'], audiences: [], mandate: { actions: ['read'], expiresAt: 9999999999999 }, proofRef: 'human' });
  const reserved = store.reserveManager(store.manager().revision, 'router-session', 'W1', ROUTER_PRESET);
  store.bindManager(reserved.revision, { sessionId: 'router-session', workspaceId: 'W1', preset: ROUTER_PRESET, nativeLogRef: 'native:router' });
  store.recordLifecycle(store.manager().revision, 'running', false);

  let agent = { id: 'router-session' };
  let foreground = true;
  const host: CallerHost<{ id: string }> = {
    identity,
    agent: () => agent,
    isRuntimeRoot: () => true,
    preset: () => ROUTER_PRESET,
    workspace: () => 'W1',
    policy: () => ({
      revision: 'host-sessions',
      backend: 'native',
      resources: ['R'],
      tools: [...READ_TOOLS, ...CONTEXT_TOOLS, ...SESSION_TOOLS],
      actions: ['read'],
      audiences: [],
      maxTokens: 2048,
      allBoardProjects: true,
    }),
    admission: () => undefined,
    task: () => undefined,
    defaultPermission: () => 'read-only',
    hasForegroundInput: candidate => foreground && candidate === agent,
    assertAvailable() {},
    now: () => 1,
  };

  let closedHandles = 0;
  const liveSessions = new Map<string, {
    id: string;
    header: Record<string, unknown>;
    snapshotEvents: () => RawSessionEvent[];
  }>([
    ['s-done-w1', {
      id: 's-done-w1',
      header: { id: 's-done-w1', createdAt: 1000, cwd: '/ws/one' },
      snapshotEvents: () => [
        { seq: 1, time: 1100, type: 'turn/start', data: { turn: 1 } },
        { seq: 2, time: 1150, type: 'user/message', data: { content: [{ type: 'text', text: '修复支付回调重试问题' }, { type: 'file', attachment: { name: 'webhook.log' } }] } },
        { seq: 3, time: 1200, type: 'tool/call', data: { turn: 1, step: 1, callId: 'tc-1', name: 'read_file' } },
        { seq: 4, time: 1250, type: 'tool/result', data: { message: { toolCallId: 'tc-1', isError: false } } },
        { seq: 5, time: 1300, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '已定位幂等键校验缺陷并补齐重试单测。' }] } } },
        { seq: 6, time: 1400, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      ],
    }],
    ['s-running-w2', {
      id: 's-running-w2',
      header: { id: 's-running-w2', createdAt: 2000, cwd: '/ws/two' },
      snapshotEvents: () => [
        { seq: 1, time: 2100, type: 'session/title', data: { title: '跨工作区性能优化' } },
        { seq: 2, time: 2200, type: 'turn/start', data: { turn: 1 } },
        { seq: 3, time: 2300, type: 'user/message', data: { content: [{ type: 'text', text: '排查慢查询索引' }] } },
      ],
    }],
    ['router-session', {
      id: 'router-session',
      header: { id: 'router-session', createdAt: 500, cwd: '/ws/one', agentPreset: ROUTER_PRESET },
      snapshotEvents: () => [
        { seq: 1, time: 600, type: 'user/message', data: { content: [{ type: 'text', text: '帮我看下我刚完成了哪些会话' }] } },
      ],
    }],
    ['worker-session', {
      id: 'worker-session',
      header: { id: 'worker-session', createdAt: 700, cwd: '/ws/one', agentPreset: WORKER_PRESET },
      snapshotEvents: () => [],
    }],
  ]);

  const coldSessions = new Map<string, { header: Record<string, unknown>; revision: string; events: RawSessionEvent[] }>([
    ['s-cold-w2', {
      header: { id: 's-cold-w2', createdAt: 3000, cwd: '/ws/two/sub' },
      revision: 'rev-cold-1',
      events: [
        { seq: 1, time: 3100, type: 'session/title', data: { title: '刚完成的订单导出改造' } },
        { seq: 2, time: 3200, type: 'turn/start', data: { turn: 1 } },
        { seq: 3, time: 3300, type: 'user/message', data: { content: [{ type: 'text', text: '把订单导出改成流式 CSV' }] } },
        { seq: 4, time: 3400, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '已完成流式 CSV 导出并验证内存占用。' }] } } },
        { seq: 5, time: 3500, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      ],
    }],
    ['s-archived', {
      header: { id: 's-archived', createdAt: 800, cwd: '/ws/one' },
      revision: 'rev-arch-1',
      events: [
        { seq: 1, time: 850, type: 'user/message', data: { content: [{ type: 'text', text: '历史归档会话' }] } },
        { seq: 2, time: 900, type: 'assistant/message', data: { content: [{ type: 'text', text: '归档回复' }] } },
        { seq: 3, time: 950, type: 'turn/end', data: { reason: { kind: 'completed' } } },
      ],
    }],
    ['s-subagent', {
      header: { id: 's-subagent', createdAt: 4000, cwd: '/ws/one', origin: 'subagent' },
      revision: 'rev-sub-1',
      events: [],
    }],
  ]);

  const authority = new CallerAuthority(store, host);
  const sessionReads = new ScopedSessionReads(authority, {
    assertAvailable() {},
    managerSessionId: () => 'router-session',
    workspaces: () => [
      { id: 'W1', path: '/ws/one', title: '主工作区', sessionIds: ['s-done-w1', 'router-session'] },
      { id: 'W2', path: '/ws/two', title: '次工作区', sessionIds: ['s-running-w2', 's-cold-w2'] },
    ],
    archivedSessionIds: () => ['s-archived'],
    agentStatus: id => id === 's-running-w2' ? 'running' : 'idle',
    liveSession: id => liveSessions.get(id),
    listStoredSessions: async () => [...coldSessions.values()].map(item => ({
      header: item.header,
      revision: item.revision,
      eventCount: item.events.length,
    })),
    statStoredSession: async id => {
      const found = coldSessions.get(id);
      return found ? { header: found.header, revision: found.revision, eventCount: found.events.length } : undefined;
    },
    openStoredSession: async id => {
      const found = coldSessions.get(id);
      if (!found) throw Error('not found');
      return {
        header: found.header,
        read: async (offset = 0, length = 256) => ({
          events: found.events.slice(offset, offset + length),
        }),
        close: async () => { closedHandles++; },
      };
    },
  });
  t.after(() => sessionReads.dispose());

  const call = (name: string = SESSION_TOOLS[0]) => ({ agent, signal: new AbortController().signal, name });
  return {
    store,
    authority,
    sessionReads,
    coldSessions,
    call,
    closedHandles: () => closedHandles,
    setForeground: (value: boolean) => { foreground = value; },
    replaceAgent: () => { agent = { id: 'router-session' }; },
  };
}

test('跨工作区列出全部用户会话并排除大肥鱼自身、Worker 与子代理会话', async t => {
  const f = fixture(t);
  const tools = sessionToolDefinitions(f.sessionReads);
  assert.deepEqual(tools.map(tool => tool.name), [...SESSION_TOOLS]);

  const all = await f.sessionReads.execute({}, f.call(SESSION_TOOLS[0])) as {
    readScope: string;
    total: number;
    items: { sessionId: string; title: string; workspaceId: string | null; status: string; lastAssistantMessage: string | null }[];
  };
  assert.equal(all.readScope, 'all-sessions');
  assert.equal(all.total, 3);
  assert.deepEqual(all.items.map(i => [i.sessionId, i.workspaceId, i.status, i.title]), [
    ['s-cold-w2', 'W2', 'completed', '刚完成的订单导出改造'],
    ['s-running-w2', 'W2', 'running', '跨工作区性能优化'],
    ['s-done-w1', 'W1', 'completed', '修复支付回调重试问题'],
  ]);
  assert.ok(f.closedHandles() > 0, '冷会话读取后必须关闭文件句柄');

  const completedOnly = await f.sessionReads.execute({ selector: { status: 'completed' } }, f.call(SESSION_TOOLS[0])) as {
    items: { sessionId: string; status: string }[];
  };
  assert.deepEqual(completedOnly.items.map(i => i.sessionId), ['s-cold-w2', 's-done-w1']);

  const archivedOnly = await f.sessionReads.execute({ selector: { archived: 'only' } }, f.call(SESSION_TOOLS[0])) as {
    items: { sessionId: string; archived: boolean }[];
  };
  assert.deepEqual(archivedOnly.items.map(i => [i.sessionId, i.archived]), [['s-archived', true]]);

  const byQuery = await f.sessionReads.execute({ selector: { query: '幂等键 重试' } }, f.call(SESSION_TOOLS[0])) as {
    items: { sessionId: string }[];
  };
  assert.deepEqual(byQuery.items.map(i => i.sessionId), ['s-done-w1']);
});

test('读取指定会话的对话上下文、工具调用摘要与附件信息，并支持分页与防篡改校验', async t => {
  const f = fixture(t);
  const detail = await f.sessionReads.execute({ sessionId: 's-done-w1' }, f.call(SESSION_TOOLS[1])) as SessionReadPage;
  assert.equal(detail.readScope, 'all-sessions');
  assert.equal(detail.session.sessionId, 's-done-w1');
  assert.equal(detail.session.workspaceTitle, '主工作区');
  assert.equal(detail.session.firstUserMessage, '修复支付回调重试问题');
  assert.equal(detail.totalMessages, 2);
  assert.equal(detail.complete, true);
  assert.equal(detail.messages[0]!.role, 'user');
  assert.deepEqual(detail.messages[0]!.attachments, [{ type: 'file', name: 'webhook.log' }]);
  assert.equal(detail.messages[1]!.role, 'assistant');
  assert.deepEqual(detail.messages[1]!.toolCalls, [{ name: 'read_file', status: 'ok' }]);

  const manyEvents: RawSessionEvent[] = [];
  for (let i = 1; i <= 30; i++) {
    manyEvents.push({
      seq: i,
      time: 5000 + i,
      type: i % 2 === 1 ? 'user/message' : 'assistant/message',
      data: { content: [{ type: 'text', text: `第 ${i} 条对话内容` }] },
    });
  }
  f.coldSessions.set('s-long', {
    header: { id: 's-long', createdAt: 5000, cwd: '/ws/one' },
    revision: 'rev-long-1',
    events: manyEvents,
  });

  const firstPage = await f.sessionReads.execute({ sessionId: 's-long', order: 'chronological' }, f.call(SESSION_TOOLS[1])) as SessionReadPage;
  assert.equal(firstPage.messages.length, 25);
  assert.equal(firstPage.complete, false);
  assert.ok(firstPage.nextCursor);

  const secondPage = await f.sessionReads.execute({ sessionId: 's-long', order: 'chronological', cursor: firstPage.nextCursor }, f.call(SESSION_TOOLS[1])) as SessionReadPage;
  assert.equal(secondPage.messages.length, 5);
  assert.equal(secondPage.complete, true);
  assert.equal(secondPage.messages[0]!.text, '第 26 条对话内容');

  await assert.rejects(f.sessionReads.execute({ sessionId: 'router-session' }, f.call(SESSION_TOOLS[1])), { code: 'SESSION_NOT_FOUND' });
  await assert.rejects(f.sessionReads.execute({ sessionId: 's-long', order: 'recent', cursor: firstPage.nextCursor }, f.call(SESSION_TOOLS[1])), { code: 'cursor_stale' });

  f.replaceAgent();
  await assert.rejects(f.sessionReads.execute({ sessionId: 's-long', cursor: firstPage.nextCursor }, f.call(SESSION_TOOLS[1])), { code: 'cursor_stale' });

  f.setForeground(false);
  await assert.rejects(f.sessionReads.execute({}, f.call(SESSION_TOOLS[0])), /没有此项权限/);
});

test('withSessionContext 为 dsh_context_catalog 与 dsh_context_query 提供内置 session.list 能力', async t => {
  const f = fixture(t);
  const service = withSessionContext(() => undefined, () => f.sessionReads);
  const [catalogTool, queryTool] = contextToolDefinitions(f.authority, {
    grants: BOARD_CONTEXT,
    service: () => service,
  }, 'W1');

  const catalog = await catalogTool!.execute({}, { agent: f.call().agent, signal: f.call().signal }) as {
    status: string;
    capabilities: { id: string; status: string; readScope?: string }[];
  };
  assert.equal(catalog.status, 'ok');
  const sessionCap = catalog.capabilities.find(c => c.id === 'session.list');
  assert.ok(sessionCap);
  assert.equal(sessionCap.status, 'available');
  assert.equal(sessionCap.readScope, 'all-sessions');

  const queryRes = await queryTool!.execute(
    { capability: 'session.list', filter: { status: 'completed' }, limit: 1 },
    { agent: f.call().agent, signal: f.call().signal },
  ) as {
    status: string;
    readScope: string;
    items: { sessionId: string; title: string }[];
    complete: boolean;
    nextCursor?: string;
  };
  assert.equal(queryRes.status, 'ok');
  assert.equal(queryRes.readScope, 'all-sessions');
  assert.equal(queryRes.items.length, 1);
  assert.equal(queryRes.items[0]!.sessionId, 's-cold-w2');
  assert.equal(queryRes.complete, false);
  assert.ok(queryRes.nextCursor);

  const page2 = await queryTool!.execute(
    { capability: 'session.list', filter: { status: 'completed' }, limit: 1, cursor: queryRes.nextCursor },
    { agent: f.call().agent, signal: f.call().signal },
  ) as {
    status: string;
    items: { sessionId: string; title: string }[];
    complete: boolean;
  };
  assert.equal(page2.status, 'ok');
  assert.equal(page2.items[0]!.sessionId, 's-done-w1');
  assert.equal(page2.complete, true);
});
