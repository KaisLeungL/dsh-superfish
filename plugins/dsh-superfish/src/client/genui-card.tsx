import * as React from 'react';
import type { Context } from '@deepseek-ai/cordis';
import { repairJson, type GenuiNode } from '../genui/core.js';
import type { GenuiRequest, GenuiView } from '../genui/service.js';
import { DEFAULT_BOT_NAME } from '../app/health/chat-input.js';
import { CONTROL_TOKEN_HEADER } from '../status.js';
import { getBotProfile } from './bot-profile.js';
import { readChatHealth } from './chat-transport.js';
import type { EmbeddedProposalEmbedProps } from './action-card.js';
import { Icon } from './icons.js';
import type { PersonalSnapshot, PersonalTodo } from './personal-panel.js';
import { publishPersonalSnapshot, requestPersonalRefresh, subscribePersonalSnapshot } from './personal-sync.js';

export type GenuiActionHandler = (params: Record<string, unknown>) => unknown | Promise<unknown>;
export type GenuiMaterialComponent = React.ComponentType<{
  node: GenuiNode;
  props: Record<string, unknown>;
  children?: React.ReactNode;
  isJsonComplete: boolean;
  triggerAction: (actionName: string, params?: Record<string, unknown>) => Promise<unknown>;
}>;

export interface SuperagentGenuiClientPlugin {
  getMaterials?(): Readonly<Record<string, GenuiMaterialComponent>>;
  getActions?(): Readonly<Record<string, GenuiActionHandler>>;
  registerMaterial?(name: string, component: GenuiMaterialComponent): () => void;
  registerAction?(name: string, handler: GenuiActionHandler): () => void;
  subscribe?(listener: () => void): () => void;
}

interface GenuiContextValue {
  readonly materials: Readonly<Record<string, GenuiMaterialComponent>>;
  readonly customActions: Readonly<Record<string, GenuiActionHandler>>;
  readonly sessionId: string;
  readonly turn: number;
  readonly isJsonComplete: boolean;
}

const GenuiReactContext = React.createContext<GenuiContextValue>({
  materials: {},
  customActions: {},
  sessionId: '',
  turn: 0,
  isJsonComplete: true,
});

export function GenuiConfigProvider({
  materials,
  customActions = {},
  sessionId = '',
  turn = 0,
  isJsonComplete = true,
  children,
}: {
  materials: Readonly<Record<string, GenuiMaterialComponent>>;
  customActions?: Readonly<Record<string, GenuiActionHandler>>;
  sessionId?: string;
  turn?: number;
  isJsonComplete?: boolean;
  children: React.ReactNode;
}) {
  const value = React.useMemo<GenuiContextValue>(
    () => ({ materials, customActions, sessionId, turn, isJsonComplete }),
    [materials, customActions, sessionId, turn, isJsonComplete],
  );
  return <GenuiReactContext.Provider value={value}>{children}</GenuiReactContext.Provider>;
}

export function GenuiRenderer({
  content,
  isJsonComplete = true,
}: {
  content: GenuiNode | string | null | undefined;
  isJsonComplete?: boolean;
}): React.ReactElement | null {
  const ctx = React.useContext(GenuiReactContext);
  const resolvedNode = React.useMemo<GenuiNode | null>(() => {
    if (!content) return null;
    if (typeof content === 'string') {
      try {
        const text = isJsonComplete ? content : repairJson(content);
        const parsed = JSON.parse(text) as GenuiNode;
        return parsed && typeof parsed === 'object' && typeof parsed.componentName === 'string' ? parsed : null;
      } catch {
        return null;
      }
    }
    return typeof content === 'object' && typeof content.componentName === 'string' ? content : null;
  }, [content, isJsonComplete]);

  const triggerAction = React.useCallback(
    async (actionName: string, params: Record<string, unknown> = {}) => {
      const handler = ctx.customActions[actionName];
      if (typeof handler === 'function') {
        return await handler({ sessionId: ctx.sessionId, ...params });
      }
      return undefined;
    },
    [ctx.customActions, ctx.sessionId],
  );

  if (!resolvedNode) return null;
  const Component =
    ctx.materials[resolvedNode.componentName] ??
    ctx.materials[
      Object.keys(ctx.materials).find(k => k.toLowerCase() === resolvedNode.componentName.toLowerCase()) ?? ''
    ];
  if (!Component) return null;

  const renderedChildren = resolvedNode.children?.length
    ? resolvedNode.children.map((child, idx) => (
        <GenuiRenderer key={`${child.componentName}-${idx}`} content={child} isJsonComplete={isJsonComplete} />
      ))
    : undefined;

  return (
    <Component
      node={resolvedNode}
      props={(resolvedNode.props ?? {}) as Record<string, unknown>}
      isJsonComplete={isJsonComplete}
      triggerAction={triggerAction}
    >
      {renderedChildren}
    </Component>
  );
}

const css = `
.wsa-genui-wrap{margin:12px 0 8px;max-width:720px;display:flex;flex-direction:column;gap:10px;color:var(--dsw-alias-label-primary);font-size:13px;overflow-wrap:anywhere}
.wsa-genui-shell{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-base);overflow:hidden;container-type:inline-size;box-shadow:0 2px 8px -2px rgb(15 23 42 / .05)}
.wsa-genui-shell[data-tone="brand"]{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary-new-colorprimary-new-color,var(--dsw-alias-label-primary)) 32%,var(--dsw-alias-border-l1))}
.wsa-genui-shell-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,var(--dsw-alias-bg-base))}
.wsa-genui-shell-title{display:flex;flex-direction:column;gap:2px;min-width:0}
.wsa-genui-shell-title h3{margin:0;font-size:14px;font-weight:600;line-height:1.35;color:var(--dsw-alias-label-primary)}
.wsa-genui-shell-title small{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.wsa-genui-shell-meta{display:flex;align-items:center;gap:6px;flex:none}
.wsa-genui-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:500;padding:2px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary)}
.wsa-genui-badge[data-tone="brand"]{color:var(--dsw-alias-brand-primary-new-colorprimary-new-color,var(--dsw-alias-label-primary));border-color:color-mix(in srgb,var(--dsw-alias-brand-primary-new-colorprimary-new-color,var(--dsw-alias-label-primary)) 35%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-brand-primary-new-colorprimary-new-color,var(--dsw-alias-label-primary)) 8%,var(--dsw-alias-bg-base))}
.wsa-genui-badge[data-tone="success"]{color:var(--dsw-alias-state-success-primary,#16a34a)}
.wsa-genui-badge[data-tone="warning"]{color:var(--dsw-alias-state-warn-primary,#d97706)}
.wsa-genui-badge[data-tone="danger"]{color:var(--dsw-alias-state-error-primary,#dc2626)}
.wsa-genui-dismiss{border:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:4px 6px;border-radius:6px;font:inherit;font-size:11.5px}
.wsa-genui-dismiss:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.wsa-genui-body{padding:13px 14px;display:flex;flex-direction:column;gap:12px}

/* Grid & Section & Tabs */
.wsa-genui-grid{display:grid;gap:10px}
.wsa-genui-grid[data-cols="1"]{grid-template-columns:minmax(0,1fr)}
.wsa-genui-grid[data-cols="2"]{grid-template-columns:repeat(2,minmax(0,1fr))}
.wsa-genui-grid[data-cols="3"]{grid-template-columns:repeat(3,minmax(0,1fr))}
.wsa-genui-grid[data-cols="4"]{grid-template-columns:repeat(4,minmax(0,1fr))}
@container (max-width:480px){.wsa-genui-grid[data-cols="2"],.wsa-genui-grid[data-cols="3"],.wsa-genui-grid[data-cols="4"]{grid-template-columns:minmax(0,1fr)}}

.wsa-genui-section{border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 2%,var(--dsw-alias-bg-base));overflow:hidden}
.wsa-genui-section-toggle{width:100%;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 12px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;text-align:left}
.wsa-genui-section-toggle:hover{background:var(--dsw-alias-interactive-bg-hover)}
.wsa-genui-section-body{padding:10px 12px;border-top:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:10px}

.wsa-genui-tabs{display:flex;flex-direction:column;gap:10px}
.wsa-genui-tablist{display:flex;align-items:center;gap:4px;padding:3px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--dsw-alias-bg-base));border:1px solid var(--dsw-alias-border-l1);overflow-x:auto}
.wsa-genui-tab{display:inline-flex;align-items:center;gap:5px;padding:5px 11px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap}
.wsa-genui-tab[aria-selected="true"]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 1px 2px rgb(0 0 0 / .06)}
.wsa-genui-tab-badge{font-size:10.5px;padding:0 5px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);color:var(--dsw-alias-label-secondary)}

/* Alert */
.wsa-genui-alert{padding:10px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--dsw-alias-bg-base));display:flex;flex-direction:column;gap:3px}
.wsa-genui-alert[data-tone="info"]{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary-new-colorprimary-new-color,var(--dsw-alias-label-primary)) 35%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-brand-primary-new-colorprimary-new-color,var(--dsw-alias-label-primary)) 6%,var(--dsw-alias-bg-base))}
.wsa-genui-alert[data-tone="warning"]{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 40%,var(--dsw-alias-border-l1))}
.wsa-genui-alert[data-tone="danger"]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 40%,var(--dsw-alias-border-l1))}
.wsa-genui-alert strong{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary)}
.wsa-genui-alert p{margin:0;font-size:12.5px;line-height:1.55;color:var(--dsw-alias-label-secondary)}

/* 1. DshMetricGroup */
.wsa-genui-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:8px}
.wsa-genui-metric{padding:10px 12px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-label-primary) 2.5%,var(--dsw-alias-bg-base));display:flex;flex-direction:column;gap:3px}
.wsa-genui-metric-label{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.wsa-genui-metric-val{font-size:20px;font-weight:650;line-height:1.2;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.wsa-genui-metric[data-tone="brand"] .wsa-genui-metric-val{color:var(--dsw-alias-brand-primary-new-colorprimary-new-color,var(--dsw-alias-label-primary))}
.wsa-genui-metric[data-tone="success"] .wsa-genui-metric-val{color:var(--dsw-alias-state-success-primary,#16a34a)}
.wsa-genui-metric[data-tone="warning"] .wsa-genui-metric-val{color:var(--dsw-alias-state-warn-primary,#d97706)}
.wsa-genui-metric[data-tone="danger"] .wsa-genui-metric-val{color:var(--dsw-alias-state-error-primary,#dc2626)}
.wsa-genui-metric-sub{font-size:11px;color:var(--dsw-alias-label-tertiary)}

/* 2. DshTodoChecklist & 3. DshSessionDigestList & 4. DshTaskTable */
.wsa-genui-block{border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-base);overflow:hidden}
.wsa-genui-block-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-label-primary) 2.5%,var(--dsw-alias-bg-base))}
.wsa-genui-block-head h4{margin:0;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary)}
.wsa-genui-list{display:flex;flex-direction:column;divide-y:1px solid var(--dsw-alias-border-l1)}
.wsa-genui-item{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:9px 12px}
.wsa-genui-item+.wsa-genui-item{border-top:1px solid var(--dsw-alias-border-l1)}
.wsa-genui-item-main{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
.wsa-genui-item-title{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12.5px;font-weight:500;line-height:1.45;color:var(--dsw-alias-label-primary)}
.wsa-genui-item-title[data-done="true"]{text-decoration:line-through;color:var(--dsw-alias-label-tertiary)}
.wsa-genui-item-desc{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.wsa-genui-item-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.wsa-genui-item-actions{display:flex;align-items:center;gap:5px;flex:none}
.wsa-genui-btn{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;font-weight:500;cursor:pointer;white-space:nowrap}
.wsa-genui-btn:hover:enabled{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2)}
.wsa-genui-btn:disabled{opacity:.5;cursor:default}
.wsa-genui-btn[data-primary="true"]{background:var(--dsw-alias-brand-primary-new-colorprimary-new-color,var(--dsw-alias-label-primary));border-color:transparent;color:var(--dsw-static-neutral-bluish-00,var(--dsw-alias-label-primary-foreground,#fff))}
.wsa-genui-check-label{display:flex;align-items:flex-start;gap:8px;cursor:pointer;flex:1;min-width:0}
.wsa-genui-check-label input{margin-top:3px;cursor:pointer}
.wsa-genui-empty{padding:12px;font-size:12px;color:var(--dsw-alias-label-tertiary);text-align:center;margin:0}

/* P3: DshSessionCompareGrid & DshTimeBlockList & DshPomodoroWidget */
.wsa-genui-compare-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;padding:10px 12px}
.wsa-genui-compare-card{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 1.5%,var(--dsw-alias-bg-base));display:flex;flex-direction:column;gap:8px}
.wsa-genui-compare-tags{display:flex;flex-wrap:wrap;gap:4px}
.wsa-genui-compare-openlist{display:flex;flex-direction:column;gap:5px;border-top:1px dashed var(--dsw-alias-border-l1);padding-top:7px}
.wsa-genui-compare-openitem{display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.wsa-genui-timeblock-time{font-variant-numeric:tabular-nums;font-weight:600;font-size:12px;color:var(--dsw-alias-brand-primary-new-colorprimary-new-color,var(--dsw-alias-label-primary));min-width:92px;flex:none}
.wsa-genui-pomo{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;padding:11px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 2.5%,var(--dsw-alias-bg-base))}
.wsa-genui-pomo-clock{font-size:24px;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:-0.5px;color:var(--dsw-alias-label-primary)}
`;

function localDateStr(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function tomorrowStr(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return localDateStr(d);
}

const CATEGORY_LABELS: Record<string, { label: string; tone: string }> = {
  overdue: { label: '逾期', tone: 'danger' },
  today: { label: '今日', tone: 'brand' },
  upcoming: { label: '后续', tone: 'default' },
  doneToday: { label: '今日完成', tone: 'success' },
};

const TASK_STATUS_LABELS: Record<string, { label: string; tone: string }> = {
  todo: { label: '待办', tone: 'default' },
  backlog: { label: '待规划', tone: 'default' },
  running: { label: '进行中', tone: 'brand' },
  needs_input: { label: '待输入', tone: 'warning' },
  review: { label: '待验收', tone: 'warning' },
  done: { label: '已完成', tone: 'success' },
  succeeded: { label: '已完成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
};

const SESSION_STATUS_LABELS: Record<string, { label: string; tone: string }> = {
  completed: { label: '已完成', tone: 'success' },
  running: { label: '进行中', tone: 'brand' },
  needs_input: { label: '等待输入', tone: 'warning' },
  blank: { label: '空会话', tone: 'default' },
};

export function createBuiltInGenuiMaterials(
  EmbeddedProposalSection?: React.ComponentType<EmbeddedProposalEmbedProps>,
): Record<string, GenuiMaterialComponent> {
  const GenuiCardComponent: GenuiMaterialComponent = ({ props, children }) => {
    const title = typeof props.title === 'string' ? props.title : '';
    const subtitle = typeof props.subtitle === 'string' ? props.subtitle : '';
    const badge = typeof props.badge === 'string' ? props.badge : '';
    const tone = typeof props.tone === 'string' ? props.tone : 'default';
    return (
      <div className="wsa-genui-shell" data-tone={tone}>
        {(title || subtitle || badge) && (
          <header className="wsa-genui-shell-head">
            <div className="wsa-genui-shell-title">
              {title && <h3>{title}</h3>}
              {subtitle && <small>{subtitle}</small>}
            </div>
            {badge && (
              <div className="wsa-genui-shell-meta">
                <span className="wsa-genui-badge" data-tone={tone}>{badge}</span>
              </div>
            )}
          </header>
        )}
        <div className="wsa-genui-body">{children}</div>
      </div>
    );
  };

  const GenuiGridComponent: GenuiMaterialComponent = ({ props, children }) => {
    const cols = typeof props.columns === 'number' && props.columns >= 1 && props.columns <= 4 ? Math.floor(props.columns) : 2;
    return (
      <div className="wsa-genui-grid" data-cols={String(cols)}>
        {children}
      </div>
    );
  };

  const GenuiTabsComponent: GenuiMaterialComponent = ({ props, isJsonComplete }) => {
    const rawItems = Array.isArray(props.items) ? props.items : [];
    const items = rawItems.filter(
      (it): it is { key: string; label: string; badge?: string; children?: GenuiNode[] } =>
        Boolean(it && typeof it === 'object' && typeof (it as { label?: unknown }).label === 'string'),
    );
    const defaultKey = typeof props.defaultActiveKey === 'string' ? props.defaultActiveKey : items[0]?.key ?? '0';
    const [activeKey, setActiveKey] = React.useState(defaultKey);
    const activeTab = items.find((it, idx) => (it.key || String(idx)) === activeKey) ?? items[0];
    if (!items.length) return null;
    return (
      <div className="wsa-genui-tabs">
        <div className="wsa-genui-tablist" role="tablist">
          {items.map((tab, idx) => {
            const key = tab.key || String(idx);
            const selected = activeTab === tab;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={selected}
                className="wsa-genui-tab"
                onClick={() => setActiveKey(key)}
              >
                <span>{tab.label}</span>
                {tab.badge && <span className="wsa-genui-tab-badge">{tab.badge}</span>}
              </button>
            );
          })}
        </div>
        {activeTab && Array.isArray(activeTab.children) && (
          <div className="wsa-genui-tab-panel" role="tabpanel">
            {activeTab.children.map((child, idx) => (
              <GenuiRenderer key={`${child.componentName}-${idx}`} content={child} isJsonComplete={isJsonComplete} />
            ))}
          </div>
        )}
      </div>
    );
  };

  const GenuiSectionComponent: GenuiMaterialComponent = ({ props, children }) => {
    const title = typeof props.title === 'string' ? props.title : '分组详情';
    const badge = typeof props.badge === 'string' ? props.badge : '';
    const [open, setOpen] = React.useState(props.defaultOpen !== false);
    return (
      <section className="wsa-genui-section">
        <button
          type="button"
          className="wsa-genui-section-toggle"
          aria-expanded={open}
          onClick={() => setOpen(prev => !prev)}
        >
          <span>{title}</span>
          <span className="wsa-genui-shell-meta">
            {badge && <span className="wsa-genui-badge">{badge}</span>}
            <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />
          </span>
        </button>
        {open && <div className="wsa-genui-section-body">{children}</div>}
      </section>
    );
  };

  const GenuiAlertComponent: GenuiMaterialComponent = ({ props }) => {
    const title = typeof props.title === 'string' ? props.title : '';
    const text = typeof props.text === 'string' ? props.text : '';
    const tone = typeof props.tone === 'string' ? props.tone : 'info';
    if (!text && !title) return null;
    return (
      <div className="wsa-genui-alert" data-tone={tone} role="note">
        {title && <strong>{title}</strong>}
        {text && <p>{text}</p>}
      </div>
    );
  };

  const DshMetricGroupComponent: GenuiMaterialComponent = ({ props }) => {
    const items = Array.isArray(props.items) ? props.items : [];
    const valid = items.filter(
      (it): it is { label: string; value: string | number; subtext?: string; tone?: string } =>
        Boolean(it && typeof it === 'object' && typeof (it as { label?: unknown }).label === 'string'),
    );
    if (!valid.length) return null;
    return (
      <div className="wsa-genui-metrics" role="region" aria-label={typeof props.title === 'string' ? props.title : '指标概览'}>
        {valid.map((item, idx) => (
          <div key={`${item.label}-${idx}`} className="wsa-genui-metric" data-tone={item.tone ?? 'default'}>
            <span className="wsa-genui-metric-label">{item.label}</span>
            <strong className="wsa-genui-metric-val">{String(item.value ?? '0')}</strong>
            {item.subtext && <span className="wsa-genui-metric-sub">{item.subtext}</span>}
          </div>
        ))}
      </div>
    );
  };

  const DshTodoChecklistComponent: GenuiMaterialComponent = ({ props, triggerAction }) => {
    const genuiCtx = React.useContext(GenuiReactContext);
    const title = typeof props.title === 'string' ? props.title : '个人待办清单';
    const emptyText = typeof props.emptyText === 'string' ? props.emptyText : '暂无待办事项';
    const rawItems = Array.isArray(props.items) ? props.items : [];
    const schemaItems = rawItems.filter(
      (it): it is {
        id?: string;
        title: string;
        localDate?: string;
        done?: boolean;
        category?: string;
        boardTaskId?: string;
        note?: string;
      } => Boolean(it && typeof it === 'object' && typeof (it as { title?: unknown }).title === 'string'),
    );

    const [liveTodos, setLiveTodos] = React.useState<Map<string, PersonalTodo>>(() => new Map());
    const [busyId, setBusyId] = React.useState<string | null>(null);
    const [notice, setNotice] = React.useState('');

    const applyLiveSnapshot = React.useCallback((data: PersonalSnapshot) => {
      if (data?.ok && Array.isArray(data.todos?.items)) {
        const map = new Map<string, PersonalTodo>();
        for (const item of data.todos.items) {
          map.set(item.id, item);
          map.set(`title:${item.title}`, item);
        }
        setLiveTodos(map);
      }
    }, []);

    const syncLiveTodos = React.useCallback(async () => {
      try {
        const res = await fetch('/api/workspace-superagent/personal', { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as PersonalSnapshot;
        applyLiveSnapshot(data);
        if (genuiCtx.sessionId && data?.ok) {
          publishPersonalSnapshot(genuiCtx.sessionId, data);
        }
      } catch {
        // 保持 Schema 快照回退显示
      }
    }, [applyLiveSnapshot, genuiCtx.sessionId]);

    React.useEffect(() => {
      void syncLiveTodos();
    }, [syncLiveTodos]);

    React.useEffect(() => subscribePersonalSnapshot<PersonalSnapshot>(event => {
      if (!genuiCtx.sessionId || event.sessionId === genuiCtx.sessionId) {
        applyLiveSnapshot(event.snapshot);
      }
    }), [applyLiveSnapshot, genuiCtx.sessionId]);

    return (
      <div className="wsa-genui-block">
        <div className="wsa-genui-block-head">
          <h4>{title}</h4>
          <span className="wsa-genui-badge">{schemaItems.length} 项</span>
        </div>
        {notice && <p className="wsa-genui-empty" role="status">{notice}</p>}
        {schemaItems.length === 0 ? (
          <p className="wsa-genui-empty">{emptyText}</p>
        ) : (
          <div className="wsa-genui-list">
            {schemaItems.map((item, idx) => {
              const live = (item.id && liveTodos.get(item.id)) || liveTodos.get(`title:${item.title}`);
              const resolvedId = live?.id ?? item.id;
              const isDone = live ? live.done : Boolean(item.done);
              const dateText = live?.localDate ?? item.localDate;
              const boardId = live?.boardTaskId ?? item.boardTaskId;
              const todayDate = localDateStr(new Date());
              const effectiveCategory = live && dateText
                ? (isDone && dateText === todayDate
                    ? 'doneToday'
                    : !isDone && dateText < todayDate
                      ? 'overdue'
                      : !isDone && dateText === todayDate
                        ? 'today'
                        : !isDone && dateText > todayDate
                          ? 'upcoming'
                          : item.category)
                : item.category;
              const categoryMeta = effectiveCategory ? CATEGORY_LABELS[effectiveCategory] : undefined;
              const isUpcoming = !isDone && (dateText ? dateText > todayDate : effectiveCategory === 'upcoming');
              const rowKey = resolvedId ?? `suggested-${idx}`;
              const rowBusy = busyId === rowKey;

              const onToggle = async (checked: boolean) => {
                if (!resolvedId || rowBusy) return;
                setBusyId(rowKey);
                setNotice('');
                try {
                  await triggerAction('dsh.personal.toggleTodo', {
                    todoId: resolvedId,
                    revision: live?.revision,
                    done: checked,
                  });
                  await syncLiveTodos();
                } catch (err) {
                  setNotice(err instanceof Error ? err.message : '更新待办未完成');
                } finally {
                  setBusyId(null);
                }
              };

              const onMoveToday = async () => {
                if (!resolvedId || rowBusy) return;
                setBusyId(rowKey);
                setNotice('');
                try {
                  await triggerAction('dsh.personal.moveTodoToday', {
                    todoId: resolvedId,
                    revision: live?.revision,
                    localDate: todayDate,
                  });
                  await syncLiveTodos();
                } catch (err) {
                  setNotice(err instanceof Error ? err.message : '迁移至今日待办未完成');
                } finally {
                  setBusyId(null);
                }
              };

              const onMoveTomorrow = async () => {
                if (!resolvedId || rowBusy) return;
                setBusyId(rowKey);
                setNotice('');
                try {
                  await triggerAction('dsh.personal.moveTodoTomorrow', {
                    todoId: resolvedId,
                    revision: live?.revision,
                    localDate: tomorrowStr(),
                  });
                  await syncLiveTodos();
                } catch (err) {
                  setNotice(err instanceof Error ? err.message : '顺延待办未完成');
                } finally {
                  setBusyId(null);
                }
              };

              const onAddSuggested = async () => {
                if (rowBusy) return;
                setBusyId(rowKey);
                setNotice('');
                try {
                  await triggerAction('dsh.personal.createTodo', {
                    title: item.title,
                    localDate: item.localDate || localDateStr(new Date()),
                    ...(boardId ? { boardTaskId: boardId } : {}),
                  });
                  await syncLiveTodos();
                } catch (err) {
                  setNotice(err instanceof Error ? err.message : '添加待办未完成');
                } finally {
                  setBusyId(null);
                }
              };

              return (
                <div key={rowKey} className="wsa-genui-item">
                  {resolvedId ? (
                    <label className="wsa-genui-check-label">
                      <input
                        type="checkbox"
                        checked={isDone}
                        disabled={rowBusy}
                        onChange={e => void onToggle(e.target.checked)}
                      />
                      <div className="wsa-genui-item-main">
                        <div className="wsa-genui-item-title" data-done={isDone ? 'true' : undefined}>
                          <span>{item.title}</span>
                          {categoryMeta && (
                            <span className="wsa-genui-badge" data-tone={categoryMeta.tone}>{categoryMeta.label}</span>
                          )}
                        </div>
                        {item.note && <div className="wsa-genui-item-desc">{item.note}</div>}
                        {dateText && <div className="wsa-genui-item-meta"><span>日期：{dateText}</span></div>}
                      </div>
                    </label>
                  ) : (
                    <div className="wsa-genui-item-main">
                      <div className="wsa-genui-item-title">
                        <span>{item.title}</span>
                        <span className="wsa-genui-badge" data-tone="brand">建议待办</span>
                      </div>
                      {item.note && <div className="wsa-genui-item-desc">{item.note}</div>}
                    </div>
                  )}
                  <div className="wsa-genui-item-actions">
                    {boardId && (
                      <button
                        type="button"
                        className="wsa-genui-btn"
                        onClick={() => void triggerAction('dsh.taskBoard.open', { taskId: boardId })}
                      >
                        查看卡片
                      </button>
                    )}
                    {resolvedId && !isDone && isUpcoming && (
                      <button
                        type="button"
                        className="wsa-genui-btn"
                        data-primary="true"
                        disabled={rowBusy}
                        onClick={() => void onMoveToday()}
                      >
                        今天完成
                      </button>
                    )}
                    {resolvedId && !isDone && dateText !== tomorrowStr() && (
                      <button
                        type="button"
                        className="wsa-genui-btn"
                        disabled={rowBusy}
                        onClick={() => void onMoveTomorrow()}
                      >
                        顺延明天
                      </button>
                    )}
                    {!resolvedId && (
                      <button
                        type="button"
                        className="wsa-genui-btn"
                        data-primary="true"
                        disabled={rowBusy}
                        onClick={() => void onAddSuggested()}
                      >
                        + 加入待办
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const DshSessionDigestListComponent: GenuiMaterialComponent = ({ props, triggerAction }) => {
    const title = typeof props.title === 'string' ? props.title : '近期会话进展盘点';
    const emptyText = typeof props.emptyText === 'string' ? props.emptyText : '暂无相关会话记录';
    const rawItems = Array.isArray(props.items) ? props.items : [];
    const items = rawItems.filter(
      (it): it is {
        sessionId: string;
        title: string;
        workspaceTitle?: string;
        status?: string;
        summary?: string;
        nextStep?: string;
        updatedAt?: string;
      } =>
        Boolean(
          it &&
            typeof it === 'object' &&
            typeof (it as { sessionId?: unknown }).sessionId === 'string' &&
            typeof (it as { title?: unknown }).title === 'string',
        ),
    );

    return (
      <div className="wsa-genui-block">
        <div className="wsa-genui-block-head">
          <h4>{title}</h4>
          <span className="wsa-genui-badge">{items.length} 个会话</span>
        </div>
        {items.length === 0 ? (
          <p className="wsa-genui-empty">{emptyText}</p>
        ) : (
          <div className="wsa-genui-list">
            {items.map(session => {
              const statusMeta = SESSION_STATUS_LABELS[session.status ?? ''] ?? {
                label: session.status || '会话',
                tone: 'default',
              };
              return (
                <div key={session.sessionId} className="wsa-genui-item">
                  <div className="wsa-genui-item-main">
                    <div className="wsa-genui-item-title">
                      <span>{session.title}</span>
                      <span className="wsa-genui-badge" data-tone={statusMeta.tone}>{statusMeta.label}</span>
                      {session.workspaceTitle && <span className="wsa-genui-badge">{session.workspaceTitle}</span>}
                    </div>
                    {session.summary && <div className="wsa-genui-item-desc">{session.summary}</div>}
                    {(session.nextStep || session.updatedAt) && (
                      <div className="wsa-genui-item-meta">
                        {session.nextStep && <span>下一步：{session.nextStep}</span>}
                        {session.updatedAt && <span>更新：{session.updatedAt}</span>}
                      </div>
                    )}
                  </div>
                  <div className="wsa-genui-item-actions">
                    <button
                      type="button"
                      className="wsa-genui-btn"
                      onClick={() => void triggerAction('dsh.session.open', { sessionId: session.sessionId })}
                    >
                      打开会话
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const DshTaskTableComponent: GenuiMaterialComponent = ({ props, triggerAction }) => {
    const title = typeof props.title === 'string' ? props.title : '任务看板态势';
    const emptyText = typeof props.emptyText === 'string' ? props.emptyText : '暂无匹配的看板任务卡片';
    const rawItems = Array.isArray(props.items) ? props.items : [];
    const items = rawItems.filter(
      (it): it is {
        taskId: string;
        title: string;
        status: string;
        projectLabel?: string;
        column?: string;
        summary?: string;
        blocker?: string;
      } =>
        Boolean(
          it &&
            typeof it === 'object' &&
            typeof (it as { taskId?: unknown }).taskId === 'string' &&
            typeof (it as { title?: unknown }).title === 'string',
        ),
    );
    const [statusFilter, setStatusFilter] = React.useState<string>('all');
    const statuses = Array.from(new Set(items.map(i => i.status).filter(Boolean)));
    const visibleItems = statusFilter === 'all' ? items : items.filter(i => i.status === statusFilter);

    return (
      <div className="wsa-genui-block">
        <div className="wsa-genui-block-head">
          <h4>{title}</h4>
          <div className="wsa-genui-shell-meta">
            {statuses.length > 1 && (
              <select
                aria-label="按状态筛选看板卡片"
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value)}
                style={{
                  fontSize: '11.5px',
                  padding: '2px 6px',
                  borderRadius: '6px',
                  border: '1px solid var(--dsw-alias-border-l1)',
                  background: 'var(--dsw-alias-bg-base)',
                  color: 'inherit',
                }}
              >
                <option value="all">全部状态 ({items.length})</option>
                {statuses.map(st => (
                  <option key={st} value={st}>
                    {TASK_STATUS_LABELS[st]?.label ?? st}
                  </option>
                ))}
              </select>
            )}
            <span className="wsa-genui-badge">{visibleItems.length} 张卡片</span>
          </div>
        </div>
        {visibleItems.length === 0 ? (
          <p className="wsa-genui-empty">{emptyText}</p>
        ) : (
          <div className="wsa-genui-list">
            {visibleItems.map(task => {
              const statusMeta = TASK_STATUS_LABELS[task.status] ?? { label: task.status || '待办', tone: 'default' };
              return (
                <div key={task.taskId} className="wsa-genui-item">
                  <div className="wsa-genui-item-main">
                    <div className="wsa-genui-item-title">
                      <span>{task.title}</span>
                      <span className="wsa-genui-badge" data-tone={statusMeta.tone}>{statusMeta.label}</span>
                      {task.projectLabel && <span className="wsa-genui-badge">{task.projectLabel}</span>}
                    </div>
                    {task.summary && <div className="wsa-genui-item-desc">{task.summary}</div>}
                    {task.blocker && (
                      <div className="wsa-genui-item-meta">
                        <span className="wsa-genui-badge" data-tone="danger">阻塞：{task.blocker}</span>
                      </div>
                    )}
                  </div>
                  <div className="wsa-genui-item-actions">
                    <button
                      type="button"
                      className="wsa-genui-btn"
                      onClick={() => void triggerAction('dsh.taskBoard.open', { taskId: task.taskId })}
                    >
                      查看卡片
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const readText = (val: unknown, fallback = ''): string => {
    if (typeof val === 'string' && val.trim()) return val.trim();
    if (typeof val === 'number' && Number.isFinite(val)) return String(val);
    return fallback;
  };

  const readNumber = (val: unknown, fallback = 0): number => {
    if (typeof val === 'number' && Number.isFinite(val)) return val;
    if (typeof val === 'string' && val.trim()) {
      const parsed = Number(val);
      if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
  };

  const DshProposalEmbedComponent: GenuiMaterialComponent = ({ props }) => {
    const ctx = React.useContext(GenuiReactContext);
    const proposalId = readText(props.proposalId);
    const proposalIds = React.useMemo(() => {
      const list = Array.isArray(props.proposalIds) ? props.proposalIds : [];
      return list.map(item => readText(item)).filter(Boolean);
    }, [props.proposalIds]);
    const targetTurn = typeof props.turn === 'number' && Number.isFinite(props.turn) ? props.turn : ctx.turn;
    const titleStr = readText(props.title);
    const descriptionStr = readText(props.description || props.subtitle);

    if (!EmbeddedProposalSection || !ctx.sessionId) {
      return (
        <p className="wsa-genui-empty">
          待确认事务卡组件暂不可用
        </p>
      );
    }

    return (
      <EmbeddedProposalSection
        sessionId={ctx.sessionId}
        turn={targetTurn}
        title={titleStr || undefined}
        description={descriptionStr || undefined}
        proposalId={proposalId || undefined}
        proposalIds={proposalIds.length > 0 ? proposalIds : undefined}
      />
    );
  };

  const DshSessionCompareGridComponent: GenuiMaterialComponent = ({ props, triggerAction }) => {
    const titleStr = readText(props.title, '多会话横向对比');
    const rawItems = Array.isArray(props.sessions ?? props.items) ? (props.sessions ?? props.items) as unknown[] : [];
    const items = rawItems
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item, idx) => {
        const modules = Array.isArray(item.modules)
          ? item.modules.map(m => readText(m)).filter(Boolean)
          : [];
        const openItems = Array.isArray(item.openItems)
          ? item.openItems.map(o => readText(o)).filter(Boolean)
          : [];
        return {
          sessionId: readText(item.sessionId || item.id, `sess-${idx}`),
          title: readText(item.title || item.name, `会话 #${idx + 1}`),
          status: readText(item.status, '进行中'),
          conclusion: readText(item.conclusion || item.summary),
          modules,
          openItems,
          updatedAt: readText(item.updatedAt),
        };
      });

    const [convertedKeys, setConvertedKeys] = React.useState<Record<string, boolean>>({});
    const [busyKey, setBusyKey] = React.useState<string | null>(null);

    const convertSingleOpenItem = async (sessionTitle: string, openItem: string, key: string) => {
      if (busyKey) return;
      setBusyKey(key);
      try {
        await triggerAction('dsh.personal.createTodo', {
          title: openItem,
          quadrant: 'q2',
          note: `来自会话「${sessionTitle}」遗留项`,
        });
        setConvertedKeys(prev => ({ ...prev, [key]: true }));
      } finally {
        setBusyKey(null);
      }
    };

    const convertAllOpenItems = async () => {
      if (busyKey) return;
      setBusyKey('__all__');
      try {
        for (const sess of items) {
          for (let i = 0; i < sess.openItems.length; i += 1) {
            const key = `${sess.sessionId}:${i}`;
            if (convertedKeys[key]) continue;
            await triggerAction('dsh.personal.createTodo', {
              title: sess.openItems[i],
              quadrant: 'q2',
              note: `来自会话「${sess.title}」遗留项`,
            });
            setConvertedKeys(prev => ({ ...prev, [key]: true }));
          }
        }
      } finally {
        setBusyKey(null);
      }
    };

    const totalOpenCount = items.reduce((acc, s) => acc + s.openItems.length, 0);

    return (
      <div className="wsa-genui-block">
        <div className="wsa-genui-block-head">
          <h4>{titleStr}</h4>
          <div className="wsa-genui-shell-meta">
            <span className="wsa-genui-badge">{items.length} 个会话</span>
            {totalOpenCount > 0 && (
              <button
                type="button"
                className="wsa-genui-btn"
                data-primary="true"
                disabled={busyKey !== null}
                onClick={() => void convertAllOpenItems()}
              >
                {busyKey === '__all__' ? '正在批量转入待办...' : `一键转入今日待办 (${totalOpenCount})`}
              </button>
            )}
          </div>
        </div>
        {items.length === 0 ? (
          <p className="wsa-genui-empty">暂无对比会话</p>
        ) : (
          <div className="wsa-genui-compare-grid">
            {items.map(sess => (
              <div key={sess.sessionId} className="wsa-genui-compare-card">
                <div className="wsa-genui-item-title">
                  <span>{sess.title}</span>
                  <span className="wsa-genui-badge" data-tone="brand">{sess.status}</span>
                </div>
                {sess.updatedAt && <div className="wsa-genui-item-meta">{sess.updatedAt}</div>}
                {sess.conclusion && (
                  <div className="wsa-genui-item-desc">
                    <strong>核心结论：</strong>{sess.conclusion}
                  </div>
                )}
                {sess.modules.length > 0 && (
                  <div className="wsa-genui-compare-tags">
                    {sess.modules.map((mod, idx) => (
                      <span key={idx} className="wsa-genui-badge">{mod}</span>
                    ))}
                  </div>
                )}
                {sess.openItems.length > 0 && (
                  <div className="wsa-genui-compare-openlist">
                    <div className="wsa-genui-item-meta">待办遗留项 ({sess.openItems.length})</div>
                    {sess.openItems.map((openItem, idx) => {
                      const key = `${sess.sessionId}:${idx}`;
                      const done = Boolean(convertedKeys[key]);
                      return (
                        <div key={key} className="wsa-genui-compare-openitem">
                          <span>• {openItem}</span>
                          <button
                            type="button"
                            className="wsa-genui-btn"
                            disabled={done || busyKey !== null}
                            onClick={() => void convertSingleOpenItem(sess.title, openItem, key)}
                          >
                            {done ? '已转待办' : busyKey === key ? '处理中...' : '+ 转待办'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
                <div style={{ marginTop: 'auto', paddingTop: '6px', display: 'flex', justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    className="wsa-genui-btn"
                    onClick={() => void triggerAction('dsh.session.open', { sessionId: sess.sessionId })}
                  >
                    打开会话
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const DshTimeBlockListComponent: GenuiMaterialComponent = ({ props, triggerAction }) => {
    const titleStr = readText(props.title, '今日专注时间块规划');
    const rawBlocks = Array.isArray(props.blocks ?? props.items) ? (props.blocks ?? props.items) as unknown[] : [];
    const items = rawBlocks
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item, idx) => ({
        id: readText(item.id, `tb-${idx}`),
        timeRange: readText(item.timeRange || item.time, `${9 + idx}:00 - ${9 + idx}:25`),
        title: readText(item.title || item.label, `专注时段 #${idx + 1}`),
        mode: readText(item.mode, 'focus') === 'break' ? 'break' : 'focus',
        durationMinutes: readNumber(item.durationMinutes ?? item.duration, 25),
        taskId: readText(item.taskId),
        todoId: readText(item.todoId),
        note: readText(item.note || item.summary),
      }));

    const [activeBlockId, setActiveBlockId] = React.useState<string | null>(null);

    const handleStartBlock = async (block: (typeof items)[number]) => {
      setActiveBlockId(block.id);
      await triggerAction('dsh.pomodoro.start', {
        mode: block.mode,
        label: block.title,
        blockId: block.id,
      });
    };

    return (
      <div className="wsa-genui-block">
        <div className="wsa-genui-block-head">
          <h4>{titleStr}</h4>
          <span className="wsa-genui-badge">{items.length} 个时间块</span>
        </div>
        {items.length === 0 ? (
          <p className="wsa-genui-empty">暂无专注时间块规划</p>
        ) : (
          <div className="wsa-genui-list">
            {items.map(block => {
              const isStarted = activeBlockId === block.id;
              return (
                <div key={block.id} className="wsa-genui-item">
                  <div className="wsa-genui-timeblock-time">{block.timeRange}</div>
                  <div className="wsa-genui-item-main">
                    <div className="wsa-genui-item-title">
                      <span>{block.title}</span>
                      <span className="wsa-genui-badge" data-tone={block.mode === 'break' ? 'success' : 'brand'}>
                        {block.mode === 'break' ? '休息' : '专注'} · {block.durationMinutes}m
                      </span>
                    </div>
                    {block.note && <div className="wsa-genui-item-desc">{block.note}</div>}
                  </div>
                  <div className="wsa-genui-item-actions">
                    <button
                      type="button"
                      className="wsa-genui-btn"
                      data-primary="true"
                      onClick={() => void handleStartBlock(block)}
                    >
                      {isStarted ? '🍅 专注进行中' : '🍅 开启专注'}
                    </button>
                    {block.todoId && (
                      <button
                        type="button"
                        className="wsa-genui-btn"
                        onClick={() => void triggerAction('dsh.personal.toggleTodo', { todoId: block.todoId, done: true })}
                      >
                        完成待办
                      </button>
                    )}
                    {block.taskId && (
                      <button
                        type="button"
                        className="wsa-genui-btn"
                        onClick={() => void triggerAction('dsh.taskBoard.open', { taskId: block.taskId })}
                      >
                        查看卡片
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const DshPomodoroWidgetComponent: GenuiMaterialComponent = ({ props, triggerAction }) => {
    const titleStr = readText(props.title, '番茄专注时钟');
    const labelStr = readText(props.label ?? props.taskTitle, '当前专注任务');
    const initialMode = readText(props.mode, 'focus') === 'break' ? 'break' : 'focus';

    const [snapshot, setSnapshot] = React.useState<{
      mode: string;
      status: string;
      remainingMs: number;
    }>({
      mode: initialMode,
      status: 'idle',
      remainingMs: initialMode === 'break' ? 5 * 60 * 1000 : 25 * 60 * 1000,
    });
    const [busy, setBusy] = React.useState(false);

    const fetchState = React.useCallback(async () => {
      if (typeof fetch !== 'function') return;
      try {
        const res = await fetch('/api/local-pomodoro', { method: 'GET', headers: { Accept: 'application/json' } });
        if (!res.ok) return;
        const data = (await res.json()) as Record<string, unknown>;
        if (data && typeof data === 'object') {
          setSnapshot({
            mode: readText(data.mode, 'focus'),
            status: readText(data.status, 'idle'),
            remainingMs: readNumber(data.remainingMs, 25 * 60 * 1000),
          });
        }
      } catch {
        // Ignore network errors in sandbox/SSR
      }
    }, []);

    React.useEffect(() => {
      void fetchState();
    }, [fetchState]);

    const invokePomodoro = async (actionName: string, payload: Record<string, unknown> = {}) => {
      if (busy) return;
      setBusy(true);
      try {
        await triggerAction(actionName, payload);
        await fetchState();
      } finally {
        setBusy(false);
      }
    };

    const totalSec = Math.max(0, Math.ceil(snapshot.remainingMs / 1000));
    const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const ss = String(totalSec % 60).padStart(2, '0');

    return (
      <div className="wsa-genui-pomo">
        <div>
          <div className="wsa-genui-item-title">
            <span>🍅 {titleStr}</span>
            <span className="wsa-genui-badge" data-tone={snapshot.status === 'running' ? 'success' : 'default'}>
              {snapshot.status === 'running' ? '运行中' : snapshot.status === 'paused' ? '已暂停' : '待机'}
            </span>
          </div>
          <div className="wsa-genui-item-desc">{labelStr} · {snapshot.mode === 'break' ? '休息模式' : '专注模式'}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <div className="wsa-genui-pomo-clock">{mm}:{ss}</div>
          <div className="wsa-genui-item-actions">
            {snapshot.status !== 'running' ? (
              <button
                type="button"
                className="wsa-genui-btn"
                data-primary="true"
                disabled={busy}
                onClick={() =>
                  void invokePomodoro(
                    snapshot.status === 'paused' ? 'dsh.pomodoro.resume' : 'dsh.pomodoro.start',
                    { mode: snapshot.mode },
                  )
                }
              >
                {snapshot.status === 'paused' ? '继续' : '开始专注'}
              </button>
            ) : (
              <button
                type="button"
                className="wsa-genui-btn"
                disabled={busy}
                onClick={() => void invokePomodoro('dsh.pomodoro.pause')}
              >
                暂停
              </button>
            )}
            <button
              type="button"
              className="wsa-genui-btn"
              disabled={busy}
              onClick={() => void invokePomodoro('dsh.pomodoro.reset')}
            >
              重置
            </button>
          </div>
        </div>
      </div>
    );
  };

  return {
    GenuiCard: GenuiCardComponent,
    TinyCard: GenuiCardComponent,
    AntdCard: GenuiCardComponent,
    Card: GenuiCardComponent,
    GenuiGrid: GenuiGridComponent,
    AntdRow: GenuiGridComponent,
    TinyGrid: GenuiGridComponent,
    Grid: GenuiGridComponent,
    GenuiTabs: GenuiTabsComponent,
    AntdTabs: GenuiTabsComponent,
    TinyTabs: GenuiTabsComponent,
    Tabs: GenuiTabsComponent,
    GenuiSection: GenuiSectionComponent,
    AntdCollapse: GenuiSectionComponent,
    TinyCollapse: GenuiSectionComponent,
    Collapse: GenuiSectionComponent,
    GenuiAlert: GenuiAlertComponent,
    AntdAlert: GenuiAlertComponent,
    TinyAlert: GenuiAlertComponent,
    Alert: GenuiAlertComponent,
    DshMetricGroup: DshMetricGroupComponent,
    MetricGroup: DshMetricGroupComponent,
    AntdStatisticGroup: DshMetricGroupComponent,
    DshTodoChecklist: DshTodoChecklistComponent,
    TodoChecklist: DshTodoChecklistComponent,
    DshSessionDigestList: DshSessionDigestListComponent,
    SessionDigestList: DshSessionDigestListComponent,
    DshTaskTable: DshTaskTableComponent,
    TaskTable: DshTaskTableComponent,
    DshBoardOverview: DshTaskTableComponent,
    DshProposalEmbed: DshProposalEmbedComponent,
    DshProposalCard: DshProposalEmbedComponent,
    DshActionCard: DshProposalEmbedComponent,
    DshProposalGroup: DshProposalEmbedComponent,
    DshSessionCompareGrid: DshSessionCompareGridComponent,
    DshSessionMatrix: DshSessionCompareGridComponent,
    DshSessionCompare: DshSessionCompareGridComponent,
    DshTimeBlockList: DshTimeBlockListComponent,
    DshFocusPlanner: DshTimeBlockListComponent,
    DshTimeBlocks: DshTimeBlockListComponent,
    DshPomodoroPlanner: DshTimeBlockListComponent,
    DshPomodoroWidget: DshPomodoroWidgetComponent,
    DshPomodoroCard: DshPomodoroWidgetComponent,
    DshPomodoroControl: DshPomodoroWidgetComponent,
  };
}

export function createGuardedGenuiActions(
  ctx: Context,
  mutatePersonal: (sessionId: string, request: Record<string, unknown>) => Promise<PersonalSnapshot>,
): Record<string, GenuiActionHandler> {
  async function resolveTodoRevision(todoId: string, providedRevision?: unknown): Promise<number> {
    if (typeof providedRevision === 'number' && Number.isSafeInteger(providedRevision)) {
      return providedRevision;
    }
    const res = await fetch('/api/workspace-superagent/personal', { credentials: 'same-origin', cache: 'no-store' });
    const snapshot = (await res.json()) as PersonalSnapshot;
    const found = snapshot?.todos?.items?.find(item => item.id === todoId);
    if (!found) throw new Error('未找到对应的待办项，请刷新后重试');
    return found.revision;
  }

  return {
    'dsh.taskBoard.open': async params => {
      const taskId = typeof params.taskId === 'string' ? params.taskId : '';
      if (!taskId) return false;
      const board = (ctx as unknown as { get?(name: string): unknown }).get?.('taskBoard') as
        | { openTaskFromHost?(id: string): Promise<boolean> }
        | undefined;
      return (await board?.openTaskFromHost?.(taskId)) ?? false;
    },
    'dsh.session.open': params => {
      const targetSessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
      if (!targetSessionId) return false;
      const uiWorkspace = (ctx as unknown as { get?(name: string): unknown }).get?.('uiWorkspace') as
        | { openSession?(id: string): void }
        | undefined;
      if (typeof uiWorkspace?.openSession === 'function') {
        uiWorkspace.openSession(targetSessionId);
        return true;
      }
      const layout = (ctx as unknown as { get?(name: string): unknown }).get?.('layout') as
        | { openSession?(id: string): void }
        | undefined;
      layout?.openSession?.(targetSessionId);
      return true;
    },
    'dsh.personal.toggleTodo': async params => {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
      const todoId = typeof params.todoId === 'string' ? params.todoId : '';
      const done = Boolean(params.done);
      if (!sessionId || !todoId) throw new Error('缺少待办标识');
      const revision = await resolveTodoRevision(todoId, params.revision);
      return await mutatePersonal(sessionId, { op: 'update', id: todoId, revision, done });
    },
    'dsh.personal.moveTodoToday': async params => {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
      const todoId = typeof params.todoId === 'string' ? params.todoId : '';
      const localDate = typeof params.localDate === 'string' ? params.localDate : localDateStr(new Date());
      if (!sessionId || !todoId) throw new Error('缺少待办标识');
      const revision = await resolveTodoRevision(todoId, params.revision);
      return await mutatePersonal(sessionId, { op: 'move', id: todoId, revision, localDate });
    },
    'dsh.personal.moveTodoTomorrow': async params => {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
      const todoId = typeof params.todoId === 'string' ? params.todoId : '';
      const localDate = typeof params.localDate === 'string' ? params.localDate : tomorrowStr();
      if (!sessionId || !todoId) throw new Error('缺少待办标识');
      const revision = await resolveTodoRevision(todoId, params.revision);
      return await mutatePersonal(sessionId, { op: 'move', id: todoId, revision, localDate });
    },
    'dsh.personal.createTodo': async params => {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
      const title = typeof params.title === 'string' ? params.title.trim() : '';
      const localDate = typeof params.localDate === 'string' ? params.localDate : localDateStr(new Date());
      const boardTaskId = typeof params.boardTaskId === 'string' ? params.boardTaskId : undefined;
      if (!sessionId || !title) throw new Error('缺少待办标题');
      return await mutatePersonal(sessionId, {
        op: 'create',
        title,
        localDate,
        ...(boardTaskId ? { boardTaskId } : {}),
      });
    },
    'dsh.todo.toggle': async params => {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
      const todoId = typeof params.todoId === 'string' ? params.todoId : '';
      const done = params.done === true;
      if (!sessionId || !todoId) throw new Error('缺少待办标识');
      const revision = await resolveTodoRevision(todoId, params.revision);
      return await mutatePersonal(sessionId, { op: 'update', id: todoId, revision, done });
    },
    'dsh.todo.moveToToday': async params => {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
      const todoId = typeof params.todoId === 'string' ? params.todoId : '';
      const localDate = typeof params.localDate === 'string' ? params.localDate : localDateStr(new Date());
      if (!sessionId || !todoId) throw new Error('缺少待办标识');
      const revision = await resolveTodoRevision(todoId, params.revision);
      return await mutatePersonal(sessionId, { op: 'move', id: todoId, revision, localDate });
    },
    'dsh.todo.moveToTomorrow': async params => {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
      const todoId = typeof params.todoId === 'string' ? params.todoId : '';
      const localDate = typeof params.localDate === 'string' ? params.localDate : tomorrowStr();
      if (!sessionId || !todoId) throw new Error('缺少待办标识');
      const revision = await resolveTodoRevision(todoId, params.revision);
      return await mutatePersonal(sessionId, { op: 'move', id: todoId, revision, localDate });
    },
    'dsh.todo.create': async params => {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
      const title = typeof params.title === 'string' ? params.title.trim() : '';
      const localDate = typeof params.localDate === 'string' ? params.localDate : localDateStr(new Date());
      const boardTaskId = typeof params.boardTaskId === 'string' ? params.boardTaskId : undefined;
      if (!sessionId || !title) throw new Error('缺少待办标题');
      return await mutatePersonal(sessionId, {
        op: 'create',
        title,
        localDate,
        ...(boardTaskId ? { boardTaskId } : {}),
      });
    },
    'dsh.pomodoro.start': async params => {
      const mode = params.mode === 'break' ? 'break' : 'focus';
      const res = await fetch('/api/local-pomodoro', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'start', mode }),
      });
      return res.ok ? await res.json() : null;
    },
    'dsh.pomodoro.pause': async () => {
      const res = await fetch('/api/local-pomodoro', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'pause' }),
      });
      return res.ok ? await res.json() : null;
    },
    'dsh.pomodoro.resume': async () => {
      const res = await fetch('/api/local-pomodoro', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'resume' }),
      });
      return res.ok ? await res.json() : null;
    },
    'dsh.pomodoro.reset': async params => {
      const mode = params.mode === 'break' ? 'break' : params.mode === 'focus' ? 'focus' : undefined;
      const res = await fetch('/api/local-pomodoro', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'reset', ...(mode ? { mode } : {}) }),
      });
      return res.ok ? await res.json() : null;
    },
    'dsh.pomodoro.select': async params => {
      const mode = params.mode === 'break' ? 'break' : 'focus';
      const res = await fetch('/api/local-pomodoro', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'select', mode }),
      });
      return res.ok ? await res.json() : null;
    },
  };
}

type TurnSlot = { turn: { turn: number; end?: { seq: number }; status: string }; sessionId: string };

export function createGenuiCard(
  ctx: Context,
  inManager: (sessionId: string) => boolean,
  EmbeddedProposalSection?: React.ComponentType<EmbeddedProposalEmbedProps>,
) {
  let tokenPromise: ReturnType<typeof readChatHealth> | undefined;
  const builtInMaterials = createBuiltInGenuiMaterials(EmbeddedProposalSection);

  async function getControlToken(): Promise<string> {
    const { token } = await (tokenPromise ??= readChatHealth());
    if (!token) throw new Error(`可视化面板授权已失效，请重新打开${getBotProfile().botName || DEFAULT_BOT_NAME}`);
    return token;
  }

  async function requestGenui(
    sessionId: string,
    request: GenuiRequest,
    signal?: AbortSignal,
  ): Promise<{ views: GenuiView[]; view: GenuiView | null }> {
    try {
      const token = await getControlToken();
      const response = await fetch('/api/workspace-superagent/genui', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        signal,
        headers: { 'content-type': 'application/json', [CONTROL_TOKEN_HEADER]: token },
        body: JSON.stringify({ sessionId, request }),
      });
      if (response.status === 403) tokenPromise = undefined;
      const value = (await response.json()) as {
        ok?: boolean;
        error?: string;
        views?: GenuiView[];
        view?: GenuiView | null;
      };
      if (!response.ok || !value.ok) throw new Error(value.error ?? '读取可视化卡片未完成');
      return {
        views: Array.isArray(value.views) ? value.views : value.view ? [value.view] : [],
        view: value.view ?? null,
      };
    } catch (error) {
      if (!signal?.aborted) tokenPromise = undefined;
      throw error;
    }
  }

  async function mutatePersonal(sessionId: string, request: Record<string, unknown>): Promise<PersonalSnapshot> {
    const token = await getControlToken();
    const requestId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : String(Date.now());
    const response = await fetch('/api/workspace-superagent/personal', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', [CONTROL_TOKEN_HEADER]: token },
      body: JSON.stringify({ sessionId, request: { ...request, requestId } }),
    });
    if (response.status === 403) tokenPromise = undefined;
    const value = (await response.json()) as PersonalSnapshot & { error?: string };
    if (!response.ok || !value.ok) throw new Error(value.error ?? '更新个人待办未完成');
    publishPersonalSnapshot(sessionId, value);
    return value;
  }

  const builtInActions = createGuardedGenuiActions(ctx, mutatePersonal);

  function GenuiTurnSlot({ turn, sessionId }: TurnSlot) {
    const [views, setViews] = React.useState<GenuiView[]>([]);
    const [, bumpPluginTick] = React.useReducer((n: number) => n + 1, 0);
    const prevTurnStatusRef = React.useRef(turn.status);
    const enabled = inManager(sessionId);

    const externalPlugin = (ctx as unknown as { get?(name: string): unknown }).get?.('superagentGenuiClient') as
      | SuperagentGenuiClientPlugin
      | undefined;

    React.useEffect(() => {
      if (typeof externalPlugin?.subscribe !== 'function') return;
      return externalPlugin.subscribe(() => bumpPluginTick());
    }, [externalPlugin]);

    React.useEffect(() => {
      const prevStatus = prevTurnStatusRef.current;
      prevTurnStatusRef.current = turn.status;
      if (!enabled) return;
      if (prevStatus !== 'closed' && turn.status === 'closed') {
        requestPersonalRefresh(sessionId);
      }
      const controller = new AbortController();
      void requestGenui(sessionId, { op: 'list', turn: turn.turn }, controller.signal)
        .then(res => {
          if (!controller.signal.aborted) setViews(res.views);
        })
        .catch(() => {});
      return () => controller.abort();
    }, [enabled, sessionId, turn.turn, turn.status, turn.end?.seq]);

    if (!enabled || views.length === 0) return null;

    const mergedMaterials = {
      ...builtInMaterials,
      ...(externalPlugin?.getMaterials?.() ?? {}),
    };
    const mergedActions = {
      ...builtInActions,
      ...(externalPlugin?.getActions?.() ?? {}),
    };

    const dismissView = async (id: string) => {
      try {
        await requestGenui(sessionId, { op: 'dismiss', id });
        setViews(current => current.filter(item => item.id !== id));
      } catch {
        // 忽略关闭失败
      }
    };

    return (
      <GenuiConfigProvider
        materials={mergedMaterials}
        customActions={mergedActions}
        sessionId={sessionId}
        turn={turn.turn}
        isJsonComplete={turn.status === 'closed'}
      >
        <div className="wsa-genui-wrap" data-superagent-genui="">
          <style>{css}</style>
          {views.map(view => (
            <section key={view.id} aria-label={view.title || `${getBotProfile().botName || DEFAULT_BOT_NAME}可视化视图`} data-genui-view-id={view.id}>
              <GenuiRenderer content={view.schema} isJsonComplete={turn.status === 'closed'} />
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '4px' }}>
                <button type="button" className="wsa-genui-dismiss" onClick={() => void dismissView(view.id)}>
                  收起视图
                </button>
              </div>
            </section>
          ))}
        </div>
      </GenuiConfigProvider>
    );
  }

  return GenuiTurnSlot;
}
