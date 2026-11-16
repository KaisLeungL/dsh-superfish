import type { GoalAdvanceTransition, GoalService } from '../goals/service.js';

export type RoutineEventKind =
  | 'board_task_completed'
  | 'board_task_failed'
  | 'goal_milestone_auto_advanced'
  | 'goal_completed'
  | 'session_needs_input_stalled';

export interface RoutineEventNotification {
  readonly kind: RoutineEventKind;
  readonly timestamp: number;
  readonly title: string;
  readonly summary: string;
  readonly taskId?: string;
  readonly goalId?: string;
  readonly sessionId?: string;
  readonly nextBoardTaskId?: string;
}

export interface BoardExecutionObservation {
  readonly taskId: string;
  readonly taskTitle: string;
  readonly executionId: string;
  readonly status: 'completed' | 'failed';
  readonly summary?: string;
}

export interface SessionStatusObservation {
  readonly sessionId: string;
  readonly title: string;
  readonly status: string;
  readonly turnCount: number;
  readonly updatedAt: number;
}

export interface EventMonitorHost {
  readonly goalService?: GoalService;
  delegateNextBoardTask?(taskId: string, operationId: string): Promise<{ readonly state: string; readonly executionId?: string }>;
  onEventNotification?(event: RoutineEventNotification): void | Promise<void>;
  now?(): number;
  needsInputStallThresholdMs?: number;
}

/**
 * 事件驱动神经系统（Event-Driven Routines）：
 * 突破单纯的 HH:mm 日历闹钟限制，监听看板任务完结/报错与普通会话长时卡点（needs_input），
 * 自动驱动 Goal 状态机推进下一阶段子任务或触发主动提醒。
 */
export class EventMonitor {
  readonly #processedExecutions = new Set<string>();
  readonly #notifiedStalledSessions = new Map<string, number>();

  constructor(private readonly host: EventMonitorHost) {}

  #now(): number {
    return typeof this.host.now === 'function' ? this.host.now() : Date.now();
  }

  /**
   * 处理看板任务执行完毕或失败事件：
   * 1. 触发基础完成/失败事件；
   * 2. 若该任务关联了长周期 Goal 里程碑，自动推进里程碑状态；
   * 3. 若 Goal 开启了 autoAdvance 且存在下一阶段待执行看板卡，自动派工下一张卡片。
   */
  async handleBoardExecutionOutcome(obs: BoardExecutionObservation): Promise<{
    readonly transitions: readonly GoalAdvanceTransition[];
    readonly notifications: readonly RoutineEventNotification[];
  }> {
    const dedupeKey = `${obs.taskId}:${obs.executionId}:${obs.status}`;
    if (this.#processedExecutions.has(dedupeKey)) {
      return { transitions: Object.freeze([]), notifications: Object.freeze([]) };
    }
    this.#processedExecutions.add(dedupeKey);

    const now = this.#now();
    const notifications: RoutineEventNotification[] = [];
    const baseEvent: RoutineEventNotification = Object.freeze({
      kind: obs.status === 'completed' ? 'board_task_completed' : 'board_task_failed',
      timestamp: now,
      title: obs.status === 'completed' ? `看板任务已完成：${obs.taskTitle}` : `看板任务执行失败：${obs.taskTitle}`,
      summary: obs.summary ?? (obs.status === 'completed' ? '子代理已完成该看板任务。' : '子代理执行异常中断，请检查阻塞原因。'),
      taskId: obs.taskId,
    });
    notifications.push(baseEvent);
    await this.host.onEventNotification?.(baseEvent);

    const transitions = this.host.goalService
      ? this.host.goalService.onBoardTaskOutcome({
          taskId: obs.taskId,
          status: obs.status,
          ...(obs.summary ? { summary: obs.summary } : {}),
        })
      : [];

    for (const tr of transitions) {
      if (tr.goalCompleted) {
        const doneEvent: RoutineEventNotification = Object.freeze({
          kind: 'goal_completed',
          timestamp: now,
          title: `长周期目标全部达成：${tr.goal.title}`,
          summary: `共 ${tr.goal.milestones.length} 个阶段里程碑已全部执行完毕，请验收最终成果。`,
          goalId: tr.goal.id,
          taskId: obs.taskId,
        });
        notifications.push(doneEvent);
        await this.host.onEventNotification?.(doneEvent);
        continue;
      }

      if (tr.nextMilestone?.boardTaskId && this.host.delegateNextBoardTask) {
        const nextTaskId = tr.nextMilestone.boardTaskId;
        const opId = `goal-auto:${tr.goal.id}:${tr.nextMilestone.id}`;
        try {
          const delegated = await this.host.delegateNextBoardTask(nextTaskId, opId);
          if (delegated.state === 'accepted' && this.host.goalService) {
            this.host.goalService.updateMilestone({
              goalId: tr.goal.id,
              milestoneId: tr.nextMilestone.id,
              status: 'running',
            });
          }
          const advEvent: RoutineEventNotification = Object.freeze({
            kind: 'goal_milestone_auto_advanced',
            timestamp: now,
            title: `长周期目标自动推进：${tr.goal.title}`,
            summary: `前序阶段「${tr.updatedMilestone.title}」已完成，已自动派发下一阶段「${tr.nextMilestone.title}」（状态：${delegated.state}）。`,
            goalId: tr.goal.id,
            taskId: obs.taskId,
            nextBoardTaskId: nextTaskId,
          });
          notifications.push(advEvent);
          await this.host.onEventNotification?.(advEvent);
        } catch {
          // 自动派发异常不阻断通知链
        }
      }
    }

    return Object.freeze({
      transitions: Object.freeze(transitions),
      notifications: Object.freeze(notifications),
    });
  }

  /**
   * 巡检普通会话列表，识别处于 `needs_input` 超过阈值的卡点会话并触发主动关怀通知。
   */
  async inspectStalledSessions(
    sessions: readonly SessionStatusObservation[],
  ): Promise<readonly RoutineEventNotification[]> {
    const now = this.#now();
    const threshold = this.host.needsInputStallThresholdMs ?? 30 * 60 * 1000;
    const emitted: RoutineEventNotification[] = [];

    for (const s of sessions) {
      if (s.status !== 'needs_input') continue;
      if (now - s.updatedAt < threshold) continue;
      const prevTurn = this.#notifiedStalledSessions.get(s.sessionId);
      if (prevTurn !== undefined && prevTurn >= s.turnCount) continue;

      this.#notifiedStalledSessions.set(s.sessionId, s.turnCount);
      const stallMinutes = Math.max(1, Math.round((now - s.updatedAt) / 60_000));
      const event: RoutineEventNotification = Object.freeze({
        kind: 'session_needs_input_stalled',
        timestamp: now,
        title: `会话等待输入超时提醒：${s.title}`,
        summary: `会话「${s.title}」已在等待确认状态（needs_input）停留约 ${stallMinutes} 分钟，建议及时处理以免阻塞后续进度。`,
        sessionId: s.sessionId,
      });
      emitted.push(event);
      await this.host.onEventNotification?.(event);
    }

    return Object.freeze(emitted);
  }
}
