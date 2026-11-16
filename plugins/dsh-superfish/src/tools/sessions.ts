import { createHash, randomUUID } from 'node:crypto';
import { scrubSensitiveText } from '../app/sentinel/scrubber.js';
import { ROUTER_PRESET } from '../sessions/manager.js';
import { CallerAuthority, CallerDenied, SCHEDULE_PRESET, SESSION_TOOLS, WORKER_PRESET, type CallerAgent, type Invocation } from './authority.js';
import type { ContextAccess, ContextService } from './context.js';

export const SESSION_LIST_CAPABILITY = 'session.list';
export const SESSION_LIST_PROVIDER = '@local/dsh-workspace-context/session';

export type SessionStatus = 'running' | 'needs_input' | 'completed' | 'blank';

export interface SessionSummaryItem {
  readonly sessionId: string;
  readonly title: string;
  readonly workspaceId: string | null;
  readonly workspaceTitle: string | null;
  readonly cwd: string | null;
  readonly status: SessionStatus;
  readonly lastTurnOutcome: string | null;
  readonly archived: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastTurnEndedAt: number | null;
  readonly turnCount: number;
  readonly lastUserMessage: string | null;
  readonly lastAssistantMessage: string | null;
}

export interface SessionMessageItem {
  readonly seq: number;
  readonly turn: number;
  readonly role: 'user' | 'assistant';
  readonly time: number;
  readonly text: string;
  readonly truncated?: true;
  readonly toolCalls?: readonly { readonly name: string; readonly status?: 'ok' | 'error' }[];
  readonly attachments?: readonly { readonly type: 'image' | 'file'; readonly name?: string }[];
}

export interface SessionReadPage {
  readonly readScope: 'all-sessions';
  readonly session: SessionSummaryItem & { readonly firstUserMessage: string | null };
  readonly order: 'chronological' | 'recent';
  readonly totalMessages: number;
  readonly messages: readonly SessionMessageItem[];
  readonly complete: boolean;
  readonly nextCursor?: string;
}

export interface RawSessionEvent {
  readonly type: string;
  readonly seq: number;
  readonly time?: number;
  readonly data: unknown;
}

export interface RawDerivedMessage {
  readonly id?: string;
  readonly role: string;
  readonly content: readonly unknown[];
  readonly source?: { readonly kind?: string; readonly form?: string };
}

export interface SessionReadHost {
  assertAvailable(): void;
  managerSessionId(): string | null;
  workspaces(): readonly { readonly id: string; readonly path: string; readonly title?: string; readonly sessionIds?: readonly string[] }[];
  archivedSessionIds?(): readonly string[];
  agentStatus?(id: string): string | undefined;
  liveSession?(id: string): {
    readonly id: string;
    readonly seq?: number;
    readonly header: Readonly<Record<string, unknown>>;
    snapshotEvents?(): readonly RawSessionEvent[];
    deriveMessages?(): readonly RawDerivedMessage[];
  } | undefined;
  listStoredSessions?(signal: AbortSignal): Promise<readonly {
    readonly header: Readonly<Record<string, unknown>>;
    readonly revision?: unknown;
    readonly eventCount?: number;
  }[]>;
  statStoredSession?(id: string, signal: AbortSignal): Promise<{
    readonly header: Readonly<Record<string, unknown>>;
    readonly revision?: unknown;
    readonly eventCount?: number;
  } | undefined>;
  openStoredSession?(id: string, signal: AbortSignal): Promise<{
    readonly header: Readonly<Record<string, unknown>>;
    read(offset?: number, length?: number, options?: { signal?: AbortSignal }): Promise<{ events: readonly RawSessionEvent[] }>;
    close(): Promise<void>;
  }>;
}

export interface SessionToolInvocation<A extends CallerAgent> extends Invocation<A> {
  readonly name: string;
}

interface ParsedSession {
  readonly summary: SessionSummaryItem;
  readonly firstUserMessage: string | null;
  readonly messages: readonly SessionMessageItem[];
  readonly searchableText: string;
}

interface CursorRecord {
  readonly agent: unknown;
  readonly fingerprint: string;
  readonly kind: 'list' | 'read' | 'context';
  readonly queryKey: string;
  readonly revision: string;
  readonly offset: number;
  readonly expiresAt: number;
}

const SESSION_STATISTICS = ['running', 'needs_input', 'completed', 'blank'] as const;
const READ_CHUNK = 256;
const MAX_EVENTS_PER_SESSION = 4096;
const MAX_PREVIEW_CHARS = 240;
const MAX_MESSAGE_CHARS = 1800;
const MAX_PAGE_MESSAGES = 25;
const MAX_PAGE_CHARS = 10_000;
const CURSOR_TTL_MS = 300_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const asRecord = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) throw new CallerDenied('INVALID_ARGUMENTS', '工具参数必须是对象。');
  return value;
};

const cleanSingleLine = (input: string): string =>
  input.replace(/[\u0000-\u001F\u007F-\u009F]+/gu, ' ').replace(/\s+/gu, ' ').trim();

const truncateChars = (input: string, maxChars: number): { text: string; truncated: boolean } => {
  const chars = Array.from(input);
  if (chars.length <= maxChars) return { text: input, truncated: false };
  return { text: chars.slice(0, maxChars).join('') + '…', truncated: true };
};

const workspaceLabel = (workspace: { readonly id: string; readonly path: string; readonly title?: string }): string =>
  workspace.title?.trim() || workspace.path.split(/[\\/]/).filter(Boolean).at(-1) || workspace.id;

function extractUserBlockContent(content: unknown): {
  text: string;
  attachments: { readonly type: 'image' | 'file'; readonly name?: string }[];
} {
  if (!Array.isArray(content)) return { text: '', attachments: [] };
  const textParts: string[] = [];
  const attachments: { readonly type: 'image' | 'file'; readonly name?: string }[] = [];
  for (const raw of content) {
    if (!isRecord(raw)) continue;
    if (raw.type === 'text' && typeof raw.text === 'string' && raw.text.trim()) {
      textParts.push(raw.text.trim());
    } else if (raw.type === 'image' || raw.type === 'file') {
      const attachment = isRecord(raw.attachment) ? raw.attachment : undefined;
      const name = typeof attachment?.name === 'string'
        ? attachment.name
        : typeof attachment?.fileName === 'string'
          ? attachment.fileName
          : undefined;
      attachments.push(Object.freeze({ type: raw.type, ...(name ? { name } : {}) }));
    }
  }
  return { text: scrubSensitiveText(textParts.join('\n').trim()).text, attachments };
}

function extractAssistantContent(
  content: unknown,
  stepTools: readonly { readonly id: string; readonly name: string }[],
  toolOutcomes: ReadonlyMap<string, 'ok' | 'error'>,
): {
  text: string;
  toolCalls: { readonly name: string; readonly status?: 'ok' | 'error' }[];
} {
  const textParts: string[] = [];
  const calls: { readonly name: string; readonly status?: 'ok' | 'error' }[] = [];
  const seenIds = new Set<string>();
  if (Array.isArray(content)) {
    for (const raw of content) {
      if (!isRecord(raw)) continue;
      if (raw.type === 'text' && typeof raw.text === 'string' && raw.text.trim()) {
        textParts.push(raw.text.trim());
      } else if (raw.type === 'tool-call' && typeof raw.name === 'string' && raw.name) {
        const callId = typeof raw.id === 'string' ? raw.id : '';
        if (callId) seenIds.add(callId);
        const status = callId ? toolOutcomes.get(callId) : undefined;
        calls.push(Object.freeze({ name: raw.name, ...(status ? { status } : {}) }));
      }
    }
  }
  for (const stepTool of stepTools) {
    if (seenIds.has(stepTool.id)) continue;
    const status = toolOutcomes.get(stepTool.id);
    calls.push(Object.freeze({ name: stepTool.name, ...(status ? { status } : {}) }));
  }
  return { text: scrubSensitiveText(textParts.join('\n').trim()).text, toolCalls: calls };
}

function isInternalManagedSession(header: Readonly<Record<string, unknown>>, managerSessionId: string | null): boolean {
  const id = typeof header.id === 'string' ? header.id : '';
  if (managerSessionId && id === managerSessionId) return true;
  const preset = typeof header.agentPreset === 'string' ? header.agentPreset : '';
  if (preset === ROUTER_PRESET || preset === WORKER_PRESET || preset === SCHEDULE_PRESET) return true;
  if (header.origin === 'subagent') return true;
  return false;
}

function parseSessionEvents(
  sessionId: string,
  header: Readonly<Record<string, unknown>>,
  events: readonly RawSessionEvent[],
  options: {
    readonly workspaceId: string | null;
    readonly workspaceTitle: string | null;
    readonly cwd: string | null;
    readonly archived: boolean;
    readonly running: boolean;
  },
): ParsedSession {
  const createdAt = typeof header.createdAt === 'number' && Number.isFinite(header.createdAt) ? header.createdAt : 0;
  let explicitTitle: string | undefined;
  let firstUserText: string | undefined;
  let lastUserText: string | undefined;
  let lastAssistantText: string | undefined;
  let lastEventTime = createdAt;
  let lastPromptAt = 0;
  let lastTurnEndedAt: number | null = null;
  let lastTurnOutcome: string | null = null;
  let turnStarts = 0;
  let userTurns = 0;
  let currentTurn = 0;

  const toolOutcomes = new Map<string, 'ok' | 'error'>();
  const stepTools = new Map<string, { readonly id: string; readonly name: string }[]>();

  for (const event of events) {
    if (!event || typeof event.type !== 'string') continue;
    if (event.type === 'tool/result' && isRecord(event.data)) {
      const msg = isRecord(event.data.message) ? event.data.message : undefined;
      const callId = typeof msg?.toolCallId === 'string' ? msg.toolCallId : undefined;
      if (callId) {
        toolOutcomes.set(callId, msg?.isError === true || isRecord(event.data.error) ? 'error' : 'ok');
      }
    } else if (event.type === 'tool/call' && isRecord(event.data)) {
      const turn = typeof event.data.turn === 'number' ? event.data.turn : 0;
      const step = typeof event.data.step === 'number' ? event.data.step : 0;
      const callId = typeof event.data.callId === 'string' ? event.data.callId : '';
      const name = typeof event.data.name === 'string' ? event.data.name : '';
      if (name) {
        const key = `${turn}/${step}`;
        const list = stepTools.get(key) ?? [];
        list.push({ id: callId, name });
        stepTools.set(key, list);
      }
    }
  }

  const messages: SessionMessageItem[] = [];
  for (const event of events) {
    if (!event || typeof event.type !== 'string') continue;
    const eventTime = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : lastEventTime;
    if (eventTime > lastEventTime) lastEventTime = eventTime;
    const seq = typeof event.seq === 'number' && Number.isSafeInteger(event.seq) ? event.seq : messages.length;

    if (event.type === 'session/title' && isRecord(event.data) && typeof event.data.title === 'string') {
      const normalized = cleanSingleLine(event.data.title);
      if (normalized) explicitTitle = normalized;
    } else if (event.type === 'turn/start' && isRecord(event.data)) {
      turnStarts++;
      if (typeof event.data.turn === 'number' && Number.isSafeInteger(event.data.turn)) {
        currentTurn = event.data.turn;
      } else {
        currentTurn = turnStarts;
      }
    } else if (event.type === 'turn/end' && isRecord(event.data)) {
      lastTurnEndedAt = eventTime;
      const reason = isRecord(event.data.reason) ? event.data.reason : undefined;
      lastTurnOutcome = typeof reason?.kind === 'string' ? reason.kind : 'completed';
    } else if (event.type === 'user/message' && isRecord(event.data)) {
      const source = isRecord(event.data.source) ? event.data.source : undefined;
      const sourceKind = typeof source?.kind === 'string' ? source.kind : 'user';
      const sourceForm = typeof source?.form === 'string' ? source.form : undefined;
      if (sourceKind !== 'user' && sourceForm !== 'recall') continue;
      const { text, attachments } = extractUserBlockContent(event.data.content);
      if (!text && !attachments.length) continue;
      userTurns++;
      const turn = currentTurn > 0 ? currentTurn : userTurns;
      if (eventTime > lastPromptAt) lastPromptAt = eventTime;
      const display = text || attachments.map(a => `[${a.type === 'image' ? '图片' : '文件'}${a.name ? ': ' + a.name : ''}]`).join(' ');
      if (firstUserText === undefined && sourceKind === 'user') firstUserText = display;
      if (sourceKind === 'user') lastUserText = display;
      const bounded = truncateChars(display, MAX_MESSAGE_CHARS);
      messages.push(Object.freeze({
        seq,
        turn,
        role: 'user',
        time: eventTime,
        text: bounded.text,
        ...(bounded.truncated ? { truncated: true as const } : {}),
        ...(attachments.length ? { attachments: Object.freeze(attachments) } : {}),
      }));
    } else if (event.type === 'assistant/message' && isRecord(event.data)) {
      const turn = typeof event.data.turn === 'number' ? event.data.turn : (currentTurn || userTurns || 1);
      const step = typeof event.data.step === 'number' ? event.data.step : 1;
      const messageObj = isRecord(event.data.message) ? event.data.message : event.data;
      const { text, toolCalls } = extractAssistantContent(
        messageObj.content,
        stepTools.get(`${turn}/${step}`) ?? [],
        toolOutcomes,
      );
      if (!text && !toolCalls.length) continue;
      if (text) lastAssistantText = text;
      const bounded = truncateChars(text, MAX_MESSAGE_CHARS);
      messages.push(Object.freeze({
        seq,
        turn,
        role: 'assistant',
        time: eventTime,
        text: bounded.text,
        ...(bounded.truncated ? { truncated: true as const } : {}),
        ...(toolCalls.length ? { toolCalls: Object.freeze(toolCalls) } : {}),
      }));
    }
  }

  const turnCount = Math.max(turnStarts, userTurns);
  if (lastTurnEndedAt === null && turnCount > 0 && !options.running && messages.length > 0) {
    lastTurnEndedAt = messages.at(-1)!.time;
    lastTurnOutcome = 'completed';
  }
  const updatedAt = Math.max(createdAt, lastEventTime, lastPromptAt, lastTurnEndedAt ?? 0);
  const fallbackTitle = firstUserText ? truncateChars(cleanSingleLine(firstUserText), 80).text : '';
  const title = explicitTitle || fallbackTitle || '未命名会话';

  let status: SessionStatus;
  if (options.running) status = 'running';
  else if (turnCount === 0 && messages.length === 0) status = 'blank';
  else if (lastTurnOutcome === 'blocked') status = 'needs_input';
  else status = 'completed';

  const firstPreview = firstUserText ? truncateChars(cleanSingleLine(firstUserText), MAX_PREVIEW_CHARS).text : null;
  const lastUserPreview = lastUserText ? truncateChars(cleanSingleLine(lastUserText), MAX_PREVIEW_CHARS).text : null;
  const lastAssistantPreview = lastAssistantText ? truncateChars(cleanSingleLine(lastAssistantText), MAX_PREVIEW_CHARS).text : null;

  const summary: SessionSummaryItem = Object.freeze({
    sessionId,
    title,
    workspaceId: options.workspaceId,
    workspaceTitle: options.workspaceTitle,
    cwd: options.cwd,
    status,
    lastTurnOutcome,
    archived: options.archived,
    createdAt,
    updatedAt,
    lastTurnEndedAt,
    turnCount,
    lastUserMessage: lastUserPreview,
    lastAssistantMessage: lastAssistantPreview,
  });

  const searchableText = [
    title,
    options.workspaceTitle ?? '',
    options.cwd ?? '',
    ...messages.map(m => m.text),
  ].join('\n').toLowerCase();

  return Object.freeze({
    summary,
    firstUserMessage: firstPreview,
    messages: Object.freeze(messages),
    searchableText,
  });
}

export class ScopedSessionReads<A extends CallerAgent> {
  readonly #cursors = new Map<string, CursorRecord>();
  readonly #coldCache = new Map<string, { readonly key: string; readonly parsed: ParsedSession }>();

  constructor(
    readonly authority: CallerAuthority<A>,
    readonly host: SessionReadHost,
  ) {}

  isAvailable(): boolean {
    try {
      this.host.assertAvailable();
      return true;
    } catch {
      return false;
    }
  }

  release(agent: A): void {
    for (const [token, entry] of this.#cursors) {
      if (entry.agent === agent || (isRecord(entry.agent) && entry.agent.id === agent.id)) {
        this.#cursors.delete(token);
      }
    }
  }

  dispose(): void {
    this.#cursors.clear();
    this.#coldCache.clear();
  }

  async #readEventsForSession(
    sessionId: string,
    live: ReturnType<NonNullable<SessionReadHost['liveSession']>>,
    signal: AbortSignal,
  ): Promise<{ header: Readonly<Record<string, unknown>>; events: readonly RawSessionEvent[] } | undefined> {
    if (live) {
      if (typeof live.snapshotEvents === 'function') {
        return { header: live.header, events: live.snapshotEvents() };
      }
      if (typeof live.deriveMessages === 'function') {
        const derived = live.deriveMessages();
        const events: RawSessionEvent[] = derived.map((msg, idx) => ({
          type: msg.role === 'assistant' ? 'assistant/message' : msg.role === 'user' ? 'user/message' : 'system/message',
          seq: idx,
          time: typeof live.header.createdAt === 'number' ? live.header.createdAt + idx : idx,
          data: msg.role === 'assistant' ? { turn: 1, step: idx + 1, message: msg } : msg,
        }));
        return { header: live.header, events };
      }
    }
    if (typeof this.host.openStoredSession !== 'function') return undefined;
    const handle = await this.host.openStoredSession(sessionId, signal);
    try {
      signal.throwIfAborted();
      this.host.assertAvailable();
      const events: RawSessionEvent[] = [];
      let offset = 0;
      while (offset < MAX_EVENTS_PER_SESSION) {
        const page = await handle.read(offset, READ_CHUNK, { signal });
        signal.throwIfAborted();
        this.host.assertAvailable();
        if (!page.events.length) break;
        events.push(...page.events);
        offset += page.events.length;
        if (page.events.length < READ_CHUNK) break;
      }
      return { header: handle.header, events };
    } finally {
      await handle.close();
    }
  }

  async #collectAllSessions(signal: AbortSignal): Promise<{
    readonly revision: string;
    readonly items: readonly ParsedSession[];
  }> {
    signal.throwIfAborted();
    this.host.assertAvailable();
    const managerId = this.host.managerSessionId();
    const workspaces = this.host.workspaces();
    const archivedSet = new Set(this.host.archivedSessionIds?.() ?? []);

    const bySessionId = new Map<string, { readonly id: string; readonly path: string; readonly title?: string }>();
    for (const ws of workspaces) {
      for (const sid of ws.sessionIds ?? []) {
        if (!bySessionId.has(sid)) bySessionId.set(sid, ws);
      }
    }

    const resolveWorkspace = (sessionId: string, cwd: string | undefined) => {
      const direct = bySessionId.get(sessionId);
      if (direct) return direct;
      if (!cwd) return undefined;
      let best: { readonly id: string; readonly path: string; readonly title?: string } | undefined;
      for (const ws of workspaces) {
        if (cwd === ws.path || cwd.startsWith(ws.path + '/')) {
          if (!best || ws.path.length > best.path.length) best = ws;
        }
      }
      return best;
    };

    const storedMap = new Map<string, { readonly header: Readonly<Record<string, unknown>>; readonly revision?: unknown; readonly eventCount?: number }>();
    if (typeof this.host.listStoredSessions === 'function') {
      const stored = await this.host.listStoredSessions(signal);
      signal.throwIfAborted();
      this.host.assertAvailable();
      for (const item of stored) {
        const id = typeof item.header?.id === 'string' ? item.header.id : undefined;
        if (id) storedMap.set(id, item);
      }
    }

    const candidateIds = new Set<string>([...storedMap.keys(), ...bySessionId.keys(), ...archivedSet]);
    const parsedList: ParsedSession[] = [];

    for (const sessionId of candidateIds) {
      signal.throwIfAborted();
      this.host.assertAvailable();
      if (managerId && sessionId === managerId) continue;

      const live = this.host.liveSession?.(sessionId);
      let stored = storedMap.get(sessionId);
      if (!live && !stored && typeof this.host.statStoredSession === 'function') {
        try {
          stored = await this.host.statStoredSession(sessionId, signal);
        } catch {
          stored = undefined;
        }
        signal.throwIfAborted();
        this.host.assertAvailable();
      }

      const header = live?.header ?? stored?.header;
      if (!header || isInternalManagedSession(header, managerId)) continue;

      const cwd = typeof header.cwd === 'string' && header.cwd ? header.cwd : undefined;
      const ws = resolveWorkspace(sessionId, cwd);
      const workspaceId = ws?.id ?? null;
      const workspaceTitle = ws ? workspaceLabel(ws) : null;
      const effectiveCwd = cwd ?? ws?.path ?? null;
      const archived = archivedSet.has(sessionId);
      const running = this.host.agentStatus?.(sessionId) === 'running';

      const cacheKey = !live && stored?.revision !== undefined
        ? JSON.stringify([ String(stored.revision), stored.eventCount ?? null, workspaceId, workspaceTitle, effectiveCwd, archived, running ])
        : undefined;
      if (cacheKey) {
        const cached = this.#coldCache.get(sessionId);
        if (cached && cached.key === cacheKey) {
          parsedList.push(cached.parsed);
          continue;
        }
      }

      let events: readonly RawSessionEvent[] = [];
      let effectiveHeader = header;
      try {
        const loaded = await this.#readEventsForSession(sessionId, live, signal);
        if (loaded) {
          effectiveHeader = loaded.header;
          events = loaded.events;
        }
      } catch (error) {
        if (signal.aborted) throw error;
      }
      signal.throwIfAborted();
      this.host.assertAvailable();
      if (isInternalManagedSession(effectiveHeader, managerId)) continue;

      const parsed = parseSessionEvents(sessionId, effectiveHeader, events, {
        workspaceId,
        workspaceTitle,
        cwd: effectiveCwd,
        archived,
        running,
      });
      if (cacheKey) {
        if (this.#coldCache.size >= 512) {
          const oldest = this.#coldCache.keys().next().value;
          if (oldest !== undefined) this.#coldCache.delete(oldest);
        }
        this.#coldCache.set(sessionId, { key: cacheKey, parsed });
      }
      parsedList.push(parsed);
    }

    parsedList.sort((a, b) =>
      b.summary.updatedAt - a.summary.updatedAt || a.summary.sessionId.localeCompare(b.summary.sessionId),
    );

    const revision = createHash('sha256')
      .update(JSON.stringify(parsedList.map(item => [
        item.summary.sessionId,
        item.summary.updatedAt,
        item.summary.status,
        item.summary.turnCount,
        item.summary.archived,
        item.messages.length,
      ])))
      .digest('hex')
      .slice(0, 24);

    return { revision, items: parsedList };
  }

  #saveCursor(record: Omit<CursorRecord, 'expiresAt'>): string {
    const token = randomUUID();
    if (this.#cursors.size >= 128) {
      const oldest = this.#cursors.keys().next().value;
      if (oldest !== undefined) this.#cursors.delete(oldest);
    }
    this.#cursors.set(token, { ...record, expiresAt: Date.now() + CURSOR_TTL_MS });
    return token;
  }

  async execute(args: unknown, exec: SessionToolInvocation<A>): Promise<unknown> {
    let lease;
    try {
      lease = this.authority.capture(exec);
    } catch (error) {
      if (exec.agent) this.release(exec.agent);
      throw error;
    }
    lease.require(exec.name, 'read');
    if (!(lease.role === 'router' && lease.foreground) && lease.role !== 'scheduled') {
      throw new CallerDenied('SESSION_FOREGROUND_REQUIRED', '只有前台大肥鱼会话或定时会话可以读取用户会话。');
    }
    const agent = exec.agent!;
    for (const [token, old] of this.#cursors) {
      if (isRecord(old.agent) && old.agent.id === agent.id && old.agent !== agent) {
        this.#cursors.delete(token);
      }
    }

    const input = asRecord(args === undefined ? {} : args);
    try {
      let result: unknown;
      if (exec.name === SESSION_TOOLS[0]) {
        result = await this.#executeList(input, agent, lease.fingerprint, exec.signal);
      } else if (exec.name === SESSION_TOOLS[1]) {
        result = await this.#executeRead(input, agent, lease.fingerprint, exec.signal);
      } else {
        throw new CallerDenied('INVALID_ARGUMENTS', '未知的会话工具调用。');
      }
      exec.signal.throwIfAborted();
      lease.assertCurrent();
      return result;
    } catch (error) {
      this.release(agent);
      throw error;
    }
  }

  async #executeList(
    input: Record<string, unknown>,
    agent: A,
    fingerprint: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (Object.keys(input).some(key => !['selector', 'limit', 'cursor'].includes(key))) {
      throw new CallerDenied('INVALID_ARGUMENTS', '工具参数包含未支持字段。');
    }
    const limit = input.limit === undefined ? 10 : input.limit;
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
      throw new CallerDenied('INVALID_ARGUMENTS', '分页大小必须在 1 到 20 之间。');
    }
    const cursorToken = input.cursor;
    if (cursorToken !== undefined && (typeof cursorToken !== 'string' || !cursorToken.length || cursorToken.length > 128)) {
      throw new CallerDenied('INVALID_ARGUMENTS', '分页游标无效。');
    }
    const selector = input.selector === undefined ? {} : asRecord(input.selector);
    if (Object.keys(selector).some(key => !['status', 'workspaceId', 'archived', 'query', 'updatedSince', 'updatedBefore'].includes(key))) {
      throw new CallerDenied('INVALID_ARGUMENTS', '筛选器包含未支持字段。');
    }
    const status = selector.status;
    if (status !== undefined && (typeof status !== 'string' || !SESSION_STATISTICS.includes(status as SessionStatus))) {
      throw new CallerDenied('INVALID_ARGUMENTS', '会话状态筛选值无效。');
    }
    const workspaceId = selector.workspaceId;
    if (workspaceId !== undefined && workspaceId !== null && (typeof workspaceId !== 'string' || !workspaceId.length || workspaceId.length > 256)) {
      throw new CallerDenied('INVALID_ARGUMENTS', '工作区标识无效。');
    }
    const archived = selector.archived ?? 'exclude';
    if (!['include', 'exclude', 'only'].includes(String(archived))) {
      throw new CallerDenied('INVALID_ARGUMENTS', '归档筛选值无效。');
    }
    const query = selector.query;
    if (query !== undefined && (typeof query !== 'string' || query.length > 500)) {
      throw new CallerDenied('INVALID_ARGUMENTS', '搜索关键词无效。');
    }
    const updatedSince = selector.updatedSince;
    if (updatedSince !== undefined && (typeof updatedSince !== 'number' || !Number.isSafeInteger(updatedSince) || updatedSince < 0)) {
      throw new CallerDenied('INVALID_ARGUMENTS', '更新时间下界无效。');
    }
    const updatedBefore = selector.updatedBefore;
    if (updatedBefore !== undefined && (typeof updatedBefore !== 'number' || !Number.isSafeInteger(updatedBefore) || updatedBefore < 0)) {
      throw new CallerDenied('INVALID_ARGUMENTS', '更新时间上界无效。');
    }

    const normalizedQuery = typeof query === 'string' ? query.trim().toLowerCase() : '';
    const terms = normalizedQuery ? normalizedQuery.split(/\s+/u).filter(Boolean) : [];
    const queryKey = JSON.stringify([status ?? null, workspaceId ?? undefined, archived, terms, updatedSince ?? null, updatedBefore ?? null, limit]);

    const cursor = cursorToken === undefined ? undefined : this.#cursors.get(cursorToken);
    if (cursorToken !== undefined) {
      if (!cursor || cursor.agent !== agent || cursor.fingerprint !== fingerprint || cursor.kind !== 'list' || cursor.queryKey !== queryKey || cursor.expiresAt <= Date.now()) {
        throw new CallerDenied('cursor_stale', '分页游标已失效，请重新查询。');
      }
    }

    const { revision, items } = await this.#collectAllSessions(signal);
    if (cursor && cursor.revision !== revision) {
      throw new CallerDenied('cursor_stale', '会话列表已更新，请重新查询。');
    }

    const filtered = items.filter(entry => {
      const s = entry.summary;
      if (status !== undefined && s.status !== status) return false;
      if (workspaceId !== undefined && s.workspaceId !== workspaceId) return false;
      if (archived === 'exclude' && s.archived) return false;
      if (archived === 'only' && !s.archived) return false;
      if (typeof updatedSince === 'number' && s.updatedAt < updatedSince) return false;
      if (typeof updatedBefore === 'number' && s.updatedAt >= updatedBefore) return false;
      if (terms.length > 0 && !terms.every(term => entry.searchableText.includes(term))) return false;
      return true;
    });

    const offset = cursor?.offset ?? 0;
    const pageItems = filtered.slice(offset, offset + limit).map(entry => entry.summary);
    const more = filtered.length > offset + limit;
    const nextCursor = more
      ? this.#saveCursor({ agent, fingerprint, kind: 'list', queryKey, revision, offset: offset + pageItems.length })
      : undefined;

    return {
      readScope: 'all-sessions',
      asOf: Date.now(),
      revision,
      total: filtered.length,
      items: pageItems,
      complete: !more,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  async #executeRead(
    input: Record<string, unknown>,
    agent: A,
    fingerprint: string,
    signal: AbortSignal,
  ): Promise<SessionReadPage> {
    if (Object.keys(input).some(key => !['sessionId', 'order', 'cursor'].includes(key))) {
      throw new CallerDenied('INVALID_ARGUMENTS', '工具参数包含未支持字段。');
    }
    const sessionId = input.sessionId;
    if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 512) {
      throw new CallerDenied('INVALID_ARGUMENTS', '会话标识无效。');
    }
    const order = (input.order ?? 'chronological') as 'chronological' | 'recent';
    if (order !== 'chronological' && order !== 'recent') {
      throw new CallerDenied('INVALID_ARGUMENTS', '消息排序方式无效。');
    }
    const cursorToken = input.cursor;
    if (cursorToken !== undefined && (typeof cursorToken !== 'string' || !cursorToken.length || cursorToken.length > 128)) {
      throw new CallerDenied('INVALID_ARGUMENTS', '分页游标无效。');
    }

    const queryKey = JSON.stringify([sessionId, order]);
    const cursor = cursorToken === undefined ? undefined : this.#cursors.get(cursorToken);
    if (cursorToken !== undefined) {
      if (!cursor || cursor.agent !== agent || cursor.fingerprint !== fingerprint || cursor.kind !== 'read' || cursor.queryKey !== queryKey || cursor.expiresAt <= Date.now()) {
        throw new CallerDenied('cursor_stale', '分页游标已失效，请重新读取。');
      }
    }

    const { items } = await this.#collectAllSessions(signal);
    const found = items.find(entry => entry.summary.sessionId === sessionId);
    if (!found) {
      throw new CallerDenied('SESSION_NOT_FOUND', '未找到指定的用户会话。');
    }

    const sessionRevision = JSON.stringify([found.summary.updatedAt, found.summary.status, found.messages.length]);
    if (cursor && cursor.revision !== sessionRevision) {
      throw new CallerDenied('cursor_stale', '该会话内容已更新，请重新读取。');
    }

    const orderedMessages = order === 'recent' ? [...found.messages].reverse() : found.messages;
    const offset = cursor?.offset ?? 0;
    const slice: SessionMessageItem[] = [];
    let usedChars = 0;
    for (let i = offset; i < orderedMessages.length && slice.length < MAX_PAGE_MESSAGES; i++) {
      const msg = orderedMessages[i]!;
      if (slice.length > 0 && usedChars + msg.text.length > MAX_PAGE_CHARS) break;
      slice.push(msg);
      usedChars += msg.text.length;
    }

    const more = offset + slice.length < orderedMessages.length;
    const nextCursor = more
      ? this.#saveCursor({ agent, fingerprint, kind: 'read', queryKey, revision: sessionRevision, offset: offset + slice.length })
      : undefined;

    return {
      readScope: 'all-sessions',
      session: {
        ...found.summary,
        firstUserMessage: found.firstUserMessage,
      },
      order,
      totalMessages: orderedMessages.length,
      messages: slice,
      complete: !more,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  /** 为 dsh_context_catalog / dsh_context_query 提供内置的 session.list 能力支持。 */
  capabilityDescriptor() {
    return {
      protocol: 1,
      id: SESSION_LIST_CAPABILITY,
      source: '用户会话',
      provider: SESSION_LIST_PROVIDER,
      description: '读取全部工作区的用户会话摘要，包含标题、所属工作区、当前状态（running/needs_input/completed/blank）、最近回合结束时间及首尾消息预览。默认排除已归档会话与大肥鱼自身会话。',
      scope: 'workspace',
      readScope: 'all-sessions',
      filters: {
        status: {
          type: 'string',
          description: '按会话状态筛选：running（进行中）、needs_input（待输入）、completed（已完成）、blank（空白未开始）。',
          enum: [...SESSION_STATISTICS],
        },
        workspaceId: {
          type: 'string',
          description: '只查询指定工作区 ID 的会话；省略时查询全部工作区。',
        },
        archived: {
          type: 'boolean',
          description: 'true 查询已归档会话，false 查询未归档会话。省略时默认查询未归档会话。',
        },
        query: {
          type: 'string',
          description: '按关键词匹配会话标题、工作区名称或对话内容。',
        },
        updatedFrom: {
          type: 'integer',
          description: '会话更新时间下界（含），Unix 毫秒。',
        },
        updatedBefore: {
          type: 'integer',
          description: '会话更新时间上界（不含），Unix 毫秒。',
        },
      },
      status: 'available' as const,
    };
  }

  async queryContext(access: ContextAccess, input: Record<string, unknown>): Promise<unknown> {
    access.assertCurrent();
    if (!Object.hasOwn(access.grants, SESSION_LIST_CAPABILITY)) {
      return { status: 'denied' };
    }
    if (!this.isAvailable()) {
      return { status: 'unavailable', capability: SESSION_LIST_CAPABILITY };
    }
    const limit = input.limit ?? 10;
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 20 ||
        (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 36))) {
      return { status: 'invalid_query', capability: SESSION_LIST_CAPABILITY };
    }
    const rawFilter = input.filter === undefined ? {} : input.filter;
    if (!isRecord(rawFilter)) return { status: 'invalid_query', capability: SESSION_LIST_CAPABILITY };
    for (const key of Object.keys(rawFilter)) {
      if (!['status', 'workspaceId', 'archived', 'query', 'updatedFrom', 'updatedBefore'].includes(key)) {
        return { status: 'invalid_query', capability: SESSION_LIST_CAPABILITY };
      }
    }
    if (rawFilter.status !== undefined && (typeof rawFilter.status !== 'string' || !SESSION_STATISTICS.includes(rawFilter.status as SessionStatus))) {
      return { status: 'invalid_query', capability: SESSION_LIST_CAPABILITY };
    }
    if (rawFilter.workspaceId !== undefined && (typeof rawFilter.workspaceId !== 'string' || rawFilter.workspaceId.length > 256)) {
      return { status: 'invalid_query', capability: SESSION_LIST_CAPABILITY };
    }
    if (rawFilter.archived !== undefined && typeof rawFilter.archived !== 'boolean') {
      return { status: 'invalid_query', capability: SESSION_LIST_CAPABILITY };
    }
    if (rawFilter.query !== undefined && (typeof rawFilter.query !== 'string' || rawFilter.query.length > 256)) {
      return { status: 'invalid_query', capability: SESSION_LIST_CAPABILITY };
    }
    if (rawFilter.updatedFrom !== undefined && (typeof rawFilter.updatedFrom !== 'number' || !Number.isSafeInteger(rawFilter.updatedFrom))) {
      return { status: 'invalid_query', capability: SESSION_LIST_CAPABILITY };
    }
    if (rawFilter.updatedBefore !== undefined && (typeof rawFilter.updatedBefore !== 'number' || !Number.isSafeInteger(rawFilter.updatedBefore))) {
      return { status: 'invalid_query', capability: SESSION_LIST_CAPABILITY };
    }

    const normalizedFilter = {
      status: rawFilter.status as SessionStatus | undefined,
      workspaceId: rawFilter.workspaceId as string | undefined,
      archived: (rawFilter.archived as boolean | undefined) ?? false,
      query: typeof rawFilter.query === 'string' ? rawFilter.query.trim().toLowerCase() : '',
      updatedFrom: rawFilter.updatedFrom as number | undefined,
      updatedBefore: rawFilter.updatedBefore as number | undefined,
    };
    const queryKey = JSON.stringify([access.binding, normalizedFilter, limit]);
    const cursorToken = input.cursor as string | undefined;
    const cursor = cursorToken === undefined ? undefined : this.#cursors.get(cursorToken);
    if (cursorToken !== undefined) {
      if (!cursor || cursor.fingerprint !== access.binding || cursor.kind !== 'context' || cursor.queryKey !== queryKey || cursor.expiresAt <= Date.now()) {
        return { status: 'cursor_stale', capability: SESSION_LIST_CAPABILITY };
      }
    }

    let collected;
    try {
      collected = await this.#collectAllSessions(access.signal);
    } catch {
      access.assertCurrent();
      return { status: 'unavailable', capability: SESSION_LIST_CAPABILITY };
    }
    access.assertCurrent();
    if (cursor && cursor.revision !== collected.revision) {
      return { status: 'cursor_stale', capability: SESSION_LIST_CAPABILITY };
    }

    const terms = normalizedFilter.query ? normalizedFilter.query.split(/\s+/u).filter(Boolean) : [];
    const visible = collected.items.filter(entry => {
      const s = entry.summary;
      if (normalizedFilter.status !== undefined && s.status !== normalizedFilter.status) return false;
      if (normalizedFilter.workspaceId !== undefined && s.workspaceId !== normalizedFilter.workspaceId) return false;
      if (s.archived !== normalizedFilter.archived) return false;
      if (normalizedFilter.updatedFrom !== undefined && s.updatedAt < normalizedFilter.updatedFrom) return false;
      if (normalizedFilter.updatedBefore !== undefined && s.updatedAt >= normalizedFilter.updatedBefore) return false;
      if (terms.length > 0 && !terms.every(term => entry.searchableText.includes(term))) return false;
      return true;
    });

    const offset = cursor?.offset ?? 0;
    const items = visible.slice(offset, offset + limit).map(entry => ({
      ref: { kind: 'session', id: entry.summary.sessionId },
      ...entry.summary,
    }));
    const more = visible.length > offset + limit;
    const nextCursor = more
      ? this.#saveCursor({
          agent: null,
          fingerprint: access.binding,
          kind: 'context',
          queryKey,
          revision: collected.revision,
          offset: offset + items.length,
        })
      : undefined;

    return {
      status: 'ok',
      capability: SESSION_LIST_CAPABILITY,
      source: '用户会话',
      readScope: 'all-sessions',
      readAt: new Date().toISOString(),
      revision: collected.revision,
      items,
      complete: !more,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }
}

export function withSessionContext<A extends CallerAgent>(
  base: () => ContextService | undefined,
  sessions: () => ScopedSessionReads<A> | undefined,
): ContextService {
  return {
    catalog(access: ContextAccess): unknown {
      access.assertCurrent();
      const reader = sessions();
      const baseService = base();
      const raw = baseService?.catalog(access);
      const hasSessionGrant = Object.hasOwn(access.grants, SESSION_LIST_CAPABILITY);
      if (!hasSessionGrant || !reader) {
        return raw ?? {
          status: 'ok',
          protocol: 1,
          workspaceId: access.scope.workspaceId,
          capabilities: Object.keys(access.grants).sort().map(id => ({ id, status: 'unavailable' })),
        };
      }
      const sessionCap = reader.isAvailable()
        ? reader.capabilityDescriptor()
        : { id: SESSION_LIST_CAPABILITY, status: 'unavailable' as const };
      if (!isRecord(raw) || !Array.isArray(raw.capabilities)) {
        const capabilities = Object.keys(access.grants).sort().map(id =>
          id === SESSION_LIST_CAPABILITY ? sessionCap : { id, status: 'unavailable' as const },
        );
        return { status: 'ok', protocol: 1, workspaceId: access.scope.workspaceId, capabilities };
      }
      const replaced = raw.capabilities.map((item: unknown) =>
        isRecord(item) && item.id === SESSION_LIST_CAPABILITY && item.status !== 'available'
          ? sessionCap
          : item,
      );
      if (!replaced.some((item: unknown) => isRecord(item) && item.id === SESSION_LIST_CAPABILITY)) {
        replaced.push(sessionCap);
        replaced.sort((a: unknown, b: unknown) =>
          String(isRecord(a) ? a.id : '').localeCompare(String(isRecord(b) ? b.id : '')),
        );
      }
      return { ...raw, capabilities: replaced };
    },
    status(grants: ContextAccess['grants']): readonly { id: string; available: boolean }[] {
      const reader = sessions();
      const baseService = base();
      const baseStatus = baseService?.status(grants) ?? Object.keys(grants).map(id => ({ id, available: false }));
      if (!reader?.isAvailable()) return baseStatus;
      return baseStatus.map(entry =>
        entry.id === SESSION_LIST_CAPABILITY ? { id: entry.id, available: true } : entry,
      );
    },
    async query(access: ContextAccess, input: unknown): Promise<unknown> {
      access.assertCurrent();
      const reader = sessions();
      if (isRecord(input) && input.capability === SESSION_LIST_CAPABILITY && reader?.isAvailable()) {
        if (Object.keys(input).some(key => !['capability', 'filter', 'limit', 'cursor'].includes(key))) {
          return { status: 'invalid_query' };
        }
        return reader.queryContext(access, input);
      }
      const baseService = base();
      if (!baseService) return { status: 'unavailable' };
      return baseService.query(access, input);
    },
  };
}

const sessionIdSchema = { type: 'string', minLength: 1, maxLength: 512 };
const sessionSelectorSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { enum: [...SESSION_STATISTICS], description: '会话状态：running（进行中）、needs_input（待输入）、completed（已完成）、blank（空白未开始）。' },
    workspaceId: { type: ['string', 'null'], description: '按工作区 ID 筛选；省略时返回全部工作区的会话。' },
    archived: { enum: ['include', 'exclude', 'only'], description: '是否包含已归档会话，默认 exclude。' },
    query: { type: 'string', maxLength: 500, description: '按关键词搜索会话标题、工作区或对话消息内容。' },
    updatedSince: { type: 'integer', minimum: 0, description: '会话最后更新时间下界（含），Unix 毫秒。' },
    updatedBefore: { type: 'integer', minimum: 0, description: '会话最后更新时间上界（不含），Unix 毫秒。' },
  },
};

export function sessionToolDefinitions<A extends CallerAgent>(reads: ScopedSessionReads<A>) {
  return [
    {
      name: SESSION_TOOLS[0],
      description: '列出或搜索全部工作区的用户会话摘要（含标题、工作区、状态 running/needs_input/completed/blank、更新时间、回合数及最近一轮用户/助手消息预览）。默认按最近更新时间倒序排列并排除大肥鱼自身会话。',
      properties: {
        selector: sessionSelectorSchema,
        limit: { type: 'integer', minimum: 1, maximum: 20 },
        cursor: sessionIdSchema,
      },
      required: [],
    },
    {
      name: SESSION_TOOLS[1],
      description: '读取指定用户会话的完整上下文与对话消息记录（用户提问、助手回复及工具调用摘要），用于总结会话内容或结合该会话上下文回答用户问题。长会话可通过返回的 nextCursor 分页续读。',
      properties: {
        sessionId: sessionIdSchema,
        order: { enum: ['chronological', 'recent'], description: 'chronological 按时间正序读取对话，recent 按最新消息倒序读取。默认 chronological。' },
        cursor: sessionIdSchema,
      },
      required: ['sessionId'],
    },
  ].map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: { type: 'object', additionalProperties: false, properties: tool.properties, required: tool.required },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: (args: unknown, exec: SessionToolInvocation<A>) => reads.execute(args, exec),
  }));
}
