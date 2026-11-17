import { createHash } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { WorkspaceContextService } from './index.js';

export const name = 'workspace-context-schedule';
export const inject = ['workspaceContext', 'schedule', 'workspaceRegistry'];

function clean(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
  return text.length <= max ? text : text.slice(0, max) + '…';
}

function workspaceOf(ctx: {
  workspaceRegistry: {
    get?(id: string): { id: string; path: string } | undefined;
    list(): { id: string; path: string; sessionIds?: string[] }[];
  };
  sessions?: { get?(id: string): { header?: { cwd?: string } } | undefined };
}, target: unknown): string | undefined {
  if (!target || typeof target !== 'object') return undefined;
  const tgt = target as {
    kind?: string;
    create?: { cwd?: string };
    sessionId?: string;
  };
  const workspaces = ctx.workspaceRegistry.list();
  if (tgt.kind === 'new_once') {
    const cwd = tgt.create?.cwd;
    return typeof cwd === 'string' ? workspaces.find(item => item.path === cwd)?.id : undefined;
  }
  if (tgt.kind === 'session' && typeof tgt.sessionId === 'string') {
    const attached = workspaces.find(item => item.sessionIds?.includes(tgt.sessionId!));
    if (attached) return attached.id;
    const cwd = ctx.sessions?.get?.(tgt.sessionId)?.header?.cwd;
    return typeof cwd === 'string' ? workspaces.find(item => item.path === cwd)?.id : undefined;
  }
  return undefined;
}

export function apply(ctx: Context): void {
  const runtime = ctx as unknown as {
    workspaceContext: WorkspaceContextService;
    schedule: { list(filter: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>[]> };
    workspaceRegistry: {
      get?(id: string): { id: string; path: string } | undefined;
      list(): { id: string; path: string; sessionIds?: string[] }[];
    };
    sessions?: { get?(id: string): { header?: { cwd?: string } } | undefined };
    effect: Context['effect'];
  };
  const off = runtime.workspaceContext.register(ctx, {
    protocol: 1,
    id: 'schedule.upcoming',
    source: '自动化任务',
    provider: '@local/dsh-superfish/workspace-context/schedule',
    description: '读取当前工作区自动化任务的标题、状态和下次触发时间；不含任务完整指令正文。',
    scope: 'workspace',
    filters: {
      status: { type: 'string', description: '任务状态。', enum: ['active', 'paused', 'ended'] },
      query: { type: 'string', description: '任务标题关键词。' },
    },
    async read({ scope, filter, offset, limit, signal }) {
      const workspace =
        runtime.workspaceRegistry.get?.(scope.workspaceId) ??
        runtime.workspaceRegistry.list().find(item => item.id === scope.workspaceId);
      if (!workspace) return { items: [], more: false, revision: 'missing' };
      const all = await runtime.schedule.list({}, signal);
      signal.throwIfAborted();
      const query = typeof filter.query === 'string' ? filter.query.trim().toLowerCase() : '';
      const scoped = all
        .filter(item => {
          if (workspaceOf(runtime, item.target) !== workspace.id) return false;
          if (filter.status && item.status !== filter.status) return false;
          if (!query) return true;
          return clean(item.title || item.prompt, 120).toLowerCase().includes(query);
        })
        .sort(
          (a, b) =>
            String(a.scheduledAt ?? '').localeCompare(String(b.scheduledAt ?? '')) ||
            String(a.id ?? '').localeCompare(String(b.id ?? '')),
        );
      const revision = createHash('sha256')
        .update(JSON.stringify(scoped.map(item => [item.id, item.status, item.scheduledAt, item.title])))
        .digest('hex')
        .slice(0, 16);
      const items = scoped.slice(offset, offset + limit).map(item => {
        const timing = item.timing as { kind?: string } | undefined;
        return {
          ref: { kind: 'schedule.task', id: String(item.id) },
          title: clean(item.title || item.prompt, 120),
          status: item.status,
          nextRunAt: item.scheduledAt ?? null,
          cadence: timing?.kind ?? 'unknown',
          workspaceId: workspace.id,
          projectId: workspace.id,
        };
      });
      return { items, more: scoped.length > offset + limit, revision };
    },
  });
  ctx.effect(() => off);
}
export default { name, inject, apply };
