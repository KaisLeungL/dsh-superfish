/**
 * @local/dsh-superfish-genui - Host 侧 Cordis 插件服务
 *
 * 对齐 OpenTiny GenUI SDK Core (@opentiny/genui-sdk-core)：
 * - genPrompt(framework, materialsMeta, customConfig)
 * - repairJson(partialJson)
 * - StreamPatternExtractor
 * - registerMaterialMeta(meta) / getMaterialsMeta()
 */

const VALID_COMPONENT_NAME = /^[A-Z][A-Za-z0-9_]{1,63}$/;

export function repairJson(raw) {
  if (typeof raw !== 'string') return '{}';
  let text = raw.trim();
  const fenced = text.match(/^```(?:json|schema-json)?\s*([\s\S]*?)(?:```|$)/i);
  if (fenced && fenced[1]) text = fenced[1].trim();
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  let start = -1;
  if (firstBrace >= 0 && firstBracket >= 0) start = Math.min(firstBrace, firstBracket);
  else start = Math.max(firstBrace, firstBracket);
  if (start > 0) text = text.slice(start);
  if (!text) return '{}';

  try {
    JSON.parse(text);
    return text;
  } catch {
    // 继续流式残缺修复
  }

  const stack = [];
  let inString = false;
  let escaped = false;
  let out = '';

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
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
  out = out.replace(/,\s*$/, '');
  if (/:\s*$/.test(out)) out += 'null';
  else if (out.endsWith(':')) out += 'null';

  while (stack.length > 0) {
    const closer = stack.pop();
    out = out.replace(/,\s*$/, '');
    if (closer === '}' && /\{\s*"[^"]+"\s*$/.test(out)) {
      out += ':null';
    }
    out += closer;
  }

  try {
    JSON.parse(out);
    return out;
  } catch {
    return '{}';
  }
}

export class StreamPatternExtractor {
  constructor(patterns = [{ type: 'schema-json', start: '```schema-json', end: '```' }]) {
    this.patterns = patterns;
    this.buffer = '';
  }

  handleContent(delta) {
    if (typeof delta === 'string') this.buffer += delta;
    return this.snapshot();
  }

  snapshot() {
    const chunks = [];
    for (const pat of this.patterns) {
      const startIdx = this.buffer.indexOf(pat.start);
      if (startIdx < 0) continue;
      const bodyStart = startIdx + pat.start.length;
      const endIdx = this.buffer.indexOf(pat.end, bodyStart);
      if (endIdx >= 0) {
        chunks.push({
          type: pat.type,
          content: this.buffer.slice(bodyStart, endIdx).trim(),
          isComplete: true,
        });
      } else {
        chunks.push({
          type: pat.type,
          content: this.buffer.slice(bodyStart).trim(),
          isComplete: false,
        });
      }
    }
    return chunks;
  }

  reset() {
    this.buffer = '';
  }
}

export function genPrompt(framework, materialsMeta, customConfig = {}) {
  const list = Array.isArray(materialsMeta) ? materialsMeta : Object.values(materialsMeta || {});
  const lines = [
    `# OpenTiny GenUI Schema 渲染协议 (${framework || 'React'})`,
    '你可以通过生成符合 OpenTiny GenUI `SchemaJson` 规范的组件树，将复杂文本转化为交互式可视化界面。',
    '',
    '## 顶层结构',
    '```json',
    '{ "componentName": "GenuiCard", "props": { "title": "标题" }, "children": [] }',
    '```',
    '',
    '## 已注册物料清单 (Materials Catalog)',
  ];
  for (const meta of list) {
    if (!meta || typeof meta.componentName !== 'string') continue;
    lines.push(`### \`${meta.componentName}\` (${meta.title || meta.componentName}) — [${meta.category || 'domain'}]`);
    if (meta.description) lines.push(meta.description);
    lines.push('Props: `' + JSON.stringify(meta.propsSchema || {}) + '`');
    if (Array.isArray(meta.events) && meta.events.length > 0) {
      lines.push(
        'Events: ' +
          meta.events.map(ev => `\`${ev.name}\` -> \`${ev.action}\` (${ev.description || ''})`).join('；'),
      );
    }
    lines.push('');
  }
  if (Array.isArray(customConfig.rules) && customConfig.rules.length > 0) {
    lines.push('## 安全与交互约束');
    for (const rule of customConfig.rules) lines.push(`- ${rule}`);
  }
  return lines.join('\n');
}

function validateMaterialMeta(meta) {
  if (!meta || typeof meta !== 'object') throw Error('GENUI_MATERIAL_META_INVALID');
  if (typeof meta.componentName !== 'string' || !VALID_COMPONENT_NAME.test(meta.componentName)) {
    throw Error('GENUI_COMPONENT_NAME_INVALID');
  }
  return Object.freeze({
    componentName: meta.componentName,
    title: typeof meta.title === 'string' && meta.title.trim() ? meta.title.trim() : meta.componentName,
    category: ['layout', 'domain', 'display', 'feedback'].includes(meta.category) ? meta.category : 'domain',
    description: typeof meta.description === 'string' ? meta.description.trim() : '',
    propsSchema: meta.propsSchema && typeof meta.propsSchema === 'object' ? structuredClone(meta.propsSchema) : {},
    ...(typeof meta.allowChildren === 'boolean' ? { allowChildren: meta.allowChildren } : {}),
    ...(Array.isArray(meta.events) ? { events: structuredClone(meta.events) } : {}),
  });
}

export function apply(ctx, config = {}) {
  const materials = new Map();
  const pluginPackages = new Map();
  const lifetime = new AbortController();

  if (Array.isArray(config.materialsMeta)) {
    for (const item of config.materialsMeta) {
      const normalized = validateMaterialMeta(item);
      materials.set(normalized.componentName, normalized);
    }
  }

  ctx.effect(() => () => {
    lifetime.abort();
    materials.clear();
    pluginPackages.clear();
  });

  const service = {
    protocol: 1,
    repairJson,
    StreamPatternExtractor,
    genPrompt,
    registerMaterialMeta(meta) {
      lifetime.signal.throwIfAborted();
      const normalized = validateMaterialMeta(meta);
      materials.set(normalized.componentName, normalized);
      return () => {
        if (materials.get(normalized.componentName) === normalized) {
          materials.delete(normalized.componentName);
        }
      };
    },
    registerPluginMaterials(pluginId, metas = []) {
      lifetime.signal.throwIfAborted();
      if (typeof pluginId !== 'string' || !pluginId.trim()) {
        throw Error('GENUI_PLUGIN_ID_INVALID');
      }
      if (!Array.isArray(metas)) {
        throw Error('GENUI_PLUGIN_METAS_INVALID');
      }
      const key = pluginId.trim();
      const normalizedList = metas.map((item) => validateMaterialMeta(item));
      for (const normalized of normalizedList) {
        materials.set(normalized.componentName, normalized);
      }
      pluginPackages.set(
        key,
        Object.freeze({
          pluginId: key,
          components: Object.freeze(normalizedList.map((m) => m.componentName)),
        }),
      );
      return () => {
        for (const normalized of normalizedList) {
          if (materials.get(normalized.componentName) === normalized) {
            materials.delete(normalized.componentName);
          }
        }
        pluginPackages.delete(key);
      };
    },
    getMaterialsMeta() {
      return [...materials.values()];
    },
    listPlugins() {
      return [...pluginPackages.values()];
    },
  };

  ctx.provide('superagentGenui', service);
}
