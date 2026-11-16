import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DEFAULT_BOT_NAME, localMottoDay, type ChatModelSelection, type ChatSoulConfig, type DailyMotto } from './chat-input.js';

export interface MottoLlm {
  stream(options: {
    provider: string;
    model: string;
    messages: { role: 'user'; content: { type: 'text'; text: string }[] }[];
    maxTokens: number;
    signal: AbortSignal;
  }): AsyncIterable<{ type: string; text?: string; reason?: { kind: string } }>;
}

export interface MottoContext {
  readonly soul?: ChatSoulConfig;
  readonly pendingTodoCount?: number;
}

const AI_CLICHE_PATTERNS = /先把眼前这一步做好|多一分清晰|一步一个脚印|星光不负|不负韶华|未来可期|砥砺前行/u;

export function cleanMotto(text: string): string {
  const firstLine = text.trim().split(/\r?\n/u)[0] ?? '';
  const line = firstLine
    .trim()
    .replace(/^[「“"'`*]+|[」”"'`*]+$/gu, '')
    .trim();
  if (!line || line.length > 48 || !/\p{Script=Han}/u.test(line)) return '';
  if (AI_CLICHE_PATTERNS.test(line)) return '';
  // 允许复合 Emoji 所需的零宽连接符 (\u200D) 与变体选择符 (\uFE0E, \uFE0F)，拒绝其他控制符
  const withoutEmojiFormatters = line.replace(/[\u200D\uFE0E\uFE0F]/gu, '');
  if (/[\r\n<>\p{Cc}\p{Cf}]/u.test(withoutEmojiFormatters)) return '';
  if (!/\p{Extended_Pictographic}/u.test(line)) {
    const withEmoji = `✨ ${line}`;
    return withEmoji.length <= 48 ? withEmoji : '';
  }
  return line;
}

function describeMoment(now = new Date()): { weekday: string; period: string } {
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const weekday = weekdays[now.getDay()] ?? '今天';
  const hour = now.getHours();
  const period =
    hour < 9 ? '清晨' :
    hour < 12 ? '上午' :
    hour < 14 ? '中午' :
    hour < 18 ? '午后' :
    hour < 22 ? '傍晚' : '深夜';
  return { weekday, period };
}

export function createDailyMotto(path: string, lifetime: AbortSignal) {
  let current: DailyMotto | undefined;
  let pending: Promise<DailyMotto | null> | undefined;
  let retryAfter = 0;
  const saved = readFile(path, 'utf8').then((raw) => {
    const value = JSON.parse(raw) as Partial<DailyMotto>;
    if (
      typeof value.day === 'string' &&
      typeof value.text === 'string' &&
      /\p{Extended_Pictographic}/u.test(value.text) &&
      cleanMotto(value.text) === value.text
    ) {
      current = { day: value.day, text: value.text };
    }
  }).catch(() => {});

  async function generate(
    day: string,
    llm: MottoLlm,
    model: ChatModelSelection,
    context?: MottoContext,
  ): Promise<DailyMotto | null> {
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(20_000)]);
    const { weekday, period } = describeMoment();
    const botName = context?.soul?.botName?.trim() || DEFAULT_BOT_NAME;
    const userHint = context?.soul?.userName?.trim()
      ? `用户昵称是「${context.soul.userName.trim()}」。`
      : '';
    const todoHint = typeof context?.pendingTodoCount === 'number' && context.pendingTodoCount > 0
      ? `今天手头有 ${context.pendingTodoCount} 件待办。`
      : '';
    const prompt = [
      `今天是 ${day}（${weekday}·${period}）。${userHint}${todoHint}`,
      `你是用户的老搭档「${botName}」。请用像熟人、靠谱搭档随口打招呼的松弛俏皮口吻，写一句接地气、有温度、不端着的今日状态或打气话（14 至 28 字）。`,
      '要求：',
      '1. 自然融入 1~2 个生动贴景的 Emoji（如 ☕️ 🐟 🚀 🎯 🌿 ✨ 🛠️ 🌙 等），增强表达张力；',
      '2. 彻底去 AI 味：严禁出现“先把眼前这一步做好”、“多一分清晰”、“一步一个脚印”、“保持专注”、“不负韶华”、“未来可期”等说教鸡汤或公文套话；',
      '3. 只返回这一句纯文本，不要加引号、不要解释。',
    ].join('\n');
    let output = '', finished = false;
    for await (const chunk of llm.stream({
      provider: model.provider, model: model.model, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: 512, signal,
    })) {
      signal.throwIfAborted();
      if (chunk.type === 'text-delta') output += chunk.text ?? '';
      if (output.length > 160) return null;
      if (chunk.type === 'finish') finished = chunk.reason?.kind === 'stop';
    }
    signal.throwIfAborted();
    const text = cleanMotto(output);
    if (!finished || !text || localMottoDay() !== day) return null;
    const value = { day, text };
    const temporary = path + '.' + randomUUID();
    try {
      await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
      signal.throwIfAborted();
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => {});
    }
    current = value;
    return value;
  }

  return async (
    llm: MottoLlm | undefined,
    model: ChatModelSelection,
    context?: MottoContext,
  ): Promise<DailyMotto | null> => {
    await saved;
    if (lifetime.aborted) return null;
    const day = localMottoDay();
    if (current?.day === day) return current;
    if (!llm || Date.now() < retryAfter) return null;
    pending ??= generate(day, llm, model, context).catch(() => null).then(value => {
      if (!value) retryAfter = Date.now() + 60_000;
      return value;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}
