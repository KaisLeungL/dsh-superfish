import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AUTO_MEMORY_MIRROR_HEADER, truncateUtf8Safe } from '../../prompts/soul.js';

export const MEMORY_CATEGORIES = ['preference', 'profile', 'project', 'decision', 'fact'] as const;
export type MemoryCategory = typeof MEMORY_CATEGORIES[number];
export type MemoryScope = 'workspace' | 'global';
export const GLOBAL_MEMORY_WORKSPACE_ID = '__global__';

export const MAX_MEMORIES_PER_WORKSPACE = 1000;
export const MAX_CORE_MEMORY_ITEMS = 20;
export const MAX_CORE_MEMORY_BYTES = 4096;

interface MemoryRow {
  id: string;
  workspace_id: string;
  category: MemoryCategory;
  title: string;
  content: string;
  tags_json: string;
  pinned: number;
  importance: number;
  source_session_id: string | null;
  revision: number;
  created_at: number;
  updated_at: number;
}

export interface PublicMemoryItem {
  readonly id: string;
  readonly category: MemoryCategory;
  readonly title: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly pinned: boolean;
  readonly importance: number;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly scope?: MemoryScope;
  readonly sourceSessionId?: string;
}

export interface MemoryCounts {
  readonly total: number;
  readonly pinned: number;
  readonly archived: number;
  readonly byCategory: Readonly<Record<MemoryCategory, number>>;
}

export interface MemoryBindings {
  readonly workspaceId: string;
  readonly workspacePath?: string;
  /** 可选的跨工作区全局个人记忆库路径（如 ~/.dsh/superagent-global.sqlite）。 */
  readonly globalDbPath?: string;
  /** 可选的全局个人记忆 Markdown 镜像路径（如 ~/.dsh/MEMORY.md）。 */
  readonly globalMirrorPath?: string;
  /** 开启后，profile 与 preference 分类默认路由至全局个人记忆层。 */
  readonly autoRouteGlobalCategories?: boolean;
  assertCurrent(): void;
  readUserMemoryMarkdown?(): { readonly name: string; readonly content: string } | undefined;
  now?(): number;
}

export interface MemoryUpsertInput {
  readonly id?: string;
  readonly category: MemoryCategory;
  readonly title: string;
  readonly content: string;
  readonly tags?: readonly string[];
  readonly pinned?: boolean;
  readonly importance?: number;
  readonly scope?: MemoryScope;
  readonly sourceSessionId?: string;
}

export interface MemorySearchFilter {
  readonly category?: MemoryCategory;
  readonly pinned?: boolean;
  readonly tag?: string;
  readonly query?: string;
  readonly scope?: MemoryScope | 'all';
}

const CATEGORY_LABELS: Readonly<Record<MemoryCategory, string>> = {
  preference: '偏好与习惯',
  profile: '用户画像',
  project: '项目背景',
  decision: '关键决策',
  fact: '事实备忘',
};

/**
 * 将中英文混合文本展开为适用于 SQLite FTS5 unicode61 分词器的索引文本：
 * 保留原文用于拉丁字母/数字词元，并将连续汉字拆分为单字与双字 Bigram。
 */
export function buildFtsTokens(text: string): string {
  const clean = text.replaceAll('\0', ' ').replaceAll('\uFDD0', ' ').replaceAll('\uFDD1', ' ').toLowerCase();
  const tokens: string[] = [clean];
  for (const match of clean.matchAll(/[\p{Unified_Ideograph}]+/gu)) {
    const chars = Array.from(match[0]);
    for (let i = 0; i < chars.length; i++) {
      tokens.push(chars[i]!);
      if (i + 1 < chars.length) {
        tokens.push(chars[i]! + chars[i + 1]!);
      }
    }
  }
  return tokens.join(' ');
}

/**
 * 将用户/模型查询词编译为安全的 SQLite FTS5 MATCH 表达式。
 */
export function buildFtsMatchQuery(rawQuery: string): string | undefined {
  const clean = rawQuery.replaceAll('\0', ' ').trim().toLowerCase();
  if (!clean) return undefined;

  const clauses: string[] = [];
  for (const word of clean.split(/\s+/u).filter(Boolean)) {
    const wordTokens: string[] = [];
    for (const cjk of word.matchAll(/[\p{Unified_Ideograph}]+/gu)) {
      const chars = Array.from(cjk[0]);
      if (chars.length === 1) {
        wordTokens.push(`"${chars[0]!}"`);
      } else {
        for (let i = 0; i + 1 < chars.length; i++) {
          wordTokens.push(`"${chars[i]! + chars[i + 1]!}"`);
        }
      }
    }
    for (const latin of word.matchAll(/[a-z0-9_]+/gu)) {
      const escaped = latin[0].replaceAll('"', '""');
      wordTokens.push(`"${escaped}"*`);
    }
    if (wordTokens.length === 1) {
      clauses.push(wordTokens[0]!);
    } else if (wordTokens.length > 1) {
      clauses.push(`(${wordTokens.join(' AND ')})`);
    }
  }
  if (!clauses.length) return undefined;
  return clauses.join(' AND ');
}

function asPublicMemory(row: MemoryRow): PublicMemoryItem {
  let parsedTags: string[] = [];
  try {
    const raw = JSON.parse(row.tags_json);
    if (Array.isArray(raw)) {
      parsedTags = raw.filter((item): item is string => typeof item === 'string');
    }
  } catch {
    parsedTags = [];
  }
  const scope: MemoryScope = row.workspace_id === GLOBAL_MEMORY_WORKSPACE_ID ? 'global' : 'workspace';
  return Object.freeze({
    id: row.id,
    category: row.category,
    title: row.title,
    content: row.content,
    tags: Object.freeze(parsedTags),
    pinned: row.pinned === 1,
    importance: row.importance,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    scope,
    ...(row.source_session_id ? { sourceSessionId: row.source_session_id } : {}),
  });
}

const MEMORY_SCHEMA_SQL = `
  PRAGMA journal_mode=WAL;
  PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS memory_item (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    category TEXT NOT NULL CHECK(category IN ('preference','profile','project','decision','fact')),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    tags_json TEXT NOT NULL CHECK(json_valid(tags_json)),
    pinned INTEGER NOT NULL CHECK(pinned IN (0,1)),
    importance INTEGER NOT NULL CHECK(importance BETWEEN 1 AND 5),
    source_session_id TEXT,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_memory_workspace_sort
    ON memory_item(workspace_id, pinned DESC, importance DESC, updated_at DESC, id ASC);
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    id UNINDEXED,
    workspace_id UNINDEXED,
    title_tokens,
    content_tokens,
    tag_tokens,
    tokenize = 'unicode61'
  );
`;

export class MemoryService {
  readonly #db: DatabaseSync;
  readonly #globalDb: DatabaseSync | null;

  constructor(path: string, private readonly binding: MemoryBindings) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(MEMORY_SCHEMA_SQL);
    if (binding.globalDbPath && binding.globalDbPath !== path) {
      mkdirSync(dirname(binding.globalDbPath), { recursive: true });
      this.#globalDb = new DatabaseSync(binding.globalDbPath);
      this.#globalDb.exec(MEMORY_SCHEMA_SQL);
      this.#globalDb.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES('workspace',?)").run(GLOBAL_MEMORY_WORKSPACE_ID);
    } else {
      this.#globalDb = null;
    }
    const owner = this.#db.prepare("SELECT value FROM metadata WHERE key='workspace'").get() as { value?: string } | undefined;
    if (typeof owner?.value === 'string' && owner.value !== binding.workspaceId) {
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        this.#db.prepare('UPDATE memory_item SET workspace_id = ? WHERE workspace_id = ?').run(binding.workspaceId, owner.value);
        this.#db.prepare('UPDATE memory_fts SET workspace_id = ? WHERE workspace_id = ?').run(binding.workspaceId, owner.value);
        this.#db.prepare("UPDATE metadata SET value = ? WHERE key = 'workspace'").run(binding.workspaceId);
        this.#db.exec('COMMIT');
      } catch (error) {
        this.#db.exec('ROLLBACK');
        this.#db.close();
        this.#globalDb?.close();
        throw error;
      }
    } else {
      this.#db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES('workspace',?)").run(binding.workspaceId);
    }
  }

  close(): void {
    this.#db.close();
    this.#globalDb?.close();
  }

  #now(): number {
    return typeof this.binding.now === 'function' ? this.binding.now() : Date.now();
  }

  #targetDb(scope: MemoryScope): { db: DatabaseSync; ownerId: string } {
    if (scope === 'global') {
      return {
        db: this.#globalDb ?? this.#db,
        ownerId: GLOBAL_MEMORY_WORKSPACE_ID,
      };
    }
    return {
      db: this.#db,
      ownerId: this.binding.workspaceId,
    };
  }

  #resolveUpsertScope(input: MemoryUpsertInput): MemoryScope {
    if (input.scope === 'global' || input.scope === 'workspace') {
      return input.scope;
    }
    if (this.binding.autoRouteGlobalCategories && (input.category === 'profile' || input.category === 'preference')) {
      return 'global';
    }
    return 'workspace';
  }

  #loadScopeRows(scope: MemoryScope): MemoryRow[] {
    const { db, ownerId } = this.#targetDb(scope);
    return db
      .prepare(
        `SELECT * FROM memory_item
         WHERE workspace_id = ?
         ORDER BY pinned DESC, importance DESC, updated_at DESC, id ASC`,
      )
      .all(ownerId) as unknown as MemoryRow[];
  }

  #loadAllRows(scopeFilter: MemoryScope | 'all' = 'all'): MemoryRow[] {
    if (scopeFilter === 'workspace') {
      return this.#loadScopeRows('workspace');
    }
    if (scopeFilter === 'global') {
      return this.#loadScopeRows('global');
    }
    const wsRows = this.#loadScopeRows('workspace');
    const globalRows = this.#loadScopeRows('global');
    if (globalRows.length === 0) return wsRows;
    const seen = new Set<string>();
    const combined: MemoryRow[] = [];
    for (const row of [...wsRows, ...globalRows]) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      combined.push(row);
    }
    combined.sort((a, b) => {
      if (a.pinned !== b.pinned) return b.pinned - a.pinned;
      if (a.importance !== b.importance) return b.importance - a.importance;
      if (a.updated_at !== b.updated_at) return b.updated_at - a.updated_at;
      return a.id.localeCompare(b.id);
    });
    return combined;
  }

  listMemories(scopeFilter: MemoryScope | 'all' = 'all'): readonly PublicMemoryItem[] {
    this.binding.assertCurrent();
    return Object.freeze(this.#loadAllRows(scopeFilter).map(asPublicMemory));
  }

  getConsolidatedSessionTurnCount(sessionId: string): number {
    const row = this.#db
      .prepare('SELECT value FROM metadata WHERE key = ?')
      .get(`consolidated:${sessionId}`) as { value?: string } | undefined;
    const parsed = Number(row?.value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  markConsolidatedSession(sessionId: string, turnCount: number): void {
    this.#db
      .prepare('INSERT OR REPLACE INTO metadata(key, value) VALUES(?, ?)')
      .run(`consolidated:${sessionId}`, String(Math.max(0, Math.trunc(turnCount))));
  }

  counts(items?: readonly PublicMemoryItem[]): MemoryCounts {
    const source = items ?? this.listMemories();
    const byCategory: Record<MemoryCategory, number> = {
      preference: 0,
      profile: 0,
      project: 0,
      decision: 0,
      fact: 0,
    };
    let pinned = 0;
    for (const item of source) {
      if (item.pinned) pinned++;
      if (Object.hasOwn(byCategory, item.category)) {
        byCategory[item.category]++;
      }
    }
    return Object.freeze({
      total: source.length,
      pinned,
      archived: source.length - pinned,
      byCategory: Object.freeze(byCategory),
    });
  }

  revision(items?: readonly PublicMemoryItem[]): string {
    const source = items ?? this.listMemories();
    const userMem = this.binding.readUserMemoryMarkdown?.();
    return createHash('sha256')
      .update(
        JSON.stringify([
          this.binding.workspaceId,
          userMem?.content ?? null,
          source.map(item => [
            item.id,
            item.revision,
            item.category,
            item.title,
            item.content,
            item.tags,
            item.pinned,
            item.importance,
            item.updatedAt,
          ]),
        ]),
      )
      .digest('hex')
      .slice(0, 24);
  }

  /**
   * 使用 SQLite FTS5 BM25 索引 + 结构化筛选器搜索记忆（支持跨工作区全局记忆与工作区记忆联合检索）。
   */
  searchMemories(filter: MemorySearchFilter = {}): {
    readonly items: readonly PublicMemoryItem[];
    readonly counts: MemoryCounts;
    readonly revision: string;
  } {
    this.binding.assertCurrent();
    const scopeFilter = filter.scope ?? 'all';
    const allItems = this.#loadAllRows('all').map(asPublicMemory);
    const counts = this.counts(allItems);
    const revision = this.revision(allItems);

    const normalizedTag = filter.tag?.trim().toLowerCase();
    const rawQuery = filter.query?.trim() ?? '';
    const queryTerms = rawQuery ? rawQuery.toLowerCase().split(/\s+/u).filter(Boolean) : [];

    // 若包含查询关键词，先通过 FTS5 虚拟表计算 BM25 相关性得分
    const ftsRanks = new Map<string, number>();
    if (rawQuery) {
      const ftsExpr = buildFtsMatchQuery(rawQuery);
      if (ftsExpr) {
        const scopesToQuery: MemoryScope[] =
          scopeFilter === 'workspace'
            ? ['workspace']
            : scopeFilter === 'global'
              ? ['global']
              : ['workspace', 'global'];
        for (const sc of scopesToQuery) {
          const { db, ownerId } = this.#targetDb(sc);
          try {
            const hits = db
              .prepare(
                `SELECT id, bm25(memory_fts, 0.0, 0.0, 5.0, 1.5, 3.0) AS score
                 FROM memory_fts
                 WHERE workspace_id = ? AND memory_fts MATCH ?
                 ORDER BY score ASC
                 LIMIT 200`,
              )
              .all(ownerId, ftsExpr) as unknown as { id: string; score: number }[];
            for (const hit of hits) {
              const prev = ftsRanks.get(hit.id);
              if (prev === undefined || hit.score < prev) {
                ftsRanks.set(hit.id, hit.score);
              }
            }
          } catch {
            // FTS 语法边缘情况降级为子串匹配
          }
        }
      }
    }

    const matched: { item: PublicMemoryItem; exactHit: boolean; ftsScore: number }[] = [];
    for (const item of allItems) {
      if (scopeFilter !== 'all' && item.scope !== scopeFilter) continue;
      if (filter.category !== undefined && item.category !== filter.category) continue;
      if (filter.pinned !== undefined && item.pinned !== filter.pinned) continue;
      if (normalizedTag && !item.tags.some(t => t.toLowerCase() === normalizedTag)) continue;

      if (queryTerms.length > 0) {
        const hay = `${item.title}\n${item.content}\n${item.tags.join(' ')}\n${item.category}`.toLowerCase();
        const exactHit = queryTerms.every(term => hay.includes(term));
        const ftsScore = ftsRanks.get(item.id);
        if (!exactHit && ftsScore === undefined) continue;
        matched.push({ item, exactHit, ftsScore: ftsScore ?? 0 });
      } else {
        matched.push({ item, exactHit: true, ftsScore: 0 });
      }
    }

    if (queryTerms.length > 0) {
      matched.sort((a, b) => {
        if (a.exactHit !== b.exactHit) return a.exactHit ? -1 : 1;
        if (a.ftsScore !== b.ftsScore) return a.ftsScore - b.ftsScore; // SQLite bm25() 越小越相关
        if (a.item.pinned !== b.item.pinned) return a.item.pinned ? -1 : 1;
        if (a.item.importance !== b.item.importance) return b.item.importance - a.item.importance;
        return b.item.updatedAt - a.item.updatedAt;
      });
    }

    return {
      items: Object.freeze(matched.map(entry => entry.item)),
      counts,
      revision,
    };
  }

  /**
   * 新建或更新一条长期记忆，并在事务内同步更新 FTS5 索引与 `.dsh/MEMORY.md` 镜像文件。
   */
  saveMemory(sessionId: string | null, input: MemoryUpsertInput): {
    readonly action: 'created' | 'updated';
    readonly item: PublicMemoryItem;
  } {
    this.binding.assertCurrent();
    if (!MEMORY_CATEGORIES.includes(input.category)) {
      throw Error('MEMORY_CATEGORY_INVALID');
    }
    const title = input.title.trim();
    const content = input.content.trim();
    if (!title || title.length > 120 || !content || content.length > 2000) {
      throw Error('MEMORY_CONTENT_INVALID');
    }
    const tags = [...new Set((input.tags ?? []).map(t => t.trim()).filter(Boolean))].slice(0, 10);
    if (tags.some(t => t.length > 40)) {
      throw Error('MEMORY_TAGS_INVALID');
    }
    const importance = input.importance ?? (input.pinned ? 4 : 3);
    if (!Number.isSafeInteger(importance) || importance < 1 || importance > 5) {
      throw Error('MEMORY_IMPORTANCE_INVALID');
    }
    const pinnedInt = input.pinned === true ? 1 : 0;
    const now = this.#now();
    const sourceSessionId = input.sourceSessionId ?? sessionId;

    let targetScope = this.#resolveUpsertScope(input);
    let { db, ownerId } = this.#targetDb(targetScope);
    let existing: MemoryRow | undefined;

    if (input.id !== undefined) {
      existing = db
        .prepare('SELECT * FROM memory_item WHERE id = ? AND workspace_id = ?')
        .get(input.id, ownerId) as unknown as MemoryRow | undefined;
      if (!existing) {
        const altScope: MemoryScope = targetScope === 'workspace' ? 'global' : 'workspace';
        const alt = this.#targetDb(altScope);
        existing = alt.db
          .prepare('SELECT * FROM memory_item WHERE id = ? AND workspace_id = ?')
          .get(input.id, alt.ownerId) as unknown as MemoryRow | undefined;
        if (existing) {
          targetScope = altScope;
          db = alt.db;
          ownerId = alt.ownerId;
        }
      }
      if (!existing) throw Error('MEMORY_NOT_FOUND');
    } else {
      existing = db
        .prepare('SELECT * FROM memory_item WHERE workspace_id = ? AND category = ? AND lower(title) = lower(?)')
        .get(ownerId, input.category, title) as unknown as MemoryRow | undefined;
    }

    const id = existing?.id ?? randomUUID();
    const revision = (existing?.revision ?? 0) + 1;
    const createdAt = existing?.created_at ?? now;
    const tagsJson = JSON.stringify(tags);
    const titleTokens = buildFtsTokens(title);
    const contentTokens = buildFtsTokens(content);
    const tagTokens = buildFtsTokens(tags.join(' '));

    db.exec('BEGIN IMMEDIATE');
    try {
      if (!existing) {
        const countRow = db
          .prepare('SELECT COUNT(*) AS total FROM memory_item WHERE workspace_id = ?')
          .get(ownerId) as { total: number };
        if (countRow.total >= MAX_MEMORIES_PER_WORKSPACE) {
          throw Error('MEMORY_CAPACITY_EXCEEDED');
        }
        db
          .prepare(
            `INSERT INTO memory_item
              (id, workspace_id, category, title, content, tags_json, pinned, importance, source_session_id, revision, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, ownerId, input.category, title, content, tagsJson, pinnedInt, importance, sourceSessionId, revision, createdAt, now);
      } else {
        db
          .prepare(
            `UPDATE memory_item
             SET category = ?, title = ?, content = ?, tags_json = ?, pinned = ?, importance = ?, source_session_id = ?, revision = ?, updated_at = ?
             WHERE id = ? AND workspace_id = ?`,
          )
          .run(input.category, title, content, tagsJson, pinnedInt, importance, sourceSessionId, revision, now, id, ownerId);
        db.prepare('DELETE FROM memory_fts WHERE id = ? AND workspace_id = ?').run(id, ownerId);
      }
      db
        .prepare(
          `INSERT INTO memory_fts (id, workspace_id, title_tokens, content_tokens, tag_tokens)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, ownerId, titleTokens, contentTokens, tagTokens);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* ignore rollback error */ }
      throw error;
    }

    const savedRow = db
      .prepare('SELECT * FROM memory_item WHERE id = ? AND workspace_id = ?')
      .get(id, ownerId) as unknown as MemoryRow;
    const item = asPublicMemory(savedRow);
    this.#syncMarkdownMirror();
    if (targetScope === 'global') {
      this.#syncGlobalMarkdownMirror();
    }
    return { action: existing ? 'updated' : 'created', item };
  }

  /**
   * 删除指定 ID 的长期记忆，并同步更新 FTS5 与 `.dsh/MEMORY.md` 镜像。
   */
  deleteMemory(id: string): { readonly deleted: boolean; readonly id: string } {
    this.binding.assertCurrent();
    for (const scope of ['workspace', 'global'] as const) {
      const { db, ownerId } = this.#targetDb(scope);
      const existing = db
        .prepare('SELECT id FROM memory_item WHERE id = ? AND workspace_id = ?')
        .get(id, ownerId) as { id?: string } | undefined;
      if (!existing) continue;
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM memory_fts WHERE id = ? AND workspace_id = ?').run(id, ownerId);
        db.prepare('DELETE FROM memory_item WHERE id = ? AND workspace_id = ?').run(id, ownerId);
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* ignore */ }
        throw error;
      }
      this.#syncMarkdownMirror();
      if (scope === 'global') {
        this.#syncGlobalMarkdownMirror();
      }
      return { deleted: true, id };
    }
    return { deleted: false, id };
  }

  /**
   * 清空当前工作区的所有长期记忆条目（用于大肥鱼重置冷启动）。
   */
  clearAll(): void {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare('DELETE FROM memory_fts WHERE workspace_id = ?').run(this.binding.workspaceId);
      this.#db.prepare('DELETE FROM memory_item WHERE workspace_id = ?').run(this.binding.workspaceId);
      this.#db.exec('COMMIT');
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw error;
    }
    this.#syncMarkdownMirror();
  }

  /**
   * 渲染注入到系统提示词中的常驻核心记忆（合并用户手写的 `MEMORY.md` 与 SQLite 中 `pinned = true` 的记忆条目）。
   */
  renderCoreMemorySection(): string {
    try {
      this.binding.assertCurrent();
      const userMem = this.binding.readUserMemoryMarkdown?.();
      const pinnedItems = this.#loadAllRows('all')
        .filter(row => row.pinned === 1)
        .slice(0, MAX_CORE_MEMORY_ITEMS)
        .map(asPublicMemory);

      if (!userMem && pinnedItems.length === 0) return '';

      const sections: string[] = [
        '以下是当前工作区的常驻长期记忆（Core Memory）。请在沟通、盘点与建议时主动结合这些背景与偏好；但涉及任务看板状态、个人待办完成度与用户会话进展时，必须以当前实时只读工具返回的数据为准：',
      ];

      if (userMem) {
        sections.push(`[工作区 ${userMem.name}]\n${truncateUtf8Safe(userMem.content, 2048)}`);
      }

      if (pinnedItems.length > 0) {
        const lines: string[] = ['[大肥鱼常驻核心记忆条目]'];
        let usedBytes = 0;
        for (const item of pinnedItems) {
          const scopePrefix = item.scope === 'global' ? '全局 | ' : '';
          const tagSuffix = item.tags.length > 0 ? ` [标签: ${item.tags.join(', ')}]` : '';
          const line = `- [${scopePrefix}${CATEGORY_LABELS[item.category]} | id:${item.id}] ${item.title}：${item.content}${tagSuffix}`;
          const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
          if (usedBytes + lineBytes > MAX_CORE_MEMORY_BYTES) break;
          lines.push(line);
          usedBytes += lineBytes;
        }
        if (lines.length > 1) {
          sections.push(lines.join('\n'));
        }
      }

      return sections.join('\n\n');
    } catch {
      return '';
    }
  }

  /**
   * 将当前工作区的记忆同步导出到 `<workspacePath>/.dsh/MEMORY.md`，方便用户在编辑器中直观查阅。
   */
  #syncMarkdownMirror(): void {
    const wsPath = this.binding.workspacePath;
    if (!wsPath) return;
    const mirrorPath = join(wsPath, '.dsh', 'MEMORY.md');
    const items = this.#loadAllRows('all').map(asPublicMemory);
    this.#writeMirrorFile(mirrorPath, items);
  }

  #syncGlobalMarkdownMirror(): void {
    const mirrorPath = this.binding.globalMirrorPath;
    if (!mirrorPath) return;
    const items = this.#loadAllRows('global').map(asPublicMemory);
    this.#writeMirrorFile(mirrorPath, items);
  }

  #writeMirrorFile(mirrorPath: string, items: readonly PublicMemoryItem[]): void {
    try {
      const pinned = items.filter(item => item.pinned);
      const archived = items.filter(item => !item.pinned).slice(0, 30);

      const lines: string[] = [
        AUTO_MEMORY_MIRROR_HEADER,
        '# 大肥鱼长期记忆镜像 (.dsh/MEMORY.md)',
        '',
        '> 本文件由大肥鱼长期记忆库（SQLite FTS5）自动同步生成。如需手写自定义常驻记忆，可在工作区根目录直接创建 `MEMORY.md`。',
        '',
        '## 一、 常驻核心记忆 (Core Memory / Pinned)',
        '',
      ];
      if (pinned.length === 0) {
        lines.push('_暂无常驻核心记忆_', '');
      } else {
        for (const item of pinned) {
          const tags = item.tags.length ? ` \`tags: ${item.tags.join(', ')}\`` : '';
          lines.push(`- **[${CATEGORY_LABELS[item.category]}] ${item.title}** (\`id: ${item.id}\`, 重要度: ${item.importance})${tags}`);
          lines.push(`  ${item.content}`);
        }
        lines.push('');
      }

      lines.push('## 二、 近期归档记忆 (Archival Memory)');
      lines.push('');
      if (archived.length === 0) {
        lines.push('_暂无归档记忆_', '');
      } else {
        for (const item of archived) {
          const tags = item.tags.length ? ` \`tags: ${item.tags.join(', ')}\`` : '';
          lines.push(`- **[${CATEGORY_LABELS[item.category]}] ${item.title}** (\`id: ${item.id}\`)${tags}`);
          lines.push(`  ${item.content}`);
        }
        lines.push('');
      }

      mkdirSync(dirname(mirrorPath), { recursive: true });
      writeFileSync(mirrorPath, lines.join('\n'), 'utf8');
    } catch {
      // 镜像导出属于辅助可观测能力，工作区只读或权限受限时不影响主库事务
    }
  }
}
