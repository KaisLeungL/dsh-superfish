import { createHash, randomUUID } from 'node:crypto';
import type { PublicTodo } from '../app/personal/service.js';
import {
  CallerAuthority,
  CallerDenied,
  PERSONAL_TOOLS,
  TODO_WRITE_TOOLS,
  type CallerAgent,
  type Invocation,
} from './authority.js';
import type { ContextAccess, ContextService } from './context.js';

export const PERSONAL_TODOS_CAPABILITY = 'personal.todos';
export const PERSONAL_TODOS_PROVIDER = '@local/dsh-superfish/personal-todos';

export type TodoTimingStatus = 'overdue' | 'today' | 'upcoming' | 'done';

export interface TodoSummaryItem extends PublicTodo {
  readonly timingStatus: TodoTimingStatus;
}

export interface TodoCounts {
  readonly total: number;
  readonly pending: number;
  readonly overdue: number;
  readonly todayPending: number;
  readonly upcomingPending: number;
  readonly done: number;
  readonly doneToday: number;
}

export interface TodoReadHost {
  assertAvailable(): void;
  workspaceId(): string;
  listTodos(): readonly PublicTodo[];
  now?(): number;
}

export interface TodoToolInvocation<A extends CallerAgent> extends Invocation<A> {
  readonly name: string;
}

interface CursorRecord {
  readonly agent: unknown;
  readonly fingerprint: string;
  readonly kind: 'list' | 'context';
  readonly queryKey: string;
  readonly revision: string;
  readonly offset: number;
  readonly expiresAt: number;
}

const TODO_STATUS_FILTERS = ['pending', 'done', 'all'] as const;
type TodoStatusFilter = typeof TODO_STATUS_FILTERS[number];
const CURSOR_TTL_MS = 300_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const asRecord = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) throw new CallerDenied('INVALID_ARGUMENTS', '工具参数必须是对象。');
  return value;
};

const isValidLocalDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
};

export function formatLocalDate(epochMs: number): string {
  const day = new Date(epochMs);
  return [
    day.getFullYear(),
    String(day.getMonth() + 1).padStart(2, '0'),
    String(day.getDate()).padStart(2, '0'),
  ].join('-');
}

function classifyTiming(item: PublicTodo, localToday: string): TodoTimingStatus {
  if (item.done) return 'done';
  if (item.localDate < localToday) return 'overdue';
  if (item.localDate === localToday) return 'today';
  return 'upcoming';
}

export class ScopedTodoReads<A extends CallerAgent> {
  readonly #cursors = new Map<string, CursorRecord>();

  constructor(
    readonly authority: CallerAuthority<A>,
    readonly host: TodoReadHost,
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
  }

  #now(): number {
    return typeof this.host.now === 'function' ? this.host.now() : Date.now();
  }

  #saveCursor(record: Omit<CursorRecord, 'expiresAt'>): string {
    const token = randomUUID();
    if (this.#cursors.size >= 128) {
      const oldest = this.#cursors.keys().next().value;
      if (oldest !== undefined) this.#cursors.delete(oldest);
    }
    this.#cursors.set(token, { ...record, expiresAt: this.#now() + CURSOR_TTL_MS });
    return token;
  }

  #collectTodos(): {
    readonly workspaceId: string;
    readonly localToday: string;
    readonly revision: string;
    readonly counts: TodoCounts;
    readonly items: readonly TodoSummaryItem[];
  } {
    this.host.assertAvailable();
    const workspaceId = this.host.workspaceId();
    const localToday = formatLocalDate(this.#now());
    const rawItems = this.host.listTodos();

    const decorated = rawItems.map((item, index) => ({
      index,
      summary: Object.freeze({
        ...item,
        timingStatus: classifyTiming(item, localToday),
      }) as TodoSummaryItem,
    }));

    decorated.sort((a, b) => {
      if (a.summary.done !== b.summary.done) return a.summary.done ? 1 : -1;
      if (!a.summary.done) {
        return a.summary.localDate.localeCompare(b.summary.localDate) || a.index - b.index;
      }
      return b.summary.localDate.localeCompare(a.summary.localDate) || a.index - b.index;
    });

    const items = Object.freeze(decorated.map(entry => entry.summary));
    let pending = 0;
    let overdue = 0;
    let todayPending = 0;
    let upcomingPending = 0;
    let done = 0;
    let doneToday = 0;
    for (const item of items) {
      if (item.done) {
        done++;
        if (item.localDate === localToday) doneToday++;
      } else {
        pending++;
        if (item.timingStatus === 'overdue') overdue++;
        else if (item.timingStatus === 'today') todayPending++;
        else upcomingPending++;
      }
    }

    const counts: TodoCounts = Object.freeze({
      total: items.length,
      pending,
      overdue,
      todayPending,
      upcomingPending,
      done,
      doneToday,
    });

    const revision = createHash('sha256')
      .update(JSON.stringify([
        workspaceId,
        localToday,
        items.map(item => [
          item.id,
          item.revision,
          item.localDate,
          item.done,
          item.title,
          item.boardTaskId ?? null,
          item.sourceUnavailable ?? false,
        ]),
      ]))
      .digest('hex')
      .slice(0, 24);

    return { workspaceId, localToday, revision, counts, items };
  }

  async execute(args: unknown, exec: TodoToolInvocation<A>): Promise<unknown> {
    let lease;
    try {
      lease = this.authority.capture(exec);
    } catch (error) {
      if (exec.agent) this.release(exec.agent);
      throw error;
    }
    lease.require(exec.name, 'read');
    if (!(lease.role === 'router' && lease.foreground) && lease.role !== 'scheduled') {
      throw new CallerDenied('TODO_READ_DENIED', '只有前台大肥鱼会话或定时会话可以读取个人待办。');
    }
    const agent = exec.agent!;
    for (const [token, old] of this.#cursors) {
      if (isRecord(old.agent) && old.agent.id === agent.id && old.agent !== agent) {
        this.#cursors.delete(token);
      }
    }

    const input = asRecord(args === undefined ? {} : args);
    try {
      if (exec.name !== PERSONAL_TOOLS[0]) {
        throw new CallerDenied('INVALID_ARGUMENTS', '未知的个人待办工具调用。');
      }
      const result = this.#executeList(input, agent, lease.fingerprint);
      exec.signal.throwIfAborted();
      lease.assertCurrent();
      return result;
    } catch (error) {
      this.release(agent);
      throw error;
    }
  }

  #executeList(
    input: Record<string, unknown>,
    agent: A,
    fingerprint: string,
  ): unknown {
    if (Object.keys(input).some(key => !['selector', 'limit', 'cursor'].includes(key))) {
      throw new CallerDenied('INVALID_ARGUMENTS', '工具参数包含未支持字段。');
    }
    const limit = input.limit === undefined ? 20 : input.limit;
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new CallerDenied('INVALID_ARGUMENTS', '分页大小必须在 1 到 50 之间。');
    }
    const cursorToken = input.cursor;
    if (cursorToken !== undefined && (typeof cursorToken !== 'string' || !cursorToken.length || cursorToken.length > 128)) {
      throw new CallerDenied('INVALID_ARGUMENTS', '分页游标无效。');
    }
    const selector = input.selector === undefined ? {} : asRecord(input.selector);
    if (Object.keys(selector).some(key => !['status', 'localDate', 'dateFrom', 'dateTo', 'query'].includes(key))) {
      throw new CallerDenied('INVALID_ARGUMENTS', '筛选器包含未支持字段。');
    }
    const status = (selector.status ?? 'all') as TodoStatusFilter;
    if (typeof status !== 'string' || !TODO_STATUS_FILTERS.includes(status)) {
      throw new CallerDenied('INVALID_ARGUMENTS', '待办状态筛选值无效。');
    }
    const localDate = selector.localDate;
    if (localDate !== undefined && !isValidLocalDate(localDate)) {
      throw new CallerDenied('INVALID_ARGUMENTS', '计划日期格式无效，须为 YYYY-MM-DD。');
    }
    const dateFrom = selector.dateFrom;
    if (dateFrom !== undefined && !isValidLocalDate(dateFrom)) {
      throw new CallerDenied('INVALID_ARGUMENTS', '起始日期格式无效，须为 YYYY-MM-DD。');
    }
    const dateTo = selector.dateTo;
    if (dateTo !== undefined && !isValidLocalDate(dateTo)) {
      throw new CallerDenied('INVALID_ARGUMENTS', '截止日期格式无效，须为 YYYY-MM-DD。');
    }
    const query = selector.query;
    if (query !== undefined && (typeof query !== 'string' || query.length > 500)) {
      throw new CallerDenied('INVALID_ARGUMENTS', '搜索关键词无效。');
    }

    const normalizedQuery = typeof query === 'string' ? query.trim().toLowerCase() : '';
    const terms = normalizedQuery ? normalizedQuery.split(/\s+/u).filter(Boolean) : [];
    const queryKey = JSON.stringify([status, localDate ?? null, dateFrom ?? null, dateTo ?? null, terms, limit]);

    const cursor = cursorToken === undefined ? undefined : this.#cursors.get(cursorToken);
    if (cursorToken !== undefined) {
      if (!cursor || cursor.agent !== agent || cursor.fingerprint !== fingerprint || cursor.kind !== 'list' || cursor.queryKey !== queryKey || cursor.expiresAt <= this.#now()) {
        throw new CallerDenied('cursor_stale', '分页游标已失效，请重新查询。');
      }
    }

    const collected = this.#collectTodos();
    if (cursor && cursor.revision !== collected.revision) {
      throw new CallerDenied('cursor_stale', '个人待办已更新，请重新查询。');
    }

    const filtered = collected.items.filter(item => {
      if (status === 'pending' && item.done) return false;
      if (status === 'done' && !item.done) return false;
      if (localDate !== undefined && item.localDate !== localDate) return false;
      if (dateFrom !== undefined && item.localDate < dateFrom) return false;
      if (dateTo !== undefined && item.localDate > dateTo) return false;
      if (terms.length > 0) {
        const hay = `${item.title}\n${item.localDate}`.toLowerCase();
        if (!terms.every(term => hay.includes(term))) return false;
      }
      return true;
    });

    const offset = cursor?.offset ?? 0;
    const pageItems = filtered.slice(offset, offset + limit);
    const more = filtered.length > offset + limit;
    const nextCursor = more
      ? this.#saveCursor({ agent, fingerprint, kind: 'list', queryKey, revision: collected.revision, offset: offset + pageItems.length })
      : undefined;

    return {
      readScope: 'workspace-personal-todos',
      workspaceId: collected.workspaceId,
      localToday: collected.localToday,
      asOf: this.#now(),
      revision: collected.revision,
      total: filtered.length,
      counts: collected.counts,
      items: pageItems,
      complete: !more,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  /** 为 dsh_context_catalog / dsh_context_query 提供内置的 personal.todos 能力支持。 */
  capabilityDescriptor() {
    return {
      protocol: 1,
      id: PERSONAL_TODOS_CAPABILITY,
      source: '个人待办',
      provider: PERSONAL_TODOS_PROVIDER,
      description: '读取当前工作区的个人待办清单（含标题、计划日期 localDate、完成状态 done、时间分类 timingStatus：overdue/today/upcoming/done，以及关联看板卡片 ID）。默认未完成待办按日期升序优先返回。',
      scope: 'workspace',
      readScope: 'workspace',
      filters: {
        done: {
          type: 'boolean',
          description: 'false 仅查询未完成待办，true 仅查询已完成待办；省略时查询全部待办。',
        },
        localDate: {
          type: 'string',
          description: '按具体计划日期（YYYY-MM-DD）筛选。',
        },
        dateFrom: {
          type: 'string',
          description: '计划日期下界（含，YYYY-MM-DD）。',
        },
        dateTo: {
          type: 'string',
          description: '计划日期上界（含，YYYY-MM-DD）。',
        },
        query: {
          type: 'string',
          description: '按关键词匹配待办标题。',
        },
      },
      status: 'available' as const,
    };
  }

  async queryContext(access: ContextAccess, input: Record<string, unknown>): Promise<unknown> {
    access.assertCurrent();
    if (!Object.hasOwn(access.grants, PERSONAL_TODOS_CAPABILITY)) {
      return { status: 'denied' };
    }
    if (!this.isAvailable()) {
      return { status: 'unavailable', capability: PERSONAL_TODOS_CAPABILITY };
    }
    const limit = input.limit ?? 10;
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 20 ||
        (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 36))) {
      return { status: 'invalid_query', capability: PERSONAL_TODOS_CAPABILITY };
    }
    const rawFilter = input.filter === undefined ? {} : input.filter;
    if (!isRecord(rawFilter)) return { status: 'invalid_query', capability: PERSONAL_TODOS_CAPABILITY };
    for (const key of Object.keys(rawFilter)) {
      if (!['done', 'localDate', 'dateFrom', 'dateTo', 'query'].includes(key)) {
        return { status: 'invalid_query', capability: PERSONAL_TODOS_CAPABILITY };
      }
    }
    if (rawFilter.done !== undefined && typeof rawFilter.done !== 'boolean') {
      return { status: 'invalid_query', capability: PERSONAL_TODOS_CAPABILITY };
    }
    if (rawFilter.localDate !== undefined && !isValidLocalDate(rawFilter.localDate)) {
      return { status: 'invalid_query', capability: PERSONAL_TODOS_CAPABILITY };
    }
    if (rawFilter.dateFrom !== undefined && !isValidLocalDate(rawFilter.dateFrom)) {
      return { status: 'invalid_query', capability: PERSONAL_TODOS_CAPABILITY };
    }
    if (rawFilter.dateTo !== undefined && !isValidLocalDate(rawFilter.dateTo)) {
      return { status: 'invalid_query', capability: PERSONAL_TODOS_CAPABILITY };
    }
    if (rawFilter.query !== undefined && (typeof rawFilter.query !== 'string' || rawFilter.query.length > 256)) {
      return { status: 'invalid_query', capability: PERSONAL_TODOS_CAPABILITY };
    }

    const normalizedFilter = {
      done: rawFilter.done as boolean | undefined,
      localDate: rawFilter.localDate as string | undefined,
      dateFrom: rawFilter.dateFrom as string | undefined,
      dateTo: rawFilter.dateTo as string | undefined,
      query: typeof rawFilter.query === 'string' ? rawFilter.query.trim().toLowerCase() : '',
    };
    const queryKey = JSON.stringify([access.binding, normalizedFilter, limit]);
    const cursorToken = input.cursor as string | undefined;
    const cursor = cursorToken === undefined ? undefined : this.#cursors.get(cursorToken);
    if (cursorToken !== undefined) {
      if (!cursor || cursor.fingerprint !== access.binding || cursor.kind !== 'context' || cursor.queryKey !== queryKey || cursor.expiresAt <= this.#now()) {
        return { status: 'cursor_stale', capability: PERSONAL_TODOS_CAPABILITY };
      }
    }

    let collected;
    try {
      collected = this.#collectTodos();
    } catch {
      access.assertCurrent();
      return { status: 'unavailable', capability: PERSONAL_TODOS_CAPABILITY };
    }
    access.assertCurrent();
    if (cursor && cursor.revision !== collected.revision) {
      return { status: 'cursor_stale', capability: PERSONAL_TODOS_CAPABILITY };
    }

    const terms = normalizedFilter.query ? normalizedFilter.query.split(/\s+/u).filter(Boolean) : [];
    const visible = collected.items.filter(item => {
      if (normalizedFilter.done !== undefined && item.done !== normalizedFilter.done) return false;
      if (normalizedFilter.localDate !== undefined && item.localDate !== normalizedFilter.localDate) return false;
      if (normalizedFilter.dateFrom !== undefined && item.localDate < normalizedFilter.dateFrom) return false;
      if (normalizedFilter.dateTo !== undefined && item.localDate > normalizedFilter.dateTo) return false;
      if (terms.length > 0) {
        const hay = `${item.title}\n${item.localDate}`.toLowerCase();
        if (!terms.every(term => hay.includes(term))) return false;
      }
      return true;
    });

    const offset = cursor?.offset ?? 0;
    const items = visible.slice(offset, offset + limit).map(item => ({
      ref: { kind: 'personal-todo', id: item.id },
      ...item,
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
      capability: PERSONAL_TODOS_CAPABILITY,
      source: '个人待办',
      readScope: 'workspace',
      readAt: new Date(this.#now()).toISOString(),
      localToday: collected.localToday,
      revision: collected.revision,
      counts: collected.counts,
      items,
      complete: !more,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }
}

export function withTodoContext<A extends CallerAgent>(
  base: () => ContextService | undefined,
  todos: () => ScopedTodoReads<A> | undefined,
): ContextService {
  return {
    catalog(access: ContextAccess): unknown {
      access.assertCurrent();
      const reader = todos();
      const baseService = base();
      const raw = baseService?.catalog(access);
      const hasTodoGrant = Object.hasOwn(access.grants, PERSONAL_TODOS_CAPABILITY);
      if (!hasTodoGrant || !reader) {
        return raw ?? {
          status: 'ok',
          protocol: 1,
          workspaceId: access.scope.workspaceId,
          capabilities: Object.keys(access.grants).sort().map(id => ({ id, status: 'unavailable' })),
        };
      }
      const todoCap = reader.isAvailable()
        ? reader.capabilityDescriptor()
        : { id: PERSONAL_TODOS_CAPABILITY, status: 'unavailable' as const };
      if (!isRecord(raw) || !Array.isArray(raw.capabilities)) {
        const capabilities = Object.keys(access.grants).sort().map(id =>
          id === PERSONAL_TODOS_CAPABILITY ? todoCap : { id, status: 'unavailable' as const },
        );
        return { status: 'ok', protocol: 1, workspaceId: access.scope.workspaceId, capabilities };
      }
      const replaced = raw.capabilities.map((item: unknown) =>
        isRecord(item) && item.id === PERSONAL_TODOS_CAPABILITY && item.status !== 'available'
          ? todoCap
          : item,
      );
      if (!replaced.some((item: unknown) => isRecord(item) && item.id === PERSONAL_TODOS_CAPABILITY)) {
        replaced.push(todoCap);
        replaced.sort((a: unknown, b: unknown) =>
          String(isRecord(a) ? a.id : '').localeCompare(String(isRecord(b) ? b.id : '')),
        );
      }
      return { ...raw, capabilities: replaced };
    },
    status(grants: ContextAccess['grants']): readonly { id: string; available: boolean }[] {
      const reader = todos();
      const baseService = base();
      const baseStatus = baseService?.status(grants) ?? Object.keys(grants).map(id => ({ id, available: false }));
      if (!reader?.isAvailable()) return baseStatus;
      return baseStatus.map(entry =>
        entry.id === PERSONAL_TODOS_CAPABILITY ? { id: entry.id, available: true } : entry,
      );
    },
    async query(access: ContextAccess, input: unknown): Promise<unknown> {
      access.assertCurrent();
      const reader = todos();
      if (isRecord(input) && input.capability === PERSONAL_TODOS_CAPABILITY && reader?.isAvailable()) {
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

const cursorSchema = { type: 'string', minLength: 1, maxLength: 128 };
const localDateSchema = {
  type: 'string',
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
  description: '本地计划日期，格式为 YYYY-MM-DD。',
};
const todoSelectorSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: {
      enum: [...TODO_STATUS_FILTERS],
      description: '按完成状态筛选：pending（未完成，含逾期/今日/未来）、done（已完成）、all（全部，默认）。',
    },
    localDate: {
      ...localDateSchema,
      description: '仅返回指定计划日期（YYYY-MM-DD）的个人待办。',
    },
    dateFrom: {
      ...localDateSchema,
      description: '计划日期下界（含，YYYY-MM-DD）。',
    },
    dateTo: {
      ...localDateSchema,
      description: '计划日期上界（含，YYYY-MM-DD）。',
    },
    query: {
      type: 'string',
      maxLength: 500,
      description: '按关键词匹配待办标题或日期。',
    },
  },
};

export function todoToolDefinitions<A extends CallerAgent>(reads: ScopedTodoReads<A>) {
  return [
    {
      name: PERSONAL_TOOLS[0],
      description: '读取当前工作区中用户的个人待办清单（含标题、计划日期 localDate、完成状态 done、时间分类 timingStatus：overdue 逾期未完 / today 今日待办 / upcoming 未来计划 / done 已完成，以及统计概览 counts 与关联看板卡片 ID）。默认未完成待办按日期升序优先排列，已完成待办按日期倒序排列。',
      properties: {
        selector: todoSelectorSchema,
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        cursor: cursorSchema,
      },
      required: [],
    },
  ].map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: { type: 'object', additionalProperties: false, properties: tool.properties, required: tool.required },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: (args: unknown, exec: TodoToolInvocation<A>) => reads.execute(args, exec),
  }));
}

export interface TodoCreateInput {
  readonly title: string;
  readonly localDate: string;
  readonly boardTaskId?: string;
}

export interface TodoUpdateInput {
  readonly id: string;
  readonly revision: number;
  readonly title?: string;
  readonly localDate?: string;
  readonly done?: boolean;
}

export interface TodoWriteHost {
  listTodos(): readonly PublicTodo[];
  createTodo(session: string, input: TodoCreateInput): Promise<readonly PublicTodo[]>;
  updateTodo(session: string, input: TodoUpdateInput): Promise<readonly PublicTodo[]>;
  now?(): number;
}

const createTodoItemSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 160, description: '待办标题，简明具体。' },
    localDate: { ...localDateSchema, description: '计划日期 YYYY-MM-DD；省略则默认为今天。' },
    boardTaskId: { type: 'string', minLength: 1, maxLength: 128, description: '可选，要关联的看板任务 ID。' },
  },
  required: ['title'],
};

function normalizeCreateItem(raw: unknown, defaultDate: string): TodoCreateInput {
  const item = asRecord(raw);
  if (Object.keys(item).some(key => !['title', 'localDate', 'boardTaskId'].includes(key))) {
    throw new CallerDenied('INVALID_ARGUMENTS', '待办创建参数包含未支持字段。');
  }
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  if (!title || title.length > 160) {
    throw new CallerDenied('INVALID_ARGUMENTS', '待办标题不能为空且长度不能超过 160 字。');
  }
  let localDate = defaultDate;
  if (item.localDate !== undefined) {
    if (!isValidLocalDate(item.localDate)) {
      throw new CallerDenied('INVALID_ARGUMENTS', 'localDate 必须是有效日期 YYYY-MM-DD。');
    }
    localDate = item.localDate;
  }
  let boardTaskId: string | undefined;
  if (item.boardTaskId !== undefined) {
    if (typeof item.boardTaskId !== 'string' || !item.boardTaskId.trim() || item.boardTaskId.length > 128) {
      throw new CallerDenied('INVALID_ARGUMENTS', 'boardTaskId 必须是非空字符串。');
    }
    boardTaskId = item.boardTaskId.trim();
  }
  return { title, localDate, ...(boardTaskId ? { boardTaskId } : {}) };
}

function findDuplicateTodo(todos: readonly PublicTodo[], input: TodoCreateInput): PublicTodo | undefined {
  if (input.boardTaskId) {
    const byBoard = todos.find(todo => todo.localDate === input.localDate && todo.boardTaskId === input.boardTaskId);
    if (byBoard) return byBoard;
  }
  const needle = input.title.trim().toLowerCase();
  return todos.find(todo => !todo.done && todo.localDate === input.localDate && todo.title.trim().toLowerCase() === needle);
}

export function todoWriteToolDefinitions<A extends CallerAgent>(
  writer: TodoWriteHost,
  checkForegroundRouter: (exec: TodoToolInvocation<A>) => { readonly session: string; readonly turn: number },
) {
  return [
    {
      name: TODO_WRITE_TOOLS[0],
      description: '直接把 1 条或最多 20 条个人待办写入用户个人待办清单（右侧面板会同步更新）。仅当用户明确要求加入/记录/添加待办时调用；如果是你主动建议或拆解的候选待办，请用 GenUI DshTodoChecklist 等交互方式让用户自己勾选。同日同标题或同关联看板卡会自动去重。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 160, description: '单条创建时的待办标题；与 items 二选一。' },
          localDate: { ...localDateSchema, description: '单条创建时的计划日期 YYYY-MM-DD；省略默认为今天。' },
          boardTaskId: { type: 'string', minLength: 1, maxLength: 128, description: '单条创建时可选关联的看板任务 ID。' },
          items: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: createTodoItemSchema,
            description: '批量创建待办列表（1 到 20 条）；与顶层 title 二选一。',
          },
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (rawArgs: unknown, exec: TodoToolInvocation<A>) => {
        const { session } = checkForegroundRouter(exec);
        const input = asRecord(rawArgs);
        if (Object.keys(input).some(key => !['title', 'localDate', 'boardTaskId', 'items'].includes(key))) {
          throw new CallerDenied('INVALID_ARGUMENTS', '工具参数包含未支持字段。');
        }
        const defaultDate = formatLocalDate(writer.now?.() ?? Date.now());
        let candidates: TodoCreateInput[];
        if (input.items !== undefined) {
          if (input.title !== undefined || input.localDate !== undefined || input.boardTaskId !== undefined) {
            throw new CallerDenied('INVALID_ARGUMENTS', 'items 与顶层单条字段不能同时传入。');
          }
          if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 20) {
            throw new CallerDenied('INVALID_ARGUMENTS', 'items 必须是 1 到 20 条待办对象。');
          }
          candidates = input.items.map(entry => normalizeCreateItem(entry, defaultDate));
        } else if (input.title !== undefined) {
          candidates = [normalizeCreateItem(input, defaultDate)];
        } else {
          throw new CallerDenied('INVALID_ARGUMENTS', '必须提供 title 或 items。');
        }

        let currentTodos = writer.listTodos();
        const results: { action: 'created' | 'deduped'; item: PublicTodo }[] = [];
        for (const item of candidates) {
          const duplicate = findDuplicateTodo(currentTodos, item);
          if (duplicate) {
            results.push({ action: 'deduped', item: duplicate });
            continue;
          }
          const existingIds = new Set(currentTodos.map(todo => todo.id));
          currentTodos = await writer.createTodo(session, item);
          const created = currentTodos.find(todo => !existingIds.has(todo.id))
            ?? findDuplicateTodo(currentTodos, item);
          if (created) results.push({ action: 'created', item: created });
        }

        return {
          status: 'ok',
          createdCount: results.filter(entry => entry.action === 'created').length,
          dedupedCount: results.filter(entry => entry.action === 'deduped').length,
          results,
          totalTodos: currentTodos.length,
        };
      },
    },
    {
      name: TODO_WRITE_TOOLS[1],
      description: '直接修改用户个人待办的完成状态、标题或计划日期（例如标记完成/未完成、顺延到明天、修改标题）。如未知 id，请先调用 steward_list_todos 查询。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 128, description: '要修改的个人待办 ID。' },
          done: { type: 'boolean', description: '是否已完成。' },
          title: { type: 'string', minLength: 1, maxLength: 160, description: '新的待办标题。' },
          localDate: { ...localDateSchema, description: '新的计划日期 YYYY-MM-DD（如顺延明天）。' },
        },
        required: ['id'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (rawArgs: unknown, exec: TodoToolInvocation<A>) => {
        const { session } = checkForegroundRouter(exec);
        const input = asRecord(rawArgs);
        if (Object.keys(input).some(key => !['id', 'done', 'title', 'localDate'].includes(key))) {
          throw new CallerDenied('INVALID_ARGUMENTS', '工具参数包含未支持字段。');
        }
        const id = typeof input.id === 'string' ? input.id.trim() : '';
        if (!id || id.length > 128) {
          throw new CallerDenied('INVALID_ARGUMENTS', '必须提供有效的待办 ID。');
        }
        if (input.done === undefined && input.title === undefined && input.localDate === undefined) {
          throw new CallerDenied('INVALID_ARGUMENTS', '至少需要提供 done、title 或 localDate 中的一项。');
        }
        if (input.done !== undefined && typeof input.done !== 'boolean') {
          throw new CallerDenied('INVALID_ARGUMENTS', 'done 必须是布尔值。');
        }
        let nextTitle: string | undefined;
        if (input.title !== undefined) {
          if (typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length > 160) {
            throw new CallerDenied('INVALID_ARGUMENTS', '待办标题不能为空且长度不能超过 160 字。');
          }
          nextTitle = input.title.trim();
        }
        let nextDate: string | undefined;
        if (input.localDate !== undefined) {
          if (!isValidLocalDate(input.localDate)) {
            throw new CallerDenied('INVALID_ARGUMENTS', 'localDate 必须是有效日期 YYYY-MM-DD。');
          }
          nextDate = input.localDate;
        }
        const existing = writer.listTodos().find(todo => todo.id === id);
        if (!existing) {
          throw new CallerDenied('NOT_FOUND', '未找到对应的个人待办，请先调用 steward_list_todos 确认 ID。');
        }
        const changed = (nextTitle !== undefined && nextTitle !== existing.title)
          || (nextDate !== undefined && nextDate !== existing.localDate)
          || (input.done !== undefined && input.done !== existing.done);
        if (!changed) {
          return { status: 'ok', action: 'unchanged', item: existing };
        }
        const updatedList = await writer.updateTodo(session, {
          id: existing.id,
          revision: existing.revision,
          ...(nextTitle !== undefined ? { title: nextTitle } : {}),
          ...(nextDate !== undefined ? { localDate: nextDate } : {}),
          ...(typeof input.done === 'boolean' ? { done: input.done } : {}),
        });
        const updated = updatedList.find(todo => todo.id === existing.id) ?? existing;
        return { status: 'ok', action: 'updated', item: updated };
      },
    },
  ];
}
