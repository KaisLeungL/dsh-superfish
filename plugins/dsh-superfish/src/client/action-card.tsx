import * as React from 'react';
import type { Context } from '@deepseek-ai/cordis';
import { BOARD, SCHEDULE, currentLocalDate, missingFields, type Candidate, type Proposal } from '../actions/protocol.js';
import type { ActionRequest } from '../actions/service.js';
import { DEFAULT_BOT_NAME } from '../app/health/chat-input.js';
import { getBotProfile } from './bot-profile.js';
import { readChatHealth } from './chat-transport.js';
import { CONTROL_TOKEN_HEADER } from '../status.js';
import { templates, week } from './action-templates.js';

const css = `
.wsa-action{margin:12px 0 7px;max-width:690px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;overflow-wrap:anywhere}
.wsa-action-header,.wsa-action-footer{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;padding:12px 14px}
.wsa-action-header{border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-module-platform);border-radius:10px 10px 0 0}
.wsa-action-header h3{font-size:14px;font-weight:500;margin:0 0 3px}.wsa-action small,.wsa-action dt{color:var(--dsw-alias-label-secondary);font-size:12px}
.wsa-action-state{font-size:12px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:2px 6px}
.wsa-action-state[data-state=ready],.wsa-action-state[data-state=succeeded]{color:var(--dsw-alias-brand-primary-new-colorprimary-new-color)}
.wsa-action-body{padding:12px 14px;container-type:inline-size}.wsa-action-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 14px;margin:0}
.wsa-action-wide{grid-column:1/-1}.wsa-action dd{margin:3px 0 0;white-space:pre-wrap}.wsa-action label.wsa-action-field{display:flex;flex-direction:column;gap:4px}
.wsa-action-field-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.wsa-action-field-hint{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11.5px;line-height:1.4}
.wsa-action button.wsa-action-ai-btn{padding:2px 8px;font-size:11.5px;border-radius:5px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-brand-primary-new-colorprimary-new-color);border:1px solid var(--dsw-alias-border-l1)}
.wsa-action :is(input:not([type=checkbox]),textarea,select){border:1px solid var(--dsw-alias-border-l2);color:inherit;background:var(--dsw-alias-bg-base);border-radius:6px;padding:6px 8px;min-width:0;font:inherit}
.wsa-action textarea{resize:vertical;min-height:62px}.wsa-action fieldset{padding:0;border:0;min-width:0;margin:0}.wsa-action fieldset label{display:inline-flex;align-items:center;gap:3px;margin:5px 10px 0 0}
.wsa-action-note{margin:9px 0 0;color:var(--dsw-alias-label-secondary)}.wsa-action-footer{border-top:1px solid var(--dsw-alias-border-l1)}
.wsa-action-buttons{display:flex;align-items:center;gap:7px;margin-left:auto;flex-wrap:wrap}
.wsa-action button{background:var(--dsw-alias-bg-base);color:inherit;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:6px 11px;font:inherit;cursor:pointer}
.wsa-action button[data-primary=true]{background:var(--dsw-alias-brand-primary-new-colorprimary-new-color);border-color:transparent;color:var(--dsw-static-neutral-bluish-00)}
.wsa-action button:disabled{opacity:.5;cursor:default}.wsa-action :is(button,input,textarea,select):focus-visible{outline:2px solid var(--dsw-alias-brand-primary-new-colorprimary-new-color);outline-offset:2px}
.wsa-action-batch{margin:12px 0 4px;max-width:690px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font-size:12.5px}
.wsa-action-batch-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary)}
.wsa-action-batch-meta strong{color:var(--dsw-alias-label-primary);font-weight:500}
.wsa-action-batch button{background:var(--dsw-alias-bg-base);color:inherit;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:5px 10px;font:inherit;cursor:pointer}
.wsa-action-batch button[data-primary=true]{background:var(--dsw-alias-brand-primary-new-colorprimary-new-color);border-color:transparent;color:var(--dsw-static-neutral-bluish-00)}
.wsa-action-batch button:disabled{opacity:.5;cursor:default}
@container (max-width:470px){.wsa-action-grid{grid-template-columns:minmax(0,1fr)}}
`;
const STATUS: Record<Proposal['status'], string> = { needs_input:'待补充', ready:'待确认', unavailable:'待提交', submitting:'正在创建',
  unknown:'待核实', succeeded:'已创建', dismissed:'未创建', expired:'草稿已过期' };
type Slot = { turn: { turn: number; end?: { seq: number }; status: string }; sessionId: string };
const copy = (value: Candidate) => structuredClone(value);

function date(iso: string, zone: string) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: zone, dateStyle:'medium', timeStyle:'short', hour12:false }).format(new Date(iso));
}
function frequency(value: Extract<Candidate, { actionId: typeof SCHEDULE }>) {
  const schedule = value.params.schedule;
  if (!schedule?.kind) return schedule?.time;
  return (schedule.kind === 'weekly' ? '每周 ' + (schedule.weekdays ?? []).map(n => week[n-1]).join('、') : '每天') + ' ' + (schedule.time ?? '');
}

type ClaimTarget = 'ALL' | ReadonlySet<string>;
const embeddedProposalClaims = new Map<string, Map<symbol, ClaimTarget>>();
const embeddedClaimListeners = new Set<() => void>();
let embeddedClaimVersion = 0;

function notifyEmbeddedClaims() {
  embeddedClaimVersion++;
  for (const fn of embeddedClaimListeners) fn();
}

export function claimEmbeddedProposals(
  sessionId: string,
  turn: number,
  target: 'ALL' | readonly string[],
): () => void {
  const key = `${sessionId}:${turn}`;
  const token = Symbol('genui-proposal-claim');
  const normalized: ClaimTarget = target === 'ALL' ? 'ALL' : new Set(target);
  let bucket = embeddedProposalClaims.get(key);
  if (!bucket) {
    bucket = new Map();
    embeddedProposalClaims.set(key, bucket);
  }
  bucket.set(token, normalized);
  notifyEmbeddedClaims();
  return () => {
    const current = embeddedProposalClaims.get(key);
    if (!current) return;
    current.delete(token);
    if (current.size === 0) embeddedProposalClaims.delete(key);
    notifyEmbeddedClaims();
  };
}

function isProposalClaimedByGenui(sessionId: string, turn: number, proposalId: string): boolean {
  const bucket = embeddedProposalClaims.get(`${sessionId}:${turn}`);
  if (!bucket || bucket.size === 0) return false;
  for (const target of bucket.values()) {
    if (target === 'ALL' || target.has(proposalId)) return true;
  }
  return false;
}

export interface EmbeddedProposalEmbedProps {
  readonly sessionId: string;
  readonly turn: number;
  readonly title?: string;
  readonly description?: string;
  readonly proposalId?: string;
  readonly proposalIds?: readonly string[];
}

export function createActionCard(
  ctx: Context,
  inManager: (sessionId: string) => boolean,
  workspaceLabel: () => string,
  onConfirmed?: () => void,
) {
  let tokenPromise: ReturnType<typeof readChatHealth> | undefined;
  async function request(sessionId: string, body: Exclude<ActionRequest, { op: 'list' }>, signal?: AbortSignal): Promise<Proposal | null> {
    try {
      const { token } = await (tokenPromise ??= readChatHealth());
      if (!token) throw Error(`快捷操作授权已失效，请重新打开${getBotProfile().botName || DEFAULT_BOT_NAME}`);
      const response = await fetch('/api/workspace-superagent/actions', {
        method:'POST', credentials:'same-origin', cache:'no-store', signal,
        headers:{ 'content-type':'application/json', [CONTROL_TOKEN_HEADER]:token },
        body: JSON.stringify({ sessionId, request:body }),
      });
      if (response.status === 403) tokenPromise = undefined;
      const value = await response.json() as { ok?:boolean; error?:string; proposal?:Proposal | null };
      if (!response.ok || !value.ok) throw Error(value.error ?? '操作未完成，请重试');
      return value.proposal ?? null;
    } catch (error) {
      if (!signal?.aborted) tokenPromise = undefined;
      throw error;
    }
  }
  async function requestList(sessionId: string, turn: number, signal?: AbortSignal): Promise<Proposal[]> {
    try {
      const { token } = await (tokenPromise ??= readChatHealth());
      if (!token) throw Error(`快捷操作授权已失效，请重新打开${getBotProfile().botName || DEFAULT_BOT_NAME}`);
      const response = await fetch('/api/workspace-superagent/actions', {
        method:'POST', credentials:'same-origin', cache:'no-store', signal,
        headers:{ 'content-type':'application/json', [CONTROL_TOKEN_HEADER]:token },
        body: JSON.stringify({ sessionId, request:{ op:'list', turn } }),
      });
      if (response.status === 403) tokenPromise = undefined;
      const value = await response.json() as { ok?:boolean; error?:string; proposal?:Proposal | null; proposals?:Proposal[] };
      if (!response.ok || !value.ok) throw Error(value.error ?? '操作未完成，请重试');
      if (Array.isArray(value.proposals)) return value.proposals;
      return value.proposal ? [value.proposal] : [];
    } catch (error) {
      if (!signal?.aborted) tokenPromise = undefined;
      throw error;
    }
  }
  async function requestByIds(sessionId: string, ids: readonly string[], signal?: AbortSignal): Promise<Proposal[]> {
    try {
      const { token } = await (tokenPromise ??= readChatHealth());
      if (!token) throw Error(`快捷操作授权已失效，请重新打开${getBotProfile().botName || DEFAULT_BOT_NAME}`);
      const response = await fetch('/api/workspace-superagent/actions', {
        method:'POST', credentials:'same-origin', cache:'no-store', signal,
        headers:{ 'content-type':'application/json', [CONTROL_TOKEN_HEADER]:token },
        body: JSON.stringify({ sessionId, request:{ op:'list', ids } }),
      });
      if (response.status === 403) tokenPromise = undefined;
      const value = await response.json() as { ok?:boolean; error?:string; proposal?:Proposal | null; proposals?:Proposal[] };
      if (!response.ok || !value.ok) throw Error(value.error ?? '操作未完成，请重试');
      if (Array.isArray(value.proposals)) return value.proposals;
      return value.proposal ? [value.proposal] : [];
    } catch (error) {
      if (!signal?.aborted) tokenPromise = undefined;
      throw error;
    }
  }
  async function open(value: Proposal) {
    const id = value.resultId;
    if (!id) throw Error('没有可打开的结果');
    if (value.candidate.actionId === BOARD) {
      const board = ctx.get('taskBoard') as { openTaskFromHost?(id: string): Promise<boolean> } | undefined;
      if (!await board?.openTaskFromHost?.(id)) throw Error('当前看板无法打开这张卡片，请到任务看板核对');
    } else {
      const nav = ctx.get('scheduleNavigation') as { openTask(id: string): boolean } | undefined;
      if (!nav?.openTask(id)) throw Error('当前定时任务详情不可用，请到定时任务管理页核对');
    }
  }
  function ProposalCard({ card, turn, sessionId, total, batchBusy, onChange }: {
    card: Proposal; turn: number; sessionId: string; total: number; batchBusy: boolean; onChange(next: Proposal | null): void;
  }) {
    const [edit,setEdit] = React.useState<Candidate | null>(null);
    const [busy,setBusy] = React.useState(false);
    const [parsingPrompt,setParsingPrompt] = React.useState(false);
    const [error,setError] = React.useState('');
    const [inspect,setInspect] = React.useState(false);
    React.useEffect(() => {
      if (card.status === 'succeeded' || card.status === 'dismissed') setEdit(null);
    },[card.status,card.revision]);
    const confirmation = React.useRef<HTMLButtonElement>(null);
    const resultButton = React.useRef<HTMLButtonElement>(null);
    const focus = React.useRef<'confirm' | 'result' | undefined>(undefined);
    React.useEffect(() => {
      if (focus.current === 'confirm' && confirmation.current) { confirmation.current.focus(); focus.current=undefined; }
      if (focus.current === 'result' && resultButton.current) { resultButton.current.focus(); focus.current=undefined; }
    },[card,edit]);
    const shown = edit ?? card.candidate, isSchedule = shown.actionId === SCHEDULE;
    const template = templates[shown.actionId], kind = template.kind;
    const target = workspaceLabel();
    const projectOptions = (card.projects?.length ? card.projects : [{ id: (shown.actionId === BOARD ? shown.params.projectId : '') || '', label: target || '当前项目' }])
      .map(item => ({ value: item.id, label: item.label }));
    const selectedProjectLabel = !isSchedule
      ? (projectOptions.find(item => item.value === shown.params.projectId)?.label ?? target)
      : '';
    const state = card.status;
    const baseTitle = kind + (state === 'unknown' ? '创建结果' : '草稿');
    const title = state === 'succeeded'
      ? (card.candidate.params.title || baseTitle)
      : (total > 1 && shown.params.title ? `${baseTitle} · ${shown.params.title}` : baseTitle);
    const draftForm = state === 'needs_input' || state === 'unavailable';
    const boardEditable = !isSchedule && !inspect && (state === 'needs_input' || state === 'ready' || state === 'unavailable');
    const form = boardEditable || draftForm || (state === 'ready' && edit !== null);
    const work = async (
      op: 'save' | 'confirm' | 'dismiss' | 'reconcile' | 'open' | 'delegate',
      options?: { delegateNow?: boolean },
    ) => {
      if (busy || batchBusy || parsingPrompt) return;
      setBusy(true); setError('');
      try {
        const base = { id:card.id, revision:card.revision };
        const body: Exclude<ActionRequest, { op: 'list' }> = op === 'save'
          ? { ...base, op, proposal:shown }
          : op === 'confirm'
            ? {
                ...base,
                op,
                expectedNextRunAt: card.nextRunAt,
                ...(!isSchedule && edit !== null ? { proposal:shown } : {}),
                ...(options?.delegateNow ? { delegateNow: true } : {}),
              }
            : { ...base, op };
        const next = await request(sessionId,body);
        if (!next) throw Error('草稿已失效，请重新发起');
        if (next.turn !== turn) { onChange(null); return; }
        if (op === 'open') await open(next);
        if (op === 'save') { setEdit(null); if (next.status === 'ready') focus.current='confirm'; }
        if (op === 'confirm') {
          setEdit(null);
          if (next.status === 'ready') setError('请核对最新草稿，再点击创建');
        }
        if (op === 'confirm' || op === 'reconcile' || op === 'delegate') {
          setInspect(false);
          if (next.status === 'succeeded') {
            focus.current='result';
            onConfirmed?.();
          }
          if (op === 'reconcile' && next.status === 'unknown') setError('暂未查到确定结果，可到管理页核对');
        }
        onChange(next);
      } catch (cause) {
        if (op === 'confirm') setInspect(true);
        if (op === 'open' || op === 'delegate') onConfirmed?.();
        setError(op === 'confirm' ? '未收到确认，请先核实结果' : cause instanceof Error ? cause.message : '操作未完成，请重试');
      } finally { setBusy(false); }
    };
    const handleParsePrompt = async () => {
      if (busy || batchBusy || parsingPrompt || shown.actionId !== BOARD) return;
      const promptRaw = shown.params.prompt?.trim() ?? '';
      const titleRaw = shown.params.title?.trim() ?? '';
      const descRaw = shown.params.description?.trim() ?? '';
      const sourceText = promptRaw
        ? [
            titleRaw && !promptRaw.includes(titleRaw) ? `任务标题：${titleRaw}` : '',
            descRaw && !promptRaw.includes(descRaw) ? `任务描述：${descRaw}` : '',
            promptRaw,
          ].filter(Boolean).join('\n')
        : [titleRaw, descRaw].filter(Boolean).join('\n');
      if (!sourceText) {
        setError('请先在执行提示词或卡片标题中输入简单描述，再点击 AI 解析');
        return;
      }
      setParsingPrompt(true);
      setError('');
      try {
        const next = await request(sessionId, {
          op: 'parse_prompt',
          id: card.id,
          revision: card.revision,
          text: sourceText,
          proposal: shown,
        });
        if (!next) throw Error('草稿已失效，请重新发起');
        if (next.turn !== turn) { onChange(null); return; }
        setEdit(null);
        onChange(next);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'AI 解析未完成，请稍后重试');
      } finally {
        setParsingPrompt(false);
      }
    };
    const setText = (key: string, value: string) => {
      if (shown.actionId === BOARD) {
        if (key === 'column') {
          if (value === 'backlog') {
            const { targetDate: _omit, ...rest } = shown.params;
            setEdit({ ...shown, params: { ...rest, column: 'backlog' } });
            return;
          }
          setEdit({
            ...shown,
            params: {
              ...shown.params,
              column: 'todo',
              targetDate: shown.params.targetDate || currentLocalDate(),
            },
          });
          return;
        }
        if (key === 'targetDate') {
          const trimmed = value.trim();
          if (!trimmed) {
            const { targetDate: _omit, ...rest } = shown.params;
            setEdit({ ...shown, params: rest });
            return;
          }
          setEdit({
            ...shown,
            params: {
              ...shown.params,
              column: 'todo',
              targetDate: trimmed,
            },
          });
          return;
        }
        if (key === 'permission' || key === 'mode') {
          const trimmed = value.trim();
          if (!trimmed) {
            const { [key]: _omit, ...rest } = shown.params;
            setEdit({ ...shown, params: rest });
            return;
          }
          setEdit({
            ...shown,
            params: {
              ...shown.params,
              [key]: trimmed,
            },
          } as Candidate);
          return;
        }
      }
      setEdit({ ...shown, params:{ ...shown.params,[key]:value } } as Candidate);
    };
    const setSchedule = (patch: Record<string,unknown>) => {
      if (shown.actionId !== SCHEDULE) return;
      setEdit({ ...shown,params:{ ...shown.params,schedule:{ ...shown.params.schedule,...patch } } });
    };
    const need = missingFields(shown);
    const fact = (label:string,value:string | undefined,wide=false) => <div className={wide ? 'wsa-action-wide' : undefined}><dt>{label}</dt><dd>{value || '—'}</dd></div>;
    const updating = busy || batchBusy || parsingPrompt || state === 'submitting';
    const schedule = shown.actionId === SCHEDULE ? shown.params.schedule : undefined;
    const values = { ...shown.params, ...schedule };
    const statusLabel = updating && state !== 'succeeded'
      ? (parsingPrompt ? '正在解析' : '正在处理')
      : inspect
        ? '待核实'
        : state === 'succeeded' && card.delegation?.state === 'accepted'
          ? '已委派执行'
          : STATUS[state];
    return <section className="wsa-action" aria-label={kind + '快捷操作'} data-action-status={state}>
      <style>{css}</style>
      <div className="wsa-action-header"><div><h3>{title}</h3><small>{template.area}{selectedProjectLabel && ' · ' + selectedProjectLabel}</small></div>
        <span role="status" className="wsa-action-state" data-state={state}>{statusLabel}</span></div>
      {state !== 'dismissed' && state !== 'expired' && <div className="wsa-action-body">
        {form ? <div className="wsa-action-grid">{template.fields.map(field => {
          const { key, label, control, wide, maxLength, placeholder, options } = field;
          if (control === 'weekdays') {
            if (schedule?.kind !== 'weekly') return null;
            const days = schedule.weekdays ?? [];
            return <fieldset key={key} className="wsa-action-wide"><legend>{label}</legend>{week.map((day,index) => {
              const n = index + 1;
              return <label key={day}><input type="checkbox" checked={days.includes(n)} disabled={updating} onChange={e => {
                const chosen = e.target.checked ? [...days,n] : days.filter(d => d !== n);
                setSchedule({ weekdays:chosen.length ? chosen : undefined });
              }} />{day}</label>;
            })}</fieldset>;
          }
          const value = values[key as keyof typeof values];
          const selectOptions = key === 'projectId' ? projectOptions : options;
          const change = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
            const next = e.target.value;
            if (key === 'kind') setSchedule({ kind:next || undefined, ...(next !== 'weekly' ? { weekdays:undefined } : {}) });
            else if (key === 'time' || key === 'timeZone') setSchedule({ [key]:next });
            else setText(key,next);
          };
          const props = { value:typeof value === 'string' ? value : '', disabled:updating, onChange:change, placeholder };
          const isPromptField = !isSchedule && key === 'prompt';
          const isTargetDateField = !isSchedule && key === 'targetDate';
          const isBacklog = shown.actionId === BOARD && shown.params.column === 'backlog';
          return <label key={key} className={'wsa-action-field' + (wide ? ' wsa-action-wide' : '')}>
            {isPromptField ? (
              <span className="wsa-action-field-head">
                <span>{label}</span>
                <button
                  type="button"
                  className="wsa-action-ai-btn"
                  disabled={updating}
                  onClick={e => {
                    e.preventDefault();
                    void handleParsePrompt();
                  }}
                >
                  {parsingPrompt ? '正在 AI 解析…' : '✨ AI 解析'}
                </button>
              </span>
            ) : label}
            {control === 'textarea' ? <textarea {...props} maxLength={maxLength} /> :
              control === 'select' ? <select {...props}>
                {key === 'kind' && <option value="">请选择</option>}
                {selectOptions?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select> : <input {...props} type={control} maxLength={maxLength} />}
            {isTargetDateField && (
              <span className="wsa-action-field-hint">
                {isBacklog
                  ? '待规划泳道不设置执行时间；若选择执行时间将自动切换为「待办」'
                  : '选择「待办」需设置执行时间（默认当前日期）；切换为「待规划」将不设置执行时间'}
              </span>
            )}
          </label>;
        })}</div> : <dl className="wsa-action-grid">
          {state !== 'succeeded' && fact(isSchedule ? '任务名称' : '卡片标题',shown.params.title)}
          {shown.actionId === SCHEDULE ? <>
            {fact('运行频率',frequency(shown))}
            {fact('时区',shown.params.schedule?.timeZone)}
            {fact('投递位置','大肥鱼主会话（当前对话）')}
            {fact('执行内容',shown.params.instruction,true)}
          </> : <>
            {fact('所属项目',selectedProjectLabel)}
            {fact('所在列',shown.params.column === 'backlog' ? '待规划' : '待办')}
            {fact('执行权限',shown.params.permission === 'workspace-write' ? '工作区读写 (workspace-write)' : shown.params.permission === 'read-only' ? '只读分析 (read-only)' : '默认（跟随看板配置）')}
            {fact('执行模式',shown.params.mode || '默认')}
            {fact('执行时间',shown.params.column === 'backlog' ? '未设置（待规划）' : (shown.params.targetDate || '未设置'),true)}
            {card.delegation?.state === 'accepted' && fact('派工状态','已委派看板 Worker 执行',true)}
            {fact('执行提示词 (Prompt)',shown.params.prompt || shown.params.description || shown.params.title,true)}
            {fact('任务描述',shown.params.description,true)}
          </>}
        </dl>}
        {isSchedule && !form && card.nextRunAt && shown.params.schedule?.timeZone && <p className="wsa-action-note">
          {state === 'succeeded' ? '创建时的下次运行：' : '预计下次运行：'}{date(card.nextRunAt,shown.params.schedule.timeZone)}
        </p>}
        {!isSchedule && card.delegation?.state === 'rejected' && <p className="wsa-action-note" role="alert">
          卡片已创建，但立即委派未启动：{card.delegation.reason || '看板拒绝了本次派工'}
        </p>}
        {!isSchedule && card.delegation?.state === 'unknown' && <p className="wsa-action-note" role="status">
          卡片已创建，委派状态待核实（可在右侧「近期活动」查看）。
        </p>}
        {card.submissionIssue && <p className="wsa-action-note" role="status">{card.submissionIssue === 'schedule_preview_failed'
          ? '无法预览下次运行。请检查运行时间、频率和时区。'
          : '创建入口暂不可用，你可以先填写并保存草稿。'}</p>}
        {(state === 'unknown' || inspect) && <p className="wsa-action-note" role="status">这次提交可能已经生效，核实前请勿重复创建。</p>}
        {error && <p className="wsa-action-note" role="alert">{error}</p>}
      </div>}
      <div className="wsa-action-footer">
        <small>{form ? (need.length ? '待填写：'+need.map(k => template.fields.find(field => field.key === k)?.label).join('、') :
          card.submissionIssue === 'entry_unavailable' ? '' : (boardEditable ? '可仅加入看板，或直接委派 Worker 立即执行' : '预览后再确认创建')) :
          state === 'ready' && !inspect ? (isSchedule ? '按计划运行，不会立即执行' : '可仅加入看板，或直接委派 Worker 立即执行') : ''}</small>
        <div className="wsa-action-buttons">
          {boardEditable ? <>
            <button disabled={updating} onClick={() => void work('dismiss')}>暂不创建</button>
            {(edit !== null || card.submissionIssue === 'entry_unavailable') && <button disabled={updating || (!!need.length && card.submissionIssue !== 'entry_unavailable')} onClick={() => void work('save')}>
              {card.submissionIssue === 'entry_unavailable' && !edit ? '重新检查' : '保存草稿'}
            </button>}
            {card.submissionIssue !== 'entry_unavailable' && <>
              <button disabled={updating || !!need.length} onClick={() => void work('confirm')}>创建{kind}</button>
              <button ref={confirmation} data-primary="true" disabled={updating || !!need.length} onClick={() => void work('confirm', { delegateNow: true })}>立即委派执行</button>
            </>}
          </> : form && <>
            <button disabled={updating} onClick={() => draftForm ? void work('dismiss') : setEdit(null)}>{draftForm ? '暂不创建' : '返回'}</button>
            <button data-primary="true" disabled={updating || (!!need.length && card.submissionIssue !== 'entry_unavailable')} onClick={() => void work('save')}>
              {card.submissionIssue === 'entry_unavailable' ? (edit ? '保存草稿' : '重新检查') : '预览' + kind}
            </button>
          </>}
          {!form && state === 'ready' && !inspect && <>
            <button disabled={updating} onClick={() => { setEdit(copy(shown)); setError(''); }}>修改</button>
            <button ref={isSchedule ? confirmation : undefined} data-primary={isSchedule ? 'true' : undefined} disabled={updating} onClick={() => void work('confirm')}>创建{kind}</button>
            {!isSchedule && <button ref={confirmation} data-primary="true" disabled={updating} onClick={() => void work('confirm', { delegateNow: true })}>立即委派执行</button>}
          </>}
          {(state === 'unknown' || inspect) && <button data-primary="true" disabled={updating} onClick={() => void work('reconcile')}>核实结果</button>}
          {state === 'succeeded' && <>
            {!isSchedule && card.delegation?.state !== 'accepted' && <button disabled={updating} onClick={() => void work('delegate')}>立即委派执行</button>}
            <button ref={resultButton} data-primary="true" disabled={updating} onClick={() => void work('open')}>查看{kind}</button>
          </>}
        </div>
      </div>
    </section>;
  }
  function renderProposalList(
    proposals: Proposal[],
    setProposals: React.Dispatch<React.SetStateAction<Proposal[]>>,
    turn: number,
    sessionId: string,
    batchBusy: boolean,
    setBatchBusy: React.Dispatch<React.SetStateAction<boolean>>,
    batchError: string,
    setBatchError: React.Dispatch<React.SetStateAction<string>>,
  ) {
    const readyList = proposals.filter(item => item.status === 'ready');
    const succeededCount = proposals.filter(item => item.status === 'succeeded').length;
    const confirmAll = async () => {
      if (batchBusy || readyList.length < 2) return;
      setBatchBusy(true); setBatchError('');
      try {
        for (const item of readyList) {
          const next = await request(sessionId, {
            op: 'confirm',
            id: item.id,
            revision: item.revision,
            expectedNextRunAt: item.nextRunAt,
          });
          if (next) {
            setProposals(current => next.turn !== turn
              ? current.filter(entry => entry.id !== item.id)
              : current.map(entry => entry.id === item.id ? next : entry));
            if (next.status === 'succeeded') onConfirmed?.();
          }
        }
      } catch (cause) {
        setBatchError(cause instanceof Error ? cause.message : '批量创建未全部完成，请逐张核对');
      } finally {
        setBatchBusy(false);
      }
    };
    return <>
      {proposals.length > 1 && <div className="wsa-action-batch" role="region" aria-label="批量快捷操作汇总">
        <div className="wsa-action-batch-meta">
          <strong>共 {proposals.length} 张创建卡片</strong>
          <span>{succeededCount > 0 ? `已创建 ${succeededCount} 张` : ''}{succeededCount > 0 && readyList.length > 0 ? ' · ' : ''}{readyList.length > 0 ? `待确认 ${readyList.length} 张` : ''}</span>
          {batchError && <span role="alert">{batchError}</span>}
        </div>
        {readyList.length >= 2 && <div className="wsa-action-buttons">
          <button type="button" data-primary="true" disabled={batchBusy} onClick={() => void confirmAll()}>
            {batchBusy ? '正在批量创建…' : `全部创建 (${readyList.length})`}
          </button>
        </div>}
      </div>}
      {proposals.map(item => <ProposalCard key={item.id} card={item} turn={turn} sessionId={sessionId} total={proposals.length} batchBusy={batchBusy} onChange={next => {
        setProposals(current => next === null ? current.filter(entry => entry.id !== item.id) : current.map(entry => entry.id === item.id ? next : entry));
      }} />)}
    </>;
  }
  function EmbeddedProposalSection({ sessionId, turn, title, description, proposalId, proposalIds }: EmbeddedProposalEmbedProps) {
    const [proposals, setProposals] = React.useState<Proposal[]>([]);
    const [batchBusy, setBatchBusy] = React.useState(false);
    const [batchError, setBatchError] = React.useState('');
    const explicitIds = React.useMemo(() => {
      const list: string[] = [];
      if (typeof proposalId === 'string' && /^[0-9a-f-]{36}$/i.test(proposalId.trim())) list.push(proposalId.trim());
      if (Array.isArray(proposalIds)) {
        for (const id of proposalIds) {
          if (typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id.trim()) && !list.includes(id.trim())) {
            list.push(id.trim());
          }
        }
      }
      return list;
    }, [proposalId, proposalIds]);
    const explicitKey = explicitIds.join(',');

    React.useEffect(() => {
      if (!sessionId || turn < 0) return;
      return claimEmbeddedProposals(sessionId, turn, explicitIds.length > 0 ? explicitIds : 'ALL');
    }, [sessionId, turn, explicitKey]);

    React.useEffect(() => {
      if (!sessionId || turn < 0) return;
      const controller = new AbortController();
      const promise = explicitIds.length > 0
        ? requestByIds(sessionId, explicitIds, controller.signal)
        : requestList(sessionId, turn, controller.signal);
      void promise
        .then(value => {
          if (!controller.signal.aborted) setProposals(value);
        })
        .catch(() => {});
      return () => controller.abort();
    }, [sessionId, turn, explicitKey]);

    if (!proposals.length) return null;
    return (
      <div className="wsa-genui-proposal-embed" data-genui-proposal-embed="">
        {(title || description) && (
          <div style={{ marginBottom: '6px' }}>
            {title && <div style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>{title}</div>}
            {description && <div style={{ fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary)', marginTop: '2px' }}>{description}</div>}
          </div>
        )}
        {renderProposalList(proposals, setProposals, turn, sessionId, batchBusy, setBatchBusy, batchError, setBatchError)}
      </div>
    );
  }
  function Card({ turn, sessionId }: Slot) {
    const [proposals,setProposals] = React.useState<Proposal[]>([]);
    const [batchBusy,setBatchBusy] = React.useState(false);
    const [batchError,setBatchError] = React.useState('');
    React.useSyncExternalStore(
      listener => { embeddedClaimListeners.add(listener); return () => embeddedClaimListeners.delete(listener); },
      () => embeddedClaimVersion,
      () => embeddedClaimVersion,
    );
    const enabled = inManager(sessionId) && turn.status === 'closed';
    React.useEffect(() => {
      if (!enabled) return;
      const controller = new AbortController();
      void requestList(sessionId,turn.turn,controller.signal).then(value => {
        if (!controller.signal.aborted) setProposals(value);
      }).catch(cause => { if (!controller.signal.aborted) console.warn('大肥鱼快捷操作读取失败',cause); });
      return () => controller.abort();
    },[enabled,sessionId,turn.turn,turn.end?.seq]);
    const visibleProposals = proposals.filter(item => !isProposalClaimedByGenui(sessionId, turn.turn, item.id));
    if (!enabled || !visibleProposals.length) return null;
    return renderProposalList(visibleProposals, setProposals, turn.turn, sessionId, batchBusy, setBatchBusy, batchError, setBatchError);
  }
  return Object.assign(Card, { EmbeddedProposalSection });
}
