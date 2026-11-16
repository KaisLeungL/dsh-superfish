import { randomUUID } from 'node:crypto';
import {
  MEMORY_CATEGORIES,
  type MemoryCategory,
  type MemoryCounts,
  type MemoryScope,
  type MemorySearchFilter,
  type MemoryUpsertInput,
  type PublicMemoryItem,
} from '../app/memory/service.js';
import { scrubSensitiveText } from '../app/sentinel/scrubber.js';
import {
  CallerAuthority,
  CallerDenied,
  MEMORY_TOOLS,
  MEMORY_WRITE_TOOLS,
  type CallerAgent,
  type Invocation,
} from './authority.js';
import type { ContextAccess, ContextService } from './context.js';

export const PERSONAL_MEMORY_CAPABILITY = 'personal.memory';
export const PERSONAL_MEMORY_PROVIDER = '@local/dsh-superfish/personal-memory';

export interface MemoryReadHost {
  assertAvailable(): void;
  workspaceId(): string;
  searchMemories(filter?: MemorySearchFilter): {
    readonly items: readonly PublicMemoryItem[];
    readonly counts: MemoryCounts;
    readonly revision: string;
  };
  now?(): number;
}

export interface MemoryWriteHost {
  saveMemory(sessionId: string | null, input: MemoryUpsertInput): {
    readonly action: 'created' | 'updated';
    readonly item: PublicMemoryItem;
  };
  deleteMemory(id: string): {
    readonly deleted: boolean;
    readonly id: string;
  };
}

export interface MemoryToolInvocation<A extends CallerAgent> extends Invocation<A> {
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

const CURSOR_TTL_MS = 300_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const asRecord = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) throw new CallerDenied('INVALID_ARGUMENTS', '工具参数必须是对象。');
  return value;
};

const isMemoryCategory = (value: unknown): value is MemoryCategory =>
  typeof value === 'string' && (MEMORY_CATEGORIES as readonly string[]).includes(value);

export class ScopedMemoryReads<A extends CallerAgent> {
  readonly #cursors = new Map<string, CursorRecord>();

  constructor(
    readonly authority: CallerAuthority<A>,
    readonly host: MemoryReadHost,
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

  async execute(args: unknown, exec: MemoryToolInvocation<A>): Promise<unknown> {
    let lease;
    try {
      lease = this.authority.capture(exec);
    } catch (error) {
      if (exec.agent) this.release(exec.agent);
      throw error;
    }
    lease.require(exec.name, 'read');
    if (!(lease.role === 'router' && lease.foreground) && lease.role !== 'scheduled') {
      throw new CallerDenied('MEMORY_READ_DENIED', '只有前台大肥鱼会话或定时会话可以检索长期记忆。');
    }
    const agent = exec.agent!;
    for (const [token, old] of this.#cursors) {
      if (isRecord(old.agent) && old.agent.id === agent.id && old.agent !== agent) {
        this.#cursors.delete(token);
      }
    }

    const input = asRecord(args === undefined ? {} : args);
    try {
      if (exec.name !== MEMORY_TOOLS[0]) {
        throw new CallerDenied('INVALID_ARGUMENTS', '未知的长期记忆读取工具调用。');
      }
      const result = this.#executeSearch(input, agent, lease.fingerprint);
      exec.signal.throwIfAborted();
      lease.assertCurrent();
      return result;
    } catch (error) {
      this.release(agent);
      throw error;
    }
  }

  #executeSearch(
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
    if (Object.keys(selector).some(key => !['category', 'pinned', 'tag', 'query', 'scope'].includes(key))) {
      throw new CallerDenied('INVALID_ARGUMENTS', '筛选器包含未支持字段。');
    }
    const category = selector.category;
    if (category !== undefined && !isMemoryCategory(category)) {
      throw new CallerDenied('INVALID_ARGUMENTS', '记忆分类无效。');
    }
    const pinned = selector.pinned;
    if (pinned !== undefined && typeof pinned !== 'boolean') {
      throw new CallerDenied('INVALID_ARGUMENTS', '常驻标记筛选值必须是布尔值。');
    }
    const tag = selector.tag;
    if (tag !== undefined && (typeof tag !== 'string' || !tag.trim() || tag.length > 64)) {
      throw new CallerDenied('INVALID_ARGUMENTS', '标签筛选值无效。');
    }
    const query = selector.query;
    if (query !== undefined && (typeof query !== 'string' || query.length > 300)) {
      throw new CallerDenied('INVALID_ARGUMENTS', '搜索关键词无效。');
    }
    const scope = selector.scope;
    if (scope !== undefined && scope !== 'workspace' && scope !== 'global' && scope !== 'all') {
      throw new CallerDenied('INVALID_ARGUMENTS', '记忆作用域无效（支持 workspace / global / all）。');
    }

    const filter: MemorySearchFilter = {
      ...(category !== undefined ? { category } : {}),
      ...(pinned !== undefined ? { pinned } : {}),
      ...(typeof tag === 'string' ? { tag: tag.trim() } : {}),
      ...(typeof query === 'string' && query.trim() ? { query: query.trim() } : {}),
      ...(scope !== undefined ? { scope } : {}),
    };
    const queryKey = JSON.stringify([
      filter.category ?? null,
      filter.pinned ?? null,
      filter.tag?.toLowerCase() ?? null,
      filter.query?.toLowerCase() ?? null,
      filter.scope ?? 'all',
      limit,
    ]);

    const cursor = cursorToken === undefined ? undefined : this.#cursors.get(cursorToken);
    if (cursorToken !== undefined) {
      if (!cursor || cursor.agent !== agent || cursor.fingerprint !== fingerprint || cursor.kind !== 'list' || cursor.queryKey !== queryKey || cursor.expiresAt <= this.#now()) {
        throw new CallerDenied('cursor_stale', '分页游标已失效，请重新查询。');
      }
    }

    this.host.assertAvailable();
    const workspaceId = this.host.workspaceId();
    const searched = this.host.searchMemories(filter);
    if (cursor && cursor.revision !== searched.revision) {
      throw new CallerDenied('cursor_stale', '长期记忆已更新，请重新查询。');
    }

    const offset = cursor?.offset ?? 0;
    const pageItems = searched.items.slice(offset, offset + limit);
    const more = searched.items.length > offset + limit;
    const nextCursor = more
      ? this.#saveCursor({ agent, fingerprint, kind: 'list', queryKey, revision: searched.revision, offset: offset + pageItems.length })
      : undefined;

    return {
      readScope: 'workspace-personal-memory',
      workspaceId,
      asOf: this.#now(),
      revision: searched.revision,
      total: searched.items.length,
      counts: searched.counts,
      items: pageItems,
      complete: !more,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  /** 为 dsh_context_catalog / dsh_context_query 提供内置的 personal.memory 能力支持。 */
  capabilityDescriptor() {
    return {
      protocol: 1,
      id: PERSONAL_MEMORY_CAPABILITY,
      source: '长期记忆',
      provider: PERSONAL_MEMORY_PROVIDER,
      description: '读取与检索当前工作区的长期记忆（含常驻核心记忆 pinned=true 与归档记忆 pinned=false，覆盖用户偏好 preference、用户画像 profile、项目背景 project、关键决策 decision 与事实备忘 fact，支持 SQLite FTS5 全文相关性排序）。',
      scope: 'workspace',
      readScope: 'workspace',
      filters: {
        category: {
          type: 'string',
          description: '按记忆分类筛选：preference / profile / project / decision / fact。',
        },
        pinned: {
          type: 'boolean',
          description: 'true 仅查询常驻核心记忆，false 仅查询归档记忆；省略时查询全部记忆。',
        },
        tag: {
          type: 'string',
          description: '按精确标签（不区分大小写）筛选。',
        },
        query: {
          type: 'string',
          description: '按关键词进行 FTS5 全文检索。',
        },
      },
      status: 'available' as const,
    };
  }

  async queryContext(access: ContextAccess, input: Record<string, unknown>): Promise<unknown> {
    access.assertCurrent();
    if (!Object.hasOwn(access.grants, PERSONAL_MEMORY_CAPABILITY)) {
      return { status: 'denied' };
    }
    if (!this.isAvailable()) {
      return { status: 'unavailable', capability: PERSONAL_MEMORY_CAPABILITY };
    }
    const limit = input.limit ?? 10;
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 20 ||
        (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 36))) {
      return { status: 'invalid_query', capability: PERSONAL_MEMORY_CAPABILITY };
    }
    const rawFilter = input.filter === undefined ? {} : input.filter;
    if (!isRecord(rawFilter)) return { status: 'invalid_query', capability: PERSONAL_MEMORY_CAPABILITY };
    for (const key of Object.keys(rawFilter)) {
      if (!['category', 'pinned', 'tag', 'query'].includes(key)) {
        return { status: 'invalid_query', capability: PERSONAL_MEMORY_CAPABILITY };
      }
    }
    if (rawFilter.category !== undefined && !isMemoryCategory(rawFilter.category)) {
      return { status: 'invalid_query', capability: PERSONAL_MEMORY_CAPABILITY };
    }
    if (rawFilter.pinned !== undefined && typeof rawFilter.pinned !== 'boolean') {
      return { status: 'invalid_query', capability: PERSONAL_MEMORY_CAPABILITY };
    }
    if (rawFilter.tag !== undefined && (typeof rawFilter.tag !== 'string' || !rawFilter.tag.trim() || rawFilter.tag.length > 64)) {
      return { status: 'invalid_query', capability: PERSONAL_MEMORY_CAPABILITY };
    }
    if (rawFilter.query !== undefined && (typeof rawFilter.query !== 'string' || rawFilter.query.length > 256)) {
      return { status: 'invalid_query', capability: PERSONAL_MEMORY_CAPABILITY };
    }

    const filter: MemorySearchFilter = {
      ...(rawFilter.category !== undefined ? { category: rawFilter.category } : {}),
      ...(rawFilter.pinned !== undefined ? { pinned: rawFilter.pinned } : {}),
      ...(typeof rawFilter.tag === 'string' ? { tag: rawFilter.tag.trim() } : {}),
      ...(typeof rawFilter.query === 'string' && rawFilter.query.trim() ? { query: rawFilter.query.trim() } : {}),
    };
    const queryKey = JSON.stringify([access.binding, filter, limit]);
    const cursorToken = input.cursor as string | undefined;
    const cursor = cursorToken === undefined ? undefined : this.#cursors.get(cursorToken);
    if (cursorToken !== undefined) {
      if (!cursor || cursor.fingerprint !== access.binding || cursor.kind !== 'context' || cursor.queryKey !== queryKey || cursor.expiresAt <= this.#now()) {
        return { status: 'cursor_stale', capability: PERSONAL_MEMORY_CAPABILITY };
      }
    }

    let searched;
    try {
      this.host.assertAvailable();
      searched = this.host.searchMemories(filter);
    } catch {
      access.assertCurrent();
      return { status: 'unavailable', capability: PERSONAL_MEMORY_CAPABILITY };
    }
    access.assertCurrent();
    if (cursor && cursor.revision !== searched.revision) {
      return { status: 'cursor_stale', capability: PERSONAL_MEMORY_CAPABILITY };
    }

    const offset = cursor?.offset ?? 0;
    const items = searched.items.slice(offset, offset + limit).map(item => ({
      ref: { kind: 'personal-memory', id: item.id },
      ...item,
    }));
    const more = searched.items.length > offset + limit;
    const nextCursor = more
      ? this.#saveCursor({
          agent: null,
          fingerprint: access.binding,
          kind: 'context',
          queryKey,
          revision: searched.revision,
          offset: offset + items.length,
        })
      : undefined;

    return {
      status: 'ok',
      capability: PERSONAL_MEMORY_CAPABILITY,
      source: '长期记忆',
      readScope: 'workspace',
      readAt: new Date(this.#now()).toISOString(),
      revision: searched.revision,
      counts: searched.counts,
      items,
      complete: !more,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }
}

export function withMemoryContext<A extends CallerAgent>(
  base: () => ContextService | undefined,
  memories: () => ScopedMemoryReads<A> | undefined,
): ContextService {
  return {
    catalog(access: ContextAccess): unknown {
      access.assertCurrent();
      const reader = memories();
      const baseService = base();
      const raw = baseService?.catalog(access);
      const hasGrant = Object.hasOwn(access.grants, PERSONAL_MEMORY_CAPABILITY);
      if (!hasGrant || !reader) {
        return raw ?? {
          status: 'ok',
          protocol: 1,
          workspaceId: access.scope.workspaceId,
          capabilities: Object.keys(access.grants).sort().map(id => ({ id, status: 'unavailable' })),
        };
      }
      const memCap = reader.isAvailable()
        ? reader.capabilityDescriptor()
        : { id: PERSONAL_MEMORY_CAPABILITY, status: 'unavailable' as const };
      if (!isRecord(raw) || !Array.isArray(raw.capabilities)) {
        const capabilities = Object.keys(access.grants).sort().map(id =>
          id === PERSONAL_MEMORY_CAPABILITY ? memCap : { id, status: 'unavailable' as const },
        );
        return { status: 'ok', protocol: 1, workspaceId: access.scope.workspaceId, capabilities };
      }
      const replaced = raw.capabilities.map((item: unknown) =>
        isRecord(item) && item.id === PERSONAL_MEMORY_CAPABILITY && item.status !== 'available'
          ? memCap
          : item,
      );
      if (!replaced.some((item: unknown) => isRecord(item) && item.id === PERSONAL_MEMORY_CAPABILITY)) {
        replaced.push(memCap);
        replaced.sort((a: unknown, b: unknown) =>
          String(isRecord(a) ? a.id : '').localeCompare(String(isRecord(b) ? b.id : '')),
        );
      }
      return { ...raw, capabilities: replaced };
    },
    status(grants: ContextAccess['grants']): readonly { id: string; available: boolean }[] {
      const reader = memories();
      const baseService = base();
      const baseStatus = baseService?.status(grants) ?? Object.keys(grants).map(id => ({ id, available: false }));
      if (!reader?.isAvailable()) return baseStatus;
      return baseStatus.map(entry =>
        entry.id === PERSONAL_MEMORY_CAPABILITY ? { id: entry.id, available: true } : entry,
      );
    },
    async query(access: ContextAccess, input: unknown): Promise<unknown> {
      access.assertCurrent();
      const reader = memories();
      if (isRecord(input) && input.capability === PERSONAL_MEMORY_CAPABILITY && reader?.isAvailable()) {
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
const memorySelectorSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    category: {
      enum: [...MEMORY_CATEGORIES],
      description: '按记忆分类筛选：preference（偏好习惯）、profile（用户画像）、project（项目背景）、decision（关键决策）、fact（事实备忘）。',
    },
    pinned: {
      type: 'boolean',
      description: 'true 仅返回常驻核心记忆，false 仅返回按需归档记忆；省略时返回全部。',
    },
    tag: {
      type: 'string',
      maxLength: 64,
      description: '按标签精确筛选（不区分大小写）。',
    },
    query: {
      type: 'string',
      maxLength: 300,
      description: '按关键词进行 SQLite FTS5 全文检索（支持中英文匹配与相关性排序）。',
    },
    scope: {
      enum: ['workspace', 'global', 'all'],
      description: '按作用域筛选：workspace（仅当前工作区记忆）、global（跨工作区全局个人记忆）、all（联合检索，默认）。',
    },
  },
};

export function memoryReadToolDefinitions<A extends CallerAgent>(reads: ScopedMemoryReads<A>) {
  return [
    {
      name: MEMORY_TOOLS[0],
      description: '检索当前工作区与跨工作区全局层的长期记忆（含常驻核心记忆与归档记忆，支持按分类 category、常驻标记 pinned、标签 tag、作用域 scope 及关键词 query 进行 FTS5 全文搜索与分页）。',
      properties: {
        selector: memorySelectorSchema,
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
    execute: (args: unknown, exec: MemoryToolInvocation<A>) => reads.execute(args, exec),
  }));
}

export function memoryWriteToolDefinitions<A extends CallerAgent>(
  writer: MemoryWriteHost,
  checkForegroundRouter: (exec: MemoryToolInvocation<A>) => { session: string; turn: number },
) {
  return [
    {
      name: MEMORY_WRITE_TOOLS[0],
      description: '新建或更新当前工作区或全局个人层的一条长期记忆（同时自动同步至 .dsh/MEMORY.md）。若已有同主题记忆，请传入原 id 更新或使用相同 category+title 覆盖，避免重复记录。核心偏好与长期项目规范设 pinned=true，具体历史事实或阶段性决策设 pinned=false。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
            description: '更新已有记忆时传入原记忆 ID；新建时省略。',
          },
          category: {
            enum: [...MEMORY_CATEGORIES],
            description: '记忆分类：preference（沟通/汇报/工作偏好）、profile（用户角色与职责画像）、project（长期项目背景与架构约定）、decision（已确认的重要决策）、fact（值得长期保留的客观事实）。',
          },
          title: {
            type: 'string',
            minLength: 1,
            maxLength: 120,
            description: '简短明确的记忆标题（不超过 120 字）。',
          },
          content: {
            type: 'string',
            minLength: 1,
            maxLength: 2000,
            description: '提炼后的记忆正文（简明扼要，不超过 2000 字，严禁包含密钥或隐私凭证）。',
          },
          tags: {
            type: 'array',
            items: { type: 'string', minLength: 1, maxLength: 40 },
            maxItems: 10,
            description: '可选检索标签列表（最多 10 个）。',
          },
          pinned: {
            type: 'boolean',
            description: '是否作为常驻核心记忆（true 时自动注入每轮系统提示词；默认 false 存入归档检索库）。',
          },
          importance: {
            type: 'integer',
            minimum: 1,
            maximum: 5,
            description: '重要程度（1~5，5 为最高）。',
          },
          scope: {
            enum: ['workspace', 'global'],
            description: '记忆存储作用域：workspace（仅当前项目有效，默认）或 global（跨所有工作区共享的个人画像/偏好记忆）。',
          },
        },
        required: ['category', 'title', 'content'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (rawArgs: unknown, exec: MemoryToolInvocation<A>) => {
        const { session } = checkForegroundRouter(exec);
        const input = asRecord(rawArgs);
        if (Object.keys(input).some(k => !['id', 'category', 'title', 'content', 'tags', 'pinned', 'importance', 'scope'].includes(k))) {
          throw new CallerDenied('INVALID_ARGUMENTS', '工具参数包含未支持字段。');
        }
        if (input.id !== undefined && (typeof input.id !== 'string' || !input.id.trim() || input.id.length > 128)) {
          throw new CallerDenied('INVALID_ARGUMENTS', '记忆 ID 无效。');
        }
        if (!isMemoryCategory(input.category)) {
          throw new CallerDenied('INVALID_ARGUMENTS', '记忆分类无效。');
        }
        if (typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length > 120) {
          throw new CallerDenied('INVALID_ARGUMENTS', '记忆标题不能为空且长度不能超过 120 字。');
        }
        if (typeof input.content !== 'string' || !input.content.trim() || input.content.trim().length > 2000) {
          throw new CallerDenied('INVALID_ARGUMENTS', '记忆内容不能为空且长度不能超过 2000 字。');
        }
        let tags: string[] | undefined;
        if (input.tags !== undefined) {
          if (!Array.isArray(input.tags) || input.tags.length > 10 || input.tags.some(t => typeof t !== 'string' || !t.trim() || t.trim().length > 40)) {
            throw new CallerDenied('INVALID_ARGUMENTS', '标签列表无效（最多 10 个，每个不超过 40 字）。');
          }
          tags = input.tags.map(t => (t as string).trim());
        }
        if (input.pinned !== undefined && typeof input.pinned !== 'boolean') {
          throw new CallerDenied('INVALID_ARGUMENTS', 'pinned 必须是布尔值。');
        }
        if (input.importance !== undefined && (typeof input.importance !== 'number' || !Number.isSafeInteger(input.importance) || input.importance < 1 || input.importance > 5)) {
          throw new CallerDenied('INVALID_ARGUMENTS', 'importance 必须是 1 到 5 之间的整数。');
        }
        if (input.scope !== undefined && input.scope !== 'workspace' && input.scope !== 'global') {
          throw new CallerDenied('INVALID_ARGUMENTS', 'scope 必须是 workspace 或 global。');
        }
        const safeTitle = scrubSensitiveText(input.title.trim()).text;
        const safeContent = scrubSensitiveText(input.content.trim()).text;
        const saved = writer.saveMemory(session, {
          ...(typeof input.id === 'string' ? { id: input.id.trim() } : {}),
          category: input.category,
          title: safeTitle,
          content: safeContent,
          ...(tags ? { tags } : {}),
          ...(typeof input.pinned === 'boolean' ? { pinned: input.pinned } : {}),
          ...(typeof input.importance === 'number' ? { importance: input.importance } : {}),
          ...(input.scope === 'workspace' || input.scope === 'global' ? { scope: input.scope as MemoryScope } : {}),
        });
        return { status: 'ok', action: saved.action, item: saved.item };
      },
    },
    {
      name: MEMORY_WRITE_TOOLS[1],
      description: '删除一条已过时、错误或用户要求忘掉的长期记忆。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
            description: '要删除的长期记忆 ID。',
          },
        },
        required: ['id'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (rawArgs: unknown, exec: MemoryToolInvocation<A>) => {
        checkForegroundRouter(exec);
        const input = asRecord(rawArgs);
        if (Object.keys(input).length !== 1 || typeof input.id !== 'string' || !input.id.trim() || input.id.length > 128) {
          throw new CallerDenied('INVALID_ARGUMENTS', '必须提供有效的记忆 ID。');
        }
        const res = writer.deleteMemory(input.id.trim());
        return { status: 'ok', deleted: res.deleted, id: res.id };
      },
    },
  ];
}
