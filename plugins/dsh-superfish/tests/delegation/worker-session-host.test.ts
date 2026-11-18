import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeWorkerSessionHost, type WorkerExecution } from '../../src/app/delegation/worker-session-host.js';
import { WorkerCreateRejected } from '../../src/app/delegation/worker-session.js';
function fixture(execution?: WorkerExecution, resolvePreset = async (_id?: string): Promise<{ id: string }> => { throw Error('NO_PRESET'); }) {
  const inbox = { nextTurn: [{ id: 'own', source: { rpcId: 'request' } }, { id: 'other', source: { rpcId: 'unrelated' } }], nextStep: [] };
  const calls: string[] = [];
  const agent = { session: { id: 'worker', header: { cwd: '/workspace', agentPreset: 'default' } }, inbox,
    model: { select(selection: { model: string }) { calls.push('model:' + selection.model); } } };
  let end: object | undefined = { type: 'turn/end', seq: 10, time: 5000, data: { reason: { kind: 'completed' } } };
  const services: Record<string, unknown> = {
    sessionController: {
      async create(request: { sessionId: string; agentPreset: string }) {
        calls.push('create:' + request.agentPreset);
        return { sessionId: request.sessionId };
      },
      async rename() {},
      async resolveAgent() { return { agent }; },
      async updateQueue(request: { itemId: string; action: { kind: string } }) {
        calls.push('remove:' + request.itemId); assert.equal(request.action.kind, 'remove');
        inbox.nextTurn = inbox.nextTurn.filter(message => message.id !== request.itemId);
      },
      cancel() { calls.push('cancel'); },
      async state() { return { active: true, running: false, queue: [], pendingInput: [] }; },
      async events() { return { records: end ? [{ type: 'event', event: end }] : [], cursor: 10 }; },
    },
    agentPresets: { resolve: resolvePreset },
    permissionPresets: {
      resolve(name: string) { return { sandbox: name, approval: 'ask' }; },
      set(_session: unknown, name: string) { calls.push('permission:' + name); },
    },
    sessionPersistence: {}, sessions: { async flush() { return true; } },
    workspaceRegistry: { get() { return { async attachSession() {} }; } },
  };
  return { host: nativeWorkerSessionHost({ get: name => services[name] }, 'W', '/workspace', () => {}, execution),
    calls, inbox, noEnd() { end = undefined; } };
}
test('普通交办固定使用大肥鱼的执行后端及沙盒配置', async () => {
  const f = fixture({ agentPreset: 'minimal', permission: 'read-only', model: { provider: 'fixture', model: 'worker-model' } },
    async id => ({ id: id ?? 'global-default' }));
  await f.host.create('worker');
  await f.host.prepare('worker', '独立执行');
  assert.deepEqual(f.calls, ['create:minimal', 'permission:read-only', 'model:worker-model']);
});
test('取消只删除本次请求的队列项，再取消活动执行', async () => {
  const f = fixture(); await f.host.cancel('worker', 'request', new AbortController().signal);
  assert.deepEqual(f.calls, ['remove:own', 'cancel']);
  assert.deepEqual(f.inbox.nextTurn.map(message => message.id), ['other']);
});
test('无预设的前置拒绝有明确类型，不伪造未知创建', async () => {
  const f = fixture(); await assert.rejects(f.host.create('worker'), WorkerCreateRejected);
});
test('结果从真实 turn/end 判定，并保留事件时间', async () => {
  const f = fixture(); const result = await f.host.observe('worker', new AbortController().signal);
  assert.equal(result.status, 'completed'); assert.equal(result.observedAt, 5000); assert.equal(result.quiescent, true);
  f.noEnd(); assert.equal((await f.host.observe('worker', new AbortController().signal)).status, 'unknown');
});
