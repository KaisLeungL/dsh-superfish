import { createHash } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { WorkspaceContextService } from './index.js';

export const name = 'workspace-context-session';
export const inject = ['workspaceContext', 'workspaceRegistry', 'sessionPersistence', 'sessions'];

const MANAGED_PRESETS = new Set([
  'workspace-superagent-router',
  'workspace-superagent-worker',
  'workspace-superagent-scheduled',
]);

function cleanLine(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

function sliceChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max - 1).join('') + '…';
}

function extractTextFromBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  const parts: string[] = [];
  for (const block of blocks) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      const cleaned = block.text.trim();
      if (cleaned) parts.push(cleaned);
    }
  }
  return parts.join('\n').trim();
}

function isManagedSession(header: unknown): boolean {
  if (!header || typeof header !== 'object') return false;
  const h = header as { agentPreset?: unknown; parent?: unknown };
  if (typeof h.agentPreset === 'string' && MANAGED_PRESETS.has(h.agentPreset)) return true;
  if (h.parent && typeof h.parent === 'object') return true;
  return false;
}

interface WorkspaceRecord {
  id: string;
  path?: string;
  title?: string;
  sessionIds?: string[];
}

export function apply(ctx: Context): void {
  const runtime = ctx as unknown as {
    workspaceContext: WorkspaceContextService;
    workspaceRegistry?: {
      list?(): WorkspaceRecord[];
      archivedSessionIds?: Iterable<string>;
    };
    sessionPersistence?: {
      list?(signal: AbortSignal): Promise<{ header?: { id?: string; createdAt?: number; cwd?: string } }[]>;
      read?(id: string, signal: AbortSignal): Promise<{
        header?: { id?: string; createdAt?: number; cwd?: string };
        events?: Record<string, unknown>[];
      } | undefined>;
    };
    sessions?: {
      get?(id: string): {
        header?: { id?: string; createdAt?: number; cwd?: string };
        snapshotEvents?(): Record<string, unknown>[];
      } | undefined;
    };
    agents?: {
      get?(id: string): { status?: string } | undefined;
    };
    effect: Context['effect'];
  };
  const off = runtime.workspaceContext.register(ctx, {
    protocol: 1,
    id: 'session.list',
    source: '用户会话',
    provider: '@local/dsh-superfish/workspace-context/session',
    description:
      '读取全部工作区的用户会话摘要，包含标题、所属工作区、当前状态（running/needs_input/completed/blank）、最近回合结束时间及首尾消息预览。默认排除已归档会话与大肥鱼自身会话。',
    scope: 'workspace',
    readScope: 'all-sessions',
    filters: {
      status: {
        type: 'string',
        description: '按会话状态筛选：running（进行中）、needs_input（待输入）、completed（已完成）、blank（空白未开始）。',
        enum: ['running', 'needs_input', 'completed', 'blank'],
      },
      workspaceId: { type: 'string', description: '只查询指定工作区 ID 的会话；省略时查询全部工作区。' },
      archived: { type: 'boolean', description: 'true 查询已归档会话，false 查询未归档会话。省略时默认查询未归档会话。' },
      query: { type: 'string', description: '按关键词匹配会话标题、工作区名称或对话内容。' },
      updatedFrom: { type: 'integer', description: '会话更新时间下界（含），Unix 毫秒。' },
      updatedBefore: { type: 'integer', description: '会话更新时间上界（不含），Unix 毫秒。' },
    },
    async read({ filter, offset, limit, signal }) {
      signal.throwIfAborted();
      const workspaces = runtime.workspaceRegistry?.list?.() ?? [];
      const archivedSet = new Set(runtime.workspaceRegistry?.archivedSessionIds ?? []);
      const bySessionId = new Map<string, WorkspaceRecord>();
      for (const ws of workspaces) {
        if (!ws || typeof ws.id !== 'string') continue;
        for (const sid of ws.sessionIds ?? []) {
          if (typeof sid === 'string' && !bySessionId.has(sid)) bySessionId.set(sid, ws);
        }
      }
      const resolveWorkspace = (sid: string, cwd: string | undefined): WorkspaceRecord | undefined => {
        const direct = bySessionId.get(sid);
        if (direct) return direct;
        if (!cwd) return undefined;
        const norm = cwd.replace(/[\\/]+$/u, '');
        let best: WorkspaceRecord | undefined;
        for (const ws of workspaces) {
          if (typeof ws.path !== 'string') continue;
          const wsPath = ws.path.replace(/[\\/]+$/u, '');
          if (norm === wsPath || norm.startsWith(wsPath + '/')) {
            if (!best || (best.path?.length ?? 0) < wsPath.length) best = ws;
          }
        }
        return best;
      };

      const storedList = (await runtime.sessionPersistence?.list?.(signal)) ?? [];
      signal.throwIfAborted();
      const storedMap = new Map<string, { header?: { id?: string; createdAt?: number; cwd?: string } }>();
      for (const item of storedList) {
        const id = item?.header?.id;
        if (typeof id === 'string') storedMap.set(id, item);
      }

      const candidateIds = new Set<string>([...storedMap.keys(), ...bySessionId.keys(), ...archivedSet]);
      const wantArchived = filter.archived === true;
      const queryTerms =
        typeof filter.query === 'string'
          ? filter.query
              .trim()
              .toLowerCase()
              .split(/\s+/u)
              .filter(Boolean)
          : [];
      const visible: (Record<string, unknown> & { updatedAt: number; sessionId: string })[] = [];

      for (const sessionId of candidateIds) {
        signal.throwIfAborted();
        const archived = archivedSet.has(sessionId);
        if (archived !== wantArchived) continue;
        const live = runtime.sessions?.get?.(sessionId);
        const stored = storedMap.get(sessionId);
        const header = live?.header ?? stored?.header;
        if (!header || isManagedSession(header)) continue;

        const cwd = typeof header.cwd === 'string' && header.cwd ? header.cwd : undefined;
        const ws = resolveWorkspace(sessionId, cwd);
        const workspaceId = ws?.id ?? null;
        if (filter.workspaceId !== undefined && workspaceId !== filter.workspaceId) continue;

        const workspaceTitle = ws
          ? cleanLine(ws.title) || cleanLine(ws.path?.replace(/[\\/]+$/u, '').split(/[\\/]/u).pop()) || ws.id
          : null;
        const running = runtime.agents?.get?.(sessionId)?.status === 'running';

        let events: Record<string, unknown>[] = [];
        try {
          if (live && typeof live.snapshotEvents === 'function') {
            events = live.snapshotEvents() ?? [];
          } else if (typeof runtime.sessionPersistence?.read === 'function') {
            const loaded = await runtime.sessionPersistence.read(sessionId, signal);
            events = loaded?.events ?? [];
          }
        } catch (err) {
          if (signal.aborted) throw err;
        }
        signal.throwIfAborted();

        const createdAt = typeof header.createdAt === 'number' ? header.createdAt : 0;
        let lastEventTime = createdAt;
        let lastTurnEndedAt: number | null = null;
        let lastTurnOutcome: string | null = null;
        let explicitTitle = '';
        let firstUser: string | null = null;
        let lastUser: string | null = null;
        let lastAssistant: string | null = null;
        let turnCount = 0;
        const textCorpus: string[] = [];

        for (const ev of events) {
          if (!ev || typeof ev.type !== 'string') continue;
          if (typeof ev.time === 'number' && ev.time > lastEventTime) lastEventTime = ev.time;
          const data = ev.data as Record<string, unknown> | undefined;
          if (ev.type === 'session/title' && typeof data?.title === 'string') {
            const t = cleanLine(data.title);
            if (t) explicitTitle = t;
          } else if (ev.type === 'turn/end') {
            lastTurnEndedAt = typeof ev.time === 'number' ? ev.time : lastEventTime;
            const reason = data?.reason as { kind?: unknown } | undefined;
            lastTurnOutcome = typeof reason?.kind === 'string' ? reason.kind : 'completed';
          } else if (ev.type === 'user/message') {
            const source = data?.source as { kind?: unknown } | undefined;
            const srcKind = typeof source?.kind === 'string' ? source.kind : 'user';
            if (srcKind !== 'user') continue;
            const text = extractTextFromBlocks(data?.content);
            if (!text) continue;
            turnCount++;
            if (firstUser === null) firstUser = text;
            lastUser = text;
            textCorpus.push(text);
          } else if (ev.type === 'assistant/message') {
            const message = data?.message as { content?: unknown } | undefined;
            const text = extractTextFromBlocks(message?.content ?? data?.content);
            if (text) {
              lastAssistant = text;
              textCorpus.push(text);
            }
          }
        }

        if (lastTurnEndedAt === null && turnCount > 0 && !running) {
          lastTurnEndedAt = lastEventTime;
          lastTurnOutcome = 'completed';
        }
        const updatedAt = Math.max(createdAt, lastEventTime, lastTurnEndedAt ?? 0);
        const status = running
          ? 'running'
          : turnCount === 0 && !firstUser
            ? 'blank'
            : lastTurnOutcome === 'blocked'
              ? 'needs_input'
              : 'completed';
        if (filter.status !== undefined && status !== filter.status) continue;
        if (filter.updatedFrom !== undefined && updatedAt < Number(filter.updatedFrom)) continue;
        if (filter.updatedBefore !== undefined && updatedAt >= Number(filter.updatedBefore)) continue;

        const title = explicitTitle || (firstUser ? sliceChars(cleanLine(firstUser), 80) : '未命名会话');
        if (queryTerms.length > 0) {
          const hay = [title, workspaceTitle ?? '', cwd ?? '', ...textCorpus].join('\n').toLowerCase();
          if (!queryTerms.every(term => hay.includes(term))) continue;
        }

        visible.push({
          workspaceId,
          ref: { kind: 'session', id: sessionId },
          sessionId,
          title,
          workspaceTitle,
          cwd: cwd ?? ws?.path ?? null,
          status,
          lastTurnOutcome,
          archived,
          createdAt,
          updatedAt,
          lastTurnEndedAt,
          turnCount,
          lastUserMessage: lastUser ? sliceChars(cleanLine(lastUser), 200) : null,
          lastAssistantMessage: lastAssistant ? sliceChars(cleanLine(lastAssistant), 200) : null,
        });
      }

      visible.sort((a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId));
      const revision = createHash('sha256')
        .update(JSON.stringify(visible.map(i => [i.sessionId, i.updatedAt, i.status, i.turnCount, i.archived])))
        .digest('hex')
        .slice(0, 24);
      return {
        revision,
        more: visible.length > offset + limit,
        items: visible.slice(offset, offset + limit),
      };
    },
  });
  ctx.effect(() => off);
}
export default { name, inject, apply };
