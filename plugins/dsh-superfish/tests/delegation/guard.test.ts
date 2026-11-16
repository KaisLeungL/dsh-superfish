import assert from 'node:assert/strict';
import { test } from 'node:test';
import { delegationTargetRejection } from '../../src/app/delegation/guard.js';

const request = { operationId: 'delegate:call-1', taskId: 'task-1' };
const board = (permission: string | undefined) => ({ tasks: [{ id: 'task-1', permission }] });

test('已存在的看板卡片允许继续派工（无论权限为只读、默认或工作区可写，执行门禁由看板裁决）', () => {
  for (const permission of ['read-only', 'workspace-write', 'danger-full-access', undefined]) {
    assert.equal(delegationTargetRejection(board(permission), request), undefined);
  }
});

test('目标卡片不可用时拒绝', () => {
  assert.deepEqual(delegationTargetRejection({ tasks: [] }, request), {
    state: 'rejected',
    operationId: request.operationId,
    taskId: request.taskId,
    reason: '目标看板卡片不可用。',
  });
  assert.equal(delegationTargetRejection(undefined, request)?.state, 'rejected');
});
