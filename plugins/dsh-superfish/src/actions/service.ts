import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  BOARD,
  SCHEDULE,
  SCHEDULE_PRESET,
  currentLocalDate,
  missingFields,
  parseCandidate,
  type Candidate,
  type ProjectOption,
  type Proposal,
  type ProposalDelegation,
} from './protocol.js';
import type { ParsedTaskDraft } from './parse-draft.js';

type Row = { id: string; session: string; turn: number; revision: number; state: 'draft' | 'pending' | 'succeeded' | 'dismissed'; body: string; expires: number; result: string | null };
type Timing = { kind: 'daily'; daily: { time: string; time_zone: string } } |
  { kind: 'weekly'; weekly: { time: string; time_zone: string; weekdays: number[] } };
type ScheduleTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'new_once'; sessionId?: string; create?: { cwd?: string; agentPreset?: string } }
  | { kind: 'new'; create?: { cwd?: string; agentPreset?: string } };
type ScheduleRequest = { title: string; prompt: string; timing: Timing; target: ScheduleTarget };
type ScheduleResult = { id: string; scheduledAt?: string; code?: string; target?: ScheduleTarget; updatedAt?: number | null };
type ScheduleCatalogEntry = ScheduleResult & {
  status?: string;
  involvedSessionIds?: readonly string[];
};
interface ScheduleFace {
  previewConfirmedCreate(request: ScheduleRequest): { scheduledAt?: string };
  createConfirmed(request: ScheduleRequest, operationId: string): Promise<ScheduleResult>;
  viewConfirmedCreate(request: ScheduleRequest, operationId: string): Promise<ScheduleResult>;
  view?(request: { id: string }): Promise<ScheduleCatalogEntry>;
  catalog?(): Promise<readonly ScheduleCatalogEntry[]>;
  edit?(request: {
    id: string;
    action: 'update';
    expectedUpdatedAt?: number | null;
    patch: { target: { kind: 'session'; sessionId: string } };
  }): Promise<unknown>;
}
interface BoardRow { id: string; title?: string; parentId?: string | null; workspaceId?: string; projectId?: string | null }
type BoardAction =
  | {
      kind: 'create';
      id: string;
      input: {
        title: string;
        description: string;
        prompt: string;
        projectId: string;
        workspaceId: string;
        status: 'todo' | 'backlog';
        targetDate?: string | null;
        applyCardDefaults?: boolean;
        permission?: 'read-only' | 'workspace-write';
        mode?: string;
        model?: string;
        reasoningEffort?: string;
      };
    }
  | { kind: 'delete'; taskId: string }
  | { kind: 'archive'; taskId: string };
interface BoardFace {
  snapshot(): { tasks: readonly BoardRow[] };
  isExtensionEnabled(id: string): boolean;
  apply(operationId: string, action: BoardAction): unknown | Promise<unknown>;
}
interface Bindings {
  workspaceId: string; workspacePath: string;
  schedule(): unknown; board(): unknown;
  projects?(): readonly ProjectOption[];
  /** The Router model a card created here will run with; keeps the Worker on a usable route. */
  model?(): { provider: string; model: string; reasoningEffort?: string } | null;
  delegate?(sessionId: string, operationId: string, taskId: string): Promise<{
    state: 'accepted' | 'rejected' | 'unknown' | 'reserved';
    executionId?: string;
    reason?: string;
  }>;
  parseTaskDraft?(text: string): Promise<ParsedTaskDraft>;
  isLegacyScheduledSession?(sessionId: string): boolean | Promise<boolean>;
  check(): void;
  now?(): number;
}
export type ActionRequest = { op: 'read' | 'list'; turn: number } |
  { op: 'read'; id: string } |
  { op: 'list'; ids: readonly string[] } |
  { op: 'save'; id: string; revision: number; proposal: Candidate } |
  { op: 'confirm'; id: string; revision: number; expectedNextRunAt?: string; proposal?: Candidate; delegateNow?: boolean } |
  { op: 'parse_prompt'; id: string; revision: number; text: string; proposal?: Candidate } |
  { op: 'dismiss' | 'reconcile' | 'open' | 'delegate'; id: string; revision: number };

export class ActionService {
  readonly #db: DatabaseSync;
  readonly #active = new Set<string>();
  readonly #deletedSchedules = new Set<string>();
  readonly #catalogScheduleIds = new Map<string, Set<string>>();
  constructor(path: string, private readonly binding: Bindings) {
    this.#db = new DatabaseSync(path);
    const existingSql = (this.#db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='proposal'").get() as { sql?: string } | undefined)?.sql ?? '';
    if (existingSql && /UNIQUE\s*\(\s*session\s*,\s*turn\s*\)/i.test(existingSql)) {
      this.#db.exec(`BEGIN;
        CREATE TABLE proposal_next (
          id TEXT PRIMARY KEY, session TEXT NOT NULL, turn INTEGER NOT NULL, revision INTEGER NOT NULL,
          state TEXT NOT NULL, body TEXT NOT NULL, expires INTEGER NOT NULL, result TEXT
        ) STRICT;
        INSERT INTO proposal_next (id, session, turn, revision, state, body, expires, result)
          SELECT id, session, turn, revision, state, body, expires, result FROM proposal ORDER BY rowid ASC;
        DROP TABLE proposal;
        ALTER TABLE proposal_next RENAME TO proposal;
        COMMIT;`);
    } else {
      this.#db.exec(`CREATE TABLE IF NOT EXISTS proposal (
        id TEXT PRIMARY KEY, session TEXT NOT NULL, turn INTEGER NOT NULL, revision INTEGER NOT NULL,
        state TEXT NOT NULL, body TEXT NOT NULL, expires INTEGER NOT NULL, result TEXT
      ) STRICT`);
    }
    this.#db.exec('CREATE INDEX IF NOT EXISTS idx_proposal_session_turn ON proposal(session, turn)');
  }
  close() { this.#db.close(); }
  /** 返回该主理会话关联的定时任务 ID（含提案确认及底层直接归属主理会话的任务）。 */
  ownedScheduleIds(session: string): string[] {
    if (!session) return [];
    const rows = this.#db.prepare("SELECT body,result FROM proposal WHERE state='succeeded' AND result IS NOT NULL ORDER BY rowid ASC").all();
    const fromProposals = rows.flatMap(row => {
      const candidate = parseCandidate(JSON.parse(String(row.body)));
      const result = JSON.parse(String(row.result)) as { resultId?: unknown };
      return candidate.actionId === SCHEDULE && typeof result.resultId === 'string' ? [result.resultId] : [];
    });
    const fromCatalog = this.#catalogScheduleIds.get(session) ?? new Set<string>();
    return [...new Set([...fromProposals, ...fromCatalog])];
  }
  hasDailyReviewSchedule(session: string): boolean {
    if (!session) return false;
    const rows = this.#db.prepare("SELECT body,result FROM proposal WHERE state='succeeded' AND result IS NOT NULL ORDER BY rowid ASC").all();
    for (const row of rows) {
      try {
        const candidate = parseCandidate(JSON.parse(String(row.body)));
        const result = JSON.parse(String(row.result)) as { resultId?: unknown };
        if (candidate.actionId === SCHEDULE && typeof result.resultId === 'string' && !this.#deletedSchedules.has(result.resultId)) {
          return true;
        }
      } catch {
        // ignore malformed row
      }
    }
    const fromCatalog = this.#catalogScheduleIds.get(session);
    if (fromCatalog) {
      for (const id of fromCatalog) {
        if (!this.#deletedSchedules.has(id)) return true;
      }
    }
    return false;
  }
  async #viewScheduleRow(
    schedule: ScheduleFace,
    candidate: Extract<Candidate, { actionId: typeof SCHEDULE }>,
    rowId: string,
    session: string,
    resultId?: string,
  ): Promise<ScheduleResult> {
    if (resultId && typeof schedule.view === 'function') {
      const byId = await schedule.view({ id: resultId });
      if (byId && typeof byId.code !== 'string') return byId;
    }
    const current = await schedule.viewConfirmedCreate(this.#request(candidate, session), rowId);
    if (current && typeof current.code !== 'string') return current;
    const legacy = await schedule.viewConfirmedCreate(this.#legacyRequest(candidate), rowId);
    if (legacy && typeof legacy.code !== 'string') return legacy;
    return current;
  }
  async #usesLegacyScheduleTarget(target: ScheduleTarget | undefined, session: string, owned: boolean): Promise<boolean> {
    if (target?.kind === 'new_once' || target?.kind === 'new') {
      return target.create?.agentPreset === SCHEDULE_PRESET
        && (target.create.cwd === this.binding.workspacePath || (target.create.cwd === undefined && owned));
    }
    return target?.kind === 'session' && target.sessionId !== session
      && (await this.binding.isLegacyScheduledSession?.(target.sessionId)) === true;
  }
  async refreshScheduleStates(session: string): Promise<boolean> {
    if (!session) return false;
    let schedule: ScheduleFace;
    try {
      schedule = this.#schedule();
    } catch {
      return this.hasDailyReviewSchedule(session);
    }
    const rows = this.#db.prepare("SELECT * FROM proposal WHERE state='succeeded' AND result IS NOT NULL ORDER BY rowid ASC").all() as unknown as Row[];
    await Promise.all(rows.map(async row => {
      try {
        const candidate = parseCandidate(JSON.parse(row.body));
        if (candidate.actionId !== SCHEDULE || !row.result) return;
        const parsed = JSON.parse(row.result) as { resultId?: unknown };
        if (typeof parsed.resultId !== 'string') return;
        const viewed = await this.#viewScheduleRow(schedule, candidate, row.id, session, parsed.resultId);
        if (viewed && typeof viewed.code === 'string') {
          this.#deletedSchedules.add(parsed.resultId);
        } else if (viewed && typeof viewed.id === 'string') {
          this.#deletedSchedules.delete(parsed.resultId);
          if (
            typeof schedule.edit === 'function' &&
            (viewed.target?.kind !== 'session' || viewed.target.sessionId !== session)
          ) {
            await schedule.edit({
              id: viewed.id,
              action: 'update',
              patch: { target: { kind: 'session', sessionId: session } },
            }).catch(() => undefined);
          }
        }
      } catch {
        // ignore transient lookup failures
      }
    }));
    if (typeof schedule.catalog === 'function') {
      try {
        const entries = await schedule.catalog();
        const proposalIds = new Set(this.ownedScheduleIds(session));
        const matched = new Set<string>();
        for (const entry of entries) {
          if (!entry || typeof entry.id !== 'string' || typeof entry.code === 'string') continue;
          const isDirectTarget = entry.target?.kind === 'session' && entry.target.sessionId === session;
          const isInvolved = Array.isArray(entry.involvedSessionIds) && entry.involvedSessionIds.includes(session);
          const owned = proposalIds.has(entry.id);
          const isLegacyTarget = await this.#usesLegacyScheduleTarget(entry.target, session, owned);
          const isOwned = owned || isDirectTarget || isInvolved || isLegacyTarget;
          if (!isOwned) continue;
          matched.add(entry.id);
          this.#deletedSchedules.delete(entry.id);
          if (typeof schedule.edit === 'function' && isLegacyTarget) {
            await schedule.edit({
              id: entry.id,
              action: 'update',
              ...(entry.updatedAt !== undefined ? { expectedUpdatedAt: entry.updatedAt } : {}),
              patch: { target: { kind: 'session', sessionId: session } },
            }).catch(() => undefined);
          }
        }
        this.#catalogScheduleIds.set(session, matched);
      } catch {
        // ignore catalog sync errors
      }
    }
    return this.hasDailyReviewSchedule(session);
  }
  renderPromptHint(session: string): string {
    if (!session) return '';
    const rows = this.#db.prepare('SELECT * FROM proposal WHERE session=? ORDER BY rowid ASC').all(session) as unknown as Row[];
    if (rows.length === 0) return '';
    const recent = rows.slice(-8).map(row => {
      try {
        const candidate = parseCandidate(JSON.parse(row.body));
        const kind = candidate.actionId === SCHEDULE ? '定时任务' : '看板任务';
        const title = candidate.params.title?.trim() || kind;
        if (row.state === 'succeeded') {
          const parsed = row.result ? (JSON.parse(row.result) as { resultId?: unknown }) : undefined;
          const resultId = typeof parsed?.resultId === 'string' ? parsed.resultId : undefined;
          let deleted = false;
          if (candidate.actionId === SCHEDULE) {
            deleted = !!resultId && this.#deletedSchedules.has(resultId);
          } else {
            try { deleted = !this.#boardResult(row); } catch { deleted = false; }
          }
          return `- 历史第 ${row.turn} 轮《${title}》（${kind}）：${deleted ? '此前已确认创建，但原任务现已被用户删除' : '此前已在界面确认创建成功'}`;
        }
        if (row.state === 'dismissed') {
          return `- 历史第 ${row.turn} 轮《${title}》（${kind}）：此前已被用户取消`;
        }
        return `- 历史第 ${row.turn} 轮《${title}》（${kind}）：仅停留在历史第 ${row.turn} 轮的旧草稿`;
      } catch {
        return '';
      }
    }).filter(Boolean);
    if (recent.length === 0) return '';
    return [
      '【当前会话历史快捷操作真实状态（以本段实时状态为准，忽略历史工具返回中静态的 created: false，切勿沿用前序轮次「不能代替卡片确认」的旧回复）】',
      ...recent,
      '重要：前端仅在当前对话轮次实际调用了 steward_propose_action 时，才会在本轮回复底部渲染卡片。只要用户在当前最新消息中再次要求创建定时任务或看板卡片（即使请求文本与前序轮次完全一致），都说明用户需要重新获取或重建任务（例如旧任务已被删除或需重新出卡）：若是看板任务或参数尚未齐备的定时任务，你必须在当前轮次重新调用 steward_propose_action 生成新草稿卡片（continueDraft 传 false）；若是用户明确要求创建且参数已完整的定时任务，请直接调用 steward_create_schedule 创建。严禁跳过工具调用！',
    ].join('\n');
  }
  clearAll(): void {
    this.#deletedSchedules.clear();
    this.#catalogScheduleIds.clear();
    this.#db.exec('DELETE FROM proposal');
  }
  listSessionProposals(session: string, limit = 20): Proposal[] {
    if (!session) return [];
    const cap = Math.max(1, Math.min(limit, 50));
    const rows = this.#db
      .prepare('SELECT * FROM proposal WHERE session=? ORDER BY turn DESC, rowid DESC LIMIT ?')
      .all(session, cap) as unknown as Row[];
    return rows.reverse().map(row => this.#view(row));
  }
  #now() { return this.binding.now?.() ?? Date.now(); }
  #listAt(session: string, turn: number): Row[] {
    return this.#db.prepare('SELECT * FROM proposal WHERE session=? AND turn=? ORDER BY rowid ASC').all(session, turn) as unknown as Row[];
  }
  #at(session: string, turn: number) {
    return this.#db.prepare('SELECT * FROM proposal WHERE session=? AND turn=? ORDER BY rowid ASC LIMIT 1').get(session, turn) as Row | undefined;
  }
  #owned(session: string, id: string) {
    const row = this.#db.prepare('SELECT * FROM proposal WHERE session=? AND id=?').get(session,id) as Row | undefined;
    if (!row) throw Error('DRAFT_NOT_FOUND');
    return row;
  }
  #projects(): readonly ProjectOption[] {
    const list = this.binding.projects?.() ?? [];
    return list.some(item => item.id === this.binding.workspaceId)
      ? list
      : [{ id: this.binding.workspaceId, label: this.binding.workspaceId }, ...list];
  }
  #resolveProjectId(raw: string | undefined, fallbackOnUnknown = false): string {
    if (!raw) return this.binding.workspaceId;
    const projects = this.#projects();
    const matched = projects.find(item => item.id === raw || item.label === raw)
      ?? projects.find(item => item.label.toLowerCase() === raw.toLowerCase());
    if (matched) return matched.id;
    if (fallbackOnUnknown) return this.binding.workspaceId;
    throw Error('DRAFT_SCOPE_CHANGED');
  }
  #normalize(candidate: Candidate, fallbackProject = false, defaultTodoDate = false): Candidate {
    if (candidate.actionId === BOARD) {
      const projectId = this.#resolveProjectId(candidate.params.projectId, fallbackProject);
      const rawColumn = candidate.params.column;
      const rawDate = candidate.params.targetDate;
      if (rawColumn === 'backlog') {
        const { targetDate: _omit, ...rest } = candidate.params;
        return { ...candidate, params: { ...rest, projectId, column: 'backlog' } };
      }
      if (rawColumn === 'todo') {
        const targetDate = rawDate ?? (defaultTodoDate ? currentLocalDate(this.#now()) : undefined);
        const { targetDate: _omit, ...rest } = candidate.params;
        return {
          ...candidate,
          params: {
            ...rest,
            projectId,
            column: 'todo',
            ...(targetDate ? { targetDate } : {}),
          },
        };
      }
      if (rawDate) {
        return {
          ...candidate,
          params: {
            ...candidate.params,
            projectId,
            column: 'todo',
            targetDate: rawDate,
          },
        };
      }
      if (defaultTodoDate) {
        return {
          ...candidate,
          params: {
            ...candidate.params,
            projectId,
            column: 'todo',
            targetDate: currentLocalDate(this.#now()),
          },
        };
      }
      const { targetDate: _omit, ...rest } = candidate.params;
      return { ...candidate, params: { ...rest, projectId, column: 'backlog' } };
    }
    const { title, instruction, schedule } = candidate.params;
    return { ...candidate, params: { ...candidate.params, title: title ?? instruction?.slice(0, 60), target: 'router_session',
      schedule: { ...schedule, timeZone: schedule?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone } } };
  }
  #schedule(): ScheduleFace {
    const s = this.binding.schedule() as Partial<ScheduleFace> | undefined;
    if (typeof s?.previewConfirmedCreate !== 'function' || typeof s.createConfirmed !== 'function' || typeof s.viewConfirmedCreate !== 'function') throw Error('ACTION_UNAVAILABLE');
    return s as ScheduleFace;
  }
  #board(): BoardFace {
    const b = this.binding.board() as Partial<BoardFace> | undefined;
    if (typeof b?.snapshot !== 'function' || typeof b.apply !== 'function' || b.isExtensionEnabled?.('workspace-superagent-read') !== true) throw Error('ACTION_UNAVAILABLE');
    return b as BoardFace;
  }
  #request(candidate: Extract<Candidate, { actionId: typeof SCHEDULE }>, session: string): ScheduleRequest {
    const { title, instruction, schedule } = candidate.params;
    const timing = { time: schedule!.time! + ':00', time_zone: schedule!.timeZone! };
    return { title: title!, prompt: instruction!, timing: schedule!.kind === 'weekly'
      ? { kind: 'weekly', weekly: { ...timing, weekdays: schedule!.weekdays! } } : { kind: 'daily', daily: timing },
      target: { kind: 'session', sessionId: session } };
  }
  #legacyRequest(candidate: Extract<Candidate, { actionId: typeof SCHEDULE }>): ScheduleRequest {
    const { title, instruction, schedule } = candidate.params;
    const timing = { time: schedule!.time! + ':00', time_zone: schedule!.timeZone! };
    return { title: title!, prompt: instruction!, timing: schedule!.kind === 'weekly'
      ? { kind: 'weekly', weekly: { ...timing, weekdays: schedule!.weekdays! } } : { kind: 'daily', daily: timing },
      target: { kind: 'new_once', create: { cwd: this.binding.workspacePath, agentPreset: SCHEDULE_PRESET } } };
  }
  #boardResult(row: Row): BoardRow | undefined {
    const candidate = parseCandidate(JSON.parse(row.body));
    const targetId = candidate.actionId === BOARD ? (candidate.params.projectId ?? this.binding.workspaceId) : this.binding.workspaceId;
    const task = this.#board().snapshot().tasks.find(task => task.id === row.id);
    return task && (task.projectId === undefined || task.projectId === null ? task.workspaceId : task.projectId) === targetId ? task : undefined;
  }
  #result(row: Row, id: string, nextRunAt?: string) {
    this.#deletedSchedules.delete(id);
    this.#db.prepare("UPDATE proposal SET state='succeeded',result=? WHERE id=? AND revision=? AND state='pending'").run(JSON.stringify({resultId:id,nextRunAt}),row.id,row.revision);
    return this.#owned(row.session,row.id);
  }
  async #delegateBoardTask(session: string, row: Row, taskId: string): Promise<Row> {
    const existingResult = row.result
      ? (JSON.parse(row.result) as { resultId: string; nextRunAt?: string; delegation?: ProposalDelegation })
      : { resultId: taskId };
    if (existingResult.delegation?.state === 'accepted') return row;
    let delegation: ProposalDelegation;
    if (!this.binding.delegate) {
      delegation = { state: 'rejected', reason: '当前主理尚未接入看板派工能力。' };
    } else {
      try {
        const rec = await this.binding.delegate(session, 'delegate:action:' + row.id, taskId);
        delegation = {
          state: rec.state === 'reserved' ? 'unknown' : rec.state,
          ...(rec.executionId ? { executionId: rec.executionId } : {}),
          ...(rec.reason ? { reason: rec.reason } : {}),
        };
      } catch (error) {
        delegation = {
          state: 'unknown',
          reason: error instanceof Error ? error.message : '派工状态需要核实',
        };
      }
    }
    const nextResult = { ...existingResult, resultId: taskId, delegation };
    this.#db.prepare("UPDATE proposal SET result=? WHERE id=? AND state='succeeded'").run(JSON.stringify(nextResult), row.id);
    return this.#owned(session, row.id);
  }
  #view(row: Row): Proposal {
    const candidate = parseCandidate(JSON.parse(row.body));
    const projects = candidate.actionId === BOARD ? this.#projects() : undefined;
    const base = { id: row.id, turn: row.turn, revision: row.revision, candidate, ...(projects ? { projects } : {}) };
    if (row.state === 'succeeded') return { ...base, status: 'succeeded', ...JSON.parse(row.result!) as {resultId:string; nextRunAt?:string; delegation?:ProposalDelegation} };
    if (row.state === 'dismissed') return { ...base, status: 'dismissed' };
    if (row.state === 'pending') return { ...base, status: this.#active.has(row.id) ? 'submitting' : 'unknown' };
    if (row.expires <= this.#now()) return { ...base, status: 'expired' };
    const incomplete = missingFields(candidate).length > 0;
    let schedule: ScheduleFace | undefined;
    try {
      if (candidate.actionId === BOARD) this.#board();
      else schedule = this.#schedule();
    } catch {
      return { ...base, status: incomplete ? 'needs_input' : 'unavailable', submissionIssue: 'entry_unavailable' };
    }
    if (incomplete) return { ...base, status: 'needs_input' };
    if (candidate.actionId === BOARD) return { ...base, status: 'ready' };
    try {
      const nextRunAt = schedule?.previewConfirmedCreate(this.#request(candidate, row.session)).scheduledAt;
      if (nextRunAt) return { ...base, status: 'ready', nextRunAt };
    } catch { /* 当前配置未通过调度预览，保留草稿供用户修改。 */ }
    return { ...base, status: 'unavailable', submissionIssue: 'schedule_preview_failed' };
  }
  propose(session: string, turn: number, candidate: Candidate, continueDraft: boolean): Proposal {
    this.binding.check();
    if (continueDraft) {
      const priorRows = this.#db.prepare("SELECT * FROM proposal WHERE session=? AND state='draft' AND expires>? AND turn<? ORDER BY turn DESC, rowid DESC").all(session,this.#now(),turn) as unknown as Row[];
      const parsedPriors = priorRows.flatMap(row => {
        try { return [{ row, prior: parseCandidate(JSON.parse(row.body)) }]; }
        catch { return []; }
      }).filter(entry => entry.prior.actionId === candidate.actionId);
      const targetTitle = candidate.params.title?.trim();
      const matched = (targetTitle ? parsedPriors.find(entry => entry.prior.params.title === targetTitle) : undefined)
        ?? parsedPriors.find(entry => missingFields(entry.prior).length > 0)
        ?? parsedPriors[0];
      if (matched) {
        const { row: previous, prior } = matched;
        const supplied = <T extends object>(value: T) => Object.fromEntries(Object.entries(value).filter(([,v]) => v !== undefined));
        const timing = prior.actionId === SCHEDULE && candidate.actionId === SCHEDULE
          ? { schedule: { ...prior.params.schedule, ...supplied(candidate.params.schedule ?? {}) } } : {};
        if ('schedule' in timing && timing.schedule?.kind === 'daily') delete timing.schedule.weekdays;
        const merged = this.#normalize(parseCandidate({ ...candidate, params: { ...prior.params, ...supplied(candidate.params), ...timing } }), true, true);
        this.#db.prepare("UPDATE proposal SET turn=?,revision=revision+1,body=?,expires=? WHERE id=? AND revision=? AND state='draft'")
          .run(turn,JSON.stringify(merged),this.#now()+86400000,previous.id,previous.revision);
        return this.#view(this.#owned(session,previous.id));
      }
    }
    const normalized = this.#normalize(candidate, true, true);
    const body = JSON.stringify(normalized);
    const existing = this.#listAt(session,turn).find(row => row.body === body);
    if (existing) return this.#view(existing);
    const id = randomUUID();
    this.#db.prepare("INSERT INTO proposal VALUES(?,?,?,1,'draft',?,?,NULL)").run(id,session,turn,body,this.#now()+86400000);
    return this.#view(this.#owned(session,id));
  }
  async createScheduleDirect(session: string, turn: number, rawCandidate: Candidate): Promise<Proposal> {
    this.binding.check();
    if (rawCandidate.actionId !== SCHEDULE) throw Error('INVALID_DRAFT');
    const candidate = parseCandidate(rawCandidate);
    const normalized = this.#normalize(candidate, true);
    if (normalized.actionId !== SCHEDULE) throw Error('INVALID_DRAFT');
    if (missingFields(normalized).length > 0) throw Error('DRAFT_NOT_READY');

    const body = JSON.stringify(normalized);
    const existing = this.#listAt(session, turn).find(row => row.body === body && (row.state === 'succeeded' || row.state === 'pending'));
    if (existing) return this.#view(existing);

    const schedule = this.#schedule();
    const request = this.#request(normalized, session);
    let previewScheduledAt: string | undefined;
    try { previewScheduledAt = schedule.previewConfirmedCreate(request).scheduledAt; } catch { /* handled below */ }
    if (!previewScheduledAt) throw Error('SCHEDULE_PREVIEW_FAILED');

    const id = randomUUID();
    this.#db.prepare("INSERT INTO proposal VALUES(?,?,?,1,'pending',?,?,NULL)").run(id, session, turn, body, this.#now() + 86400000);
    let row = this.#owned(session, id);
    this.#active.add(id);
    try {
      await schedule.createConfirmed(request, id);
      const result = await schedule.viewConfirmedCreate(request, id);
      if (!result.code) row = this.#result(row, result.id, result.scheduledAt);
    } catch (error) {
      // The downstream may have committed. Keep pending row so host reconciliation can inspect it.
      console.error('大肥鱼直接创建定时任务结果需要核实', id, error instanceof Error ? error.name : '未知错误');
    } finally {
      this.#active.delete(id);
    }
    this.binding.check();
    return this.#view(this.#owned(session, id));
  }
  async ensureBoardTaskConfirmed(
    session: string,
    idOrTitle: string,
    fallback?: {
      title: string;
      description?: string;
      prompt?: string;
      permission?: 'read-only' | 'workspace-write';
      mode?: string;
    },
  ): Promise<string | undefined> {
    let board: BoardFace;
    try {
      board = this.#board();
    } catch {
      return undefined;
    }
    const rawId = idOrTitle.trim();
    const existingById = rawId ? board.snapshot().tasks.find(t => t.id === rawId) : undefined;
    if (existingById) return existingById.id;

    let matchedRow: Row | undefined = rawId
      ? (this.#db.prepare('SELECT * FROM proposal WHERE id=?').get(rawId) as Row | undefined)
      : undefined;

    const targetTitle = (fallback?.title ?? rawId).trim();
    if (!matchedRow && session && targetTitle) {
      const sessionRows = this.#db
        .prepare('SELECT * FROM proposal WHERE session=? ORDER BY rowid DESC LIMIT 30')
        .all(session) as unknown as Row[];
      for (const r of sessionRows) {
        try {
          const cand = parseCandidate(JSON.parse(r.body));
          if (cand.actionId === BOARD && cand.params.title?.trim() === targetTitle) {
            matchedRow = r;
            break;
          }
        } catch {
          // ignore malformed
        }
      }
    }

    if (matchedRow) {
      try {
        const candidate = this.#normalize(parseCandidate(JSON.parse(matchedRow.body)), true, true);
        if (candidate.actionId === BOARD && candidate.params.title?.trim()) {
          const id = matchedRow.id;
          const alreadyOnBoard = board.snapshot().tasks.find(t => t.id === id);
          if (!alreadyOnBoard) {
            const targetProjectId = candidate.params.projectId ?? this.binding.workspaceId;
            const description = candidate.params.description ?? fallback?.description ?? '';
            const prompt = candidate.params.prompt ?? fallback?.prompt ?? (description || candidate.params.title!);
            const column = candidate.params.column ?? (candidate.params.targetDate ? 'todo' : 'backlog');
            const targetDate = column === 'todo' ? candidate.params.targetDate : undefined;
            await board.apply(id, {
              kind: 'create',
              id,
              input: {
                title: candidate.params.title!,
                description,
                prompt,
                projectId: targetProjectId,
                workspaceId: targetProjectId,
                status: column === 'backlog' ? 'backlog' : 'todo',
                ...(targetDate ? { targetDate } : {}),
                ...(candidate.params.permission ? { permission: candidate.params.permission } : {}),
                ...(candidate.params.mode ? { mode: candidate.params.mode } : {}),
                applyCardDefaults: true,
              },
            });
          }
          if (matchedRow.state === 'draft' || matchedRow.state === 'pending') {
            this.#db
              .prepare("UPDATE proposal SET state='succeeded',result=? WHERE id=?")
              .run(JSON.stringify({ resultId: id }), id);
          }
          if (board.snapshot().tasks.some(t => t.id === id)) {
            return id;
          }
        }
      } catch {
        // fall through to title/fallback creation
      }
    }

    if (targetTitle) {
      const byTitle = board.snapshot().tasks.find(t => {
        const sameWs = (t.projectId ?? t.workspaceId ?? this.binding.workspaceId) === this.binding.workspaceId;
        return sameWs && t.title?.trim() === targetTitle;
      });
      if (byTitle) return byTitle.id;
    }

    const createTitle = fallback?.title?.trim() || (rawId && !/^[0-9a-f-]{36}$/i.test(rawId) ? rawId : '');
    if (!createTitle) return undefined;
    const taskId = /^[0-9a-f-]{36}$/i.test(rawId) ? rawId : randomUUID();
    const description = fallback?.description?.trim() ?? '';
    const prompt = fallback?.prompt?.trim() || description || createTitle;
    await board.apply(taskId, {
      kind: 'create',
      id: taskId,
      input: {
        title: createTitle,
        description,
        prompt,
        projectId: this.binding.workspaceId,
        workspaceId: this.binding.workspaceId,
        status: 'todo',
        targetDate: currentLocalDate(this.#now()),
        permission: fallback?.permission ?? 'workspace-write',
        ...(fallback?.mode ? { mode: fallback.mode } : {}),
        applyCardDefaults: true,
      },
    });
    return board.snapshot().tasks.some(t => t.id === taskId) ? taskId : undefined;
  }
  async deleteBoardTasksForGoal(input: {
    readonly title?: string;
    readonly milestones?: readonly { readonly title?: string; readonly boardTaskId?: string | null }[];
  }): Promise<string[]> {
    const targetIds = new Set<string>();
    const targetTitles = new Set<string>();
    if (input.title?.trim()) targetTitles.add(input.title.trim());
    for (const ms of input.milestones ?? []) {
      const bid = ms.boardTaskId?.trim();
      if (bid) {
        targetIds.add(bid);
        try {
          const row = this.#db.prepare('SELECT * FROM proposal WHERE id=?').get(bid) as Row | undefined;
          if (row) {
            if (row.state === 'draft' || row.state === 'pending') {
              this.#db.prepare("UPDATE proposal SET state='dismissed' WHERE id=?").run(bid);
            }
            if (row.result) {
              const parsed = JSON.parse(row.result) as { resultId?: string };
              if (parsed?.resultId) targetIds.add(parsed.resultId);
            }
          }
        } catch {
          // ignore
        }
      }
      if (ms.title?.trim()) targetTitles.add(ms.title.trim());
    }
    let board: BoardFace;
    try {
      board = this.#board();
    } catch {
      return [];
    }
    const tasks = board.snapshot().tasks;
    const toDelete = new Set<string>();
    for (const t of tasks) {
      const sameWs = (t.projectId ?? t.workspaceId ?? this.binding.workspaceId) === this.binding.workspaceId;
      if (targetIds.has(t.id) || (sameWs && t.title && targetTitles.has(t.title.trim()))) {
        toDelete.add(t.id);
      }
    }
    const ordered: string[] = [];
    for (const t of tasks) {
      if (t.parentId && toDelete.has(t.parentId) && !ordered.includes(t.id)) {
        ordered.push(t.id);
      }
    }
    for (const id of toDelete) {
      if (!ordered.includes(id)) ordered.push(id);
    }
    const deleted: string[] = [];
    for (const taskId of ordered) {
      try {
        await board.apply(randomUUID(), { kind: 'delete', taskId });
        deleted.push(taskId);
      } catch {
        try {
          await board.apply(randomUUID(), { kind: 'archive', taskId });
          deleted.push(taskId);
        } catch {
          // ignore
        }
      }
    }
    return deleted;
  }
  handle(session: string, input: { op: 'list'; turn: number } | { op: 'list'; ids: readonly string[] }, assertCurrent: () => void): Promise<Proposal[]>;
  handle(session: string, input: Exclude<ActionRequest, { op: 'list' }>, assertCurrent: () => void): Promise<Proposal | null>;
  handle(session: string, input: unknown, assertCurrent: () => void): Promise<Proposal | Proposal[] | null>;
  async handle(session: string, input: unknown, assertCurrent: () => void): Promise<Proposal | Proposal[] | null> {
    assertCurrent(); this.binding.check();
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('INVALID_DRAFT');
    const r = input as Record<string, unknown>;
    if ((r.op === 'read' || r.op === 'list') && Object.keys(r).sort().join() === 'op,turn' && typeof r.turn === 'number' && Number.isSafeInteger(r.turn) && r.turn >= 0) {
      if (r.op === 'list') return this.#listAt(session,r.turn).map(row => this.#view(row));
      const row = this.#at(session,r.turn);
      return row ? this.#view(row) : null;
    }
    if (r.op === 'read' && Object.keys(r).sort().join() === 'id,op' && typeof r.id === 'string' && /^[0-9a-f-]{36}$/i.test(r.id)) {
      try { return this.#view(this.#owned(session, r.id)); }
      catch { return null; }
    }
    if (r.op === 'list' && Object.keys(r).sort().join() === 'ids,op' && Array.isArray(r.ids) && r.ids.length <= 20 &&
        r.ids.every(id => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id))) {
      const out: Proposal[] = [];
      const seen = new Set<string>();
      for (const id of r.ids as string[]) {
        if (seen.has(id)) continue;
        seen.add(id);
        try { out.push(this.#view(this.#owned(session, id))); } catch { /* ignore non-owned */ }
      }
      return out;
    }
    const allowedKeys = r.op === 'save'
      ? ['op', 'id', 'revision', 'proposal']
      : r.op === 'confirm'
        ? ['op', 'id', 'revision', 'expectedNextRunAt', 'proposal', 'delegateNow']
        : r.op === 'parse_prompt'
          ? ['op', 'id', 'revision', 'text', 'proposal']
          : ['op', 'id', 'revision'];
    if (typeof r.id !== 'string' || !/^[0-9a-f-]{36}$/.test(r.id) || typeof r.revision !== 'number' || !Number.isSafeInteger(r.revision) ||
        typeof r.op !== 'string' || !['save','confirm','dismiss','reconcile','open','delegate','parse_prompt'].includes(r.op) ||
        Object.keys(r).some(k => !allowedKeys.includes(k))) throw Error('INVALID_DRAFT');
    if (r.op === 'confirm' && r.delegateNow !== undefined && typeof r.delegateNow !== 'boolean') throw Error('INVALID_DRAFT');
    if (r.op === 'parse_prompt' && (typeof r.text !== 'string' || !r.text.trim() || r.text.length > 16384)) throw Error('INVALID_DRAFT');
    let row = this.#owned(session,r.id);
    if (r.revision !== row.revision) return this.#view(row);
    const current = parseCandidate(JSON.parse(row.body));
    if (r.op === 'open') {
      if (row.state !== 'succeeded') throw Error('RESULT_NOT_AVAILABLE');
      const parsedResultId = row.result ? (JSON.parse(row.result) as { resultId?: string }).resultId : undefined;
      let found: string | undefined;
      if (current.actionId === BOARD) {
        found = this.#boardResult(row)?.id;
      } else {
        const schedule = this.#schedule();
        const viewed = await this.#viewScheduleRow(schedule, current, row.id, session, parsedResultId);
        if (viewed.code === undefined) {
          found = row.result ?? undefined;
          if (
            typeof schedule.edit === 'function' &&
            await this.#usesLegacyScheduleTarget(viewed.target, session, true)
          ) {
            await schedule.edit({
              id: viewed.id,
              action: 'update',
              ...(viewed.updatedAt !== undefined ? { expectedUpdatedAt: viewed.updatedAt } : {}),
              patch: { target: { kind: 'session', sessionId: session } },
            }).catch(() => undefined);
          }
        }
      }
      if (!found && current.actionId === SCHEDULE && row.result) {
        try {
          const parsed = JSON.parse(row.result) as { resultId?: unknown };
          if (typeof parsed.resultId === 'string') this.#deletedSchedules.add(parsed.resultId);
        } catch { /* ignore */ }
      }
      assertCurrent(); this.binding.check();
      if (!found) throw Error('RESULT_NOT_AVAILABLE');
      return this.#view(row);
    }
    if (r.op === 'delegate') {
      if (row.state !== 'succeeded' || current.actionId !== BOARD) throw Error('RESULT_NOT_AVAILABLE');
      const found = this.#boardResult(row)?.id;
      if (!found) throw Error('RESULT_NOT_AVAILABLE');
      row = await this.#delegateBoardTask(session, row, found);
      assertCurrent(); this.binding.check();
      return this.#view(row);
    }
    if (r.op === 'reconcile') {
      if (row.state !== 'pending' || this.#active.has(row.id)) return this.#view(row);
      const found = current.actionId === BOARD ? this.#boardResult(row)
        : await this.#viewScheduleRow(this.#schedule(), current, row.id, row.session);
      assertCurrent(); this.binding.check();
      return this.#view(found && !('code' in found && found.code !== undefined) ? this.#result(row,found.id,'scheduledAt' in found ? found.scheduledAt : undefined) : row);
    }
    if (row.state !== 'draft' || row.expires <= this.#now()) return this.#view(row);
    if (r.op === 'dismiss') {
      this.#db.prepare("UPDATE proposal SET state='dismissed',revision=revision+1 WHERE id=? AND revision=? AND state='draft'").run(row.id,row.revision);
      return this.#view(this.#owned(session,row.id));
    }
    if (r.op === 'parse_prompt') {
      if (current.actionId !== BOARD) throw Error('INVALID_DRAFT');
      const base = r.proposal !== undefined ? this.#normalize(parseCandidate(r.proposal)) : current;
      if (base.actionId !== BOARD) throw Error('INVALID_DRAFT');
      if (!this.binding.parseTaskDraft) throw Error('ACTION_UNAVAILABLE');
      const parsed = await this.binding.parseTaskDraft(String(r.text).trim());
      assertCurrent(); this.binding.check();
      row = this.#owned(session, row.id);
      if (r.revision !== row.revision || row.state !== 'draft') return this.#view(row);
      const nextCandidate: Candidate = {
        ...base,
        params: {
          ...base.params,
          title: base.params.title?.trim() || parsed.title || undefined,
          description: base.params.description?.trim() || parsed.description || undefined,
          prompt: parsed.prompt || base.params.prompt,
        },
      };
      this.#db.prepare("UPDATE proposal SET body=?,revision=revision+1 WHERE id=? AND revision=? AND state='draft'")
        .run(JSON.stringify(nextCandidate), row.id, row.revision);
      return this.#view(this.#owned(session, row.id));
    }
    const candidate = (r.op === 'save' || (r.op === 'confirm' && r.proposal !== undefined)) ? this.#normalize(parseCandidate(r.proposal)) : current;
    if (candidate.actionId !== current.actionId) throw Error('INVALID_DRAFT');
    if (r.op === 'save') {
      this.#db.prepare("UPDATE proposal SET body=?,revision=revision+1 WHERE id=? AND revision=? AND state='draft'").run(JSON.stringify(candidate),row.id,row.revision);
      return this.#view(this.#owned(session,row.id));
    }
    if (r.op === 'confirm' && r.proposal !== undefined) {
      if (candidate.actionId !== BOARD) throw Error('INVALID_DRAFT');
      this.#db.prepare("UPDATE proposal SET body=? WHERE id=? AND revision=? AND state='draft'").run(JSON.stringify(candidate),row.id,row.revision);
      row = this.#owned(session,row.id);
    }
    // Submit only the exact revision previously returned to the user for review.
    const preview = this.#view(row);
    if (preview.status === 'unavailable') return preview;
    if (preview.status !== 'ready') throw Error('DRAFT_NOT_READY');
    if (candidate.actionId === SCHEDULE && r.expectedNextRunAt !== preview.nextRunAt) return preview;
    assertCurrent(); this.binding.check();
    const adapter = candidate.actionId === BOARD ? this.#board() : this.#schedule();
    const reserved = this.#db.prepare("UPDATE proposal SET state='pending' WHERE id=? AND revision=? AND state='draft'").run(row.id,row.revision);
    if (!reserved.changes) return this.#view(this.#owned(session,row.id));
    this.#active.add(row.id);
    try {
      const id = row.id;
      if (candidate.actionId === BOARD) {
        const targetProjectId = candidate.params.projectId ?? this.binding.workspaceId;
        const description = candidate.params.description ?? '';
        const prompt = candidate.params.prompt ?? (description || candidate.params.title!);
        const column = candidate.params.column ?? (candidate.params.targetDate ? 'todo' : 'backlog');
        const targetDate = column === 'todo' ? candidate.params.targetDate : undefined;
        await (adapter as BoardFace).apply(id, {
          kind: 'create',
          id,
          input: {
            title: candidate.params.title!,
            description,
            prompt,
            projectId: targetProjectId,
            workspaceId: targetProjectId,
            status: column,
            ...(targetDate ? { targetDate } : {}),
            ...(candidate.params.permission ? { permission: candidate.params.permission } : {}),
            ...(candidate.params.mode ? { mode: candidate.params.mode } : {}),
            applyCardDefaults: true,
          },
        });
        if (this.#boardResult(row)?.id === id) {
          row = this.#result(row, id);
          if (r.delegateNow === true) {
            row = await this.#delegateBoardTask(session, row, id);
          }
        }
      } else {
        const schedule = adapter as ScheduleFace, request = this.#request(candidate, row.session);
        await schedule.createConfirmed(request,id);
        const result = await schedule.viewConfirmedCreate(request,id);
        if (!result.code) row = this.#result(row,result.id,result.scheduledAt);
      }
    } catch (error) {
      // The downstream may have committed. Do not send another create on an ambiguous result.
      console.error('大肥鱼快捷操作结果需要核实', row.id, error instanceof Error ? error.name : '未知错误');
    } finally { this.#active.delete(row.id); }
    assertCurrent(); this.binding.check();
    return this.#view(this.#owned(session,row.id));
  }
}
