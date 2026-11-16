import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  parseAndValidateSchema,
  type GenuiNode,
  type MaterialMeta,
  type MaterialsMetaMap,
} from './core.js';
import { P1_MATERIALS_META, buildGenuiPrompt } from './materials-meta.js';

export interface GenuiView {
  readonly id: string;
  readonly turn: number;
  readonly revision: number;
  readonly title?: string;
  readonly schema: GenuiNode;
  readonly nodeCount: number;
  readonly status: 'active' | 'dismissed';
  readonly createdAt: number;
}

export interface SuperagentGenuiHostPlugin {
  getMaterialsMeta?(): MaterialsMetaMap | readonly MaterialMeta[];
  registerMaterialMeta?(meta: MaterialMeta): () => void;
}

export type GenuiRequest =
  | { op: 'list'; turn: number }
  | { op: 'dismiss'; id: string };

type Row = {
  id: string;
  session: string;
  turn: number;
  revision: number;
  state: 'active' | 'dismissed';
  title: string | null;
  body: string;
  node_count: number;
  created_at: number;
};

interface GenuiBindings {
  check?(): void;
  plugin?(): SuperagentGenuiHostPlugin | undefined;
  now?(): number;
}

export const genuiToolSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schema'],
  properties: {
    title: { type: 'string', maxLength: 120 },
    replaceTurn: { type: 'boolean' },
    schema: {
      type: 'object',
      additionalProperties: true,
    },
  },
};

export class GenuiService {
  readonly #db: DatabaseSync;
  readonly #customMeta = new Map<string, MaterialMeta>();

  constructor(path: string, private readonly binding: GenuiBindings) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`CREATE TABLE IF NOT EXISTS genui_view (
      id TEXT PRIMARY KEY,
      session TEXT NOT NULL,
      turn INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      state TEXT NOT NULL,
      title TEXT,
      body TEXT NOT NULL,
      node_count INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`);
    this.#db.exec('CREATE INDEX IF NOT EXISTS idx_genui_session_turn ON genui_view(session, turn)');
  }

  close(): void {
    this.#db.close();
  }

  clearAll(): void {
    this.#db.exec('DELETE FROM genui_view');
  }

  registerMaterialMeta(meta: MaterialMeta): () => void {
    if (!meta?.componentName || typeof meta.componentName !== 'string') {
      throw new Error('INVALID_GENUI_MATERIAL_META');
    }
    this.#customMeta.set(meta.componentName, meta);
    return () => {
      if (this.#customMeta.get(meta.componentName) === meta) {
        this.#customMeta.delete(meta.componentName);
      }
    };
  }

  #normalizePluginMeta(): MaterialsMetaMap {
    const raw = this.binding.plugin?.()?.getMaterialsMeta?.();
    if (!raw) return {};
    if (Array.isArray(raw)) {
      const out: Record<string, MaterialMeta> = {};
      for (const item of raw) {
        if (item && typeof item.componentName === 'string') {
          out[item.componentName] = item;
        }
      }
      return out;
    }
    return raw as MaterialsMetaMap;
  }

  materialsMeta(): MaterialsMetaMap {
    const pluginMeta = this.#normalizePluginMeta();
    const localMeta = Object.fromEntries(this.#customMeta.entries());
    return {
      ...P1_MATERIALS_META,
      ...pluginMeta,
      ...localMeta,
    };
  }

  promptText(): string {
    const pluginMeta = this.#normalizePluginMeta();
    const localMeta = Object.fromEntries(this.#customMeta.entries());
    return buildGenuiPrompt({ ...pluginMeta, ...localMeta });
  }

  #now(): number {
    return this.binding.now?.() ?? Date.now();
  }

  #toView(row: Row): GenuiView {
    const parsed = JSON.parse(row.body) as GenuiNode;
    return {
      id: row.id,
      turn: row.turn,
      revision: row.revision,
      ...(row.title ? { title: row.title } : {}),
      schema: parsed,
      nodeCount: row.node_count,
      status: row.state,
      createdAt: row.created_at,
    };
  }

  #listAt(session: string, turn: number): Row[] {
    return this.#db
      .prepare("SELECT * FROM genui_view WHERE session=? AND turn=? AND state='active' ORDER BY rowid ASC")
      .all(session, turn) as unknown as Row[];
  }

  #owned(session: string, id: string): Row {
    const row = this.#db
      .prepare('SELECT * FROM genui_view WHERE session=? AND id=?')
      .get(session, id) as unknown as Row | undefined;
    if (!row) throw new Error('GENUI_VIEW_NOT_FOUND');
    return row;
  }

  render(session: string, turn: number, rawInput: unknown): GenuiView {
    this.binding.check?.();
    if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
      throw new Error('INVALID_GENUI_SCHEMA');
    }
    const record = rawInput as Record<string, unknown>;
    if (Object.keys(record).some(k => !['title', 'schema', 'replaceTurn'].includes(k))) {
      throw new Error('INVALID_GENUI_SCHEMA');
    }
    const rawTitle = record.title;
    if (rawTitle !== undefined && (typeof rawTitle !== 'string' || rawTitle.length > 120)) {
      throw new Error('INVALID_GENUI_SCHEMA');
    }
    const title = typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.trim() : undefined;
    const replaceTurn = record.replaceTurn === true;

    const { schema, nodeCount } = parseAndValidateSchema(record.schema, this.materialsMeta());
    const body = JSON.stringify(schema);
    const existingList = this.#listAt(session, turn);

    const exactSame = existingList.find(row => row.body === body && (row.title ?? undefined) === title);
    if (exactSame) return this.#toView(exactSame);

    if (replaceTurn && existingList.length > 0) {
      const target = existingList[existingList.length - 1]!;
      this.#db
        .prepare("UPDATE genui_view SET revision=revision+1, title=?, body=?, node_count=? WHERE id=? AND session=?")
        .run(title ?? null, body, nodeCount, target.id, session);
      return this.#toView(this.#owned(session, target.id));
    }

    if (existingList.length >= 6) {
      const oldest = existingList[0]!;
      this.#db.prepare("UPDATE genui_view SET state='dismissed', revision=revision+1 WHERE id=?").run(oldest.id);
    }

    const id = randomUUID();
    this.#db
      .prepare("INSERT INTO genui_view VALUES (?, ?, ?, 1, 'active', ?, ?, ?, ?)")
      .run(id, session, turn, title ?? null, body, nodeCount, this.#now());
    return this.#toView(this.#owned(session, id));
  }

  handle(session: string, input: { op: 'list'; turn: number }, assertCurrent: () => void): Promise<GenuiView[]>;
  handle(session: string, input: { op: 'dismiss'; id: string }, assertCurrent: () => void): Promise<GenuiView | null>;
  handle(session: string, input: unknown, assertCurrent: () => void): Promise<GenuiView[] | GenuiView | null>;
  async handle(session: string, input: unknown, assertCurrent: () => void): Promise<GenuiView[] | GenuiView | null> {
    assertCurrent();
    this.binding.check?.();
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('INVALID_GENUI_REQUEST');
    }
    const req = input as Record<string, unknown>;
    if (
      req.op === 'list' &&
      Object.keys(req).sort().join(',') === 'op,turn' &&
      typeof req.turn === 'number' &&
      Number.isSafeInteger(req.turn) &&
      req.turn >= 0
    ) {
      return this.#listAt(session, req.turn).map(row => this.#toView(row));
    }
    if (
      req.op === 'dismiss' &&
      Object.keys(req).sort().join(',') === 'id,op' &&
      typeof req.id === 'string' &&
      /^[0-9a-f-]{36}$/i.test(req.id)
    ) {
      const row = this.#owned(session, req.id);
      if (row.state === 'active') {
        this.#db
          .prepare("UPDATE genui_view SET state='dismissed', revision=revision+1 WHERE id=? AND session=?")
          .run(row.id, session);
      }
      return this.#toView(this.#owned(session, row.id));
    }
    throw new Error('INVALID_GENUI_REQUEST');
  }
}
