import { SCHEDULED_PROMPT } from '../prompts/package.js';
import type { RuntimeContext, NativeAgent } from './runtime.js';
export const inject = ['tools', 'systemPrompt'];
/** 稳定外层不依赖可撤回 runtime；缺当前 attachment 时一直默认拒绝。 */
export function apply(ctx: RuntimeContext & { inject(names: string[], callback: (scope: RuntimeContext) => void): unknown }, config: { scheduleOnly?: boolean } = {}): void {
  if (config.scheduleOnly === true) { scheduled(ctx); return; }
  ctx.tools.restrict({ allow: [] });
  ctx.tools.guard(exec => {
    const runtime = ctx.get('workspaceSuperagentRuntime') as { isPublished(agent: NativeAgent): boolean } | undefined;
    return exec.agent && runtime?.isPublished(exec.agent) ? undefined : '当前安装已关闭，拒绝调用。';
  });
  ctx.on('agent/created', raw => {
    const agent = (raw as { agent: NativeAgent }).agent;
    if (agent.inputAdmissionVersion !== 4 || typeof agent.requireInputAdmission !== 'function') throw Error('PRECLAIM_CAPABILITY_REQUIRED');
    agent.requireInputAdmission();
  });
  // 内层 provider/consumer 在同一 realm；只追踪当前 runtime，不重 mount published Agent。
  ctx.inject(['workspaceSuperagentRuntime'], scope => {
    const runtime = scope.get('workspaceSuperagentRuntime') as { installWorkerScope(scope: RuntimeContext): void };
    runtime.installWorkerScope(scope);
  });
}

/** 定时会话仅授予当前工作区受控只读工具，禁止写操作、派工、网络与任意执行。 */
export function scheduled(ctx: RuntimeContext & { inject?(names: string[], callback: (scope: RuntimeContext) => void): unknown }): void {
  ctx.tools.restrict({ allow: [] });
  ctx.tools.guard(exec => {
    const runtime = ctx.get('workspaceSuperagentRuntime') as { checkScheduledTool?(exec: unknown): string | undefined } | undefined;
    return runtime && typeof runtime.checkScheduledTool === 'function'
      ? runtime.checkScheduledTool(exec)
      : '当前大肥鱼运行时未就绪，定时会话暂不可调用工具。';
  });
  ctx.systemPrompt.section({ name: 'workspace-superagent-scheduled', order: 50, text: SCHEDULED_PROMPT });
  if (typeof ctx.inject === 'function') {
    ctx.inject(['workspaceSuperagentRuntime'], scope => {
      const runtime = scope.get('workspaceSuperagentRuntime') as { installScheduledScope?(scope: RuntimeContext): void } | undefined;
      runtime?.installScheduledScope?.(scope);
    });
  } else {
    const runtime = ctx.get('workspaceSuperagentRuntime') as { installScheduledScope?(scope: RuntimeContext): void } | undefined;
    runtime?.installScheduledScope?.(ctx);
  }
}
