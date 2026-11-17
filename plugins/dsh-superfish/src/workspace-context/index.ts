import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';

export const name = 'workspace-context';

export interface ContextScope {
  readonly workspaceId: string;
  readonly projectIds: readonly (string | null)[];
  readonly allBoardProjects?: true;
  readonly allSessions?: true;
}

export interface ContextAccess {
  readonly scope: ContextScope;
  readonly grants: Readonly<Record<string, string>>;
  readonly binding: string;
  readonly signal: AbortSignal;
  assertCurrent(): void;
}

export interface ContextFilterDefinition {
  readonly type: 'string' | 'boolean' | 'integer';
  readonly description: string;
  readonly enum?: readonly string[];
}

export interface ContextCapabilityInfo {
  readonly protocol: 1;
  readonly id: string;
  readonly source: string;
  readonly provider: string;
  readonly description: string;
  readonly scope: 'workspace' | 'project';
  readonly readScope?: 'all-board-projects' | 'all-projects' | 'workspace' | 'all-sessions';
  readonly filters: Readonly<Record<string, ContextFilterDefinition>>;
}

export interface ContextReadInput {
  readonly scope: ContextScope;
  readonly filter: Readonly<Record<string, string | boolean | number>>;
  readonly offset: number;
  readonly limit: number;
  readonly signal: AbortSignal;
}

export interface ContextReadResult {
  readonly items: readonly Readonly<Record<string, unknown>>[];
  readonly more: boolean;
  readonly revision: string;
}

export interface ContextCapabilitySpec extends Omit<ContextCapabilityInfo, 'provider'> {
  readonly provider?: string;
  read(input: ContextReadInput): Promise<ContextReadResult> | ContextReadResult;
}

export interface WorkspaceContextService {
  register(owner: unknown, spec: ContextCapabilitySpec): () => void;
  listRegistered(): readonly (ContextCapabilityInfo & { readonly status: 'available' })[];
  catalog(access: ContextAccess): unknown;
  status(grants: Readonly<Record<string, string>>): readonly { id: string; available: boolean }[];
  query(access: ContextAccess, input: unknown): Promise<unknown>;
}

const capabilityId = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const unavailable = (id: string) => ({ status: 'unavailable', capability: id });

const PROVIDER_EQUIVALENTS: Readonly<Record<string, readonly string[]>> = {
  '@local/dsh-superfish/workspace-context/task-board': [
    '@local/dsh-superfish/workspace-context/task-board',
    '@local/dsh-workspace-context/task-board',
  ],
  '@local/dsh-workspace-context/task-board': [
    '@local/dsh-superfish/workspace-context/task-board',
    '@local/dsh-workspace-context/task-board',
  ],
  '@local/dsh-superfish/workspace-context/schedule': [
    '@local/dsh-superfish/workspace-context/schedule',
    '@local/dsh-workspace-context/schedule',
  ],
  '@local/dsh-workspace-context/schedule': [
    '@local/dsh-superfish/workspace-context/schedule',
    '@local/dsh-workspace-context/schedule',
  ],
  '@local/dsh-superfish/workspace-context/session': [
    '@local/dsh-superfish/workspace-context/session',
    '@local/dsh-workspace-context/session',
  ],
  '@local/dsh-workspace-context/session': [
    '@local/dsh-superfish/workspace-context/session',
    '@local/dsh-workspace-context/session',
  ],
};

function providerCandidates(provider: string): readonly string[] {
  return PROVIDER_EQUIVALENTS[provider] ?? [provider];
}

const isBoardAdapterProvider = (provider: string): boolean =>
  providerCandidates(provider).includes('@local/dsh-superfish/workspace-context/task-board');

const isSessionAdapterProvider = (provider: string): boolean =>
  providerCandidates(provider).includes('@local/dsh-superfish/workspace-context/session');

const hasBoardScope = (scope: ContextScope, info: ContextCapabilityInfo): boolean =>
  scope.allBoardProjects === true &&
  info.id === 'task-board.list' &&
  isBoardAdapterProvider(info.provider) &&
  info.scope === 'project';

const hasSessionScope = (info: ContextCapabilityInfo): boolean =>
  info.id === 'session.list' && isSessionAdapterProvider(info.provider) && info.scope === 'workspace';

function moduleName(ctx: unknown, fallbackProvider?: string): string {
  type FiberLike = { entry?: { options?: { name?: unknown } }; parent?: { fiber?: FiberLike } };
  for (
    let fiber = (ctx as { fiber?: FiberLike } | null | undefined)?.fiber;
    fiber;
    fiber = fiber.parent?.fiber
  ) {
    if (typeof fiber.entry?.options?.name === 'string') return fiber.entry.options.name;
    if (fiber.parent?.fiber === fiber) break;
  }
  if (typeof fallbackProvider === 'string' && fallbackProvider) return fallbackProvider;
  throw Error('CONTEXT_PLUGIN_IDENTITY_REQUIRED');
}

function parseFilter(
  value: unknown,
  fields: Readonly<Record<string, ContextFilterDefinition>>,
): Readonly<Record<string, string | boolean | number>> | undefined {
  if (!record(value)) return undefined;
  const result = Object.create(null) as Record<string, string | boolean | number>;
  for (const key of Object.keys(value).sort()) {
    const rule = Object.hasOwn(fields, key) ? fields[key] : undefined;
    const item = value[key];
    if (
      !rule ||
      (rule.type === 'integer' ? !Number.isSafeInteger(item) : typeof item !== rule.type) ||
      (typeof item === 'string' && item.length > 256) ||
      (rule.enum && !rule.enum.includes(item as string))
    ) {
      return undefined;
    }
    result[key] = item as string | boolean | number;
  }
  return Object.freeze(result);
}

interface InternalEntry {
  readonly info: ContextCapabilityInfo;
  readonly read: ContextCapabilitySpec['read'];
  readonly controller: AbortController;
}

interface InternalCursor {
  readonly entry: InternalEntry;
  readonly queryKey: string;
  readonly revision: string;
  readonly offset: number;
  readonly expiresAt: number;
}

async function readWithin(
  provider: InternalEntry,
  request: ContextReadInput,
  signal: AbortSignal,
): Promise<ContextReadResult> {
  let abort!: () => void;
  const stop = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return provider.read(request);
      }),
      stop,
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** Cordis Host 服务。注册的读取函数在宿主进程内执行。 */
export function apply(ctx: Context): void {
  const entries = new Map<string, InternalEntry>();
  const cursors = new Map<string, InternalCursor>();
  const lifetime = new AbortController();
  ctx.effect(() => () => {
    lifetime.abort();
    entries.clear();
    cursors.clear();
  });

  const find = (provider: string, id: string): InternalEntry | undefined => {
    for (const candidate of providerCandidates(provider)) {
      const found = entries.get(JSON.stringify([candidate, id]));
      if (found) return found;
    }
    return undefined;
  };

  const catalog = (grants: Readonly<Record<string, string>>) =>
    Object.entries(grants)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, provider]) => {
        const entry = find(provider, id);
        return entry
          ? { ...structuredClone(entry.info), status: 'available' as const }
          : { id, status: 'unavailable' as const };
      });

  const service: WorkspaceContextService = {
    register(owner, capability) {
      lifetime.signal.throwIfAborted();
      const module = moduleName(owner, capability?.provider);
      const { protocol, id, source, description, scope, filters } = capability;
      if (
        protocol !== 1 ||
        !capabilityId.test(id) ||
        !['workspace', 'project'].includes(scope) ||
        typeof source !== 'string' ||
        !source ||
        source.length > 160 ||
        typeof description !== 'string' ||
        !description ||
        description.length > 320 ||
        !record(filters) ||
        Object.keys(filters).length > 12 ||
        typeof capability.read !== 'function'
      ) {
        throw Error('CONTEXT_CAPABILITY_INVALID');
      }
      const cleanFilters = Object.fromEntries(
        Object.entries(filters).map(([key, field]) => {
          if (
            !/^[a-z][a-zA-Z0-9]*$/.test(key) ||
            !field ||
            !['string', 'boolean', 'integer'].includes(field.type) ||
            typeof field.description !== 'string' ||
            field.description.length > 240 ||
            (field.enum !== undefined &&
              (field.type !== 'string' ||
                !Array.isArray(field.enum) ||
                field.enum.length > 20 ||
                field.enum.some(item => typeof item !== 'string' || item.length > 80)))
          ) {
            throw Error('CONTEXT_FILTER_INVALID');
          }
          return [
            key,
            {
              type: field.type,
              description: field.description,
              ...(field.enum && { enum: [...field.enum] }),
            },
          ];
        }),
      );
      const key = JSON.stringify([module, id]);
      if (entries.has(key)) throw Error('CONTEXT_CAPABILITY_ALREADY_REGISTERED');
      const controller = new AbortController();
      const entry: InternalEntry = {
        info: {
          protocol,
          id,
          source,
          provider: module,
          description,
          scope,
          filters: cleanFilters,
        },
        read: capability.read,
        controller,
      };
      entries.set(key, entry);
      return () => {
        if (entries.get(key) !== entry) return;
        entries.delete(key);
        controller.abort();
        for (const [token, page] of cursors) {
          if (page.entry === entry) cursors.delete(token);
        }
      };
    },
    catalog(access) {
      access.assertCurrent();
      lifetime.signal.throwIfAborted();
      const capabilities = catalog(access.grants).map(info =>
        'provider' in info && hasBoardScope(access.scope, info)
          ? { ...info, readScope: 'all-board-projects' }
          : 'provider' in info && hasSessionScope(info)
            ? { ...info, readScope: 'all-sessions' }
            : info,
      );
      return { status: 'ok', protocol: 1, workspaceId: access.scope.workspaceId, capabilities };
    },
    status(grants) {
      return Object.entries(grants).map(([id, provider]) => ({
        id,
        available: !!find(provider, id),
      }));
    },
    listRegistered() {
      lifetime.signal.throwIfAborted();
      return [...entries.values()]
        .map(entry => ({ ...structuredClone(entry.info), status: 'available' as const }))
        .sort((a, b) => a.id.localeCompare(b.id) || a.provider.localeCompare(b.provider));
    },
    async query(access, input) {
      access.assertCurrent();
      lifetime.signal.throwIfAborted();
      if (
        !record(input) ||
        Object.keys(input).some(key => !['capability', 'filter', 'limit', 'cursor'].includes(key)) ||
        typeof input.capability !== 'string' ||
        !capabilityId.test(input.capability)
      ) {
        return { status: 'invalid_query' };
      }
      const id = input.capability;
      if (!Object.hasOwn(access.grants, id)) return { status: 'denied' };
      const entry = find(access.grants[id]!, id);
      if (!entry) return unavailable(id);
      const limit = (input.limit as number | undefined) ?? 10;
      const filter = parseFilter(input.filter === undefined ? {} : input.filter, entry.info.filters);
      if (
        !filter ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 20 ||
        (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 36))
      ) {
        return { status: 'invalid_query', capability: id };
      }
      const { workspaceId, projectIds } = access.scope;
      const allBoardProjects = hasBoardScope(access.scope, entry.info);
      const allSessions = hasSessionScope(entry.info);
      const scope: ContextScope = Object.freeze({
        workspaceId,
        projectIds,
        ...(allBoardProjects && { allBoardProjects: true as const }),
        ...(allSessions && { allSessions: true as const }),
      });
      const queryKey = JSON.stringify([access.binding, scope, filter, limit]);
      const page = input.cursor === undefined ? undefined : cursors.get(input.cursor as string);
      if (
        input.cursor !== undefined &&
        (!page || page.entry !== entry || page.queryKey !== queryKey || page.expiresAt <= Date.now())
      ) {
        return { status: 'cursor_stale', capability: id };
      }
      const timeout = AbortSignal.timeout(3000);
      const signal = AbortSignal.any([access.signal, entry.controller.signal, lifetime.signal, timeout]);
      const offset = page?.offset ?? 0;
      let result: ContextReadResult;
      try {
        result = await readWithin(entry, { scope, filter, offset, limit, signal }, signal);
      } catch {
        access.assertCurrent();
        return timeout.aborted && !entry.controller.signal.aborted && !lifetime.signal.aborted
          ? { status: 'timeout', capability: id }
          : unavailable(id);
      }
      access.assertCurrent();
      if (entry.controller.signal.aborted || lifetime.signal.aborted) return unavailable(id);
      if (timeout.aborted) return { status: 'timeout', capability: id };
      if (
        !Array.isArray(result?.items) ||
        result.items.length > limit ||
        typeof result.revision !== 'string' ||
        !result.revision ||
        result.revision.length > 160 ||
        typeof result.more !== 'boolean' ||
        (result.more && !result.items.length) ||
        result.items.some(
          item =>
            !record(item) ||
            (allBoardProjects
              ? !(item.workspaceId === null || typeof item.workspaceId === 'string') ||
                !(item.projectId === null || typeof item.projectId === 'string')
              : allSessions
                ? !(item.workspaceId === null || typeof item.workspaceId === 'string')
                : item.workspaceId !== workspaceId ||
                  (entry.info.scope === 'project' &&
                    !projectIds.includes(item.projectId as string | null))) ||
            !record(item.ref) ||
            typeof item.ref.kind !== 'string' ||
            typeof item.ref.id !== 'string' ||
            !item.ref.id,
        )
      ) {
        return unavailable(id);
      }
      let items: unknown;
      try {
        const json = JSON.stringify(result.items);
        if (Buffer.byteLength(json) > 16_000) return unavailable(id);
        items = JSON.parse(json);
      } catch {
        return unavailable(id);
      }
      if (page && page.revision !== result.revision) return { status: 'cursor_stale', capability: id };
      let nextCursor: string | undefined;
      if (result.more) {
        nextCursor = randomUUID();
        if (cursors.size >= 128) {
          const oldest = cursors.keys().next().value;
          if (oldest !== undefined) cursors.delete(oldest);
        }
        cursors.set(nextCursor, {
          entry,
          queryKey,
          revision: result.revision,
          offset: offset + (items as unknown[]).length,
          expiresAt: Date.now() + 300_000,
        });
      }
      return {
        status: 'ok',
        capability: id,
        source: entry.info.source,
        ...(allBoardProjects
          ? { readScope: 'all-board-projects' }
          : allSessions
            ? { readScope: 'all-sessions' }
            : { workspaceId }),
        readAt: new Date().toISOString(),
        revision: result.revision,
        items,
        complete: !result.more,
        ...(nextCursor && { nextCursor }),
      };
    },
  };

  ctx.provide('workspaceContext', service);
}
export default { name, apply };
