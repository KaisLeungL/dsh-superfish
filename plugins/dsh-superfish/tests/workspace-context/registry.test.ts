import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import { apply, type ContextAccess, type WorkspaceContextService } from '../../src/workspace-context/index.js';
import { apply as applyTaskBoard } from '../../src/workspace-context/task-board.js';
import { apply as applySchedule } from '../../src/workspace-context/schedule.js';
import { apply as applySession } from '../../src/workspace-context/session.js';
import { createScheduleNavigation, installScheduleNavigation, openScheduleTask } from '../../src/client/schedule-navigation.js';

function fixture() {
  let service!: WorkspaceContextService;
  let close: (() => void) | undefined;
  apply({
    effect: (setup: () => () => void) => {
      close = setup();
    },
    provide: (_name: string, value: WorkspaceContextService) => {
      service = value;
    },
  } as unknown as Context);
  const owner = (name: string) => ({ fiber: { entry: { options: { name } } } });
  const access: ContextAccess = {
    scope: { workspaceId: 'one', projectIds: ['project'] },
    binding: 'session-generation',
    grants: { 'example.list': '@example/context' },
    signal: new AbortController().signal,
    assertCurrent() {},
  };
  const item = (id: string) => ({ workspaceId: 'one', projectId: 'project', ref: { kind: 'example.item', id } });
  const base = {
    id: 'example.list',
    protocol: 1 as const,
    source: '示例',
    description: '列表',
    scope: 'project' as const,
    filters: { state: { type: 'string' as const, description: '状态', enum: ['active'] } },
  };
  return { service, owner, access, item, base, close: () => close?.() };
}

test('只发现当前授权的注册者，并检查筛选和每条结果的归属', async () => {
  const { service, owner, access, item, base, close } = fixture();
  service.register(owner('@example/other'), { ...base, read: () => assert.fail('未经授权的注册者被调用') });
  const cat1 = service.catalog(access) as { capabilities: { status: string }[] };
  assert.equal(cat1.capabilities[0]!.status, 'unavailable');
  const unregister = service.register(owner('@example/context'), {
    ...base,
    read: () => ({
      items: [{ ...item('different-workspace'), workspaceId: 'two' }],
      more: false,
      revision: '1',
    }),
  });
  const cat2 = service.catalog(access) as { capabilities: { status: string }[] };
  assert.equal(cat2.capabilities[0]!.status, 'available');
  const query = { capability: base.id };
  assert.equal(((await service.query(access, { ...query, filter: { state: 'unknown' } })) as { status: string }).status, 'invalid_query');
  assert.equal(((await service.query(access, { ...query, workspaceId: 'two' })) as { status: string }).status, 'invalid_query');
  assert.equal(((await service.query(access, query)) as { status: string }).status, 'unavailable');
  assert.equal(((await service.query({ ...access, grants: {} }, query)) as { status: string }).status, 'denied');
  unregister();
  service.register(owner('@example/context'), {
    ...base,
    read: () => ({
      items: [{ ...item('different-project'), projectId: 'private' }],
      more: false,
      revision: '1',
    }),
  });
  assert.equal(((await service.query(access, query)) as { status: string }).status, 'unavailable');
  close();
});

test('分页绑定调用身份、查询条件和来源代次', async () => {
  const { service, owner, access, item, base, close } = fixture();
  let revision = 'one';
  const register = () =>
    service.register(owner('@example/context'), {
      ...base,
      read: ({ offset }) => ({
        items: [item(String(offset))],
        more: offset === 0,
        revision,
      }),
    });
  const unregister = register();
  const query = { capability: base.id, limit: 1, filter: { state: 'active' } };
  const first = (await service.query(access, query)) as { complete: boolean; nextCursor: string };
  assert.equal(first.complete, false);
  const next = { ...query, cursor: first.nextCursor };
  const page2 = (await service.query(access, next)) as { items: { ref: { id: string } }[] };
  assert.equal(page2.items[0]!.ref.id, '1');
  assert.equal(((await service.query({ ...access, binding: 'new-authorization' }, next)) as { status: string }).status, 'cursor_stale');
  assert.equal(((await service.query(access, { ...next, filter: {} })) as { status: string }).status, 'cursor_stale');
  revision = 'two';
  assert.equal(((await service.query(access, next)) as { status: string }).status, 'cursor_stale');
  unregister();
  register();
  assert.equal(((await service.query(access, next)) as { status: string }).status, 'cursor_stale');
  close();
});

test('读取过程中卸载或撤回授权时丢弃在途结果', async () => {
  const { service, owner, access, item, base, close } = fixture();
  let finish!: (value: { items: Record<string, unknown>[]; more: boolean; revision: string }) => void;
  let active = true;
  const register = () =>
    service.register(owner('@example/context'), {
      ...base,
      read: () => new Promise(resolve => { finish = resolve; }),
    });
  const result = { items: [item('private')], more: false, revision: '1' };
  const unregister = register();
  const query = { capability: base.id };
  const pending = service.query(access, query);
  await Promise.resolve();
  unregister();
  finish(result);
  assert.equal(((await pending) as { status: string }).status, 'unavailable');
  register();
  const revoked = service.query(
    { ...access, assertCurrent() { assert.ok(active, '授权已撤回'); } },
    query,
  );
  await Promise.resolve();
  active = false;
  finish(result);
  await assert.rejects(revoked, /授权已撤回/);
  close();
});

test('整合后的 task-board、schedule 与 session 适配器支持内置与旧版别名授权', async () => {
  const { service, owner, access, close } = fixture();
  let closeBoard: (() => void) | undefined;
  let closeSchedule: (() => void) | undefined;
  let closeSession: (() => void) | undefined;

  applyTaskBoard({
    ...owner('@local/dsh-superfish/workspace-context/task-board'),
    workspaceContext: service,
    taskBoard: {
      snapshot: () => ({
        revision: 7,
        tasks: [
          {
            id: 'card-1',
            title: '整合大肥鱼上下文插件',
            description: '将三个伴生插件合入 dsh-superfish',
            status: 'in_progress',
            workspaceId: 'one',
            projectId: 'project',
            updatedAt: 5000,
          },
        ],
      }),
    },
    workspaceRegistry: {
      get: (id: string) => (id === 'project' ? { title: '大肥鱼主工程' } : undefined),
    },
    effect: (setup: () => () => void) => {
      closeBoard = setup();
    },
  } as unknown as Context);

  applySchedule({
    ...owner('@local/dsh-superfish/workspace-context/schedule'),
    workspaceContext: service,
    schedule: {
      list: async () => [
        {
          id: 'sched-1',
          title: '每日晨报提醒',
          status: 'active',
          scheduledAt: '2026-11-18T01:00:00.000Z',
          timing: { kind: 'daily' },
          target: { kind: 'new_once', create: { cwd: '/ws/one' } },
        },
      ],
    },
    workspaceRegistry: {
      get: (id: string) => (id === 'one' ? { id: 'one', path: '/ws/one' } : undefined),
      list: () => [{ id: 'one', path: '/ws/one' }],
    },
    effect: (setup: () => () => void) => {
      closeSchedule = setup();
    },
  } as unknown as Context);

  applySession({
    ...owner('@local/dsh-superfish/workspace-context/session'),
    workspaceContext: service,
    workspaceRegistry: {
      list: () => [
        { id: 'one', path: '/ws/one', title: '工作区一', sessionIds: ['s-one'] },
        { id: 'two', path: '/ws/two', title: '工作区二', sessionIds: ['s-two'] },
      ],
      archivedSessionIds: [],
    },
    sessionPersistence: {
      list: async () => [
        { header: { id: 's-one', createdAt: 1000, cwd: '/ws/one' } },
        { header: { id: 's-two', createdAt: 2000, cwd: '/ws/two' } },
        { header: { id: 's-router', createdAt: 3000, cwd: '/ws/one', agentPreset: 'workspace-superagent-router' } },
      ],
    },
    sessions: {
      get: (id: string) => {
        if (id === 's-one') {
          return {
            header: { id: 's-one', createdAt: 1000, cwd: '/ws/one' },
            snapshotEvents: () => [
              { id: 'e1', time: 1100, type: 'user/message', data: { content: [{ type: 'text', text: '修复登录鉴权' }] } },
              { id: 'e2', time: 1200, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '已修复登录鉴权逻辑' }] } } },
              { id: 'e3', time: 1300, type: 'turn/end', data: { reason: { kind: 'completed' } } },
            ],
          };
        }
        if (id === 's-two') {
          return {
            header: { id: 's-two', createdAt: 2000, cwd: '/ws/two' },
            snapshotEvents: () => [
              { id: 'e4', time: 2100, type: 'session/title', data: { title: '跨工作区接口重构' } },
              { id: 'e5', time: 2200, type: 'user/message', data: { content: [{ type: 'text', text: '重构订单同步接口' }] } },
              { id: 'e6', time: 2300, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '订单同步接口重构完成并通过测试' }] } } },
              { id: 'e7', time: 2400, type: 'turn/end', data: { reason: { kind: 'completed' } } },
            ],
          };
        }
        return undefined;
      },
    },
    agents: { get: () => undefined },
    effect: (setup: () => () => void) => {
      closeSession = setup();
    },
  } as unknown as Context);

  // 同时验证新内置路径与旧 @local/dsh-workspace-context/* 别名均可命中
  for (const prefix of ['@local/dsh-superfish/workspace-context', '@local/dsh-workspace-context']) {
    const fullAccess: ContextAccess = {
      ...access,
      grants: {
        'task-board.list': `${prefix}/task-board`,
        'schedule.upcoming': `${prefix}/schedule`,
        'session.list': `${prefix}/session`,
      },
    };
    assert.deepEqual(service.status(fullAccess.grants), [
      { id: 'task-board.list', available: true },
      { id: 'schedule.upcoming', available: true },
      { id: 'session.list', available: true },
    ]);

    const boardRes = (await service.query(fullAccess, { capability: 'task-board.list' })) as {
      status: string;
      items: { title: string; projectName: string }[];
    };
    assert.equal(boardRes.status, 'ok');
    assert.equal(boardRes.items[0]!.title, '整合大肥鱼上下文插件');
    assert.equal(boardRes.items[0]!.projectName, '大肥鱼主工程');

    const scheduleRes = (await service.query(fullAccess, { capability: 'schedule.upcoming' })) as {
      status: string;
      items: { title: string; cadence: string }[];
    };
    assert.equal(scheduleRes.status, 'ok');
    assert.equal(scheduleRes.items[0]!.title, '每日晨报提醒');
    assert.equal(scheduleRes.items[0]!.cadence, 'daily');

    const sessionRes = (await service.query(fullAccess, {
      capability: 'session.list',
      filter: { status: 'completed' },
    })) as {
      status: string;
      readScope: string;
      items: { sessionId: string; workspaceId: string; title: string }[];
    };
    assert.equal(sessionRes.status, 'ok');
    assert.equal(sessionRes.readScope, 'all-sessions');
    assert.deepEqual(
      sessionRes.items.map(i => [i.sessionId, i.workspaceId, i.title]),
      [
        ['s-two', 'two', '跨工作区接口重构'],
        ['s-one', 'one', '修复登录鉴权'],
      ],
    );
  }

  closeBoard?.();
  closeSchedule?.();
  closeSession?.();
  close();
});

test('scheduleNavigation 客户端服务注入与跳转打开自动化任务面板', () => {
  let selectedPanel: string | undefined;
  const provided = new Map<string, unknown>();
  const ctx = {
    get(name: string) {
      if (name === 'layout') {
        return {
          selectPanel(id: string) {
            selectedPanel = id;
          },
        };
      }
      return provided.get(name);
    },
    provide(name: string, value: unknown) {
      provided.set(name, value);
    },
    effect() {},
  } as unknown as Context;

  installScheduleNavigation(ctx);
  assert.ok(provided.get('scheduleNavigation'));
  assert.equal(openScheduleTask(ctx, 'schedule-123'), true);
  assert.equal(selectedPanel, 'schedules');
  assert.equal(createScheduleNavigation(ctx).openTask(''), false);
});
