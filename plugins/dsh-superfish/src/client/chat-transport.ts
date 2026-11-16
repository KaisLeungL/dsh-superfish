import type { ChatContent, ChatModelSelection, ChatSuggestionsPayload, DailyMotto } from '../app/health/chat-input.js';
import type { HealthView } from '../app/health/view.js';
import { CONTROL_TOKEN_HEADER } from '../status.js';

const BASE = '/api/workspace-superagent/';

export async function readChatHealth(signal?: AbortSignal) {
  const response = await fetch(BASE + 'health', { credentials: 'same-origin', cache: 'no-store', signal });
  if (!response.ok) throw Error('暂时无法读取主理状态。');
  return { health: await response.json() as HealthView, token: response.headers.get(CONTROL_TOKEN_HEADER) };
}

export async function mutateChat(body: object, token: string | null, signal?: AbortSignal) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (token) headers.set(CONTROL_TOKEN_HEADER, token);
  const response = await fetch(BASE + 'chat', { method: 'POST', credentials: 'same-origin', headers, signal, body: JSON.stringify(body) });
  const result = await response.json() as {
    ok?: boolean;
    health?: HealthView;
    dailyMotto?: DailyMotto | null;
    suggestions?: ChatSuggestionsPayload | null;
    error?: string;
  };
  if (!response.ok || !result.ok) throw Error(result.error ?? '请求未完成。');
  return result;
}

type Result<T> = { ok: true; value: T } | { ok: false; error: Error & { code: string; details: object } };
type Prompt = (request: { sessionId: string; requestId: string; content: ChatContent[] }, signal?: AbortSignal) => Promise<Result<{ accepted: true }>>;
type SelectModel = (request: ChatModelSelection & { sessionId: string }) => Promise<Result<{ selected: ChatModelSelection }>>;
type HistoryFollow = (request: Record<string, unknown>, signal?: AbortSignal) => AsyncIterable<unknown>;
type HistoryPage = (request: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;

export const WSA_HISTORY_PAGE_SIZE = 30;
export const WSA_HISTORY_PAGE_OPTIONS = {
  maxMessages: WSA_HISTORY_PAGE_SIZE,
  turnWindow: {
    minMessages: WSA_HISTORY_PAGE_SIZE,
    minTurns: 1,
  },
} as const;

export interface HistoryChatNodeLike {
  readonly kind?: string;
  readonly location?: {
    readonly kind?: string;
    readonly turn?: {
      readonly turn?: number;
    };
  };
}

export interface HistoryChatNodeLookup {
  get(key: string): HistoryChatNodeLike | undefined;
}

export interface HistoryPaginationSnapshot {
  readonly totalMessages: number;
  readonly visibleMessages: number;
  readonly hiddenMessageCount: number;
  readonly totalTurns: number;
  readonly visibleTurns: number;
  readonly hiddenTurnNumbers: readonly number[];
  readonly hiddenNodeKeys: readonly string[];
  readonly firstVisibleTurn: number | null;
  readonly firstVisibleNodeKey: string | null;
  readonly latestTurn: number | null;
}

const MESSAGE_NODE_KINDS = new Set(['user', 'turn-trigger', 'steering', 'assistant-step']);

export function isHistoryMessageNode(node: HistoryChatNodeLike | undefined): boolean {
  return Boolean(node?.kind && MESSAGE_NODE_KINDS.has(node.kind));
}

export function computeHistoryPagination(
  order: readonly string[],
  nodes: HistoryChatNodeLookup,
  visibleMessageLimit: number = WSA_HISTORY_PAGE_SIZE,
): HistoryPaginationSnapshot {
  const limit = Math.max(1, Math.floor(visibleMessageLimit));
  interface TurnBucket {
    readonly turn: number | null;
    readonly nodeKeys: string[];
    messageCount: number;
  }
  const buckets: TurnBucket[] = [];
  const turnMap = new Map<number, TurnBucket>();

  for (const key of order) {
    const node = nodes.get(key);
    if (!node) continue;
    const rawTurn = node.location?.turn?.turn;
    const turn = typeof rawTurn === 'number' && Number.isSafeInteger(rawTurn) ? rawTurn : null;
    const isMsg = isHistoryMessageNode(node);
    if (turn !== null) {
      let bucket = turnMap.get(turn);
      if (!bucket) {
        bucket = { turn, nodeKeys: [], messageCount: 0 };
        turnMap.set(turn, bucket);
        buckets.push(bucket);
      }
      bucket.nodeKeys.push(key);
      if (isMsg) bucket.messageCount += 1;
    } else {
      buckets.push({
        turn: null,
        nodeKeys: [key],
        messageCount: isMsg ? 1 : 0,
      });
    }
  }

  for (const bucket of buckets) {
    if (bucket.turn !== null && bucket.messageCount === 0 && bucket.nodeKeys.length > 0) {
      bucket.messageCount = 1;
    }
  }

  const totalMessages = buckets.reduce((sum, b) => sum + b.messageCount, 0);
  const turnBuckets = buckets.filter((b): b is TurnBucket & { readonly turn: number } => b.turn !== null);
  const totalTurns = turnBuckets.length;
  const latestTurn = turnBuckets.at(-1)?.turn ?? null;

  if (totalMessages <= limit || buckets.length <= 1) {
    return {
      totalMessages,
      visibleMessages: totalMessages,
      hiddenMessageCount: 0,
      totalTurns,
      visibleTurns: totalTurns,
      hiddenTurnNumbers: [],
      hiddenNodeKeys: [],
      firstVisibleTurn: turnBuckets[0]?.turn ?? null,
      firstVisibleNodeKey: buckets[0]?.nodeKeys[0] ?? null,
      latestTurn,
    };
  }

  let visibleMessages = 0;
  let cutoffIndex = buckets.length;
  for (let i = buckets.length - 1; i >= 0; i--) {
    if (visibleMessages >= limit && cutoffIndex < buckets.length) break;
    visibleMessages += buckets[i]!.messageCount;
    cutoffIndex = i;
  }

  const hiddenBuckets = buckets.slice(0, cutoffIndex);
  const visibleBuckets = buckets.slice(cutoffIndex);
  const hiddenMessageCount = Math.max(0, totalMessages - visibleMessages);
  const hiddenTurnNumbers = hiddenBuckets
    .filter((b): b is TurnBucket & { readonly turn: number } => b.turn !== null)
    .map(b => b.turn);
  const hiddenNodeKeys = hiddenBuckets.flatMap(b => b.nodeKeys);
  const visibleTurnBuckets = visibleBuckets.filter((b): b is TurnBucket & { readonly turn: number } => b.turn !== null);

  return {
    totalMessages,
    visibleMessages,
    hiddenMessageCount,
    totalTurns,
    visibleTurns: visibleTurnBuckets.length,
    hiddenTurnNumbers,
    hiddenNodeKeys,
    firstVisibleTurn: visibleTurnBuckets[0]?.turn ?? null,
    firstVisibleNodeKey: visibleBuckets[0]?.nodeKeys[0] ?? null,
    latestTurn,
  };
}

export function countMessagesFromTurn(
  order: readonly string[],
  nodes: HistoryChatNodeLookup,
  fromTurn: number,
): number {
  const turnCounts = new Map<number, { hasNodes: boolean; messages: number }>();
  for (const key of order) {
    const node = nodes.get(key);
    const turn = node?.location?.turn?.turn;
    if (typeof turn !== 'number' || !Number.isSafeInteger(turn) || turn < fromTurn) continue;
    let entry = turnCounts.get(turn);
    if (!entry) {
      entry = { hasNodes: true, messages: 0 };
      turnCounts.set(turn, entry);
    }
    if (isHistoryMessageNode(node)) entry.messages += 1;
  }
  let total = 0;
  for (const entry of turnCounts.values()) {
    total += entry.messages > 0 ? entry.messages : (entry.hasNodes ? 1 : 0);
  }
  return total;
}

export function applyHistoryPaginationRequest<T extends Record<string, unknown>>(
  request: T,
  targetSessionId?: string,
): T & typeof WSA_HISTORY_PAGE_OPTIONS {
  if (targetSessionId && typeof request?.address === 'object' && request.address !== null) {
    const addr = request.address as { kind?: string; sessionId?: string };
    if (typeof addr.sessionId === 'string' && addr.sessionId !== targetSessionId) {
      return request as T & typeof WSA_HISTORY_PAGE_OPTIONS;
    }
  }
  return {
    ...request,
    maxMessages: WSA_HISTORY_PAGE_OPTIONS.maxMessages,
    turnWindow: { ...WSA_HISTORY_PAGE_OPTIONS.turnWindow },
  };
}

export function withSessionHistoryPagination<T extends object>(
  sessionApi: T,
  targetSessionId?: string,
): T {
  let wrapped: { follow?: HistoryFollow; page?: HistoryPage } = sessionApi as { follow?: HistoryFollow; page?: HistoryPage };
  if (typeof wrapped.follow === 'function') {
    const rawFollow = wrapped.follow.bind(sessionApi);
    wrapped = withMethod(wrapped, 'follow', (request: Record<string, unknown>, signal?: AbortSignal) =>
      rawFollow(applyHistoryPaginationRequest(request ?? {}, targetSessionId), signal));
  }
  if (typeof wrapped.page === 'function') {
    const rawPage = wrapped.page.bind(sessionApi);
    wrapped = withMethod(wrapped, 'page', (request: Record<string, unknown>, signal?: AbortSignal) =>
      rawPage(applyHistoryPaginationRequest(request ?? {}, targetSessionId), signal));
  }
  return wrapped as T;
}

export function withRemoteHistoryPagination<T extends { session?: object }>(
  remote: T,
  targetSessionId?: string,
): T {
  if (!remote || typeof remote !== 'object' || !remote.session || typeof remote.session !== 'object') {
    return remote;
  }
  return withMethod(remote, 'session', withSessionHistoryPagination(remote.session, targetSessionId));
}

export type ChatReference = {
  sessionId: string;
  binding: {
    session: {
      remote: { session: { prompt: Prompt; follow?: HistoryFollow; page?: HistoryPage } };
      events?: { remote?: unknown };
      loadOlder?(): Promise<unknown> | void;
    };
  };
  ready: Promise<unknown>;
  release(): void;
};
export interface ChatModelDirectories {
  directoryFor(sessionId: string): { sessions: { selectModel: SelectModel } };
}

function withMethod<T extends object, K extends keyof T>(source: T, name: K, replacement: T[K]): T {
  return new Proxy(Object.create(null) as T, { get(_target, key) {
    if (key === name) return replacement;
    const value = Reflect.get(source, key, source);
    return typeof value === 'function' ? value.bind(source) : value;
  } });
}

// 仅替换当前会话及其模型目录的传输，保留普通聊天的编辑器、发送回执和模型菜单，并将会话历史分页限制为每页 30 条消息。
export function attachChatTransport(reference: ChatReference, models: ChatModelDirectories,
  request: (body: object, signal?: AbortSignal) => Promise<unknown>): () => void {
  const { sessionId, binding: { session } } = reference;
  const directory = models.directoryFor(sessionId);
  const remote = session.remote, modelRemote = directory.sessions;
  if (typeof remote?.session?.prompt !== 'function' || typeof modelRemote?.selectModel !== 'function') throw Error('当前 DSH 的输入框接口不兼容。');
  const failure = (error: unknown) => ({ ok: false as const, error: Object.assign(
    new Error(error instanceof Error ? error.message : '主理请求未完成。'), { code: 'session/agent-busy', details: {} },
  ) });
  const prompt: Prompt = async (value, signal) => {
    try {
      if (value.sessionId !== sessionId) throw Error('主理会话已变化。');
      if (!value.content.length) throw Error('请重新发送上一条消息。');
      await request({ sessionId, requestId: value.requestId, content: value.content }, signal);
      return { ok: true, value: { accepted: true } };
    } catch (error) { return failure(error); }
  };
  const selectModel: SelectModel = async ({ sessionId: target, ...model }) => {
    try {
      if (target !== sessionId) throw Error('主理会话已变化。');
      await request({ sessionId, model });
      return { ok: true, value: { selected: model } };
    } catch (error) { return failure(error); }
  };
  const paginatedSessionApi = withSessionHistoryPagination(withMethod(remote.session, 'prompt', prompt), sessionId);
  const chatRemote = withMethod(remote, 'session', paginatedSessionApi);
  const chatModels = withMethod(modelRemote, 'selectModel', selectModel);
  const eventsStream = session.events && typeof session.events === 'object' ? session.events : undefined;
  const prevEventsRemote = eventsStream?.remote;
  session.remote = chatRemote;
  if (eventsStream && 'remote' in eventsStream) {
    eventsStream.remote = chatRemote;
  }
  try { directory.sessions = chatModels; }
  catch (error) {
    session.remote = remote;
    if (eventsStream && 'remote' in eventsStream) eventsStream.remote = prevEventsRemote;
    throw error;
  }
  return () => {
    if (session.remote === chatRemote) session.remote = remote;
    if (eventsStream && eventsStream.remote === chatRemote) eventsStream.remote = prevEventsRemote;
    if (directory.sessions === chatModels) directory.sessions = modelRemote;
  };
}
