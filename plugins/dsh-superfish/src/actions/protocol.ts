export const ACTION_TOOL = 'steward_propose_action';
export const SCHEDULE_WRITE_TOOL = 'steward_create_schedule';
export const SCHEDULE_PRESET = 'workspace-superagent-scheduled';
export const SCHEDULE = 'dsh.schedule.create';
export const BOARD = 'dsh.taskBoard.create';
export type ActionId = typeof SCHEDULE | typeof BOARD;
export interface ScheduleFields {
  title?: string; instruction?: string;
  schedule?: { kind?: 'daily' | 'weekly'; time?: string; timeZone?: string; weekdays?: number[] };
  target?: 'router_session' | 'dedicated_session';
}
export type BoardCardPermission = 'read-only' | 'workspace-write';
export interface BoardFields {
  title?: string;
  description?: string;
  prompt?: string;
  projectId?: string;
  column?: 'todo' | 'backlog';
  targetDate?: string;
  permission?: BoardCardPermission;
  mode?: string;
}
export interface ProjectOption { id: string; label: string }
export interface ProposalDelegation {
  state: 'accepted' | 'rejected' | 'unknown';
  executionId?: string;
  reason?: string;
}
export type Candidate =
  | { actionId: typeof SCHEDULE; version: 1; params: ScheduleFields }
  | { actionId: typeof BOARD; version: 1; params: BoardFields };
export interface Proposal {
  id: string; turn: number; revision: number; candidate: Candidate;
  status: 'needs_input' | 'ready' | 'unavailable' | 'submitting' | 'unknown' | 'succeeded' | 'dismissed' | 'expired';
  nextRunAt?: string; resultId?: string;
  projects?: readonly ProjectOption[];
  submissionIssue?: 'entry_unavailable' | 'schedule_preview_failed';
  delegation?: ProposalDelegation;
}

export function isValidTargetDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) || value.startsWith('0000')) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function currentLocalDate(now = Date.now(), timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      ...(timeZone ? { timeZone } : {}),
    }).format(new Date(now));
  } catch {
    return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  }
}

const str = (maxLength: number) => ({ type: 'string', maxLength });
const shape = (properties: object, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const mergedCandidateParams = shape({
  title: { ...str(120), description: '卡片标题或定时任务名称' },
  description: { ...str(4000), description: '看板卡片任务描述（可选）' },
  prompt: { ...str(20000), description: '看板卡片执行提示词 Prompt（可选）' },
  projectId: { ...str(256), description: '所属项目 ID 或名称（可选，默认当前工作区）' },
  column: { enum: ['todo', 'backlog'], description: '看板所在列：todo（待办）或 backlog（待规划）' },
  targetDate: { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$', description: '待办执行日期 YYYY-MM-DD（可选，todo 默认当天）' },
  permission: { enum: ['read-only', 'workspace-write'], description: '看板卡片执行权限：read-only 或 workspace-write' },
  mode: { ...str(128), description: '看板卡片执行模式（如 claude-code、codex、gemini 等）' },
  instruction: { ...str(4000), description: '定时任务执行指令（仅 dsh.schedule.create 使用）' },
  target: { enum: ['router_session', 'dedicated_session'], description: '定时任务投递目标（可选）' },
  schedule: shape({
    kind: { enum: ['daily', 'weekly'] },
    time: { type: 'string', pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' },
    timeZone: str(96),
    weekdays: { type: 'array', minItems: 1, maxItems: 7, uniqueItems: true, items: { type: 'integer', minimum: 1, maximum: 7 } },
  }),
});
export const candidateSchema = shape({
  actionId: {
    type: 'string',
    enum: [BOARD, SCHEDULE],
    description: '动作类型：新建看板任务卡片传 "dsh.taskBoard.create"，新建定时任务传 "dsh.schedule.create"',
  },
  version: {
    type: 'integer',
    enum: [1],
    description: '协议版本号，固定填 1',
  },
  params: mergedCandidateParams,
}, ['actionId', 'params']);
export const actionToolSchema = shape({
  proposal: { ...candidateSchema, description: '单张草稿卡片配置（推荐格式：{ actionId: "dsh.taskBoard.create", version: 1, params: { title, column, permission, mode, ... } }）' },
  proposals: { type: 'array', minItems: 1, maxItems: 10, items: candidateSchema, description: '批量生成多张草稿卡片时传入数组' },
  continueDraft: { type: 'boolean', description: '仅在补充上一轮未完成草稿时设为 true，新建卡片设为 false' },
});
const scheduleWriteItemSchema = shape({
  title: str(120),
  instruction: str(4000),
  kind: { enum: ['daily', 'weekly'] },
  time: { type: 'string', pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' },
  timeZone: str(96),
  weekdays: { type: 'array', minItems: 1, maxItems: 7, uniqueItems: true, items: { type: 'integer', minimum: 1, maximum: 7 } },
}, ['instruction', 'kind', 'time']);
export const scheduleWriteToolSchema = shape({
  title: str(120),
  instruction: str(4000),
  kind: { enum: ['daily', 'weekly'] },
  time: { type: 'string', pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' },
  timeZone: str(96),
  weekdays: { type: 'array', minItems: 1, maxItems: 7, uniqueItems: true, items: { type: 'integer', minimum: 1, maximum: 7 } },
  schedules: { type: 'array', minItems: 1, maxItems: 5, items: scheduleWriteItemSchema },
});

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw Error('INVALID_DRAFT');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) throw Error('INVALID_DRAFT');
  return value.trim() || undefined;
}
function choice<T>(value: unknown, choices: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (!choices.includes(value as T)) throw Error('INVALID_DRAFT');
  return value as T;
}

const BOARD_PARAM_KEYS = ['title', 'description', 'prompt', 'projectId', 'column', 'targetDate', 'permission', 'mode'] as const;

function normalizeActionId(raw: unknown, hintObj: Record<string, unknown>): ActionId {
  if (raw === BOARD || raw === 'board' || raw === 'taskBoard' || raw === 'task_board' || raw === 'dsh.taskBoard' || raw === 'taskBoard.create') {
    return BOARD;
  }
  if (raw === SCHEDULE || raw === 'schedule' || raw === 'dsh.schedule' || raw === 'schedule.create') {
    return SCHEDULE;
  }
  if (raw !== undefined) throw Error('INVALID_DRAFT');
  const nested = hintObj.params && typeof hintObj.params === 'object' && !Array.isArray(hintObj.params)
    ? (hintObj.params as Record<string, unknown>)
    : hintObj;
  if ('instruction' in nested || 'schedule' in nested || 'kind' in nested || 'time' in nested || 'weekdays' in nested || 'target' in nested) {
    return SCHEDULE;
  }
  if (BOARD_PARAM_KEYS.some(k => k in nested) || 'status' in nested || 'workspaceId' in nested) {
    return BOARD;
  }
  throw Error('INVALID_DRAFT');
}

export function parseCandidate(value: unknown): Candidate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('INVALID_DRAFT');
  const rawObj = value as Record<string, unknown>;
  const actionId = normalizeActionId(rawObj.actionId, rawObj);
  const rawVersion = rawObj.version;
  if (rawVersion !== undefined && rawVersion !== 1 && rawVersion !== '1') throw Error('INVALID_DRAFT');
  const version = 1 as const;

  const topKeys = Object.keys(rawObj).filter(k => k !== 'actionId' && k !== 'version' && k !== 'params');
  let rawParams: Record<string, unknown>;
  if (rawObj.params !== undefined) {
    if (!rawObj.params || typeof rawObj.params !== 'object' || Array.isArray(rawObj.params)) throw Error('INVALID_DRAFT');
    if (topKeys.length > 0) {
      const extra: Record<string, unknown> = {};
      for (const k of topKeys) extra[k] = rawObj[k];
      rawParams = { ...extra, ...(rawObj.params as Record<string, unknown>) };
    } else {
      rawParams = { ...(rawObj.params as Record<string, unknown>) };
    }
  } else {
    rawParams = {};
    for (const k of topKeys) rawParams[k] = rawObj[k];
  }

  if (actionId === SCHEDULE) {
    if (rawParams.schedule === undefined && ('kind' in rawParams || 'time' in rawParams || 'timeZone' in rawParams || 'weekdays' in rawParams)) {
      const { kind, time, timeZone, weekdays, ...rest } = rawParams;
      rawParams = {
        ...rest,
        schedule: {
          ...(kind !== undefined ? { kind } : {}),
          ...(time !== undefined ? { time } : {}),
          ...(timeZone !== undefined ? { timeZone } : {}),
          ...(weekdays !== undefined ? { weekdays } : {}),
        },
      };
    }
    const p = record(rawParams, ['title','instruction','schedule','target']);
    const s = record(p.schedule === undefined ? {} : p.schedule, ['kind','time','timeZone','weekdays']);
    const kind = choice(s.kind, ['daily','weekly'] as const);
    const time = text(s.time, 5);
    if (time && !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(time)) throw Error('INVALID_DRAFT');
    const zone = text(s.timeZone, 96);
    if (zone && !['UTC', ...Intl.supportedValuesOf('timeZone')].includes(zone)) {
      // Intl.supportedValuesOf may omit valid aliases; reject offsets and non-IANA forms.
      try { if (!zone.includes('/')) throw Error('INVALID_DRAFT'); new Intl.DateTimeFormat('en', { timeZone: zone }); }
      catch { throw Error('INVALID_DRAFT'); }
    }
    const days = s.weekdays;
    if (days !== undefined && (kind === 'daily' || !Array.isArray(days) || days.length < 1 || days.length > 7 ||
        new Set(days).size !== days.length || days.some(day => !Number.isInteger(day) || day < 1 || day > 7))) throw Error('INVALID_DRAFT');
    return { actionId, version, params: { title: text(p.title,120), instruction: text(p.instruction,4000), target: choice(p.target,['router_session','dedicated_session'] as const),
      schedule: { kind, time, timeZone: zone, weekdays: days === undefined ? undefined : [...days].sort((a,b) => a-b) } } };
  }
  if (actionId === BOARD) {
    if ('status' in rawParams && rawParams.column === undefined) {
      rawParams.column = rawParams.status;
      delete rawParams.status;
    }
    if ('workspaceId' in rawParams && rawParams.projectId === undefined) {
      rawParams.projectId = rawParams.workspaceId;
      delete rawParams.workspaceId;
    }
    if (rawParams.column === '待办') rawParams.column = 'todo';
    if (rawParams.column === '待规划') rawParams.column = 'backlog';
    const p = record(rawParams, ['title','description','prompt','projectId','column','targetDate','permission','mode']);
    const column = choice(p.column, ['todo','backlog'] as const);
    const rawDate = text(p.targetDate, 10);
    if (rawDate !== undefined && !isValidTargetDate(rawDate)) throw Error('INVALID_DRAFT');
    const rawPermission = text(p.permission, 32);
    const permission = choice(rawPermission, ['read-only', 'workspace-write'] as const);
    const mode = text(p.mode, 128);
    if (mode !== undefined && !/^[a-z0-9][a-z0-9_.:-]{1,127}$/i.test(mode)) throw Error('INVALID_DRAFT');
    return {
      actionId,
      version,
      params: {
        title: text(p.title, 120),
        description: text(p.description, 4000),
        prompt: text(p.prompt, 20000),
        projectId: text(p.projectId, 256),
        column,
        ...(rawDate && column !== 'backlog' ? { targetDate: rawDate } : {}),
        ...(permission ? { permission } : {}),
        ...(mode ? { mode } : {}),
      },
    };
  }
  throw Error('INVALID_DRAFT');
}
export function readToolCandidates(value: unknown): { candidates: Candidate[]; continueDraft: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('INVALID_DRAFT');
  const raw = value as Record<string, unknown>;
  if (!('proposal' in raw) && !('proposals' in raw)) {
    const { continueDraft, ...rest } = raw;
    if (continueDraft !== undefined && typeof continueDraft !== 'boolean') throw Error('INVALID_DRAFT');
    if (Object.keys(rest).length === 0) throw Error('INVALID_DRAFT');
    return { candidates: [parseCandidate(rest)], continueDraft: continueDraft === true };
  }
  const { proposal, proposals, continueDraft } = record(value, ['proposal','proposals','continueDraft']);
  if (continueDraft !== undefined && typeof continueDraft !== 'boolean') throw Error('INVALID_DRAFT');
  const candidates: Candidate[] = [];
  if (proposal !== undefined) candidates.push(parseCandidate(proposal));
  if (proposals !== undefined) {
    if (!Array.isArray(proposals) || proposals.length < 1 || proposals.length > 10) throw Error('INVALID_DRAFT');
    for (const item of proposals) candidates.push(parseCandidate(item));
  }
  if (candidates.length < 1 || candidates.length > 10) throw Error('INVALID_DRAFT');
  return { candidates, continueDraft: continueDraft === true };
}
export function readToolCandidate(value: unknown) {
  const { candidates, continueDraft } = readToolCandidates(value);
  return { candidate: candidates[0]!, continueDraft };
}

function toScheduleCandidate(raw: unknown): Extract<Candidate, { actionId: typeof SCHEDULE }> {
  const entry = record(raw, ['title', 'instruction', 'kind', 'time', 'timeZone', 'weekdays']);
  return parseCandidate({
    actionId: SCHEDULE,
    version: 1,
    params: {
      title: entry.title,
      instruction: entry.instruction,
      target: 'router_session',
      schedule: {
        kind: entry.kind,
        time: entry.time,
        timeZone: entry.timeZone,
        weekdays: entry.weekdays,
      },
    },
  }) as Extract<Candidate, { actionId: typeof SCHEDULE }>;
}

export function readScheduleWriteCandidates(value: unknown): Extract<Candidate, { actionId: typeof SCHEDULE }>[] {
  const obj = record(value, ['title', 'instruction', 'kind', 'time', 'timeZone', 'weekdays', 'schedules']);
  if (obj.schedules !== undefined) {
    if (obj.title !== undefined || obj.instruction !== undefined || obj.kind !== undefined
      || obj.time !== undefined || obj.timeZone !== undefined || obj.weekdays !== undefined) {
      throw Error('INVALID_DRAFT');
    }
    if (!Array.isArray(obj.schedules) || obj.schedules.length < 1 || obj.schedules.length > 5) {
      throw Error('INVALID_DRAFT');
    }
    return obj.schedules.map(toScheduleCandidate);
  }
  return [toScheduleCandidate(obj)];
}

export function missingFields(candidate: Candidate): string[] {
  if (candidate.actionId === BOARD) {
    const missing: string[] = [];
    if (!candidate.params.title?.trim()) missing.push('title');
    if (candidate.params.column === 'todo' && !candidate.params.targetDate?.trim()) {
      missing.push('targetDate');
    }
    return missing;
  }
  const { instruction, schedule } = candidate.params;
  return [...(!instruction?.trim() ? ['instruction'] : []), ...(!schedule?.kind ? ['kind'] : []),
    ...(!schedule?.time ? ['time'] : []), ...(!schedule?.timeZone?.trim() ? ['timeZone'] : []),
    ...(schedule?.kind === 'weekly' && !schedule.weekdays?.length ? ['weekdays'] : [])];
}
