import * as React from 'react';
import type { Context } from '@deepseek-ai/cordis';
import {
  DEFAULT_BOT_NAME,
  SOUL_PRESETS,
  SOUL_TRAITS,
  buildDefaultTraitsMarkdown,
  type ChatModelSelection,
  type ChatSoulPreset,
  type ChatSoulTraitId,
  type OnboardingMemoryCandidate,
  type OnboardingMemorySourceId,
} from '../app/health/chat-input.js';
import { CONTROL_TOKEN_HEADER } from '../status.js';
import { BotAvatar, getBotProfile, useBotProfile } from './bot-profile.js';
import { readChatHealth } from './chat-transport.js';
import { Icon, type IconName } from './icons.js';
import type { ModelCatalogGroup } from './settings.js';
import {
  getCachedPersonalSnapshot,
  isPersonalSessionRunning,
  publishPersonalSnapshot,
  subscribePersonalRefresh,
  subscribePersonalSessionRunning,
  subscribePersonalSnapshot,
} from './personal-sync.js';

export interface PersonalTodo {
  id: string;
  title: string;
  localDate: string;
  done: boolean;
  revision: number;
  boardTaskId?: string;
  sourceUnavailable?: boolean;
}
export interface PersonalSchedule {
  id: string;
  title: string;
  status: 'active' | 'paused' | 'ended';
  scheduledAt?: string;
  timingLabel: string;
}
export interface PersonalActivity {
  id: string;
  title: string;
  status: string;
  updatedAt: number;
  worker?: string;
  events?: { title: string; at: number; summary?: string }[];
  taskId?: string;
  sessionId?: string;
  kind?: 'delegation' | 'schedule_trigger';
  scheduleId?: string;
}
export interface PersonalMemoryItem {
  id: string;
  category: 'preference' | 'profile' | 'project' | 'decision' | 'fact';
  title: string;
  content: string;
  tags: readonly string[];
  pinned: boolean;
  importance: number;
  scope?: 'workspace' | 'global';
  updatedAt: number;
}
export interface PersonalSkillItem {
  slug: string;
  name: string;
  displayName?: string;
  description: string;
  triggers: readonly string[];
  instructions?: string;
  scope: 'workspace' | 'global';
  updatedAt: number;
}
export interface PersonalGoalMilestoneItem {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  boardTaskId?: string | null;
  summary?: string | null;
  updatedAt: number;
}
export interface PersonalGoalItem {
  id: string;
  title: string;
  description: string;
  status: 'active' | 'paused' | 'completed' | 'failed' | 'archived';
  autoAdvance: boolean;
  milestones: readonly PersonalGoalMilestoneItem[];
  updatedAt: number;
}
export interface PersonalPluginCapability {
  kind: 'context' | 'genui' | 'action';
  id: string;
  description?: string;
  scope?: 'workspace' | 'project';
  available?: boolean;
}
export interface PersonalPluginItem {
  id: string;
  packageName: string;
  title: string;
  description: string;
  enabled: boolean;
  source: 'builtin' | 'discovered' | 'manual';
  capabilities: readonly PersonalPluginCapability[];
  updatedAt: number;
}
export interface PersonalPluginsSnapshot {
  available: boolean;
  items: PersonalPluginItem[];
  policyRevision?: string;
  contextGrants?: Readonly<Record<string, string>>;
  genuiPackages?: readonly string[];
}
interface Resource<T> { available: boolean; items: T[]; error?: string }
export interface PersonalSnapshot {
  ok: true;
  todos: Resource<PersonalTodo>;
  schedules: Resource<PersonalSchedule>;
  activities: Resource<PersonalActivity>;
  boardCandidates: Resource<{ id: string; title: string; status: string }>;
  memories?: Resource<PersonalMemoryItem> & { counts?: { total: number; pinned: number; archived: number } };
  skills?: Resource<PersonalSkillItem>;
  goals?: Resource<PersonalGoalItem>;
  plugins?: PersonalPluginsSnapshot;
}
export type PersonalPanelTab = 'overview' | 'memory' | 'skills' | 'config' | 'soul_memory';
export type StewardConfigSubTab = 'basic' | 'model' | 'soul' | 'memory' | 'plugins';

export interface StewardConfigPanelProps {
  botName: string;
  avatarDataUrl?: string | undefined;
  userName: string;
  onChangeBotName(name: string): void;
  onChangeUserName(name: string): void;
  onRequestAvatarUpload(): void;
  onClearAvatar?(): void;
  groups: readonly ModelCatalogGroup[];
  selectedModel: ChatModelSelection;
  onChangeModel(model: ChatModelSelection): void;
  soulPreset: ChatSoulPreset;
  soulTraits: readonly ChatSoulTraitId[];
  soulTraitsMarkdown: string;
  soulPrompt: string;
  syncSoulMarkdown: boolean;
  soulPreviewDoc: string;
  onSelectPreset(preset: ChatSoulPreset, prompt: string): void;
  onToggleTrait(traitId: ChatSoulTraitId): void;
  onChangeTraitsMarkdown(markdown: string): void;
  onResetTraitsMarkdown(): void;
  onChangePrompt(prompt: string): void;
  onResetPreset(): void;
  onToggleSyncSoulMarkdown(): void;
  discoveredCandidates: readonly OnboardingMemoryCandidate[];
  memorySources: readonly OnboardingMemorySourceId[];
  customMemoryNote: string;
  onToggleMemorySource(id: OnboardingMemorySourceId): void;
  onToggleAllMemorySources(): void;
  onChangeCustomMemoryNote(note: string): void;
  onAppendMemorySnippet(snippet: string): void;
  onResetSteward(): Promise<void> | void;
  isDirty: boolean;
  saving: boolean;
  savedNotice?: string;
  statusNotice?: string;
  onSaveConfig(): Promise<void> | void;
  onRevertConfig(): void;
}

export interface PersonalPanelProps {
  sessionId: string;
  workspace: string;
  automationText: string;
  onDiagnostics(): void;
  onGuideSchedule?(): void;
  activeTab?: PersonalPanelTab;
  onTabChange?(tab: PersonalPanelTab): void;
  config?: StewardConfigPanelProps;
}
type Page = 'overview' | 'todos' | 'activities';
type TodoFilter = 'all' | 'pending' | 'done';
type ActivityFilter = 'all' | 'waiting' | 'finished';
type Tone = 'neutral' | 'waiting' | 'success' | 'error';

const EFFORT_LABELS: Readonly<Record<string, string>> = {
  off: '关闭',
  low: '低',
  medium: '中',
  high: '高',
  max: '最高',
};

const EFFORT_META: Readonly<Record<string, { bars: number; hint: string; desc: string }>> = {
  off: { bars: 0, hint: '极速直出', desc: '跳过深度思考链，适合轻量闲聊、快捷待办记录与简单指令响应。' },
  low: { bars: 1, hint: '轻量推理', desc: '低延迟快速推理，适合日常待办梳理与单会话进度速览。' },
  medium: { bars: 2, hint: '均衡思考', desc: '兼顾响应速度与归纳深度，适合常规多任务盘点与日报生成。' },
  high: { bars: 3, hint: '深度归纳', desc: '深度串联跨项目会话、看板依赖与潜在阻塞风险（推荐默认）。' },
  max: { bars: 4, hint: '极限推演', desc: '全量上下文深度推演，适合复杂架构复盘、多线任务统筹与深度调研。' },
};

const PRESET_ICONS: Readonly<Record<ChatSoulPreset, IconName>> = {
  efficient: 'zap',
  warm: 'sparkle',
  direct: 'route',
  geek: 'terminal',
};

const MEMORY_SOURCE_ICONS: Readonly<Record<OnboardingMemorySourceId, IconName>> = {
  rules: 'terminal',
  sessions: 'sparkle',
  board: 'board',
};

const QUICK_MEMORY_SNIPPETS: readonly string[] = [
  '早上优先处理阻塞 PR 与逾期卡片',
  '每次盘点回复控制在 3 条核心结论以内',
  '重点关注跨仓库架构一致性与测试覆盖',
];

const css = `
.wsa-personal{--wsa-ease:cubic-bezier(.23,1,.32,1);--wsa-quick:160ms;--wsa-brand:var(--dsw-alias-brand-primary-new-colorprimary-new-color,#3b5bf6);box-sizing:border-box;display:flex;flex-direction:column;height:100%;min-height:0;min-width:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font:inherit;-webkit-font-smoothing:antialiased}
.wsa-personal *{box-sizing:border-box}
.wsa-personal :where(button,input,select,textarea){font:inherit;color:inherit}
.wsa-personal :where(button){display:inline-flex;align-items:center;justify-content:center;gap:6px;margin:0;padding:0;border:0;border-radius:6px;background:none;cursor:pointer;text-align:left}
.wsa-personal button:disabled{opacity:.45;cursor:default}
.wsa-personal p,.wsa-personal h2,.wsa-personal h3,.wsa-personal h4{margin:0}
.wsa-personal :focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}
.wsa-personal-scroll{flex:1;min-height:0;overflow:auto;padding:12px 16px 20px;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent}

/* 顶部四主 Tab 胶囊图标导航栏（参考 Muse AI 分段胶囊设计：工作概览 / 记忆库 / 技能库 / 主理配置） */
.wsa-personal-tabs-bar{flex:none;padding:10px 16px;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent);background:var(--dsw-alias-bg-base)}
.wsa-personal-tabs{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));align-items:center;padding:3px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent);background:color-mix(in srgb,var(--dsw-alias-label-primary) 5.5%,var(--dsw-alias-bg-base))}
.wsa-personal-tab{position:relative;height:28px;padding:0 6px;border-radius:999px;border:1px solid transparent;font-size:11.5px;font-weight:500;color:var(--dsw-alias-label-tertiary);justify-content:center;gap:4px;white-space:nowrap;transition:background-color var(--wsa-quick) var(--wsa-ease),color var(--wsa-quick) var(--wsa-ease),border-color var(--wsa-quick) var(--wsa-ease),box-shadow var(--wsa-quick) var(--wsa-ease)}
.wsa-personal-tab:not(:first-child)::before{content:"";position:absolute;left:-0.5px;top:50%;width:1px;height:12px;transform:translateY(-50%);background:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent);transition:opacity var(--wsa-quick) var(--wsa-ease);pointer-events:none}
.wsa-personal-tab[aria-selected="true"]::before,.wsa-personal-tab[aria-selected="true"]+.wsa-personal-tab::before{opacity:0}
.wsa-personal-tab:hover:enabled{color:var(--dsw-alias-label-primary)}
.wsa-personal-tab[aria-selected="true"]{background:var(--dsw-alias-bg-base);border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 1px 4px rgb(0 0 0 / .12),0 1px 2px rgb(0 0 0 / .06)}
.wsa-personal-tab[aria-selected="true"] .wsa-personal-tab-icon[data-accent="true"]{color:var(--wsa-brand)}
.wsa-personal-tab-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.wsa-personal-tab-badge{display:inline-flex;align-items:center;justify-content:center;min-width:15px;height:15px;padding:0 4px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);font-size:10px;font-weight:600;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;line-height:1}
.wsa-personal-tab[aria-selected="true"] .wsa-personal-tab-badge{background:color-mix(in srgb,var(--wsa-brand) 14%,transparent);color:var(--wsa-brand)}
.wsa-personal-tab-dot{flex:none;width:5.5px;height:5.5px;border-radius:50%;background:var(--dsw-alias-state-warn-primary,#f59e0b)}

/* 分区与标题 */
.wsa-personal-section{padding:10px 11px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:color-mix(in srgb, var(--dsw-alias-label-primary) 4%, var(--dsw-alias-bg-base))}
.wsa-personal-section + .wsa-personal-section{margin-top:10px}
.wsa-personal-head{display:flex;align-items:center;gap:4px;min-height:32px}
.wsa-personal-head h3{flex:1;min-width:0;font-size:13px;font-weight:600;line-height:1.4}
.wsa-personal-section-toggle{justify-content:flex-start;gap:7px;width:100%;min-height:32px;padding:0 4px;color:var(--dsw-alias-label-primary)}
.wsa-personal-section-glyph{flex:none;color:var(--dsw-alias-label-secondary)}
.wsa-personal-section-chevron{flex:none;margin-left:1px;color:var(--dsw-alias-label-tertiary)}
.wsa-personal-section-toggle[aria-expanded="false"] .wsa-personal-section-chevron{transform:rotate(-90deg)}
.wsa-personal-count{font-size:11px;font-weight:400;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.wsa-personal-add{flex:none;min-height:30px;padding:0 8px;border-radius:7px;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary-foreground);font-size:11.5px;font-weight:550}
.wsa-personal-add:disabled{opacity:.48}
.wsa-personal-section-body{padding-top:3px}
.wsa-personal-section-body .wsa-personal-row{padding-inline:4px}
.wsa-personal-section-body .wsa-personal-date{padding-inline:4px}
.wsa-personal-section-body .wsa-personal-note,.wsa-personal-empty{padding:7px 4px 5px}
.wsa-personal-empty{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55}
.wsa-personal-today-meta{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:0 6px;margin:5px 0 0;padding:4px 0 0 4px;border-top:1px solid var(--dsw-alias-border-l1)}
.wsa-personal-progress{display:inline-flex;align-items:center;gap:7px;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.wsa-personal-progress progress{appearance:none;width:34px;height:3px;overflow:hidden;border:0;border-radius:3px;background:var(--dsw-alias-border-l2);accent-color:var(--dsw-alias-label-secondary)}
.wsa-personal-progress progress::-webkit-progress-bar{background:var(--dsw-alias-border-l2)}
.wsa-personal-progress progress::-webkit-progress-value{border-radius:3px;background:var(--dsw-alias-label-secondary)}
.wsa-personal-progress progress::-moz-progress-bar{border-radius:3px;background:var(--dsw-alias-label-secondary)}
.wsa-personal-today-meta .wsa-personal-more{margin:0 0 0 auto}
.wsa-personal-spacer{flex:1}
.wsa-personal-icon{flex:none;width:28px;height:28px;border-radius:6px;color:var(--dsw-alias-label-tertiary);transition:background-color var(--wsa-quick) var(--wsa-ease),color var(--wsa-quick) var(--wsa-ease),transform var(--wsa-quick) var(--wsa-ease)}
.wsa-personal-icon:hover:enabled{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.wsa-personal-icon:active:enabled{transform:scale(.94)}

/* 行 */
.wsa-personal-list{display:flex;flex-direction:column}
.wsa-personal-row{display:flex;align-items:flex-start;gap:9px;min-width:0;min-height:34px;padding:6px 8px;border-radius:7px;transition:background-color 140ms var(--wsa-ease)}
.wsa-personal-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.wsa-personal-check{display:flex;flex:1;align-items:flex-start;gap:9px;min-width:0;cursor:pointer}
.wsa-personal-check input{position:absolute;width:16px;height:16px;margin:0;opacity:0;cursor:pointer}
.wsa-personal-check input:focus-visible{outline:none}
.wsa-personal-box{display:grid;flex:none;place-items:center;width:16px;height:16px;margin-top:1px;border:1.5px solid color-mix(in srgb, var(--dsw-alias-label-primary) 24%, transparent);border-radius:4px;background:transparent;color:var(--dsw-alias-label-primary-foreground);transition:background-color 140ms var(--wsa-ease),border-color 140ms var(--wsa-ease),transform 140ms var(--wsa-ease)}
.wsa-personal-check:hover .wsa-personal-box{border-color:color-mix(in srgb, var(--dsw-alias-label-primary) 38%, transparent)}
.wsa-personal-check:active .wsa-personal-box{transform:scale(.9)}
.wsa-personal-check input:focus-visible+.wsa-personal-box{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}
.wsa-personal-box svg{opacity:0;transform:scale(.7);transition:opacity 120ms var(--wsa-ease),transform 140ms var(--wsa-ease)}
.wsa-personal-check input:checked+.wsa-personal-box{background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary)}
.wsa-personal-check input:checked+.wsa-personal-box svg{opacity:1;transform:scale(1)}
.wsa-personal-row-text{display:flex;flex:1;flex-direction:column;gap:2px;min-width:0}
.wsa-personal-title{font-size:13px;font-weight:500;line-height:1.45;letter-spacing:.005em;overflow-wrap:anywhere}
.wsa-personal-complete{color:var(--dsw-alias-label-tertiary);text-decoration:line-through;text-decoration-thickness:1px;text-decoration-color:var(--dsw-alias-label-dimmed)}
.wsa-personal-sub{font-size:11.5px;line-height:1.45;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.wsa-personal-row-actions{display:flex;flex:none;align-items:center;gap:1px;margin:-2px -4px -2px 0;opacity:0;transition:opacity 140ms var(--wsa-ease)}
.wsa-personal-row:hover .wsa-personal-row-actions,.wsa-personal-row:focus-within .wsa-personal-row-actions{opacity:1}
@media(hover:none){.wsa-personal-row-actions{opacity:.75}}
.wsa-personal-row-actions button{height:24px;min-width:24px;padding:0 6px;border-radius:5px;font-size:11px;color:var(--dsw-alias-label-tertiary);transition:background-color var(--wsa-quick) var(--wsa-ease),color var(--wsa-quick) var(--wsa-ease),transform var(--wsa-quick) var(--wsa-ease)}
.wsa-personal-row-actions button:hover:enabled{background:var(--dsw-alias-bg-hover);color:var(--dsw-alias-label-primary)}
.wsa-personal-row-actions button:active:enabled{transform:scale(.94)}

/* 条目（定时任务、活动） */
.wsa-personal-entry{width:100%;min-height:48px;padding:7px 8px;align-items:center;justify-content:flex-start;gap:10px}
.wsa-personal-entry .wsa-personal-row-text{gap:3px}
.wsa-personal-entry time{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.wsa-personal-schedule-clock{display:flex;flex:none;flex-direction:column;align-items:center;gap:1px;width:48px;padding:4px 5px 4px 0;border-right:1px solid var(--dsw-alias-border-l1);font-variant-numeric:tabular-nums}
.wsa-personal-schedule-clock time{font-size:14px;font-weight:650;line-height:1.2;color:var(--dsw-alias-label-primary)}
.wsa-personal-schedule-clock span{font-size:10.5px;line-height:1.3;color:var(--dsw-alias-label-secondary)}
.wsa-personal-schedule-clock svg{color:var(--dsw-alias-label-secondary)}
.wsa-personal-schedule .wsa-personal-title{white-space:normal}
.wsa-personal-entry-icon{display:grid;flex:none;place-items:center;width:30px;height:30px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:color-mix(in srgb, var(--dsw-alias-label-primary) 4.5%, transparent);color:var(--dsw-alias-label-secondary);transition:border-color var(--wsa-quick) var(--wsa-ease),color var(--wsa-quick) var(--wsa-ease),background-color var(--wsa-quick) var(--wsa-ease)}
.wsa-personal-entry:hover .wsa-personal-entry-icon{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent)}
.wsa-personal-entry .wsa-personal-title{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.wsa-personal-entry-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;min-width:0}
.wsa-personal-chevron{flex:none;display:grid;place-items:center;color:var(--dsw-alias-label-caption);opacity:.85}
.wsa-personal-activity-meta{display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0;width:100%}
.wsa-personal-worker{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-tertiary)}
.wsa-personal-status{margin-left:auto;flex:none;display:inline-flex;align-items:center;justify-content:flex-end;gap:5px;font-size:11px;font-weight:500;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.wsa-personal-status::before{content:"";flex:none;width:5.5px;height:5.5px;border-radius:50%;background:var(--dsw-alias-label-caption)}
.wsa-personal-status[data-tone="waiting"]{color:var(--dsw-alias-state-warn-primary)}
.wsa-personal-status[data-tone="waiting"]::before{background:var(--dsw-alias-state-warn-primary)}
.wsa-personal-status[data-tone="success"]{color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 88%, var(--dsw-alias-label-secondary))}
.wsa-personal-status[data-tone="success"]::before{background:var(--dsw-alias-state-success-primary)}
.wsa-personal-status[data-tone="error"]{color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 90%, var(--dsw-alias-label-secondary))}
.wsa-personal-status[data-tone="error"]::before{background:var(--dsw-alias-state-error-primary)}
.wsa-personal-date{display:flex;align-items:center;gap:8px;padding:9px 0 3px;font-size:11px;font-weight:500;letter-spacing:.02em;color:var(--dsw-alias-label-tertiary)}
.wsa-personal-date::after{content:"";flex:1;height:1px;background:var(--dsw-alias-border-l1)}
.wsa-personal-more{justify-content:flex-start;gap:2px;min-height:28px;margin:3px 0 0;padding:0 4px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.wsa-personal-more svg{opacity:.7}

/* 长周期目标 */
.wsa-personal-goal{display:flex;flex-direction:column;gap:6px;padding:6px 4px 2px}
.wsa-personal-goal+.wsa-personal-goal{margin-top:6px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1)}
.wsa-personal-goal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;min-width:0}
.wsa-personal-goal-actions{display:flex;flex:none;align-items:center;gap:4px}
.wsa-personal-goal-title{flex:1;min-width:0;font-size:13px;font-weight:550;line-height:1.45;letter-spacing:.005em;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.wsa-personal-goal-desc{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.wsa-personal-goal-steps{display:flex;flex-direction:column;gap:2px;margin-top:1px}
.wsa-personal-goal-step{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:28px;padding:3px 6px;margin:0 -6px;border-radius:6px;transition:background-color 140ms var(--wsa-ease)}
.wsa-personal-goal-step:hover{background:var(--dsw-alias-interactive-bg-hover)}
.wsa-personal-goal-step-main{display:flex;flex:1;align-items:center;gap:8px;min-width:0}
.wsa-personal-goal-step-num{display:grid;flex:none;place-items:center;width:16px;height:16px;border:1.5px solid color-mix(in srgb,var(--dsw-alias-label-primary) 22%,transparent);border-radius:4px;font-size:10px;font-weight:600;line-height:1;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.wsa-personal-goal-step[data-status="running"] .wsa-personal-goal-step-num{border-color:var(--wsa-brand);background:color-mix(in srgb,var(--wsa-brand) 12%,transparent);color:var(--wsa-brand)}
.wsa-personal-goal-step[data-status="completed"] .wsa-personal-goal-step-num{border-color:var(--dsw-alias-label-primary);background:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary-foreground)}
.wsa-personal-goal-step[data-status="failed"] .wsa-personal-goal-step-num{border-color:var(--dsw-alias-state-error-primary,#ef4444);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 12%,transparent);color:var(--dsw-alias-state-error-primary,#ef4444)}
.wsa-personal-goal-step-title{flex:1;min-width:0;font-size:12.5px;font-weight:450;line-height:1.4;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wsa-personal-goal-step[data-status="completed"] .wsa-personal-goal-step-title{color:var(--dsw-alias-label-tertiary);text-decoration:line-through;text-decoration-thickness:1px;text-decoration-color:var(--dsw-alias-label-dimmed)}
.wsa-personal-chip{flex:none;display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 3.5%,var(--dsw-alias-bg-base));font-size:11px;font-weight:500;color:var(--dsw-alias-label-secondary);white-space:nowrap;transition:background-color var(--wsa-quick) var(--wsa-ease),color var(--wsa-quick) var(--wsa-ease),border-color var(--wsa-quick) var(--wsa-ease),transform var(--wsa-quick) var(--wsa-ease)}
.wsa-personal-chip:hover:enabled{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.wsa-personal-chip:active:enabled{transform:scale(.96)}
.wsa-personal-goal-auto{display:inline-flex;align-items:center;gap:3.5px;margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.wsa-personal-goal .wsa-personal-today-meta{margin-top:2px;padding-left:0}

/* 页脚 */
.wsa-personal-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;flex:none;padding:6px 14px 6px 18px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11.5px;line-height:1.4;color:var(--dsw-alias-label-secondary)}
.wsa-personal-footer-status{display:inline-flex;align-items:center;gap:6px;min-width:0}
.wsa-personal-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-caption)}
.wsa-personal-dot[data-tone="success"]{background:var(--dsw-alias-state-success-primary)}
.wsa-personal-footer-link{flex:none;gap:2px;min-height:26px;padding:0 6px;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
@media(hover:hover) and (pointer:fine){
  .wsa-personal :is(.wsa-personal-section-toggle,.wsa-personal-more,.wsa-personal-footer-link):hover:enabled{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
  .wsa-personal-add:hover:enabled{opacity:.86}
  .wsa-personal :is(.wsa-personal-section-toggle,.wsa-personal-more,.wsa-personal-footer-link,.wsa-personal-add){transition:transform 120ms var(--wsa-ease)}
  .wsa-personal :is(.wsa-personal-section-toggle,.wsa-personal-more,.wsa-personal-footer-link,.wsa-personal-add):active:enabled:not(:focus-visible){transform:scale(.97)}
}

/* 子页 */
.wsa-personal-subhead{display:flex;flex:none;align-items:center;gap:4px;padding:11px 16px 11px 11px;border-bottom:1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)}
.wsa-personal-subhead h2{font-size:14px;font-weight:600;line-height:1.4;letter-spacing:.01em;white-space:nowrap}
.wsa-personal-subhead .wsa-personal-spacer{margin-left:4px}
.wsa-personal-body{flex:1;min-height:0;overflow:auto;padding:0 16px 24px;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent}
.wsa-personal-filter{display:inline-flex;gap:2px;margin:14px 0 2px;padding:2px;border-radius:7px;background:color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent)}
.wsa-personal-filter button{height:24px;padding:0 10px;border-radius:5px;font-size:11.5px;color:var(--dsw-alias-label-secondary);transition:background-color var(--wsa-quick) var(--wsa-ease),color var(--wsa-quick) var(--wsa-ease),transform var(--wsa-quick) var(--wsa-ease)}
.wsa-personal-filter button:hover:enabled{color:var(--dsw-alias-label-primary)}
.wsa-personal-filter button:active:enabled{transform:scale(.97)}
.wsa-personal-filter button[aria-pressed="true"]{background:color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent);color:var(--dsw-alias-label-primary);font-weight:500}
.wsa-personal-group{margin-top:16px}
.wsa-personal-group>h3{display:flex;align-items:baseline;gap:6px;padding:0 8px 6px;font-size:11px;font-weight:500;letter-spacing:.02em;color:var(--dsw-alias-label-tertiary)}
.wsa-personal-group>h3[data-tone="warn"]{color:var(--dsw-alias-state-warn-label)}
.wsa-personal-group>h3 span{font-weight:400;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}
.wsa-personal-group .wsa-personal-row{margin:0 -8px}

/* 表单与提示 */
.wsa-personal-form{display:flex;flex-direction:column;gap:8px;padding:12px 0 2px}
.wsa-personal-form input,.wsa-personal-form select{flex:none;width:100%;min-width:0;height:32px;padding:0 9px;border:1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent);border-radius:7px;background:color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent);color:var(--dsw-alias-label-primary);font-size:12px;transition:border-color var(--wsa-quick) var(--wsa-ease),background-color var(--wsa-quick) var(--wsa-ease)}
.wsa-personal-form input::placeholder{color:var(--dsw-alias-label-caption)}
.wsa-personal-form input:focus-visible,.wsa-personal-form select:focus-visible{outline:none;border-color:var(--dsw-alias-border-l3);box-shadow:0 0 0 3px var(--dsw-alias-interactive-bg-hover)}
.wsa-personal-form-actions{display:flex;justify-content:flex-end;gap:6px}
.wsa-personal-form button{flex:none;height:28px;padding:0 11px;border:1px solid transparent;border-radius:6px;background:transparent;font-size:12px;color:var(--dsw-alias-label-secondary);transition:background-color var(--wsa-quick) var(--wsa-ease),color var(--wsa-quick) var(--wsa-ease),border-color var(--wsa-quick) var(--wsa-ease),opacity var(--wsa-quick) var(--wsa-ease),transform var(--wsa-quick) var(--wsa-ease)}
.wsa-personal-form button:hover:enabled{background:var(--dsw-alias-bg-hover);color:var(--dsw-alias-label-primary)}
.wsa-personal-form button:active:enabled{transform:scale(.97)}
.wsa-personal-form button:disabled{opacity:.42}
.wsa-personal-form button[type="submit"],.wsa-personal-form button:not([type="button"]){border-color:transparent;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary-foreground);font-weight:500}
.wsa-personal-form button[type="submit"]:hover:enabled,.wsa-personal-form button:not([type="button"]):hover:enabled{opacity:.88;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary-foreground)}
.wsa-personal-form-inline{flex:1;flex-direction:row;flex-wrap:nowrap;align-items:center;gap:6px;padding:0}
.wsa-personal-form-inline input{flex:1;width:auto;height:28px}
.wsa-personal-form-inline button{height:28px;padding:0 9px}
.wsa-personal-note{padding:6px 0 2px;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.wsa-personal-note button{margin-left:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary);text-decoration:underline;text-underline-offset:2px}
.wsa-personal-note button:hover:enabled{color:var(--dsw-alias-label-primary)}
.wsa-personal-notice{display:flex;flex:none;align-items:center;gap:8px;padding:8px 16px;border-bottom:1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);background:var(--dsw-alias-bg-layer-1);font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.wsa-personal-notice span{min-width:0;overflow-wrap:anywhere}
.wsa-personal-notice button{flex:none;font-size:11.5px;color:var(--dsw-alias-label-tertiary);text-decoration:underline;text-underline-offset:2px}
.wsa-personal-state{padding:20px 16px;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-tertiary)}
.wsa-personal-skel{padding:8px 4px 6px;display:flex;flex-direction:column;gap:7px}
.wsa-personal-skel-bar{height:8px;border-radius:4px;background:color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent)}
.wsa-personal-skel-bar[data-short="true"]{width:64%}

/* 详情弹窗 */
.wsa-personal-detail-backdrop{position:fixed;inset:0;z-index:110;display:flex;align-items:center;justify-content:center;padding:24px;background:rgb(0 0 0 / .46);animation:wsa-personal-fade 160ms var(--wsa-ease)}
.wsa-personal .wsa-personal-dialog:focus,.wsa-personal .wsa-personal-dialog:focus-visible{outline:none}
.wsa-personal-dialog{display:flex;flex-direction:column;width:min(720px,100%);height:min(82vh,580px);max-height:calc(100vh - 48px);overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 32px 80px -24px rgb(0 0 0 / .6),0 2px 6px rgb(0 0 0 / .18);color:var(--dsw-alias-label-primary);animation:wsa-personal-dialog-in 200ms var(--wsa-ease)}
.wsa-personal-dialog-head{display:flex;flex:none;flex-direction:column;gap:8px;padding:16px 20px 14px;border-bottom:1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)}
.wsa-personal-dialog-top{display:flex;align-items:center;justify-content:space-between;gap:12px}
.wsa-personal-dialog-top-right{display:flex;align-items:center;gap:8px;flex:none}
.wsa-personal-dialog-kicker{display:flex;align-items:center;gap:5px;font-size:11.5px;font-weight:500;letter-spacing:.02em;color:var(--dsw-alias-label-tertiary)}
.wsa-personal-dialog-title-row{display:flex;align-items:baseline;justify-content:space-between;gap:16px;flex-wrap:wrap}
.wsa-personal-dialog-head h2{flex:1;min-width:180px;margin:0;font-size:18px;font-weight:600;line-height:1.35;letter-spacing:-.01em;overflow-wrap:anywhere}
.wsa-personal-dialog-meta{display:flex;flex:none;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}
.wsa-personal-dialog-meta span+span::before{content:"·";margin-right:6px;color:var(--dsw-alias-label-dimmed)}
.wsa-personal-dialog-close{margin:-2px -6px -2px 0}
.wsa-personal-pill{flex:none;display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent);font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.wsa-personal-pill::before{content:"";flex:none;width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-label-caption)}
.wsa-personal-pill[data-tone="running"]{color:var(--dsw-alias-label-primary);border-color:color-mix(in srgb,var(--wsa-brand) 28%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--wsa-brand) 8%,transparent)}
.wsa-personal-pill[data-tone="running"]::before{background:var(--wsa-brand)}
.wsa-personal-pill[data-tone="waiting"]::before{background:var(--dsw-alias-state-warn-primary)}
.wsa-personal-pill[data-tone="success"]::before{background:var(--dsw-alias-state-success-primary)}
.wsa-personal-pill[data-tone="error"]::before{background:var(--dsw-alias-state-error-primary)}
.wsa-personal-dialog-body{display:grid;flex:1;grid-template-columns:220px minmax(0,1fr);min-height:0}
.wsa-personal-timeline{min-height:0;overflow:auto;padding:14px 10px;border-right:1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent}
.wsa-personal-timeline>h3{padding:0 6px 2px;font-size:11px;font-weight:500;letter-spacing:.02em;color:var(--dsw-alias-label-tertiary)}
.wsa-personal-steps{position:relative;display:flex;flex-direction:column;gap:2px;margin-top:8px}
.wsa-personal-steps::before{content:"";position:absolute;top:15px;bottom:25px;left:14px;width:1px;background:var(--dsw-alias-border-l2)}
.wsa-personal-step{position:relative;display:flex;align-items:flex-start;justify-content:flex-start;gap:10px;width:100%;padding:7px 6px;border-radius:7px;text-align:left;color:var(--dsw-alias-label-secondary);transition:background-color var(--wsa-quick) var(--wsa-ease),color var(--wsa-quick) var(--wsa-ease)}
.wsa-personal-step:hover:enabled{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.wsa-personal-step[aria-current="step"]{background:color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent);color:var(--dsw-alias-label-primary)}
.wsa-personal-marker{position:relative;z-index:1;display:grid;flex:none;place-items:center;width:17px;height:17px;margin-top:1px;border:1px solid var(--dsw-alias-border-l2);border-radius:50%;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary-foreground)}
.wsa-personal-step[aria-current="step"] .wsa-personal-marker{border-color:var(--dsw-alias-label-primary);background:var(--dsw-alias-label-primary)}
.wsa-personal-step-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.wsa-personal-step-title{font-size:12px;font-weight:500;line-height:1.4;overflow-wrap:anywhere}
.wsa-personal-step time{font-size:10.5px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}
.wsa-personal-result{min-height:0;overflow:auto;padding:18px 22px;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent}
.wsa-personal-result time{font-size:11px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}
.wsa-personal-result h3{margin:5px 0 10px;font-size:15px;font-weight:600;line-height:1.4}
.wsa-personal-result p{font-size:13px;line-height:1.75;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
.wsa-personal-result-empty{font-size:12.5px!important;line-height:1.7!important;color:var(--dsw-alias-label-tertiary)!important}
.wsa-personal-dialog-footer{display:flex;flex:none;align-items:center;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)}
.wsa-personal .wsa-personal-button{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border:1px solid transparent;border-radius:7px;background:color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);font-size:12px;color:var(--dsw-alias-label-primary);transition:background-color var(--wsa-quick) var(--wsa-ease),color var(--wsa-quick) var(--wsa-ease),border-color var(--wsa-quick) var(--wsa-ease),transform var(--wsa-quick) var(--wsa-ease)}
.wsa-personal .wsa-personal-button:hover:enabled{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}
.wsa-personal .wsa-personal-button:active:enabled{transform:scale(.97)}
.wsa-personal .wsa-personal-button:disabled{opacity:.5}
.wsa-personal-dot[data-tone="waiting"]{background:var(--dsw-alias-state-warn-primary,#f59e0b)}

/* 二级轻量水平导航栏与单面板卡片样式（与工作概览保持一致的 16px 左右边距与卡片宽度） */
.wsa-cfg-subtabs-bar{flex:none;padding:0 16px;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent);background:var(--dsw-alias-bg-base)}
.wsa-cfg-subtabs{display:flex;align-items:center;justify-content:space-between;gap:2px}
.wsa-cfg-subtab{position:relative;flex:1;justify-content:center;gap:4px;height:34px;padding:0 4px;border-radius:0;border:0;background:transparent;font-size:11.5px;font-weight:500;color:var(--dsw-alias-label-tertiary);white-space:nowrap;transition:color var(--wsa-quick) var(--wsa-ease)}
.wsa-cfg-subtab:hover:enabled{color:var(--dsw-alias-label-primary)}
.wsa-cfg-subtab[aria-selected="true"]{color:var(--dsw-alias-label-primary);font-weight:600}
.wsa-cfg-subtab[aria-selected="true"]::after{content:"";position:absolute;left:6px;right:6px;bottom:0;height:2px;border-radius:2px 2px 0 0;background:var(--wsa-brand)}
.wsa-cfg-pane{display:flex;flex-direction:column;gap:12px;padding:0;animation:wsa-personal-fade 140ms var(--wsa-ease)}
.wsa-cfg-card{display:flex;flex-direction:column;gap:12px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--dsw-alias-bg-base))}
.wsa-cfg-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding-bottom:10px;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent)}
.wsa-cfg-card-title-group{display:flex;flex-direction:column;gap:2px;min-width:0}
.wsa-cfg-card-title{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);line-height:1.35}
.wsa-cfg-card-title svg{color:var(--wsa-brand);flex:none}
.wsa-cfg-card-desc{font-size:11px;line-height:1.45;color:var(--dsw-alias-label-tertiary)}
.wsa-cfg-body{display:flex;flex-direction:column;gap:12px}
.wsa-cfg-tag{flex:none;display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-label-primary) 3.5%,var(--dsw-alias-bg-base));font-size:11px;font-weight:500;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.wsa-cfg-tag[data-tone="success"]{color:var(--dsw-alias-state-success-primary,#10b981);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#10b981) 30%,var(--dsw-alias-border-l1))}
.wsa-cfg-identity{display:flex;align-items:center;gap:12px;padding:10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.wsa-cfg-avatar-wrap{position:relative;flex:none}
.wsa-cfg-avatar-btn{width:52px;height:52px;border-radius:13px;border:1.5px solid color-mix(in srgb,var(--wsa-brand) 34%,var(--dsw-alias-border-l1));background:radial-gradient(circle at 30% 25%,color-mix(in srgb,var(--wsa-brand) 16%,transparent),transparent 70%),color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--dsw-alias-bg-base));overflow:hidden;padding:0;justify-content:center;transition:border-color var(--wsa-quick) var(--wsa-ease),transform var(--wsa-quick) var(--wsa-ease)}
.wsa-cfg-avatar-btn:hover:enabled{border-color:var(--wsa-brand);transform:translateY(-1px)}
.wsa-cfg-camera-btn{position:absolute;right:-4px;bottom:-4px;width:21px;height:21px;border-radius:999px;border:1.5px solid var(--dsw-alias-bg-base);background:var(--wsa-brand);color:#fff;padding:0;justify-content:center;box-shadow:0 2px 6px rgb(0 0 0 / .24)}
.wsa-cfg-avatar-copy{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
.wsa-cfg-avatar-title{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary)}
.wsa-cfg-avatar-sub{font-size:11px;line-height:1.4;color:var(--dsw-alias-label-tertiary)}
.wsa-cfg-avatar-actions{display:flex;align-items:center;gap:6px;margin-top:3px}
.wsa-cfg-name-stack{display:flex;flex-direction:column;gap:10px}
.wsa-cfg-live-card{display:flex;flex-direction:column;gap:8px;padding:10px 11px;border-radius:9px;border:1px solid color-mix(in srgb,var(--wsa-brand) 22%,var(--dsw-alias-border-l1));background:linear-gradient(135deg,color-mix(in srgb,var(--wsa-brand) 7%,var(--dsw-alias-bg-base)),var(--dsw-alias-bg-base))}
.wsa-cfg-live-quote{font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary)}
.wsa-cfg-live-quote strong{color:var(--dsw-alias-label-primary);font-weight:600}
.wsa-cfg-cap-list{display:flex;flex-direction:column;gap:6px}
.wsa-cfg-cap-item{display:flex;align-items:flex-start;gap:8px;padding:8px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.wsa-cfg-cap-item svg{flex:none;margin-top:2px;color:var(--wsa-brand)}
.wsa-cfg-cap-text{display:flex;flex-direction:column;gap:1px;min-width:0}
.wsa-cfg-cap-title{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-primary)}
.wsa-cfg-cap-desc{font-size:10.5px;line-height:1.4;color:var(--dsw-alias-label-tertiary)}
.wsa-cfg-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.wsa-cfg-label-row{display:flex;align-items:center;justify-content:space-between;gap:6px}
.wsa-cfg-label{font-size:11.5px;font-weight:550;color:var(--dsw-alias-label-secondary);line-height:1.35}
.wsa-cfg-input,.wsa-cfg-select,.wsa-cfg-textarea{width:100%;min-width:0;border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 12%,var(--dsw-alias-border-l1));border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12px;transition:border-color var(--wsa-quick) var(--wsa-ease),box-shadow var(--wsa-quick) var(--wsa-ease)}
.wsa-cfg-input{height:32px;padding:0 10px}
.wsa-cfg-select{height:34px;padding:0 28px 0 10px;font-weight:500;cursor:pointer;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 16 16' fill='none' stroke='%2394a3b8' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m4 6 4 4 4-4'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 9px center}
.wsa-cfg-textarea{min-height:76px;padding:8px 10px;line-height:1.55;resize:vertical}
.wsa-cfg-textarea[data-soul="true"]{min-height:142px;padding:9px 11px;line-height:1.58;letter-spacing:.01em}
.wsa-cfg-soul-subbox{display:flex;flex-direction:column;gap:6px;margin-top:4px;padding:9px 10px;border-radius:9px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 8%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-label-primary) 2.5%,var(--dsw-alias-bg-base))}
.wsa-cfg-soul-subhead{display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap}
.wsa-cfg-soul-sublabel{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.wsa-cfg-soul-pill{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:999px;font-size:10px;font-weight:500;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-tertiary)}
.wsa-cfg-soul-pill[data-custom="true"]{color:var(--wsa-brand);border-color:color-mix(in srgb,var(--wsa-brand) 36%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--wsa-brand) 8%,var(--dsw-alias-bg-base))}
.wsa-cfg-trait-rules{display:flex;flex-direction:column;gap:5px;margin:0;padding:0;list-style:none}
.wsa-cfg-trait-rule{display:flex;align-items:flex-start;gap:6px;font-size:11px;line-height:1.48;color:var(--dsw-alias-label-secondary)}
.wsa-cfg-trait-rule-dot{flex:none;width:5px;height:5px;margin-top:5.5px;border-radius:999px;background:var(--wsa-brand)}
.wsa-cfg-trait-rule strong{color:var(--dsw-alias-label-primary);font-weight:600}
.wsa-cfg-trait-empty{font-size:11px;line-height:1.45;color:var(--dsw-alias-label-tertiary)}
.wsa-cfg-soul-subactions{display:inline-flex;align-items:center;gap:4px;flex:none}
.wsa-cfg-trait-md-editor{min-height:132px;padding:9px 11px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:11.5px;line-height:1.58}
.wsa-cfg-soul-compose{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;padding:7px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.wsa-cfg-soul-compose-parts{display:flex;align-items:center;gap:4px;flex-wrap:wrap;min-width:0}
.wsa-cfg-input:focus,.wsa-cfg-select:focus,.wsa-cfg-textarea:focus{outline:none;border-color:var(--wsa-brand);box-shadow:0 0 0 2.5px color-mix(in srgb,var(--wsa-brand) 18%,transparent)}
.wsa-cfg-effort-seg{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;padding:3px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,var(--dsw-alias-bg-base))}
.wsa-cfg-effort-btn{flex-direction:column;justify-content:center;gap:3px;height:44px;padding:4px 4px;border:1px solid transparent;border-radius:6px;font-size:11.5px;font-weight:500;color:var(--dsw-alias-label-secondary);transition:background-color var(--wsa-quick) var(--wsa-ease),color var(--wsa-quick) var(--wsa-ease),border-color var(--wsa-quick) var(--wsa-ease)}
.wsa-cfg-effort-btn:hover:enabled{color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--dsw-alias-bg-base))}
.wsa-cfg-effort-btn[data-active="true"]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-weight:600;border-color:color-mix(in srgb,var(--wsa-brand) 50%,var(--dsw-alias-border-l1));box-shadow:0 3px 10px -4px color-mix(in srgb,var(--wsa-brand) 36%,transparent)}
.wsa-cfg-bars{display:inline-flex;align-items:flex-end;gap:2px;height:9px}
.wsa-cfg-bar{width:2.5px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent)}
.wsa-cfg-bar:nth-child(1){height:3.5px}
.wsa-cfg-bar:nth-child(2){height:5.5px}
.wsa-cfg-bar:nth-child(3){height:7.5px}
.wsa-cfg-bar:nth-child(4){height:9px}
.wsa-cfg-bar[data-lit="true"]{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 70%,transparent)}
.wsa-cfg-effort-btn[data-active="true"] .wsa-cfg-bar[data-lit="true"]{background:var(--wsa-brand)}
.wsa-cfg-effort-desc{padding:8px 10px;border-radius:8px;border:1px solid color-mix(in srgb,var(--wsa-brand) 20%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--wsa-brand) 5%,var(--dsw-alias-bg-base));font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.wsa-cfg-effort-desc strong{color:var(--dsw-alias-label-primary);font-weight:600}
.wsa-cfg-presets{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}
.wsa-cfg-preset{flex-direction:column;align-items:stretch;justify-content:flex-start;gap:4px;padding:9px 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);transition:border-color var(--wsa-quick) var(--wsa-ease),background-color var(--wsa-quick) var(--wsa-ease)}
.wsa-cfg-preset:hover:enabled{background:var(--dsw-alias-interactive-bg-hover)}
.wsa-cfg-preset[data-selected="true"]{border-color:color-mix(in srgb,var(--wsa-brand) 62%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--wsa-brand) 7%,var(--dsw-alias-bg-base))}
.wsa-cfg-preset-head{display:flex;align-items:center;justify-content:space-between;gap:4px;width:100%;font-size:12px;font-weight:600}
.wsa-cfg-preset-title{display:inline-flex;align-items:center;gap:5px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wsa-cfg-preset-title svg{flex:none;color:var(--dsw-alias-label-secondary)}
.wsa-cfg-preset[data-selected="true"] .wsa-cfg-preset-title svg{color:var(--wsa-brand)}
.wsa-cfg-preset-dot{width:6px;height:6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);flex:none}
.wsa-cfg-preset[data-selected="true"] .wsa-cfg-preset-dot{border-color:var(--wsa-brand);background:var(--wsa-brand)}
.wsa-cfg-preset-sub{font-size:10.5px;color:var(--dsw-alias-label-tertiary);line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wsa-cfg-traits{display:flex;flex-wrap:wrap;gap:5px}
.wsa-cfg-trait{height:25px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);font-size:11px;font-weight:500;color:var(--dsw-alias-label-secondary);transition:border-color var(--wsa-quick) var(--wsa-ease),background-color var(--wsa-quick) var(--wsa-ease),color var(--wsa-quick) var(--wsa-ease)}
.wsa-cfg-trait:hover:enabled{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.wsa-cfg-trait[data-selected="true"]{border-color:color-mix(in srgb,var(--wsa-brand) 55%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--wsa-brand) 11%,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary);font-weight:600}
.wsa-cfg-link{flex:none;height:22px;padding:0 6px;border-radius:5px;font-size:11px;font-weight:500;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.wsa-cfg-link:hover:enabled{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.wsa-cfg-checkall{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 6px;border-radius:6px;font-size:11.5px;font-weight:500;color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none;user-select:none;transition:background-color var(--wsa-quick) var(--wsa-ease),color var(--wsa-quick) var(--wsa-ease)}
.wsa-cfg-checkall:hover:enabled{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.wsa-cfg-checkall[aria-checked="true"],.wsa-cfg-checkall[aria-checked="mixed"]{color:var(--dsw-alias-label-primary)}
.wsa-cfg-checkall[aria-checked="true"] .wsa-cfg-mem-check,.wsa-cfg-checkall[aria-checked="mixed"] .wsa-cfg-mem-check{border-color:var(--wsa-brand);background:var(--wsa-brand);color:#fff}
.wsa-cfg-switch-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1)}
.wsa-cfg-switch{position:relative;width:34px;height:19px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-label-primary) 16%,var(--dsw-alias-bg-base));padding:0;flex:none;transition:background-color var(--wsa-quick) var(--wsa-ease)}
.wsa-cfg-switch[aria-checked="true"]{background:var(--wsa-brand);border-color:transparent}
.wsa-cfg-switch-thumb{position:absolute;top:1.5px;left:1.5px;width:14px;height:14px;border-radius:999px;background:#fff;transition:transform var(--wsa-quick) var(--wsa-ease)}
.wsa-cfg-switch[aria-checked="true"] .wsa-cfg-switch-thumb{transform:translateX(15px)}
.wsa-cfg-soul-preview{margin:4px 0 0;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;max-height:160px;overflow:auto}
.wsa-cfg-mem-list{display:flex;flex-direction:column;gap:7px}
.wsa-cfg-mem-item{display:flex;flex-direction:column;align-items:stretch;gap:5px;width:100%;padding:10px 11px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);font-size:12px;color:var(--dsw-alias-label-primary);text-align:left;transition:border-color var(--wsa-quick) var(--wsa-ease),background-color var(--wsa-quick) var(--wsa-ease)}
.wsa-cfg-mem-item:hover:enabled{background:var(--dsw-alias-interactive-bg-hover)}
.wsa-cfg-mem-item[data-selected="true"]{border-color:color-mix(in srgb,var(--wsa-brand) 52%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--wsa-brand) 6%,var(--dsw-alias-bg-base))}
.wsa-cfg-mem-top{display:flex;align-items:center;justify-content:space-between;gap:6px;width:100%}
.wsa-cfg-mem-left{display:flex;align-items:center;gap:6px;min-width:0;flex:1}
.wsa-cfg-mem-check{width:15px;height:15px;border-radius:4px;border:1.5px solid var(--dsw-alias-border-l2);display:inline-flex;align-items:center;justify-content:center;flex:none;font-size:10px;font-weight:700;line-height:1;color:transparent;background:var(--dsw-alias-bg-base);transition:background-color var(--wsa-quick) var(--wsa-ease),border-color var(--wsa-quick) var(--wsa-ease),color var(--wsa-quick) var(--wsa-ease)}
.wsa-cfg-mem-item[data-selected="true"] .wsa-cfg-mem-check{border-color:var(--wsa-brand);background:var(--wsa-brand);color:#fff}
.wsa-cfg-mem-title{font-size:12px;font-weight:600;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wsa-cfg-mem-badge{flex:none;display:inline-flex;align-items:center;gap:3.5px;height:19px;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-label-primary) 3.5%,var(--dsw-alias-bg-base));font-size:10.5px;font-weight:500;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.wsa-cfg-mem-desc{padding-left:21px;font-size:11px;line-height:1.48;color:var(--dsw-alias-label-tertiary)}
.wsa-cfg-snippets{display:flex;flex-wrap:wrap;gap:5px;margin-top:2px}
.wsa-cfg-snippet{height:22px;padding:0 8px;border-radius:999px;border:1px dashed var(--dsw-alias-border-l2);font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.wsa-cfg-snippet:hover:enabled{color:var(--dsw-alias-label-primary);border-color:var(--wsa-brand)}
.wsa-cfg-danger-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.wsa-cfg-danger-btn{height:26px;padding:0 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);font-size:11.5px;color:var(--dsw-alias-state-error-primary,#ef4444)}
.wsa-cfg-danger-btn:hover:enabled{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 10%,var(--dsw-alias-bg-base))}
.wsa-cfg-danger-btn[data-confirm="true"]{background:var(--dsw-alias-state-error-primary,#ef4444);border-color:transparent;color:#fff;font-weight:600}
.wsa-cfg-footer-actions{display:flex;align-items:center;gap:6px;flex:none}
.wsa-cfg-foot-btn{height:25px;padding:0 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);font-size:11.5px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.wsa-cfg-foot-btn:hover:enabled{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.wsa-cfg-foot-btn[data-primary="true"]{background:var(--wsa-brand);border-color:transparent;color:#fff;font-weight:600}
.wsa-cfg-foot-btn[data-primary="true"]:hover:enabled{opacity:.92}

/* 记忆库与技能库二级轻量筛选栏及卡片样式 */
.wsa-sm-subbar{flex:none;display:flex;align-items:center;justify-content:space-between;gap:6px;padding:6px 16px;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent);background:var(--dsw-alias-bg-base)}
.wsa-sm-pills{display:flex;align-items:center;gap:3px;min-width:0;flex:1}
.wsa-sm-pill{height:24px;padding:0 7px;border-radius:6px;border:1px solid transparent;font-size:11px;font-weight:500;color:var(--dsw-alias-label-tertiary);justify-content:center;white-space:nowrap;transition:background-color var(--wsa-quick) var(--wsa-ease),color var(--wsa-quick) var(--wsa-ease),border-color var(--wsa-quick) var(--wsa-ease)}
.wsa-sm-pill:hover:enabled{color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--dsw-alias-bg-base))}
.wsa-sm-pill[data-active="true"]{border-color:color-mix(in srgb,var(--wsa-brand) 36%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--wsa-brand) 10%,var(--dsw-alias-bg-base));color:var(--wsa-brand);font-weight:600}
.wsa-sm-src-btn{flex:none;height:24px;padding:0 7px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,var(--dsw-alias-bg-base));font-size:11px;font-weight:500;color:var(--dsw-alias-label-secondary);gap:4px;white-space:nowrap}
.wsa-sm-src-btn:hover:enabled{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.wsa-sm-toolbar{display:flex;align-items:center;gap:6px}
.wsa-sm-toolbar .wsa-cfg-input{flex:1}
.wsa-sm-toolbar .wsa-cfg-select{width:108px;flex:none;height:32px;font-size:11.5px}
.wsa-sm-list{display:flex;flex-direction:column;gap:8px}
.wsa-sm-item{display:flex;flex-direction:column;gap:6px;padding:10px 11px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);transition:border-color var(--wsa-quick) var(--wsa-ease)}
.wsa-sm-item:hover{border-color:color-mix(in srgb,var(--wsa-brand) 42%,var(--dsw-alias-border-l1))}
.wsa-sm-item-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.wsa-sm-item-badges{display:flex;align-items:center;flex-wrap:wrap;gap:4px;min-width:0;flex:1}
.wsa-sm-scope{display:inline-flex;align-items:center;gap:3px;height:19px;padding:0 6px;border-radius:5px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--dsw-alias-bg-base));font-size:10.5px;font-weight:550;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.wsa-sm-scope[data-global="true"]{border-color:color-mix(in srgb,var(--wsa-brand) 38%,var(--dsw-alias-border-l1));color:var(--wsa-brand);background:color-mix(in srgb,var(--wsa-brand) 8%,var(--dsw-alias-bg-base))}
.wsa-sm-cat{display:inline-flex;align-items:center;height:19px;padding:0 6px;border-radius:5px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent);font-size:10.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.wsa-sm-item-title{font-size:12.5px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.wsa-sm-item-body{font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
.wsa-sm-item-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:2px;font-size:10.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.wsa-sm-pin-btn{height:21px;padding:0 7px;border-radius:5px;border:1px solid var(--dsw-alias-border-l1);font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.wsa-sm-pin-btn[data-pinned="true"]{border-color:color-mix(in srgb,var(--wsa-brand) 50%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--wsa-brand) 10%,var(--dsw-alias-bg-base));color:var(--wsa-brand);font-weight:600}
.wsa-sm-del-btn{width:21px;height:21px;border-radius:5px;font-size:11px;color:var(--dsw-alias-label-tertiary);justify-content:center}
.wsa-sm-del-btn:hover:enabled{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 12%,transparent);color:var(--dsw-alias-state-error-primary,#ef4444)}

/* 插件空间主次级视图样式 */
.wsa-plugin-toolbar{display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap}
.wsa-plugin-icon-btn{flex:none;width:28px;height:28px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);justify-content:center;transition:border-color var(--wsa-quick) var(--wsa-ease),background-color var(--wsa-quick) var(--wsa-ease),color var(--wsa-quick) var(--wsa-ease),transform var(--wsa-quick) var(--wsa-ease)}
.wsa-plugin-icon-btn:hover:enabled{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.wsa-plugin-icon-btn:active:enabled{transform:scale(.94)}
.wsa-plugin-icon-btn[data-primary="true"]{background:var(--wsa-brand);border-color:transparent;color:#fff}
.wsa-plugin-icon-btn[data-primary="true"]:hover:enabled{opacity:.9;background:var(--wsa-brand);color:#fff}
.wsa-plugin-title-stack{display:flex;flex-direction:column;align-items:flex-start;gap:3px;min-width:0;flex:1}
.wsa-plugin-pkg{display:inline-block;max-width:100%;padding:1px 6px;border-radius:4px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent);font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:10px;line-height:1.45;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wsa-plugin-caps{display:flex;align-items:center;flex-wrap:wrap;gap:4px;padding-top:6px;border-top:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent)}
.wsa-plugin-cap{display:inline-flex;align-items:center;gap:3.5px;height:19px;padding:0 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-label-primary) 3.5%,var(--dsw-alias-bg-base));font-size:10px;font-weight:600;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.wsa-plugin-cap[data-kind="context"]{color:var(--wsa-brand);border-color:color-mix(in srgb,var(--wsa-brand) 32%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--wsa-brand) 8%,var(--dsw-alias-bg-base))}
.wsa-plugin-cap[data-kind="genui"]{color:#a855f7;border-color:rgb(168 85 247 / .3);background:rgb(168 85 247 / .08)}
.wsa-plugin-cap[data-kind="action"]{color:var(--dsw-alias-state-warn-primary,#f59e0b);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 32%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 8%,var(--dsw-alias-bg-base))}
.wsa-plugin-subnav{display:flex;align-items:center;gap:8px;padding-bottom:10px;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent)}
.wsa-plugin-subnav .wsa-cfg-card-title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

@keyframes wsa-personal-fade{from{opacity:0}}
@keyframes wsa-personal-dialog-in{from{opacity:0;transform:translateY(6px) scale(.985)}}
@media(max-width:1100px){.wsa-personal-footer{padding-bottom:calc(8px + env(safe-area-inset-bottom, 0px))}}
@media(max-width:560px){.wsa-personal-detail-backdrop{padding:12px}.wsa-personal-dialog-body{grid-template-columns:1fr}.wsa-personal-timeline{max-height:176px;border-right:0;border-bottom:1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)}}
@media(prefers-reduced-motion:reduce){.wsa-personal *{transition-duration:0ms!important;animation-duration:0ms!important}.wsa-personal :is(.wsa-personal-section-toggle,.wsa-personal-more,.wsa-personal-footer-link,.wsa-personal-add):active:enabled{transform:none}}
`;

function localDate(day: Date): string {
  return [day.getFullYear(), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0')].join('-');
}
function tomorrow(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return localDate(date);
}
function time(value: number): string {
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}
function dateHeading(value: number): string {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (localDate(date) === localDate(today)) return '今天';
  if (localDate(date) === localDate(yesterday)) return '昨天';
  return date.toLocaleDateString('zh-CN', { year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric', month: 'long', day: 'numeric' });
}
function activityStatus(status: string): string {
  const labels: Record<string, string> = {
    queued: '排队中', delegated: '已派工', running: '进行中', needs_input: '等待输入', review: '待我验收',
    succeeded: '执行成功', done: '已完成', accepted: '已验收', failed: '失败', rejected: '已拒绝',
    cancelled: '已取消', unknown: '待核实', interrupted: '已中断',
  };
  return labels[status] ?? status;
}
function statusTone(status: string): Tone {
  if (['needs_input', 'review', 'waiting', 'unknown'].includes(status)) return 'waiting';
  if (['succeeded', 'done', 'accepted'].includes(status)) return 'success';
  if (['failed', 'rejected', 'cancelled', 'interrupted'].includes(status)) return 'error';
  return 'neutral';
}
function waiting(activity: PersonalActivity): boolean {
  return ['needs_input', 'review', 'waiting', 'unknown'].includes(activity.status);
}
function finished(activity: PersonalActivity): boolean {
  return ['succeeded', 'done', 'accepted', 'failed', 'rejected', 'cancelled', 'interrupted'].includes(activity.status);
}
function dateLabel(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}
function todoMeta(item: PersonalTodo, today: string): string | undefined {
  if (item.boardTaskId) return '关联看板任务';
  if (!item.done && item.localDate < today) return '原定 ' + dateLabel(item.localDate);
  if (item.localDate > today) return dateLabel(item.localDate);
  return undefined;
}
function scheduleTime(item: PersonalSchedule): { label: string; clock?: string } {
  if (item.status === 'paused') return { label: '已暂停' };
  if (item.status === 'ended') return { label: '已结束' };
  if (!item.scheduledAt) return { label: '下次时间待确认' };
  const date = new Date(item.scheduledAt);
  if (!Number.isFinite(date.getTime())) return { label: '下次时间待确认' };
  const today = localDate(new Date());
  const label = localDate(date) === today ? '今天' : localDate(date) === tomorrow() ? '明天' : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  return { label, clock: time(date.getTime()) };
}
function scheduleRepeat(label?: string): string {
  if (!label) return '';
  const head = label.split(' · ')[0].trim();
  const repeat = head.replace(/\s*\d{1,2}:\d{2}\s*$/, '').trim();
  return repeat && repeat !== head ? repeat : '';
}
function groupedActivities(items: PersonalActivity[]): [string, PersonalActivity[]][] {
  const groups = new Map<string, PersonalActivity[]>();
  for (const item of [...items].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const key = dateHeading(item.updatedAt);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups];
}
function formatGoalDescription(title: string, description?: string): string {
  const cleanTitle = title.trim();
  let desc = (description ?? '').trim();
  if (!desc || desc === cleanTitle) return '';
  if (cleanTitle && desc.startsWith(cleanTitle)) {
    desc = desc.slice(cleanTitle.length).replace(/^[\s:：—\-·]+/, '').trim();
  }
  return desc;
}

const DELETED_GOALS_STORAGE_KEY = 'wsa:deleted-goals:v1';
const GOAL_STATUS_STORAGE_KEY = 'wsa:goal-status-overrides:v1';

function readDeletedGoalIds(): Set<string> {
  try {
    const raw = window.localStorage.getItem(DELETED_GOALS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((x): x is string => typeof x === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function markGoalDeletedLocally(goalId: string): void {
  try {
    const ids = readDeletedGoalIds();
    ids.add(goalId);
    window.localStorage.setItem(DELETED_GOALS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore storage errors
  }
}

function readGoalStatusOverrides(): Record<string, PersonalGoalItem['status']> {
  try {
    const raw = window.localStorage.getItem(GOAL_STATUS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, PersonalGoalItem['status']>) : {};
  } catch {
    return {};
  }
}

function setGoalStatusLocally(goalId: string, status: PersonalGoalItem['status']): void {
  try {
    const map = readGoalStatusOverrides();
    map[goalId] = status;
    window.localStorage.setItem(GOAL_STATUS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore storage errors
  }
}

function applyLocalGoalPatches(snapshot: PersonalSnapshot | undefined): PersonalSnapshot | undefined {
  if (!snapshot?.goals?.items) return snapshot;
  const deleted = readDeletedGoalIds();
  const statusMap = readGoalStatusOverrides();
  if (deleted.size === 0 && Object.keys(statusMap).length === 0) return snapshot;
  const items = snapshot.goals.items
    .filter(item => !deleted.has(item.id))
    .map(item => (statusMap[item.id] && statusMap[item.id] !== item.status ? { ...item, status: statusMap[item.id]! } : item));
  return {
    ...snapshot,
    goals: {
      ...snapshot.goals,
      items,
    },
  };
}

async function deleteGoalBoardTasksFromClient(goal: {
  readonly title?: string;
  readonly milestones?: readonly { readonly title?: string; readonly boardTaskId?: string | null }[];
}): Promise<void> {
  try {
    const targetIds = new Set<string>();
    const targetTitles = new Set<string>();
    if (goal.title?.trim()) targetTitles.add(goal.title.trim());
    for (const ms of goal.milestones ?? []) {
      if (ms.boardTaskId?.trim()) targetIds.add(ms.boardTaskId.trim());
      if (ms.title?.trim()) targetTitles.add(ms.title.trim());
    }
    if (targetIds.size === 0 && targetTitles.size === 0) return;

    const stateRes = await fetch('/api/task-board/state', { credentials: 'same-origin', cache: 'no-store' });
    if (!stateRes.ok) return;
    const state = (await stateRes.json()) as {
      schemaVersion?: number;
      capabilities?: readonly string[];
      tasks?: readonly { id: string; title?: string; parentId?: string | null }[];
    };
    const tasks = state.tasks ?? [];
    const schemaVersion = state.schemaVersion ?? 8;
    const capabilities = state.capabilities ?? ['planning.v1', 'human-review.v1', 'inspection-control.v1'];

    const matched = new Set<string>();
    for (const t of tasks) {
      if (targetIds.has(t.id) || (t.title && targetTitles.has(t.title.trim()))) {
        matched.add(t.id);
      }
    }
    if (matched.size === 0) return;

    const ordered: string[] = [];
    for (const t of tasks) {
      if (t.parentId && matched.has(t.parentId) && !ordered.includes(t.id)) {
        ordered.push(t.id);
      }
    }
    for (const id of matched) {
      if (!ordered.includes(id)) ordered.push(id);
    }

    for (const taskId of ordered) {
      const delRes = await fetch('/api/task-board/action', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          action: { kind: 'delete', taskId },
          schemaVersion,
          capabilities,
        }),
      });
      if (!delRes.ok) {
        await fetch('/api/task-board/action', {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            action: { kind: 'archive', taskId },
            schemaVersion,
            capabilities,
          }),
        }).catch(() => undefined);
      }
    }
  } catch {
    // ignore transient board client errors
  }
}

export function createPersonalPanel(ctx: Context): React.ComponentType<PersonalPanelProps> {
  return function PersonalPanel({
    sessionId,
    automationText,
    onDiagnostics,
    onGuideSchedule,
    activeTab,
    onTabChange,
    config,
  }: PersonalPanelProps): React.ReactElement {
    const profile = useBotProfile();
    const [internalTab, setInternalTab] = React.useState<PersonalPanelTab>('overview');
    const rawTab: PersonalPanelTab = config ? (activeTab ?? internalTab) : 'overview';
    const currentTab: Exclude<PersonalPanelTab, 'soul_memory'> = rawTab === 'soul_memory' ? 'memory' : rawTab;
    const selectTab = (nextTab: PersonalPanelTab) => {
      setInternalTab(nextTab);
      onTabChange?.(nextTab);
      if (nextTab === 'overview') setPage('overview');
    };
    const [configSubTab, setConfigSubTab] = React.useState<StewardConfigSubTab>('basic');
    const [pluginSubView, setPluginSubView] = React.useState<'list' | 'register' | 'snapshot'>('list');
    const [pluginFilter, setPluginFilter] = React.useState<'all' | 'bound' | 'discovered'>('all');
    const [pluginToast, setPluginToast] = React.useState('');
    const [newPluginPkg, setNewPluginPkg] = React.useState('');
    const [newPluginCap, setNewPluginCap] = React.useState('');
    const [newPluginTitle, setNewPluginTitle] = React.useState('');
    const [memScopeFilter, setMemScopeFilter] = React.useState<'all' | 'pinned' | 'global' | 'workspace'>('all');
    const [memCatFilter, setMemCatFilter] = React.useState<'all' | PersonalMemoryItem['category']>('all');
    const [memQuery, setMemQuery] = React.useState('');
    const [addingMemory, setAddingMemory] = React.useState(false);
    const [newMemScope, setNewMemScope] = React.useState<'global' | 'workspace'>('global');
    const [newMemCat, setNewMemCat] = React.useState<PersonalMemoryItem['category']>('preference');
    const [newMemTitle, setNewMemTitle] = React.useState('');
    const [newMemContent, setNewMemContent] = React.useState('');
    const [newMemPinned, setNewMemPinned] = React.useState(true);
    const [expandedSkills, setExpandedSkills] = React.useState<Record<string, boolean>>({});
    const [editingTraitRules, setEditingTraitRules] = React.useState(false);
    const [confirmingReset, setConfirmingReset] = React.useState(false);
    const [snapshot, setSnapshot] = React.useState<PersonalSnapshot | undefined>(() =>
      applyLocalGoalPatches(getCachedPersonalSnapshot<PersonalSnapshot>(sessionId)),
    );
    const [notice, setNotice] = React.useState('');
    const [loading, setLoading] = React.useState(() => !getCachedPersonalSnapshot<PersonalSnapshot>(sessionId));
    const [busy, setBusy] = React.useState(false);
    const busyRef = React.useRef(false);
    const [page, setPage] = React.useState<Page>('overview');
    const [todoFilter, setTodoFilter] = React.useState<TodoFilter>('all');
    const [activityFilter, setActivityFilter] = React.useState<ActivityFilter>('all');
    const [open, setOpen] = React.useState({ todos: true, goals: true, schedules: true, activities: true });
    const sectionId = React.useId();
    const [adding, setAdding] = React.useState(false);
    const overviewAdd = React.useRef<HTMLButtonElement | null>(null);
    const [addingBoard, setAddingBoard] = React.useState(false);
    const [title, setTitle] = React.useState('');
    const [boardId, setBoardId] = React.useState('');
    const [editing, setEditing] = React.useState<string>();
    const [editTitle, setEditTitle] = React.useState('');
    const [activity, setActivity] = React.useState<PersonalActivity>();
    const [step, setStep] = React.useState(0);
    const trigger = React.useRef<HTMLButtonElement | null>(null);
    const detailDialog = React.useRef<HTMLElement | null>(null);
    const [sessionRunning, setSessionRunning] = React.useState(() => isPersonalSessionRunning(sessionId));
    const requestCounter = React.useRef(0);
    const mounted = React.useRef(true);
    const pendingRequests = React.useRef(new Map<string, string>());
    const syncedDeletedGoals = React.useRef(new Set<string>());

    const load = React.useCallback(async (signal?: AbortSignal) => {
      const counter = ++requestCounter.current;
      try {
        const response = await fetch('/api/workspace-superagent/personal', { credentials: 'same-origin', cache: 'no-store', signal });
        const rawValue = await response.json() as PersonalSnapshot & { error?: string };
        if (!response.ok || !rawValue.ok || !rawValue.todos || !rawValue.schedules || !rawValue.activities) throw Error(rawValue.error ?? '无法读取个人面板');
        const deletedIds = readDeletedGoalIds();
        if (deletedIds.size > 0 && rawValue.goals?.items?.length) {
          for (const g of rawValue.goals.items) {
            if (deletedIds.has(g.id) && !syncedDeletedGoals.current.has(g.id)) {
              syncedDeletedGoals.current.add(g.id);
              void deleteGoalBoardTasksFromClient(g);
              void readChatHealth().then(({ token }) => {
                if (!token) return;
                return fetch('/api/workspace-superagent/personal', {
                  method: 'POST',
                  credentials: 'same-origin',
                  cache: 'no-store',
                  headers: { 'content-type': 'application/json', [CONTROL_TOKEN_HEADER]: token },
                  body: JSON.stringify({
                    sessionId,
                    request: {
                      op: 'goal.delete',
                      id: g.id,
                      title: g.title,
                      milestones: g.milestones,
                      requestId: crypto.randomUUID(),
                    },
                  }),
                });
              }).catch(() => undefined);
            }
          }
        }
        const value = applyLocalGoalPatches(rawValue)!;
        publishPersonalSnapshot(sessionId, value);
        if (mounted.current && counter === requestCounter.current) { setSnapshot(value); setLoading(false); }
      } catch (error) {
        if (signal?.aborted || !mounted.current || counter !== requestCounter.current) return;
        setLoading(false);
        setNotice(error instanceof Error ? error.message : '无法读取个人面板');
      }
    }, [sessionId]);
    React.useEffect(() => {
      mounted.current = true;
      setSessionRunning(isPersonalSessionRunning(sessionId));
      const controller = new AbortController();
      void load(controller.signal);
      const refresh = () => { if (document.visibilityState === 'visible') void load(); };
      window.addEventListener('focus', refresh);
      document.addEventListener('visibilitychange', refresh);
      const unsubSnapshot = subscribePersonalSnapshot<PersonalSnapshot>(event => {
        if (event.sessionId !== sessionId || !mounted.current) return;
        const next = applyLocalGoalPatches(event.snapshot);
        if (!next?.ok || !next.todos || !next.schedules || !next.activities) return;
        requestCounter.current++;
        setSnapshot(next);
        setLoading(false);
        setNotice('');
      });
      const unsubRefresh = subscribePersonalRefresh(targetId => {
        if (targetId === sessionId) void load();
      });
      const unsubRunning = subscribePersonalSessionRunning((targetId, running) => {
        if (targetId === sessionId && mounted.current) setSessionRunning(running);
      });
      const remote = ctx.get('remote') as { $on?(event: string, fn: () => void): (() => void) | void; on?(event: string, fn: () => void): (() => void) | void } | undefined;
      const unsubRemote = typeof remote?.$on === 'function'
        ? remote.$on('schedule/changed', () => { void load(); })
        : typeof remote?.on === 'function'
          ? remote.on('schedule/changed', () => { void load(); })
          : undefined;
      const panelInfo = (ctx.get('layout') as {
        panelInfo?: { getSnapshot?(): { activePanelId?: string | null }; subscribe?(fn: () => void): () => void };
      } | undefined)?.panelInfo;
      let prevActivePanel = panelInfo?.getSnapshot?.()?.activePanelId ?? null;
      const unsubPanel = typeof panelInfo?.subscribe === 'function'
        ? panelInfo.subscribe(() => {
            const nextPanel = panelInfo.getSnapshot?.()?.activePanelId ?? null;
            if (nextPanel === 'workspace-superagent' && prevActivePanel !== 'workspace-superagent') {
              void load();
            }
            prevActivePanel = nextPanel;
          })
        : undefined;
      return () => {
        mounted.current = false;
        controller.abort();
        window.removeEventListener('focus', refresh);
        document.removeEventListener('visibilitychange', refresh);
        unsubSnapshot();
        unsubRefresh();
        unsubRunning();
        if (typeof unsubRemote === 'function') unsubRemote();
        if (typeof unsubPanel === 'function') unsubPanel();
      };
    }, [ctx, load, sessionId]);
    React.useEffect(() => {
      const intervalMs = sessionRunning ? 2_000 : 15_000;
      const timer = window.setInterval(() => {
        if (document.visibilityState === 'visible') void load();
      }, intervalMs);
      return () => window.clearInterval(timer);
    }, [load, sessionId, sessionRunning]);

    React.useEffect(() => {
      if (!activity) return;
      detailDialog.current?.focus();
      const keydown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') { setActivity(undefined); trigger.current?.focus(); }
      };
      window.addEventListener('keydown', keydown);
      return () => window.removeEventListener('keydown', keydown);
    }, [activity]);

    const mutate = async (request: Record<string, unknown>) => {
      if (busyRef.current) return false;
      busyRef.current = true;
      setBusy(true);
      setNotice('');
      const isGoalDelete = request.op === 'goal.delete' && typeof request.id === 'string' && request.id.trim().length > 0;
      const isGoalStatus = request.op === 'goal.status' && typeof request.id === 'string' && request.id.trim().length > 0 && typeof request.status === 'string';
      if (isGoalDelete) {
        const goalId = String(request.id).trim();
        const existingGoal = snapshot?.goals?.items.find(g => g.id === goalId);
        markGoalDeletedLocally(goalId);
        syncedDeletedGoals.current.add(goalId);
        void deleteGoalBoardTasksFromClient(
          existingGoal ?? {
            ...(typeof request.title === 'string' ? { title: request.title } : {}),
            ...(Array.isArray(request.milestones)
              ? {
                  milestones: request.milestones.filter(
                    (m): m is { title?: string; boardTaskId?: string | null } => !!m && typeof m === 'object',
                  ),
                }
              : {}),
          },
        );
      } else if (isGoalStatus) {
        setGoalStatusLocally(String(request.id).trim(), request.status as PersonalGoalItem['status']);
      }
      if (isGoalDelete || isGoalStatus) {
        requestCounter.current++;
        setSnapshot(prev => {
          const next = applyLocalGoalPatches(prev);
          if (next) publishPersonalSnapshot(sessionId, next);
          return next;
        });
      }
      const signature = JSON.stringify(request);
      const requestId = pendingRequests.current.get(signature) ?? crypto.randomUUID();
      pendingRequests.current.set(signature, requestId);
      try {
        const { token } = await readChatHealth();
        if (!token) {
          if (isGoalDelete || isGoalStatus) {
            pendingRequests.current.delete(signature);
            return true;
          }
          throw Error(`连接已失效，请重新打开${getBotProfile().botName || DEFAULT_BOT_NAME}`);
        }
        const response = await fetch('/api/workspace-superagent/personal', {
          method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'content-type': 'application/json', [CONTROL_TOKEN_HEADER]: token },
          body: JSON.stringify({ sessionId, request: { ...request, requestId } }),
        });
        const rawValue = await response.json() as PersonalSnapshot & { error?: string };
        if (!response.ok || !rawValue.ok) {
          if (isGoalDelete || isGoalStatus) {
            pendingRequests.current.delete(signature);
            return true;
          }
          if (response.status === 409) { pendingRequests.current.delete(signature); await load(); }
          throw Error(rawValue.error ?? '操作未完成');
        }
        const value = applyLocalGoalPatches(rawValue)!;
        pendingRequests.current.delete(signature);
        requestCounter.current++;
        if (mounted.current) setSnapshot(value);
        publishPersonalSnapshot(sessionId, value);
        return true;
      } catch (error) {
        if (isGoalDelete || isGoalStatus) {
          pendingRequests.current.delete(signature);
          return true;
        }
        if (mounted.current) setNotice(error instanceof Error ? error.message : '操作未完成，请重试');
        return false;
      } finally { busyRef.current = false; if (mounted.current) setBusy(false); }
    };
    const openSchedule = (id: string) => {
      const navigation = ctx.get('scheduleNavigation') as { openTask(id: string): boolean } | undefined;
      if (!navigation?.openTask(id)) setNotice('定时任务详情暂不可用，请在自动化任务中查看。');
    };
    const openBoard = async (id: string, goalMeta?: { goalId?: string; milestoneId?: string; title?: string }) => {
      const board = ctx.get('taskBoard') as { openTaskFromHost?(id: string): Promise<boolean> } | undefined;
      if (await board?.openTaskFromHost?.(id)) return;
      try {
        const { token } = await readChatHealth();
        if (token) {
          const response = await fetch('/api/workspace-superagent/personal', {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'content-type': 'application/json', [CONTROL_TOKEN_HEADER]: token },
            body: JSON.stringify({
              sessionId,
              request: {
                op: 'goal.ensure_board_task',
                boardTaskId: id,
                ...(goalMeta?.goalId ? { goalId: goalMeta.goalId } : {}),
                ...(goalMeta?.milestoneId ? { milestoneId: goalMeta.milestoneId } : {}),
                ...(goalMeta?.title ? { title: goalMeta.title } : {}),
              },
            }),
          });
          const value = await response.json() as PersonalSnapshot & { resolvedTaskId?: string; error?: string };
          if (response.ok && value.ok) {
            if (mounted.current) setSnapshot(value);
            publishPersonalSnapshot(sessionId, value);
            const targetId = value.resolvedTaskId || id;
            if (await board?.openTaskFromHost?.(targetId)) return;
          }
        }
      } catch {
        // fall through to notice
      }
      setNotice('看板卡片暂时无法打开。');
    };
    const openSession = (id: string, isSchedule = false) => {
      if (id === sessionId) {
        closeActivity();
        return;
      }
      const navigation = ctx.get('uiWorkspace') as { openSession?(id: string): void } | undefined;
      if (!navigation?.openSession) { setNotice(isSchedule ? '定时会话暂时无法打开。' : 'Worker 会话暂时无法打开。'); return; }
      navigation.openSession(id);
    };
    const openScheduleList = () => {
      const layout = ctx.get('layout') as { selectPanel?(id: string): void } | undefined;
      if (!layout?.selectPanel) { setNotice('自动化任务页面暂时无法打开。'); return; }
      layout.selectPanel('schedules');
    };
    const showActivity = (item: PersonalActivity, button: HTMLButtonElement) => {
      trigger.current = button;
      setStep(Math.max(0, (item.events?.length ?? 0) - 1));
      setActivity(item);
    };
    const closeActivity = () => { setActivity(undefined); trigger.current?.focus(); };
    const today = localDate(new Date());
    const todos = snapshot?.todos.items ?? [];
    const todayItems = todos.filter(item => item.localDate === today).sort((a, b) => Number(a.done) - Number(b.done));
    const doneToday = todayItems.filter(item => item.done).length;
    const activities = snapshot?.activities.items ?? [];
    const scheduleItems = [...(snapshot?.schedules.items ?? [])].sort((a, b) => {
      if (a.status !== b.status) return a.status === 'active' ? -1 : b.status === 'active' ? 1 : 0;
      return (a.scheduledAt ?? '\uffff').localeCompare(b.scheduledAt ?? '\uffff');
    });
    const closeAddForm = () => { setAdding(false); overviewAdd.current?.focus(); };
    const submitCreate = async (event: React.FormEvent) => {
      event.preventDefault();
      const value = title.trim();
      if (!value || busy) return;
      if (await mutate({ op: 'create', title: value, localDate: today })) { setTitle(''); closeAddForm(); }
    };
    const submitBoard = async (event: React.FormEvent) => {
      event.preventDefault();
      const item = snapshot?.boardCandidates?.items.find(candidate => candidate.id === boardId);
      if (!item || busy) return;
      if (await mutate({ op: 'create', title: item.title, localDate: today, boardTaskId: item.id })) { setBoardId(''); setAddingBoard(false); }
    };
    const form = <>
      {adding && <form className="wsa-personal-form" onSubmit={event => void submitCreate(event)}><input autoFocus aria-label="待办标题" maxLength={120} value={title} onChange={event => setTitle(event.target.value)} placeholder="输入待办，按回车添加" /><div className="wsa-personal-form-actions"><button type="button" onClick={closeAddForm}>取消</button><button disabled={!title.trim() || busy}>添加</button></div></form>}
      {addingBoard && <form className="wsa-personal-form" onSubmit={event => void submitBoard(event)}>
        {!snapshot?.boardCandidates?.available ? <span className="wsa-personal-note">{snapshot?.boardCandidates?.error ?? '看板任务暂时不可用'}</span> :
          <select aria-label="选择看板任务" value={boardId} onChange={event => setBoardId(event.target.value)}><option value="">选择看板任务</option>{snapshot.boardCandidates.items.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select>}
        <div className="wsa-personal-form-actions"><button type="button" onClick={() => setAddingBoard(false)}>取消</button><button disabled={!boardId || busy}>添加</button></div>
      </form>}
    </>;
    const todoRow = (item: PersonalTodo, secondary = false) => <div className={'wsa-personal-row' + (item.done ? ' wsa-personal-row-done' : '')} key={item.id}>
      {editing === item.id ? <form className="wsa-personal-form wsa-personal-form-inline" onSubmit={event => { event.preventDefault(); if (editTitle.trim()) void mutate({ op: 'update', id: item.id, revision: item.revision, title: editTitle.trim() }).then(ok => { if (ok) setEditing(undefined); }); }}>
        <input autoFocus aria-label="编辑待办标题" maxLength={120} value={editTitle} onChange={event => setEditTitle(event.target.value)} /><button disabled={busy || !editTitle.trim()}>保存</button><button type="button" onClick={() => setEditing(undefined)}>取消</button>
      </form> : <>
        <label className="wsa-personal-check"><input type="checkbox" checked={item.done} disabled={busy} onChange={event => void mutate({ op: 'update', id: item.id, revision: item.revision, done: event.target.checked })} /><span className="wsa-personal-box" aria-hidden="true"><Icon name="check" size={9} strokeWidth={3} /></span><span className="wsa-personal-row-text"><span className={'wsa-personal-title' + (item.done ? ' wsa-personal-complete' : '')}>{item.title}</span>{secondary && todoMeta(item, today) && <span className="wsa-personal-sub">{todoMeta(item, today)}</span>}</span></label>
        <div className="wsa-personal-row-actions">{item.boardTaskId && <button type="button" aria-label={'打开看板任务：' + item.title} title="打开看板任务" onClick={() => void openBoard(item.boardTaskId!, { title: item.title })}><Icon name="link" size={13} /></button>}
          {secondary && !item.sourceUnavailable && <button type="button" aria-label={'编辑：' + item.title} title="编辑" onClick={() => { setEditing(item.id); setEditTitle(item.title); }}><Icon name="edit" size={13} /></button>}
          {secondary && !item.done && <button type="button" disabled={busy} aria-label={'移到明天：' + item.title} title="移到明天" onClick={() => void mutate({ op: 'move', id: item.id, revision: item.revision, localDate: tomorrow() })}><Icon name="calendar" size={13} /></button>}
        </div></>}
    </div>;
    const activityRow = (item: PersonalActivity) => <button type="button" className="wsa-personal-row wsa-personal-entry" key={item.id} onClick={event => showActivity(item, event.currentTarget)}>
      <span className="wsa-personal-entry-icon" aria-hidden="true"><Icon name={item.kind === 'schedule_trigger' ? 'clock' : 'route'} size={15} /></span>
      <span className="wsa-personal-row-text"><span className="wsa-personal-entry-head"><span className="wsa-personal-title">{item.title}</span><time>{time(item.updatedAt)}</time></span><span className="wsa-personal-sub wsa-personal-activity-meta">{item.worker && <span className="wsa-personal-worker">{item.worker}</span>}<span className="wsa-personal-status" data-tone={statusTone(item.status)}>{activityStatus(item.status)}</span></span></span>
      <span className="wsa-personal-chevron" aria-hidden="true"><Icon name="chevron-right" size={14} /></span>
    </button>;
    const scheduleRow = (item: PersonalSchedule) => {
      const { clock, label } = scheduleTime(item);
      const repeat = scheduleRepeat(item.timingLabel);
      return <button type="button" className="wsa-personal-row wsa-personal-entry wsa-personal-schedule" key={item.id} onClick={() => openSchedule(item.id)}>
        <span className="wsa-personal-schedule-clock">
          {clock ? <><time dateTime={item.scheduledAt}>{clock}</time><span>{label}</span></> : <Icon name="clock" size={16} />}
        </span>
        <span className="wsa-personal-row-text"><span className="wsa-personal-title">{item.title}</span>
          {(!clock || repeat) && <span className="wsa-personal-sub">{[!clock ? label : '', repeat].filter(Boolean).join(' · ')}</span>}
        </span>
        <Icon name="chevron-right" size={14} className="wsa-personal-chevron" />
      </button>;
    };
    const error = (resource: Resource<unknown> | undefined, empty: string) => !resource?.available
      ? <p className="wsa-personal-note" role="status">{resource?.error ?? '暂时无法读取'}<button type="button" onClick={() => void load()}>重试</button></p>
      : resource.items.length === 0 && empty ? <p className="wsa-personal-empty">{empty}</p> : null;

    const visibleTodos = todos.filter(item => todoFilter === 'all' || (todoFilter === 'done' ? item.done : !item.done));
    const overdue = visibleTodos.filter(item => !item.done && item.localDate < today);
    const current = visibleTodos.filter(item => !item.done && item.localDate === today);
    const future = visibleTodos.filter(item => !item.done && item.localDate > today);
    const completed = visibleTodos.filter(item => item.done);
    const shownActivities = activities.filter(item => activityFilter === 'all' || (activityFilter === 'waiting' ? waiting(item) : finished(item)));
    const automationRunning = automationText.includes('运行中');

    const filter = (items: readonly (readonly [string, string])[], value: string, set: (next: string) => void, label: string) =>
      <div className="wsa-personal-filter" role="group" aria-label={label}>{items.map(([key, text]) => <button type="button" key={key} aria-pressed={value === key} onClick={() => set(key)}>{text}</button>)}</div>;
    const sectionToggle = (key: keyof typeof open, label: string, icon: IconName, count?: number) =>
      <h3><button type="button" className="wsa-personal-section-toggle" aria-expanded={open[key]} aria-controls={sectionId + key}
        onClick={() => setOpen(value => ({ ...value, [key]: !value[key] }))}>
        <Icon name={icon} size={15} className="wsa-personal-section-glyph" />{label}
        {count !== undefined && count > 0 && <span className="wsa-personal-count">{count} 项</span>}
        <Icon name="chevron-down" size={12} className="wsa-personal-section-chevron" />
      </button></h3>;
    const displayBotName = (config?.botName || profile.botName || DEFAULT_BOT_NAME).trim() || DEFAULT_BOT_NAME;
    const pendingTodayCount = todayItems.filter(item => !item.done).length;
    const currentGroup = config?.groups.find(g => g.id === config.selectedModel.provider);
    const currentEntry = currentGroup?.models.find(e => e.id === config?.selectedModel.model);
    const efforts = currentEntry?.reasoning?.efforts ?? [];
    const activeEffort = config?.selectedModel.reasoningEffort ?? currentEntry?.reasoning?.defaultEffort;
    const selectedEffortLabel = efforts.length > 0
      ? (EFFORT_LABELS[activeEffort ?? ''] ?? activeEffort ?? '模型默认')
      : (config?.selectedModel.reasoningEffort ? (EFFORT_LABELS[config.selectedModel.reasoningEffort] ?? config.selectedModel.reasoningEffort) : '模型默认');
    const selectedPresetItem = SOUL_PRESETS.find(item => item.id === config?.soulPreset) ?? SOUL_PRESETS[0]!;
    const memoryItems = snapshot?.memories?.items ?? [];
    const pinnedMemCount = memoryItems.filter(item => item.pinned).length;
    const skillItems = snapshot?.skills?.items ?? [];
    const goalItems = (snapshot?.goals?.items ?? []).filter(item => item.status !== 'archived');
    const filteredMemories = memoryItems.filter(item => {
      if (memScopeFilter === 'pinned' && !item.pinned) return false;
      if (memScopeFilter === 'global' && item.scope !== 'global') return false;
      if (memScopeFilter === 'workspace' && item.scope === 'global') return false;
      if (memCatFilter !== 'all' && item.category !== memCatFilter) return false;
      const q = memQuery.trim().toLowerCase();
      if (q) {
        const hitTitle = item.title.toLowerCase().includes(q);
        const hitContent = item.content.toLowerCase().includes(q);
        const hitTag = item.tags?.some(t => t.toLowerCase().includes(q));
        if (!hitTitle && !hitContent && !hitTag) return false;
      }
      return true;
    });
    const memoryCategoryLabel: Readonly<Record<PersonalMemoryItem['category'], string>> = {
      preference: '偏好与习惯',
      profile: '个人画像',
      project: '项目规范',
      decision: '关键决策',
      fact: '事实备忘',
    };
    const submitAddMemory = async (event: React.FormEvent) => {
      event.preventDefault();
      if (!newMemTitle.trim() || !newMemContent.trim() || busy) return;
      const ok = await mutate({
        op: 'memory.save',
        scope: newMemScope,
        category: newMemCat,
        title: newMemTitle.trim(),
        content: newMemContent.trim(),
        pinned: newMemPinned,
      });
      if (ok) {
        setNewMemTitle('');
        setNewMemContent('');
        setAddingMemory(false);
      }
    };

    return <div className="wsa-personal" data-superagent-personal="" data-personal-tab={currentTab}><style>{css}</style>
      {config && (
        <div className="wsa-personal-tabs-bar">
          <div className="wsa-personal-tabs" role="tablist" aria-label="右侧面板视图">
            <button
              type="button"
              role="tab"
              className="wsa-personal-tab"
              title="工作概览"
              aria-label="工作概览"
              aria-selected={currentTab === 'overview'}
              onClick={() => selectTab('overview')}
            >
              <Icon name="list" size={15} className="wsa-personal-tab-icon" />
              <span className="wsa-personal-tab-sr">工作概览</span>
              {pendingTodayCount > 0 && <span className="wsa-personal-tab-badge">{pendingTodayCount}</span>}
            </button>
            <button
              type="button"
              role="tab"
              className="wsa-personal-tab"
              title="联邦记忆库"
              aria-label="记忆库"
              aria-selected={currentTab === 'memory'}
              onClick={() => selectTab('memory')}
            >
              <Icon name="layers" size={15} className="wsa-personal-tab-icon" data-accent="true" />
              <span className="wsa-personal-tab-sr">记忆库</span>
              {memoryItems.length > 0 && <span className="wsa-personal-tab-badge">{memoryItems.length}</span>}
            </button>
            <button
              type="button"
              role="tab"
              className="wsa-personal-tab"
              title="程序性技能库"
              aria-label="技能库"
              aria-selected={currentTab === 'skills'}
              onClick={() => selectTab('skills')}
            >
              <Icon name="terminal" size={15} className="wsa-personal-tab-icon" data-accent="true" />
              <span className="wsa-personal-tab-sr">技能库</span>
              {skillItems.length > 0 && <span className="wsa-personal-tab-badge">{skillItems.length}</span>}
            </button>
            <button
              type="button"
              role="tab"
              className="wsa-personal-tab"
              title="主理配置"
              aria-label="配置"
              aria-selected={currentTab === 'config'}
              onClick={() => selectTab('config')}
            >
              <Icon name="sliders" size={15} className="wsa-personal-tab-icon" data-accent="true" />
              <span className="wsa-personal-tab-sr">配置</span>
              {config.isDirty && <span className="wsa-personal-tab-dot" title="有未保存的配置更改" aria-label="有未保存的配置更改" />}
            </button>
          </div>
        </div>
      )}
      {currentTab === 'memory' && config ? <>
        <div className="wsa-sm-subbar">
          <div className="wsa-sm-pills" role="group" aria-label="按作用域筛选记忆">
            {([
              ['all', '全部'],
              ['pinned', '📌 常驻'],
              ['global', '🌐 全局'],
              ['workspace', '📁 项目'],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className="wsa-sm-pill"
                data-active={memScopeFilter === key ? 'true' : undefined}
                onClick={() => setMemScopeFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="wsa-sm-src-btn"
            title="配置上下文记忆源注入与重置"
            onClick={() => {
              selectTab('config');
              setConfigSubTab('memory');
            }}
          >
            <Icon name="sliders" size={11} />
            <span>记忆源</span>
          </button>
        </div>
        {notice && <p role="status" className="wsa-personal-notice"><span>{notice}</span><button type="button" onClick={() => void load()}>刷新</button></p>}
        <div className="wsa-personal-scroll" data-superagent-soul-memory-panel="" data-soul-memory-subtab="memory">
          <div key="sm-memory" className="wsa-cfg-pane" role="tabpanel" aria-label="联邦长期记忆库">
            <section className="wsa-cfg-card">
              <header className="wsa-cfg-card-head">
                <div className="wsa-cfg-card-title-group">
                  <div className="wsa-cfg-card-title">
                    <Icon name="layers" size={15} />
                    <span>联邦长期记忆库</span>
                    <span className="wsa-cfg-tag">{memoryItems.length} 条 · {pinnedMemCount} 常驻</span>
                  </div>
                  <p className="wsa-cfg-card-desc">跨工作区全局个人偏好与当前项目记忆统一检索管理</p>
                </div>
                <button
                  type="button"
                  className="wsa-personal-add"
                  disabled={busy}
                  onClick={() => setAddingMemory(v => !v)}
                >
                  <Icon name="plus" size={12} />
                  <span>{addingMemory ? '收起' : '新增'}</span>
                </button>
              </header>
              <div className="wsa-cfg-body">
                {addingMemory && (
                  <form className="wsa-personal-form" style={{ paddingTop: 0 }} onSubmit={e => void submitAddMemory(e)}>
                    <div className="wsa-sm-toolbar">
                      <select
                        aria-label="记忆作用域"
                        value={newMemScope}
                        onChange={e => setNewMemScope(e.target.value as 'global' | 'workspace')}
                      >
                        <option value="global">🌐 全局个人层</option>
                        <option value="workspace">📁 当前工作区</option>
                      </select>
                      <select
                        aria-label="记忆分类"
                        value={newMemCat}
                        onChange={e => setNewMemCat(e.target.value as PersonalMemoryItem['category'])}
                      >
                        <option value="preference">偏好与习惯</option>
                        <option value="profile">个人画像</option>
                        <option value="project">项目规范</option>
                        <option value="decision">关键决策</option>
                        <option value="fact">事实备忘</option>
                      </select>
                    </div>
                    <input
                      type="text"
                      aria-label="记忆标题"
                      maxLength={80}
                      value={newMemTitle}
                      onChange={e => setNewMemTitle(e.target.value)}
                      placeholder="记忆标题（如：技术方案汇报格式）"
                    />
                    <textarea
                      className="wsa-cfg-textarea"
                      rows={3}
                      aria-label="记忆内容"
                      maxLength={600}
                      value={newMemContent}
                      onChange={e => setNewMemContent(e.target.value)}
                      placeholder="输入需要大肥鱼长期记住的具体规范、偏好或关键结论…"
                    />
                    <div className="wsa-cfg-label-row">
                      <label className="wsa-personal-check" style={{ alignItems: 'center' }}>
                        <input
                          type="checkbox"
                          checked={newMemPinned}
                          onChange={e => setNewMemPinned(e.target.checked)}
                        />
                        <span className="wsa-personal-box" aria-hidden="true">
                          <Icon name="check" size={9} strokeWidth={3} />
                        </span>
                        <span className="wsa-personal-sub">📌 设为常驻核心记忆（每轮自动注入）</span>
                      </label>
                      <div className="wsa-personal-form-actions">
                        <button type="button" onClick={() => setAddingMemory(false)}>取消</button>
                        <button type="submit" disabled={busy || !newMemTitle.trim() || !newMemContent.trim()}>保存</button>
                      </div>
                    </div>
                  </form>
                )}

                <div className="wsa-sm-toolbar">
                  <input
                    type="text"
                    className="wsa-cfg-input"
                    aria-label="搜索长期记忆"
                    value={memQuery}
                    onChange={e => setMemQuery(e.target.value)}
                    placeholder="搜索记忆标题、内容或标签…"
                  />
                  <select
                    className="wsa-cfg-select"
                    aria-label="按分类筛选记忆"
                    value={memCatFilter}
                    onChange={e => setMemCatFilter(e.target.value as 'all' | PersonalMemoryItem['category'])}
                  >
                    <option value="all">全部分类</option>
                    <option value="preference">偏好与习惯</option>
                    <option value="profile">个人画像</option>
                    <option value="project">项目规范</option>
                    <option value="decision">关键决策</option>
                    <option value="fact">事实备忘</option>
                  </select>
                </div>

                {filteredMemories.length === 0 ? (
                  <p className="wsa-personal-empty">
                    {memoryItems.length === 0
                      ? '暂未保存长期记忆。可在对话中让大肥鱼“记住…”或点击右上角「+ 新增」。'
                      : '没有符合当前筛选条件的长期记忆。'}
                  </p>
                ) : (
                  <div className="wsa-sm-list">
                    {filteredMemories.map(item => {
                      const isGlobal = item.scope === 'global';
                      return (
                        <article key={`${item.scope ?? 'ws'}:${item.id}`} className="wsa-sm-item">
                          <div className="wsa-sm-item-head">
                            <div className="wsa-sm-item-badges">
                              <span className="wsa-sm-scope" data-global={isGlobal ? 'true' : undefined}>
                                {isGlobal ? '🌐 全局' : '📁 项目'}
                              </span>
                              <span className="wsa-sm-cat">
                                {memoryCategoryLabel[item.category] ?? item.category}
                              </span>
                              <span className="wsa-sm-item-title">{item.title}</span>
                            </div>
                            <div className="wsa-cfg-footer-actions">
                              <button
                                type="button"
                                className="wsa-sm-pin-btn"
                                disabled={busy}
                                data-pinned={item.pinned ? 'true' : undefined}
                                title={item.pinned ? '点击取消常驻核心记忆' : '点击设为常驻核心记忆'}
                                onClick={() =>
                                  void mutate({
                                    op: 'memory.save',
                                    id: item.id,
                                    category: item.category,
                                    title: item.title,
                                    content: item.content,
                                    pinned: !item.pinned,
                                    scope: item.scope ?? 'workspace',
                                    tags: item.tags,
                                  })
                                }
                              >
                                {item.pinned ? '📌 常驻' : '置顶'}
                              </button>
                              <button
                                type="button"
                                className="wsa-sm-del-btn"
                                disabled={busy}
                                title="删除该条记忆"
                                aria-label={`删除记忆：${item.title}`}
                                onClick={() => void mutate({ op: 'memory.delete', id: item.id })}
                              >
                                ✕
                              </button>
                            </div>
                          </div>
                          <p className="wsa-sm-item-body">{item.content}</p>
                          <div className="wsa-sm-item-foot">
                            <span>id: {item.id.slice(0, 8)}</span>
                            <span>{dateHeading(item.updatedAt)} {time(item.updatedAt)}</span>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>
        <footer className="wsa-personal-footer">
          <span className="wsa-personal-footer-status">
            <span className="wsa-personal-dot" data-tone={automationRunning ? 'success' : 'neutral'} aria-hidden="true" />
            <span>全局库与 .dsh/MEMORY.md 实时同步</span>
          </span>
          <button type="button" className="wsa-personal-footer-link" onClick={onDiagnostics}>
            运行状态<Icon name="chevron-right" size={12} />
          </button>
        </footer>
      </> : currentTab === 'skills' && config ? <>
        {notice && <p role="status" className="wsa-personal-notice"><span>{notice}</span><button type="button" onClick={() => void load()}>刷新</button></p>}
        <div className="wsa-personal-scroll" data-superagent-soul-memory-panel="" data-soul-memory-subtab="skills">
          <div key="sm-skills" className="wsa-cfg-pane" role="tabpanel" aria-label="程序性技能库 SKILL.md">
            <section className="wsa-cfg-card">
              <header className="wsa-cfg-card-head">
                <div className="wsa-cfg-card-title-group">
                  <div className="wsa-cfg-card-title"><Icon name="terminal" size={15} /><span>程序性技能库 (SKILL.md)</span></div>
                  <p className="wsa-cfg-card-desc">对话传授沉淀的固定办事流程（SOP）与底层元技能</p>
                </div>
                <span className="wsa-cfg-tag" data-tone="success">● {skillItems.length} 项已就绪</span>
              </header>
              <div className="wsa-cfg-body">
                {skillItems.length === 0 ? (
                  <p className="wsa-personal-empty">暂无自定义技能。可在对话中告诉大肥鱼：“教你一套以后固定的办事流程…”自动生成。</p>
                ) : (
                  <div className="wsa-sm-list">
                    {skillItems.map(skill => {
                      const isBuiltIn = skill.slug === 'skills-creator';
                      const isExpanded = Boolean(expandedSkills[skill.slug]);
                      return (
                        <article key={`${skill.scope}:${skill.slug}`} className="wsa-sm-item">
                          <div className="wsa-sm-item-head">
                            <div className="wsa-sm-item-badges">
                              <span className="wsa-sm-scope" data-global={skill.scope === 'global' && !isBuiltIn ? 'true' : undefined}>
                                {isBuiltIn ? '内置元技能' : skill.scope === 'global' ? '🌐 全局' : '📁 工作区'}
                              </span>
                              <span className="wsa-sm-item-title" style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                                {skill.name}
                              </span>
                              {skill.displayName && (
                                <span className="wsa-personal-sub">（{skill.displayName}）</span>
                              )}
                            </div>
                            {skill.instructions && (
                              <button
                                type="button"
                                className="wsa-sm-pin-btn"
                                onClick={() => setExpandedSkills(prev => ({ ...prev, [skill.slug]: !prev[skill.slug] }))}
                              >
                                {isExpanded ? '收起 SOP ▴' : '查看 SOP ▾'}
                              </button>
                            )}
                          </div>
                          <p className="wsa-sm-item-body">{skill.description}</p>
                          {skill.triggers && skill.triggers.length > 0 && (
                            <div className="wsa-cfg-snippets">
                              {skill.triggers.map(trig => (
                                <span key={trig} className="wsa-sm-cat">触发词: {trig}</span>
                              ))}
                            </div>
                          )}
                          {isExpanded && skill.instructions && (
                            <pre className="wsa-cfg-soul-preview" style={{ maxHeight: 240 }}>
                              {skill.instructions}
                            </pre>
                          )}
                        </article>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>
        <footer className="wsa-personal-footer">
          <span className="wsa-personal-footer-status">
            <span className="wsa-personal-dot" data-tone={automationRunning ? 'success' : 'neutral'} aria-hidden="true" />
            <span>全局与工作区 SKILL.md 自动加载</span>
          </span>
          <button type="button" className="wsa-personal-footer-link" onClick={onDiagnostics}>
            运行状态<Icon name="chevron-right" size={12} />
          </button>
        </footer>
      </> : currentTab === 'config' && config ? <>
        <div className="wsa-cfg-subtabs-bar">
          <div className="wsa-cfg-subtabs" role="tablist" aria-label={`${displayBotName}配置分类`}>
            <button
              type="button"
              role="tab"
              className="wsa-cfg-subtab"
              title="基本信息与形象"
              aria-label="基本信息与形象"
              aria-selected={configSubTab === 'basic'}
              onClick={() => setConfigSubTab('basic')}
            >
              <span>基本</span>
            </button>
            <button
              type="button"
              role="tab"
              className="wsa-cfg-subtab"
              title="核心模型与推理强度"
              aria-label="核心模型与推理强度"
              aria-selected={configSubTab === 'model'}
              onClick={() => setConfigSubTab('model')}
            >
              <span>模型</span>
            </button>
            <button
              type="button"
              role="tab"
              className="wsa-cfg-subtab"
              title="人设与性格 (Soul)"
              aria-label="人设与性格 (Soul)"
              aria-selected={configSubTab === 'soul'}
              onClick={() => setConfigSubTab('soul')}
            >
              <span>人设</span>
            </button>
            <button
              type="button"
              role="tab"
              className="wsa-cfg-subtab"
              title="记忆源注入与重置"
              aria-label="记忆源注入与重置"
              aria-selected={configSubTab === 'memory'}
              onClick={() => setConfigSubTab('memory')}
            >
              <span>记忆</span>
            </button>
            <button
              type="button"
              role="tab"
              className="wsa-cfg-subtab"
              title="DSH 插件空间"
              aria-label="DSH 插件空间"
              aria-selected={configSubTab === 'plugins'}
              onClick={() => {
                setConfigSubTab('plugins');
                setPluginSubView('list');
              }}
            >
              <span>插件</span>
            </button>
          </div>
        </div>
        {config.statusNotice && <p role="status" className="wsa-personal-notice"><span>{config.statusNotice}</span></p>}
        <div className="wsa-personal-scroll" data-superagent-config-panel="" data-config-subtab={configSubTab}>
          {configSubTab === 'basic' && (
            <div key="subtab-basic" className="wsa-cfg-pane" role="tabpanel" aria-label="基本信息与形象">
              <section className="wsa-cfg-card">
                <header className="wsa-cfg-card-head">
                  <div className="wsa-cfg-card-title-group">
                    <div className="wsa-cfg-card-title"><Icon name="user" size={15} /><span>基本信息与形象</span></div>
                    <p className="wsa-cfg-card-desc">定制主理的头像、名字以及日常与你沟通时的称呼</p>
                  </div>
                  <span className="wsa-cfg-tag" data-tone="success">● 已激活</span>
                </header>
                <div className="wsa-cfg-body">
                  <div className="wsa-cfg-identity">
                    <div className="wsa-cfg-avatar-wrap">
                      <button
                        type="button"
                        className="wsa-cfg-avatar-btn"
                        title="点击更换主理头像"
                        aria-label="更换主理头像"
                        onClick={config.onRequestAvatarUpload}
                      >
                        <BotAvatar src={config.avatarDataUrl ?? profile.avatarDataUrl} size={40} />
                      </button>
                      <button
                        type="button"
                        className="wsa-cfg-camera-btn"
                        title="上传静图或动图头像"
                        aria-label="上传静图或动图头像"
                        onClick={config.onRequestAvatarUpload}
                      >
                        <Icon name="camera" size={10} />
                      </button>
                    </div>
                    <div className="wsa-cfg-avatar-copy">
                      <span className="wsa-cfg-avatar-title">{displayBotName}专属形象</span>
                      <span className="wsa-cfg-avatar-sub">支持上传 PNG / JPG / WebP 静图或 GIF 动图</span>
                      <div className="wsa-cfg-avatar-actions">
                        <button type="button" className="wsa-cfg-foot-btn" onClick={config.onRequestAvatarUpload}>
                          更换头像
                        </button>
                        {config.onClearAvatar && (
                          <button
                            type="button"
                            className="wsa-cfg-foot-btn"
                            disabled={!config.avatarDataUrl && !profile.avatarDataUrl}
                            title={config.avatarDataUrl || profile.avatarDataUrl ? '恢复默认蓝鲸头像' : '当前已是默认头像'}
                            onClick={config.onClearAvatar}
                          >
                            恢复默认头像
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="wsa-cfg-name-stack">
                    <label className="wsa-cfg-field">
                      <span className="wsa-cfg-label">主理名字</span>
                      <input
                        type="text"
                        className="wsa-cfg-input"
                        aria-label="主理名字"
                        maxLength={32}
                        value={config.botName}
                        placeholder={DEFAULT_BOT_NAME}
                        onChange={event => config.onChangeBotName(event.target.value)}
                      />
                    </label>
                    <label className="wsa-cfg-field">
                      <span className="wsa-cfg-label">对你的称呼（选填）</span>
                      <input
                        type="text"
                        className="wsa-cfg-input"
                        aria-label="对你的称呼"
                        maxLength={64}
                        value={config.userName}
                        placeholder="如：开水"
                        onChange={event => config.onChangeUserName(event.target.value)}
                      />
                    </label>
                  </div>
                  <div className="wsa-cfg-live-card">
                    <div className="wsa-cfg-label-row">
                      <span className="wsa-cfg-label">当前主理名片预览</span>
                      <span className="wsa-cfg-tag">{selectedPresetItem.title}</span>
                    </div>
                    <p className="wsa-cfg-live-quote">
                      “嗨{config.userName.trim() ? `，${config.userName.trim()}` : ''}！我是<strong>{displayBotName}</strong>，当前搭载 <strong>{currentEntry?.name ?? config.selectedModel.model}</strong>，随时准备协助你盘点工作区。”
                    </p>
                  </div>
                </div>
              </section>
            </div>
          )}

          {configSubTab === 'model' && (
            <div key="subtab-model" className="wsa-cfg-pane" role="tabpanel" aria-label="核心模型与推理">
              <section className="wsa-cfg-card">
                <header className="wsa-cfg-card-head">
                  <div className="wsa-cfg-card-title-group">
                    <div className="wsa-cfg-card-title"><Icon name="cpu" size={15} /><span>核心模型与推理</span></div>
                    <p className="wsa-cfg-card-desc">分配主理对话大模型与跨会话思考强度</p>
                  </div>
                  <span className="wsa-cfg-tag">
                    {selectedEffortLabel}{EFFORT_META[activeEffort ?? ''] ? ` · ${EFFORT_META[activeEffort ?? '']!.hint}` : ''}
                  </span>
                </header>
                <div className="wsa-cfg-body">
                  <label className="wsa-cfg-field">
                    <span className="wsa-cfg-label">主理对话模型</span>
                    <select
                      className="wsa-cfg-select"
                      aria-label="主理模型"
                      value={config.selectedModel.provider && config.selectedModel.model ? `${config.selectedModel.provider}\n${config.selectedModel.model}` : ''}
                      onChange={event => {
                        const [provider = '', model = ''] = event.target.value.split('\n');
                        if (!provider || !model) return;
                        const nextGroup = config.groups.find(g => g.id === provider);
                        const nextEntry = nextGroup?.models.find(e => e.id === model);
                        const defaultEffort = nextEntry?.reasoning?.defaultEffort;
                        config.onChangeModel({
                          provider,
                          model,
                          ...(defaultEffort ? { reasoningEffort: defaultEffort } : {}),
                        });
                      }}
                    >
                      {!currentEntry && config.selectedModel.provider && config.selectedModel.model && (
                        <option value={`${config.selectedModel.provider}\n${config.selectedModel.model}`}>
                          {config.selectedModel.model} · {config.selectedModel.provider}
                        </option>
                      )}
                      {config.groups.map(group => (
                        <optgroup key={group.id} label={group.name}>
                          {group.models.map(entry => (
                            <option key={`${group.id}\n${entry.id}`} value={`${group.id}\n${entry.id}`}>
                              {entry.name} · {group.name}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </label>

                  <div className="wsa-cfg-field">
                    <span className="wsa-cfg-label">推理强度</span>
                    {efforts.length > 0 ? (
                      <>
                        <div className="wsa-cfg-effort-seg" role="group" aria-label="推理强度">
                          {efforts.map(effort => {
                            const meta = EFFORT_META[effort.id] ?? { bars: 2, hint: '', desc: '' };
                            return (
                              <button
                                key={effort.id}
                                type="button"
                                className="wsa-cfg-effort-btn"
                                data-active={activeEffort === effort.id ? 'true' : undefined}
                                onClick={() => config.onChangeModel({ ...config.selectedModel, reasoningEffort: effort.id })}
                              >
                                <span className="wsa-cfg-bars" aria-hidden="true">
                                  {[1, 2, 3, 4].map(bar => (
                                    <span key={bar} className="wsa-cfg-bar" data-lit={bar <= meta.bars ? 'true' : undefined} />
                                  ))}
                                </span>
                                <span>{EFFORT_LABELS[effort.id] ?? effort.id}</span>
                              </button>
                            );
                          })}
                        </div>
                        {activeEffort && EFFORT_META[activeEffort] && (
                          <p className="wsa-cfg-effort-desc">
                            <strong>{EFFORT_LABELS[activeEffort] ?? activeEffort}（{EFFORT_META[activeEffort]!.hint}）</strong>：{EFFORT_META[activeEffort]!.desc}
                          </p>
                        )}
                      </>
                    ) : (
                      <span className="wsa-personal-sub">{selectedEffortLabel}</span>
                    )}
                  </div>

                  <div className="wsa-cfg-field">
                    <span className="wsa-cfg-label">引擎驱动能力</span>
                    <div className="wsa-cfg-cap-list">
                      <div className="wsa-cfg-cap-item">
                        <Icon name="layers" size={14} />
                        <div className="wsa-cfg-cap-text">
                          <span className="wsa-cfg-cap-title">跨会话脉络归纳</span>
                          <span className="wsa-cfg-cap-desc">串联多项目活跃会话，提炼阻塞风险与未闭环事项</span>
                        </div>
                      </div>
                      <div className="wsa-cfg-cap-item">
                        <Icon name="route" size={14} />
                        <div className="wsa-cfg-cap-text">
                          <span className="wsa-cfg-cap-title">只读 Worker 委派</span>
                          <span className="wsa-cfg-cap-desc">按需派发代码检索与架构调研任务，汇总可验证结论</span>
                        </div>
                      </div>
                      <div className="wsa-cfg-cap-item">
                        <Icon name="clock" size={14} />
                        <div className="wsa-cfg-cap-text">
                          <span className="wsa-cfg-cap-title">早晚报与看板编排</span>
                          <span className="wsa-cfg-cap-desc">联动个人待办与任务看板，生成结构化优先级建议</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </section>
            </div>
          )}

          {configSubTab === 'soul' && (() => {
            const isCustomBasePrompt = config.soulPrompt.trim() !== '' && config.soulPrompt.trim() !== selectedPresetItem.prompt.trim();
            return (
              <div key="subtab-soul" className="wsa-cfg-pane" role="tabpanel" aria-label="人设与沟通 (Soul)">
                <section className="wsa-cfg-card">
                  <header className="wsa-cfg-card-head">
                    <div className="wsa-cfg-card-title-group">
                      <div className="wsa-cfg-card-title"><Icon name="sparkle" size={15} /><span>人设与沟通 (Soul)</span></div>
                      <p className="wsa-cfg-card-desc">分别设定沟通基调与协作特征准则，两者将组合注入主理人设</p>
                    </div>
                    <span className="wsa-cfg-tag">{selectedPresetItem.title} · {config.soulTraits.length} 特征</span>
                  </header>
                  <div className="wsa-cfg-body">
                    <div className="wsa-cfg-field">
                      <span className="wsa-cfg-label">1. 风格预设与沟通基调</span>
                      <div className="wsa-cfg-presets">
                        {SOUL_PRESETS.map(item => (
                          <button
                            key={item.id}
                            type="button"
                            className="wsa-cfg-preset"
                            data-selected={config.soulPreset === item.id ? 'true' : undefined}
                            onClick={() => config.onSelectPreset(item.id, item.prompt)}
                          >
                            <span className="wsa-cfg-preset-head">
                              <span className="wsa-cfg-preset-title">
                                <Icon name={PRESET_ICONS[item.id]} size={12} />
                                <span>{item.title}</span>
                              </span>
                              <span className="wsa-cfg-preset-dot" aria-hidden="true" />
                            </span>
                            <span className="wsa-cfg-preset-sub">{item.subtitle}</span>
                          </button>
                        ))}
                      </div>
                      <div className="wsa-cfg-soul-subbox">
                        <div className="wsa-cfg-soul-subhead">
                          <span className="wsa-cfg-soul-sublabel">
                            <span>「{selectedPresetItem.title}」基调提示词微调</span>
                            <span className="wsa-cfg-soul-pill" data-custom={isCustomBasePrompt ? 'true' : undefined}>
                              {isCustomBasePrompt ? '已微调' : '预设默认'}
                            </span>
                          </span>
                          <button type="button" className="wsa-cfg-link" onClick={config.onResetPreset}>重置预设</button>
                        </div>
                        <textarea
                          className="wsa-cfg-textarea"
                          data-soul="true"
                          rows={6}
                          aria-label="Soul 提示词"
                          maxLength={1200}
                          value={config.soulPrompt}
                          placeholder="描述你希望主理如何与你配合…"
                          onChange={event => config.onChangePrompt(event.target.value)}
                        />
                      </div>
                    </div>

                    <div className="wsa-cfg-field">
                      <div className="wsa-cfg-label-row">
                        <span className="wsa-cfg-label">2. 协作特征偏好（可多选）</span>
                        <span className="wsa-cfg-soul-pill">已启用 {config.soulTraits.length}/{SOUL_TRAITS.length} 项</span>
                      </div>
                      <div className="wsa-cfg-traits" role="group" aria-label="协作特征偏好">
                        {SOUL_TRAITS.map(trait => {
                          const selected = config.soulTraits.includes(trait.id);
                          return (
                            <button
                              key={trait.id}
                              type="button"
                              className="wsa-cfg-trait"
                              data-selected={selected ? 'true' : undefined}
                              title={trait.instruction}
                              onClick={() => config.onToggleTrait(trait.id)}
                            >
                              {selected ? `✓ ${trait.label}` : trait.label}
                            </button>
                          );
                        })}
                      </div>
                      {(() => {
                        const defaultTraitsMd = buildDefaultTraitsMarkdown(config.soulTraits).trim();
                        const trimmedMd = config.soulTraitsMarkdown.trim();
                        const hasCustomTraitsMd = trimmedMd !== defaultTraitsMd;
                        const mdLines = trimmedMd.split('\n').map(l => l.trim()).filter(Boolean);
                        return (
                          <div className="wsa-cfg-soul-subbox" aria-live="polite">
                            <div className="wsa-cfg-soul-subhead">
                              <span className="wsa-cfg-soul-sublabel">
                                <span>当前生效的特征准则 (Markdown)</span>
                                {hasCustomTraitsMd && (
                                  <span className="wsa-cfg-soul-pill" data-custom="true">已自定义</span>
                                )}
                              </span>
                              <div className="wsa-cfg-soul-subactions">
                                {(hasCustomTraitsMd || editingTraitRules) && (
                                  <button type="button" className="wsa-cfg-link" onClick={config.onResetTraitsMarkdown}>
                                    恢复默认
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="wsa-cfg-link"
                                  onClick={() => setEditingTraitRules(v => !v)}
                                >
                                  {editingTraitRules ? '完成编辑' : '编辑 Markdown'}
                                </button>
                              </div>
                            </div>
                            {editingTraitRules ? (
                              <textarea
                                className="wsa-cfg-textarea wsa-cfg-trait-md-editor"
                                rows={6}
                                maxLength={2000}
                                aria-label="协作特征偏好 Markdown"
                                value={config.soulTraitsMarkdown}
                                placeholder="- **结论先行**：每次回复先给核心结论或行动清单…"
                                onChange={event => config.onChangeTraitsMarkdown(event.target.value)}
                              />
                            ) : mdLines.length > 0 ? (
                              <ul className="wsa-cfg-trait-rules">
                                {mdLines.map((line, idx) => {
                                  const cleaned = line.replace(/^[-*+]\s+/, '');
                                  const match = cleaned.match(/^\*\*(.+?)\*\*\s*[：:]\s*(.*)$/);
                                  return (
                                    <li key={idx} className="wsa-cfg-trait-rule">
                                      <span className="wsa-cfg-trait-rule-dot" aria-hidden="true" />
                                      {match ? (
                                        <span><strong>{match[1]}</strong>：{match[2]}</span>
                                      ) : (
                                        <span>{cleaned}</span>
                                      )}
                                    </li>
                                  );
                                })}
                              </ul>
                            ) : (
                              <span className="wsa-cfg-trait-empty">暂未设置特征准则，可勾选上方标签或点击「编辑 Markdown」自由编写。</span>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                </section>
              </div>
            );
          })()}

          {configSubTab === 'memory' && (
            <div key="subtab-memory" className="wsa-cfg-pane" role="tabpanel" aria-label="记忆注入与管理">
              <section className="wsa-cfg-card">
                <header className="wsa-cfg-card-head">
                  <div className="wsa-cfg-card-title-group">
                    <div className="wsa-cfg-card-title"><Icon name="layers" size={15} /><span>记忆注入与管理</span></div>
                    <p className="wsa-cfg-card-desc">同步工作区上下文、个人偏好与记忆重置</p>
                  </div>
                  <span className="wsa-cfg-tag">已选 {config.memorySources.length}/{config.discoveredCandidates.length} 项</span>
                </header>
                <div className="wsa-cfg-body">
                  <div className="wsa-cfg-field">
                    <div className="wsa-cfg-label-row">
                      <span className="wsa-cfg-label">上下文记忆源</span>
                      <button
                        type="button"
                        role="checkbox"
                        className="wsa-cfg-checkall"
                        aria-label={config.memorySources.length === 3 ? '取消全选' : '全选'}
                        aria-checked={config.memorySources.length === 3 ? 'true' : config.memorySources.length > 0 ? 'mixed' : 'false'}
                        onClick={config.onToggleAllMemorySources}
                      >
                        <span className="wsa-cfg-mem-check" aria-hidden="true">
                          {config.memorySources.length === 3 ? '✓' : config.memorySources.length > 0 ? '−' : ''}
                        </span>
                        <span>全选</span>
                      </button>
                    </div>
                    <div className="wsa-cfg-mem-list" role="group" aria-label="DSH 记忆来源">
                      {config.discoveredCandidates.map(candidate => {
                        const selected = config.memorySources.includes(candidate.id);
                        return (
                          <button
                            key={candidate.id}
                            type="button"
                            className="wsa-cfg-mem-item"
                            data-selected={selected ? 'true' : undefined}
                            title={candidate.summary}
                            onClick={() => config.onToggleMemorySource(candidate.id)}
                          >
                            <div className="wsa-cfg-mem-top">
                              <span className="wsa-cfg-mem-left">
                                <span className="wsa-cfg-mem-check">{selected ? '✓' : ''}</span>
                                <span className="wsa-cfg-mem-title">{candidate.title}</span>
                              </span>
                              <span className="wsa-cfg-mem-badge">
                                <Icon name={MEMORY_SOURCE_ICONS[candidate.id]} size={11} />
                                <span>{candidate.badge}</span>
                              </span>
                            </div>
                            <span className="wsa-cfg-mem-desc">{candidate.summary}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="wsa-cfg-field">
                    <span className="wsa-cfg-label">追加个人长期记忆偏好</span>
                    <textarea
                      className="wsa-cfg-textarea"
                      rows={3}
                      aria-label="补充初始长期记忆"
                      maxLength={1000}
                      value={config.customMemoryNote}
                      placeholder="写下作息习惯、关注焦点或协作偏好…"
                      onChange={event => config.onChangeCustomMemoryNote(event.target.value)}
                    />
                    <div className="wsa-cfg-snippets">
                      {QUICK_MEMORY_SNIPPETS.map(snippet => (
                        <button
                          key={snippet}
                          type="button"
                          className="wsa-cfg-snippet"
                          onClick={() => config.onAppendMemorySnippet(snippet)}
                        >
                          <Icon name="plus" size={10} />
                          <span>{snippet}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="wsa-cfg-danger-row">
                    <span>{confirmingReset ? `确认清空${displayBotName}会话与数据？` : '清空会话、记忆与待办'}</span>
                    {confirmingReset ? (
                      <div className="wsa-cfg-footer-actions">
                        <button type="button" className="wsa-cfg-foot-btn" disabled={config.saving} onClick={() => setConfirmingReset(false)}>
                          取消
                        </button>
                        <button
                          type="button"
                          className="wsa-cfg-danger-btn"
                          data-confirm="true"
                          disabled={config.saving}
                          onClick={() => {
                            setConfirmingReset(false);
                            void config.onResetSteward();
                          }}
                        >
                          确认重置
                        </button>
                      </div>
                    ) : (
                      <button type="button" className="wsa-cfg-danger-btn" disabled={config.saving} onClick={() => setConfirmingReset(true)}>
                        重置{displayBotName}…
                      </button>
                    )}
                  </div>
                </div>
              </section>
            </div>
          )}

          {configSubTab === 'plugins' && (() => {
            const pluginItems = snapshot?.plugins?.items ?? [];
            const boundPluginCount = pluginItems.filter(p => p.enabled).length;
            const discoveredPluginCount = pluginItems.length - boundPluginCount;
            const filteredPlugins = pluginItems.filter(p => {
              if (pluginFilter === 'bound') return p.enabled;
              if (pluginFilter === 'discovered') return !p.enabled;
              return true;
            });
            const snapshotPayload = {
              policyRevision: snapshot?.plugins?.policyRevision ?? 'rev-local',
              contextGrants: snapshot?.plugins?.contextGrants ?? {},
              genuiPackages: snapshot?.plugins?.genuiPackages ?? [],
            };
            const submitRegisterPlugin = async (event: React.FormEvent) => {
              event.preventDefault();
              const packageName = newPluginPkg.trim();
              const capabilityId = newPluginCap.trim();
              const pluginTitle = newPluginTitle.trim();
              if (!packageName || !capabilityId || busy) return;
              const ok = await mutate({
                op: 'plugin.register',
                packageName,
                capabilityId,
                ...(pluginTitle ? { title: pluginTitle } : {}),
              });
              if (ok) {
                const label = pluginTitle || packageName;
                setNewPluginPkg('');
                setNewPluginCap('');
                setNewPluginTitle('');
                setPluginFilter('all');
                setPluginSubView('list');
                setPluginToast(`✓ 已关联 ${label}`);
                window.setTimeout(() => setPluginToast(''), 2500);
              }
            };

            return (
              <div key="subtab-plugins" className="wsa-cfg-pane" role="tabpanel" aria-label="大肥鱼插件空间">
                {pluginSubView === 'list' && (
                  <section className="wsa-cfg-card">
                    <header className="wsa-cfg-card-head">
                      <div className="wsa-cfg-card-title-group">
                        <div className="wsa-cfg-card-title">
                          <Icon name="layers" size={15} />
                          <span style={{ whiteSpace: 'nowrap' }}>DSH 插件空间</span>
                          <span className="wsa-cfg-tag" data-tone="success">● {boundPluginCount} 已启用</span>
                        </div>
                        <p className="wsa-cfg-card-desc">
                          自动发现宿主已安装的 DSH 插件，一键开关即可注册到{displayBotName}空间
                        </p>
                      </div>
                      <div className="wsa-cfg-footer-actions">
                        <button
                          type="button"
                          className="wsa-plugin-icon-btn"
                          title="查看实时空间注册快照 (contextGrants)"
                          aria-label="查看实时空间注册快照"
                          onClick={() => setPluginSubView('snapshot')}
                        >
                          <Icon name="terminal" size={14} />
                        </button>
                        <button
                          type="button"
                          className="wsa-plugin-icon-btn"
                          data-primary="true"
                          title="手动关联第三方 DSH 插件"
                          aria-label="手动关联第三方 DSH 插件"
                          onClick={() => setPluginSubView('register')}
                        >
                          <Icon name="plus" size={15} />
                        </button>
                      </div>
                    </header>

                    <div className="wsa-cfg-body">
                      <div className="wsa-plugin-toolbar">
                        <div className="wsa-sm-pills" role="group" aria-label="筛选空间插件">
                          <button
                            type="button"
                            className="wsa-sm-pill"
                            data-active={pluginFilter === 'all' ? 'true' : undefined}
                            onClick={() => setPluginFilter('all')}
                          >
                            全部 ({pluginItems.length})
                          </button>
                          <button
                            type="button"
                            className="wsa-sm-pill"
                            data-active={pluginFilter === 'bound' ? 'true' : undefined}
                            onClick={() => setPluginFilter('bound')}
                          >
                            已启用 ({boundPluginCount})
                          </button>
                          <button
                            type="button"
                            className="wsa-sm-pill"
                            data-active={pluginFilter === 'discovered' ? 'true' : undefined}
                            onClick={() => setPluginFilter('discovered')}
                          >
                            待启用 ({discoveredPluginCount})
                          </button>
                        </div>
                        {pluginToast && (
                          <span className="wsa-cfg-tag" data-tone="success">{pluginToast}</span>
                        )}
                      </div>

                      {filteredPlugins.length === 0 ? (
                        <p className="wsa-personal-empty">
                          {pluginFilter === 'discovered'
                            ? '当前宿主发现的 DSH 插件均已启用，或可点击右上角「+」图标手动关联新插件。'
                            : '暂未发现可用插件，可点击右上角「+」图标添加 DSH 插件包名。'}
                        </p>
                      ) : (
                        <div className="wsa-sm-list">
                          {filteredPlugins.map(plugin => (
                            <article key={plugin.id} className="wsa-sm-item">
                              <div className="wsa-sm-item-head">
                                <div className="wsa-plugin-title-stack">
                                  <div className="wsa-sm-item-badges">
                                    <span className="wsa-sm-item-title">{plugin.title}</span>
                                    {!plugin.enabled && (
                                      <span className="wsa-sm-cat">待启用</span>
                                    )}
                                    {plugin.source === 'manual' && (
                                      <span className="wsa-sm-scope" data-global="true">手动关联</span>
                                    )}
                                  </div>
                                  <span className="wsa-plugin-pkg" title={plugin.packageName}>{plugin.packageName}</span>
                                </div>
                                <div className="wsa-cfg-footer-actions">
                                  {plugin.source === 'manual' && (
                                    <button
                                      type="button"
                                      className="wsa-sm-del-btn"
                                      disabled={busy}
                                      title="移除该手动关联插件"
                                      aria-label={`移除插件：${plugin.title}`}
                                      onClick={() => void mutate({ op: 'plugin.remove', id: plugin.id })}
                                    >
                                      <Icon name="close" size={12} />
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    role="switch"
                                    className="wsa-cfg-switch"
                                    disabled={busy}
                                    aria-label={`${plugin.enabled ? '停用' : '启用'}插件 ${plugin.title}`}
                                    aria-checked={plugin.enabled}
                                    title={plugin.enabled ? `点击从${displayBotName}空间移出` : `点击启用并注册到${displayBotName}空间`}
                                    onClick={() => void mutate({ op: 'plugin.toggle', id: plugin.id, enabled: !plugin.enabled })}
                                  >
                                    <span className="wsa-cfg-switch-thumb" />
                                  </button>
                                </div>
                              </div>
                              <p className="wsa-sm-item-body">{plugin.description}</p>
                              {plugin.capabilities.length > 0 && (
                                <div className="wsa-plugin-caps">
                                  {plugin.capabilities.map(cap => (
                                    <span key={`${cap.kind}:${cap.id}`} className="wsa-plugin-cap" data-kind={cap.kind}>
                                      <span>{cap.kind === 'context' ? 'Context:' : cap.kind === 'genui' ? 'GenUI:' : 'Action:'}</span>
                                      <span>{cap.id}</span>
                                    </span>
                                  ))}
                                </div>
                              )}
                            </article>
                          ))}
                        </div>
                      )}
                    </div>
                  </section>
                )}

                {pluginSubView === 'register' && (
                  <section className="wsa-cfg-card" aria-label="手动关联第三方 DSH 插件">
                    <div className="wsa-plugin-subnav">
                      <button
                        type="button"
                        className="wsa-plugin-icon-btn"
                        title="返回插件列表"
                        aria-label="返回插件列表"
                        onClick={() => setPluginSubView('list')}
                      >
                        <Icon name="back" size={14} />
                      </button>
                      <span className="wsa-cfg-card-title">手动关联 DSH 插件</span>
                    </div>
                    <form className="wsa-cfg-body" onSubmit={event => void submitRegisterPlugin(event)}>
                      <p className="wsa-cfg-card-desc">
                        输入第三方 DSH 插件的 Cordis 模块包名与暴露的 Context Capability ID，即可将其直接关联并授权到{displayBotName}空间：
                      </p>
                      <label className="wsa-cfg-field">
                        <span className="wsa-cfg-label">1. DSH 插件包名 (Module Name) *</span>
                        <input
                          type="text"
                          className="wsa-cfg-input"
                          aria-label="DSH 插件包名"
                          maxLength={240}
                          value={newPluginPkg}
                          placeholder="例如 @local/dsh-git-radar"
                          onChange={e => setNewPluginPkg(e.target.value)}
                        />
                      </label>
                      <label className="wsa-cfg-field">
                        <span className="wsa-cfg-label">2. Context Capability ID *</span>
                        <input
                          type="text"
                          className="wsa-cfg-input"
                          aria-label="Context Capability ID"
                          maxLength={100}
                          value={newPluginCap}
                          placeholder="例如 git-radar.branches"
                          onChange={e => setNewPluginCap(e.target.value)}
                        />
                      </label>
                      <label className="wsa-cfg-field">
                        <span className="wsa-cfg-label">3. 插件显示名称（选填）</span>
                        <input
                          type="text"
                          className="wsa-cfg-input"
                          aria-label="插件显示名称"
                          maxLength={80}
                          value={newPluginTitle}
                          placeholder="例如 Git 仓库健康雷达（留空默认使用包名）"
                          onChange={e => setNewPluginTitle(e.target.value)}
                        />
                      </label>
                      <div className="wsa-personal-form-actions">
                        <button
                          type="button"
                          className="wsa-cfg-foot-btn"
                          onClick={() => setPluginSubView('list')}
                        >
                          取消
                        </button>
                        <button
                          type="submit"
                          className="wsa-cfg-foot-btn"
                          data-primary="true"
                          disabled={busy || !newPluginPkg.trim() || !newPluginCap.trim()}
                        >
                          关联并启用
                        </button>
                      </div>
                    </form>
                  </section>
                )}

                {pluginSubView === 'snapshot' && (
                  <section className="wsa-cfg-card" aria-label="实时空间注册快照">
                    <div className="wsa-plugin-subnav">
                      <button
                        type="button"
                        className="wsa-plugin-icon-btn"
                        title="返回插件列表"
                        aria-label="返回插件列表"
                        onClick={() => setPluginSubView('list')}
                      >
                        <Icon name="back" size={14} />
                      </button>
                      <span className="wsa-cfg-card-title">实时空间注册快照</span>
                      <button
                        type="button"
                        className="wsa-plugin-icon-btn"
                        title={pluginToast === '✓ 已复制快照 JSON' ? '已复制快照 JSON' : '复制快照 JSON'}
                        aria-label="复制快照 JSON"
                        onClick={() => {
                          void navigator.clipboard?.writeText(JSON.stringify(snapshotPayload, null, 2));
                          setPluginToast('✓ 已复制快照 JSON');
                          window.setTimeout(() => setPluginToast(''), 1800);
                        }}
                      >
                        <Icon name={pluginToast === '✓ 已复制快照 JSON' ? 'check' : 'copy'} size={14} />
                      </button>
                    </div>
                    <div className="wsa-cfg-body">
                      <p className="wsa-cfg-card-desc">
                        当前{displayBotName}空间向 workspaceContext 与 superagentGenui 动态注入的实时白名单映射与策略指纹（只读自动继承插件固有粒度）：
                      </p>
                      <pre className="wsa-cfg-soul-preview" style={{ maxHeight: 280 }} aria-label="contextGrants 注册快照 JSON">
                        {JSON.stringify(snapshotPayload, null, 2)}
                      </pre>
                    </div>
                  </section>
                )}
              </div>
            );
          })()}
        </div>
        <footer className="wsa-personal-footer">
          {config.isDirty || config.saving ? (
            <>
              <span className="wsa-personal-footer-status">
                <span className="wsa-personal-dot" data-tone="waiting" aria-hidden="true" />
                <span>{config.saving ? '正在保存配置…' : '配置已修改'}</span>
              </span>
              <div className="wsa-cfg-footer-actions">
                <button type="button" className="wsa-cfg-foot-btn" disabled={config.saving} onClick={config.onRevertConfig}>
                  还原
                </button>
                <button
                  type="button"
                  className="wsa-cfg-foot-btn"
                  data-primary="true"
                  disabled={config.saving}
                  onClick={() => void config.onSaveConfig()}
                >
                  {config.saving ? '保存中…' : '保存生效'}
                </button>
              </div>
            </>
          ) : configSubTab === 'plugins' ? (
            <>
              <span className="wsa-personal-footer-status">
                <span className="wsa-personal-dot" data-tone="success" aria-hidden="true" />
                <span>宿主插件自动发现已开启</span>
              </span>
              <button
                type="button"
                className="wsa-personal-footer-link"
                title="查看实时空间注册快照"
                onClick={() => setPluginSubView(pluginSubView === 'snapshot' ? 'list' : 'snapshot')}
              >
                Policy: {(snapshot?.plugins?.policyRevision ?? 'rev-local').slice(0, 12)}
                <Icon name="chevron-right" size={12} />
              </button>
            </>
          ) : (
            <>
              <span className="wsa-personal-footer-status">
                <span className="wsa-personal-dot" data-tone={automationRunning ? 'success' : 'neutral'} aria-hidden="true" />
                <span>{config.savedNotice || automationText}</span>
              </span>
              <button type="button" className="wsa-personal-footer-link" onClick={onDiagnostics}>
                运行状态<Icon name="chevron-right" size={12} />
              </button>
            </>
          )}
        </footer>
      </> : <>
        {notice && <p role="status" className="wsa-personal-notice"><span>{notice}</span><button type="button" onClick={() => void load()}>刷新</button></p>}
        {loading && !snapshot ? <>
          <div className="wsa-personal-scroll" aria-busy="true">
            <section className="wsa-personal-section">
              <header className="wsa-personal-head">{sectionToggle('todos', '今日待办', 'check')}
                <button type="button" className="wsa-personal-add" aria-label="新增待办" disabled><Icon name="plus" size={13} />新增</button>
              </header>
              <div className="wsa-personal-section-body" hidden={!open.todos}><div className="wsa-personal-skel"><div className="wsa-personal-skel-bar" /><div className="wsa-personal-skel-bar" data-short="true" /></div></div>
            </section>
            <section className="wsa-personal-section">
              <header className="wsa-personal-head">{sectionToggle('goals', '长周期目标', 'layers')}</header>
              <div className="wsa-personal-section-body" hidden={!open.goals}><div className="wsa-personal-skel"><div className="wsa-personal-skel-bar" /><div className="wsa-personal-skel-bar" data-short="true" /></div></div>
            </section>
            <section className="wsa-personal-section">
              <header className="wsa-personal-head">{sectionToggle('schedules', '定时任务', 'calendar')}</header>
              <div className="wsa-personal-section-body" hidden={!open.schedules}><div className="wsa-personal-skel"><div className="wsa-personal-skel-bar" /><div className="wsa-personal-skel-bar" data-short="true" /></div></div>
            </section>
            <section className="wsa-personal-section">
              <header className="wsa-personal-head">{sectionToggle('activities', '近期活动', 'route')}</header>
              <div className="wsa-personal-section-body" hidden={!open.activities}><div className="wsa-personal-skel"><div className="wsa-personal-skel-bar" /><div className="wsa-personal-skel-bar" data-short="true" /></div></div>
            </section>
          </div>
          <footer className="wsa-personal-footer">
            <span className="wsa-personal-footer-status"><span className="wsa-personal-dot" data-tone={automationRunning ? 'success' : 'neutral'} aria-hidden="true" /><span>{automationText}</span></span>
            <button type="button" className="wsa-personal-footer-link" onClick={onDiagnostics}>运行状态<Icon name="chevron-right" size={12} /></button>
          </footer>
        </> : !snapshot ? <p className="wsa-personal-state">无法读取个人面板。<button type="button" className="wsa-personal-more" onClick={() => void load()}><Icon name="refresh" size={12} />重试</button></p> :
        page === 'overview' ? <>
          <div className="wsa-personal-scroll">
            <section className="wsa-personal-section">
              <header className="wsa-personal-head">{sectionToggle('todos', '今日待办', 'check')}
                <button type="button" className="wsa-personal-add" ref={overviewAdd} aria-label="新增待办" disabled={!snapshot.todos.available} onClick={() => {
                  setOpen(value => ({ ...value, todos: true })); setAdding(true); setAddingBoard(false);
                }}><Icon name="plus" size={13} />新增</button>
              </header>
              <div className="wsa-personal-section-body" id={sectionId + 'todos'} hidden={!open.todos}>{open.todos && <>
                {form}
                {!snapshot.todos.available ? error(snapshot.todos, '') : todayItems.length > 0
                  ? <div className="wsa-personal-list">{todayItems.slice(0, 5).map(item => todoRow(item))}</div>
                  : !adding && <p className="wsa-personal-empty">今天还没有待办。</p>}
                <div className="wsa-personal-today-meta">
                  {snapshot.todos.available && todayItems.length > 0 && <span className="wsa-personal-progress">
                    <progress value={doneToday} max={todayItems.length} aria-label="今日待办完成进度" />
                    <span aria-hidden="true">已完成 {doneToday}/{todayItems.length}</span>
                  </span>}
                  <button type="button" className="wsa-personal-more" onClick={() => setPage('todos')}>查看全部待办<Icon name="chevron-right" size={12} /></button>
                </div>
              </>}</div>
            </section>
            <section className="wsa-personal-section">
              <header className="wsa-personal-head">{sectionToggle('goals', '长周期目标', 'layers', goalItems.length)}</header>
              <div className="wsa-personal-section-body" id={sectionId + 'goals'} hidden={!open.goals}>
                {goalItems.length === 0 ? (
                  <p className="wsa-personal-empty">暂无长周期目标。可在对话中让{displayBotName}拆解阶段里程碑并自动推进。</p>
                ) : (
                  <div className="wsa-personal-list">
                    {goalItems.slice(0, 5).map(goal => {
                      const doneMs = goal.milestones.filter(ms => ms.status === 'completed').length;
                      const totalMs = goal.milestones.length;
                      const statusLabel = goal.status === 'completed' ? '已完成' : goal.status === 'paused' ? '已暂停' : goal.status === 'failed' ? '已受阻' : '推进中';
                      const statusToneVal = goal.status === 'completed' ? 'success' : goal.status === 'paused' ? 'neutral' : goal.status === 'failed' ? 'error' : 'running';
                      const cleanDesc = formatGoalDescription(goal.title, goal.description);
                      return (
                        <article key={goal.id} className="wsa-personal-goal">
                          <div className="wsa-personal-goal-head">
                            <h4 className="wsa-personal-goal-title">{goal.title}</h4>
                            <div className="wsa-personal-goal-actions">
                              {goal.status === 'active' || goal.status === 'paused' ? (
                                <button
                                  type="button"
                                  className="wsa-personal-pill"
                                  data-tone={statusToneVal}
                                  disabled={busy}
                                  title={goal.status === 'active' ? '点击暂停推进' : '点击恢复推进'}
                                  onClick={() =>
                                    void mutate({
                                      op: 'goal.status',
                                      id: goal.id,
                                      status: goal.status === 'active' ? 'paused' : 'active',
                                    })
                                  }
                                >
                                  {statusLabel}
                                </button>
                              ) : (
                                <span className="wsa-personal-pill" data-tone={statusToneVal}>{statusLabel}</span>
                              )}
                              <button
                                type="button"
                                className="wsa-sm-del-btn"
                                disabled={busy}
                                title="删除该长周期目标"
                                aria-label={`删除长周期目标：${goal.title}`}
                                onClick={() =>
                                  void mutate({
                                    op: 'goal.delete',
                                    id: goal.id,
                                    title: goal.title,
                                    milestones: goal.milestones,
                                  })
                                }
                              >
                                <Icon name="close" size={12} />
                              </button>
                            </div>
                          </div>
                          {cleanDesc && <p className="wsa-personal-goal-desc" title={goal.description}>{cleanDesc}</p>}
                          {goal.milestones.length > 0 && (
                            <div className="wsa-personal-goal-steps">
                              {goal.milestones.map((ms, idx) => (
                                <div key={ms.id} className="wsa-personal-goal-step" data-status={ms.status}>
                                  <span className="wsa-personal-goal-step-main" title={ms.summary ? `${ms.title} — ${ms.summary}` : ms.title}>
                                    <span className="wsa-personal-goal-step-num" aria-hidden="true">
                                      {ms.status === 'completed' ? (
                                        <Icon name="check" size={9} strokeWidth={3} />
                                      ) : ms.status === 'failed' ? (
                                        <Icon name="close" size={9} strokeWidth={2.6} />
                                      ) : (
                                        idx + 1
                                      )}
                                    </span>
                                    <span className="wsa-personal-goal-step-title">{ms.title}</span>
                                  </span>
                                  {ms.boardTaskId && (
                                    <button
                                      type="button"
                                      className="wsa-personal-chip"
                                      title={`打开关联看板卡 ${ms.boardTaskId}`}
                                      onClick={() => void openBoard(ms.boardTaskId!, { goalId: goal.id, milestoneId: ms.id, title: ms.title })}
                                    >
                                      <Icon name="board" size={11} />看板卡
                                    </button>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                          {(totalMs > 0 || goal.autoAdvance) && (
                            <div className="wsa-personal-today-meta">
                              {totalMs > 0 && (
                                <span className="wsa-personal-progress">
                                  <progress value={doneMs} max={totalMs} aria-label={`${goal.title} 阶段进度`} />
                                  <span aria-hidden="true">已完成 {doneMs}/{totalMs} 阶段</span>
                                </span>
                              )}
                              {goal.autoAdvance && (
                                <span className="wsa-personal-goal-auto">
                                  <Icon name="zap" size={11} />自动推进
                                </span>
                              )}
                            </div>
                          )}
                        </article>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>
            <section className="wsa-personal-section">
              <header className="wsa-personal-head">{sectionToggle('schedules', '定时任务', 'calendar', scheduleItems.length)}</header>
              <div className="wsa-personal-section-body" id={sectionId + 'schedules'} hidden={!open.schedules}>
                {scheduleItems.slice(0, 3).map(scheduleRow)}
                {error(snapshot.schedules, '还没有定时任务。')}
                {snapshot.schedules.available && scheduleItems.length === 0 && onGuideSchedule && (
                  <button type="button" className="wsa-personal-more" onClick={onGuideSchedule}>
                    <Icon name="plus" size={12} />开启每日早晚总结与复盘<Icon name="chevron-right" size={12} />
                  </button>
                )}
                {scheduleItems.length > 0 && <button type="button" className="wsa-personal-more" onClick={openScheduleList}>查看全部定时任务<Icon name="chevron-right" size={12} /></button>}
              </div>
            </section>
            <section className="wsa-personal-section">
              <header className="wsa-personal-head">{sectionToggle('activities', '近期活动', 'route')}</header>
              <div className="wsa-personal-section-body" id={sectionId + 'activities'} hidden={!open.activities}>
                {groupedActivities([...activities].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5)).map(([date, rows]) => <div key={date}><p className="wsa-personal-date">{date}</p>{rows.map(activityRow)}</div>)}
                {error(snapshot.activities, '暂无委派活动。')}
                {activities.length > 0 && <button type="button" className="wsa-personal-more" onClick={() => setPage('activities')}>查看更早活动<Icon name="chevron-right" size={12} /></button>}
              </div>
            </section>
          </div>
          <footer className="wsa-personal-footer">
            <span className="wsa-personal-footer-status"><span className="wsa-personal-dot" data-tone={automationRunning ? 'success' : 'neutral'} aria-hidden="true" /><span>{automationText}</span></span>
            <button type="button" className="wsa-personal-footer-link" onClick={onDiagnostics}>运行状态<Icon name="chevron-right" size={12} /></button>
          </footer>
        </> : page === 'todos' ? <>
          <header className="wsa-personal-subhead"><button type="button" className="wsa-personal-icon" aria-label="返回个人面板" onClick={() => setPage('overview')}><Icon name="back" size={15} /></button><h2>全部待办</h2><span className="wsa-personal-spacer" /><button type="button" className="wsa-personal-icon" aria-label="从看板添加" title="从看板添加" onClick={() => { setAddingBoard(true); setAdding(false); }}><Icon name="board" size={15} /></button><button type="button" className="wsa-personal-icon" aria-label="新增待办" title="新增待办" onClick={() => { setAdding(true); setAddingBoard(false); }}><Icon name="plus" size={15} /></button></header>
          <div className="wsa-personal-body">{form}{filter([['all', '全部'], ['pending', '未完成'], ['done', '已完成']] as const, todoFilter, value => setTodoFilter(value as TodoFilter), '筛选待办')}
            {error(snapshot.todos, '还没有待办。')}{snapshot.todos.available && visibleTodos.length === 0 && todos.length > 0 && <p className="wsa-personal-note">没有符合条件的待办。</p>}
            {([['已逾期', overdue], ['今天', current], ['即将到来', future], ['已完成', completed]] as [string, PersonalTodo[]][]).map(([heading, rows]) => rows.length > 0 && <section className="wsa-personal-group" key={heading}><h3 data-tone={heading === '已逾期' ? 'warn' : undefined}>{heading}<span>{rows.length} 项</span></h3>{rows.map(item => todoRow(item, true))}</section>)}
          </div>
        </> : <>
          <header className="wsa-personal-subhead"><button type="button" className="wsa-personal-icon" aria-label="返回个人面板" onClick={() => setPage('overview')}><Icon name="back" size={15} /></button><h2>委派活动</h2></header>
          <div className="wsa-personal-body">{filter([['all', '全部'], ['waiting', '待我处理'], ['finished', '已结束']] as const, activityFilter, value => setActivityFilter(value as ActivityFilter), '筛选活动')}
            {error(snapshot.activities, '暂无委派活动。')}{snapshot.activities.available && shownActivities.length === 0 && activities.length > 0 && <p className="wsa-personal-note">没有符合条件的活动。</p>}
            {groupedActivities(shownActivities).map(([date, rows]) => <section className="wsa-personal-group" key={date}><h3>{date}<span>{rows.length} 项</span></h3>{rows.map(activityRow)}</section>)}
          </div>
        </>}
      </>}
      {activity && <div className="wsa-personal-detail-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) closeActivity(); }}><section className="wsa-personal-dialog" role="dialog" aria-modal="true" aria-labelledby="wsa-personal-dialog-title" ref={detailDialog} tabIndex={-1}>
        <header className="wsa-personal-dialog-head">
          <div className="wsa-personal-dialog-top">
            <p className="wsa-personal-dialog-kicker"><Icon name={activity.kind === 'schedule_trigger' ? 'clock' : 'route'} size={12} /><span>{activity.kind === 'schedule_trigger' ? '定时触发详情' : '委派详情'}</span></p>
            <div className="wsa-personal-dialog-top-right">
              <span className="wsa-personal-pill" data-tone={statusTone(activity.status)}>{activityStatus(activity.status)}</span>
              <button className="wsa-personal-icon wsa-personal-dialog-close" type="button" aria-label={activity.kind === 'schedule_trigger' ? '关闭定时触发详情' : '关闭委派详情'} onClick={closeActivity}><Icon name="close" size={15} /></button>
            </div>
          </div>
          <div className="wsa-personal-dialog-title-row">
            <h2 id="wsa-personal-dialog-title">{activity.title}</h2>
            <p className="wsa-personal-dialog-meta">{activity.worker && <span>{activity.worker}</span>}<span>{dateHeading(activity.updatedAt)} {time(activity.updatedAt)}</span></p>
          </div>
        </header>
        <div className="wsa-personal-dialog-body"><nav className="wsa-personal-timeline" aria-label="执行时间线"><h3>执行时间线</h3><div className="wsa-personal-steps">{activity.events?.length ? activity.events.map((event, index) => <button key={index} type="button" className="wsa-personal-step" aria-current={step === index ? 'step' : undefined} onClick={() => setStep(index)}><span className="wsa-personal-marker" aria-hidden="true">{step === index ? <Icon name="check" size={9} strokeWidth={2.6} /> : null}</span><span className="wsa-personal-step-text"><span className="wsa-personal-step-title">{event.title}</span><time>{time(event.at)}</time></span></button>) : <p className="wsa-personal-note">暂无可用的执行事件。</p>}</div></nav>
          <div className="wsa-personal-result">{activity.events?.[step] ? <><time>{time(activity.events[step].at)}</time><h3>{activity.events[step].title}</h3><p>{activity.events[step].summary || '此步骤没有提供更多内容。'}</p></> : <p className="wsa-personal-result-empty">当前状态：{activityStatus(activity.status)}</p>}</div>
        </div>{(activity.sessionId || activity.taskId || activity.scheduleId) && <footer className="wsa-personal-dialog-footer">{activity.kind === 'schedule_trigger' ? <>{activity.sessionId && <button type="button" className="wsa-personal-button" onClick={() => openSession(activity.sessionId!, true)}>{activity.sessionId === sessionId ? '在当前会话查看' : '打开定时会话'}</button>}{(activity.scheduleId || activity.taskId) && <button type="button" className="wsa-personal-button" onClick={() => openSchedule((activity.scheduleId ?? activity.taskId)!)}>打开定时任务</button>}</> : <>{activity.sessionId && <button type="button" className="wsa-personal-button" onClick={() => openSession(activity.sessionId!)}>打开 Worker 会话</button>}{activity.taskId && <button type="button" className="wsa-personal-button" onClick={() => void openBoard(activity.taskId!)}>打开看板卡片</button>}</>}</footer>}
      </section></div>}
    </div>;
  };
}
