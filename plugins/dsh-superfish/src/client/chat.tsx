import * as React from 'react';
import { createActionCard } from './action-card.js';
import { createGenuiCard } from './genui-card.js';
import {
  createPersonalPanel,
  type PersonalPanelTab,
  type PersonalSnapshot,
  type StewardConfigPanelProps,
} from './personal-panel.js';
import {
  clearCachedPersonalSnapshot,
  getCachedPersonalSnapshot,
  publishPersonalSnapshot,
  requestPersonalRefresh,
  setPersonalSessionRunning,
} from './personal-sync.js';
import { Icon, type IconName } from './icons.js';
import {
  AVATAR_ANIMATION_STYLES,
  BotAvatar,
  getBotProfile,
  readAvatarFileAsDataUrl,
  registerRemoteAvatarUpdater,
  resetBotProfile,
  setBotProfile,
  useBotProfile,
} from './bot-profile.js';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsRenderFactories, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots';
import type { HealthView } from '../app/health/view.js';
import {
  DEFAULT_BOT_NAME,
  DEFAULT_CHAT_MODEL,
  DEFAULT_CHAT_SOUL,
  DEFAULT_SOUL_TRAITS,
  SOUL_PRESETS,
  SOUL_TRAITS,
  buildDefaultTraitsMarkdown,
  localMottoDay,
  nativeChatModel,
  renderSoulMarkdownDocument,
  resolveSoulPresetPrompt,
  resolveSoulTraitsMarkdown,
  syncTraitToggleInMarkdown,
  type ChatModelSelection,
  type ChatSoulConfig,
  type ChatSoulPreset,
  type ChatSoulTraitId,
  type ChatSuggestionItem,
  type ChatSuggestionsPayload,
  type DailyMotto,
  type OnboardingMemoryCandidate,
  type OnboardingMemoryOptions,
  type OnboardingMemorySourceId,
} from '../app/health/chat-input.js';
import {
  WSA_HISTORY_PAGE_SIZE,
  attachChatTransport,
  computeHistoryPagination,
  countMessagesFromTurn,
  mutateChat,
  readChatHealth,
  withRemoteHistoryPagination,
  type ChatModelDirectories,
  type ChatReference,
  type HistoryChatNodeLookup,
} from './chat-transport.js';
import type { ModelCatalogGroup, ModelCatalogRemote } from './settings.js';

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'workspace-superagent.conversation': { kind: 'single'; scope: 'session' };
  }
}
const CHILD = 'workspace-superagent.conversation';
export const DAILY_SUMMARY_SCHEDULE_PROMPT =
  '帮我创建每天早上 09:00 的早间总结和每天晚上 20:30 的晚间复盘定时任务，结合我的个人待办、任务看板和近期会话记录给出总结与建议。';

const FIXED_DAILY_SUGGESTION: ChatSuggestionItem = {
  id: 'daily-schedule',
  label: '开启每日早晚总结与复盘',
  icon: 'clock',
  prompt: DAILY_SUMMARY_SCHEDULE_PROMPT,
  primary: true,
};

const DEFAULT_DYNAMIC_SUGGESTIONS: readonly ChatSuggestionItem[] = [
  {
    id: 'today-todos',
    label: '盘点今日待办与工作建议',
    icon: 'check',
    prompt: '结合我的个人待办清单、任务看板和近期会话记录，帮我盘点今天的待办事项并给出优先工作建议。',
  },
  {
    id: 'recent-sessions',
    label: '总结近期会话进展',
    icon: 'route',
    prompt: '帮我总结一下最近活跃和刚完成的会话进展，看看有哪些未闭环事项。',
  },
  {
    id: 'board-overview',
    label: '查看看板待规划与进行中任务',
    icon: 'board',
    prompt: '帮我看看任务看板里目前有哪些待规划和进行中的卡片。',
  },
];

const FALLBACK_MEMORY_CANDIDATES: readonly OnboardingMemoryCandidate[] = [
  {
    id: 'rules',
    title: 'DSH 规则与项目记忆文档',
    badge: '工程规则',
    summary: '扫描全局工作空间与已接入项目的 AGENTS.md、CLAUDE.md、MEMORY.md 及工程配置约定。',
    count: 1,
    items: ['全局工作空间与各项目 DSH 规则、编码规范与架构约定'],
  },
  {
    id: 'sessions',
    title: '近期会话画像与行为习惯',
    badge: '行为画像',
    summary: '从近期活跃 DSH 会话中提炼你的关注焦点、提问习惯与协作偏好。',
    count: 1,
    items: ['跨项目会话高频讨论模块与日常开发习惯画像'],
  },
  {
    id: 'board',
    title: '看板在途任务与待办基线',
    badge: '项目基线',
    summary: '将当前活跃看板任务与未完成待办同步为大肥鱼的初始项目记忆。',
    count: 1,
    items: ['跨项目看板在途卡片与个人待办初始快照'],
  },
];

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
  high: { bars: 3, hint: '深度归纳', desc: '深度串联跨项目会话、看板依赖与潜在阻塞风险（推荐主理默认档位）。' },
  max: { bars: 4, hint: '极限推演', desc: '全量上下文深度推演，适合复杂架构复盘、多线任务统筹与深度只读调研。' },
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
${AVATAR_ANIMATION_STYLES}
.wsa-chat{--wsa-ease:cubic-bezier(.22,1,.36,1);--wsa-spring:cubic-bezier(.34,1.56,.64,1);--wsa-brand:var(--dsw-alias-brand-primary-new-colorprimary-new-color,#3b5bf6);display:flex;flex-direction:column;height:100%;min-height:0;min-width:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}
.wsa-chat-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:52px;padding:0 14px 0 22px;border-bottom:1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)}
.wsa-chat-title{display:flex;align-items:center;gap:8px;min-width:0}
.wsa-chat-head strong{display:block;font-size:13.5px;font-weight:600;line-height:1.4;letter-spacing:.01em;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.wsa-chat-toggle{display:inline-flex;flex:none;align-items:center;justify-content:center;gap:6px;min-width:28px;height:28px;padding:0 6px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12.5px;font-weight:500;cursor:pointer;transition:background-color 160ms var(--wsa-ease),color 160ms var(--wsa-ease),transform 160ms var(--wsa-ease)}
.wsa-chat-toggle[data-back="true"]{height:30px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb, var(--dsw-alias-label-primary) 4%, var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary)}
.wsa-chat-toggle:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.wsa-chat-toggle:active{transform:scale(.94)}
.wsa-chat-toggle[aria-expanded="true"]{background:var(--dsw-alias-bg-hover);color:var(--dsw-alias-label-primary)}
.wsa-chat-toggle:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}
.wsa-chat-main{display:flex;flex:1;min-height:0;min-width:0;position:relative}.wsa-chat-body{flex:1;min-height:0;min-width:0;overflow:auto}
.wsa-chat-native{height:100%;min-height:0}.wsa-chat-native [data-conversation-content]{height:100%}
.wsa-chat-detail{width:min(348px,42%);flex:none;border-left:1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);min-height:0;overflow:hidden}
.wsa-chat-empty{max-width:520px;margin:12vh auto 0;padding:24px}.wsa-chat-empty h2{font-size:22px}
.wsa-chat-status{padding:8px 20px;color:var(--dsw-alias-label-secondary);font-size:13px}
.wsa-chat :is(.wsa-chat-empty,.wsa-chat-status)>button{color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 12px;font:inherit}
.wsa-chat :is(.wsa-chat-empty,.wsa-chat-status)>button:disabled{opacity:.5}
.wsa-chat-scrim{display:none}
.wsa-chat[data-ready="false"] [data-composer-seat],
.wsa-chat [data-slot="conversation.input.permission"],.wsa-chat [data-slot="conversation.input.plan"],
.wsa-chat [data-slot="conversation.input.model"]{display:none!important}
@keyframes wsa-boot-fade{from{opacity:0}to{opacity:1}}
.wsa-chat-boot{box-sizing:border-box;display:flex;flex-direction:column;justify-content:space-between;height:100%;min-height:0;padding:20px calc(var(--dsh-composer-side-clearance,8px) + 16px) 18px}
.wsa-chat-boot-inner{box-sizing:border-box;max-width:var(--dsh-chat-content-width,min(calc(100% - 32px),920px));width:100%;margin:0 auto;display:flex;flex-direction:column;gap:14px;animation:wsa-boot-fade 180ms var(--wsa-ease) 120ms both}
.wsa-chat-boot-card{padding:16px 18px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 2.5%,var(--dsw-alias-bg-base));display:flex;flex-direction:column;gap:10px}
.wsa-chat-boot-row{display:flex;align-items:center;gap:8px}
.wsa-chat-boot-bar{height:10px;border-radius:5px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,var(--dsw-alias-bg-base))}
.wsa-chat-boot-composer{box-sizing:border-box;max-width:var(--dsh-composer-card-max-width,952px);width:100%;height:88px;margin:auto auto 0;border:1px solid var(--dsw-alias-border-l1);border-radius:16px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 2%,var(--dsw-alias-bg-base));animation:wsa-boot-fade 180ms var(--wsa-ease) 120ms both}
.wsa-chat-boot-error{box-sizing:border-box;max-width:440px;width:calc(100% - 32px);margin:14vh auto 0;padding:22px 24px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,var(--dsw-alias-bg-base));display:flex;flex-direction:column;align-items:flex-start;gap:10px}
.wsa-chat-boot-error h3{margin:0;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}
.wsa-chat-boot-error p{margin:0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary)}

/* 初次使用四步引导 Wizard — 高级宽幅工作台与交互动效 */
@keyframes wsa-ob-aura-drift{
  0%,100%{transform:translate3d(0,0,0) scale(1)}
  50%{transform:translate3d(14px,-10px,0) scale(1.06)}
}
@keyframes wsa-ob-halo-pulse{
  0%,100%{transform:scale(1);opacity:.55}
  50%{transform:scale(1.08);opacity:.88}
}
@keyframes wsa-ob-card-enter-next{
  from{opacity:0;transform:translate3d(22px,6px,0) scale(.988)}
  to{opacity:1;transform:translate3d(0,0,0) scale(1)}
}
@keyframes wsa-ob-card-enter-prev{
  from{opacity:0;transform:translate3d(-22px,6px,0) scale(.988)}
  to{opacity:1;transform:translate3d(0,0,0) scale(1)}
}
@keyframes wsa-ob-stagger-up{
  from{opacity:0;transform:translate3d(0,10px,0)}
  to{opacity:1;transform:translate3d(0,0,0)}
}
@keyframes wsa-ob-check-pop{
  0%{transform:scale(.6)}
  65%{transform:scale(1.16)}
  100%{transform:scale(1)}
}
@keyframes wsa-ob-preview-expand{
  from{opacity:0;transform:translateY(-6px)}
  to{opacity:1;transform:translateY(0)}
}

.wsa-onboarding{
  box-sizing:border-box;width:100%;max-width:780px;margin:0 auto;
  padding:clamp(28px,4.8vh,54px) clamp(24px,4vw,44px) 64px;
  position:relative;isolation:isolate;
}
.wsa-ob-ambient{
  position:absolute;inset:0 -40px auto -40px;height:420px;pointer-events:none;z-index:-1;overflow:hidden;
  mask-image:radial-gradient(ellipse 80% 75% at 50% 32%,#000 35%,transparent 100%);
  -webkit-mask-image:radial-gradient(ellipse 80% 75% at 50% 32%,#000 35%,transparent 100%);
}
.wsa-ob-ambient::before{
  content:'';position:absolute;top:-70px;left:calc(16% + var(--wsa-step-shift,0%));
  width:380px;height:260px;border-radius:999px;
  background:radial-gradient(circle,color-mix(in srgb,var(--wsa-brand) 22%,transparent) 0%,transparent 72%);
  filter:blur(36px);transition:left 560ms var(--wsa-ease);
  animation:wsa-ob-aura-drift 8s ease-in-out infinite;
}
.wsa-ob-ambient::after{
  content:'';position:absolute;inset:0;
  background-image:radial-gradient(color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent) 1px,transparent 1px);
  background-size:20px 20px;opacity:.45;
}

/* 顶部主理 Hero 舞台 */
.wsa-ob-hero{
  display:flex;align-items:center;justify-content:space-between;gap:20px;
  margin-bottom:24px;padding:20px 24px;border-radius:20px;
  border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 10%,var(--dsw-alias-border-l1));
  background:
    radial-gradient(120% 140% at 0% 0%,color-mix(in srgb,var(--wsa-brand) 11%,transparent) 0%,transparent 58%),
    linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--dsw-alias-bg-base)) 0%,color-mix(in srgb,var(--dsw-alias-label-primary) 1.5%,var(--dsw-alias-bg-base)) 100%);
  box-shadow:0 16px 40px -22px rgb(0 0 0 / .32),inset 0 1px 0 color-mix(in srgb,var(--dsw-alias-label-primary) 9%,transparent);
  position:relative;overflow:hidden;
}
.wsa-ob-hero-left{display:flex;align-items:center;gap:18px;min-width:0;flex:1}
.wsa-ob-logo-wrap{position:relative;flex:none}
.wsa-ob-logo-Wrap-glow{
  position:absolute;inset:-6px;border-radius:24px;
  background:radial-gradient(circle,color-mix(in srgb,var(--wsa-brand) 32%,transparent) 0%,transparent 70%);
  animation:wsa-ob-halo-pulse 3.6s ease-in-out infinite;pointer-events:none;
}
.wsa-ob-logo{
  position:relative;width:68px;height:68px;border-radius:19px;
  border:1px solid color-mix(in srgb,var(--wsa-brand) 36%,var(--dsw-alias-border-l1));
  background:
    radial-gradient(circle at 30% 22%,color-mix(in srgb,var(--wsa-brand) 22%,transparent),transparent 70%),
    color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--dsw-alias-bg-base));
  box-shadow:0 10px 26px -10px color-mix(in srgb,var(--wsa-brand) 42%,transparent),inset 0 1px 0 color-mix(in srgb,#fff 20%,transparent);
  display:flex;align-items:center;justify-content:center;flex:none;overflow:hidden;
  cursor:pointer;padding:0;transition:transform 240ms var(--wsa-spring),border-color 200ms var(--wsa-ease),box-shadow 240ms var(--wsa-ease);
}
.wsa-ob-logo:hover{
  transform:translateY(-2px) scale(1.04);
  border-color:color-mix(in srgb,var(--wsa-brand) 68%,var(--dsw-alias-border-l1));
  box-shadow:0 14px 30px -10px color-mix(in srgb,var(--wsa-brand) 55%,transparent),inset 0 1px 0 color-mix(in srgb,#fff 28%,transparent);
}
.wsa-ob-logo:active{transform:scale(.97)}
.wsa-ob-logo img{width:50px;height:50px;object-fit:contain}
.wsa-ob-logo-status{
  position:absolute;right:-2px;bottom:-2px;width:16px;height:16px;border-radius:999px;
  border:2.5px solid var(--dsw-alias-bg-base);background:#10b981;
  box-shadow:0 0 0 3px rgb(16 185 129 / .2);pointer-events:none;
}
.wsa-ob-hero-text{min-width:0;flex:1}
.wsa-ob-eyebrow{
  display:inline-flex;align-items:center;gap:6px;margin-bottom:6px;
  padding:2px 9px;border-radius:999px;
  border:1px solid color-mix(in srgb,var(--wsa-brand) 30%,var(--dsw-alias-border-l1));
  background:color-mix(in srgb,var(--wsa-brand) 10%,var(--dsw-alias-bg-base));
  font-size:11px;font-weight:600;letter-spacing:.04em;color:color-mix(in srgb,var(--wsa-brand) 75%,var(--dsw-alias-label-primary));
}
.wsa-ob-title-row{display:flex;align-items:center;flex-wrap:wrap;gap:10px}
.wsa-ob-hero-text h2{margin:0;font-size:22px;font-weight:700;line-height:1.25;letter-spacing:-.015em;color:var(--dsw-alias-label-primary)}
.wsa-ob-hero-badges{display:inline-flex;align-items:center;flex-wrap:wrap;gap:6px}
.wsa-ob-hero-pill{
  display:inline-flex;align-items:center;gap:5px;height:23px;padding:0 9px;border-radius:7px;
  border:1px solid var(--dsw-alias-border-l1);
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--dsw-alias-bg-base));
  font-size:11.5px;font-weight:500;color:var(--dsw-alias-label-secondary);
}
.wsa-ob-hero-text p{margin:6px 0 0;font-size:13.5px;line-height:1.55;color:var(--dsw-alias-label-secondary)}
.wsa-ob-hero-right{
  display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex:none;
}
.wsa-ob-step-counter{
  font-size:11.5px;font-weight:700;letter-spacing:.06em;
  color:var(--dsw-alias-label-tertiary);text-transform:uppercase;
}
.wsa-ob-step-dots{display:flex;align-items:center;gap:5px}
.wsa-ob-step-dot{
  width:18px;height:4px;border-radius:999px;
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 14%,transparent);
  transition:width 280ms var(--wsa-ease),background-color 280ms var(--wsa-ease);
}
.wsa-ob-step-dot[data-active="true"]{width:28px;background:var(--wsa-brand)}
.wsa-ob-step-dot[data-done="true"]{background:color-mix(in srgb,var(--wsa-brand) 55%,transparent)}

/* 四步进度导航轨 */
.wsa-ob-steps{
  position:relative;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;
  margin-bottom:20px;padding:7px;border-radius:16px;
  border:1px solid var(--dsw-alias-border-l1);
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 2.5%,var(--dsw-alias-bg-base));
  box-shadow:inset 0 1px 0 color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent);
}
.wsa-ob-step-line{display:none}
.wsa-ob-step-tab{
  position:relative;display:flex;align-items:center;gap:11px;width:100%;text-align:left;
  padding:10px 13px;border-radius:11px;border:1px solid transparent;
  background:transparent;color:var(--dsw-alias-label-tertiary);
  font:inherit;font-size:13px;font-weight:500;cursor:pointer;
  transition:background-color 200ms var(--wsa-ease),color 200ms var(--wsa-ease),border-color 200ms var(--wsa-ease),transform 180ms var(--wsa-ease),box-shadow 200ms var(--wsa-ease);
}
.wsa-ob-step-tab:hover{
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--dsw-alias-bg-base));
  color:var(--dsw-alias-label-secondary);
}
.wsa-ob-step-tab:active{transform:scale(.98)}
.wsa-ob-step-tab[data-active="true"]{
  color:var(--dsw-alias-label-primary);font-weight:600;
  border-color:color-mix(in srgb,var(--wsa-brand) 42%,var(--dsw-alias-border-l1));
  background:
    linear-gradient(135deg,color-mix(in srgb,var(--wsa-brand) 12%,var(--dsw-alias-bg-base)) 0%,color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--dsw-alias-bg-base)) 100%);
  box-shadow:0 6px 18px -10px color-mix(in srgb,var(--wsa-brand) 45%,transparent);
}
.wsa-ob-step-tab[data-done="true"]{color:var(--dsw-alias-label-secondary)}
.wsa-ob-step-num{
  width:26px;height:26px;border-radius:9px;
  border:1px solid color-mix(in srgb,currentColor 32%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,var(--dsw-alias-bg-base));
  display:inline-flex;align-items:center;justify-content:center;flex:none;
  font-size:12px;font-weight:700;line-height:1;
  transition:transform 220ms var(--wsa-spring),background-color 200ms var(--wsa-ease),border-color 200ms var(--wsa-ease),box-shadow 200ms var(--wsa-ease);
}
.wsa-ob-step-tab:hover .wsa-ob-step-num{transform:scale(1.06)}
.wsa-ob-step-tab[data-active="true"] .wsa-ob-step-num{
  border-color:transparent;
  background:var(--wsa-brand);
  color:var(--dsw-static-neutral-bluish-00,var(--dsw-alias-label-primary-foreground,#fff));
  box-shadow:0 0 0 4px color-mix(in srgb,var(--wsa-brand) 20%,transparent);
}
.wsa-ob-step-tab[data-done="true"] .wsa-ob-step-num{
  border-color:color-mix(in srgb,var(--wsa-brand) 40%,transparent);
  background:color-mix(in srgb,var(--wsa-brand) 14%,var(--dsw-alias-bg-base));
  color:color-mix(in srgb,var(--wsa-brand) 85%,var(--dsw-alias-label-primary));
  animation:wsa-ob-check-pop 280ms var(--wsa-spring);
}
.wsa-ob-step-meta{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.wsa-ob-step-title{font-size:13px;font-weight:600;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wsa-ob-step-sub{font-size:11px;line-height:1.25;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wsa-ob-step-tab[data-active="true"] .wsa-ob-step-sub{color:var(--dsw-alias-label-secondary)}

/* 步骤主卡片与过渡动效 */
.wsa-ob-card{
  border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 10%,var(--dsw-alias-border-l1));
  border-radius:20px;
  background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-label-primary) 2.5%,var(--dsw-alias-bg-base)) 0%,var(--dsw-alias-bg-base) 100%);
  box-shadow:0 22px 50px -26px rgb(0 0 0 / .38),inset 0 1px 0 color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);
  overflow:hidden;
  animation:wsa-ob-card-enter-next 320ms var(--wsa-ease) both;
}
.wsa-ob-card[data-step-dir="prev"]{
  animation-name:wsa-ob-card-enter-prev;
}
.wsa-ob-card-head{
  display:flex;align-items:flex-start;justify-content:space-between;gap:16px;
  padding:22px 26px 18px;
  border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 7%,var(--dsw-alias-border-l1));
  background:radial-gradient(90% 140% at 100% 0%,color-mix(in srgb,var(--wsa-brand) 7%,transparent) 0%,transparent 70%);
}
.wsa-ob-card-head-left{display:flex;align-items:flex-start;gap:14px;min-width:0}
.wsa-ob-card-icon{
  width:38px;height:38px;border-radius:11px;flex:none;
  border:1px solid color-mix(in srgb,var(--wsa-brand) 32%,var(--dsw-alias-border-l1));
  background:color-mix(in srgb,var(--wsa-brand) 11%,var(--dsw-alias-bg-base));
  color:color-mix(in srgb,var(--wsa-brand) 85%,var(--dsw-alias-label-primary));
  display:inline-flex;align-items:center;justify-content:center;
  box-shadow:inset 0 1px 0 color-mix(in srgb,#fff 14%,transparent);
}
.wsa-ob-card-title{margin:0;font-size:16px;font-weight:650;line-height:1.35;color:var(--dsw-alias-label-primary)}
.wsa-ob-card-subtitle{margin:4px 0 0;font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.wsa-ob-card-tag{
  display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 10px;border-radius:999px;flex:none;
  border:1px solid var(--dsw-alias-border-l1);
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,var(--dsw-alias-bg-base));
  font-size:11.5px;font-weight:500;color:var(--dsw-alias-label-secondary);
}

.wsa-ob-row{
  display:flex;align-items:center;justify-content:space-between;gap:20px;
  padding:20px 26px;
  animation:wsa-ob-stagger-up 340ms var(--wsa-ease) both;
}
.wsa-ob-row+.wsa-ob-row,.wsa-ob-block+.wsa-ob-block,.wsa-ob-row+.wsa-ob-block,.wsa-ob-block+.wsa-ob-row{
  border-top:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 7%,var(--dsw-alias-border-l1));
}
.wsa-ob-block{
  padding:20px 26px;
  animation:wsa-ob-stagger-up 340ms var(--wsa-ease) both;
}
.wsa-ob-copy{min-width:0;flex:1}
.wsa-ob-label{font-size:14.5px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:8px}
.wsa-ob-desc{margin-top:4px;font-size:12.5px;line-height:1.55;color:var(--dsw-alias-label-secondary)}
.wsa-ob-muted{font-size:13px;color:var(--dsw-alias-label-secondary)}

/* Step 1: 模型选择与推理强度矩阵 */
.wsa-ob-select{
  min-width:280px;max-width:360px;height:40px;padding:0 34px 0 14px;
  border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 12%,var(--dsw-alias-border-l1));
  border-radius:11px;
  background-color:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,var(--dsw-alias-bg-base));
  color:var(--dsw-alias-label-primary);font:inherit;font-size:13.5px;font-weight:550;
  cursor:pointer;outline:none;appearance:none;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 16 16' fill='none' stroke='%2394a3b8' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m4 6 4 4 4-4'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right 12px center;
  box-shadow:0 2px 8px -4px rgb(0 0 0 / .18);
  transition:border-color 160ms var(--wsa-ease),background-color 160ms var(--wsa-ease),box-shadow 160ms var(--wsa-ease),transform 160ms var(--wsa-ease);
}
.wsa-ob-select:hover:enabled{
  background-color:var(--dsw-alias-interactive-bg-hover);
  border-color:color-mix(in srgb,var(--wsa-brand) 45%,var(--dsw-alias-border-l1));
}
.wsa-ob-select:focus-visible{
  border-color:var(--wsa-brand);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--wsa-brand) 22%,transparent);
}
.wsa-ob-select:disabled{opacity:.6;cursor:default}

.wsa-ob-cap-grid{
  display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:16px;
}
.wsa-ob-cap-item{
  padding:12px 14px;border-radius:12px;
  border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 7%,var(--dsw-alias-border-l1));
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 2%,var(--dsw-alias-bg-base));
  display:flex;flex-direction:column;gap:4px;
  transition:border-color 180ms var(--wsa-ease),background-color 180ms var(--wsa-ease),transform 180ms var(--wsa-ease);
}
.wsa-ob-cap-item:hover{
  transform:translateY(-1.5px);
  border-color:color-mix(in srgb,var(--wsa-brand) 32%,var(--dsw-alias-border-l1));
  background:color-mix(in srgb,var(--wsa-brand) 4%,var(--dsw-alias-bg-base));
}
.wsa-ob-cap-title{display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary)}
.wsa-ob-cap-title svg{color:var(--wsa-brand);flex:none}
.wsa-ob-cap-desc{font-size:11.5px;line-height:1.45;color:var(--dsw-alias-label-tertiary)}

.wsa-ob-effort-wrap{display:flex;flex-direction:column;gap:12px;margin-top:14px}
.wsa-ob-seg{
  display:grid;grid-template-columns:repeat(auto-fit,minmax(92px,1fr));
  padding:5px;border-radius:13px;
  border:1px solid var(--dsw-alias-border-l1);
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 3.5%,var(--dsw-alias-bg-base));
  gap:6px;
}
.wsa-ob-seg-btn{
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;
  height:54px;padding:6px 12px;border:1px solid transparent;border-radius:9px;
  background:transparent;color:var(--dsw-alias-label-secondary);
  font:inherit;font-size:13px;font-weight:500;cursor:pointer;
  transition:background-color 180ms var(--wsa-ease),color 180ms var(--wsa-ease),border-color 180ms var(--wsa-ease),transform 160ms var(--wsa-spring),box-shadow 180ms var(--wsa-ease);
}
.wsa-ob-seg-btn:hover{
  color:var(--dsw-alias-label-primary);
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--dsw-alias-bg-base));
}
.wsa-ob-seg-btn:active{transform:scale(.96)}
.wsa-ob-seg-btn[data-active="true"]{
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-weight:650;
  border-color:color-mix(in srgb,var(--wsa-brand) 48%,var(--dsw-alias-border-l1));
  box-shadow:0 6px 16px -8px color-mix(in srgb,var(--wsa-brand) 40%,rgb(0 0 0 / .24));
}
.wsa-ob-effort-bars{display:inline-flex;align-items:flex-end;gap:3px;height:11px}
.wsa-ob-effort-bar{
  width:3.5px;border-radius:999px;
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent);
  transition:background-color 200ms var(--wsa-ease),transform 200ms var(--wsa-spring);
}
.wsa-ob-effort-bar:nth-child(1){height:4px}
.wsa-ob-effort-bar:nth-child(2){height:6.5px}
.wsa-ob-effort-bar:nth-child(3){height:9px}
.wsa-ob-effort-bar:nth-child(4){height:11px}
.wsa-ob-effort-bar[data-lit="true"]{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 68%,transparent)}
.wsa-ob-seg-btn[data-active="true"] .wsa-ob-effort-bar[data-lit="true"]{
  background:var(--wsa-brand);transform:scaleY(1.08);
}
.wsa-ob-effort-caption{
  display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:10px 14px;border-radius:10px;
  border:1px solid color-mix(in srgb,var(--wsa-brand) 22%,var(--dsw-alias-border-l1));
  background:color-mix(in srgb,var(--wsa-brand) 5%,var(--dsw-alias-bg-base));
  font-size:12.5px;line-height:1.45;color:var(--dsw-alias-label-secondary);
}
.wsa-ob-effort-caption strong{color:var(--dsw-alias-label-primary);font-weight:600}

/* Step 2: 设定 Soul 形象、风格预设与特征芯片 */
.wsa-ob-identity{
  display:flex;align-items:center;gap:20px;
  padding:16px 18px;border-radius:14px;
  border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 8%,var(--dsw-alias-border-l1));
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 2.5%,var(--dsw-alias-bg-base));
}
.wsa-ob-avatar-wrap{position:relative;flex:none}
.wsa-ob-avatar-box{
  width:64px;height:64px;border-radius:17px;
  border:1.5px solid color-mix(in srgb,var(--wsa-brand) 32%,var(--dsw-alias-border-l1));
  background:
    radial-gradient(circle at 30% 25%,color-mix(in srgb,var(--wsa-brand) 18%,transparent),transparent 70%),
    color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--dsw-alias-bg-base));
  display:flex;align-items:center;justify-content:center;overflow:hidden;
  cursor:pointer;padding:0;
  box-shadow:0 8px 20px -10px rgb(0 0 0 / .28);
  transition:border-color 180ms var(--wsa-ease),transform 200ms var(--wsa-spring),box-shadow 200ms var(--wsa-ease);
}
.wsa-ob-avatar-box:hover{
  transform:translateY(-2px) scale(1.03);
  border-color:var(--wsa-brand);
  box-shadow:0 12px 24px -10px color-mix(in srgb,var(--wsa-brand) 42%,transparent);
}
.wsa-ob-camera-btn{
  position:absolute;right:-5px;bottom:-5px;width:24px;height:24px;border-radius:999px;
  border:2px solid var(--dsw-alias-bg-base);
  background:var(--wsa-brand);color:#fff;
  display:inline-flex;align-items:center;justify-content:center;padding:0;cursor:pointer;
  box-shadow:0 3px 8px rgb(0 0 0 / .28);
  transition:transform 180ms var(--wsa-spring),opacity 140ms var(--wsa-ease);
}
.wsa-ob-camera-btn:hover{transform:scale(1.12)}
.wsa-ob-name-grid{flex:1;min-width:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.wsa-ob-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.wsa-ob-field-label{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.wsa-ob-input{
  box-sizing:border-box;width:100%;height:38px;padding:0 12px;
  border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 10%,var(--dsw-alias-border-l1));
  border-radius:10px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  font:inherit;font-size:13.5px;outline:none;
  transition:border-color 160ms var(--wsa-ease),box-shadow 160ms var(--wsa-ease);
}
.wsa-ob-input:hover{border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 24%,var(--dsw-alias-border-l1))}
.wsa-ob-input:focus{
  border-color:var(--wsa-brand);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--wsa-brand) 20%,transparent);
}

.wsa-ob-block-top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
.wsa-ob-presets{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.wsa-ob-preset{
  position:relative;text-align:left;padding:15px 17px;border-radius:14px;
  border:1px solid var(--dsw-alias-border-l1);
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 1.5%,var(--dsw-alias-bg-base));
  color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;
  transition:background-color 180ms var(--wsa-ease),border-color 180ms var(--wsa-ease),transform 200ms var(--wsa-spring),box-shadow 200ms var(--wsa-ease);
}
.wsa-ob-preset:hover{
  transform:translateY(-2px);
  background:var(--dsw-alias-interactive-bg-hover);
  border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 22%,var(--dsw-alias-border-l1));
  box-shadow:0 10px 24px -16px rgb(0 0 0 / .35);
}
.wsa-ob-preset:active{transform:scale(.985)}
.wsa-ob-preset[data-selected="true"]{
  border-color:color-mix(in srgb,var(--wsa-brand) 65%,var(--dsw-alias-border-l1));
  background:
    radial-gradient(120% 120% at 100% 0%,color-mix(in srgb,var(--wsa-brand) 14%,transparent) 0%,transparent 70%),
    color-mix(in srgb,var(--wsa-brand) 6%,var(--dsw-alias-bg-base));
  box-shadow:0 10px 26px -14px color-mix(in srgb,var(--wsa-brand) 42%,transparent);
}
.wsa-ob-preset-title{font-size:14px;font-weight:650;display:flex;align-items:center;justify-content:space-between;gap:8px}
.wsa-ob-preset-title-left{display:inline-flex;align-items:center;gap:8px}
.wsa-ob-preset-icon{
  width:26px;height:26px;border-radius:8px;
  border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 10%,var(--dsw-alias-border-l1));
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--dsw-alias-bg-base));
  color:var(--dsw-alias-label-secondary);
  display:inline-flex;align-items:center;justify-content:center;flex:none;
  transition:background-color 180ms var(--wsa-ease),color 180ms var(--wsa-ease),border-color 180ms var(--wsa-ease);
}
.wsa-ob-preset[data-selected="true"] .wsa-ob-preset-icon{
  border-color:color-mix(in srgb,var(--wsa-brand) 45%,transparent);
  background:color-mix(in srgb,var(--wsa-brand) 16%,var(--dsw-alias-bg-base));
  color:var(--wsa-brand);
}
.wsa-ob-preset-dot{
  width:8px;height:8px;border-radius:999px;
  background:var(--wsa-brand);
  box-shadow:0 0 0 4px color-mix(in srgb,var(--wsa-brand) 22%,transparent);
  opacity:0;transform:scale(.5);
  transition:opacity 180ms var(--wsa-ease),transform 220ms var(--wsa-spring);
}
.wsa-ob-preset[data-selected="true"] .wsa-ob-preset-dot{opacity:1;transform:scale(1)}
.wsa-ob-preset-sub{margin-top:6px;font-size:12.5px;color:var(--dsw-alias-label-secondary);line-height:1.45}

.wsa-ob-traits{display:flex;flex-wrap:wrap;gap:9px}
.wsa-ob-trait-chip{
  display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 14px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l1);
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 2%,var(--dsw-alias-bg-base));
  color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;font-weight:500;cursor:pointer;
  transition:background-color 160ms var(--wsa-ease),color 160ms var(--wsa-ease),border-color 160ms var(--wsa-ease),transform 160ms var(--wsa-spring),box-shadow 160ms var(--wsa-ease);
}
.wsa-ob-trait-chip:hover{
  transform:translateY(-1px);
  background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);
}
.wsa-ob-trait-chip:active{transform:scale(.95)}
.wsa-ob-trait-chip[data-selected="true"]{
  border-color:color-mix(in srgb,var(--wsa-brand) 58%,var(--dsw-alias-border-l1));
  background:color-mix(in srgb,var(--wsa-brand) 12%,var(--dsw-alias-bg-base));
  color:var(--dsw-alias-label-primary);font-weight:600;
  box-shadow:0 4px 12px -6px color-mix(in srgb,var(--wsa-brand) 40%,transparent);
}

.wsa-ob-textarea{
  box-sizing:border-box;width:100%;min-height:84px;padding:12px 14px;
  border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 10%,var(--dsw-alias-border-l1));
  border-radius:12px;
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 2.5%,var(--dsw-alias-bg-base));
  color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.65;
  resize:vertical;outline:none;
  transition:border-color 160ms var(--wsa-ease),background-color 160ms var(--wsa-ease),box-shadow 160ms var(--wsa-ease);
}
.wsa-ob-textarea:focus{
  border-color:var(--wsa-brand);background:var(--dsw-alias-bg-base);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--wsa-brand) 20%,transparent);
}

.wsa-ob-soul-subbox{
  display:flex;flex-direction:column;gap:8px;margin-top:12px;padding:12px 14px;border-radius:12px;
  border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 9%,var(--dsw-alias-border-l1));
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 2.5%,var(--dsw-alias-bg-base));
}
.wsa-ob-soul-subhead{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.wsa-ob-soul-sublabel{display:inline-flex;align-items:center;gap:8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.wsa-ob-soul-pill{
  display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;
  font-size:11px;font-weight:500;border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-tertiary);
}
.wsa-ob-soul-pill[data-custom="true"]{
  color:var(--wsa-brand);border-color:color-mix(in srgb,var(--wsa-brand) 38%,var(--dsw-alias-border-l1));
  background:color-mix(in srgb,var(--wsa-brand) 10%,var(--dsw-alias-bg-base));
}
.wsa-ob-trait-rules{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.wsa-ob-trait-rule{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary)}
.wsa-ob-trait-rule-dot{flex:none;width:6px;height:6px;margin-top:6.5px;border-radius:999px;background:var(--wsa-brand)}
.wsa-ob-trait-rule strong{color:var(--dsw-alias-label-primary);font-weight:600}
.wsa-ob-trait-empty{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.wsa-ob-soul-subactions{display:inline-flex;align-items:center;gap:6px;flex:none}
.wsa-ob-trait-md-editor{min-height:142px;padding:10px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px;line-height:1.6}
.wsa-ob-soul-compose{
  display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;
  margin-top:12px;padding:9px 12px;border-radius:10px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);
}
.wsa-ob-soul-compose-parts{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.wsa-ob-soul-preview{
  margin:10px 0 0;padding:14px 16px;border-radius:12px;
  border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 10%,var(--dsw-alias-border-l1));
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 3.5%,var(--dsw-alias-bg-base));
  color:var(--dsw-alias-label-secondary);
  font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;
  font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;
  max-height:190px;overflow:auto;
  animation:wsa-ob-preview-expand 240ms var(--wsa-ease);
}

/* Step 3: DSH 记忆注入卡片列表 */
.wsa-ob-mem-list{display:flex;flex-direction:column;gap:12px}
.wsa-ob-mem-card{
  text-align:left;width:100%;padding:16px 18px;border-radius:14px;
  border:1px solid var(--dsw-alias-border-l1);
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 1.5%,var(--dsw-alias-bg-base));
  color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;
  transition:background-color 180ms var(--wsa-ease),border-color 180ms var(--wsa-ease),transform 200ms var(--wsa-spring),box-shadow 200ms var(--wsa-ease);
}
.wsa-ob-mem-card:hover{
  transform:translateY(-2px);
  background:var(--dsw-alias-interactive-bg-hover);
  box-shadow:0 10px 24px -16px rgb(0 0 0 / .35);
}
.wsa-ob-mem-card:active{transform:scale(.99)}
.wsa-ob-mem-card[data-selected="true"]{
  border-color:color-mix(in srgb,var(--wsa-brand) 60%,var(--dsw-alias-border-l1));
  background:
    radial-gradient(120% 130% at 100% 0%,color-mix(in srgb,var(--wsa-brand) 12%,transparent) 0%,transparent 70%),
    color-mix(in srgb,var(--wsa-brand) 5%,var(--dsw-alias-bg-base));
  box-shadow:0 10px 26px -16px color-mix(in srgb,var(--wsa-brand) 42%,transparent);
}
.wsa-ob-mem-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.wsa-ob-mem-title{display:flex;align-items:center;gap:10px;font-size:14px;font-weight:650}
.wsa-ob-mem-check{
  width:19px;height:19px;border-radius:6px;
  border:1.5px solid var(--dsw-alias-border-l1);
  display:inline-flex;align-items:center;justify-content:center;flex:none;
  font-size:11.5px;font-weight:700;line-height:1;color:transparent;
  background:var(--dsw-alias-bg-base);
  transition:background-color 180ms var(--wsa-ease),border-color 180ms var(--wsa-ease),transform 200ms var(--wsa-spring);
}
.wsa-ob-mem-card[data-selected="true"] .wsa-ob-mem-check{
  border-color:var(--wsa-brand);background:var(--wsa-brand);
  color:var(--dsw-static-neutral-bluish-00,#fff);
  transform:scale(1.05);
}
.wsa-ob-checkall{
  display:inline-flex;align-items:center;gap:7px;height:28px;padding:0 9px;border-radius:8px;
  border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;
  font-size:12.5px;font-weight:500;cursor:pointer;white-space:nowrap;flex:none;user-select:none;
  transition:background-color 160ms var(--wsa-ease),color 160ms var(--wsa-ease);
}
.wsa-ob-checkall:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.wsa-ob-checkall[aria-checked="true"],.wsa-ob-checkall[aria-checked="mixed"]{color:var(--dsw-alias-label-primary)}
.wsa-ob-checkall[aria-checked="true"] .wsa-ob-mem-check,.wsa-ob-checkall[aria-checked="mixed"] .wsa-ob-mem-check{
  border-color:var(--wsa-brand);background:var(--wsa-brand);color:var(--dsw-static-neutral-bluish-00,#fff);
}
.wsa-ob-mem-badge{
  display:inline-flex;align-items:center;gap:5px;
  font-size:11.5px;font-weight:500;padding:3px 9px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l1);
  color:var(--dsw-alias-label-secondary);
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,var(--dsw-alias-bg-base));
}
.wsa-ob-mem-card[data-selected="true"] .wsa-ob-mem-badge{
  border-color:color-mix(in srgb,var(--wsa-brand) 38%,var(--dsw-alias-border-l1));
  color:color-mix(in srgb,var(--wsa-brand) 85%,var(--dsw-alias-label-primary));
}
.wsa-ob-mem-desc{margin-top:7px;padding-left:29px;font-size:12.5px;line-height:1.55;color:var(--dsw-alias-label-secondary)}
.wsa-ob-mem-items{margin:8px 0 0;padding-left:45px;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-tertiary)}
.wsa-ob-mem-snippets{display:flex;flex-wrap:wrap;gap:7px;margin-top:10px}
.wsa-ob-mem-snippet{
  display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 11px;border-radius:999px;
  border:1px dashed color-mix(in srgb,var(--dsw-alias-label-primary) 18%,var(--dsw-alias-border-l1));
  background:transparent;color:var(--dsw-alias-label-secondary);
  font:inherit;font-size:11.5px;cursor:pointer;
  transition:background-color 150ms var(--wsa-ease),border-color 150ms var(--wsa-ease),color 150ms var(--wsa-ease),transform 150ms var(--wsa-spring);
}
.wsa-ob-mem-snippet:hover{
  background:color-mix(in srgb,var(--wsa-brand) 8%,var(--dsw-alias-bg-base));
  border-color:color-mix(in srgb,var(--wsa-brand) 45%,var(--dsw-alias-border-l1));
  color:var(--dsw-alias-label-primary);transform:translateY(-1px);
}

/* Step 4: 确认开启蓝图预览 */
.wsa-ob-launch-preview{
  margin:20px 26px 4px;padding:18px 20px;border-radius:16px;
  border:1px solid color-mix(in srgb,var(--wsa-brand) 34%,var(--dsw-alias-border-l1));
  background:
    radial-gradient(120% 140% at 0% 0%,color-mix(in srgb,var(--wsa-brand) 14%,transparent) 0%,transparent 65%),
    color-mix(in srgb,var(--dsw-alias-label-primary) 2.5%,var(--dsw-alias-bg-base));
  display:flex;align-items:center;gap:16px;
  animation:wsa-ob-stagger-up 320ms var(--wsa-ease) both;
}
.wsa-ob-launch-avatar{
  width:52px;height:52px;border-radius:15px;flex:none;
  border:1px solid color-mix(in srgb,var(--wsa-brand) 40%,var(--dsw-alias-border-l1));
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--dsw-alias-bg-base));
  display:flex;align-items:center;justify-content:center;overflow:hidden;
}
.wsa-ob-launch-copy{min-width:0;flex:1}
.wsa-ob-launch-title{display:flex;align-items:center;gap:8px;font-size:14.5px;font-weight:650;color:var(--dsw-alias-label-primary)}
.wsa-ob-launch-quote{margin-top:4px;font-size:12.5px;line-height:1.55;color:var(--dsw-alias-label-secondary)}

.wsa-ob-sum-avatar{
  width:22px;height:22px;border-radius:7px;
  border:1px solid var(--dsw-alias-border-l1);
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--dsw-alias-bg-base));
  display:inline-flex;align-items:center;justify-content:center;overflow:hidden;flex:none;
}
.wsa-ob-summary-right{
  display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:10px;
  font-size:13px;color:var(--dsw-alias-label-primary);font-weight:550;
}
.wsa-ob-link{
  border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--dsw-alias-bg-base));
  color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;font-weight:500;
  cursor:pointer;padding:4px 10px;border-radius:7px;
  transition:background-color 150ms var(--wsa-ease),color 150ms var(--wsa-ease),border-color 150ms var(--wsa-ease),transform 150ms var(--wsa-ease);
}
.wsa-ob-link:hover{
  color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-interactive-bg-hover);
  border-color:var(--dsw-alias-border-l1);
}
.wsa-ob-link:active{transform:scale(.96)}

.wsa-ob-switch{
  position:relative;width:44px;height:24px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l1);
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 16%,var(--dsw-alias-bg-base));
  padding:0;cursor:pointer;flex:none;
  transition:background-color 180ms var(--wsa-ease),border-color 180ms var(--wsa-ease),box-shadow 180ms var(--wsa-ease);
}
.wsa-ob-switch[aria-checked="true"]{
  background:var(--wsa-brand);border-color:transparent;
  box-shadow:0 4px 12px -4px color-mix(in srgb,var(--wsa-brand) 55%,transparent);
}
.wsa-ob-switch-thumb{
  position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:999px;
  background:#fff;box-shadow:0 2px 5px rgb(0 0 0 / .22);
  transition:transform 220ms var(--wsa-spring);
}
.wsa-ob-switch[aria-checked="true"] .wsa-ob-switch-thumb{transform:translateX(20px)}

.wsa-ob-notice{
  padding:13px 26px;
  border-top:1px solid var(--dsw-alias-border-l1);
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 3.5%,var(--dsw-alias-bg-base));
  display:flex;align-items:center;justify-content:space-between;gap:12px;
  font-size:12.5px;color:var(--dsw-alias-label-secondary);
}

.wsa-ob-foot{
  display:flex;align-items:center;justify-content:space-between;gap:14px;
  padding:16px 26px;
  border-top:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 8%,var(--dsw-alias-border-l1));
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 2.5%,var(--dsw-alias-bg-base));
}
.wsa-ob-foot-hint{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--dsw-alias-label-tertiary)}
.wsa-ob-btn{
  display:inline-flex;align-items:center;justify-content:center;gap:8px;
  height:40px;padding:0 18px;border-radius:11px;
  border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 12%,var(--dsw-alias-border-l1));
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  font:inherit;font-size:13.5px;font-weight:550;cursor:pointer;
  transition:background-color 160ms var(--wsa-ease),border-color 160ms var(--wsa-ease),opacity 160ms var(--wsa-ease),transform 160ms var(--wsa-spring),box-shadow 180ms var(--wsa-ease);
}
.wsa-ob-btn:hover:enabled{
  background:var(--dsw-alias-interactive-bg-hover);
  transform:translateY(-1px);
}
.wsa-ob-btn:active:enabled{transform:scale(.97)}
.wsa-ob-btn:disabled{opacity:.5;cursor:default}
.wsa-ob-btn[data-primary="true"]{
  padding:0 22px;
  background:linear-gradient(135deg,color-mix(in srgb,var(--wsa-brand) 92%,#60a5fa) 0%,var(--wsa-brand) 100%);
  border-color:color-mix(in srgb,#fff 16%,transparent);
  color:var(--dsw-static-neutral-bluish-00,var(--dsw-alias-label-primary-foreground,#fff));
  font-weight:650;
  box-shadow:0 10px 24px -8px color-mix(in srgb,var(--wsa-brand) 58%,transparent),inset 0 1px 0 color-mix(in srgb,#fff 22%,transparent);
}
.wsa-ob-btn[data-primary="true"]:hover:enabled{
  opacity:.96;
  box-shadow:0 14px 28px -8px color-mix(in srgb,var(--wsa-brand) 72%,transparent),inset 0 1px 0 color-mix(in srgb,#fff 28%,transparent);
}

@media(max-width:760px){
  .wsa-onboarding{padding:20px 16px 44px}
  .wsa-ob-hero{flex-direction:column;align-items:flex-start;padding:18px}
  .wsa-ob-hero-right{align-items:flex-start;flex-direction:row;justify-content:space-between;width:100%}
  .wsa-ob-steps{grid-template-columns:repeat(2,minmax(0,1fr))}
  .wsa-ob-row{flex-direction:column;align-items:stretch;gap:12px;padding:18px}
  .wsa-ob-block,.wsa-ob-card-head,.wsa-ob-foot{padding-left:18px;padding-right:18px}
  .wsa-ob-select{max-width:none;width:100%}
  .wsa-ob-cap-grid,.wsa-ob-presets,.wsa-ob-name-grid{grid-template-columns:1fr}
  .wsa-ob-identity{flex-direction:column;align-items:flex-start}
  .wsa-ob-name-grid{width:100%}
  .wsa-ob-launch-preview{margin:16px 18px 4px}
}
@media(prefers-reduced-motion:reduce){
  .wsa-ob-ambient::before,.wsa-ob-logo-Wrap-glow,.wsa-ob-card,.wsa-ob-row,.wsa-ob-block,.wsa-ob-launch-preview,.wsa-ob-soul-preview,.wsa-ob-step-tab[data-done="true"] .wsa-ob-step-num{animation:none!important}
}

/* 右侧个人面板未初始化态轻量骨架预览 */
.wsa-preview-aside{box-sizing:border-box;height:100%;display:flex;flex-direction:column;justify-content:space-between;padding:16px;color:var(--dsw-alias-label-secondary)}
.wsa-preview-top{display:flex;flex-direction:column;gap:12px}
.wsa-preview-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-bottom:10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.wsa-preview-head strong{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.wsa-preview-badge{font-size:11px;padding:1px 6px;border-radius:5px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary)}
.wsa-preview-card{padding:11px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 2%,var(--dsw-alias-bg-base))}
.wsa-preview-card-head{display:flex;align-items:center;justify-content:space-between;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);margin-bottom:8px}
.wsa-preview-bar{height:7px;border-radius:4px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,var(--dsw-alias-bg-base))}
.wsa-preview-bar+.wsa-preview-bar{margin-top:6px;width:68%}
.wsa-preview-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-tertiary)}
.wsa-preview-diag{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;padding:2px 4px;border-radius:4px}
.wsa-preview-diag:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}

/* 大肥鱼首次进入主动欢迎消息 */
.wsa-welcome-wrap{box-sizing:border-box;width:100%;padding:20px calc(var(--dsh-composer-side-clearance,8px) + 16px) 4px}
.wsa-welcome{box-sizing:border-box;max-width:var(--dsh-chat-content-width,min(calc(100% - 32px),920px));width:100%;margin:0 auto;padding:16px 18px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary);font-size:13.5px;line-height:1.65}
.wsa-welcome-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.wsa-welcome-avatar{width:24px;height:24px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,var(--dsw-alias-bg-base));display:inline-flex;align-items:center;justify-content:center;overflow:hidden;flex:none}
.wsa-welcome-author{font-size:13.5px;font-weight:600;color:var(--dsw-alias-label-primary)}
.wsa-welcome-badge{font-size:11px;padding:1px 6px;border-radius:5px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base)}
.wsa-welcome-reconfig{margin-left:auto;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;padding:2px 6px;border-radius:5px}
.wsa-welcome-reconfig:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.wsa-welcome p{margin:0 0 8px}
.wsa-welcome-list{margin:0 0 12px;padding-left:18px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.65}
.wsa-welcome-list li+li{margin-top:3px}
.wsa-welcome-list strong{color:var(--dsw-alias-label-primary);font-weight:550}
.wsa-welcome-guide{margin-top:10px;padding:11px 13px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-base)}
.wsa-welcome-guide-title{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:4px}
.wsa-welcome-guide-desc{margin:0 0 10px!important;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.wsa-welcome-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.wsa-welcome-btn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;font-weight:500;cursor:pointer;transition:background-color 140ms var(--wsa-ease),opacity 140ms var(--wsa-ease),transform 140ms var(--wsa-ease)}
.wsa-welcome-btn:hover:enabled{background:var(--dsw-alias-interactive-bg-hover)}
.wsa-welcome-btn:active:enabled{transform:scale(.97)}
.wsa-welcome-btn:disabled{opacity:.5;cursor:default}
.wsa-welcome-btn[data-primary="true"]{background:var(--dsw-alias-brand-primary-new-colorprimary-new-color,var(--dsw-alias-label-primary));border-color:transparent;color:var(--dsw-static-neutral-bluish-00,var(--dsw-alias-label-primary-foreground))}
.wsa-welcome-btn[data-primary="true"]:hover:enabled{opacity:.9}

/* 历史消息顶部按页加载按钮（每次 30 条） */
.wsa-chat [data-chat-flow] > [class*="_older"]{display:none!important}
@keyframes wsa-history-spin{to{transform:rotate(360deg)}}
.wsa-history-pager{
  box-sizing:border-box;width:100%;
  padding:10px calc(var(--dsh-composer-side-clearance,8px) + 16px) 2px;
  display:flex;justify-content:center;align-items:center;
}
.wsa-history-pager-inner{
  box-sizing:border-box;max-width:var(--dsh-chat-content-width,min(calc(100% - 32px),920px));
  width:100%;margin:0 auto;display:flex;align-items:center;justify-content:center;gap:12px;
}
.wsa-history-pager-line{
  flex:1;height:1px;
  background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--dsw-alias-border-l1) 85%,transparent),transparent);
}
.wsa-history-load-btn{
  display:inline-flex;align-items:center;justify-content:center;gap:7px;
  height:32px;padding:0 16px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l1);
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,var(--dsw-alias-bg-base));
  color:var(--dsw-alias-label-secondary);
  font:inherit;font-size:12.5px;font-weight:550;line-height:1;
  cursor:pointer;user-select:none;
  box-shadow:0 2px 8px -2px rgb(0 0 0 / .08);
  transition:background-color 150ms var(--wsa-ease),border-color 150ms var(--wsa-ease),color 150ms var(--wsa-ease),transform 150ms var(--wsa-ease),box-shadow 150ms var(--wsa-ease);
}
.wsa-history-load-btn:hover:enabled{
  background:var(--dsw-alias-interactive-bg-hover);
  border-color:color-mix(in srgb,var(--wsa-brand) 38%,var(--dsw-alias-border-l1));
  color:var(--dsw-alias-label-primary);
  transform:translateY(-1px);
  box-shadow:0 4px 12px -3px rgb(0 0 0 / .14);
}
.wsa-history-load-btn:active:enabled{transform:scale(.97)}
.wsa-history-load-btn:disabled{opacity:.68;cursor:default}
.wsa-history-load-badge{
  font-size:11px;font-weight:500;padding:1px 6px;border-radius:999px;
  background:color-mix(in srgb,var(--wsa-brand) 10%,var(--dsw-alias-bg-base));
  color:color-mix(in srgb,var(--wsa-brand) 82%,var(--dsw-alias-label-secondary));
  font-variant-numeric:tabular-nums;
}
.wsa-history-spinner{
  width:13px;height:13px;border-radius:999px;
  border:1.8px solid color-mix(in srgb,var(--dsw-alias-label-tertiary) 35%,transparent);
  border-top-color:var(--wsa-brand);
  animation:wsa-history-spin .75s linear infinite;flex:none;
}

/* 输入框上方 Suggestion List */
.wsa-suggestions{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,8px)*2 - var(--dsh-composer-dock-inset,8px)*2);max-width:calc(var(--dsh-composer-card-max-width,952px) - var(--dsh-composer-dock-inset,8px)*2);margin:0 auto 2px;display:flex;align-items:center;gap:7px;overflow-x:auto;padding:2px 2px 4px;scrollbar-width:none}
.wsa-suggestions::-webkit-scrollbar{display:none}
.wsa-suggestion-pill{display:inline-flex;flex:none;align-items:center;gap:6px;height:29px;padding:0 11px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;white-space:nowrap;cursor:pointer;transition:background-color 140ms var(--wsa-ease),color 140ms var(--wsa-ease),border-color 140ms var(--wsa-ease),transform 140ms var(--wsa-ease)}
.wsa-suggestion-pill:hover:enabled{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.wsa-suggestion-pill:active:enabled{transform:scale(.97)}
.wsa-suggestion-pill:disabled{opacity:.5;cursor:default}
.wsa-suggestion-pill[data-primary="true"]{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary-new-colorprimary-new-color,var(--dsw-alias-label-primary)) 38%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-brand-primary-new-colorprimary-new-color,var(--dsw-alias-label-primary)) 8%,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary);font-weight:500}

@media(max-width:1100px){
  .wsa-chat-scrim{display:block;position:absolute;inset:0;z-index:20;margin:0;padding:0;border:0;background:rgb(0 0 0 / .26);cursor:default;animation:wsa-chat-fade 160ms var(--wsa-ease)}
  .wsa-chat-detail{position:absolute;inset:0 0 0 auto;z-index:21;width:min(348px,92%);background:var(--dsw-alias-bg-base);box-shadow:-24px 0 60px -20px rgb(0 0 0 / .42);animation:wsa-chat-drawer 180ms var(--wsa-ease)}
  .wsa-chat-config-pill{display:none}
}
@keyframes wsa-chat-fade{from{opacity:0}}
@keyframes wsa-chat-drawer{from{opacity:0;transform:translateX(14px)}}
@media(prefers-reduced-motion:reduce){.wsa-chat-scrim,.wsa-chat-detail,.wsa-history-spinner{animation:none}}
`;

const EMPTY_CHAT_ORDER: readonly string[] = [];
const EMPTY_CHAT_NODES: HistoryChatNodeLookup = { get: () => undefined };

type InputActionsLike = { setDraft?(text: string): void; submit?(): void };
type FixedChatProps = {
  sessionId?: string;
  renderSlot(key: 'conversation.session', owner: { view: 'chat' }): React.ReactNode;
  inputActions?: InputActionsLike;
  useInput?: <T>(selector: (state: { draft?: string; phase?: string }) => T) => T;
  useSession?: <T>(selector: (state: { hasMore?: boolean; loadingOlder?: boolean; openState?: string; running?: boolean }) => T) => T;
  useChat?: <T>(selector: (state: { order: readonly string[]; nodes: HistoryChatNodeLookup }) => T) => T;
};
type SuggestionDockProps = {
  sessionId?: string;
  session?: { running?: boolean };
  input?: { draft?: string; phase?: string };
  inputActions?: InputActionsLike;
};

function focusComposerEditor() {
  if (typeof document === 'undefined') return;
  const editor = document.querySelector<HTMLElement>('[data-superagent-chat] [contenteditable="true"], [data-superagent-chat] textarea');
  editor?.focus();
}

class ChatPanelBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { console.error(`${getBotProfile().botName || DEFAULT_BOT_NAME} 面板加载失败`, error); }
  render() {
    if (!this.state.failed) return this.props.children;
    const botName = getBotProfile().botName || DEFAULT_BOT_NAME;
    return <section className="wsa-chat" data-superagent-chat="">
      <style>{css}</style>
      <header className="wsa-chat-head"><strong>{botName}</strong></header>
      <div className="wsa-chat-empty">
        <p role="status">暂时无法显示主理对话。</p>
        <button type="button" onClick={() => this.setState({ failed: false })}>重新加载对话</button>
      </div>
    </section>;
  }
}

export interface RemoteCatalogStore {
  get(): ModelCatalogRemote | undefined;
  subscribe(fn: () => void): () => void;
}

export function createChatPanel(
  ctx: Context,
  HealthPage: React.ComponentType<{ onBack?: () => void }>,
  openChat: () => void,
  isChatOpen: () => boolean,
  remoteStore?: RemoteCatalogStore,
) {
  let managerId: string | null = null;
  let workspaceLabel = '';
  let workspaceListStyle: HTMLStyleElement | undefined;
  let dispatchPrompt: ((text: string, mode?: 'send' | 'draft', inputActions?: InputActionsLike) => Promise<void>) | null = null;
  let openOnboardingGuide: (() => void) | null = null;
  const busyListeners = new Set<() => void>();
  let busySending = false;
  function setBusySending(next: boolean) {
    if (busySending === next) return;
    busySending = next;
    for (const listener of busyListeners) listener();
  }
  function useBusySending() {
    return React.useSyncExternalStore(
      listener => { busyListeners.add(listener); return () => busyListeners.delete(listener); },
      () => busySending,
    );
  }
  const USED_SUGGESTIONS_STORAGE_KEY = 'workspace-superagent-used-suggestions';
  const usedSuggestionKeys = new Set<string>();
  try {
    const rawSaved = typeof window !== 'undefined' ? window.localStorage.getItem(USED_SUGGESTIONS_STORAGE_KEY) : null;
    if (rawSaved) {
      const parsed = JSON.parse(rawSaved) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === 'string' && item.trim()) usedSuggestionKeys.add(item.trim());
        }
      }
    }
  } catch { /* ignore storage errors */ }
  function persistUsedSuggestionKeys() {
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(USED_SUGGESTIONS_STORAGE_KEY, JSON.stringify([...usedSuggestionKeys]));
      }
    } catch { /* ignore storage errors */ }
  }
  const CLIENT_ASCII_STOPWORDS = new Set([
    'workspace', 'dsh', 'soul', 'memory', 'memories', 'todo', 'todos', 'task', 'tasks',
    'board', 'session', 'sessions', 'json', 'llm', 'check', 'route', 'calendar', 'edit',
    'link', 'clock', 'pr', 'id', 'ui', 'api', 'app', 'web', 'dev',
  ]);
  function extractClientTopicIds(text: string): string[] {
    const rawIds = text.toLowerCase().match(/[a-z][a-z0-9._-]{2,}/gu) ?? [];
    return [
      ...new Set(
        rawIds
          .map(t => t.replace(/^[._-]+|[._-]+$/gu, ''))
          .filter(t => t.length >= 3 && !CLIENT_ASCII_STOPWORDS.has(t)),
      ),
    ];
  }
  function isSuggestionUsed(item: Pick<ChatSuggestionItem, 'id' | 'label' | 'prompt'>): boolean {
    if (usedSuggestionKeys.size === 0) return false;
    if (
      (!item.id.startsWith('llm-suggestion-') && usedSuggestionKeys.has(item.id)) ||
      usedSuggestionKeys.has(item.label.trim()) ||
      usedSuggestionKeys.has(item.prompt.trim())
    ) {
      return true;
    }
    if (item.id === FIXED_DAILY_SUGGESTION.id) return false;
    const candIds = extractClientTopicIds(item.label);
    if (candIds.length > 0) {
      for (const used of usedSuggestionKeys) {
        if (used.length > 48 || used.startsWith('llm-')) continue;
        const refIds = extractClientTopicIds(used);
        if (candIds.some(id => refIds.includes(id))) return true;
      }
    }
    return false;
  }
  function filterUnusedSuggestionsPayload(payload: ChatSuggestionsPayload): ChatSuggestionsPayload {
    const fixedDismissed = isSuggestionUsed(FIXED_DAILY_SUGGESTION);
    const dailyReviewConfigured = payload.dailyReviewConfigured || fixedDismissed;
    const dynamicItems = payload.items
      .filter(item => item.id !== FIXED_DAILY_SUGGESTION.id && !isSuggestionUsed(item))
      .slice(0, 3);
    const items = dailyReviewConfigured ? dynamicItems : [FIXED_DAILY_SUGGESTION, ...dynamicItems];
    return { dailyReviewConfigured, items };
  }
  const suggestionListeners = new Set<() => void>();
  let currentSuggestions: ChatSuggestionsPayload = filterUnusedSuggestionsPayload({
    dailyReviewConfigured: false,
    items: [FIXED_DAILY_SUGGESTION, ...DEFAULT_DYNAMIC_SUGGESTIONS],
  });
  let triggerSuggestionsRefresh: ((dismissKeys?: readonly string[]) => void) | null = null;
  function setSuggestionsPayload(next: ChatSuggestionsPayload) {
    currentSuggestions = filterUnusedSuggestionsPayload(next);
    for (const listener of suggestionListeners) listener();
  }
  function markSuggestionUsed(item: Pick<ChatSuggestionItem, 'id' | 'label' | 'prompt'>) {
    const keys: string[] = [];
    if (!item.id.startsWith('llm-suggestion-') && item.id.trim()) keys.push(item.id.trim());
    if (item.label.trim()) keys.push(item.label.trim());
    if (item.prompt.trim()) keys.push(item.prompt.trim());
    for (const key of keys) usedSuggestionKeys.add(key);
    persistUsedSuggestionKeys();
    currentSuggestions = filterUnusedSuggestionsPayload(currentSuggestions);
    for (const listener of suggestionListeners) listener();
    triggerSuggestionsRefresh?.(keys);
  }
  function clearUsedSuggestions() {
    usedSuggestionKeys.clear();
    try {
      if (typeof window !== 'undefined') window.localStorage.removeItem(USED_SUGGESTIONS_STORAGE_KEY);
    } catch { /* ignore */ }
  }
  function syncDailyReviewConfiguredFlag(configured: boolean) {
    const effective = configured || isSuggestionUsed(FIXED_DAILY_SUGGESTION);
    if (currentSuggestions.dailyReviewConfigured === effective) return;
    const dynamicOnly = currentSuggestions.items.filter(item => item.id !== FIXED_DAILY_SUGGESTION.id).slice(0, 3);
    const items = effective ? dynamicOnly : [FIXED_DAILY_SUGGESTION, ...dynamicOnly];
    setSuggestionsPayload({ dailyReviewConfigured: effective, items });
  }
  function useSuggestionsPayload() {
    return React.useSyncExternalStore(
      listener => { suggestionListeners.add(listener); return () => suggestionListeners.delete(listener); },
      () => currentSuggestions,
    );
  }
  function useCatalogRemote(): ModelCatalogRemote | undefined {
    return React.useSyncExternalStore(
      listener => remoteStore ? remoteStore.subscribe(listener) : () => {},
      () => remoteStore?.get() ?? ((ctx as unknown as { get?(name: string): unknown }).get?.('remote') as ModelCatalogRemote | undefined),
    );
  }
  const DAILY_MOTTO_STORAGE_KEY = 'workspace-superagent-daily-motto';
  const BOUND_SESSION_STORAGE_KEY = 'workspace-superagent-bound-session';
  let boundSessionHint: string | null = null;
  let cachedMotto: DailyMotto | null = null;
  try {
    if (typeof window !== 'undefined') {
      const savedBound = window.localStorage.getItem(BOUND_SESSION_STORAGE_KEY);
      if (savedBound && savedBound.trim()) {
        boundSessionHint = savedBound.trim();
        managerId = boundSessionHint;
      }
      const savedMotto = window.localStorage.getItem(DAILY_MOTTO_STORAGE_KEY);
      if (savedMotto) {
        const parsed = JSON.parse(savedMotto) as DailyMotto | null;
        if (parsed && parsed.day === localMottoDay() && typeof parsed.text === 'string' && parsed.text.trim()) {
          cachedMotto = parsed;
        }
      }
    }
  } catch { /* ignore storage errors */ }

  let cachedHealth: HealthView | undefined;
  let cachedToken: string | null = null;
  let cachedGroups: readonly ModelCatalogGroup[] = [];
  const healthListeners = new Set<() => void>();
  const mottoListeners = new Set<() => void>();
  let mottoRequestInFlight = false;
  let personalPrewarmInFlight = false;

  function notifyHealth() {
    for (const listener of healthListeners) listener();
  }
  function setSharedMotto(next: DailyMotto | null) {
    if (cachedMotto?.day === next?.day && cachedMotto?.text === next?.text) return;
    cachedMotto = next;
    try {
      if (typeof window !== 'undefined') {
        if (next) window.localStorage.setItem(DAILY_MOTTO_STORAGE_KEY, JSON.stringify(next));
        else window.localStorage.removeItem(DAILY_MOTTO_STORAGE_KEY);
      }
    } catch { /* ignore storage errors */ }
    for (const listener of mottoListeners) listener();
  }
  async function refreshSharedMotto(signal?: AbortSignal) {
    const day = localMottoDay();
    if (cachedMotto?.day === day || mottoRequestInFlight) return;
    mottoRequestInFlight = true;
    try {
      const { dailyMotto } = await mutateChat({ dailyMotto: true }, cachedToken, signal);
      if (!signal?.aborted && dailyMotto?.day === localMottoDay() && dailyMotto.text?.trim()) {
        setSharedMotto(dailyMotto);
      }
    } catch { /* 标语暂不可用时显示主理名称。 */ }
    finally { mottoRequestInFlight = false; }
  }
  function prewarmPersonalSnapshot(sessionId: string, signal?: AbortSignal) {
    if (!sessionId || getCachedPersonalSnapshot(sessionId) || personalPrewarmInFlight) return;
    personalPrewarmInFlight = true;
    void fetch('/api/workspace-superagent/personal', { credentials: 'same-origin', cache: 'no-store', signal })
      .then(async response => {
        const value = await response.json() as PersonalSnapshot & { error?: string };
        if (response.ok && value.ok && value.todos && value.schedules && value.activities) {
          publishPersonalSnapshot(sessionId, value);
        }
      })
      .catch(() => {})
      .finally(() => { personalPrewarmInFlight = false; });
  }

  let retainedReference: ChatReference | undefined;
  let retainedDetach: (() => void) | undefined;
  let retainedTargetId: string | null = null;
  let retainedAbort: AbortController | null = null;
  let retainedTimer: number | undefined;
  let retainedListUnsub: (() => void) | undefined;
  let retainedError = false;
  const retainedListeners = new Set<() => void>();

  function notifyRetained() {
    for (const listener of retainedListeners) listener();
  }
  function cleanupRetained() {
    retainedAbort?.abort();
    retainedAbort = null;
    if (retainedTimer !== undefined) {
      window.clearTimeout(retainedTimer);
      retainedTimer = undefined;
    }
    if (retainedListUnsub) {
      retainedListUnsub();
      retainedListUnsub = undefined;
    }
    try { retainedDetach?.(); }
    finally {
      retainedReference?.release();
      retainedDetach = undefined;
      retainedReference = undefined;
    }
  }
  function ensureSessionRetained(sessionId: string | null, forceRetry = false) {
    if (!sessionId) {
      const hadState = Boolean(retainedTargetId || retainedReference || retainedError || retainedAbort);
      cleanupRetained();
      retainedTargetId = null;
      retainedError = false;
      if (hadState) notifyRetained();
      return;
    }
    if (!forceRetry && retainedTargetId === sessionId && (retainedReference?.sessionId === sessionId || retainedAbort)) {
      return;
    }
    cleanupRetained();
    retainedTargetId = sessionId;
    retainedError = false;
    notifyRetained();
    const abort = new AbortController();
    retainedAbort = abort;
    let inFlight = false;
    let attempt = 0;

    async function tryOpen() {
      if (inFlight || abort.signal.aborted || retainedReference?.sessionId === sessionId) return;
      inFlight = true;
      let candidate: ChatReference | undefined;
      let detach: (() => void) | undefined;
      try {
        const sessions = ctx.get('sessions') as unknown as {
          retain(id: string, options: { source: string; signal: AbortSignal }): ChatReference;
          manager?: { remote?: { session?: object } };
          refresh?(): Promise<unknown>;
          list?: { subscribe?(fn: () => void): () => void };
        } | undefined;
        if (!sessions?.retain) throw new Error('unknown session');
        const managerObj = sessions.manager && typeof sessions.manager === 'object' ? sessions.manager : undefined;
        const prevManagerRemote = managerObj?.remote;
        if (managerObj && prevManagerRemote && typeof prevManagerRemote === 'object') {
          try {
            managerObj.remote = withRemoteHistoryPagination(prevManagerRemote, sessionId!);
          } catch { /* ignore readonly remote */ }
        }
        try {
          candidate = sessions.retain(sessionId!, { source: 'workspaceSuperagent', signal: abort.signal });
        } finally {
          if (managerObj && prevManagerRemote !== undefined) {
            try { managerObj.remote = prevManagerRemote; } catch { /* ignore */ }
          }
        }
        const earlySession = candidate?.binding?.session;
        if (earlySession?.remote && typeof earlySession.remote === 'object') {
          const paginatedEarly = withRemoteHistoryPagination(earlySession.remote, sessionId!);
          if (earlySession.events && typeof earlySession.events === 'object' && 'remote' in earlySession.events) {
            earlySession.events.remote = paginatedEarly;
          }
        }
        await candidate.ready;
        abort.signal.throwIfAborted();
        detach = attachChatTransport(
          candidate,
          ctx.get('modelDirectories') as ChatModelDirectories,
          (body, signal) => mutateChat(body, cachedToken, signal),
        );
        if (retainedTimer !== undefined) {
          window.clearTimeout(retainedTimer);
          retainedTimer = undefined;
        }
        if (retainedListUnsub) {
          retainedListUnsub();
          retainedListUnsub = undefined;
        }
        retainedDetach = detach;
        retainedReference = candidate;
        retainedError = false;
        notifyRetained();
      } catch (error) {
        try { detach?.(); }
        finally { candidate?.release(); }
        if (abort.signal.aborted) return;
        // 会话目录在页面加载后异步到达，而默认页可能在目录就绪前打开；此时主理会话还不在目录里，
        // 主动触发会话目录刷新并订阅列表更新，到达后立即重试。
        if (!(error instanceof Error && error.message.includes('unknown session'))) {
          console.error(`${getBotProfile().botName || DEFAULT_BOT_NAME} 会话加载失败`, error);
          retainedAbort = null;
          retainedError = true;
          notifyRetained();
          return;
        }
        const sessions = ctx.get('sessions') as unknown as {
          refresh?(): Promise<unknown>;
          list?: { subscribe?(fn: () => void): () => void };
        } | undefined;
        if (attempt === 0 || attempt % 5 === 0) {
          void sessions?.refresh?.()?.catch?.(() => {});
        }
        if (!retainedListUnsub && typeof sessions?.list?.subscribe === 'function') {
          retainedListUnsub = sessions.list.subscribe(() => {
            if (!abort.signal.aborted && !retainedReference) {
              void tryOpen();
            }
          });
        }
        if (attempt >= 60) {
          retainedAbort = null;
          retainedError = true;
          notifyRetained();
          return;
        }
        attempt += 1;
        if (retainedTimer !== undefined) window.clearTimeout(retainedTimer);
        retainedTimer = window.setTimeout(() => {
          retainedTimer = undefined;
          if (!abort.signal.aborted) void tryOpen();
        }, 240);
      } finally {
        inFlight = false;
      }
    }
    void tryOpen();
  }

  function shouldAutoConnect(next: HealthView | undefined): boolean {
    return Boolean(
      next?.chat?.sessionId &&
      !next.chat.ready &&
      !next.chat.reason &&
      next.summary?.manager.lifecycle === 'paused' &&
      next.capacityBlocks.length === 0,
    );
  }

  function setManagerId(id: string | null) {
    managerId = id;
    // 主理的工作区绑定用于恢复会话，隐藏侧栏中与绑定 ID 及主理专属前缀匹配的行。
    if (workspaceListStyle) {
      const rules = ['[data-slot="sidebar.workspaces"] [data-row-key^="session:session-superagent-"]{display:none!important}'];
      if (id) {
        rules.push(`[data-slot="sidebar.workspaces"] [data-row-key="${CSS.escape('session:' + id)}"]{display:none!important}`);
      }
      workspaceListStyle.textContent = rules.join('\n');
    }
  }

  function adoptSharedHealth(next: HealthView, nextToken?: string | null) {
    if (nextToken !== undefined && nextToken !== null) cachedToken = nextToken;
    cachedHealth = next;
    const nextSessionId = next.chat?.sessionId ?? null;
    setManagerId(nextSessionId);
    boundSessionHint = nextSessionId;
    try {
      if (typeof window !== 'undefined') {
        if (nextSessionId) window.localStorage.setItem(BOUND_SESSION_STORAGE_KEY, nextSessionId);
        else if (next.chat !== undefined) window.localStorage.removeItem(BOUND_SESSION_STORAGE_KEY);
      }
    } catch { /* ignore storage errors */ }
    workspaceLabel = next.chat?.workspace ?? '';
    if (next.chat?.dailyReviewConfigured !== undefined) {
      syncDailyReviewConfiguredFlag(next.chat.dailyReviewConfigured);
    }
    if (next.chat?.soul) {
      setBotProfile({
        botName: next.chat.soul.botName || DEFAULT_BOT_NAME,
        avatarDataUrl: next.chat.soul.avatarDataUrl ?? null,
      });
    }
    ensureSessionRetained(nextSessionId);
    if (nextSessionId) {
      prewarmPersonalSnapshot(nextSessionId);
      if (next.chat?.ready) void refreshSharedMotto();
    }
    notifyHealth();
  }

  const OpenManager = () => {
    const profile = useBotProfile();
    return <button type="button" onClick={openChat}>打开{profile.botName || DEFAULT_BOT_NAME}</button>;
  };
  const slots = ctx.slots as unknown as {
    inject(name: 'conversation.composer', fn: () => unknown): unknown;
    register(options: { name: 'conversation.composer'; select(owner: { sessionId?: string }): true | null },
      component: typeof OpenManager): unknown;
  };
  slots.inject('conversation.composer', () => slots.register({
    name: 'conversation.composer', select: ({ sessionId }) => sessionId && sessionId === managerId && !isChatOpen() ? true : null,
  }, OpenManager));
  ctx.effect(() => {
    const abort = new AbortController();
    const style = document.createElement('style');
    workspaceListStyle = style;
    document.head.append(style);
    setManagerId(managerId);
    if (boundSessionHint) {
      ensureSessionRetained(boundSessionHint);
      prewarmPersonalSnapshot(boundSessionHint, abort.signal);
    }
    void readChatHealth(abort.signal)
      .then(async ({ health: next, token: ownerToken }) => {
        if (abort.signal.aborted) return;
        adoptSharedHealth(next, ownerToken);
        if (shouldAutoConnect(next) && next.summary) {
          try {
            const res = await mutateChat({ revision: next.summary.manager.revision }, cachedToken, abort.signal);
            if (!abort.signal.aborted && res.health) adoptSharedHealth(res.health);
          } catch { /* 留给面板内连接逻辑继续处理 */ }
        }
      })
      .catch(() => {});
    return () => {
      abort.abort();
      ensureSessionRetained(null);
      style.remove();
      if (workspaceListStyle === style) workspaceListStyle = undefined;
    };
  });
  const Card = createActionCard(
    ctx,
    sessionId => isChatOpen() && sessionId === managerId,
    () => workspaceLabel,
    () => {
      triggerSuggestionsRefresh?.();
      if (managerId) requestPersonalRefresh(managerId);
    },
  );
  const GenuiCard = createGenuiCard(
    ctx,
    sessionId => isChatOpen() && sessionId === managerId,
    Card.EmbeddedProposalSection,
  );
  const PersonalPanel = createPersonalPanel(ctx);

  function FixedChat({ sessionId, renderSlot, inputActions, useInput, useSession, useChat }: FixedChatProps) {
    const profile = useBotProfile();
    const displayName = profile.botName || DEFAULT_BOT_NAME;
    const sending = useBusySending();
    const { dailyReviewConfigured } = useSuggestionsPayload();
    const inputPhase = useInput ? useInput(s => s?.phase) : 'plain';
    const disabled = sending || (inputPhase !== undefined && inputPhase !== 'plain');

    const hasMore = useSession ? Boolean(useSession(s => s?.hasMore)) : false;
    const loadingOlder = useSession ? Boolean(useSession(s => s?.loadingOlder)) : false;
    const chatOrder = useChat ? useChat(s => s?.order ?? EMPTY_CHAT_ORDER) : EMPTY_CHAT_ORDER;
    const chatNodes = useChat ? useChat(s => s?.nodes ?? EMPTY_CHAT_NODES) : EMPTY_CHAT_NODES;
    const activeSessionKey = sessionId ?? managerId ?? '';

    const [visibleMessageLimit, setVisibleMessageLimit] = React.useState(WSA_HISTORY_PAGE_SIZE);
    const prevSessionKeyRef = React.useRef(activeSessionKey);
    const anchorTurnRef = React.useRef<number | null>(null);
    const pagerRef = React.useRef<HTMLDivElement | null>(null);
    const scrollAnchorRef = React.useRef<{
      element: HTMLElement;
      topOffset: number;
      scroller: HTMLElement;
    } | null>(null);

    React.useEffect(() => {
      if (prevSessionKeyRef.current !== activeSessionKey) {
        prevSessionKeyRef.current = activeSessionKey;
        anchorTurnRef.current = null;
        scrollAnchorRef.current = null;
        setVisibleMessageLimit(WSA_HISTORY_PAGE_SIZE);
      }
    }, [activeSessionKey]);

    const pagination = React.useMemo(
      () => computeHistoryPagination(chatOrder, chatNodes, visibleMessageLimit),
      [chatOrder, chatNodes, visibleMessageLimit],
    );

    React.useEffect(() => {
      if (pagination.hiddenMessageCount <= 0) {
        anchorTurnRef.current = pagination.firstVisibleTurn;
        return;
      }
      if (anchorTurnRef.current === null) {
        anchorTurnRef.current = pagination.firstVisibleTurn;
        return;
      }
      const messagesFromAnchor = countMessagesFromTurn(chatOrder, chatNodes, anchorTurnRef.current);
      if (messagesFromAnchor > visibleMessageLimit) {
        setVisibleMessageLimit(messagesFromAnchor);
      } else {
        anchorTurnRef.current = pagination.firstVisibleTurn;
      }
    }, [chatOrder, chatNodes, pagination.hiddenMessageCount, pagination.firstVisibleTurn, visibleMessageLimit]);

    React.useLayoutEffect(() => {
      const pendingAnchor = scrollAnchorRef.current;
      if (!pendingAnchor) return;
      if (pendingAnchor.element.isConnected && pendingAnchor.scroller.isConnected) {
        const currentTopOffset =
          pendingAnchor.element.getBoundingClientRect().top - pendingAnchor.scroller.getBoundingClientRect().top;
        const delta = currentTopOffset - pendingAnchor.topOffset;
        if (Math.abs(delta) > 0.5) {
          pendingAnchor.scroller.scrollTop += delta;
        }
      }
      if (!loadingOlder) {
        scrollAnchorRef.current = null;
      }
    }, [pagination.firstVisibleTurn, pagination.visibleMessages, chatOrder.length, loadingOlder]);

    const hiddenHistoryCss = React.useMemo(() => {
      if (pagination.hiddenTurnNumbers.length === 0 && pagination.hiddenNodeKeys.length === 0) return '';
      const selectors: string[] = [];
      for (const turn of pagination.hiddenTurnNumbers) {
        selectors.push(`.wsa-chat [data-slot="conversation.chat.flow"] > [data-chat-turn="${turn}"]`);
      }
      if (pagination.hiddenTurnNumbers.length === 0) {
        for (const key of pagination.hiddenNodeKeys) {
          const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
            ? CSS.escape(key)
            : key.replace(/"/gu, '\\"');
          selectors.push(`.wsa-chat [data-slot="conversation.chat.flow"] > [data-chat-node-key="${escaped}"]`);
        }
      }
      if (selectors.length === 0) return '';
      const firstTurnRule = pagination.firstVisibleTurn !== null
        ? `.wsa-chat [data-slot="conversation.chat.flow"] > [data-chat-turn="${pagination.firstVisibleTurn}"]:first-of-type{--dsh-chat-flow-gap:0px}`
        : '';
      return `${selectors.join(',')}{display:none!important}${firstTurnRule}`;
    }, [pagination.hiddenTurnNumbers, pagination.hiddenNodeKeys, pagination.firstVisibleTurn]);

    const canLoadMoreHistory = pagination.hiddenMessageCount > 0 || hasMore;

    const handleLoadMoreHistory = React.useCallback(() => {
      if (loadingOlder && pagination.hiddenMessageCount === 0) return;
      if (typeof document !== 'undefined') {
        const scroller =
          pagerRef.current?.closest<HTMLElement>('[data-conversation-scroll], .wsa-chat-body') ??
          document.querySelector<HTMLElement>('[data-superagent-chat] [data-conversation-scroll]');
        const anchorSelector = pagination.firstVisibleTurn !== null
          ? `.wsa-chat [data-slot="conversation.chat.flow"] > [data-chat-turn="${pagination.firstVisibleTurn}"]`
          : '.wsa-chat [data-slot="conversation.chat.flow"] > [data-chat-node-key]';
        const anchorElement = document.querySelector<HTMLElement>(anchorSelector);
        if (scroller && anchorElement) {
          scrollAnchorRef.current = {
            element: anchorElement,
            topOffset: anchorElement.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
            scroller,
          };
        }
      }
      const nextLimit = Math.max(visibleMessageLimit, pagination.visibleMessages) + WSA_HISTORY_PAGE_SIZE;
      anchorTurnRef.current = null;
      setVisibleMessageLimit(nextLimit);
      if (pagination.hiddenMessageCount < WSA_HISTORY_PAGE_SIZE && hasMore && !loadingOlder) {
        const nativeOlderBtn = typeof document !== 'undefined'
          ? document.querySelector<HTMLButtonElement>('.wsa-chat [data-chat-flow] > [class*="_older"] button:not(:disabled)')
          : null;
        if (nativeOlderBtn) {
          nativeOlderBtn.click();
        } else {
          void retainedReference?.binding?.session?.loadOlder?.();
        }
      }
    }, [hasMore, loadingOlder, pagination.firstVisibleTurn, pagination.hiddenMessageCount, pagination.visibleMessages, visibleMessageLimit]);

    const busyLoadingHistory = loadingOlder && pagination.hiddenMessageCount === 0;

    return <>
      {hiddenHistoryCss && <style data-superagent-history-style="">{hiddenHistoryCss}</style>}
      <div className="wsa-welcome-wrap" data-superagent-welcome="">
        <article className="wsa-welcome" aria-label={`${displayName}欢迎介绍与定时任务引导`}>
          <header className="wsa-welcome-head">
            <span className="wsa-welcome-avatar"><BotAvatar src={profile.avatarDataUrl} size={20} /></span>
            <span className="wsa-welcome-author">{displayName}</span>
            <span className="wsa-welcome-badge">工作区主理</span>
            <button type="button" className="wsa-welcome-reconfig" onClick={() => openOnboardingGuide?.()}>
              配置模型、Soul 与记忆 ›
            </button>
          </header>
          <p>嗨，我是<strong>{displayName}</strong>！我是常驻在工作区里的主理助手，平时可以帮你把每天的事儿打理得井井有条：</p>
          <ul className="wsa-welcome-list">
            <li><strong>个人待办与看板协同</strong>：随时帮你记待办、盘点今日优先级，或者生成看板卡片草稿（经你确认后创建）。</li>
            <li><strong>长期记忆与画像感知</strong>：自动记住你的偏好、项目上下文与关键决策，跨会话提供贴合你习惯的建议。</li>
            <li><strong>只读任务委派</strong>：需要翻代码、做调研或整理方案时，为你派发只读 Worker 并跟进汇总结论。</li>
            <li><strong>定时提醒与巡检</strong>：按你设定的时间自动执行早报、复盘或巡检任务。</li>
          </ul>
          {!dailyReviewConfigured && (
            <div className="wsa-welcome-guide">
              <div className="wsa-welcome-guide-title"><Icon name="clock" size={14} /><span>是否需要开启「每日早间总结与晚间复盘」功能？</span></div>
              <p className="wsa-welcome-guide-desc">
                开启后，我会默认在每天早上 <strong>09:00</strong> 为你生成早间总结与工作建议，每天晚上 <strong>20:30</strong> 为你整理晚间复盘（结合个人待办、任务看板与近期会话记录，生成 2 张独立草稿卡供你核对确认）。
              </p>
              <div className="wsa-welcome-actions">
                <button type="button" className="wsa-welcome-btn" data-primary="true" disabled={disabled}
                  onClick={() => {
                    markSuggestionUsed(FIXED_DAILY_SUGGESTION);
                    void dispatchPrompt?.(DAILY_SUMMARY_SCHEDULE_PROMPT, 'send', inputActions);
                  }}>
                  <Icon name="clock" size={13} /><span>开启每日日报与复盘</span>
                </button>
                <button type="button" className="wsa-welcome-btn" disabled={disabled}
                  onClick={() => {
                    markSuggestionUsed(FIXED_DAILY_SUGGESTION);
                    void dispatchPrompt?.(DAILY_SUMMARY_SCHEDULE_PROMPT, 'draft', inputActions);
                  }}>
                  <span>修改时间后发送</span>
                </button>
              </div>
            </div>
          )}
        </article>
      </div>
      {canLoadMoreHistory && (
        <div ref={pagerRef} className="wsa-history-pager" data-superagent-history-pager="">
          <div className="wsa-history-pager-inner">
            <span className="wsa-history-pager-line" aria-hidden="true" />
            <button
              type="button"
              className="wsa-history-load-btn"
              disabled={busyLoadingHistory}
              onClick={handleLoadMoreHistory}
              aria-label="加载更多历史消息"
            >
              {busyLoadingHistory ? (
                <>
                  <span className="wsa-history-spinner" aria-hidden="true" />
                  <span>正在加载历史消息...</span>
                </>
              ) : (
                <>
                  <Icon name="clock" size={13} />
                  <span>加载更多历史消息</span>
                  <span className="wsa-history-load-badge">
                    {pagination.hiddenMessageCount > 0
                      ? `还有 ${pagination.hiddenMessageCount}${hasMore ? '+' : ''} 条`
                      : `每次 ${WSA_HISTORY_PAGE_SIZE} 条`}
                  </span>
                </>
              )}
            </button>
            <span className="wsa-history-pager-line" aria-hidden="true" />
          </div>
        </div>
      )}
      {renderSlot('conversation.session', { view: 'chat' })}
    </>;
  }

  function Transcript({ renderFactorySlot }: PropsRenderFactories) {
    // 0.2.2-rc.1 的原生会话 Factory，由 ui-conversation 提供。
    const render = renderFactorySlot as unknown as (key: 'conversation.content',
      owner: { variant: 'embedded'; phase: 'active'; hero: false },
      options: { slots: { views: typeof FixedChat } }) => React.ReactNode;
    return <div className="wsa-chat-native">{render('conversation.content', { variant: 'embedded', phase: 'active', hero: false },
      { slots: { views: FixedChat } })}</div>;
  }

  function SuggestionDock({ sessionId, session, input, inputActions }: SuggestionDockProps) {
    const sending = useBusySending();
    const { dailyReviewConfigured, items } = useSuggestionsPayload();
    const prevRunningRef = React.useRef<boolean | undefined>(session?.running);
    React.useEffect(() => {
      if (sessionId && sessionId === managerId) {
        setPersonalSessionRunning(sessionId, Boolean(session?.running));
      }
      if (prevRunningRef.current === true && !session?.running) {
        triggerSuggestionsRefresh?.();
        if (sessionId) requestPersonalRefresh(sessionId);
      }
      prevRunningRef.current = session?.running;
    }, [session?.running, sessionId]);

    if (!isChatOpen() || !managerId || sessionId !== managerId) return null;
    if (session?.running || (input?.phase && input.phase !== 'plain') || input?.draft?.trim()) return null;

    const dynamicItems = items
      .filter(item => item.id !== FIXED_DAILY_SUGGESTION.id && !isSuggestionUsed(item))
      .slice(0, 3);
    const hideFixed = dailyReviewConfigured || isSuggestionUsed(FIXED_DAILY_SUGGESTION);
    const visibleItems = hideFixed ? dynamicItems : [FIXED_DAILY_SUGGESTION, ...dynamicItems];
    if (visibleItems.length === 0) return null;

    return <div className="wsa-suggestions" role="region" aria-label="快捷引导建议" data-superagent-suggestions="">
      {visibleItems.map(item => (
        <button key={item.id} type="button" className="wsa-suggestion-pill" data-primary={item.primary ? 'true' : undefined}
          disabled={sending} onClick={() => {
            markSuggestionUsed(item);
            void dispatchPrompt?.(item.prompt, 'send', inputActions);
          }}>
          <Icon name={item.icon as IconName} size={13} /><span>{item.label}</span>
        </button>
      ))}
    </div>;
  }

  const actions = ctx.slots as unknown as {
    inject(name: string, register: () => unknown): unknown;
    register(config: { name: string; id: string; order: number; inject?(sessionId: string): { sessionId: string } }, component: unknown): unknown;
  };
  actions.inject('conversation.chat.turnTail', () => actions.register({
    name: 'conversation.chat.turnTail', id: 'workspace-superagent-genui', order: 8, inject: sessionId => ({ sessionId }),
  }, GenuiCard));
  actions.inject('conversation.chat.turnTail', () => actions.register({
    name:'conversation.chat.turnTail',id:'workspace-superagent-actions',order:10,inject:sessionId => ({sessionId}),
  },Card));
  actions.inject('conversation.input.dock', () => actions.register({
    name: 'conversation.input.dock', id: 'workspace-superagent-suggestions', order: 50,
  }, SuggestionDock));
  ctx.slots.inject(CHILD, () => ctx.slots.register({ name: CHILD }, Transcript));

  function ChatPage({ SessionProvider, renderSlot }: PropsRenderSlots<typeof CHILD>) {
    const Provider = SessionProvider as unknown as (props: { session: ChatReference; children: React.ReactNode }) => React.ReactNode;
    const remote = useCatalogRemote();
    const health = React.useSyncExternalStore(
      listener => { healthListeners.add(listener); return () => healthListeners.delete(listener); },
      () => cachedHealth,
    );
    const motto = React.useSyncExternalStore(
      listener => { mottoListeners.add(listener); return () => mottoListeners.delete(listener); },
      () => cachedMotto,
    );
    const reference = React.useSyncExternalStore(
      listener => { retainedListeners.add(listener); return () => retainedListeners.delete(listener); },
      () => retainedReference,
    );
    const historyError = React.useSyncExternalStore(
      listener => { retainedListeners.add(listener); return () => retainedListeners.delete(listener); },
      () => retainedError,
    );
    const [notice, setNotice] = React.useState('');
    const [autoConnectFailed, setAutoConnectFailed] = React.useState(false);
    const [details, setDetails] = React.useState(() => {
      try {
        const saved = window.localStorage.getItem('workspace-superagent-personal-open');
        if (saved !== null) return saved === 'true';
        return typeof window !== 'undefined' && window.innerWidth > 1100;
      } catch { return false; }
    });
    const [diagnostics, setDiagnostics] = React.useState(false);
    const [connecting, setConnecting] = React.useState(false);
    const [reconfiguring, setReconfiguring] = React.useState(false);
    const [step, setStep] = React.useState<1 | 2 | 3 | 4>(1);
    const [stepDir, setStepDir] = React.useState<'next' | 'prev'>('next');
    const goToStep = React.useCallback((nextStep: 1 | 2 | 3 | 4) => {
      setStep(prev => {
        if (nextStep !== prev) setStepDir(nextStep > prev ? 'next' : 'prev');
        return nextStep;
      });
    }, []);
    const [groups, setGroups] = React.useState<readonly ModelCatalogGroup[]>(() => cachedGroups);
    const [selectedModel, setSelectedModel] = React.useState<ChatModelSelection>(() =>
      cachedHealth?.chat?.model ? { ...cachedHealth.chat.model } : { ...DEFAULT_CHAT_MODEL },
    );
    const [modelTouched, setModelTouched] = React.useState(false);
    const [soulPreset, setSoulPreset] = React.useState<ChatSoulPreset>(() =>
      cachedHealth?.chat?.soul?.preset ?? DEFAULT_CHAT_SOUL.preset,
    );
    const [soulBotName, setSoulBotName] = React.useState(() =>
      cachedHealth?.chat?.soul?.botName || getBotProfile().botName || DEFAULT_BOT_NAME,
    );
    const [soulAvatarDataUrl, setSoulAvatarDataUrl] = React.useState<string | undefined>(() =>
      cachedHealth?.chat?.soul?.avatarDataUrl ?? getBotProfile().avatarDataUrl ?? undefined,
    );
    const [soulUserName, setSoulUserName] = React.useState(() =>
      cachedHealth?.chat?.soul?.userName ?? '',
    );
    const [soulPrompt, setSoulPrompt] = React.useState(() =>
      cachedHealth?.chat?.soul
        ? resolveSoulPresetPrompt(cachedHealth.chat.soul.preset, cachedHealth.chat.soul.prompt)
        : DEFAULT_CHAT_SOUL.prompt,
    );
    const [soulTraits, setSoulTraits] = React.useState<readonly ChatSoulTraitId[]>(() =>
      cachedHealth?.chat?.soul?.traits ? [...cachedHealth.chat.soul.traits] : [...DEFAULT_SOUL_TRAITS],
    );
    const [soulTraitsMarkdown, setSoulTraitsMarkdown] = React.useState<string>(() =>
      cachedHealth?.chat?.soul
        ? resolveSoulTraitsMarkdown(cachedHealth.chat.soul)
        : buildDefaultTraitsMarkdown(DEFAULT_SOUL_TRAITS),
    );
    const [editingObTraitRules, setEditingObTraitRules] = React.useState(false);
    const [syncSoulMarkdown, setSyncSoulMarkdown] = React.useState(true);
    const [soulTouched, setSoulTouched] = React.useState(false);
    const [memoryTouched, setMemoryTouched] = React.useState(false);
    const [memorySources, setMemorySources] = React.useState<readonly OnboardingMemorySourceId[]>(() => ['rules', 'sessions', 'board']);
    const [customMemoryNote, setCustomMemoryNote] = React.useState('');
    const [autoDailyDraft, setAutoDailyDraft] = React.useState(true);
    const [personalTab, setPersonalTab] = React.useState<PersonalPanelTab>('overview');
    const [configSavedNotice, setConfigSavedNotice] = React.useState('');
    const savedNoticeTimerRef = React.useRef<number | undefined>(undefined);
    const avatarInputRef = React.useRef<HTMLInputElement>(null);
    const pendingAutoDailyRef = React.useRef(false);
    const pending = React.useRef(false);
    const state = health?.chat;
    const retryHistory = React.useCallback(() => {
      if (state?.sessionId) ensureSessionRetained(state.sessionId, true);
    }, [state?.sessionId]);
    const toggleDetails = () => setDetails(open => {
      try { window.localStorage.setItem('workspace-superagent-personal-open', String(!open)); } catch { /* 保持当前窗口状态。 */ }
      return !open;
    });
    const openConfigTab = React.useCallback(() => {
      setDiagnostics(false);
      setPersonalTab('config');
      setDetails(true);
      try { window.localStorage.setItem('workspace-superagent-personal-open', 'true'); } catch { /* 保持当前窗口状态。 */ }
    }, []);
    React.useEffect(() => {
      openOnboardingGuide = openConfigTab;
      return () => { if (openOnboardingGuide === openConfigTab) openOnboardingGuide = null; };
    }, [openConfigTab]);
    React.useEffect(() => {
      return () => {
        if (savedNoticeTimerRef.current !== undefined) window.clearTimeout(savedNoticeTimerRef.current);
      };
    }, []);
    React.useEffect(() => {
      if (!remote?.session) return;
      let cancelled = false;
      void remote.session.modelCatalog().then(res => {
        if (cancelled || !res.ok) return;
        const nativeGroups = res.value.groups.filter(g => nativeChatModel(g.id) && g.models.length > 0);
        cachedGroups = nativeGroups;
        setGroups(nativeGroups);
      }).catch(() => {});
      return () => { cancelled = true; };
    }, [remote]);
    React.useEffect(() => {
      if (!state) return;
      if (!modelTouched && state.model) setSelectedModel({ ...state.model });
      if (!soulTouched && state.soul) {
        setSoulPreset(state.soul.preset);
        setSoulBotName(state.soul.botName || DEFAULT_BOT_NAME);
        setSoulAvatarDataUrl(state.soul.avatarDataUrl);
        setSoulUserName(state.soul.userName ?? '');
        setSoulPrompt(resolveSoulPresetPrompt(state.soul.preset, state.soul.prompt));
        if (state.soul.traits) setSoulTraits([...state.soul.traits]);
        setSoulTraitsMarkdown(resolveSoulTraitsMarkdown(state.soul));
        setSyncSoulMarkdown(true);
      }
    }, [state, modelTouched, soulTouched]);
    React.useEffect(() => {
      if (!details && !diagnostics) return;
      const narrow = window.matchMedia('(max-width: 1100px)');
      const keydown = (event: KeyboardEvent) => {
        if (event.key !== 'Escape') return;
        if (diagnostics) { setDiagnostics(false); return; }
        if (!narrow.matches) return;
        // 委派详情自己处理 Escape，避免连同抽屉一起关闭。
        if ((event.target as HTMLElement | null)?.closest?.('[role="dialog"]')) return;
        toggleDetails();
      };
      window.addEventListener('keydown', keydown);
      return () => window.removeEventListener('keydown', keydown);
    }, [details, diagnostics]);

    function adopt(next: HealthView, nextToken?: string | null) {
      adoptSharedHealth(next, nextToken);
      if (next.chat?.ready) setAutoConnectFailed(false);
    }
    async function refresh(signal?: AbortSignal) {
      const { health: next, token: ownerToken } = await readChatHealth(signal);
      if (!signal?.aborted) adopt(next, ownerToken);
      return next;
    }
    const mutate = (body: object, signal?: AbortSignal) => mutateChat(body, cachedToken, signal);
    const applyAvatarUpdate = React.useCallback((nextDataUrl: string | undefined) => {
      const normalized = nextDataUrl?.trim() || undefined;
      setSoulAvatarDataUrl(normalized);
      setBotProfile({ avatarDataUrl: normalized ?? null });
      setNotice('');
      if (!state?.sessionId || !state.ready) {
        setSoulTouched(true);
        return;
      }
      const baseSoul = state.soul ?? DEFAULT_CHAT_SOUL;
      const trimmedPrompt = (soulTouched ? soulPrompt : baseSoul.prompt).trim()
        || SOUL_PRESETS.find(item => item.id === (soulTouched ? soulPreset : baseSoul.preset))?.prompt
        || DEFAULT_CHAT_SOUL.prompt;
      const trimmedName = (soulTouched ? soulUserName : (baseSoul.userName ?? '')).trim();
      const trimmedBotName = (soulTouched ? soulBotName : (baseSoul.botName || DEFAULT_BOT_NAME)).trim() || DEFAULT_BOT_NAME;
      const activeTraits = [...(soulTouched ? soulTraits : (baseSoul.traits ?? DEFAULT_SOUL_TRAITS))];
      const defaultMd = buildDefaultTraitsMarkdown(activeTraits).trim();
      const currentMd = (soulTouched ? soulTraitsMarkdown : resolveSoulTraitsMarkdown(baseSoul)).trim();
      const soulPayload: ChatSoulConfig = {
        preset: soulTouched ? soulPreset : baseSoul.preset,
        botName: trimmedBotName,
        ...(normalized ? { avatarDataUrl: normalized } : {}),
        ...(trimmedName ? { userName: trimmedName } : {}),
        prompt: trimmedPrompt,
        traits: activeTraits,
        ...(currentMd !== defaultMd ? { traitsMarkdown: currentMd } : {}),
        syncSoulMarkdown: true,
      };
      void mutate({ sessionId: state.sessionId, soul: soulPayload })
        .then(res => {
          if (res.health) adopt(res.health);
          setConfigSavedNotice(normalized ? '✓ 头像已更新生效' : '✓ 已恢复默认头像');
          if (savedNoticeTimerRef.current !== undefined) window.clearTimeout(savedNoticeTimerRef.current);
          savedNoticeTimerRef.current = window.setTimeout(() => setConfigSavedNotice(''), 3200);
        })
        .catch(() => {
          setSoulTouched(true);
        });
    }, [state?.sessionId, state?.ready, state?.soul, soulTouched, soulPreset, soulBotName, soulUserName, soulPrompt, soulTraits, soulTraitsMarkdown, syncSoulMarkdown]);
    React.useEffect(() => {
      return registerRemoteAvatarUpdater(dataUrl => {
        applyAvatarUpdate(dataUrl ?? undefined);
      });
    }, [applyAvatarUpdate]);
    async function handleAvatarChange(event: React.ChangeEvent<HTMLInputElement>) {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      try {
        const dataUrl = await readAvatarFileAsDataUrl(file);
        applyAvatarUpdate(dataUrl);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : '头像读取失败。');
      }
    }
    const sendGuidePrompt = React.useCallback(async (text: string, mode: 'send' | 'draft' = 'send', inputActions?: InputActionsLike) => {
      const sessionId = state?.sessionId;
      if (!sessionId || !state?.ready) return;
      if (mode === 'draft') {
        inputActions?.setDraft?.(text);
        focusComposerEditor();
        return;
      }
      if (busySending) return;
      setBusySending(true);
      setNotice('');
      if (typeof window !== 'undefined' && window.matchMedia?.('(max-width: 1100px)').matches && details) {
        setDetails(false);
      }
      try {
        const requestId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : String(Date.now());
        await mutate({ sessionId, requestId, content: [{ type: 'text', text }] });
      } catch (error) {
        setNotice(error instanceof Error ? error.message : '发送引导指令未完成。');
      } finally {
        setBusySending(false);
      }
    }, [state?.sessionId, state?.ready, details]);
    React.useEffect(() => {
      dispatchPrompt = sendGuidePrompt;
      return () => { if (dispatchPrompt === sendGuidePrompt) dispatchPrompt = null; };
    }, [sendGuidePrompt]);
    React.useEffect(() => {
      if (!pendingAutoDailyRef.current) return;
      if (!state?.ready || !state.sessionId || reference?.sessionId !== state.sessionId) return;
      pendingAutoDailyRef.current = false;
      void sendGuidePrompt(DAILY_SUMMARY_SCHEDULE_PROMPT, 'send');
    }, [state?.ready, state?.sessionId, reference?.sessionId, sendGuidePrompt]);
    async function connect(
      snapshot: HealthView,
      signal?: AbortSignal,
      options?: { model?: ChatModelSelection; soul?: ChatSoulConfig; onboardingMemory?: OnboardingMemoryOptions },
      silentAuto = false,
    ): Promise<boolean> {
      if (!snapshot.summary || pending.current) return false;
      pending.current = true;
      setConnecting(true);
      if (!silentAuto) setNotice('');
      try {
        const payload = {
          revision: snapshot.summary.manager.revision,
          ...(options?.model ? { model: options.model } : {}),
          ...(options?.soul ? { soul: options.soul } : {}),
          ...(options?.onboardingMemory ? { onboardingMemory: options.onboardingMemory } : {}),
        };
        const result = await mutate(payload, signal);
        if (result.health && !signal?.aborted) adopt(result.health);
        if (!signal?.aborted) setAutoConnectFailed(false);
        return true;
      } catch (error) {
        if (!signal?.aborted) {
          if (silentAuto) setAutoConnectFailed(true);
          else setNotice(error instanceof Error ? error.message : '连接未完成。');
        }
        return false;
      } finally {
        pending.current = false;
        if (!signal?.aborted) setConnecting(false);
      }
    }
    async function resetSteward() {
      if (connecting || pending.current) return;
      let snapshot = health;
      if (!snapshot?.summary) {
        try { snapshot = await refresh(); } catch { return; }
      }
      if (!snapshot?.summary) return;
      pending.current = true;
      setConnecting(true);
      setNotice('');
      try {
        const res = await mutate({ reset: true, revision: snapshot.summary.manager.revision });
        setSharedMotto(null);
        ensureSessionRetained(null);
        clearCachedPersonalSnapshot();
        setReconfiguring(false);
        setStep(1);
        setSoulPreset(DEFAULT_CHAT_SOUL.preset);
        setSoulBotName(DEFAULT_BOT_NAME);
        setSoulAvatarDataUrl(undefined);
        setSoulUserName('');
        setSoulPrompt(DEFAULT_CHAT_SOUL.prompt);
        setSoulTraits([...DEFAULT_SOUL_TRAITS]);
        setSyncSoulMarkdown(true);
        setSoulTouched(false);
        setModelTouched(false);
        setMemoryTouched(false);
        setCustomMemoryNote('');
        setConfigSavedNotice('');
        setPersonalTab('overview');
        resetBotProfile();
        clearUsedSuggestions();
        setSuggestionsPayload({
          dailyReviewConfigured: false,
          items: [FIXED_DAILY_SUGGESTION, ...DEFAULT_DYNAMIC_SUGGESTIONS],
        });
        if (res.health) adopt(res.health);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : `重置${soulBotName.trim() || DEFAULT_BOT_NAME}数据未完成。`);
      } finally {
        pending.current = false;
        setConnecting(false);
      }
    }
    function revertConfigDraft() {
      const currentModel = state?.model ?? DEFAULT_CHAT_MODEL;
      const currentSoul = state?.soul ?? DEFAULT_CHAT_SOUL;
      setSelectedModel({ ...currentModel });
      setSoulPreset(currentSoul.preset);
      const nextBotName = currentSoul.botName || DEFAULT_BOT_NAME;
      setSoulBotName(nextBotName);
      setSoulAvatarDataUrl(currentSoul.avatarDataUrl);
      setSoulUserName(currentSoul.userName ?? '');
      setSoulPrompt(resolveSoulPresetPrompt(currentSoul.preset, currentSoul.prompt));
      setSoulTraits(currentSoul.traits ? [...currentSoul.traits] : [...DEFAULT_SOUL_TRAITS]);
      setSoulTraitsMarkdown(resolveSoulTraitsMarkdown(currentSoul));
      setSyncSoulMarkdown(true);
      setBotProfile({
        botName: nextBotName,
        avatarDataUrl: currentSoul.avatarDataUrl ?? null,
      });
      setMemorySources(['rules', 'sessions', 'board']);
      setCustomMemoryNote('');
      setModelTouched(false);
      setSoulTouched(false);
      setMemoryTouched(false);
      setNotice('');
      setConfigSavedNotice('');
    }
    async function completeOnboarding() {
      if (connecting) return;
      const trimmedPrompt = soulPrompt.trim() || SOUL_PRESETS.find(item => item.id === soulPreset)?.prompt || DEFAULT_CHAT_SOUL.prompt;
      const trimmedName = soulUserName.trim();
      const trimmedBotName = soulBotName.trim() || DEFAULT_BOT_NAME;
      const defaultTraitsMd = buildDefaultTraitsMarkdown(soulTraits).trim();
      const trimmedTraitsMd = soulTraitsMarkdown.trim();
      const soulPayload: ChatSoulConfig = {
        preset: soulPreset,
        botName: trimmedBotName,
        ...(soulAvatarDataUrl ? { avatarDataUrl: soulAvatarDataUrl } : {}),
        ...(trimmedName ? { userName: trimmedName } : {}),
        prompt: trimmedPrompt,
        traits: [...soulTraits],
        ...(trimmedTraitsMd !== defaultTraitsMd ? { traitsMarkdown: trimmedTraitsMd } : {}),
        syncSoulMarkdown: true,
      };
      setBotProfile({
        botName: trimmedBotName,
        avatarDataUrl: soulAvatarDataUrl ?? null,
      });
      const modelPayload: ChatModelSelection = {
        provider: selectedModel.provider,
        model: selectedModel.model,
        ...(selectedModel.reasoningEffort ? { reasoningEffort: selectedModel.reasoningEffort } : {}),
      };
      const trimmedCustomNote = customMemoryNote.trim();
      const onboardingMemoryPayload: OnboardingMemoryOptions = {
        sources: [...memorySources],
        ...(trimmedCustomNote ? { customNote: trimmedCustomNote } : {}),
      };
      let snapshot = health;
      if (!snapshot?.summary) {
        try { snapshot = await refresh(); } catch { /* 继续由下方连接检查处理。 */ }
      }
      if (!snapshot?.summary) return;
      if (autoDailyDraft && !state?.sessionId) {
        pendingAutoDailyRef.current = true;
      }
      if (state?.sessionId && state.ready) {
        setConnecting(true); setNotice('');
        try {
          await mutate({ sessionId: state.sessionId, model: modelPayload });
          const res = await mutate({
            sessionId: state.sessionId,
            soul: soulPayload,
            onboardingMemory: onboardingMemoryPayload,
          });
          if (res.health) adopt(res.health);
          triggerSuggestionsRefresh?.();
          setModelTouched(false);
          setSoulTouched(false);
          setMemoryTouched(false);
          setCustomMemoryNote('');
          setReconfiguring(false);
          setConfigSavedNotice('✓ 配置已更新生效');
          if (savedNoticeTimerRef.current !== undefined) window.clearTimeout(savedNoticeTimerRef.current);
          savedNoticeTimerRef.current = window.setTimeout(() => setConfigSavedNotice(''), 3200);
          if (typeof window !== 'undefined' && window.innerWidth > 1100) setDetails(true);
        } catch (error) {
          setNotice(error instanceof Error ? error.message : '保存配置未完成。');
        } finally {
          setConnecting(false);
        }
        return;
      }
      const ok = await connect(snapshot, undefined, {
        model: modelPayload,
        soul: soulPayload,
        onboardingMemory: onboardingMemoryPayload,
      });
      if (ok) {
        setModelTouched(false);
        setSoulTouched(false);
        setMemoryTouched(false);
        setCustomMemoryNote('');
        setReconfiguring(false);
        if (typeof window !== 'undefined' && window.innerWidth > 1100) setDetails(true);
      } else {
        pendingAutoDailyRef.current = false;
      }
    }
    React.useEffect(() => {
      const abort = new AbortController();
      void refresh(abort.signal).then(next => {
        if (!abort.signal.aborted && shouldAutoConnect(next)) {
          void connect(next, abort.signal, undefined, true);
        }
      }).catch(() => {});
      return () => abort.abort();
    }, [diagnostics]);
    React.useEffect(() => {
      if (!state?.ready || diagnostics) return;
      const abort = new AbortController();
      void refreshSharedMotto(abort.signal);
      const timer = window.setInterval(() => void refreshSharedMotto(abort.signal), 60_000);
      return () => { window.clearInterval(timer); abort.abort(); };
    }, [state?.ready, diagnostics]);
    React.useEffect(() => {
      if (!state?.ready || diagnostics) {
        triggerSuggestionsRefresh = null;
        return;
      }
      const abort = new AbortController();
      let requesting = false;
      async function refreshSuggestions(dismissKeys?: readonly string[]) {
        if ((requesting && !dismissKeys?.length) || abort.signal.aborted) return;
        requesting = true;
        try {
          const payload = dismissKeys && dismissKeys.length > 0
            ? { suggestions: true, dismiss: [...dismissKeys] }
            : { suggestions: true };
          const { suggestions } = await mutateChat(payload, cachedToken, abort.signal);
          if (!abort.signal.aborted && suggestions && Array.isArray(suggestions.items)) {
            setSuggestionsPayload(suggestions);
          }
        } catch { /* 保持兜底建议列表可用 */ }
        finally { requesting = false; }
      }
      triggerSuggestionsRefresh = (dismissKeys?: readonly string[]) => { void refreshSuggestions(dismissKeys); };
      void refreshSuggestions();
      const onVisible = () => {
        if (typeof document === 'undefined' || document.visibilityState === 'visible') {
          void refreshSuggestions();
        }
      };
      window.addEventListener('focus', onVisible);
      document.addEventListener('visibilitychange', onVisible);
      const timer = window.setInterval(() => void refreshSuggestions(), 45_000);
      return () => {
        if (triggerSuggestionsRefresh) triggerSuggestionsRefresh = null;
        window.removeEventListener('focus', onVisible);
        document.removeEventListener('visibilitychange', onVisible);
        window.clearInterval(timer);
        abort.abort();
      };
    }, [state?.ready, state?.sessionId, diagnostics]);
    React.useEffect(() => {
      if (state?.sessionId) ensureSessionRetained(state.sessionId);
    }, [state?.sessionId]);

    const currentGroup = groups.find(g => g.id === selectedModel.provider);
    const currentEntry = currentGroup?.models.find(e => e.id === selectedModel.model);
    const efforts = currentEntry?.reasoning?.efforts ?? [];
    const activeEffort = selectedModel.reasoningEffort ?? currentEntry?.reasoning?.defaultEffort;
    const selectedModelLabel = currentEntry
      ? `${currentEntry.name} · ${currentGroup?.name ?? selectedModel.provider}`
      : `${selectedModel.model} · ${selectedModel.provider}`;
    const selectedEffortLabel = efforts.length > 0
      ? (EFFORT_LABELS[activeEffort ?? ''] ?? activeEffort ?? '模型默认')
      : (selectedModel.reasoningEffort ? (EFFORT_LABELS[selectedModel.reasoningEffort] ?? selectedModel.reasoningEffort) : '模型默认');
    const selectedPresetItem = SOUL_PRESETS.find(item => item.id === soulPreset) ?? SOUL_PRESETS[0]!;
    const discoveredCandidates = state?.onboardingDiscovery?.sources?.length
      ? state.onboardingDiscovery.sources
      : FALLBACK_MEMORY_CANDIDATES;
    const displayBotName = soulBotName.trim() || DEFAULT_BOT_NAME;
    const defaultPreviewTraitsMd = buildDefaultTraitsMarkdown(soulTraits).trim();
    const trimmedPreviewTraitsMd = soulTraitsMarkdown.trim();
    const soulPreviewDoc = renderSoulMarkdownDocument({
      preset: soulPreset,
      botName: displayBotName,
      ...(soulUserName.trim() ? { userName: soulUserName.trim() } : {}),
      prompt: soulPrompt.trim() || selectedPresetItem.prompt,
      traits: soulTraits,
      ...(trimmedPreviewTraitsMd !== defaultPreviewTraitsMd ? { traitsMarkdown: trimmedPreviewTraitsMd } : {}),
    });
    const statusMessage = historyError ? '暂时无法加载主理对话。' : notice;
    const activeSessionId = state?.sessionId ?? (health === undefined ? boundSessionHint : null);
    const showOnboarding = health !== undefined && !state?.sessionId;
    const showConversation = !showOnboarding && !!state?.sessionId && reference?.sessionId === state.sessionId;
    const showStatusBanner = Boolean(
      state?.sessionId &&
      !reconfiguring &&
      (notice || state.reason || (!state.ready && (!shouldAutoConnect(health) || autoConnectFailed))),
    );
    const isConfigDirty = modelTouched || soulTouched || memoryTouched || Boolean(customMemoryNote.trim());
    const stewardConfigProps: StewardConfigPanelProps = {
      botName: soulBotName,
      avatarDataUrl: soulAvatarDataUrl,
      userName: soulUserName,
      onChangeBotName: nextName => {
        setSoulTouched(true);
        setConfigSavedNotice('');
        setSoulBotName(nextName);
        setBotProfile({ botName: nextName.trim() || DEFAULT_BOT_NAME });
      },
      onChangeUserName: nextUser => {
        setSoulTouched(true);
        setConfigSavedNotice('');
        setSoulUserName(nextUser);
      },
      onRequestAvatarUpload: () => avatarInputRef.current?.click(),
      onClearAvatar: () => {
        applyAvatarUpdate(undefined);
      },
      groups,
      selectedModel,
      onChangeModel: nextModel => {
        setModelTouched(true);
        setConfigSavedNotice('');
        setSelectedModel(nextModel);
      },
      soulPreset,
      soulTraits,
      soulTraitsMarkdown,
      soulPrompt,
      syncSoulMarkdown,
      soulPreviewDoc,
      onSelectPreset: (preset, prompt) => {
        setSoulTouched(true);
        setConfigSavedNotice('');
        setSoulPreset(preset);
        setSoulPrompt(prompt);
      },
      onToggleTrait: traitId => {
        setSoulTouched(true);
        setConfigSavedNotice('');
        setSoulTraits(prev => {
          const next = prev.includes(traitId)
            ? prev.filter(id => id !== traitId)
            : [...prev, traitId];
          setSoulTraitsMarkdown(prevMd => syncTraitToggleInMarkdown(prevMd, traitId, prev, next));
          return next;
        });
      },
      onChangeTraitsMarkdown: nextMarkdown => {
        setSoulTouched(true);
        setConfigSavedNotice('');
        setSoulTraitsMarkdown(nextMarkdown);
      },
      onResetTraitsMarkdown: () => {
        setSoulTouched(true);
        setConfigSavedNotice('');
        setSoulTraitsMarkdown(buildDefaultTraitsMarkdown(soulTraits));
      },
      onChangePrompt: nextPrompt => {
        setSoulTouched(true);
        setConfigSavedNotice('');
        setSoulPrompt(nextPrompt);
      },
      onResetPreset: () => {
        setSoulTouched(true);
        setConfigSavedNotice('');
        setSoulTraits([...DEFAULT_SOUL_TRAITS]);
        setSoulTraitsMarkdown(buildDefaultTraitsMarkdown(DEFAULT_SOUL_TRAITS));
        setSoulPrompt(selectedPresetItem.prompt);
      },
      onToggleSyncSoulMarkdown: () => {
        setSoulTouched(true);
        setConfigSavedNotice('');
        setSyncSoulMarkdown(v => !v);
      },
      discoveredCandidates,
      memorySources,
      customMemoryNote,
      onToggleMemorySource: id => {
        setMemoryTouched(true);
        setConfigSavedNotice('');
        setMemorySources(prev =>
          prev.includes(id)
            ? prev.filter(item => item !== id)
            : [...prev, id],
        );
      },
      onToggleAllMemorySources: () => {
        setMemoryTouched(true);
        setConfigSavedNotice('');
        setMemorySources(prev => prev.length === 3 ? [] : ['rules', 'sessions', 'board']);
      },
      onChangeCustomMemoryNote: note => {
        setMemoryTouched(true);
        setConfigSavedNotice('');
        setCustomMemoryNote(note);
      },
      onAppendMemorySnippet: snippet => {
        setMemoryTouched(true);
        setConfigSavedNotice('');
        setCustomMemoryNote(prev => {
          const trimmed = prev.trim();
          if (trimmed.includes(snippet)) return prev;
          return trimmed ? `${trimmed}；${snippet}` : snippet;
        });
      },
      onResetSteward: () => resetSteward(),
      isDirty: isConfigDirty,
      saving: connecting,
      savedNotice: configSavedNotice,
      statusNotice: statusMessage,
      onSaveConfig: () => completeOnboarding(),
      onRevertConfig: revertConfigDraft,
    };

    return <section className="wsa-chat" data-superagent-chat="" data-ready={state?.ready === true}>
      <style>{css}</style>
      <input ref={avatarInputRef} type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
        style={{ display: 'none' }}
        onChange={event => void handleAvatarChange(event)} />
      <header className="wsa-chat-head"><div className="wsa-chat-title"><strong>{motto?.day === localMottoDay() ? motto.text : displayBotName}</strong></div>
        <button type="button" className="wsa-chat-toggle" data-back={diagnostics ? 'true' : undefined}
          title={diagnostics ? `返回${displayBotName}会话` : details ? '收起个人面板' : '打开个人面板'}
          aria-label={diagnostics ? `返回${displayBotName}会话` : details ? '收起个人面板' : '打开个人面板'}
          aria-expanded={!diagnostics && details} aria-controls={details ? 'wsa-personal-detail' : undefined}
          onClick={() => diagnostics ? setDiagnostics(false) : toggleDetails()}>
          <Icon name={diagnostics ? 'back' : 'panel'} size={diagnostics ? 15 : 17} />
          {diagnostics && <span>返回{displayBotName}会话</span>}
        </button>
      </header>
      {diagnostics ? <div className="wsa-chat-body"><HealthPage onBack={() => setDiagnostics(false)} /></div> : <>
        {showStatusBanner && state && <div className="wsa-chat-status" role="status">
          {notice || state.reason || (connecting ? '正在连接主理…' : '主理尚未连接。')}{!state.ready && !state.reason &&
            <button type="button" disabled={connecting} onClick={() => health && void connect(health)}>重新连接</button>}
        </div>}
        <div className="wsa-chat-main"><div className="wsa-chat-body">
          {showConversation
            ? <Provider session={reference!}>{renderSlot(CHILD, {})}</Provider>
            : !showOnboarding
              ? <div className="wsa-chat-boot" data-superagent-loading="" aria-busy={!historyError}>
                  {historyError ? (
                    <div className="wsa-chat-boot-error" role="status">
                      <h3>暂时无法加载主理对话</h3>
                      <p>{notice || '主理会话目录正在同步或连接暂未就绪，请稍后重试。'}</p>
                      <button type="button" className="wsa-ob-btn" data-primary="true" onClick={retryHistory}>重新加载对话</button>
                    </div>
                  ) : (
                    <>
                      <div className="wsa-chat-boot-inner" aria-hidden="true">
                        <div className="wsa-chat-boot-card">
                          <div className="wsa-chat-boot-row">
                            <span className="wsa-welcome-avatar"><BotAvatar src={soulAvatarDataUrl} size={20} /></span>
                            <div className="wsa-chat-boot-bar" style={{ width: 96, height: 12 }} />
                          </div>
                          <div className="wsa-chat-boot-bar" style={{ width: '72%' }} />
                          <div className="wsa-chat-boot-bar" style={{ width: '88%' }} />
                          <div className="wsa-chat-boot-bar" style={{ width: '56%' }} />
                        </div>
                      </div>
                      <div className="wsa-chat-boot-composer" aria-hidden="true" />
                    </>
                  )}
                </div>
              : <div className="wsa-onboarding" data-superagent-onboarding=""
                style={{ '--wsa-step-shift': `${(step - 1) * 16}%` } as React.CSSProperties}>
                <div className="wsa-ob-ambient" aria-hidden="true" />

                <header className="wsa-ob-hero">
                  <div className="wsa-ob-hero-left">
                    <div className="wsa-ob-logo-wrap">
                      <span className="wsa-ob-logo-Wrap-glow" aria-hidden="true" />
                      <button type="button" className="wsa-ob-logo" title="点击更换主理头像" aria-label="更换主理头像"
                        onClick={() => avatarInputRef.current?.click()}>
                        <BotAvatar src={soulAvatarDataUrl} size={48} />
                      </button>
                      <span className="wsa-ob-logo-status" aria-hidden="true" />
                    </div>
                    <div className="wsa-ob-hero-text">
                      <div className="wsa-ob-eyebrow">
                        <Icon name="sparkle" size={11} />
                        <span>WORKSPACE STEWARD · 全局工作区主理</span>
                      </div>
                      <div className="wsa-ob-title-row">
                        <h2>{displayBotName}</h2>
                        <div className="wsa-ob-hero-badges">
                          <span className="wsa-ob-hero-pill">
                            <Icon name={PRESET_ICONS[soulPreset]} size={12} />
                            <span>{selectedPresetItem.title}</span>
                          </span>
                          <span className="wsa-ob-hero-pill">
                            <Icon name="cpu" size={12} />
                            <span>{currentEntry?.name ?? selectedModel.model}</span>
                          </span>
                        </div>
                      </div>
                      <p>初始化你的全局工作空间主理：配置模型、设定 Soul 并注入 DSH 记忆。</p>
                    </div>
                  </div>
                  <div className="wsa-ob-hero-right" aria-hidden="true">
                    <span className="wsa-ob-step-counter">STEP 0{step} / 04</span>
                    <div className="wsa-ob-step-dots">
                      {[1, 2, 3, 4].map(idx => (
                        <span key={idx} className="wsa-ob-step-dot"
                          data-active={step === idx ? 'true' : undefined}
                          data-done={step > idx ? 'true' : undefined} />
                      ))}
                    </div>
                  </div>
                </header>

                <nav className="wsa-ob-steps" aria-label="主理初始化引导步骤">
                  <button type="button" className="wsa-ob-step-tab"
                    data-active={step === 1 ? 'true' : undefined}
                    data-done={step > 1 ? 'true' : undefined}
                    onClick={() => goToStep(1)}>
                    <span className="wsa-ob-step-num">{step > 1 ? '✓' : '1'}</span>
                    <span className="wsa-ob-step-meta">
                      <span className="wsa-ob-step-title">配置模型</span>
                      <span className="wsa-ob-step-sub">{currentEntry?.name ?? selectedModel.model}</span>
                    </span>
                  </button>
                  <span className="wsa-ob-step-line" aria-hidden="true" />
                  <button type="button" className="wsa-ob-step-tab"
                    data-active={step === 2 ? 'true' : undefined}
                    data-done={step > 2 ? 'true' : undefined}
                    onClick={() => goToStep(2)}>
                    <span className="wsa-ob-step-num">{step > 2 ? '✓' : '2'}</span>
                    <span className="wsa-ob-step-meta">
                      <span className="wsa-ob-step-title">设定 Soul</span>
                      <span className="wsa-ob-step-sub">{selectedPresetItem.title} · {soulTraits.length} 特征</span>
                    </span>
                  </button>
                  <span className="wsa-ob-step-line" aria-hidden="true" />
                  <button type="button" className="wsa-ob-step-tab"
                    data-active={step === 3 ? 'true' : undefined}
                    data-done={step > 3 ? 'true' : undefined}
                    onClick={() => goToStep(3)}>
                    <span className="wsa-ob-step-num">{step > 3 ? '✓' : '3'}</span>
                    <span className="wsa-ob-step-meta">
                      <span className="wsa-ob-step-title">注入记忆</span>
                      <span className="wsa-ob-step-sub">{memorySources.length > 0 ? `已选 ${memorySources.length} 类记忆源` : '待勾选记忆源'}</span>
                    </span>
                  </button>
                  <span className="wsa-ob-step-line" aria-hidden="true" />
                  <button type="button" className="wsa-ob-step-tab"
                    data-active={step === 4 ? 'true' : undefined}
                    onClick={() => goToStep(4)}>
                    <span className="wsa-ob-step-num">4</span>
                    <span className="wsa-ob-step-meta">
                      <span className="wsa-ob-step-title">确认开启</span>
                      <span className="wsa-ob-step-sub">{state?.sessionId ? '核对并保存' : '准备就绪'}</span>
                    </span>
                  </button>
                </nav>

                {step === 1 && <section key="step-1" className="wsa-ob-card" data-step-dir={stepDir} aria-label="配置模型">
                  <div className="wsa-ob-card-head">
                    <div className="wsa-ob-card-head-left">
                      <span className="wsa-ob-card-icon"><Icon name="cpu" size={18} /></span>
                      <div>
                        <h3 className="wsa-ob-card-title">核心推理引擎与归纳深度</h3>
                        <p className="wsa-ob-card-subtitle">为主理分配原生对话大模型与思考强度，驱动跨会话盘点、待办编排与只读 Worker 协同。</p>
                      </div>
                    </div>
                    <span className="wsa-ob-card-tag">Step 1 · 引擎底座</span>
                  </div>

                  <div className="wsa-ob-block" style={{ animationDelay: '40ms' }}>
                    <div className="wsa-ob-row" style={{ padding: 0 }}>
                      <div className="wsa-ob-copy">
                        <div className="wsa-ob-label">主理模型</div>
                        <div className="wsa-ob-desc">选择你当前已拥有的原生对话模型</div>
                      </div>
                      <select className="wsa-ob-select" aria-label="主理模型"
                        value={selectedModel.provider && selectedModel.model ? `${selectedModel.provider}\n${selectedModel.model}` : ''}
                        onChange={event => {
                          const [provider = '', model = ''] = event.target.value.split('\n');
                          if (!provider || !model) return;
                          const nextGroup = groups.find(g => g.id === provider);
                          const nextEntry = nextGroup?.models.find(e => e.id === model);
                          const defaultEffort = nextEntry?.reasoning?.defaultEffort;
                          setModelTouched(true);
                          setSelectedModel({
                            provider,
                            model,
                            ...(defaultEffort ? { reasoningEffort: defaultEffort } : {}),
                          });
                        }}>
                        {!currentEntry && selectedModel.provider && selectedModel.model && (
                          <option value={`${selectedModel.provider}\n${selectedModel.model}`}>
                            {selectedModel.model} · {selectedModel.provider}
                          </option>
                        )}
                        {groups.map(group => (
                          <optgroup key={group.id} label={group.name}>
                            {group.models.map(entry => (
                              <option key={`${group.id}\n${entry.id}`} value={`${group.id}\n${entry.id}`}>
                                {entry.name} · {group.name}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                    </div>
                    <div className="wsa-ob-cap-grid" aria-hidden="true">
                      <div className="wsa-ob-cap-item">
                        <div className="wsa-ob-cap-title"><Icon name="layers" size={14} /><span>跨会话脉络归纳</span></div>
                        <div className="wsa-ob-cap-desc">自动串联多项目活跃会话，提炼阻塞风险与未闭环事项</div>
                      </div>
                      <div className="wsa-ob-cap-item">
                        <div className="wsa-ob-cap-title"><Icon name="route" size={14} /><span>只读 Worker 委派</span></div>
                        <div className="wsa-ob-cap-desc">按需派发代码检索与架构调研任务，汇总可验证结论</div>
                      </div>
                      <div className="wsa-ob-cap-item">
                        <div className="wsa-ob-cap-title"><Icon name="clock" size={14} /><span>早晚报与看板编排</span></div>
                        <div className="wsa-ob-cap-desc">联动个人待办与任务看板，生成结构化优先级行动建议</div>
                      </div>
                    </div>
                  </div>

                  <div className="wsa-ob-block" style={{ animationDelay: '85ms' }}>
                    <div className="wsa-ob-row" style={{ padding: 0 }}>
                      <div className="wsa-ob-copy">
                        <div className="wsa-ob-label">推理强度</div>
                        <div className="wsa-ob-desc">复杂任务盘点与跨会话归纳深度</div>
                      </div>
                      <span className="wsa-ob-card-tag">{selectedEffortLabel}{EFFORT_META[activeEffort ?? ''] ? ` · ${EFFORT_META[activeEffort ?? '']!.hint}` : ''}</span>
                    </div>
                    {efforts.length > 0 ? (
                      <div className="wsa-ob-effort-wrap">
                        <div className="wsa-ob-seg" role="group" aria-label="推理强度">
                          {efforts.map(effort => {
                            const meta = EFFORT_META[effort.id] ?? { bars: 2, hint: '', desc: '' };
                            return (
                              <button key={effort.id} type="button" className="wsa-ob-seg-btn"
                                data-active={activeEffort === effort.id ? 'true' : undefined}
                                onClick={() => {
                                  setModelTouched(true);
                                  setSelectedModel(prev => ({ ...prev, reasoningEffort: effort.id }));
                                }}>
                                <span className="wsa-ob-effort-bars" aria-hidden="true">
                                  {[1, 2, 3, 4].map(bar => (
                                    <span key={bar} className="wsa-ob-effort-bar" data-lit={bar <= meta.bars ? 'true' : undefined} />
                                  ))}
                                </span>
                                <span>{EFFORT_LABELS[effort.id] ?? effort.id}</span>
                              </button>
                            );
                          })}
                        </div>
                        {activeEffort && EFFORT_META[activeEffort] && (
                          <div className="wsa-ob-effort-caption">
                            <span><strong>{EFFORT_LABELS[activeEffort] ?? activeEffort}（{EFFORT_META[activeEffort]!.hint}）</strong>：{EFFORT_META[activeEffort]!.desc}</span>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div style={{ marginTop: 10 }}><span className="wsa-ob-muted">{selectedEffortLabel}</span></div>
                    )}
                  </div>

                  <footer className="wsa-ob-foot">
                    {reconfiguring && state?.sessionId
                      ? <button type="button" className="wsa-ob-btn" onClick={() => setReconfiguring(false)}>返回会话</button>
                      : <span className="wsa-ob-foot-hint"><Icon name="sparkle" size={13} /><span>可随时在引导设置中更改</span></span>}
                    <button type="button" className="wsa-ob-btn" data-primary="true" onClick={() => goToStep(2)}>
                      <span>下一步 · 设定 Soul</span>
                      <Icon name="chevron-right" size={15} />
                    </button>
                  </footer>
                </section>}

                {step === 2 && <section key="step-2" className="wsa-ob-card" data-step-dir={stepDir} aria-label="设定 Soul">
                  <div className="wsa-ob-card-head">
                    <div className="wsa-ob-card-head-left">
                      <span className="wsa-ob-card-icon"><Icon name="sparkle" size={18} /></span>
                      <div>
                        <h3 className="wsa-ob-card-title">塑造专属形象与 Soul 人设</h3>
                        <p className="wsa-ob-card-subtitle">定制主理的称呼、沟通基调与协作特征偏好，让{displayBotName}真正贴合你的日常工作节奏。</p>
                      </div>
                    </div>
                    <span className="wsa-ob-card-tag">Step 2 · 灵魂设定</span>
                  </div>

                  <div className="wsa-ob-block" style={{ animationDelay: '35ms' }}>
                    {soulAvatarDataUrl && (
                      <div className="wsa-ob-block-top" style={{ marginBottom: 8 }}>
                        <span className="wsa-ob-desc">已上传自定义头像</span>
                        <button type="button" className="wsa-ob-link" onClick={() => applyAvatarUpdate(undefined)}>
                          恢复默认头像
                        </button>
                      </div>
                    )}
                    <div className="wsa-ob-identity">
                      <div className="wsa-ob-avatar-wrap">
                        <button type="button" className="wsa-ob-avatar-box" aria-label="更换头像"
                          onClick={() => avatarInputRef.current?.click()}>
                          <BotAvatar src={soulAvatarDataUrl} size={46} />
                        </button>
                        <button type="button" className="wsa-ob-camera-btn" title="更换头像" aria-label="上传静图或动图头像"
                          onClick={() => avatarInputRef.current?.click()}>
                          <Icon name="camera" size={12} />
                        </button>
                      </div>
                      <div className="wsa-ob-name-grid">
                        <label className="wsa-ob-field">
                          <span className="wsa-ob-field-label">主理名字</span>
                          <input type="text" className="wsa-ob-input" aria-label="主理名字"
                            value={soulBotName} maxLength={32}
                            placeholder={DEFAULT_BOT_NAME}
                            onChange={event => {
                              const nextName = event.target.value;
                              setSoulTouched(true);
                              setSoulBotName(nextName);
                              setBotProfile({ botName: nextName.trim() || DEFAULT_BOT_NAME });
                            }} />
                        </label>
                        <label className="wsa-ob-field">
                          <span className="wsa-ob-field-label">对你的称呼</span>
                          <input type="text" className="wsa-ob-input" aria-label="对你的称呼"
                            value={soulUserName} maxLength={64}
                            placeholder="选填，如：开水"
                            onChange={event => {
                              setSoulTouched(true);
                              setSoulUserName(event.target.value);
                            }} />
                        </label>
                      </div>
                    </div>
                  </div>

                  <div className="wsa-ob-block" style={{ animationDelay: '70ms' }}>
                    <div className="wsa-ob-block-top">
                      <div>
                        <div className="wsa-ob-label">1. 风格预设与沟通基调</div>
                        <div className="wsa-ob-desc">选择主理日常沟通与盘点任务时的搭档性格，下方可直接微调当前预设基调</div>
                      </div>
                    </div>
                    <div className="wsa-ob-presets">
                      {SOUL_PRESETS.map(item => (
                        <button key={item.id} type="button" className="wsa-ob-preset"
                          data-selected={soulPreset === item.id ? 'true' : undefined}
                          onClick={() => {
                            setSoulTouched(true);
                            setSoulPreset(item.id);
                            setSoulPrompt(item.prompt);
                          }}>
                          <div className="wsa-ob-preset-title">
                            <span className="wsa-ob-preset-title-left">
                              <span className="wsa-ob-preset-icon"><Icon name={PRESET_ICONS[item.id]} size={14} /></span>
                              <span>{item.title}</span>
                            </span>
                            <span className="wsa-ob-preset-dot" />
                          </div>
                          <div className="wsa-ob-preset-sub">{item.subtitle}</div>
                        </button>
                      ))}
                    </div>
                    {(() => {
                      const isCustomBasePrompt = soulPrompt.trim() !== '' && soulPrompt.trim() !== selectedPresetItem.prompt.trim();
                      return (
                        <div className="wsa-ob-soul-subbox">
                          <div className="wsa-ob-soul-subhead">
                            <span className="wsa-ob-soul-sublabel">
                              <span>「{selectedPresetItem.title}」基调提示词微调</span>
                              <span className="wsa-ob-soul-pill" data-custom={isCustomBasePrompt ? 'true' : undefined}>
                                {isCustomBasePrompt ? '已微调' : '预设默认'}
                              </span>
                            </span>
                            <button type="button" className="wsa-ob-link" onClick={() => {
                              setSoulTouched(true);
                              setSoulTraits([...DEFAULT_SOUL_TRAITS]);
                              setSoulTraitsMarkdown(buildDefaultTraitsMarkdown(DEFAULT_SOUL_TRAITS));
                              setSoulPrompt(selectedPresetItem.prompt);
                            }}>重置预设</button>
                          </div>
                          <textarea className="wsa-ob-textarea" rows={5} aria-label="Soul 提示词"
                            value={soulPrompt} maxLength={1200}
                            placeholder="描述你希望主理如何与你配合…"
                            onChange={event => {
                              setSoulTouched(true);
                              setSoulPrompt(event.target.value);
                            }} />
                        </div>
                      );
                    })()}
                  </div>

                  <div className="wsa-ob-block" style={{ animationDelay: '105ms' }}>
                    <div className="wsa-ob-block-top">
                      <div>
                        <div className="wsa-ob-label">2. 协作特征偏好（可多选）</div>
                        <div className="wsa-ob-desc">组合注入具体的沟通约束与行动准则，勾选后将在下方实时生效</div>
                      </div>
                      <span className="wsa-ob-card-tag">已启用 {soulTraits.length}/{SOUL_TRAITS.length} 项</span>
                    </div>
                    <div className="wsa-ob-traits" role="group" aria-label="协作特征偏好">
                      {SOUL_TRAITS.map(trait => {
                        const selected = soulTraits.includes(trait.id);
                        return (
                          <button key={trait.id} type="button" className="wsa-ob-trait-chip"
                            data-selected={selected ? 'true' : undefined}
                            title={trait.instruction}
                            onClick={() => {
                              setSoulTouched(true);
                              setSoulTraits(prev => {
                                const next = prev.includes(trait.id)
                                  ? prev.filter(id => id !== trait.id)
                                  : [...prev, trait.id];
                                setSoulTraitsMarkdown(prevMd => syncTraitToggleInMarkdown(prevMd, trait.id, prev, next));
                                return next;
                              });
                            }}>
                            {selected ? `✓ ${trait.label}` : trait.label}
                          </button>
                        );
                      })}
                    </div>
                    {(() => {
                      const defaultTraitsMd = buildDefaultTraitsMarkdown(soulTraits).trim();
                      const trimmedMd = soulTraitsMarkdown.trim();
                      const hasCustomTraitsMd = trimmedMd !== defaultTraitsMd;
                      const mdLines = trimmedMd.split('\n').map(l => l.trim()).filter(Boolean);
                      return (
                        <div className="wsa-ob-soul-subbox" aria-live="polite">
                          <div className="wsa-ob-soul-subhead">
                            <span className="wsa-ob-soul-sublabel">
                              <span>当前生效的特征准则 (Markdown)</span>
                              {hasCustomTraitsMd && (
                                <span className="wsa-ob-soul-pill" data-custom="true">已自定义</span>
                              )}
                            </span>
                            <div className="wsa-ob-soul-subactions">
                              {(hasCustomTraitsMd || editingObTraitRules) && (
                                <button type="button" className="wsa-ob-link" onClick={() => {
                                  setSoulTouched(true);
                                  setSoulTraitsMarkdown(buildDefaultTraitsMarkdown(soulTraits));
                                }}>
                                  恢复默认
                                </button>
                              )}
                              <button type="button" className="wsa-ob-link" onClick={() => setEditingObTraitRules(v => !v)}>
                                {editingObTraitRules ? '完成编辑' : '编辑 Markdown'}
                              </button>
                            </div>
                          </div>
                          {editingObTraitRules ? (
                            <textarea
                              className="wsa-ob-textarea wsa-ob-trait-md-editor"
                              rows={6}
                              maxLength={2000}
                              aria-label="协作特征偏好 Markdown"
                              value={soulTraitsMarkdown}
                              placeholder="- **结论先行**：每次回复先给核心结论或行动清单…"
                              onChange={event => {
                                setSoulTouched(true);
                                setSoulTraitsMarkdown(event.target.value);
                              }}
                            />
                          ) : mdLines.length > 0 ? (
                            <ul className="wsa-ob-trait-rules">
                              {mdLines.map((line, idx) => {
                                const cleaned = line.replace(/^[-*+]\s+/, '');
                                const match = cleaned.match(/^\*\*(.+?)\*\*\s*[：:]\s*(.*)$/);
                                return (
                                  <li key={idx} className="wsa-ob-trait-rule">
                                    <span className="wsa-ob-trait-rule-dot" aria-hidden="true" />
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
                            <span className="wsa-ob-trait-empty">暂未设置特征准则，可勾选上方标签或点击「编辑 Markdown」自由编写。</span>
                          )}
                        </div>
                      );
                    })()}
                  </div>

                  {statusMessage && <div className="wsa-ob-notice" role="status">
                    <span>{statusMessage}</span>
                  </div>}

                  <footer className="wsa-ob-foot">
                    <button type="button" className="wsa-ob-btn" onClick={() => goToStep(1)}>上一步</button>
                    <button type="button" className="wsa-ob-btn" data-primary="true" onClick={() => goToStep(3)}>
                      <span>下一步 · 注入记忆</span>
                      <Icon name="chevron-right" size={15} />
                    </button>
                  </footer>
                </section>}

                {step === 3 && <section key="step-3" className="wsa-ob-card" data-step-dir={stepDir} aria-label="注入 DSH 记忆">
                  <div className="wsa-ob-card-head">
                    <div className="wsa-ob-card-head-left">
                      <span className="wsa-ob-card-icon"><Icon name="layers" size={18} /></span>
                      <div>
                        <h3 className="wsa-ob-card-title">注入 DSH 工作空间全景记忆</h3>
                        <p className="wsa-ob-card-subtitle">让{displayBotName}在冷启动时即刻掌握你的工程规则、近期研发焦点与看板在途卡片。</p>
                      </div>
                    </div>
                    <span className="wsa-ob-card-tag">Step 3 · 记忆同步</span>
                  </div>

                  <div className="wsa-ob-block" style={{ animationDelay: '40ms' }}>
                    <div className="wsa-ob-block-top">
                      <div>
                        <div className="wsa-ob-label">注入 DSH 当前拥有的上下文与记忆</div>
                        <div className="wsa-ob-desc">勾选要同步到{displayBotName}长期记忆库（MemoryService & .dsh/MEMORY.md）的来源</div>
                      </div>
                      <button type="button" role="checkbox" className="wsa-ob-checkall"
                        aria-label={memorySources.length === 3 ? '取消全选' : '全选'}
                        aria-checked={memorySources.length === 3 ? 'true' : memorySources.length > 0 ? 'mixed' : 'false'}
                        onClick={() => {
                          setMemorySources(prev => prev.length === 3 ? [] : ['rules', 'sessions', 'board']);
                        }}>
                        <span className="wsa-ob-mem-check" aria-hidden="true">
                          {memorySources.length === 3 ? '✓' : memorySources.length > 0 ? '−' : ''}
                        </span>
                        <span>全选</span>
                      </button>
                    </div>
                    <div className="wsa-ob-mem-list" role="group" aria-label="DSH 记忆来源">
                      {discoveredCandidates.map(candidate => {
                        const selected = memorySources.includes(candidate.id);
                        return (
                          <button key={candidate.id} type="button" className="wsa-ob-mem-card"
                            data-selected={selected ? 'true' : undefined}
                            onClick={() => {
                              setMemorySources(prev =>
                                prev.includes(candidate.id)
                                  ? prev.filter(id => id !== candidate.id)
                                  : [...prev, candidate.id],
                              );
                            }}>
                            <div className="wsa-ob-mem-head">
                              <span className="wsa-ob-mem-title">
                                <span className="wsa-ob-mem-check">{selected ? '✓' : ''}</span>
                                <span>{candidate.title}</span>
                              </span>
                              <span className="wsa-ob-mem-badge">
                                <Icon name={MEMORY_SOURCE_ICONS[candidate.id]} size={12} />
                                <span>{candidate.badge}</span>
                              </span>
                            </div>
                            <div className="wsa-ob-mem-desc">{candidate.summary}</div>
                            {candidate.items.length > 0 && (
                              <ul className="wsa-ob-mem-items">
                                {candidate.items.map((line, idx) => <li key={idx}>{line}</li>)}
                              </ul>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="wsa-ob-block" style={{ animationDelay: '85ms' }}>
                    <div className="wsa-ob-block-top">
                      <div>
                        <div className="wsa-ob-label">补充初始长期记忆（选填）</div>
                        <div className="wsa-ob-desc">写下你的作息习惯、关键关注点或协作禁忌，主理会将其永久记入个人档案</div>
                      </div>
                    </div>
                    <textarea className="wsa-ob-textarea" rows={3} aria-label="补充初始长期记忆"
                      value={customMemoryNote} maxLength={1000}
                      placeholder="例如：我习惯早上先处理阻塞 PR，回复尽量控制在 3 点以内…"
                      onChange={event => setCustomMemoryNote(event.target.value)} />
                    <div className="wsa-ob-mem-snippets">
                      {QUICK_MEMORY_SNIPPETS.map(snippet => (
                        <button key={snippet} type="button" className="wsa-ob-mem-snippet"
                          onClick={() => {
                            setCustomMemoryNote(prev => {
                              const trimmed = prev.trim();
                              if (trimmed.includes(snippet)) return prev;
                              return trimmed ? `${trimmed}；${snippet}` : snippet;
                            });
                          }}>
                          <Icon name="plus" size={11} />
                          <span>{snippet}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <footer className="wsa-ob-foot">
                    <button type="button" className="wsa-ob-btn" onClick={() => goToStep(2)}>上一步</button>
                    <button type="button" className="wsa-ob-btn" data-primary="true" onClick={() => goToStep(4)}>
                      <span>下一步 · 确认开启</span>
                      <Icon name="chevron-right" size={15} />
                    </button>
                  </footer>
                </section>}

                {step === 4 && <section key="step-4" className="wsa-ob-card" data-step-dir={stepDir} aria-label="确认开启">
                  <div className="wsa-ob-card-head">
                    <div className="wsa-ob-card-head-left">
                      <span className="wsa-ob-card-icon"><Icon name="check" size={18} /></span>
                      <div>
                        <h3 className="wsa-ob-card-title">核对配置蓝图并唤醒{displayBotName}</h3>
                        <p className="wsa-ob-card-subtitle">以下配置将立即写入工作区主理运行时，后续也可随时在会话顶部重新调整。</p>
                      </div>
                    </div>
                    <span className="wsa-ob-card-tag">Step 4 · 准备就绪</span>
                  </div>

                  <div className="wsa-ob-launch-preview">
                    <div className="wsa-ob-launch-avatar">
                      <BotAvatar src={soulAvatarDataUrl} size={38} />
                    </div>
                    <div className="wsa-ob-launch-copy">
                      <div className="wsa-ob-launch-title">
                        <span>{displayBotName}</span>
                        <span className="wsa-ob-hero-pill">{selectedPresetItem.title}</span>
                      </div>
                      <div className="wsa-ob-launch-quote">
                        “嗨{soulUserName.trim() ? `，${soulUserName.trim()}` : ''}！我是<strong>{displayBotName}</strong>，已搭载 <strong>{currentEntry?.name ?? selectedModel.model}</strong> 与 <strong>{memorySources.length} 类 DSH 记忆源</strong>，随时准备接管你的工作区。”
                      </div>
                    </div>
                  </div>

                  <div className="wsa-ob-row" style={{ animationDelay: '40ms' }}>
                    <div className="wsa-ob-copy">
                      <div className="wsa-ob-label"><Icon name="cpu" size={15} /><span>模型配置</span></div>
                      <div className="wsa-ob-desc">核心对话模型与跨会话推理深度</div>
                    </div>
                    <div className="wsa-ob-summary-right">
                      <span>{selectedModelLabel} · {selectedEffortLabel}</span>
                      <button type="button" className="wsa-ob-link" onClick={() => goToStep(1)}>修改</button>
                    </div>
                  </div>

                  <div className="wsa-ob-row" style={{ animationDelay: '75ms' }}>
                    <div className="wsa-ob-copy">
                      <div className="wsa-ob-label"><Icon name="sparkle" size={15} /><span>形象与 Soul</span></div>
                      <div className="wsa-ob-desc">主理人设基调、协作特征与工作区文档同步</div>
                    </div>
                    <div className="wsa-ob-summary-right">
                      <span className="wsa-ob-sum-avatar"><BotAvatar src={soulAvatarDataUrl} size={17} /></span>
                      <span>
                        {displayBotName} · {selectedPresetItem.title}
                        {soulTraits.length > 0 ? ` · ${soulTraits.length} 项特征` : ''}
                        {soulUserName.trim() ? ` · 称呼「${soulUserName.trim()}」` : ''}
                        {syncSoulMarkdown ? ' · 同步 .dsh/SOUL.md' : ''}
                      </span>
                      <button type="button" className="wsa-ob-link" onClick={() => goToStep(2)}>修改</button>
                    </div>
                  </div>

                  <div className="wsa-ob-row" style={{ animationDelay: '110ms' }}>
                    <div className="wsa-ob-copy">
                      <div className="wsa-ob-label"><Icon name="layers" size={15} /><span>DSH 记忆注入</span></div>
                      <div className="wsa-ob-desc">同步至长期记忆库（MemoryService & .dsh/MEMORY.md）的初始上下文</div>
                    </div>
                    <div className="wsa-ob-summary-right">
                      <span>
                        {memorySources.length > 0 ? `已选 ${memorySources.length} 类 DSH 记忆源` : '未勾选自动源'}
                        {customMemoryNote.trim() ? ' + 自定义记忆' : ''}
                      </span>
                      <button type="button" className="wsa-ob-link" onClick={() => goToStep(3)}>修改</button>
                    </div>
                  </div>

                  {!state?.sessionId && <div className="wsa-ob-row" style={{ animationDelay: '145ms' }}>
                    <div className="wsa-ob-copy">
                      <div className="wsa-ob-label"><Icon name="clock" size={15} /><span>每日早晚总结定时草稿</span></div>
                      <div className="wsa-ob-desc">进入会话后自动准备 09:00 早报与 20:30 晚复盘确认卡</div>
                    </div>
                    <button type="button" role="switch" className="wsa-ob-switch"
                      aria-label="每日早晚总结定时草稿"
                      aria-checked={autoDailyDraft}
                      onClick={() => setAutoDailyDraft(v => !v)}>
                      <span className="wsa-ob-switch-thumb" />
                    </button>
                  </div>}

                  {reconfiguring && state?.sessionId && <div className="wsa-ob-row" style={{ animationDelay: '145ms' }}>
                    <div className="wsa-ob-copy">
                      <div className="wsa-ob-label">从头重置{displayBotName}</div>
                      <div className="wsa-ob-desc">清空当前会话绑定、长期记忆与个人待办，重新开始冷启动引导</div>
                    </div>
                    <button type="button" className="wsa-ob-btn" disabled={connecting} onClick={() => void resetSteward()}>
                      清空数据并重置
                    </button>
                  </div>}

                  {statusMessage && <div className="wsa-ob-notice" role="status">
                    <span>{statusMessage}</span>
                    {historyError && <button type="button" className="wsa-ob-btn" onClick={retryHistory}>重新加载对话</button>}
                  </div>}

                  <footer className="wsa-ob-foot">
                    <button type="button" className="wsa-ob-btn" onClick={() => goToStep(3)}>上一步</button>
                    <button type="button" className="wsa-ob-btn" data-primary="true"
                      disabled={connecting || !selectedModel.provider || !selectedModel.model}
                      onClick={() => void completeOnboarding()}>
                      <Icon name="sparkle" size={15} />
                      <span>{connecting ? '正在开启…' : state?.sessionId ? '保存并进入会话' : `开启${displayBotName}`}</span>
                    </button>
                  </footer>
                </section>}
              </div>}
        </div>
        {details && <button type="button" className="wsa-chat-scrim" aria-label="收起个人面板" tabIndex={-1} onClick={toggleDetails} />}
        {details && <aside className="wsa-chat-detail" id="wsa-personal-detail" aria-label="个人面板">
          {activeSessionId ? <PersonalPanel key={activeSessionId} sessionId={activeSessionId} workspace={state?.workspace ?? workspaceLabel}
            automationText={health ? (health.automation?.accepting ? '运行中' : '已暂停') : '运行中'}
            onDiagnostics={() => setDiagnostics(true)}
            onGuideSchedule={() => void sendGuidePrompt(DAILY_SUMMARY_SCHEDULE_PROMPT)}
            activeTab={personalTab}
            onTabChange={setPersonalTab}
            config={stewardConfigProps} />
            : <div className="wsa-preview-aside">
                <div className="wsa-preview-top">
                  <div className="wsa-preview-head">
                    <strong>个人面板</strong>
                    {health !== undefined && <span className="wsa-preview-badge">待激活</span>}
                  </div>
                  <div className="wsa-preview-card">
                    <div className="wsa-preview-card-head"><span>今日待办</span><span>0</span></div>
                    <div className="wsa-preview-bar" />
                    <div className="wsa-preview-bar" />
                  </div>
                  <div className="wsa-preview-card">
                    <div className="wsa-preview-card-head"><span>定时任务</span><span>0</span></div>
                    <div className="wsa-preview-bar" />
                    <div className="wsa-preview-bar" />
                  </div>
                  <div className="wsa-preview-card">
                    <div className="wsa-preview-card-head"><span>近期活动</span><span>0</span></div>
                    <div className="wsa-preview-bar" />
                    <div className="wsa-preview-bar" />
                  </div>
                </div>
                <div className="wsa-preview-foot">
                  <span>{health !== undefined ? '主理会话未初始化' : '正在同步状态…'}</span>
                  <button type="button" className="wsa-preview-diag" onClick={() => setDiagnostics(true)}>运行状态 ›</button>
                </div>
              </div>}
        </aside>}</div>
      </>}
    </section>;
  }
  return function ChatPanel(props: PropsRenderSlots<typeof CHILD>) {
    return <ChatPanelBoundary><ChatPage {...props} /></ChatPanelBoundary>;
  };
}
