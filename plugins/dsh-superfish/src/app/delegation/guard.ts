import type { BoardLaunchReceipt } from './launch.js';

/** 看板当前任务快照里与派工有关的字段。 */
export interface DelegationTargetSnapshot {
  readonly tasks?: readonly { readonly id: string; readonly permission?: string }[];
}

export interface DelegationTargetRequest {
  readonly operationId: string;
  readonly taskId: string;
}

/**
 * 派工前置校验：验证目标卡片在当前看板快照中存在；具体执行权限基线与确认门禁由看板自身规则裁决。
 * 返回 undefined 表示可继续派工；否则返回持久的拒绝回执。
 */
export function delegationTargetRejection(
  snapshot: DelegationTargetSnapshot | undefined,
  request: DelegationTargetRequest,
): BoardLaunchReceipt | undefined {
  const target = snapshot?.tasks?.find(item => item.id === request.taskId);
  if (!target) {
    return { state: 'rejected', operationId: request.operationId, taskId: request.taskId, reason: '目标看板卡片不可用。' };
  }
  return undefined;
}
