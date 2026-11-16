import type { CapturedExecution, CapturedTask } from '../projections/types.js';
import type { DelegationRecord } from './launch.js';

/** 个人面板「近期活动」的一条活动记录（看板委派或大肥鱼定时任务触发）；只含可解释的状态和可信里程碑。 */
export interface DelegationActivityEvent { title: string; at: number; summary?: string }
export interface DelegationActivity {
  id: string; title: string; status: string; updatedAt: number;
  worker?: string; events: DelegationActivityEvent[]; taskId: string; sessionId?: string;
  kind?: 'delegation' | 'schedule_trigger';
  scheduleId?: string;
}

export interface ScheduleDeliverySnapshot {
  readonly scheduledAt: string;
  readonly deliveredAt: string;
  readonly messageId: string;
  readonly targetSessionId: string;
  readonly prompt?: string;
  readonly assistantSummary?: string;
  readonly completedAt?: number;
}

export interface ScheduleTriggerSource {
  readonly id: string;
  readonly title: string;
  readonly prompt?: string;
  readonly status: 'active' | 'paused' | 'ended';
  readonly executionActive?: boolean;
  readonly lastDelivery?: ScheduleDeliverySnapshot;
  readonly deliveries?: readonly ScheduleDeliverySnapshot[];
}

const WORKER_LABEL = '看板 Worker';
const SCHEDULE_TRIGGER_LABEL = '大肥鱼定时任务';

function event(title: string, at: number, summary?: string): DelegationActivityEvent {
  return { title, at, ...(summary ? { summary } : {}) };
}

function latestExecution(task: CapturedTask | undefined, executionId: string | undefined): CapturedExecution | undefined {
  if (!task) return undefined;
  if (executionId !== undefined) {
    const exact = task.executions.find(entry => entry.id === executionId);
    if (exact) return exact;
  }
  return task.executions.find(entry => entry.endedAt === null) ?? task.executions[task.executions.length - 1];
}

/** 返回给人看的活动状态；只依据持久回执与看板投影，不从文案推断。 */
function activityStatus(record: DelegationRecord, task: CapturedTask | undefined, execution: CapturedExecution | undefined): string {
  if (record.state === 'rejected') return 'rejected';
  if (record.state !== 'accepted') return 'unknown';
  if (task?.status === 'needs_input') return 'needs_input';
  if (task?.status === 'review') return 'review';
  if (execution === undefined) return 'running';
  if (execution.endedAt === null) return 'running';
  if (execution.result === 'failed') return 'failed';
  if (execution.result === 'cancelled') return 'cancelled';
  return task?.status === 'done' ? 'done' : 'succeeded';
}

function title(record: DelegationRecord, task: CapturedTask | undefined): string {
  const name = task?.title.trim();
  if (name) return name;
  return `看板任务 ${record.taskId.slice(0, 8)}`;
}

function parseTimestamp(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * 把大肥鱼定时任务的真实触发回执投影成个人面板活动记录。
 */
export function scheduleTriggerActivities(schedules: readonly ScheduleTriggerSource[]): DelegationActivity[] {
  const activities: DelegationActivity[] = [];
  for (const item of schedules) {
    const seen = new Set<string>();
    const deliveries: ScheduleDeliverySnapshot[] = [];
    for (const candidate of [...(item.deliveries ?? []), ...(item.lastDelivery ? [item.lastDelivery] : [])]) {
      if (!candidate || typeof candidate.deliveredAt !== 'string') continue;
      const key = candidate.messageId || candidate.deliveredAt;
      if (seen.has(key)) continue;
      seen.add(key);
      deliveries.push(candidate);
    }
    deliveries.sort((a, b) => parseTimestamp(b.deliveredAt, 0) - parseTimestamp(a.deliveredAt, 0));
    const scheduleTitle = item.title?.trim() || `定时任务 ${item.id.slice(0, 8)}`;
    deliveries.forEach((delivery, index) => {
      const scheduledAt = parseTimestamp(delivery.scheduledAt, Date.now());
      const deliveredAt = parseTimestamp(delivery.deliveredAt, scheduledAt);
      const running = index === 0 && item.executionActive === true;
      const status = running ? 'running' : 'done';
      const promptText = (delivery.prompt ?? item.prompt)?.trim();
      const events: DelegationActivityEvent[] = [
        event('定时任务到达计划时间', scheduledAt, promptText || undefined),
        event(
          '大肥鱼定时任务触发',
          deliveredAt,
          promptText ? `已向大肥鱼会话投递执行指令：${promptText}` : '已向大肥鱼会话投递本次定时任务。',
        ),
      ];
      if (!running) {
        const completedAt = delivery.completedAt && delivery.completedAt >= deliveredAt ? delivery.completedAt : deliveredAt;
        events.push(
          event('定时任务执行完成', completedAt, delivery.assistantSummary?.trim() || '本次定时任务已执行完毕。'),
        );
      }
      const updatedAt = Math.max(deliveredAt, ...events.map(entry => entry.at));
      activities.push({
        id: `schedule-trigger:${item.id}:${delivery.messageId || delivery.deliveredAt}`,
        kind: 'schedule_trigger',
        title: scheduleTitle,
        status,
        updatedAt,
        worker: SCHEDULE_TRIGGER_LABEL,
        events,
        taskId: item.id,
        scheduleId: item.id,
        ...(delivery.targetSessionId ? { sessionId: delivery.targetSessionId } : {}),
      });
    });
  }
  return activities.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 把持久委派记录与大肥鱼定时任务触发回执合并投影成个人面板活动。
 *
 * 一次派工或一次定时触发各占一行：状态来自真实回执与执行记录，事件只收录提交、启动、
 * 触发投递、回传、等待验收和结算。没有结构化进展时只保留已确认的两三步，
 * 不补写不确定的中间过程。
 */
export function delegationActivities(
  records: readonly DelegationRecord[],
  tasks: readonly CapturedTask[],
  schedules: readonly ScheduleTriggerSource[] = [],
): DelegationActivity[] {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const delegated = records.map(record => {
    const task = byId.get(record.taskId);
    const execution = latestExecution(task, record.executionId);
    const status = activityStatus(record, task, execution);
    const events: DelegationActivityEvent[] = [event('大肥鱼提交委派', record.createdAt)];
    if (record.state === 'rejected') {
      events.push(event('启动被拒绝', record.updatedAt, record.reason ?? '看板拒绝启动本次执行'));
    } else if (record.state !== 'accepted') {
      events.push(event('派工回执待核实', record.updatedAt, '尚未从看板读到本次执行，正在按原操作核实。'));
    } else {
      events.push(event('看板确认启动', execution?.startedAt ?? record.updatedAt));
      if (execution?.summary) events.push(event('Worker 回传结果', execution.endedAt ?? execution.startedAt, execution.summary));
      if (execution?.endedAt !== undefined && execution.endedAt !== null) {
        if (execution.result === 'failed') events.push(event('执行失败', execution.endedAt));
        else if (execution.result === 'cancelled') events.push(event('执行已取消', execution.endedAt));
      }
      if (status === 'review') events.push(event('等待人工验收', task?.updatedAt ?? record.updatedAt));
      if (status === 'needs_input') events.push(event('等待输入', task?.updatedAt ?? record.updatedAt));
    }
    const timestamps = [record.updatedAt, execution?.endedAt ?? execution?.startedAt ?? 0, task?.updatedAt ?? 0, ...events.map(entry => entry.at)];
    return {
      id: record.operationId,
      title: title(record, task),
      status,
      updatedAt: Math.max(...timestamps),
      worker: WORKER_LABEL,
      events,
      taskId: record.taskId,
      ...(execution?.sessionId ? { sessionId: execution.sessionId } : record.sessionId ? { sessionId: record.sessionId } : {}),
    };
  });
  return [...delegated, ...scheduleTriggerActivities(schedules)].sort((a, b) => b.updatedAt - a.updatedAt);
}
