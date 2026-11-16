import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import {
  DEFAULT_BOT_NAME,
  localMottoDay,
  type ChatModelSelection,
  type ChatSoulConfig,
  type ChatSuggestionIcon,
  type ChatSuggestionItem,
  type ChatSuggestionsPayload,
} from './chat-input.js';
import type { MottoLlm } from './daily-motto.js';
import type { PublicMemoryItem } from '../memory/service.js';
import type { PublicTodo } from '../personal/service.js';
import type { CapturedTask } from '../projections/types.js';

export const DAILY_SUMMARY_SCHEDULE_PROMPT =
  '帮我创建每天早上 09:00 的早间总结和每天晚上 20:30 的晚间复盘定时任务，结合我的个人待办、任务看板和近期会话记录给出总结与建议。';

export const FIXED_DAILY_REVIEW_SUGGESTION: ChatSuggestionItem = Object.freeze({
  id: 'daily-schedule',
  label: '开启每日早晚总结与复盘',
  icon: 'clock',
  prompt: DAILY_SUMMARY_SCHEDULE_PROMPT,
  primary: true,
});

const VALID_ICONS = new Set<ChatSuggestionIcon>(['check', 'route', 'board', 'calendar', 'edit', 'link']);

export interface SuggestionContextSnapshot {
  readonly dailyReviewConfigured: boolean;
  readonly soul?: ChatSoulConfig;
  readonly memories?: readonly PublicMemoryItem[];
  readonly todos?: readonly PublicTodo[];
  readonly tasks?: readonly CapturedTask[];
  readonly recentSessions?: readonly {
    readonly title: string;
    readonly status?: string;
    readonly lastUserMessage?: string | null;
  }[];
  readonly recentUserMessages?: readonly string[];
  readonly lastAssistantReply?: string;
  readonly dismiss?: readonly string[];
}

const GENERIC_ASCII_STOPWORDS = new Set([
  'workspace',
  'dsh',
  'soul',
  'memory',
  'memories',
  'todo',
  'todos',
  'task',
  'tasks',
  'board',
  'session',
  'sessions',
  'json',
  'llm',
  'check',
  'route',
  'calendar',
  'edit',
  'link',
  'clock',
  'pr',
  'id',
  'ui',
  'api',
  'app',
  'web',
  'dev',
]);

const GENERIC_CJK_STOPWORDS =
  /梳理|盘点|总结|查看|推进|规划|整理|检查|复盘|开启|沉淀|跟进|汇总|评估|分析|排期|构建|任务|待办|看板|会话|近期|今日|今天|明日|明天|本周|工作|建议|项目|方案|帮我|请帮|如何|怎么|当前|目前|下一步|依赖|拆解|要点|状态|进展|卡片|事项|清单|围绕|结合|以及|那些|哪些|优先|优先级|执行|动作|核心|问题|情况|记录|重点|模块|工程|仓库|代码|配置|规范|未闭环|未完成|进行中|待规划/gu;

export function extractTopicSignature(text: string): {
  readonly identifiers: readonly string[];
  readonly cjkBigrams: readonly string[];
} {
  const lower = text.toLowerCase();
  const rawIds = lower.match(/[a-z][a-z0-9._-]{2,}/gu) ?? [];
  const identifiers = [
    ...new Set(
      rawIds
        .map(token => token.replace(/^[._-]+|[._-]+$/gu, ''))
        .filter(token => token.length >= 3 && !GENERIC_ASCII_STOPWORDS.has(token)),
    ),
  ];

  const strippedCjk = text
    .replace(/[a-zA-Z0-9._\-\s,，。！？：；、“”‘’「」『』（）()【】[\]/\\]+/gu, '')
    .replace(GENERIC_CJK_STOPWORDS, '');
  const cjkBigrams: string[] = [];
  for (let i = 0; i + 1 < strippedCjk.length; i++) {
    const bg = strippedCjk.slice(i, i + 2);
    if (!cjkBigrams.includes(bg)) cjkBigrams.push(bg);
  }
  return { identifiers, cjkBigrams };
}

export function isTopicOverlap(candidateLabel: string, usedTexts: Iterable<string>): boolean {
  const cand = extractTopicSignature(candidateLabel);
  if (cand.identifiers.length === 0 && cand.cjkBigrams.length === 0) return false;

  for (const rawUsed of usedTexts) {
    const used = rawUsed.trim();
    if (!used || used === DAILY_SUMMARY_SCHEDULE_PROMPT || used === FIXED_DAILY_REVIEW_SUGGESTION.id) continue;
    // 只基于短标签或用户近期短指令做话题去重，避免长段通用 prompt 误伤
    const refText = used.length > 48 ? used.slice(0, 48) : used;
    const ref = extractTopicSignature(refText);
    if (
      cand.identifiers.length > 0 &&
      cand.identifiers.some(id => ref.identifiers.includes(id))
    ) {
      return true;
    }
    if (cand.cjkBigrams.length > 0 && ref.cjkBigrams.length > 0) {
      const shared = cand.cjkBigrams.filter(bg => ref.cjkBigrams.includes(bg)).length;
      if (shared >= 2 || (cand.cjkBigrams.length <= 2 && shared >= 1 && refText.length <= 26)) {
        return true;
      }
    }
  }
  return false;
}

interface StoredSuggestionsCache {
  readonly fingerprint: string;
  readonly items: readonly ChatSuggestionItem[];
  readonly dismissed?: readonly string[];
}

function buildContextFingerprint(day: string, ctx: SuggestionContextSnapshot): string {
  const memPart = (ctx.memories ?? []).slice(0, 12).map(m => `${m.id}:${m.revision}`);
  const todoPart = (ctx.todos ?? []).filter(t => !t.done).slice(0, 8).map(t => `${t.id}:${t.revision}`);
  const taskPart = (ctx.tasks ?? []).filter(t => t.archivedAt === null && !t.hidden && t.status !== 'done').slice(0, 8).map(t => `${t.id}:${t.status}`);
  const sessionPart = (ctx.recentSessions ?? []).slice(0, 5).map(s => s.title);
  return createHash('sha256')
    .update(JSON.stringify({ day, soul: ctx.soul?.preset ?? 'default', memPart, todoPart, taskPart, sessionPart }))
    .digest('hex')
    .slice(0, 20);
}

export function buildFallbackDynamicSuggestions(ctx: SuggestionContextSnapshot): ChatSuggestionItem[] {
  const botName = ctx.soul?.botName?.trim() || DEFAULT_BOT_NAME;
  const results: ChatSuggestionItem[] = [];
  const pendingTodos = (ctx.todos ?? []).filter(t => !t.done);
  const activeTasks = (ctx.tasks ?? []).filter(t => t.archivedAt === null && !t.hidden && t.status !== 'done');
  const sessions = (ctx.recentSessions ?? []).filter(s => s.title?.trim());
  const memories = ctx.memories ?? [];

  for (const todo of pendingTodos.slice(0, 2)) {
    const shortTitle = todo.title.trim().slice(0, 10);
    results.push({
      id: `ctx-todo-${createHash('sha1').update(todo.id).digest('hex').slice(0, 8)}`,
      label: `推进待办：${shortTitle}`,
      icon: 'check',
      prompt: `结合我的个人待办清单（特别是「${todo.title.trim()}」）和长期记忆偏好，帮我梳理执行步骤与下一步动作。`,
    });
  }
  results.push({
    id: 'today-todos',
    label: '盘点今日待办与工作建议',
    icon: 'check',
    prompt: '结合我的长期记忆、个人待办清单、任务看板和近期会话记录，帮我盘点今天的待办事项并给出优先工作建议。',
  });

  for (const sess of sessions.slice(0, 2)) {
    const recentTitle = sess.title.trim().slice(0, 10);
    results.push({
      id: `ctx-session-${createHash('sha1').update(sess.title).digest('hex').slice(0, 8)}`,
      label: `跟进「${recentTitle}」会话进展`,
      icon: 'route',
      prompt: `帮我总结近期会话「${sess.title.trim()}」的核心进展，结合我的工作习惯提炼还有哪些未闭环事项。`,
    });
  }
  results.push({
    id: 'recent-sessions',
    label: '总结近期会话进展与未闭环项',
    icon: 'route',
    prompt: '帮我总结一下最近活跃和刚完成的会话进展，看看有哪些未闭环事项。',
  });

  for (const task of activeTasks.slice(0, 2)) {
    const firstTask = task.title.trim().slice(0, 10);
    results.push({
      id: `ctx-board-${createHash('sha1').update(task.id).digest('hex').slice(0, 8)}`,
      label: `推进看板「${firstTask}」卡片`,
      icon: 'board',
      prompt: `帮我查看任务看板中正在推进的「${task.title.trim()}」卡片，评估是否存在阻塞并给出拆解或派工建议。`,
    });
  }
  const projectMemories = memories.filter(m => m.category === 'project' || m.category === 'decision').slice(0, 2);
  for (const pm of projectMemories) {
    const memTitle = pm.title.replace(/^.*：/u, '').trim().slice(0, 10);
    results.push({
      id: `ctx-memory-${createHash('sha1').update(pm.id).digest('hex').slice(0, 8)}`,
      label: `围绕「${memTitle}」规划下一步`,
      icon: 'edit',
      prompt: `结合我长期记忆中的「${pm.title}」背景以及当前看板状态，帮我规划今天最值得优先推进的 2~3 个动作。`,
    });
  }
  results.push(
    {
      id: 'board-overview',
      label: '查看看板待规划与进行中任务',
      icon: 'board',
      prompt: '帮我看看任务看板里目前有哪些待规划和进行中的卡片，并结合我的偏好给出排期建议。',
    },
    {
      id: 'memory-curation',
      label: '检视并整理我的长期记忆库',
      icon: 'edit',
      prompt: `帮我盘点一下目前${botName}记住的长期记忆与个人偏好，看看有哪些可以合并、更新或新沉淀的要点。`,
    },
    {
      id: 'next-focus-plan',
      label: '规划接下来一小时专注目标',
      icon: 'calendar',
      prompt: '结合我手头的未完成待办、看板任务和近期讨论进展，帮我挑出接下来 1 小时最适合专注闭环的 1 件事。',
    },
  );

  return results;
}

export function parseLlmSuggestions(raw: string, maxItems = 3): ChatSuggestionItem[] {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '')
    .trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start < 0 || end <= start) return [];

  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) return [];
    const items: ChatSuggestionItem[] = [];
    const seenLabels: string[] = [];
    for (let i = 0; i < parsed.length && items.length < maxItems; i++) {
      const entry = parsed[i];
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      const rawLabel = typeof record.label === 'string' ? record.label.trim().replace(/[\r\n]/gu, '') : '';
      const rawPrompt = typeof record.prompt === 'string' ? record.prompt.trim() : '';
      const rawIcon = typeof record.icon === 'string' ? record.icon.trim() : '';
      if (rawLabel.length < 4 || rawLabel.length > 26) continue;
      if (rawPrompt.length < 8 || rawPrompt.length > 500) continue;
      // 过滤掉与每日复盘固定引导重复的条目
      if (/每日.*(?:总结|复盘|早晚报)/u.test(rawLabel)) continue;
      // 同一批次内部也做话题去重，禁止同一批次出现两个围绕同一项目/关键词的建议
      if (isTopicOverlap(rawLabel, seenLabels)) continue;
      const icon: ChatSuggestionIcon = VALID_ICONS.has(rawIcon as ChatSuggestionIcon)
        ? (rawIcon as ChatSuggestionIcon)
        : (['check', 'route', 'board'][items.length % 3] as ChatSuggestionIcon);
      const hash = createHash('sha1').update(`${rawLabel}\n${rawPrompt}`).digest('hex').slice(0, 10);
      items.push({
        id: `llm-${hash}`,
        label: rawLabel,
        icon,
        prompt: rawPrompt,
      });
      seenLabels.push(rawLabel);
    }
    return items.slice(0, maxItems);
  } catch {
    return [];
  }
}

function buildSuggestionPrompt(ctx: SuggestionContextSnapshot, dismissed: ReadonlySet<string> = new Set()): string {
  const usedCorpus = [...dismissed, ...(ctx.recentUserMessages ?? [])];
  const exhaustedIds = new Set<string>();
  for (const text of usedCorpus) {
    if (!text || text === DAILY_SUMMARY_SCHEDULE_PROMPT) continue;
    const sig = extractTopicSignature(text.slice(0, 60));
    for (const id of sig.identifiers) exhaustedIds.add(id);
  }

  const botName = ctx.soul?.botName?.trim() || DEFAULT_BOT_NAME;
  const lines: string[] = [
    `你是工作区主理助手「${botName}」。请根据以下用户的上下文，为用户生成 **5 条** 候选快捷对话建议（系统会从中筛选前 3 条展示在 Suggestion List）。`,
    '',
    '【生成规则】',
    '1. 输出格式必须是合法的 JSON 数组（最多 5 条），不要输出任何 Markdown 解释文字。',
    '2. 每条元素包含 3 个字段：',
    '   - "label": 胶囊按钮短文案（8~18 个汉字，简洁自然）',
    '   - "icon": 只能从 ["check", "route", "board", "calendar", "edit", "link"] 中选一个最匹配的图标名',
    '   - "prompt": 用户点击该胶囊后发送给你的完整指令（20~100 字，自然第一人称“帮我…”）',
    '3. 不要生成“开启每日早晚总结与复盘”相关的建议（系统已在第 1 位单独处理）。',
    '4. 【多维度分散要求】5 条候选建议必须覆盖不同的工作维度（严禁多条建议围绕同一个项目名或同一张卡片）：',
    '   - 维度 A（对话延续）：若下方有「当前对话最新回复」，可生成 1 条一键承接其后续动作的建议（如整理成卡片草案、写入待办或保存记忆），但绝不能重复刚问过的问题本身；',
    '   - 维度 B（个人待办与精力排期）：如盘点今日待办优先级、规划接下来 1 小时专注事项、清理逾期项；',
    '   - 维度 C（跨会话与看板巡检）：如跟进尚未讨论过的其他近期会话、排查看板 Backlog 或阻塞风险；',
    `   - 维度 D（长期记忆与主理配合）：如检视/整理${botName}已记住的长期记忆、沉淀新的个人协作偏好。`,
  ];
  const dismissedShortLabels = [...dismissed].filter(item => item.length >= 4 && item.length <= 36).slice(-15);
  if (dismissedShortLabels.length > 0 || exhaustedIds.size > 0) {
    const bannedTopics = [...exhaustedIds].slice(0, 12);
    lines.push(
      `5. 【严禁同话题换皮】用户已经点击或讨论过以下建议：${dismissedShortLabels.join('、') || '（见近期提问）'}。` +
        (bannedTopics.length > 0
          ? ` 严禁在 label 或 prompt 中再次出现或围绕以下已聊过的关键词/项目名（换个动词或角度也不行）：${bannedTopics.join('、')}。`
          : ' 严禁换个动词或说法重复围绕同一件事生成建议。'),
    );
  }
  lines.push('', '【当前用户上下文】');

  if (ctx.soul) {
    lines.push(`- 用户画像与沟通设定：称呼=${ctx.soul.userName || '未设置'}，风格=${ctx.soul.preset}（${ctx.soul.prompt.slice(0, 120)}）`);
  }
  if (ctx.lastAssistantReply?.trim()) {
    lines.push(`- 当前对话${botName}最新回复摘录：${ctx.lastAssistantReply.trim().replace(/\s+/gu, ' ').slice(0, 240)}`);
  }
  const freshMemories = (ctx.memories ?? [])
    .filter(m => !isTopicOverlap(`${m.title} ${m.content.slice(0, 40)}`, usedCorpus))
    .slice(0, 6);
  if (freshMemories.length > 0) {
    lines.push('- 尚未在本次会话展开的长期记忆（画像/偏好/项目/决策）：');
    for (const m of freshMemories) {
      lines.push(`  * [${m.category}] ${m.title}：${m.content.slice(0, 120)}`);
    }
  }
  const freshTodos = (ctx.todos ?? [])
    .filter(t => !t.done && !isTopicOverlap(t.title, usedCorpus))
    .slice(0, 5);
  if (freshTodos.length > 0) {
    lines.push(`- 今日未完成待办（${freshTodos.length} 项）：${freshTodos.map(t => t.title).join('；')}`);
  }
  const freshTasks = (ctx.tasks ?? [])
    .filter(t => t.archivedAt === null && !t.hidden && t.status !== 'done' && !isTopicOverlap(t.title, usedCorpus))
    .slice(0, 5);
  if (freshTasks.length > 0) {
    lines.push(`- 尚未讨论的看板在途任务（${freshTasks.length} 项）：${freshTasks.map(t => `[${t.status}] ${t.title}`).join('；')}`);
  }
  const freshSessions = (ctx.recentSessions ?? [])
    .filter(s => !isTopicOverlap(s.title, usedCorpus))
    .slice(0, 5);
  if (freshSessions.length > 0) {
    lines.push(
      `- 其他近期活跃会话：${freshSessions
        .map(s => (s.lastUserMessage ? `${s.title}（最近关注：${s.lastUserMessage.slice(0, 60)}）` : s.title))
        .join('；')}`,
    );
  }

  lines.push('', '请直接返回 JSON 数组，例如：[{"label":"...","icon":"check","prompt":"..."}]');
  return lines.join('\n');
}

export function assembleSuggestionPayload(
  dailyReviewConfigured: boolean,
  dynamicItems: readonly ChatSuggestionItem[],
): ChatSuggestionsPayload {
  const cappedDynamic = dynamicItems.slice(0, 3);
  const items = dailyReviewConfigured
    ? cappedDynamic
    : [FIXED_DAILY_REVIEW_SUGGESTION, ...cappedDynamic];
  return Object.freeze({
    dailyReviewConfigured,
    items: Object.freeze(items),
  });
}

function isItemDismissed(
  item: ChatSuggestionItem,
  dismissed: ReadonlySet<string>,
  recentUserMessages?: readonly string[],
): boolean {
  const hasDismissed = dismissed.size > 0;
  const hasRecent = !!recentUserMessages && recentUserMessages.length > 0;
  if (!hasDismissed && !hasRecent) return false;
  if (
    hasDismissed &&
    ((!item.id.startsWith('llm-suggestion-') && dismissed.has(item.id)) ||
      dismissed.has(item.label.trim()) ||
      dismissed.has(item.prompt.trim()))
  ) {
    return true;
  }
  if (item.id === FIXED_DAILY_REVIEW_SUGGESTION.id) return false;
  return isTopicOverlap(item.label, [...dismissed, ...(recentUserMessages ?? [])]);
}

export function createChatSuggestions(path: string, lifetime: AbortSignal) {
  let cached: StoredSuggestionsCache | undefined;
  const dismissed = new Set<string>();
  let pending: Promise<readonly ChatSuggestionItem[] | null> | undefined;
  let retryAfter = 0;

  async function persistCache(record: StoredSuggestionsCache): Promise<void> {
    const temporary = path + '.' + randomUUID();
    try {
      await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      if (!lifetime.aborted) {
        await rename(temporary, path);
      }
    } catch {
      // ignore write race
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  const saved = readFile(path, 'utf8')
    .then(raw => {
      const parsed = JSON.parse(raw) as Partial<StoredSuggestionsCache>;
      if (Array.isArray(parsed.dismissed)) {
        for (const key of parsed.dismissed) {
          if (typeof key === 'string' && key.trim()) dismissed.add(key.trim());
        }
      }
      if (typeof parsed.fingerprint === 'string' && Array.isArray(parsed.items)) {
        const valid = parseLlmSuggestions(JSON.stringify(parsed.items)).filter(
          item => !isItemDismissed(item, dismissed),
        );
        cached = {
          fingerprint: parsed.fingerprint,
          items: valid,
          dismissed: [...dismissed],
        };
      }
    })
    .catch(() => {});

  async function generateWithLlm(
    fingerprint: string,
    llm: MottoLlm,
    model: ChatModelSelection,
    snapshot: SuggestionContextSnapshot,
  ): Promise<readonly ChatSuggestionItem[] | null> {
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(20_000)]);
    const prompt = buildSuggestionPrompt(snapshot, dismissed);
    let output = '';
    let finished = false;
    for await (const chunk of llm.stream({
      provider: model.provider,
      model: model.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: 600,
      signal,
    })) {
      signal.throwIfAborted();
      if (chunk.type === 'text-delta') output += chunk.text ?? '';
      if (output.length > 2400) break;
      if (chunk.type === 'finish') finished = chunk.reason?.kind === 'stop' || chunk.reason?.kind === 'max-tokens';
    }
    signal.throwIfAborted();
    if (!finished && !output.includes(']')) return null;
    const parsedItems = parseLlmSuggestions(output, 6);
    if (parsedItems.length === 0) return null;
    const items = parsedItems
      .filter(item => !isItemDismissed(item, dismissed, snapshot.recentUserMessages))
      .slice(0, 3);

    const record: StoredSuggestionsCache = {
      fingerprint,
      items,
      dismissed: [...dismissed],
    };
    await persistCache(record);
    cached = record;
    return items;
  }

  const runner = async (
    llm: MottoLlm | undefined,
    model: ChatModelSelection,
    snapshot: SuggestionContextSnapshot,
  ): Promise<ChatSuggestionsPayload> => {
    await saved;
    let dismissChanged = false;
    if (snapshot.dismiss && snapshot.dismiss.length > 0) {
      for (const rawKey of snapshot.dismiss) {
        const key = rawKey.trim();
        if (key && !dismissed.has(key)) {
          dismissed.add(key);
          dismissChanged = true;
        }
      }
    }
    if (cached && dismissChanged) {
      cached = {
        fingerprint: cached.fingerprint,
        items: cached.items.filter(item => !isItemDismissed(item, dismissed, snapshot.recentUserMessages)),
        dismissed: [...dismissed],
      };
      void persistCache(cached);
    }

    const effectiveDailyConfigured =
      snapshot.dailyReviewConfigured || isItemDismissed(FIXED_DAILY_REVIEW_SUGGESTION, dismissed);
    const fallback = buildFallbackDynamicSuggestions(snapshot)
      .filter(item => !isItemDismissed(item, dismissed, snapshot.recentUserMessages))
      .slice(0, 3);
    if (lifetime.aborted) {
      return assembleSuggestionPayload(effectiveDailyConfigured, fallback);
    }

    const fingerprint = buildContextFingerprint(localMottoDay(), snapshot);
    const remainingCached =
      cached?.fingerprint === fingerprint
        ? cached.items.filter(item => !isItemDismissed(item, dismissed, snapshot.recentUserMessages))
        : [];
    // 当当前批次仍有未点击的动态建议时直接返回；若已全部点击完（remainingCached 为空），则自动调用 LLM 补充新一批建议
    if (remainingCached.length > 0) {
      return assembleSuggestionPayload(effectiveDailyConfigured, remainingCached);
    }

    if (!llm || Date.now() < retryAfter) {
      const currentItems = cached
        ? cached.items.filter(item => !isItemDismissed(item, dismissed, snapshot.recentUserMessages))
        : fallback;
      return assembleSuggestionPayload(effectiveDailyConfigured, currentItems);
    }

    pending ??= generateWithLlm(fingerprint, llm, model, snapshot)
      .catch(() => null)
      .then(items => {
        if (!items) retryAfter = Date.now() + 30_000;
        return items;
      })
      .finally(() => {
        pending = undefined;
      });

    const generated = await pending;
    const finalItems =
      generated !== null && generated.length > 0
        ? generated.filter(item => !isItemDismissed(item, dismissed, snapshot.recentUserMessages))
        : fallback;
    return assembleSuggestionPayload(effectiveDailyConfigured, finalItems);
  };

  return Object.assign(runner, {
    clear() {
      cached = undefined;
      dismissed.clear();
      retryAfter = 0;
    },
  });
}
