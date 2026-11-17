export interface MaterialPropMeta {
  readonly type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  readonly description: string;
  readonly required?: boolean;
  readonly enum?: readonly string[];
}

export interface MaterialMeta {
  readonly componentName: string;
  readonly aliases?: readonly string[];
  readonly category?: 'layout' | 'domain' | 'feedback';
  readonly description: string;
  readonly props?: Readonly<Record<string, MaterialPropMeta>>;
  readonly allowChildren?: boolean;
  readonly events?: Readonly<Record<string, string>>;
}

export type MaterialsMetaMap = Readonly<Record<string, MaterialMeta>>;

export interface GenuiActionBinding {
  readonly action: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface GenuiNode {
  readonly componentName: string;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly children?: readonly GenuiNode[];
  readonly actions?: Readonly<Record<string, GenuiActionBinding>>;
}

export type SchemaJson = GenuiNode;

export interface GenPromptCustomConfig {
  readonly rules?: readonly string[];
  readonly examples?: readonly GenuiNode[];
}

const MAX_SCHEMA_DEPTH = 8;
const MAX_SCHEMA_NODES = 80;
const MAX_STRING_LENGTH = 4000;
const MAX_ARRAY_ITEMS = 40;

/**
 * 兼容 @opentiny/genui-sdk-core 的 repairJson：
 * 从流式或不完整的 JSON 文本（含 ```genui-schema / ```json 代码块）中提取并自动补全缺失的引号、括号与尾随逗号。
 */
export function repairJson(input: string): string {
  let text = String(input ?? '').trim();
  const fenced = /^```(?:genui-schema|json|genui)?\s*\r?\n([\s\S]*?)(?:\r?\n```)?$/i.exec(text);
  if (fenced) text = fenced[1]!.trim();
  const firstBrace = text.indexOf('{');
  if (firstBrace > 0) text = text.slice(firstBrace);
  if (!text) return '{}';

  try {
    JSON.parse(text);
    return text;
  } catch {
    // 继续执行增量语法修复
  }

  const stack: ('}' | ']')[] = [];
  let inString = false;
  let escaped = false;
  let out = '';

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '{') {
      stack.push('}');
      out += ch;
    } else if (ch === '[') {
      stack.push(']');
      out += ch;
    } else if (ch === '}' || ch === ']') {
      if (stack.length > 0 && stack[stack.length - 1] === ch) {
        stack.pop();
        out += ch;
      }
    } else {
      out += ch;
    }
  }

  if (inString) {
    if (escaped) out = out.slice(0, -1);
    out += '"';
  }

  // 清理末尾悬空的冒号、逗号或未完成的键名
  let trimmed = out.trimEnd();
  while (trimmed.length > 0) {
    if (trimmed.endsWith(',') || trimmed.endsWith(':')) {
      trimmed = trimmed.slice(0, -1).trimEnd();
      continue;
    }
    break;
  }

  const closing = [...stack].reverse().join('');
  const candidate = trimmed + closing;
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    // 若末尾存在悬空的裸属性键（如 `{"a":1,"b"`），尝试回退最后一个逗号后再闭合
    const lastComma = trimmed.lastIndexOf(',');
    if (lastComma > 0) {
      const fallback = trimmed.slice(0, lastComma).trimEnd() + closing;
      try {
        JSON.parse(fallback);
        return fallback;
      } catch {
        // 保留 candidate
      }
    }
    return candidate;
  }
}

/**
 * 兼容 @opentiny/genui-sdk-core 的 StreamPatternExtractor：
 * 从流式 Markdown 文本中提取 ```genui-schema 代码块并实时产出修复后的 SchemaJson。
 */
export const ALLOWED_GENUI_ACTIONS = new Set([
  'dsh.todo.toggle',
  'dsh.todo.moveToToday',
  'dsh.todo.moveToTomorrow',
  'dsh.todo.create',
  'dsh.personal.toggleTodo',
  'dsh.personal.moveTodoToday',
  'dsh.personal.moveTodoTomorrow',
  'dsh.personal.createTodo',
  'dsh.session.open',
  'dsh.taskBoard.open',
  'dsh.personal.open',
  'dsh.pomodoro.start',
  'dsh.pomodoro.pause',
  'dsh.pomodoro.resume',
  'dsh.pomodoro.reset',
  'dsh.pomodoro.select',
  'dsh.action.open',
]);

export class StreamPatternExtractor {
  #buffer = '';
  append(chunk: string): { text: string; schemas: { raw: string; repaired: string; complete: boolean }[] } {
    this.#buffer += chunk;
    return this.snapshot();
  }
  handleContent(chunk: string): { text: string; schemas: { raw: string; repaired: string; complete: boolean }[] } {
    return this.append(chunk);
  }
  snapshot(): { text: string; schemas: { raw: string; repaired: string; complete: boolean }[] } {
    const schemas: { raw: string; repaired: string; complete: boolean }[] = [];
    const blockRegex = /```(?:genui-schema|genui|schema-json)\s*\r?\n([\s\S]*?)(?:\r?\n```|$)/gi;
    let cleanText = '';
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = blockRegex.exec(this.#buffer)) !== null) {
      cleanText += this.#buffer.slice(lastIndex, match.index);
      const fullMatch = match[0]!;
      const body = match[1] ?? '';
      const complete = fullMatch.endsWith('```');
      schemas.push({ raw: body, repaired: repairJson(body), complete });
      lastIndex = match.index + fullMatch.length;
    }
    cleanText += this.#buffer.slice(lastIndex);
    return { text: cleanText.trim(), schemas };
  }
  reset(): void {
    this.#buffer = '';
  }
}

/**
 * 兼容 @opentiny/genui-sdk-core 的 genPrompt：
 * 根据目标框架（React/Vue/Angular）与物料元数据（materialsMeta）动态生成给 LLM 的系统提示词。
 */
export function genPrompt(
  framework: 'React' | 'Vue' | 'Angular',
  materialsMeta: MaterialsMetaMap,
  customConfig?: GenPromptCustomConfig,
): string {
  const lines: string[] = [
    `# OpenTiny GenUI SDK (${framework}) 声明式界面生成协议`,
    '',
    '你可以使用 `SchemaJson` 组件树协议动态构建可视化界面。每个节点格式为：',
    '`{ "componentName": "<组件名>", "props": { ... }, "children": [ ... ] }`',
    '',
    '## 可用组件目录 (Materials Catalog)',
  ];

  for (const meta of Object.values(materialsMeta)) {
    const aliasText = meta.aliases?.length ? `（兼容别名：${meta.aliases.join(' / ')}）` : '';
    lines.push(`### \`${meta.componentName}\`${aliasText}`);
    lines.push(`- 说明：${meta.description}`);
    if (meta.props && Object.keys(meta.props).length > 0) {
      lines.push('- 属性 (`props`)：');
      for (const [propName, propMeta] of Object.entries(meta.props)) {
        const req = propMeta.required ? '必填' : '可选';
        const enumHint = propMeta.enum?.length ? `，可选值：${propMeta.enum.map(v => `\`${v}\``).join(' | ')}` : '';
        lines.push(`  - \`${propName}\` (\`${propMeta.type}\`, ${req})：${propMeta.description}${enumHint}`);
      }
    }
    if (meta.events && Object.keys(meta.events).length > 0) {
      lines.push('- 内置交互动作：');
      for (const [eventName, desc] of Object.entries(meta.events)) {
        lines.push(`  - \`${eventName}\`：${desc}`);
      }
    }
    lines.push('');
  }

  if (customConfig?.rules?.length) {
    lines.push('## 生成约束与安全规则');
    for (const [index, rule] of customConfig.rules.entries()) {
      lines.push(`${index + 1}. ${rule}`);
    }
    lines.push('');
  }

  if (customConfig?.examples?.length) {
    lines.push('## 标准 SchemaJson 示例');
    for (const example of customConfig.examples) {
      lines.push('```json');
      lines.push(JSON.stringify(example, null, 2));
      lines.push('```');
    }
  }

  return lines.join('\n').trim();
}

function sanitizeValue(
  value: unknown,
  depth: number,
  canonicalNameMap: ReadonlyMap<string, string>,
  counter: { nodes: number },
): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return value.length > MAX_STRING_LENGTH ? value.slice(0, MAX_STRING_LENGTH) : value;
  if (Array.isArray(value)) {
    if (depth > MAX_SCHEMA_DEPTH + 2) return [];
    const items: unknown[] = [];
    for (const entry of value.slice(0, MAX_ARRAY_ITEMS)) {
      if (isPlainRecord(entry) && typeof entry.componentName === 'string') {
        items.push(validateNode(entry, depth + 1, canonicalNameMap, counter));
      } else {
        const cleaned = sanitizeValue(entry, depth + 1, canonicalNameMap, counter);
        if (cleaned !== undefined) items.push(cleaned);
      }
    }
    return items;
  }
  if (isPlainRecord(value)) {
    if (depth > MAX_SCHEMA_DEPTH + 2) return {};
    if (typeof value.componentName === 'string') {
      return validateNode(value, depth + 1, canonicalNameMap, counter);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype' || k.startsWith('on')) continue;
      if (k === 'children' && Array.isArray(v)) {
        out.children = v
          .slice(0, MAX_ARRAY_ITEMS)
          .filter(item => isPlainRecord(item) && typeof item.componentName === 'string')
          .map(item => validateNode(item as Record<string, unknown>, depth + 1, canonicalNameMap, counter));
        continue;
      }
      const cleaned = sanitizeValue(v, depth + 1, canonicalNameMap, counter);
      if (cleaned !== undefined) out[k] = cleaned;
    }
    return out;
  }
  return undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildCanonicalNameMap(materialsMeta: MaterialsMetaMap, extraAllowed?: ReadonlySet<string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const meta of Object.values(materialsMeta)) {
    map.set(meta.componentName, meta.componentName);
    map.set(meta.componentName.toLowerCase(), meta.componentName);
    for (const alias of meta.aliases ?? []) {
      map.set(alias, meta.componentName);
      map.set(alias.toLowerCase(), meta.componentName);
    }
  }
  if (extraAllowed) {
    for (const name of extraAllowed) {
      if (!map.has(name)) {
        map.set(name, name);
        map.set(name.toLowerCase(), name);
      }
    }
  }
  return map;
}

function validateNode(
  raw: Record<string, unknown>,
  depth: number,
  canonicalNameMap: ReadonlyMap<string, string>,
  counter: { nodes: number },
): GenuiNode {
  if (depth > MAX_SCHEMA_DEPTH) throw new Error('INVALID_GENUI_SCHEMA');
  counter.nodes++;
  if (counter.nodes > MAX_SCHEMA_NODES) throw new Error('INVALID_GENUI_SCHEMA');

  const rawName = typeof raw.componentName === 'string' ? raw.componentName.trim() : '';
  const canonicalName = canonicalNameMap.get(rawName) ?? canonicalNameMap.get(rawName.toLowerCase());
  if (!canonicalName) throw new Error('INVALID_GENUI_COMPONENT:' + rawName);

  const rawProps = raw.props === undefined ? {} : raw.props;
  if (!isPlainRecord(rawProps)) throw new Error('INVALID_GENUI_SCHEMA');
  const props = sanitizeValue(rawProps, depth + 1, canonicalNameMap, counter) as Record<string, unknown>;

  let children: GenuiNode[] | undefined;
  if (raw.children !== undefined) {
    if (!Array.isArray(raw.children)) throw new Error('INVALID_GENUI_SCHEMA');
    children = raw.children.slice(0, MAX_ARRAY_ITEMS).map(child => {
      if (!isPlainRecord(child)) throw new Error('INVALID_GENUI_SCHEMA');
      return validateNode(child, depth + 1, canonicalNameMap, counter);
    });
  }

  let actions: Record<string, GenuiActionBinding> | undefined;
  if (raw.actions !== undefined) {
    if (!isPlainRecord(raw.actions)) throw new Error('INVALID_GENUI_SCHEMA');
    actions = {};
    for (const [eventKey, binding] of Object.entries(raw.actions)) {
      if (
        !isPlainRecord(binding) ||
        typeof binding.action !== 'string' ||
        (!ALLOWED_GENUI_ACTIONS.has(binding.action) && !/^custom\.[a-zA-Z0-9_.]+$/.test(binding.action))
      ) {
        const invalidName = isPlainRecord(binding) && typeof binding.action === 'string' ? ':' + binding.action : '';
        throw new Error('INVALID_GENUI_ACTION' + invalidName);
      }
      const params = binding.params !== undefined
        ? (sanitizeValue(binding.params, depth + 1, canonicalNameMap, counter) as Record<string, unknown>)
        : undefined;
      actions[eventKey] = { action: binding.action, ...(params ? { params } : {}) };
    }
  }

  return {
    componentName: canonicalName,
    ...(Object.keys(props).length > 0 ? { props } : {}),
    ...(children && children.length > 0 ? { children } : {}),
    ...(actions && Object.keys(actions).length > 0 ? { actions } : {}),
  };
}

export function parseAndValidateSchema(
  input: unknown,
  materialsMeta: MaterialsMetaMap,
  extraAllowed?: ReadonlySet<string>,
): { schema: GenuiNode; nodeCount: number } {
  let parsed: unknown = input;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(repairJson(input));
    } catch {
      throw new Error('INVALID_GENUI_SCHEMA');
    }
  }
  if (!isPlainRecord(parsed)) throw new Error('INVALID_GENUI_SCHEMA');
  const canonicalNameMap = buildCanonicalNameMap(materialsMeta, extraAllowed);
  const counter = { nodes: 0 };
  const schema = validateNode(parsed, 0, canonicalNameMap, counter);
  return { schema, nodeCount: counter.nodes };
}
