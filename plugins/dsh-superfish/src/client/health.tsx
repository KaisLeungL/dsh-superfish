import * as React from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type { HealthView } from '../app/health/view.js';
import { DEFAULT_BOT_NAME } from '../app/health/chat-input.js';
import { CONTROL_TOKEN_HEADER } from '../status.js';
import { useBotProfile } from './bot-profile.js';
import { Icon, type IconName } from './icons.js';

export type HealthTabId = 'queues' | 'dependencies' | 'capacity' | 'audit';

const copy = {
  title: '主理运行状态', description: '查看持久状态、依赖与运行限额。暂停或停止自动化后，原卡与会话仍保留。',
  back: '返回大肥鱼会话',
  loading: '正在读取宿主健康状态…', unreachable: '未能读取宿主状态，请刷新重试。',
  stale: '旧样本，宿主状态未确认', staleSampled: '旧样本采样时间',
  refresh: '刷新状态', controlMenu: '自动化控制',
  pause: '暂停自动化', resume: '恢复自动化', stop: '停止自动化',
  pauseDesc: '冻结后台候选队列与倒计时，保留日常对话与待办',
  resumeDesc: '重新开启后台自动队列消费与内部计算任务',
  stopDesc: '终止后台自动队列，撤销未决副作用并取消计算任务',
  pending: '正在处理控制请求…', success: '宿主已处理请求，以下为重新读取的实际状态。',
  failure: '控制未完成，请以刷新后的持久状态为准。', sampled: '采样时间',
  tabQueues: '队列与计算', tabDeps: '依赖与上下文', tabCapacity: '容量与存储', tabAudit: '审计与边界',
  queues: '候选队列', normal: '普通队列', control: '控制队列', evals: 'Eval 状态与时限',
  jobs: '内部计算 Job', capacity: '容量观测', audit: '请求审计', dependencies: '宿主依赖',
  contextSources: '上下文来源', sourceRegistered: '已注册', sourceUnavailable: '当前不可用',
  native: '原生卡执行', unavailable: '未提供', empty: '当前没有持久运行项。',
  columnName: '项目', columnValue: '当前值', columnState: '状态', columnDeadline: '期限',
  db: 'SQLite 主文件', wal: 'WAL 文件', artifacts: '未墓碑工件索引', disk: '磁盘可用量',
  artifactNote: '工件值来自索引，未作为磁盘实占。容量文件观测与数据库摘要分开采样。',
  scoped: '已核有限范围', reconcile: '待对账', reconcileNow: '立即对账', gate: '完整 E37 仍需独立验收',
  available: '可用', missing: '缺失或旧能力', replaced: '已换代，等待人工恢复',
  paused: '已暂停', running: '运行中', stopped: '已停止', unknown: '未知',
  effects: '未知效果', active: '占用名额', handle: '自有计时器', notDelivered: '尚无已验证投递回执',
  original: '基础入口', summaryMissing: '运行时不可用，保留基础入口。', close: '处理结束',
} as const;
type Key = keyof typeof copy;
declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'workspace-superagent-health': Key } }
const css = `
.wsa-health-viewport{height:100%;min-height:0;min-width:0;width:100%;overflow:auto;background:var(--dsw-alias-bg-base)}
.wsa-health{--wsa-ease:cubic-bezier(.23,1,.32,1);--wsa-brand:var(--dsw-alias-brand-primary-new-colorprimary-new-color,#3b5bf6);box-sizing:border-box;padding:24px 28px 40px;max-width:1100px;margin:0 auto;color:var(--dsw-alias-label-primary);font:inherit;-webkit-font-smoothing:antialiased}
.wsa-health *{box-sizing:border-box}
.wsa-health h1{font-size:20px;line-height:1.35;margin:0;font-weight:650;letter-spacing:-.01em}
.wsa-health h2{font-size:14px;line-height:1.4;margin:0;font-weight:600}
.wsa-health p{margin:0;line-height:1.65;overflow-wrap:anywhere}
.wsa-health-muted{color:var(--dsw-alias-label-secondary);font-size:12.5px}
.wsa-health-hero{display:flex;flex-direction:column;gap:14px;padding:18px 20px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:color-mix(in srgb, var(--dsw-alias-label-primary) 3.5%, var(--dsw-alias-bg-base))}
.wsa-health-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.wsa-health-title-group{display:flex;flex-direction:column;gap:6px;min-width:0}
.wsa-health-title-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.wsa-health-meta{display:flex;flex-direction:column;align-items:flex-end;gap:4px;font-variant-numeric:tabular-nums}
.wsa-health-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1)}
.wsa-health-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wsa-health button{display:inline-flex;align-items:center;justify-content:center;gap:6px;font:inherit;font-size:12.5px;font-weight:500;padding:0 12px;min-height:32px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);cursor:pointer;transition:background-color 140ms var(--wsa-ease),border-color 140ms var(--wsa-ease),transform 120ms var(--wsa-ease),box-shadow 140ms var(--wsa-ease)}
.wsa-health button:hover:enabled{background:var(--dsw-alias-bg-hover);border-color:var(--dsw-alias-border-l2)}
.wsa-health button:active:enabled{transform:scale(.97)}
.wsa-health button:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}
.wsa-health button:disabled{opacity:.48;cursor:default}
.wsa-health-btn-back{background:var(--dsw-alias-label-primary)!important;color:var(--dsw-alias-label-primary-foreground)!important;border-color:var(--dsw-alias-label-primary)!important;font-weight:550!important}
.wsa-health-btn-back:hover:enabled{opacity:.88}
.wsa-health-status{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:3px 10px;font-size:12px;font-weight:550;background:var(--dsw-alias-bg-base)}
.wsa-health-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-caption);flex:none}
.wsa-health-dot[data-tone="running"],.wsa-health-pill[data-tone="ok"] .wsa-health-dot{background:var(--dsw-alias-state-success-primary)}
.wsa-health-dot[data-tone="paused"],.wsa-health-pill[data-tone="warn"] .wsa-health-dot{background:var(--dsw-alias-state-warn-primary)}
.wsa-health-dot[data-tone="stopped"],.wsa-health-pill[data-tone="error"] .wsa-health-dot{background:var(--dsw-alias-state-error-primary)}
.wsa-health-banner{display:flex;flex-direction:column;gap:3px;padding:10px 12px;border-radius:9px;background:color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent);font-size:12.5px}
.wsa-health-message{font-weight:500;color:var(--dsw-alias-label-primary)}
.wsa-health-hint{font-size:12px;color:var(--dsw-alias-label-secondary)}

/* 自动化控制 Pop Menu */
.wsa-health-menu-wrap{position:relative;display:inline-flex}
.wsa-health-menu-trigger[aria-expanded="true"]{background:var(--dsw-alias-bg-hover);border-color:var(--dsw-alias-border-l2)}
.wsa-health-menu-caret{color:var(--dsw-alias-label-tertiary);transition:transform 150ms var(--wsa-ease)}
.wsa-health-menu-trigger[aria-expanded="true"] .wsa-health-menu-caret{transform:rotate(180deg)}
.wsa-health-popmenu{position:absolute;top:calc(100% + 6px);right:0;z-index:40;width:276px;padding:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-base);box-shadow:0 12px 28px -6px rgb(0 0 0 / .18),0 4px 10px -3px rgb(0 0 0 / .1);display:flex;flex-direction:column;gap:2px}
.wsa-health-popmenu-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px 8px;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 75%,transparent);margin-bottom:2px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.wsa-health-popmenu-divider{height:1px;margin:3px 6px;background:color-mix(in srgb,var(--dsw-alias-border-l1) 75%,transparent)}
.wsa-health button.wsa-health-popmenu-item{width:100%;min-height:auto;padding:8px 10px;border:0;border-radius:8px;background:transparent;display:flex;flex-direction:column;align-items:flex-start;justify-content:flex-start;gap:2px;text-align:left}
.wsa-health button.wsa-health-popmenu-item:hover:enabled{background:color-mix(in srgb,var(--dsw-alias-label-primary) 5.5%,transparent)}
.wsa-health button.wsa-health-popmenu-item[data-danger="true"]:not(:disabled) .wsa-health-popmenu-item-title{color:var(--dsw-alias-state-error-primary)}
.wsa-health button.wsa-health-popmenu-item[data-danger="true"]:hover:enabled{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
.wsa-health-popmenu-item-row{display:flex;align-items:center;justify-content:space-between;width:100%;gap:8px}
.wsa-health-popmenu-item-title{font-size:12.5px;font-weight:550;color:var(--dsw-alias-label-primary);line-height:1.35}
.wsa-health-popmenu-item-desc{font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary);line-height:1.45}

/* KPI 概览卡 */
.wsa-health-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-top:14px}
.wsa-health button.wsa-health-kpi{display:flex;flex-direction:column;align-items:flex-start;justify-content:flex-start;gap:4px;padding:12px 14px;min-height:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:color-mix(in srgb, var(--dsw-alias-label-primary) 2.5%, var(--dsw-alias-bg-base));font-variant-numeric:tabular-nums;text-align:left;width:100%}
.wsa-health button.wsa-health-kpi:hover:enabled{background:color-mix(in srgb, var(--dsw-alias-label-primary) 4.5%, var(--dsw-alias-bg-base));border-color:var(--dsw-alias-border-l2)}
.wsa-health button.wsa-health-kpi[data-active="true"]{border-color:color-mix(in srgb,var(--wsa-brand) 45%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--wsa-brand) 4.5%,var(--dsw-alias-bg-base))}
.wsa-health-kpi-label{font-size:11.5px;color:var(--dsw-alias-label-secondary);font-weight:500}
.wsa-health-kpi-value{font-size:15px;font-weight:650;line-height:1.3;color:var(--dsw-alias-label-primary)}
.wsa-health-kpi-sub{font-size:11.5px;color:var(--dsw-alias-label-tertiary);font-weight:400}

/* 分栏 Tab 导航栏 */
.wsa-health-tabs-bar{margin-top:16px}
.wsa-health-tabs{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));align-items:center;padding:3px;border-radius:11px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent);background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,var(--dsw-alias-bg-base));gap:2px}
.wsa-health button.wsa-health-tab{position:relative;min-height:34px;padding:0 10px;border-radius:8px;border:1px solid transparent;background:transparent;font-size:12.5px;font-weight:500;color:var(--dsw-alias-label-secondary);justify-content:center;gap:6px;white-space:nowrap}
.wsa-health button.wsa-health-tab:hover:enabled{color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,transparent)}
.wsa-health button.wsa-health-tab[aria-selected="true"]{background:var(--dsw-alias-bg-base);border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 1px 4px rgb(0 0 0 / .1),0 1px 2px rgb(0 0 0 / .05)}
.wsa-health button.wsa-health-tab[aria-selected="true"] .wsa-health-tab-icon{color:var(--wsa-brand)}
.wsa-health-tab-badge{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 6px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;line-height:1}
.wsa-health button.wsa-health-tab[aria-selected="true"] .wsa-health-tab-badge{background:color-mix(in srgb,var(--wsa-brand) 14%,transparent);color:var(--wsa-brand)}
.wsa-health-tab-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-warn-primary,#f59e0b)}

.wsa-health-tabpanel{margin-top:14px}
.wsa-health-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-items:start}
.wsa-health-stack{display:flex;flex-direction:column;gap:14px;min-width:0}
.wsa-health-section{padding:16px 18px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:color-mix(in srgb, var(--dsw-alias-label-primary) 2.5%, var(--dsw-alias-bg-base));min-width:0}
.wsa-health-section-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}
.wsa-health-subsection{margin-top:14px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1)}
.wsa-health-scroll{overflow:auto}
.wsa-health table{border-collapse:collapse;width:100%;font-size:12.5px;font-variant-numeric:tabular-nums}
.wsa-health th,.wsa-health td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--dsw-alias-border-l1);line-height:1.5;overflow-wrap:anywhere}
.wsa-health th{font-weight:500;color:var(--dsw-alias-label-secondary)}
.wsa-health dl{margin:0;font-size:12.5px;font-variant-numeric:tabular-nums}
.wsa-health dl>div{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:7px 0;border-bottom:1px solid color-mix(in srgb, var(--dsw-alias-border-l1) 70%, transparent)}
.wsa-health dl>div:last-child{border-bottom:0;padding-bottom:2px}
.wsa-health dt{color:var(--dsw-alias-label-secondary)}
.wsa-health dd{margin:0;text-align:right;font-weight:500;overflow-wrap:anywhere}
.wsa-health-pill{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:500}
.wsa-health-job-stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:8px 0 10px;font-variant-numeric:tabular-nums}
.wsa-health-job-stat{display:flex;justify-content:space-between;gap:8px;padding:7px 10px;border-radius:8px;background:color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent);font-size:12px}
.wsa-health-job-stat span:first-child{color:var(--dsw-alias-label-secondary)}
.wsa-health-job-stat strong{font-weight:600}
.wsa-health-empty-box{padding:10px 12px;border-radius:8px;background:color-mix(in srgb, var(--dsw-alias-label-primary) 3.5%, transparent);color:var(--dsw-alias-label-secondary);font-size:12.5px}
.wsa-health-footnote{margin-top:8px;font-size:11.5px;color:var(--dsw-alias-label-tertiary);line-height:1.55}
.wsa-health ul{margin:0;padding-left:18px;line-height:1.7;font-size:12.5px;color:var(--dsw-alias-state-error-primary)}
.wsa-health-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;overflow-wrap:anywhere}
@media(max-width:860px){.wsa-health-kpis,.wsa-health-tabs{grid-template-columns:repeat(2,minmax(0,1fr))}.wsa-health-grid{grid-template-columns:1fr}}
@media(max-width:600px){.wsa-health{padding:16px 14px 28px}.wsa-health-kpis,.wsa-health-tabs,.wsa-health-job-stats{grid-template-columns:1fr}.wsa-health-meta{align-items:flex-start}}
`;
const date = (value: number | null): string => value === null ? '未提供' : new Date(value).toLocaleString('zh-CN', { hour12: false });
const bytes = (value: number | null): string => value === null ? '未提供' : (value / (1024*1024)).toFixed(2) + ' MiB';
const states: Record<string,string> = { queued: '排队中', dispatching: '投递中，尚未核回执', delivered: '已验证投递', paused: '已暂停',
  retry_wait: '已证明可重试，等待', unavailable: '不可用，待核对', completed: '已完成', running: '计算中',
  failed: '失败', cancelled: '已取消', interrupted: '重启中断', unknown: '未知，待对账' };

export function createHealthPage(ctx: Context, Foundation: React.ComponentType): React.ComponentType<{ onBack?: () => void }> {
  ctx.effect(() => ctx.locale.register('workspace-superagent-health', { zh: copy, en: copy }));
  const t = ctx.locale.bind('workspace-superagent-health');
  return function HealthPage({ onBack }: { onBack?: () => void } = {}): React.ReactElement {
    const profile = useBotProfile();
    React.useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot());
    const [health, setHealth] = React.useState<HealthView | null>(null);
    const [current, setCurrent] = React.useState(false);
    const [busy, setBusy] = React.useState(false), [notice, setNotice] = React.useState('');
    const [activeTab, setActiveTab] = React.useState<HealthTabId>('queues');
    const [menuOpen, setMenuOpen] = React.useState(false);
    const menuRef = React.useRef<HTMLDivElement | null>(null);
    const abort = React.useRef<AbortController | null>(null);
    const controlToken = React.useRef<string | null>(null);
    const load = React.useCallback(async () => {
      abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
      setCurrent(false);
      try {
        const response = await fetch('/api/workspace-superagent/health', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw Error('HEALTH_UNAVAILABLE');
        const value = await response.json() as HealthView;
        if (value.version !== 'b04' || typeof value.available !== 'boolean' || !Number.isFinite(value.sampledAt)) throw Error('HEALTH_INVALID');
        if (!controller.signal.aborted) {
          controlToken.current = response.headers.get(CONTROL_TOKEN_HEADER);
          setHealth(value); setCurrent(true); setNotice(previous => previous === t('unreachable') ? '' : previous);
        }
      } catch { if (!controller.signal.aborted) { setCurrent(false); setNotice(t('unreachable')); } }
    }, []);
    React.useEffect(() => { void load(); return () => abort.current?.abort(); }, [load]);
    React.useEffect(() => {
      if (!menuOpen) return;
      const onPointerDown = (event: MouseEvent) => {
        if (menuRef.current && event.target instanceof Node && !menuRef.current.contains(event.target)) {
          setMenuOpen(false);
        }
      };
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') setMenuOpen(false);
      };
      document.addEventListener('mousedown', onPointerDown);
      document.addEventListener('keydown', onKeyDown);
      return () => {
        document.removeEventListener('mousedown', onPointerDown);
        document.removeEventListener('keydown', onKeyDown);
      };
    }, [menuOpen]);
    const control = async (action: 'pause' | 'resume' | 'stop' | 'reconcile') => {
      if (busy || !current || !health?.summary || !health.control.enabled) return;
      setMenuOpen(false);
      setBusy(true); setNotice(t('pending'));
      const controller = new AbortController(); abort.current?.abort(); abort.current = controller;
      try {
        const headers = new Headers({ 'content-type': 'application/json' });
        if (controlToken.current) headers.set(CONTROL_TOKEN_HEADER, controlToken.current);
        const response = await fetch('/api/workspace-superagent/control', { method: 'POST', credentials: 'same-origin',
          headers, signal: controller.signal,
          body: JSON.stringify({ action, revision: health.summary.manager.revision }) });
        const result = await response.json() as { ok?: boolean; health?: HealthView; error?: string };
        if (!response.ok || !result.ok || result.health?.version !== 'b04') throw Error(result.error ?? t('failure'));
        if (!controller.signal.aborted) { setHealth(result.health); setNotice(t('success')); }
      } catch (error) {
        if (!controller.signal.aborted) { setNotice(error instanceof Error ? error.message : t('failure')); await load(); }
      } finally { if (!controller.signal.aborted) setBusy(false); else setBusy(false); }
    };
    if (!health?.available || !health.summary) return <div className="wsa-health-viewport"><section className="wsa-health"><style>{css}</style>
      <div className="wsa-health-hero"><header className="wsa-health-header"><div className="wsa-health-title-group"><h1>{t('title')}</h1><p role="status" className="wsa-health-muted">{notice || health?.reason || t('loading')}</p></div></header>
        <div className="wsa-health-actions">{onBack && <button type="button" className="wsa-health-btn-back" onClick={onBack}><Icon name="back" size={14} />{t('back')}</button>}<button type="button" onClick={() => void load()}><Icon name="refresh" size={14} />{t('refresh')}</button></div></div></section>{(health || notice) && <Foundation />}</div>;
    const summary = health.summary, lifecycle = summary.manager.lifecycle;
    const stateLabel = lifecycle === 'running' ? t('running') : lifecycle === 'paused' ? t('paused') : lifecycle === 'stopped' ? t('stopped') : t('unknown');
    const tone = lifecycle === 'running' ? 'running' : lifecycle === 'paused' ? 'paused' : 'stopped';
    const Row = ({ name, value }: { name: React.ReactNode; value: React.ReactNode }) => <div><dt>{name}</dt><dd>{value}</dd></div>;
    const Pill = ({ label, kind }: { label: string; kind: 'ok' | 'warn' | 'error' }) =>
      <span className="wsa-health-pill" data-tone={kind}><span className="wsa-health-dot" aria-hidden="true" />{label}</span>;
    const availableDeps = health.dependencies.filter(d => d.available && !d.changed).length;
    const registeredSources = health.contextSources?.filter(s => s.available).length ?? 0;
    const totalSources = health.contextSources?.length ?? 0;
    const totalDbBytes = summary.capacity.dbBytes !== null && summary.capacity.walBytes !== null ? summary.capacity.dbBytes + summary.capacity.walBytes : summary.capacity.dbBytes;
    const activeQueueCount = summary.queues.normal.items + summary.queues.control.items + summary.evals.active.length + summary.jobs.occupied;
    const canPause = !busy && current && health.control.enabled && lifecycle === 'running';
    const canResume = !busy && current && health.control.enabled && lifecycle !== 'running' && !health.control.reason && health.capacityBlocks.length === 0;
    const canStop = !busy && current && health.control.enabled && lifecycle !== 'stopped';
    const canReconcile = !busy && current && health.control.enabled;
    const tabs: readonly { id: HealthTabId; label: string; icon: IconName; badge: string; warn: boolean }[] = [
      {
        id: 'queues',
        label: t('tabQueues'),
        icon: 'layers',
        badge: String(activeQueueCount),
        warn: summary.effects.unknown > 0 || summary.evals.truncated || summary.jobs.truncated,
      },
      {
        id: 'dependencies',
        label: t('tabDeps'),
        icon: 'cpu',
        badge: `${availableDeps}/${health.dependencies.length}`,
        warn: availableDeps < health.dependencies.length || registeredSources < totalSources,
      },
      {
        id: 'capacity',
        label: t('tabCapacity'),
        icon: 'board',
        badge: bytes(totalDbBytes),
        warn: health.capacityBlocks.length > 0 || !summary.diagnostics.healthy || summary.diagnostics.recoveryPending,
      },
      {
        id: 'audit',
        label: t('tabAudit'),
        icon: 'terminal',
        badge: summary.audit.status === 'verified_scope' && summary.audit.pending === 0 ? '已核' : `待核 ${summary.audit.pending}`,
        warn: summary.audit.pending > 0 || summary.audit.status !== 'verified_scope',
      },
    ];
    return <div className="wsa-health-viewport"><section className="wsa-health" data-workspace-superagent-health=""><style>{css}</style>
      <div className="wsa-health-hero">
        <header className="wsa-health-header">
          <div className="wsa-health-title-group">
            <div className="wsa-health-title-row"><h1>{t('title')}</h1></div>
            <p className="wsa-health-muted">{t('description')}</p>
          </div>
          <div className="wsa-health-meta">
            <span className="wsa-health-status"><span className="wsa-health-dot" data-tone={current ? tone : 'paused'} aria-hidden="true" />{current ? stateLabel : t('stale')}</span>
            <p className="wsa-health-muted">{t(current ? 'sampled' : 'staleSampled')}：{date(health.sampledAt)}</p>
          </div>
        </header>
        <div className="wsa-health-toolbar">
          <div className="wsa-health-actions">
            {onBack && <button type="button" className="wsa-health-btn-back" onClick={onBack}><Icon name="back" size={14} />{`返回${profile.botName || DEFAULT_BOT_NAME}会话`}</button>}
            <button type="button" disabled={busy} onClick={() => void load()}><Icon name="refresh" size={14} />{t('refresh')}</button>
          </div>
          <div className="wsa-health-menu-wrap" ref={menuRef}>
            <button
              type="button"
              className="wsa-health-menu-trigger"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              disabled={busy}
              onClick={() => setMenuOpen(open => !open)}
            >
              <Icon name="sliders" size={14} />
              <span>{t('controlMenu')}</span>
              <Icon name="chevron-down" size={13} className="wsa-health-menu-caret" />
            </button>
            {menuOpen && (
              <div className="wsa-health-popmenu" role="menu" aria-label={t('controlMenu')}>
                <div className="wsa-health-popmenu-head">
                  <span>后台自动化</span>
                  <Pill label={stateLabel} kind={lifecycle === 'running' ? 'ok' : lifecycle === 'paused' ? 'warn' : 'error'} />
                </div>
                <button
                  type="button"
                  role="menuitem"
                  className="wsa-health-popmenu-item"
                  disabled={!canPause}
                  onClick={() => void control('pause')}
                >
                  <span className="wsa-health-popmenu-item-row">
                    <span className="wsa-health-popmenu-item-title">{t('pause')}</span>
                  </span>
                  <span className="wsa-health-popmenu-item-desc">{t('pauseDesc')}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="wsa-health-popmenu-item"
                  disabled={!canResume}
                  onClick={() => void control('resume')}
                >
                  <span className="wsa-health-popmenu-item-row">
                    <span className="wsa-health-popmenu-item-title">{t('resume')}</span>
                  </span>
                  <span className="wsa-health-popmenu-item-desc">{t('resumeDesc')}</span>
                </button>
                <div className="wsa-health-popmenu-divider" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  className="wsa-health-popmenu-item"
                  data-danger="true"
                  disabled={!canStop}
                  onClick={() => void control('stop')}
                >
                  <span className="wsa-health-popmenu-item-row">
                    <span className="wsa-health-popmenu-item-title">{t('stop')}</span>
                  </span>
                  <span className="wsa-health-popmenu-item-desc">{t('stopDesc')}</span>
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="wsa-health-banner" role="status" aria-live="polite">
          <p className="wsa-health-message">{notice || health.reason || health.automation?.reason}</p>
          {lifecycle === 'running' && !health.reason && <p className="wsa-health-hint">说明：主理对话与后台自动化已随启动自动开启。</p>}
          {lifecycle === 'paused' && !health.reason && <p className="wsa-health-hint">说明：日常对话、个人待办、看板读取与定时任务均正常工作；当前后台自动队列处于暂停状态，可在右上角「自动化控制」菜单中点击「恢复自动化」开启。</p>}
        </div>
        {health.capacityBlocks.length > 0 && <ul role="alert">{health.capacityBlocks.map(reason => <li key={reason}>{reason}</li>)}</ul>}
      </div>

      <div className="wsa-health-kpis">
        <button type="button" className="wsa-health-kpi" data-active={activeTab === 'audit'} onClick={() => setActiveTab('audit')}>
          <span className="wsa-health-kpi-label">会话与审计</span>
          <strong className="wsa-health-kpi-value">{health.chat?.ready ? '对话已就绪' : '对话待连接'}</strong>
          <span className="wsa-health-kpi-sub">后台：{stateLabel} · 待核 {summary.audit.pending}</span>
        </button>
        <button type="button" className="wsa-health-kpi" data-active={activeTab === 'queues'} onClick={() => setActiveTab('queues')}>
          <span className="wsa-health-kpi-label">{t('queues')}</span>
          <strong className="wsa-health-kpi-value">{summary.queues.normal.items} / 256</strong>
          <span className="wsa-health-kpi-sub">控制 {summary.queues.control.items} / 32 · 未知效果 {summary.effects.unknown}</span>
        </button>
        <button type="button" className="wsa-health-kpi" data-active={activeTab === 'dependencies'} onClick={() => setActiveTab('dependencies')}>
          <span className="wsa-health-kpi-label">宿主依赖与上下文</span>
          <strong className="wsa-health-kpi-value">{availableDeps} / {health.dependencies.length} 可用</strong>
          <span className="wsa-health-kpi-sub">上下文来源 {registeredSources} / {totalSources} 已注册</span>
        </button>
        <button type="button" className="wsa-health-kpi" data-active={activeTab === 'capacity'} onClick={() => setActiveTab('capacity')}>
          <span className="wsa-health-kpi-label">{t('capacity')}</span>
          <strong className="wsa-health-kpi-value">{bytes(totalDbBytes)}</strong>
          <span className="wsa-health-kpi-sub">可用磁盘 {bytes(summary.capacity.diskAvailableBytes)}</span>
        </button>
      </div>

      <div className="wsa-health-tabs-bar">
        <div className="wsa-health-tabs" role="tablist" aria-label="运行状态分栏">
          {tabs.map(tab => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`wsa-health-tab-${tab.id}`}
              aria-selected={activeTab === tab.id}
              aria-controls={`wsa-health-panel-${tab.id}`}
              className="wsa-health-tab"
              onClick={() => setActiveTab(tab.id)}
            >
              <Icon name={tab.icon} size={14} className="wsa-health-tab-icon" />
              <span>{tab.label}</span>
              <span className="wsa-health-tab-badge">{tab.badge}</span>
              {tab.warn && <span className="wsa-health-tab-dot" aria-hidden="true" />}
            </button>
          ))}
        </div>
      </div>

      <div
        className="wsa-health-tabpanel"
        role="tabpanel"
        id={`wsa-health-panel-${activeTab}`}
        aria-labelledby={`wsa-health-tab-${activeTab}`}
      >
        {activeTab === 'queues' && (
          <div className="wsa-health-grid">
            <div className="wsa-health-stack">
              <section className="wsa-health-section">
                <div className="wsa-health-section-head"><h2>{t('queues')}</h2></div>
                <dl>
                  <Row name={t('normal')} value={summary.queues.normal.items + ' / 256 · ' + bytes(summary.queues.normal.bytes)} />
                  <Row name={t('control')} value={summary.queues.control.items + ' / 32 · ' + bytes(summary.queues.control.bytes)} />
                  <Row name="普通最老排队时间" value={summary.queues.normal.oldestQueuedAt === null ? '队列为空' : date(summary.queues.normal.oldestQueuedAt)} />
                  <Row name={t('effects')} value={String(summary.effects.unknown)} />
                </dl>
              </section>
              <section className="wsa-health-section">
                <div className="wsa-health-section-head"><h2>{t('evals')}</h2></div>
                {summary.evals.truncated && <p role="alert">{summary.evals.reason}</p>}
                {!summary.evals.active.length ? <p className="wsa-health-empty-box">{t('empty')}</p> : <div className="wsa-health-scroll"><table><thead><tr>
                  <th>{t('columnName')}</th><th>{t('columnState')}</th><th>{t('columnDeadline')}</th></tr></thead><tbody>{summary.evals.active.map(evaluation =>
                  <tr key={evaluation.id}><td className="wsa-health-id">{evaluation.id}</td><td>{states[evaluation.state] ?? evaluation.state}，尝试{evaluation.attempt}/2</td>
                  <td>{evaluation.deadline === null ? evaluation.deadlineBasis === null ? t('notDelivered') : '已冻结剩余 '+Math.ceil(evaluation.remainingMs/1000)+' 秒' : date(evaluation.deadline)}</td></tr>)}</tbody></table></div>}
              </section>
            </div>
            <div className="wsa-health-stack">
              <section className="wsa-health-section">
                <div className="wsa-health-section-head"><h2>{t('jobs')}</h2></div>
                <div className="wsa-health-job-stats">
                  <div className="wsa-health-job-stat"><span>持久占用名额</span><strong>{summary.jobs.occupied} / 2</strong></div>
                  <div className="wsa-health-job-stat"><span>同部署未退出计算</span><strong>{health.handles?.jobs.pendingResults ?? t('unavailable')} / 2</strong></div>
                  <div className="wsa-health-job-stat"><span>本实例运行句柄</span><strong>{health.handles?.jobs.running ?? t('unavailable')}</strong></div>
                  <div className="wsa-health-job-stat"><span>{t('handle')}</span><strong>{health.handles?.jobs.timers ?? t('unavailable')}</strong></div>
                </div>
                <dl>{Object.entries(summary.jobs.counts).map(([state, count]) => <Row key={state} name={states[state] ?? state} value={String(count)} />)}</dl>
                {summary.jobs.truncated && <p role="alert">{summary.jobs.reason}</p>}
                {summary.jobs.active.map(job => <p key={job.id} className="wsa-health-id">{job.id} · {states[job.state] ?? job.state} · {date(job.deadline)}</p>)}
              </section>
            </div>
          </div>
        )}

        {activeTab === 'dependencies' && (
          <div className="wsa-health-grid">
            <div className="wsa-health-stack">
              <section className="wsa-health-section">
                <div className="wsa-health-section-head"><h2>{t('dependencies')}</h2><span className="wsa-health-muted">{availableDeps}/{health.dependencies.length}</span></div>
                <dl>{health.dependencies.map(dependency =>
                  <Row key={dependency.name} name={<span className="wsa-health-id">{dependency.name}</span>}
                    value={<Pill label={dependency.changed ? t('replaced') : dependency.available ? t('available') : t('missing')}
                      kind={dependency.changed ? 'warn' : dependency.available ? 'ok' : 'error'} />} />)}</dl>
              </section>
            </div>
            <div className="wsa-health-stack">
              <section className="wsa-health-section">
                <div className="wsa-health-section-head"><h2>{t('contextSources')}</h2><span className="wsa-health-muted">{registeredSources}/{totalSources}</span></div>
                {health.contextSources?.length ? (
                  <dl>
                    {health.contextSources.map(source => <Row key={source.id} name={<span className="wsa-health-id">{source.id}</span>}
                      value={<Pill label={t(source.available ? 'sourceRegistered' : 'sourceUnavailable')} kind={source.available ? 'ok' : 'warn'} />} />)}
                  </dl>
                ) : (
                  <p className="wsa-health-empty-box">{t('empty')}</p>
                )}
              </section>
            </div>
          </div>
        )}

        {activeTab === 'capacity' && (
          <div className="wsa-health-grid">
            <div className="wsa-health-stack">
              <section className="wsa-health-section">
                <div className="wsa-health-section-head"><h2>{t('capacity')}</h2></div>
                <dl>
                  <Row name={t('db')} value={bytes(summary.capacity.dbBytes)} />
                  <Row name={t('wal')} value={bytes(summary.capacity.walBytes)} />
                  <Row name={t('artifacts')} value={bytes(summary.capacity.artifactIndexedBytes)} />
                  <Row name={t('disk')} value={bytes(summary.capacity.diskAvailableBytes)} />
                </dl>
                <p className="wsa-health-footnote">{t('artifactNote')} {t('sampled')}：{date(summary.capacity.observedAt)}</p>
                {Object.entries(summary.capacity.reasons).filter(([, reason]) => reason && reason !== 'ENOENT').map(([key, reason]) => <p key={key} className="wsa-health-footnote">{key}：{reason}</p>)}
              </section>
            </div>
            <div className="wsa-health-stack">
              <section className="wsa-health-section">
                <div className="wsa-health-section-head">
                  <h2>存储引擎诊断</h2>
                  <Pill label={summary.diagnostics.healthy && !summary.diagnostics.recoveryPending ? '健康' : '待恢复或异常'}
                    kind={summary.diagnostics.healthy && !summary.diagnostics.recoveryPending ? 'ok' : 'warn'} />
                </div>
                <dl>
                  <Row name="日志模式 (Journal Mode)" value={<span className="wsa-health-id">{summary.diagnostics.journalMode.toUpperCase()}</span>} />
                  <Row name="外键约束 (Foreign Keys)" value={summary.diagnostics.foreignKeys ? '已启用' : '未启用'} />
                  <Row name="冷恢复状态" value={summary.diagnostics.recoveryPending ? '待执行冷恢复' : '已就绪'} />
                  <Row name="修订版本 (Revision)" value={String(summary.manager.revision)} />
                </dl>
              </section>
            </div>
          </div>
        )}

        {activeTab === 'audit' && (
          <div className="wsa-health-grid">
            <div className="wsa-health-stack">
              <section className="wsa-health-section">
                <div className="wsa-health-section-head">
                  <h2>{t('audit')}</h2>
                  <div className="wsa-health-actions">
                    <Pill label={(summary.audit.status === 'verified_scope' ? t('scoped') : t('reconcile')) + ' · 待核 ' + summary.audit.pending}
                      kind={summary.audit.status === 'verified_scope' && summary.audit.pending === 0 ? 'ok' : 'warn'} />
                    <button type="button" disabled={!canReconcile} onClick={() => void control('reconcile')}>
                      <Icon name="refresh" size={13} />
                      <span>{t('reconcileNow')}</span>
                    </button>
                  </div>
                </div>
                {summary.audit.reason && <p className="wsa-health-muted">{summary.audit.reason}</p>}
                <p className="wsa-health-footnote">{health.auditGate.reason}（{t('gate')}）</p>
                {summary.audit.verifiedScope.length > 0 && (
                  <div className="wsa-health-subsection">
                    <div className="wsa-health-section-head"><h2>已核日志游标范围</h2><span className="wsa-health-muted">{summary.audit.verifiedScope.length} 个会话</span></div>
                    <dl>
                      {summary.audit.verifiedScope.map(scope => (
                        <Row key={scope.sessionId} name={<span className="wsa-health-id">{scope.sessionId}</span>} value={`已核至 #${scope.offset}`} />
                      ))}
                    </dl>
                  </div>
                )}
              </section>
            </div>
            <div className="wsa-health-stack">
              <section className="wsa-health-section">
                <div className="wsa-health-section-head"><h2>{t('native')}</h2></div>
                <p className="wsa-health-muted">{health.nativeExecution.reason}</p>
              </section>
            </div>
          </div>
        )}
      </div>
    </section></div>;
  };
}
