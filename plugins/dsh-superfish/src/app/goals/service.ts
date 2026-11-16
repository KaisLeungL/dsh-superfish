import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type GoalStatus = 'active' | 'paused' | 'completed' | 'failed';
export type MilestoneStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface GoalMilestone {
  readonly id: string;
  readonly index: number;
  readonly title: string;
  readonly status: MilestoneStatus;
  readonly boardTaskId?: string;
  readonly agentPreset?: string;
  readonly summary?: string;
  readonly updatedAt: number;
}

export interface PublicGoal {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly description: string;
  readonly status: GoalStatus;
  readonly autoAdvance: boolean;
  readonly milestones: readonly GoalMilestone[];
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface GoalCreateInput {
  readonly title: string;
  readonly description?: string;
  readonly autoAdvance?: boolean;
  readonly milestones: readonly {
    readonly title: string;
    readonly boardTaskId?: string;
    readonly agentPreset?: string;
  }[];
}

export interface GoalMilestoneUpdateInput {
  readonly goalId: string;
  readonly milestoneId: string;
  readonly status?: MilestoneStatus;
  readonly boardTaskId?: string;
  readonly summary?: string;
}

export interface GoalAdvanceTransition {
  readonly goal: PublicGoal;
  readonly updatedMilestone: GoalMilestone;
  readonly nextMilestone?: GoalMilestone;
  readonly goalCompleted: boolean;
}

interface GoalRow {
  id: string;
  workspace_id: string;
  title: string;
  description: string;
  status: GoalStatus;
  auto_advance: number;
  milestones_json: string;
  revision: number;
  created_at: number;
  updated_at: number;
}

export interface GoalServiceBindings {
  readonly workspaceId: string;
  assertCurrent(): void;
  now?(): number;
}

function asPublicGoal(row: GoalRow): PublicGoal {
  let milestones: GoalMilestone[] = [];
  try {
    const parsed = JSON.parse(row.milestones_json);
    if (Array.isArray(parsed)) {
      milestones = parsed.map((m, idx) =>
        Object.freeze({
          id: typeof m?.id === 'string' ? m.id : `m-${idx + 1}`,
          index: typeof m?.index === 'number' ? m.index : idx,
          title: typeof m?.title === 'string' ? m.title : '',
          status: (['pending', 'running', 'completed', 'failed'].includes(m?.status) ? m.status : 'pending') as MilestoneStatus,
          ...(typeof m?.boardTaskId === 'string' && m.boardTaskId ? { boardTaskId: m.boardTaskId } : {}),
          ...(typeof m?.agentPreset === 'string' && m.agentPreset ? { agentPreset: m.agentPreset } : {}),
          ...(typeof m?.summary === 'string' && m.summary ? { summary: m.summary } : {}),
          updatedAt: typeof m?.updatedAt === 'number' ? m.updatedAt : row.updated_at,
        }),
      );
    }
  } catch {
    milestones = [];
  }
  return Object.freeze({
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    description: row.description,
    status: row.status,
    autoAdvance: row.auto_advance === 1,
    milestones: Object.freeze(milestones),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/**
 * 长周期目标状态机（Goals State Machine）：
 * 跨天追踪多阶段里程碑（Milestones），并与看板任务（boardTaskId）和事件驱动引擎联动，
 * 实现前序子任务完成后自动推进下一里程碑或汇总通知用户验收。
 */
export class GoalService {
  readonly #db: DatabaseSync;

  constructor(path: string, private readonly binding: GoalServiceBindings) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS goal_item (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','paused','completed','failed')),
        auto_advance INTEGER NOT NULL CHECK(auto_advance IN (0,1)),
        milestones_json TEXT NOT NULL CHECK(json_valid(milestones_json)),
        revision INTEGER NOT NULL CHECK(revision >= 1),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_goal_workspace_status
        ON goal_item(workspace_id, status, updated_at DESC);
    `);
  }

  close(): void {
    this.#db.close();
  }

  #now(): number {
    return typeof this.binding.now === 'function' ? this.binding.now() : Date.now();
  }

  listGoals(statusFilter?: GoalStatus): readonly PublicGoal[] {
    this.binding.assertCurrent();
    const rows = statusFilter
      ? (this.#db
          .prepare('SELECT * FROM goal_item WHERE workspace_id = ? AND status = ? ORDER BY updated_at DESC, id ASC')
          .all(this.binding.workspaceId, statusFilter) as unknown as GoalRow[])
      : (this.#db
          .prepare('SELECT * FROM goal_item WHERE workspace_id = ? ORDER BY updated_at DESC, id ASC')
          .all(this.binding.workspaceId) as unknown as GoalRow[]);
    return Object.freeze(rows.map(asPublicGoal));
  }

  getGoal(id: string): PublicGoal | undefined {
    this.binding.assertCurrent();
    const row = this.#db
      .prepare('SELECT * FROM goal_item WHERE id = ? AND workspace_id = ?')
      .get(id, this.binding.workspaceId) as unknown as GoalRow | undefined;
    return row ? asPublicGoal(row) : undefined;
  }

  createGoal(input: GoalCreateInput): PublicGoal {
    this.binding.assertCurrent();
    const title = input.title.trim();
    const description = (input.description ?? '').trim();
    if (!title || title.length > 120 || description.length > 2000) {
      throw Error('GOAL_CONTENT_INVALID');
    }
    if (!Array.isArray(input.milestones) || input.milestones.length < 1 || input.milestones.length > 20) {
      throw Error('GOAL_MILESTONES_INVALID');
    }
    const now = this.#now();
    const milestones: GoalMilestone[] = input.milestones.map((m, idx) => {
      const mTitle = m.title.trim();
      if (!mTitle || mTitle.length > 160) throw Error('GOAL_MILESTONE_TITLE_INVALID');
      return {
        id: `ms-${idx + 1}-${randomUUID().slice(0, 8)}`,
        index: idx,
        title: mTitle,
        status: 'pending',
        ...(m.boardTaskId?.trim() ? { boardTaskId: m.boardTaskId.trim() } : {}),
        ...(m.agentPreset?.trim() ? { agentPreset: m.agentPreset.trim() } : {}),
        updatedAt: now,
      };
    });

    const id = randomUUID();
    const autoAdvance = input.autoAdvance !== false ? 1 : 0;
    this.#db
      .prepare(
        `INSERT INTO goal_item
          (id, workspace_id, title, description, status, auto_advance, milestones_json, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, 1, ?, ?)`,
      )
      .run(id, this.binding.workspaceId, title, description, autoAdvance, JSON.stringify(milestones), now, now);

    return this.getGoal(id)!;
  }

  updateGoalStatus(goalId: string, status: GoalStatus): PublicGoal {
    this.binding.assertCurrent();
    const existing = this.#db
      .prepare('SELECT * FROM goal_item WHERE id = ? AND workspace_id = ?')
      .get(goalId, this.binding.workspaceId) as unknown as GoalRow | undefined;
    if (!existing) throw Error('GOAL_NOT_FOUND');
    const now = this.#now();
    this.#db
      .prepare('UPDATE goal_item SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND workspace_id = ?')
      .run(status, now, goalId, this.binding.workspaceId);
    return this.getGoal(goalId)!;
  }

  deleteGoal(goalId: string): boolean {
    this.binding.assertCurrent();
    const res = this.#db
      .prepare('DELETE FROM goal_item WHERE id = ? AND workspace_id = ?')
      .run(goalId, this.binding.workspaceId);
    return res.changes > 0;
  }

  updateMilestone(input: GoalMilestoneUpdateInput): GoalAdvanceTransition {
    this.binding.assertCurrent();
    const existing = this.#db
      .prepare('SELECT * FROM goal_item WHERE id = ? AND workspace_id = ?')
      .get(input.goalId, this.binding.workspaceId) as unknown as GoalRow | undefined;
    if (!existing) throw Error('GOAL_NOT_FOUND');

    const goal = asPublicGoal(existing);
    const targetIdx = goal.milestones.findIndex(m => m.id === input.milestoneId);
    if (targetIdx < 0) throw Error('MILESTONE_NOT_FOUND');

    const now = this.#now();
    const currentMs = goal.milestones[targetIdx]!;
    const updatedMs: GoalMilestone = Object.freeze({
      ...currentMs,
      ...(input.status ? { status: input.status } : {}),
      ...(input.boardTaskId !== undefined ? (input.boardTaskId ? { boardTaskId: input.boardTaskId } : {}) : {}),
      ...(input.summary !== undefined ? (input.summary ? { summary: input.summary } : {}) : {}),
      updatedAt: now,
    });

    const nextMilestones = goal.milestones.map((m, idx) => (idx === targetIdx ? updatedMs : m));
    const allCompleted = nextMilestones.length > 0 && nextMilestones.every(m => m.status === 'completed');
    const anyFailed = nextMilestones.some(m => m.status === 'failed');
    const nextGoalStatus: GoalStatus = allCompleted
      ? 'completed'
      : anyFailed && updatedMs.status === 'failed'
        ? 'failed'
        : goal.status === 'completed'
          ? 'active'
          : goal.status;

    const nextMilestone =
      goal.autoAdvance && updatedMs.status === 'completed' && !allCompleted
        ? nextMilestones.find((m, idx) => idx > targetIdx && m.status === 'pending')
        : undefined;

    this.#db
      .prepare(
        `UPDATE goal_item
         SET status = ?, milestones_json = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND workspace_id = ?`,
      )
      .run(nextGoalStatus, JSON.stringify(nextMilestones), now, goal.id, this.binding.workspaceId);

    const savedGoal = this.getGoal(goal.id)!;
    return Object.freeze({
      goal: savedGoal,
      updatedMilestone: savedGoal.milestones[targetIdx]!,
      ...(nextMilestone ? { nextMilestone: savedGoal.milestones.find(m => m.id === nextMilestone.id) } : {}),
      goalCompleted: allCompleted,
    });
  }

  /**
   * 当看板某张任务卡片执行结束（completed / failed）时，自动匹配关联的长周期目标里程碑并推进状态机。
   */
  onBoardTaskOutcome(event: {
    readonly taskId: string;
    readonly status: 'completed' | 'failed' | 'running';
    readonly summary?: string;
  }): readonly GoalAdvanceTransition[] {
    const activeGoals = this.listGoals('active');
    const transitions: GoalAdvanceTransition[] = [];
    for (const goal of activeGoals) {
      const matchedMs = goal.milestones.find(
        m => m.boardTaskId === event.taskId && m.status !== event.status,
      );
      if (!matchedMs) continue;
      transitions.push(
        this.updateMilestone({
          goalId: goal.id,
          milestoneId: matchedMs.id,
          status: event.status,
          ...(event.summary ? { summary: event.summary } : {}),
        }),
      );
    }
    return Object.freeze(transitions);
  }

  clearAll(): void {
    this.#db.prepare('DELETE FROM goal_item WHERE workspace_id = ?').run(this.binding.workspaceId);
  }

  renderActiveGoalsSection(): string {
    try {
      this.binding.assertCurrent();
      const activeGoals = this.listGoals('active');
      if (activeGoals.length === 0) return '';
      const lines: string[] = [
        '以下是当前工作区正在追踪的长周期目标（Active Goals State Machine）。你可以调用 `steward_list_goals` 或 `steward_manage_goal` 创建里程碑、绑定看板任务 ID 或推进阶段状态：',
      ];
      for (const goal of activeGoals.slice(0, 8)) {
        const doneCount = goal.milestones.filter(m => m.status === 'completed').length;
        const nextMs = goal.milestones.find(m => m.status === 'running' || m.status === 'pending');
        const nextText = nextMs
          ? ` | 当前阶段：[${nextMs.status}] ${nextMs.title}${nextMs.boardTaskId ? ` (task:${nextMs.boardTaskId})` : ''}`
          : '';
        lines.push(
          `- [Goal id:${goal.id} | 进度 ${doneCount}/${goal.milestones.length}${goal.autoAdvance ? ' | 自动推进' : ''}] **${goal.title}**${nextText}`,
        );
      }
      return lines.join('\n');
    } catch {
      return '';
    }
  }
}
