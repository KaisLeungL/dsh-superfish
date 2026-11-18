import type { DelegateInvocation } from './delegate.js';
import type { WorkerTask } from '../app/delegation/worker-session.js';

export const WORKER_SESSION_TOOLS = ['steward_submit_task', 'steward_read_worker', 'steward_cancel_worker', 'steward_resume_worker'] as const;
export function readWorkerTask(value: unknown): WorkerTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('WORKER_INVALID_ARGUMENTS');
  const r = value as Record<string, unknown>;
  if (Object.keys(r).some(key => !['title', 'instruction'].includes(key)) ||
      typeof r.title !== 'string' || !r.title.trim() || r.title.length > 200 ||
      typeof r.instruction !== 'string' || !r.instruction.trim() || r.instruction.length > 24000) throw Error('WORKER_INVALID_ARGUMENTS');
  return { title: r.title.trim(), instruction: r.instruction.trim() };
}
export function readWorkerOperation(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('WORKER_INVALID_ARGUMENTS');
  const r = value as Record<string, unknown>;
  if (Object.keys(r).length !== 1 || typeof r.operationId !== 'string' || !r.operationId || r.operationId.length > 512) throw Error('WORKER_INVALID_ARGUMENTS');
  return r.operationId;
}
export function workerSessionToolDefinitions<A extends { readonly id: string }>(
  execute: (name: string, args: unknown, exec: DelegateInvocation<A>) => Promise<unknown>,
) {
  return WORKER_SESSION_TOOLS.map((name, index) => ({
    name,
    description: index === 0
      ? '用户交办执行类任务（拉取/克隆仓库、安装、构建、改文件、跑命令等）时的第一步动作：把任务交给新建的普通执行会话，不需要先建看板卡片。传入独立可执行的任务说明，保留用户范围、上下文与验收要求。主会话不直接执行命令；不要因为主会话没有 shell/git 就拒绝交办。返回 accepted 仅表示已提交，unknown 时核实原操作，禁止另起同一任务。'
      : index === 1 ? '读取本大肥鱼委派的指定 Worker 会话的真实状态与最近结果。operationId 必须来自提交任务的真实回执。'
      : index === 2 ? '请求取消本大肥鱼委派的指定 Worker 执行。返回状态未停止时不能宣称取消完成，待处理队列仍须核实。'
      : '在用户要求继续时恢复原 operationId 对应的未决提交，仅核实原会话和重试幂等提交，不新建另一个会话；已取消请求不恢复。',
    parameters: index === 0 ? {
      type: 'object', additionalProperties: false, required: ['title', 'instruction'],
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200 },
        instruction: { type: 'string', minLength: 1, maxLength: 24000 },
      },
    } : {
      type: 'object', additionalProperties: false, required: ['operationId'],
      properties: { operationId: { type: 'string', minLength: 1, maxLength: 512 } },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    execute: (args: unknown, exec: DelegateInvocation<A>) => execute(name, args, exec),
  }));
}
