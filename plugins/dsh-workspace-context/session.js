import { createHash } from 'node:crypto';

export const inject = ['workspaceContext', 'sessionPersistence', 'sessions', 'agents', 'workspaceRegistry'];

const statuses = ['running', 'needs_input', 'completed', 'blank'];
const cleanLine = text => String(text ?? '').replace(/[\u0000-\u001F\u007F-\u009F]+/gu, ' ').replace(/\s+/gu, ' ').trim();
const sliceChars = (text, max) => {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('') + '…';
};
const isInternal = header => {
  const preset = typeof header?.agentPreset === 'string' ? header.agentPreset : '';
  return preset === 'workspace-superagent-router' || preset === 'workspace-superagent-worker' || preset === 'workspace-superagent-scheduled' || header?.origin === 'subagent';
};

/** 从宿主会话与持久化日志按只读方式汇总全部工作区的用户会话。 */
export function apply(ctx) {
  ctx.effect(() => ctx.workspaceContext.register(ctx, {
    protocol: 1,
    id: 'session.list',
    source: '用户会话',
    scope: 'workspace',
    description: '读取全部工作区的用户会话摘要，包含标题、所属工作区、当前状态（running/needs_input/completed/blank）、最近回合结束时间及首尾消息预览。默认排除已归档会话与大肥鱼自身会话。',
    filters: {
      status: { type: 'string', description: '按会话状态筛选：running、needs_input、completed、blank。', enum: statuses },
      workspaceId: { type: 'string', description: '只查询指定工作区 ID 的会话；省略时查询全部工作区。' },
      archived: { type: 'boolean', description: 'true 查询已归档会话，false 查询未归档会话。省略时默认查询未归档会话。' },
      query: { type: 'string', description: '按关键词匹配会话标题、工作区名称或对话内容。' },
      updatedFrom: { type: 'integer', description: '会话更新时间下界（含），Unix 毫秒。' },
      updatedBefore: { type: 'integer', description: '会话更新时间上界（不含），Unix 毫秒。' },
    },
    async read({ filter, offset, limit, signal }) {
      const workspaces = ctx.workspaceRegistry.list();
      const archivedSet = new Set(ctx.workspaceRegistry.archivedSessionIds ?? []);
      const bySessionId = new Map();
      for (const ws of workspaces) {
        for (const sid of ws.sessionIds ?? []) {
          if (!bySessionId.has(sid)) bySessionId.set(sid, ws);
        }
      }
      const resolveWorkspace = (sessionId, cwd) => {
        if (bySessionId.has(sessionId)) return bySessionId.get(sessionId);
        if (!cwd) return undefined;
        let best;
        for (const ws of workspaces) {
          if (cwd === ws.path || cwd.startsWith(ws.path + '/')) {
            if (!best || ws.path.length > best.path.length) best = ws;
          }
        }
        return best;
      };

      const stored = typeof ctx.sessionPersistence.list === 'function'
        ? await ctx.sessionPersistence.list({ signal })
        : [];
      signal.throwIfAborted();
      const storedMap = new Map(stored.filter(s => typeof s?.header?.id === 'string').map(s => [s.header.id, s]));
      const ids = new Set([...storedMap.keys(), ...bySessionId.keys(), ...archivedSet]);
      const queryTerms = typeof filter.query === 'string' && filter.query.trim()
        ? filter.query.trim().toLowerCase().split(/\s+/u).filter(Boolean)
        : [];
      const visible = [];

      for (const sessionId of ids) {
        signal.throwIfAborted();
        const live = ctx.sessions.get(sessionId);
        const snap = storedMap.get(sessionId);
        const header = live?.header ?? snap?.header;
        if (!header || isInternal(header)) continue;
        const archived = archivedSet.has(sessionId);
        if (archived !== (filter.archived ?? false)) continue;
        const cwd = typeof header.cwd === 'string' && header.cwd ? header.cwd : undefined;
        const ws = resolveWorkspace(sessionId, cwd);
        const workspaceId = ws?.id ?? null;
        if (filter.workspaceId !== undefined && workspaceId !== filter.workspaceId) continue;
        const workspaceTitle = ws ? (ws.title?.trim() || ws.path.split(/[\\/]/).filter(Boolean).at(-1) || ws.id) : null;

        let events = [];
        if (live && typeof live.snapshotEvents === 'function') {
          events = live.snapshotEvents();
        } else if (typeof ctx.sessionPersistence.open === 'function') {
          try {
            const handle = await ctx.sessionPersistence.open(sessionId, 'read', { signal });
            try {
              const page = await handle.read(0, 512, { signal });
              events = page.events ?? [];
            } finally {
              await handle.close();
            }
          } catch {
            if (signal.aborted) throw signal.reason;
          }
        }
        signal.throwIfAborted();

        const createdAt = typeof header.createdAt === 'number' ? header.createdAt : 0;
        let explicitTitle, firstUser, lastUser, lastAssistant, lastTurnEndedAt = null, lastTurnOutcome = null;
        let lastEventTime = createdAt, turnStarts = 0, userTurns = 0;
        const textCorpus = [];

        for (const event of events) {
          if (typeof event?.time === 'number' && event.time > lastEventTime) lastEventTime = event.time;
          if (event?.type === 'session/title' && typeof event.data?.title === 'string') {
            const t = cleanLine(event.data.title);
            if (t) explicitTitle = t;
          } else if (event?.type === 'turn/start') {
            turnStarts++;
          } else if (event?.type === 'turn/end') {
            lastTurnEndedAt = typeof event.time === 'number' ? event.time : lastEventTime;
            lastTurnOutcome = typeof event.data?.reason?.kind === 'string' ? event.data.reason.kind : 'completed';
          } else if (event?.type === 'user/message') {
            const kind = event.data?.source?.kind ?? 'user';
            if (kind !== 'user') continue;
            const text = Array.isArray(event.data?.content)
              ? event.data.content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text.trim()).filter(Boolean).join('\n')
              : '';
            if (!text) continue;
            userTurns++;
            if (firstUser === undefined) firstUser = text;
            lastUser = text;
            textCorpus.push(text);
          } else if (event?.type === 'assistant/message') {
            const content = event.data?.message?.content ?? event.data?.content;
            const text = Array.isArray(content)
              ? content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text.trim()).filter(Boolean).join('\n')
              : '';
            if (!text) continue;
            lastAssistant = text;
            textCorpus.push(text);
          }
        }

        const running = ctx.agents.get(sessionId)?.status === 'running';
        const turnCount = Math.max(turnStarts, userTurns);
        if (lastTurnEndedAt === null && turnCount > 0 && !running) {
          lastTurnEndedAt = lastEventTime;
          lastTurnOutcome = 'completed';
        }
        const updatedAt = Math.max(createdAt, lastEventTime, lastTurnEndedAt ?? 0);
        const status = running ? 'running' : (turnCount === 0 && !firstUser) ? 'blank' : lastTurnOutcome === 'blocked' ? 'needs_input' : 'completed';
        if (filter.status !== undefined && status !== filter.status) continue;
        if (filter.updatedFrom !== undefined && updatedAt < filter.updatedFrom) continue;
        if (filter.updatedBefore !== undefined && updatedAt >= filter.updatedBefore) continue;

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
  }));
}
