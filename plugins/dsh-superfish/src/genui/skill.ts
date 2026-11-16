import { readFileSync } from 'node:fs';
import { buildGenuiPrompt } from './materials-meta.js';
import type { MaterialsMetaMap } from './core.js';

export const GENUI_SKILL = 'dsh-genui';
export const LOAD_GENUI_SKILL = 'steward_load_genui_skill';
export const RENDER_GENUI_TOOL = 'steward_render_genui';

const packageRoot = new URL(import.meta.url).pathname.endsWith('/skill.ts') ? '../../' : '../';
const skillFile = new URL(packageRoot + 'skills/dsh-genui/SKILL.md', import.meta.url);
const markdown = readFileSync(skillFile, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();

export function renderGenuiSkillContent(extraMeta?: MaterialsMetaMap): string {
  return [markdown, '', buildGenuiPrompt(extraMeta)].join('\n');
}

export const genuiSkill = {
  name: GENUI_SKILL,
  description: '基于 OpenTiny GenUI SDK SchemaJson 协议生成交互式每日早晚报、待办盘点、会话总结与看板可视化面板。',
  source: 'bundled',
  invocation: { modelInvocable: true, userInvocable: false },
  content: renderGenuiSkillContent(),
};
