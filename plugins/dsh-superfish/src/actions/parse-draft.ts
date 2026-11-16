export interface ParsedTaskDraft {
  readonly title: string;
  readonly description: string;
  readonly prompt: string;
}

export interface TaskParseLlm {
  prepareCall?(
    config: { provider: string; model: string; maxTokens?: number },
    signal?: AbortSignal,
  ): Promise<{
    config: Record<string, unknown>;
    stream(request: Record<string, unknown>): AsyncIterable<{ type: string; text?: string }>;
  }>;
  stream(options: {
    provider: string;
    model: string;
    system?: string;
    messages: { role: 'user'; content: { type: 'text'; text: string }[] }[];
    maxTokens: number;
    signal: AbortSignal;
  }): AsyncIterable<{ type: string; text?: string }>;
}

const TASK_PARSE_TIMEOUT_MS = 45_000;
export const TASK_PARSE_MAX_INPUT = 16 * 1024;
const TASK_PARSE_TITLE_LIMIT = 120;

export const TASK_PARSE_SYSTEM_PROMPT = [
  'You turn one pasted note into a task for a kanban board.',
  'Reply with a single JSON object and nothing else, with exactly these keys:',
  '{"title": string, "description": string, "prompt": string}',
  '- title: one line, at most 80 characters, in the language of the note.',
  '- description: what the task is and the context the note carries, as plain text.',
  '- prompt: the instruction an agent should execute, keeping every fact that matters and expanding brief user statements into concrete, actionable steps, scope, and expected deliverables in the language of the note.',
].join('\n');

function field(value: unknown, limit?: number): string {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return limit === undefined || text.length <= limit ? text : text.slice(0, limit).trim();
}

function firstLine(source: string): string {
  const line = source.split(/\r?\n/).map(entry => entry.trim()).find(entry => entry !== '') ?? '';
  return line.length <= TASK_PARSE_TITLE_LIMIT ? line : line.slice(0, TASK_PARSE_TITLE_LIMIT).trim();
}

export function extractTaskParseReply(reply: string): Partial<ParsedTaskDraft> | undefined {
  const withoutFences = reply.replace(/```[a-zA-Z]*\s*/g, '');
  const start = withoutFences.indexOf('{');
  const end = withoutFences.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(withoutFences.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (typeof payload !== 'object' || payload === null) return undefined;
  const record = payload as { title?: unknown; description?: unknown; prompt?: unknown };
  const draft: Partial<ParsedTaskDraft> = {
    title: field(record.title, TASK_PARSE_TITLE_LIMIT),
    description: field(record.description, 4000),
    prompt: field(record.prompt, 20000),
  };
  return draft.title === '' && draft.description === '' && draft.prompt === '' ? undefined : draft;
}

export function draftFromReply(reply: string, source: string): ParsedTaskDraft {
  const parsed = extractTaskParseReply(reply);
  return {
    title: parsed?.title !== undefined && parsed.title !== '' ? parsed.title : firstLine(source),
    description: parsed?.description ?? '',
    prompt: parsed?.prompt !== undefined && parsed.prompt !== '' ? parsed.prompt : source.trim(),
  };
}

export async function parseBoardTaskDraft(
  llm: TaskParseLlm | undefined,
  route: { provider: string; model: string } | null | undefined,
  rawText: string,
  callerSignal?: AbortSignal,
): Promise<ParsedTaskDraft> {
  const text = rawText.trim();
  if (!text || text.length > TASK_PARSE_MAX_INPUT) throw Error('INVALID_DRAFT');
  if (!llm || !route?.provider || !route?.model) throw Error('ACTION_UNAVAILABLE');
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, AbortSignal.timeout(TASK_PARSE_TIMEOUT_MS)])
    : AbortSignal.timeout(TASK_PARSE_TIMEOUT_MS);
  const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: `${TASK_PARSE_SYSTEM_PROMPT}\n\n用户输入：\n${text}` }] }];
  const stream = typeof llm.prepareCall === 'function'
    ? await llm.prepareCall({ provider: route.provider, model: route.model, maxTokens: 2048 }, signal).then(prepared =>
        prepared.stream({ ...prepared.config, system: TASK_PARSE_SYSTEM_PROMPT, messages, signal }),
      )
    : llm.stream({ provider: route.provider, model: route.model, system: TASK_PARSE_SYSTEM_PROMPT, messages, maxTokens: 2048, signal });
  let reply = '';
  for await (const chunk of stream) {
    signal.throwIfAborted();
    if (chunk.type === 'text-delta') reply += chunk.text ?? '';
  }
  signal.throwIfAborted();
  return draftFromReply(reply, text);
}
