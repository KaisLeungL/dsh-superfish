import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerCreateRejected, WorkerSessionService, type WorkerObservation, type WorkerSessionHost } from '../../src/app/delegation/worker-session.js';
import { readWorkerOperation, readWorkerTask } from '../../src/tools/worker-session.js';
function fixture(t: TestContext) {
  const path = join(mkdtempSync(join(tmpdir(), 'dsh-worker-session-')), 'workers.sqlite');
  const sessions = new Set<string>(), prompts = new Set<string>();
  let createCount = 0, submitCount = 0, prepareCount = 0, cancelCount = 0, available = true;
  let loseCreate = false, loseSubmit = false, rejectCreate = false;
  let observation: WorkerObservation = { status: 'running' };
  const host: WorkerSessionHost = {
    assertCurrent(owner) { if (!available || owner !== 'router') throw Error('SCOPE_CHANGED'); },
    async exists(id) { return sessions.has(id); },
    async create(id) { createCount++; if (rejectCreate) throw new WorkerCreateRejected('PRESET_UNAVAILABLE'); sessions.add(id); if (loseCreate) throw Error('lost'); return { sessionId: id }; },
    async prepare() { prepareCount++; },
    async submit(_id, requestId) { if (!prompts.has(requestId)) { prompts.add(requestId); submitCount++; } if (loseSubmit) throw Error('lost'); },
    async observe() { return observation; },
    async cancel() { cancelCount++; },
  };
  let service = new WorkerSessionService(path, host);
  t.after(() => service.close());
  return { get service() { return service; }, counts: () => ({ createCount, submitCount, prepareCount, cancelCount }),
    restart() { service.close(); service = new WorkerSessionService(path, host); },
    loseCreate(value: boolean) { loseCreate = value; }, loseSubmit(value: boolean) { loseSubmit = value; },
    rejectCreate(value: boolean) { rejectCreate = value; },
    available(value: boolean) { available = value; }, observe(value: WorkerObservation) { observation = value; } };
}
const signal = () => new AbortController().signal;
const task = { title: '拉取仓库', instruction: '把用户指定仓库拉到当前工作区，核验分支和提交。' };
test('新任务无需看板，创建执行会话并只提交一次', async t => {
  const f = fixture(t);
  const [a, b] = await Promise.all([f.service.start('router', 'op', task, signal()), f.service.start('router', 'op', task, signal())]);
  assert.equal(a.sessionId, b.sessionId); assert.equal(a.phase, 'accepted');
  assert.deepEqual(f.counts(), { createCount: 1, submitCount: 1, prepareCount: 1, cancelCount: 0 });
  assert.equal((await f.service.read('router', 'op', signal())).status, 'running');
});
test('创建提交后丢回执，重启按原 ID 核实，不重复创建', async t => {
  const f = fixture(t); f.loseCreate(true);
  const a = await f.service.start('router', 'op', task, signal());
  assert.equal(a.phase, 'creating'); f.restart(); f.loseCreate(false);
  const b = await f.service.resume('router', 'op', signal());
  assert.equal(b.sessionId, a.sessionId); assert.equal(b.phase, 'accepted');
  assert.equal(f.counts().createCount, 1); assert.equal(f.counts().submitCount, 1);
});
test('prompt 丢回执，恢复沿用原 requestId 去重', async t => {
  const f = fixture(t); f.loseSubmit(true);
  assert.equal((await f.service.start('router', 'op', task, signal())).phase, 'submitting');
  f.restart(); f.loseSubmit(false);
  assert.equal((await f.service.resume('router', 'op', signal())).phase, 'accepted');
  assert.equal(f.counts().createCount, 1); assert.equal(f.counts().submitCount, 1);
});
test('确定的创建拒绝保留原因，恢复时按原身份安全重试', async t => {
  const f = fixture(t); f.rejectCreate(true);
  const a = await f.service.start('router', 'op', task, signal());
  assert.equal(a.phase, 'rejected'); assert.equal(a.reason, 'PRESET_UNAVAILABLE');
  assert.equal((await f.service.read('router', 'op', signal())).status, 'failed');
  f.restart(); f.rejectCreate(false);
  const b = await f.service.resume('router', 'op', signal());
  assert.equal(b.sessionId, a.sessionId); assert.equal(b.phase, 'accepted');
  assert.equal(f.counts().submitCount, 1);
});
test('跨主理、变更参数与撤销授权均拒绝', async t => {
  const f = fixture(t); await f.service.start('router', 'op', task, signal());
  await assert.rejects(f.service.read('other', 'op', signal()), /SCOPE_CHANGED/);
  await assert.rejects(f.service.start('router', 'op', { ...task, instruction: '另一项任务' }, signal()), /WORKER_OPERATION_CONFLICT/);
  f.available(false);
  await assert.rejects(f.service.resume('router', 'op', signal()), /SCOPE_CHANGED/);
});
test('取消请求持久记录，不能误报已停止或在恢复时重新提交', async t => {
  const f = fixture(t); f.loseSubmit(true);
  await f.service.start('router', 'op', task, signal());
  assert.equal((await f.service.cancel('router', 'op', signal())).status, 'running');
  f.restart(); f.loseSubmit(false);
  assert.equal((await f.service.resume('router', 'op', signal())).phase, 'cancelling');
  assert.equal(f.counts().submitCount, 1);
  f.observe({ status: 'cancelled', cursor: 40 });
  assert.equal((await f.service.read('router', 'op', signal())).status, 'cancelled');
});
test('完成通知持久去重，重启保留未投递内容', async t => {
  const f = fixture(t); await f.service.start('router', 'op', task, signal());
  f.observe({ status: 'completed', summary: '已克隆并验证。', cursor: 100 });
  const a = await f.service.notices('router', signal()); assert.equal(a.length, 1);
  f.restart();
  const b = await f.service.notices('router', signal()); assert.deepEqual(b, a);
  f.service.delivered('router', b[0]!.id);
  assert.deepEqual(await f.service.notices('router', signal()), []);
});
test('模型参数不能指定权限、预设、工作区或任意会话', () => {
  assert.deepEqual(readWorkerTask(task), task);
  for (const key of ['permission', 'agentPreset', 'workspaceId', 'sessionId']) assert.throws(() => readWorkerTask({ ...task, [key]: 'unsafe' }));
  assert.throws(() => readWorkerOperation({ operationId: 'op', sessionId: 'other' }));
});
