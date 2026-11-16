import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply } from '../index.js';
import { apply as applySession } from '../session.js';

function fixture() {
  let service, close;
  apply({ effect: setup => { close = setup(); }, provide: (_name, value) => { service = value; } });
  const owner = name => ({ fiber: { entry: { options: { name } } } });
  const access = { scope: { workspaceId: 'one', projectIds: ['project'] }, binding: 'session-generation',
    grants: { 'example.list': '@example/context' }, signal: new AbortController().signal, assertCurrent() {} };
  const item = id => ({ workspaceId: 'one', projectId: 'project', ref: { kind: 'example.item', id } });
  const base = { id: 'example.list', protocol: 1, source: '示例', description: '列表', scope: 'project',
    filters: { state: { type: 'string', description: '状态', enum: ['active'] } } };
  return { service, owner, access, item, base, close };
}

test('只发现当前授权的注册者，并检查筛选和每条结果的归属', async () => {
  const { service, owner, access, item, base, close } = fixture();
  service.register(owner('@example/other'), { ...base, read: () => assert.fail('未经授权的注册者被调用') });
  assert.equal(service.catalog(access).capabilities[0].status, 'unavailable');
  const unregister = service.register(owner('@example/context'), { ...base, read: () => ({
    items: [{ ...item('different-workspace'), workspaceId: 'two' }], more: false, revision: '1',
  }) });
  assert.equal(service.catalog(access).capabilities[0].status, 'available');
  const query = { capability: base.id };
  assert.equal((await service.query(access, { ...query, filter: { state: 'unknown' } })).status, 'invalid_query');
  assert.equal((await service.query(access, { ...query, workspaceId: 'two' })).status, 'invalid_query');
  assert.equal((await service.query(access, query)).status, 'unavailable');
  assert.equal((await service.query({ ...access, grants: {} }, query)).status, 'denied');
  unregister();
  service.register(owner('@example/context'), { ...base, read: () => ({
    items: [{ ...item('different-project'), projectId: 'private' }], more: false, revision: '1',
  }) });
  assert.equal((await service.query(access, query)).status, 'unavailable');
  close();
});

test('分页绑定调用身份、查询条件和来源代次', async () => {
  const { service, owner, access, item, base, close } = fixture();
  let revision = 'one';
  const register = () => service.register(owner('@example/context'), { ...base, read: ({ offset }) => ({
    items: [item(String(offset))], more: offset === 0, revision,
  }) });
  const unregister = register();
  const query = { capability: base.id, limit: 1, filter: { state: 'active' } };
  const first = await service.query(access, query);
  assert.equal(first.complete, false);
  const next = { ...query, cursor: first.nextCursor };
  assert.equal((await service.query(access, next)).items[0].ref.id, '1');
  assert.equal((await service.query({ ...access, binding: 'new-authorization' }, next)).status, 'cursor_stale');
  assert.equal((await service.query(access, { ...next, filter: {} })).status, 'cursor_stale');
  revision = 'two';
  assert.equal((await service.query(access, next)).status, 'cursor_stale');
  unregister();
  register();
  assert.equal((await service.query(access, next)).status, 'cursor_stale');
  close();
});

test('读取过程中卸载或撤回授权时丢弃在途结果', async () => {
  const { service, owner, access, item, base, close } = fixture();
  let finish, active = true;
  const register = () => service.register(owner('@example/context'), { ...base, read: () => new Promise(resolve => { finish = resolve; }) });
  const result = { items: [item('private')], more: false, revision: '1' };
  const unregister = register();
  const query = { capability: base.id };
  const pending = service.query(access, query);
  await Promise.resolve();
  unregister();
  finish(result);
  assert.equal((await pending).status, 'unavailable');
  register();
  const revoked = service.query({ ...access, assertCurrent() { assert.ok(active, '授权已撤回'); } }, query);
  await Promise.resolve();
  active = false;
  finish(result);
  await assert.rejects(revoked, /授权已撤回/);
  close();
});

test('session.list 能力默认暴露 all-sessions 范围并跨工作区汇总已完成会话', async () => {
  const { service, owner, access, close } = fixture();
  let closeSession;
  applySession({
    ...owner('@local/dsh-workspace-context/session'),
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
      get: id => {
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
    effect: setup => { closeSession = setup(); },
  });
  const sessionAccess = { ...access, grants: { 'session.list': '@local/dsh-workspace-context/session' } };
  const cat = service.catalog(sessionAccess);
  assert.equal(cat.capabilities[0].status, 'available');
  assert.equal(cat.capabilities[0].readScope, 'all-sessions');
  const res = await service.query(sessionAccess, { capability: 'session.list', filter: { status: 'completed' } });
  assert.equal(res.status, 'ok');
  assert.equal(res.readScope, 'all-sessions');
  assert.deepEqual(res.items.map(i => [i.sessionId, i.workspaceId, i.title]), [
    ['s-two', 'two', '跨工作区接口重构'],
    ['s-one', 'one', '修复登录鉴权'],
  ]);
  closeSession?.();
  close();
});

test('listRegistered 暴露宿主已挂载候选插件元信息且随注销实时移除', () => {
  const { service, owner, base, close } = fixture();
  const offA = service.register(owner('@local/dsh-pomodoro-clock'), {
    ...base,
    id: 'pomodoro.focus',
    source: '番茄钟专注计时器',
    description: '读取专注计时统计',
    scope: 'workspace',
    read: () => ({ items: [], more: false, revision: '1' }),
  });
  const offB = service.register(owner('@example/context'), {
    ...base,
    read: () => ({ items: [], more: false, revision: '1' }),
  });
  assert.deepEqual(
    service.listRegistered().map(item => [item.id, item.provider, item.source, item.scope]),
    [
      ['example.list', '@example/context', '示例', 'project'],
      ['pomodoro.focus', '@local/dsh-pomodoro-clock', '番茄钟专注计时器', 'workspace'],
    ],
  );
  offA();
  assert.deepEqual(
    service.listRegistered().map(item => [item.id, item.provider]),
    [['example.list', '@example/context']],
  );
  offB();
  assert.deepEqual(service.listRegistered(), []);
  close();
});
