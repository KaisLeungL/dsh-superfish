import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearCachedPersonalSnapshot,
  getCachedPersonalSnapshot,
  isPersonalSessionRunning,
  publishPersonalSnapshot,
  requestPersonalRefresh,
  setPersonalSessionRunning,
  subscribePersonalRefresh,
  subscribePersonalSessionRunning,
  subscribePersonalSnapshot,
} from '../../src/client/personal-sync.js';

test('personal-sync 广播快照、缓存读取与清理、刷新信号与运行态并支持取消订阅及错误隔离', () => {
  const snapshots: unknown[] = [];
  const refreshes: string[] = [];
  const runEvents: Array<[string, boolean]> = [];

  clearCachedPersonalSnapshot();
  assert.equal(getCachedPersonalSnapshot('session-a'), undefined);

  const unsubBadSnap = subscribePersonalSnapshot(() => {
    throw new Error('broken-subscriber');
  });
  const unsubSnap = subscribePersonalSnapshot<{ ok: boolean; rev: number }>(event => {
    snapshots.push(event);
  });
  const unsubRefresh = subscribePersonalRefresh(sessionId => {
    refreshes.push(sessionId);
  });
  const unsubRun = subscribePersonalSessionRunning((sessionId, running) => {
    runEvents.push([sessionId, running]);
  });

  try {
    publishPersonalSnapshot('session-a', { ok: true, rev: 1 });
    assert.deepEqual(snapshots, [{ sessionId: 'session-a', snapshot: { ok: true, rev: 1 } }]);
    assert.deepEqual(getCachedPersonalSnapshot('session-a'), { ok: true, rev: 1 });
    assert.equal(getCachedPersonalSnapshot(''), undefined);

    clearCachedPersonalSnapshot('session-a');
    assert.equal(getCachedPersonalSnapshot('session-a'), undefined);

    publishPersonalSnapshot('session-a', { ok: true, rev: 2 });
    clearCachedPersonalSnapshot();
    assert.equal(getCachedPersonalSnapshot('session-a'), undefined);

    requestPersonalRefresh('session-a');
    requestPersonalRefresh('');
    assert.deepEqual(refreshes, ['session-a']);

    assert.equal(isPersonalSessionRunning('session-a'), false);
    setPersonalSessionRunning('session-a', true);
    setPersonalSessionRunning('session-a', true);
    setPersonalSessionRunning('session-a', false);
    assert.equal(isPersonalSessionRunning('session-a'), false);
    assert.deepEqual(runEvents, [['session-a', true], ['session-a', false]]);
  } finally {
    unsubBadSnap();
    unsubSnap();
    unsubRefresh();
    unsubRun();
  }
});
