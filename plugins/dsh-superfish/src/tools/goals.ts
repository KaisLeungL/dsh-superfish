import type { GoalService, GoalStatus, MilestoneStatus } from '../app/goals/service.js';
import {
  CallerAuthority,
  CallerDenied,
  GOAL_TOOLS,
  GOAL_WRITE_TOOLS,
  type CallerAgent,
  type Invocation,
} from './authority.js';

export interface GoalToolInvocation<A extends CallerAgent> extends Invocation<A> {
  readonly name: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const asRecord = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) throw new CallerDenied('INVALID_ARGUMENTS', '工具参数必须是对象。');
  return value;
};

export function goalReadToolDefinitions<A extends CallerAgent>(
  authority: CallerAuthority<A>,
  goalServiceProvider: () => GoalService | undefined,
) {
  return [
    {
      name: GOAL_TOOLS[0],
      description: '读取当前工作区的长周期目标（Goals）及其各阶段里程碑（Milestones）执行进度。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: {
            enum: ['active', 'paused', 'completed', 'failed'],
            description: '可选状态过滤（默认返回全部长周期目标）。',
          },
        },
        required: [],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (rawArgs: unknown, exec: GoalToolInvocation<A>) => {
        const lease = authority.capture(exec);
        lease.require(GOAL_TOOLS[0], 'read');
        if (!(lease.role === 'router' && lease.foreground) && lease.role !== 'scheduled') {
          throw new CallerDenied('GOAL_READ_DENIED', '只有前台大肥鱼或定时会话可查询长周期目标。');
        }
        const input = asRecord(rawArgs === undefined ? {} : rawArgs);
        const status = input.status as GoalStatus | undefined;
        if (status !== undefined && !['active', 'paused', 'completed', 'failed'].includes(status)) {
          throw new CallerDenied('INVALID_ARGUMENTS', '目标状态过滤值无效。');
        }
        const svc = goalServiceProvider();
        const goals = svc ? svc.listGoals(status) : [];
        return {
          status: 'ok',
          total: goals.length,
          items: goals,
        };
      },
    },
  ];
}

export function goalWriteToolDefinitions<A extends CallerAgent>(
  goalServiceProvider: () => GoalService | undefined,
  checkForegroundRouter: (exec: GoalToolInvocation<A>) => { session: string; turn: number },
  ensureBoardTask?: (
    session: string,
    idOrTitle: string,
    fallback: { title: string; description?: string; prompt?: string; mode?: string },
  ) => Promise<string | undefined>,
  deleteBoardTasks?: (input: {
    readonly title?: string;
    readonly milestones?: readonly { readonly title?: string; readonly boardTaskId?: string | null }[];
  }) => Promise<string[]>,
) {
  return [
    {
      name: GOAL_WRITE_TOOLS[0],
      description: '创建或推进跨轮次的长周期目标状态机（Goal State Machine），支持拆解多阶段里程碑（Milestones）、绑定看板任务卡片 ID 并开启前序完成后自动推进下一阶段。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            enum: ['create', 'update_milestone', 'update_status', 'delete'],
            description: '操作类型：create（新建多阶段目标）、update_milestone（更新里程碑状态或绑定看板卡片 ID）、update_status（暂停/恢复/完结整个目标）、delete（删除长周期目标）。',
          },
          goalId: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
            description: '目标 ID（update_milestone / update_status / delete 时必填）。',
          },
          title: {
            type: 'string',
            minLength: 1,
            maxLength: 120,
            description: '长周期目标标题（create 时必填）。',
          },
          description: {
            type: 'string',
            maxLength: 2000,
            description: '长周期目标背景与验收标准描述。',
          },
          autoAdvance: {
            type: 'boolean',
            description: '前一个里程碑绑定的看板任务完成后，是否自动派发下一个待办里程碑（默认 true）。',
          },
          milestones: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string', minLength: 1, maxLength: 160 },
                boardTaskId: { type: 'string', maxLength: 128 },
                agentPreset: { type: 'string', maxLength: 128 },
              },
              required: ['title'],
            },
            description: '阶段里程碑列表（create 时必填）。',
          },
          milestoneId: {
            type: 'string',
            maxLength: 128,
            description: '要更新的里程碑 ID（update_milestone 时必填）。',
          },
          status: {
            enum: ['pending', 'running', 'completed', 'failed', 'active', 'paused'],
            description: '目标状态或里程碑状态。',
          },
          boardTaskId: {
            type: 'string',
            maxLength: 128,
            description: '绑定到该里程碑的看板任务卡片 ID。',
          },
          summary: {
            type: 'string',
            maxLength: 1000,
            description: '里程碑阶段产出或复盘摘要。',
          },
        },
        required: ['action'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (rawArgs: unknown, exec: GoalToolInvocation<A>) => {
        const { session } = checkForegroundRouter(exec);
        const svc = goalServiceProvider();
        if (!svc) {
          throw new CallerDenied('GOAL_SERVICE_UNAVAILABLE', '当前工作区未启用长周期目标服务。');
        }
        const input = asRecord(rawArgs);
        const action = input.action;
        if (action === 'create') {
          if (typeof input.title !== 'string' || !input.title.trim()) {
            throw new CallerDenied('INVALID_ARGUMENTS', '创建目标必须提供 title。');
          }
          if (!Array.isArray(input.milestones) || input.milestones.length < 1 || input.milestones.length > 20) {
            throw new CallerDenied('INVALID_ARGUMENTS', '创建目标必须提供 1~20 个 milestones。');
          }
          const goalTitle = input.title.trim();
          const goalDesc = typeof input.description === 'string' ? input.description.trim() : '';
          const milestones = await Promise.all(
            input.milestones.map(async raw => {
              const m = asRecord(raw);
              if (typeof m.title !== 'string' || !m.title.trim()) {
                throw new CallerDenied('INVALID_ARGUMENTS', '每个里程碑必须包含 title。');
              }
              const mTitle = m.title.trim();
              const mPreset = typeof m.agentPreset === 'string' && m.agentPreset.trim() ? m.agentPreset.trim() : undefined;
              let boardTaskId = typeof m.boardTaskId === 'string' && m.boardTaskId.trim() ? m.boardTaskId.trim() : undefined;
              if (boardTaskId && ensureBoardTask) {
                const resolved = await ensureBoardTask(session, boardTaskId, {
                  title: mTitle,
                  description: goalDesc || mTitle,
                  prompt: goalDesc ? `${mTitle}\n\n所属长周期目标：${goalTitle}\n${goalDesc}` : mTitle,
                  ...(mPreset ? { mode: mPreset } : {}),
                }).catch(() => undefined);
                if (resolved) boardTaskId = resolved;
              }
              return {
                title: mTitle,
                ...(boardTaskId ? { boardTaskId } : {}),
                ...(mPreset ? { agentPreset: mPreset } : {}),
              };
            }),
          );
          const goal = svc.createGoal({
            title: input.title,
            ...(typeof input.description === 'string' ? { description: input.description } : {}),
            ...(typeof input.autoAdvance === 'boolean' ? { autoAdvance: input.autoAdvance } : {}),
            milestones,
          });
          return { status: 'ok', action: 'created', goal };
        }
        if (action === 'update_milestone') {
          if (typeof input.goalId !== 'string' || !input.goalId.trim() || typeof input.milestoneId !== 'string' || !input.milestoneId.trim()) {
            throw new CallerDenied('INVALID_ARGUMENTS', 'update_milestone 必须提供 goalId 与 milestoneId。');
          }
          const goalId = input.goalId.trim();
          const milestoneId = input.milestoneId.trim();
          const msStatus = input.status as MilestoneStatus | undefined;
          if (msStatus !== undefined && !['pending', 'running', 'completed', 'failed'].includes(msStatus)) {
            throw new CallerDenied('INVALID_ARGUMENTS', '里程碑 status 必须是 pending / running / completed / failed。');
          }
          let boardTaskId = typeof input.boardTaskId === 'string' ? input.boardTaskId.trim() : undefined;
          if (boardTaskId && ensureBoardTask) {
            const existingGoal = svc.getGoal(goalId);
            const existingMs = existingGoal?.milestones.find(m => m.id === milestoneId);
            const mTitle = existingMs?.title || boardTaskId;
            const resolved = await ensureBoardTask(session, boardTaskId, {
              title: mTitle,
              description: existingGoal?.description || mTitle,
              prompt: existingGoal?.description ? `${mTitle}\n\n所属长周期目标：${existingGoal.title}\n${existingGoal.description}` : mTitle,
              ...(existingMs?.agentPreset ? { mode: existingMs.agentPreset } : {}),
            }).catch(() => undefined);
            if (resolved) boardTaskId = resolved;
          }
          const transition = svc.updateMilestone({
            goalId,
            milestoneId,
            ...(msStatus ? { status: msStatus } : {}),
            ...(boardTaskId !== undefined ? { boardTaskId } : {}),
            ...(typeof input.summary === 'string' ? { summary: input.summary.trim() } : {}),
          });
          return { status: 'ok', action: 'milestone_updated', ...transition };
        }
        if (action === 'update_status') {
          if (typeof input.goalId !== 'string' || !input.goalId.trim() || typeof input.status !== 'string') {
            throw new CallerDenied('INVALID_ARGUMENTS', 'update_status 必须提供 goalId 与 status。');
          }
          if (!['active', 'paused', 'completed', 'failed'].includes(input.status)) {
            throw new CallerDenied('INVALID_ARGUMENTS', '目标 status 必须是 active / paused / completed / failed。');
          }
          const goal = svc.updateGoalStatus(input.goalId.trim(), input.status as GoalStatus);
          return { status: 'ok', action: 'status_updated', goal };
        }
        if (action === 'delete') {
          if (typeof input.goalId !== 'string' || !input.goalId.trim()) {
            throw new CallerDenied('INVALID_ARGUMENTS', 'delete 必须提供 goalId。');
          }
          const goalId = input.goalId.trim();
          const existingGoal = svc.getGoal(goalId);
          let deletedBoardTaskIds: string[] = [];
          if (existingGoal && deleteBoardTasks) {
            deletedBoardTaskIds = await deleteBoardTasks(existingGoal).catch(() => []);
          }
          const deleted = svc.deleteGoal(goalId);
          return { status: 'ok', action: 'deleted', goalId, deleted, deletedBoardTaskIds };
        }
        throw new CallerDenied('INVALID_ARGUMENTS', '未知的 action 类型。');
      },
    },
  ];
}
