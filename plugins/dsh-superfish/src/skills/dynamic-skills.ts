import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { truncateUtf8Safe } from '../prompts/soul.js';
import { scrubSensitiveText } from '../app/sentinel/scrubber.js';
import {
  CallerAuthority,
  CallerDenied,
  SKILL_TOOLS,
  SKILL_WRITE_TOOLS,
  type CallerAgent,
  type Invocation,
} from '../tools/authority.js';

export type SkillScope = 'workspace' | 'global';

export interface CustomSkillSummary {
  readonly slug: string;
  readonly name: string;
  readonly displayName?: string;
  readonly description: string;
  readonly triggers: readonly string[];
  readonly scope: SkillScope;
  readonly updatedAt: number;
}

export interface CustomSkillDetail extends CustomSkillSummary {
  readonly instructions: string;
}

export interface CustomSkillUpsertInput {
  readonly slug: string;
  readonly name?: string;
  readonly displayName?: string;
  readonly description: string;
  readonly instructions: string;
  readonly triggers?: readonly string[];
  readonly scope?: SkillScope;
}

export interface DynamicSkillToolInvocation<A extends CallerAgent> extends Invocation<A> {
  readonly name: string;
}

/**
 * DSH 宿主技能名强规范：仅允许英文小写字母、数字与单连字符（kebab-case），长度 2~64。
 * 对应 @michengai/dsh-skills-manager 中的 KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/。
 */
export const KEBAB_SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SKILL_INSTRUCTIONS_CHARS = 8000;
const MAX_SKILL_CATALOG_BYTES = 2048;

export const SKILLS_CREATOR_SKILL = 'skills-creator';
const packageRoot = new URL(import.meta.url).pathname.endsWith('/dynamic-skills.ts') ? '../../' : '../';
const skillsCreatorFile = new URL(packageRoot + 'skills/skills-creator/SKILL.md', import.meta.url);
const skillsCreatorMarkdown = readFileSync(skillsCreatorFile, 'utf8');

export const skillsCreatorSkill = {
  name: SKILLS_CREATOR_SKILL,
  description:
    '创建或更新大肥鱼自定义程序性技能（SKILL.md）的底层元技能规范，约束英文 kebab-case 命名、YAML Frontmatter 结构、三阶段渐进式披露与 SOP 编写准则。',
  source: 'bundled',
  invocation: { modelInvocable: true, userInvocable: false },
  content: skillsCreatorMarkdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim(),
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const asRecord = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) throw new CallerDenied('INVALID_ARGUMENTS', '工具参数必须是对象。');
  return value;
};

export function isValidSkillSlug(slug: unknown): slug is string {
  if (typeof slug !== 'string') return false;
  const trimmed = slug.trim();
  return trimmed.length >= 2 && trimmed.length <= 64 && KEBAB_SKILL_NAME_RE.test(trimmed);
}

function extractLeadingHeading(markdownBody: string): string | undefined {
  const firstLine = markdownBody.trim().split('\n')[0]?.trim() ?? '';
  if (firstLine.startsWith('# ')) {
    const title = firstLine.slice(2).trim();
    if (title) return title;
  }
  return undefined;
}

function parseFrontmatterSkill(
  rawText: string,
  fallbackSlug: string,
): {
  name: string;
  displayName?: string;
  description: string;
  triggers: string[];
  instructions: string;
} {
  const normalized = rawText.replace(/\r\n/g, '\n').trim();
  if (!normalized.startsWith('---\n')) {
    const heading = extractLeadingHeading(normalized);
    return {
      name: fallbackSlug,
      ...(heading ? { displayName: heading } : {}),
      description: truncateUtf8Safe(normalized.split('\n')[0] ?? fallbackSlug, 160),
      triggers: [],
      instructions: normalized,
    };
  }
  const endIdx = normalized.indexOf('\n---\n', 4);
  if (endIdx < 0) {
    const heading = extractLeadingHeading(normalized);
    return {
      name: fallbackSlug,
      ...(heading ? { displayName: heading } : {}),
      description: fallbackSlug,
      triggers: [],
      instructions: normalized,
    };
  }
  const headerBlock = normalized.slice(4, endIdx);
  const body = normalized.slice(endIdx + 5).trim();
  let rawName = '';
  let description = '';
  const triggers: string[] = [];

  for (const line of headerBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx <= 0) continue;
    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const val = line.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key === 'name' && val) {
      rawName = val.trim();
    } else if (key === 'description' && val) {
      description = val;
    } else if (key === 'triggers' && val) {
      try {
        const parsed = JSON.parse(val);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (typeof item === 'string' && item.trim()) triggers.push(item.trim());
          }
          continue;
        }
      } catch {
        // fallback to comma split
      }
      for (const part of val.split(',')) {
        if (part.trim()) triggers.push(part.trim());
      }
    }
  }

  // 强制保证返回的 name 符合宿主英文 kebab-case 规范；若旧文件 name 为中文则自动降级为 displayName
  const validKebabName = isValidSkillSlug(rawName) ? rawName : fallbackSlug;
  const heading = extractLeadingHeading(body);
  const displayName = !isValidSkillSlug(rawName) && rawName ? rawName : heading;

  return {
    name: validKebabName,
    ...(displayName ? { displayName } : {}),
    description: description || truncateUtf8Safe(body.split('\n')[0] ?? validKebabName, 160),
    triggers,
    instructions: body,
  };
}

function serializeSkillMarkdown(input: {
  slug: string;
  name: string;
  displayName?: string;
  description: string;
  triggers: readonly string[];
  instructions: string;
}): string {
  // 宿主 @michengai/dsh-skills-manager 要求 frontmatter name 必须为英文 kebab-case
  const kebabName = isValidSkillSlug(input.name) ? input.name.trim() : input.slug.trim();
  const safeDesc = input.description.replace(/\r?\n/g, ' ').trim();
  let body = input.instructions.trim();
  const displayTitle = input.displayName?.replace(/\r?\n/g, ' ').trim();
  if (displayTitle && !body.startsWith('# ')) {
    body = `# ${displayTitle}\n\n${body}`;
  }
  const lines = [
    '---',
    `name: ${kebabName}`,
    `description: ${JSON.stringify(safeDesc)}`,
    ...(input.triggers.length > 0 ? [`triggers: ${JSON.stringify(input.triggers)}`] : []),
    '---',
    '',
    body,
    '',
  ];
  return lines.join('\n');
}

/**
 * 动态程序性记忆与自定义技能注册表（Dynamic Procedural Skills）：
 * 支持在 `<workspacePath>/.dsh/skills/<slug>/SKILL.md` 与 `<dshHome>/.dsh/skills/<slug>/SKILL.md`
 * 发现、按需加载、由用户传授并持久化自定义 SOP 技能。
 */
export class DynamicSkillRegistry {
  constructor(
    private readonly workspacePath: string | null,
    private readonly globalDshHome: string | null = process.env.DSH_HOME || homedir(),
  ) {}

  #skillsRoot(scope: SkillScope): string | null {
    if (scope === 'workspace') {
      return this.workspacePath ? resolve(this.workspacePath, '.dsh', 'skills') : null;
    }
    if (!this.globalDshHome) return null;
    return this.globalDshHome.endsWith('/.dsh') || this.globalDshHome.endsWith('\\.dsh')
      ? resolve(this.globalDshHome, 'skills')
      : resolve(this.globalDshHome, '.dsh', 'skills');
  }

  #scanScope(scope: SkillScope): CustomSkillDetail[] {
    const rootDir = this.#skillsRoot(scope);
    if (!rootDir || !existsSync(rootDir)) return [];
    const results: CustomSkillDetail[] = [];
    let entries: string[] = [];
    try {
      entries = readdirSync(rootDir);
    } catch {
      return [];
    }
    for (const entry of entries.sort()) {
      if (!isValidSkillSlug(entry)) continue;
      const skillFile = join(rootDir, entry, 'SKILL.md');
      try {
        if (!existsSync(skillFile)) continue;
        const stat = statSync(skillFile);
        if (!stat.isFile() || stat.size > 64 * 1024) continue;
        const raw = readFileSync(skillFile, 'utf8');
        const parsed = parseFrontmatterSkill(raw, entry);
        const scrubbedDisplay = parsed.displayName ? scrubSensitiveText(parsed.displayName).text : undefined;
        results.push(
          Object.freeze({
            slug: entry,
            name: scrubSensitiveText(parsed.name).text,
            ...(scrubbedDisplay ? { displayName: scrubbedDisplay } : {}),
            description: scrubSensitiveText(parsed.description).text,
            triggers: Object.freeze(parsed.triggers.map(t => scrubSensitiveText(t).text)),
            instructions: scrubSensitiveText(parsed.instructions).text,
            scope,
            updatedAt: Math.trunc(stat.mtimeMs),
          }),
        );
      } catch {
        // 忽略损坏的单条技能文件
      }
    }
    return results;
  }

  listSkills(scopeFilter: SkillScope | 'all' = 'all'): readonly CustomSkillSummary[] {
    const wsSkills = scopeFilter === 'global' ? [] : this.#scanScope('workspace');
    const globalSkills = scopeFilter === 'workspace' ? [] : this.#scanScope('global');
    const bySlug = new Map<string, CustomSkillSummary>();
    // 工作区同名技能优先于全局技能
    for (const item of [...globalSkills, ...wsSkills]) {
      const { instructions: _omit, ...summary } = item;
      bySlug.set(item.slug, Object.freeze(summary));
    }
    return Object.freeze([...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug)));
  }

  listSkillDetails(scopeFilter: SkillScope | 'all' = 'all', includeBuiltIn = false): readonly CustomSkillDetail[] {
    const wsSkills = scopeFilter === 'global' ? [] : this.#scanScope('workspace');
    const globalSkills = scopeFilter === 'workspace' ? [] : this.#scanScope('global');
    const bySlug = new Map<string, CustomSkillDetail>();
    for (const item of [...globalSkills, ...wsSkills]) {
      bySlug.set(item.slug, item);
    }
    const list = [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
    if (includeBuiltIn && scopeFilter !== 'workspace' && !bySlug.has(SKILLS_CREATOR_SKILL)) {
      const builtIn = this.loadSkill(SKILLS_CREATOR_SKILL);
      if (builtIn) list.push(builtIn);
    }
    return Object.freeze(list);
  }

  loadSkill(slug: string, preferredScope?: SkillScope): CustomSkillDetail | undefined {
    const normalizedSlug = slug.trim();
    if (!isValidSkillSlug(normalizedSlug)) {
      throw Error('SKILL_SLUG_INVALID');
    }
    if (normalizedSlug === SKILLS_CREATOR_SKILL || normalizedSlug === 'skill-creator') {
      return Object.freeze({
        slug: SKILLS_CREATOR_SKILL,
        name: SKILLS_CREATOR_SKILL,
        displayName: '大肥鱼自定义技能构建器 (Skills Creator)',
        description: skillsCreatorSkill.description,
        triggers: Object.freeze(['创建技能', '新建技能', '沉淀技能', 'skills-creator', 'skill-creator']),
        instructions: skillsCreatorSkill.content,
        scope: 'global',
        updatedAt: 0,
      });
    }
    const scopes: SkillScope[] = preferredScope
      ? [preferredScope]
      : ['workspace', 'global'];
    for (const sc of scopes) {
      const found = this.#scanScope(sc).find(s => s.slug === normalizedSlug);
      if (found) return found;
    }
    return undefined;
  }

  saveSkill(input: CustomSkillUpsertInput): {
    readonly action: 'created' | 'updated';
    readonly skill: CustomSkillDetail;
  } {
    const slug = input.slug.trim();
    if (!isValidSkillSlug(slug)) {
      throw Error('SKILL_SLUG_INVALID');
    }
    const rawName = typeof input.name === 'string' ? scrubSensitiveText(input.name.trim()).text : '';
    const rawDisplay = typeof input.displayName === 'string' ? scrubSensitiveText(input.displayName.trim()).text : '';
    // 技能正式 name 必须严格为英文 kebab-case（默认等于 slug）；中文可读标题归入 displayName
    const name = isValidSkillSlug(rawName) ? rawName : slug;
    const displayName = rawDisplay || (!isValidSkillSlug(rawName) && rawName ? rawName : undefined);
    const description = scrubSensitiveText(input.description.trim()).text;
    const instructions = scrubSensitiveText(input.instructions.trim()).text;
    if ((displayName && displayName.length > 80) || !description || description.length > 240) {
      throw Error('SKILL_METADATA_INVALID');
    }
    if (!instructions || instructions.length > MAX_SKILL_INSTRUCTIONS_CHARS) {
      throw Error('SKILL_INSTRUCTIONS_INVALID');
    }
    const triggers = [...new Set((input.triggers ?? []).map(t => scrubSensitiveText(t.trim()).text).filter(Boolean))].slice(0, 10);
    const scope: SkillScope = input.scope === 'global' ? 'global' : 'workspace';
    const rootDir = this.#skillsRoot(scope);
    if (!rootDir) {
      throw Error('SKILL_STORAGE_UNAVAILABLE');
    }
    const skillDir = join(rootDir, slug);
    const skillFile = join(skillDir, 'SKILL.md');
    const existed = existsSync(skillFile);
    mkdirSync(skillDir, { recursive: true });
    const markdown = serializeSkillMarkdown({
      slug,
      name,
      ...(displayName ? { displayName } : {}),
      description,
      triggers,
      instructions,
    });
    writeFileSync(skillFile, markdown, 'utf8');
    const stat = statSync(skillFile);
    const parsedBack = parseFrontmatterSkill(markdown, slug);
    return {
      action: existed ? 'updated' : 'created',
      skill: Object.freeze({
        slug,
        name: parsedBack.name,
        ...(parsedBack.displayName ? { displayName: parsedBack.displayName } : {}),
        description,
        triggers: Object.freeze(triggers),
        instructions: parsedBack.instructions,
        scope,
        updatedAt: Math.trunc(stat.mtimeMs),
      }),
    };
  }

  deleteSkill(slug: string, scope?: SkillScope): { readonly deleted: boolean; readonly slug: string } {
    const normalizedSlug = slug.trim();
    if (!isValidSkillSlug(normalizedSlug)) {
      throw Error('SKILL_SLUG_INVALID');
    }
    const scopes: SkillScope[] = scope ? [scope] : ['workspace', 'global'];
    for (const sc of scopes) {
      const rootDir = this.#skillsRoot(sc);
      if (!rootDir) continue;
      const skillDir = join(rootDir, normalizedSlug);
      const skillFile = join(skillDir, 'SKILL.md');
      if (existsSync(skillFile)) {
        rmSync(skillDir, { recursive: true, force: true });
        return { deleted: true, slug: normalizedSlug };
      }
    }
    return { deleted: false, slug: normalizedSlug };
  }

  /**
   * 渲染注入系统提示词的自定义程序性技能目录（渐进式披露：仅注入摘要，触发时调用 steward_load_custom_skill）。
   */
  renderSkillCatalogSection(): string {
    const skills = this.listSkills('all');
    if (skills.length === 0) return '';
    const lines: string[] = [
      '以下是用户传授并沉淀的自定义办事技能（Procedural Skills）。当用户的诉求或定时复盘匹配某项技能时，请先调用 `steward_load_custom_skill` 读取完整 SOP 步骤再执行；当用户明确教授一套新的固定流程时，遵循底层 `skills-creator` 规范（英文 kebab-case `name`）调用 `steward_save_custom_skill` 将其固化为技能：',
    ];
    let usedBytes = 0;
    for (const skill of skills.slice(0, 20)) {
      const triggerText = skill.triggers.length > 0 ? `（触发词：${skill.triggers.join(' / ')}）` : '';
      const scopeTag = skill.scope === 'global' ? '全局' : '工作区';
      const titleLabel = skill.displayName ? `${skill.name}（${skill.displayName}）` : skill.name;
      const line = `- [${scopeTag} | slug:${skill.slug}] **${titleLabel}**：${skill.description}${triggerText}`;
      const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
      if (usedBytes + lineBytes > MAX_SKILL_CATALOG_BYTES) break;
      lines.push(line);
      usedBytes += lineBytes;
    }
    return lines.length > 1 ? lines.join('\n') : '';
  }
}

export function skillReadToolDefinitions<A extends CallerAgent>(
  authority: CallerAuthority<A>,
  registryProvider: () => DynamicSkillRegistry | undefined,
) {
  return [
    {
      name: SKILL_TOOLS[0],
      description: '列出当前工作区与全局个人层已安装的自定义程序性技能（SKILL.md 摘要目录）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scope: {
            enum: ['workspace', 'global', 'all'],
            description: '筛选作用域：workspace / global / all（默认 all）。',
          },
        },
        required: [],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (rawArgs: unknown, exec: DynamicSkillToolInvocation<A>) => {
        const lease = authority.capture(exec);
        lease.require(SKILL_TOOLS[0], 'read');
        if (!(lease.role === 'router' && lease.foreground) && lease.role !== 'scheduled') {
          throw new CallerDenied('SKILL_READ_DENIED', '只有前台大肥鱼或定时会话可列出自定义技能。');
        }
        const input = asRecord(rawArgs === undefined ? {} : rawArgs);
        const scope = input.scope === undefined ? 'all' : input.scope;
        if (scope !== 'workspace' && scope !== 'global' && scope !== 'all') {
          throw new CallerDenied('INVALID_ARGUMENTS', 'scope 必须是 workspace、global 或 all。');
        }
        const registry = registryProvider();
        const skills = registry ? registry.listSkills(scope) : [];
        return { status: 'ok', total: skills.length, items: skills };
      },
    },
    {
      name: SKILL_TOOLS[1],
      description: '按 slug 加载某项自定义技能（SKILL.md）或底层 skills-creator 元技能的完整执行步骤与规范。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          slug: {
            type: 'string',
            minLength: 2,
            maxLength: 64,
            pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
            description: '技能唯一英文标识 slug（kebab-case，仅限英文小写字母、数字与连字符 -，如 friday-board-audit 或 skills-creator）。',
          },
        },
        required: ['slug'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (rawArgs: unknown, exec: DynamicSkillToolInvocation<A>) => {
        const lease = authority.capture(exec);
        lease.require(SKILL_TOOLS[1], 'read');
        if (!(lease.role === 'router' && lease.foreground) && lease.role !== 'scheduled') {
          throw new CallerDenied('SKILL_READ_DENIED', '只有前台大肥鱼或定时会话可读取自定义技能。');
        }
        const input = asRecord(rawArgs);
        if (typeof input.slug !== 'string' || !isValidSkillSlug(input.slug)) {
          throw new CallerDenied(
            'INVALID_ARGUMENTS',
            '技能 slug 格式无效（必须为英文小写字母、数字与连字符组成的 kebab-case，长度 2~64）。',
          );
        }
        const registry = registryProvider();
        const detail = registry?.loadSkill(input.slug);
        if (!detail) {
          return { status: 'not_found', slug: input.slug };
        }
        return { status: 'ok', skill: detail };
      },
    },
  ];
}

export function skillWriteToolDefinitions<A extends CallerAgent>(
  registryProvider: () => DynamicSkillRegistry | undefined,
  checkForegroundRouter: (exec: DynamicSkillToolInvocation<A>) => { session: string; turn: number },
) {
  return [
    {
      name: SKILL_WRITE_TOOLS[0],
      description:
        '遵循底层 skills-creator 规范，将用户传授的个性化办事流程、周报模板或检查清单保存为可复用的自定义技能（写入 .dsh/skills/<slug>/SKILL.md）。注意：技能 name 与 slug 必须为英文 kebab-case 格式（如 friday-board-audit），严禁在 frontmatter name 中使用中文。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          slug: {
            type: 'string',
            minLength: 2,
            maxLength: 64,
            pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
            description:
              '技能英文唯一名称与目录标识（必填，严格遵循 kebab-case：仅限英文小写字母 a-z、数字 0-9 与单连字符 -，如 friday-board-audit，严禁使用中文、空格或下划线）。',
          },
          name: {
            type: 'string',
            minLength: 2,
            maxLength: 64,
            pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
            description:
              '技能英文名称（写入 SKILL.md frontmatter 的 name 字段，必须与 slug 一致为英文 kebab-case，如 friday-board-audit；严禁填中文，中文名称请填在 displayName）。',
          },
          displayName: {
            type: 'string',
            minLength: 1,
            maxLength: 80,
            description: '可选的技能中文/可读展示名称（如“周五看板盘点”），仅作为 Markdown 正文一级标题，绝不写入 frontmatter name。',
          },
          description: {
            type: 'string',
            minLength: 1,
            maxLength: 240,
            description: '简述该技能何时触发以及解决什么问题（写入 SKILL.md frontmatter 的 description 字段）。',
          },
          instructions: {
            type: 'string',
            minLength: 1,
            maxLength: 8000,
            description: '完整的 Markdown SOP 执行步骤、输出格式或检查清单。',
          },
          triggers: {
            type: 'array',
            items: { type: 'string', minLength: 1, maxLength: 40 },
            maxItems: 10,
            description: '可选触发词列表。',
          },
          scope: {
            enum: ['workspace', 'global'],
            description: '保存作用域：workspace（仅当前项目有效，默认）或 global（跨所有工作区通用）。',
          },
        },
        required: ['slug', 'description', 'instructions'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (rawArgs: unknown, exec: DynamicSkillToolInvocation<A>) => {
        checkForegroundRouter(exec);
        const input = asRecord(rawArgs);
        if (
          Object.keys(input).some(
            k => !['slug', 'name', 'displayName', 'description', 'instructions', 'triggers', 'scope'].includes(k),
          )
        ) {
          throw new CallerDenied('INVALID_ARGUMENTS', '工具参数包含未支持字段。');
        }
        if (typeof input.slug !== 'string' || !isValidSkillSlug(input.slug)) {
          throw new CallerDenied(
            'INVALID_ARGUMENTS',
            '技能 slug 格式无效（宿主仅支持英文小写字母 a-z、数字 0-9 与连字符 - 组成的 kebab-case，长度 2~64，如 friday-board-audit）。',
          );
        }
        if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80)) {
          throw new CallerDenied('INVALID_ARGUMENTS', '技能名称不能为空且不超过 80 字。');
        }
        if (
          input.displayName !== undefined &&
          (typeof input.displayName !== 'string' || !input.displayName.trim() || input.displayName.trim().length > 80)
        ) {
          throw new CallerDenied('INVALID_ARGUMENTS', 'displayName 不能为空且不超过 80 字。');
        }
        if (typeof input.description !== 'string' || !input.description.trim() || input.description.trim().length > 240) {
          throw new CallerDenied('INVALID_ARGUMENTS', '技能描述不能为空且不超过 240 字。');
        }
        if (
          typeof input.instructions !== 'string' ||
          !input.instructions.trim() ||
          input.instructions.trim().length > MAX_SKILL_INSTRUCTIONS_CHARS
        ) {
          throw new CallerDenied('INVALID_ARGUMENTS', '技能正文不能为空且不超过 8000 字。');
        }
        let triggers: string[] | undefined;
        if (input.triggers !== undefined) {
          if (
            !Array.isArray(input.triggers) ||
            input.triggers.length > 10 ||
            input.triggers.some(t => typeof t !== 'string' || !t.trim() || t.trim().length > 40)
          ) {
            throw new CallerDenied('INVALID_ARGUMENTS', '触发词列表无效。');
          }
          triggers = input.triggers.map(t => (t as string).trim());
        }
        if (input.scope !== undefined && input.scope !== 'workspace' && input.scope !== 'global') {
          throw new CallerDenied('INVALID_ARGUMENTS', 'scope 必须是 workspace 或 global。');
        }
        const registry = registryProvider();
        if (!registry) {
          throw new CallerDenied('SKILL_STORAGE_UNAVAILABLE', '当前工作区未挂载技能存储目录。');
        }
        const saved = registry.saveSkill({
          slug: input.slug,
          ...(typeof input.name === 'string' ? { name: input.name } : {}),
          ...(typeof input.displayName === 'string' ? { displayName: input.displayName } : {}),
          description: input.description,
          instructions: input.instructions,
          ...(triggers ? { triggers } : {}),
          ...(input.scope === 'workspace' || input.scope === 'global' ? { scope: input.scope } : {}),
        });
        return { status: 'ok', action: saved.action, skill: saved.skill };
      },
    },
  ];
}
