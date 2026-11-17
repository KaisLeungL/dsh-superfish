import type { Context } from '@deepseek-ai/cordis';
import type { WorkspaceContextService } from './index.js';

export const name = 'workspace-context-task-board';
export const inject = ['workspaceContext', 'taskBoard', 'workspaceRegistry'];

function clean(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
  return text.length <= max ? text : text.slice(0, max) + '…';
}

function projectNameOf(workspaces: unknown, id: string | null | undefined): string {
  if (!id) return '未归属项目';
  const ws = workspaces as {
    get?(id: string): { title?: string; path?: string } | undefined;
    list?(): { id: string; title?: string; path?: string }[];
  } | undefined;
  const workspace =
    (typeof ws?.get === 'function' ? ws.get(id) : undefined) ??
    (typeof ws?.list === 'function' ? ws.list().find(item => item.id === id) : undefined);
  const title = clean(workspace?.title, 120);
  if (title) return title;
  const path = typeof workspace?.path === 'string' ? workspace.path.replace(/[\\/]+$/u, '') : '';
  const tail = path ? path.split(/[\\/]/u).pop() : '';
  return clean(tail, 120) || id;
}

export function apply(ctx: Context): void {
  const runtime = ctx as unknown as {
    workspaceContext: WorkspaceContextService;
    taskBoard: {
      snapshot(): {
        revision: number | string;
        tasks?: Record<string, unknown>[];
        archivedTasks?: Record<string, unknown>[];
      };
    };
    workspaceRegistry: unknown;
    effect: Context['effect'];
  };
  const off = runtime.workspaceContext.register(ctx, {
    protocol: 1,
    id: 'task-board.list',
    source: '任务看板',
    provider: '@local/dsh-superfish/workspace-context/task-board',
    description:
      '读取任务看板卡片摘要；按宿主看板读取范围（当前工作区或全部项目，含未归属项目）返回，支持按列、归档状态和关键词筛选。默认返回未归档卡片且自动过滤内部隐藏卡片。',
    scope: 'project',
    filters: {
      column: {
        type: 'string',
        description: '看板列。',
        enum: ['backlog', 'ready', 'in_progress', 'blocked', 'in_review', 'done'],
      },
      archived: { type: 'boolean', description: 'true 查询归档卡片，省略或 false 查询未归档卡片。' },
      query: { type: 'string', description: '标题、描述或项目名称关键词。' },
    },
    read({ scope, filter, offset, limit, signal }) {
      signal.throwIfAborted();
      const snapshot = runtime.taskBoard.snapshot();
      const terms =
        typeof filter.query === 'string'
          ? filter.query
              .trim()
              .toLowerCase()
              .split(/\s+/u)
              .filter(Boolean)
          : [];
      const archived = filter.archived === true;
      const source = archived ? (snapshot.archivedTasks ?? []) : (snapshot.tasks ?? []);
      const allProjects = scope.allBoardProjects === true;
      const visible = source
        .filter(task => {
          if (!task || task.hidden === true) return false;
          const projectId = (task.projectId ?? task.workspaceId ?? null) as string | null;
          if (!allProjects) {
            const taskWorkspaceId = (task.workspaceId ?? projectId) as string | null;
            if (taskWorkspaceId !== scope.workspaceId || !scope.projectIds.includes(projectId)) return false;
          }
          if (filter.column && task.status !== filter.column) return false;
          if (!terms.length) return true;
          const projectName = projectNameOf(runtime.workspaceRegistry, projectId);
          const text = [task.title, task.description, projectName, ...(Array.isArray(task.tags) ? task.tags : [])]
            .filter(Boolean)
            .join('\n')
            .toLowerCase();
          return terms.every(term => text.includes(term));
        })
        .sort(
          (a, b) =>
            Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0) ||
            String(a.id ?? '').localeCompare(String(b.id ?? '')),
        );
      const items = visible.slice(offset, offset + limit).map(task => {
        const projectId = (task.projectId ?? task.workspaceId ?? null) as string | null;
        const workspaceId = (task.workspaceId ?? projectId) as string | null;
        return {
          ref: { kind: 'task-board.card', id: String(task.id) },
          title: clean(task.title, 160),
          summary: clean(task.description, 240),
          column: task.status,
          archived,
          priority: task.priority ?? null,
          updatedAt: task.updatedAt ?? null,
          workspaceId,
          projectId,
          projectName: projectNameOf(runtime.workspaceRegistry, projectId),
        };
      });
      return {
        items,
        more: visible.length > offset + limit,
        revision: String(snapshot.revision),
      };
    },
  });
  ctx.effect(() => off);
}
export default { name, inject, apply };
