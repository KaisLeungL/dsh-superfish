export type ChatModelSelection = { provider: string; model: string; reasoningEffort?: string };
export type ChatSoulPreset = 'efficient' | 'warm' | 'direct' | 'geek';
export type ChatSoulTraitId =
  | 'conclusion-first'
  | 'proactive-memory'
  | 'code-rigor'
  | 'blunt-risk'
  | 'emoji-vibe'
  | 'step-breakdown';
export type OnboardingMemorySourceId = 'rules' | 'sessions' | 'board';
export type OnboardingMemoryOptions = {
  sources: readonly OnboardingMemorySourceId[];
  customNote?: string;
};
export type OnboardingMemoryCandidate = {
  readonly id: OnboardingMemorySourceId;
  readonly title: string;
  readonly badge: string;
  readonly summary: string;
  readonly count: number;
  readonly items: readonly string[];
};
export type OnboardingDiscoverySummary = {
  readonly workspacePath: string;
  readonly sources: readonly OnboardingMemoryCandidate[];
};
export type ChatSuggestionIcon = 'clock' | 'check' | 'route' | 'board' | 'calendar' | 'edit' | 'link';
export type ChatSuggestionItem = {
  readonly id: string;
  readonly label: string;
  readonly icon: ChatSuggestionIcon;
  readonly prompt: string;
  readonly primary?: boolean;
};
export type ChatSuggestionsPayload = {
  readonly dailyReviewConfigured: boolean;
  readonly items: readonly ChatSuggestionItem[];
};
export const DEFAULT_BOT_NAME = '大肥鱼';
export const MAX_AVATAR_DATA_URL_LENGTH = 2 * 1024 * 1024;
export type ChatSoulConfig = {
  preset: ChatSoulPreset;
  botName?: string;
  userName?: string;
  avatarDataUrl?: string;
  prompt: string;
  traits?: readonly ChatSoulTraitId[];
  traitsMarkdown?: string;
  traitOverrides?: Partial<Record<ChatSoulTraitId, string>>;
  syncSoulMarkdown?: boolean;
};
export type DailyMotto = { day: string; text: string };
export function localMottoDay(date = new Date()): string {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].map(part => String(part).padStart(2, '0')).join('-');
}
export const DEFAULT_CHAT_MODEL = Object.freeze({
  provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high',
});
export const SOUL_PRESETS: readonly { readonly id: ChatSoulPreset; readonly title: string; readonly subtitle: string; readonly prompt: string }[] = Object.freeze([
  {
    id: 'efficient',
    title: '干练主理',
    subtitle: '结论先行 · 结构化清单',
    prompt: [
      '角色定位：高效干练的工作区主理搭档，专注帮我把控全局进度与每日优先级。',
      '沟通风格：结论先行，直接给出核心判断与结构化行动清单，省去寒暄铺垫与空洞套话。',
      '盘点与复盘：梳理个人待办、看板任务与近期会话时，重点标出逾期风险、阻塞项和下一步最小可执行动作。',
      '记忆与协作：主动结合我的长期记忆与工程习惯给出建议，跨会话保持上下文连贯。',
    ].join('\n\n'),
  },
  {
    id: 'warm',
    title: '温和管家',
    subtitle: '贴心陪伴 · 循序渐进',
    prompt: [
      '角色定位：温和有条理的工作区贴心管家，像熟悉我节奏的靠谱伙伴。',
      '沟通风格：语气自然松弛、有陪伴感，适度使用 Emoji 增强表达，拒绝冷冰冰的机械 AI 腔。',
      '盘点与复盘：面对繁杂待办与多线会话时，先帮我理清主次、缓解压力，再拆解出轻量无负担的第一步。',
      '记忆与协作：细心记住我的作息节奏、偏好与近期关注点，循序渐进协助推进目标闭环。',
    ].join('\n\n'),
  },
  {
    id: 'direct',
    title: '直球督促',
    subtitle: '紧盯闭环 · 拒绝拖延',
    prompt: [
      '角色定位：直爽干脆的闭环督促搭档，帮我对抗拖延与注意力分散。',
      '沟通风格：有话直说、不绕弯子，一针见血指出问题核心，用最短篇幅锁定行动。',
      '盘点与复盘：紧盯逾期未完待办、长期停滞的看板卡片与悬而未决的会话，发现偏离主线时直接提醒纠偏。',
      '记忆与协作：记住我设定的核心目标与关键节点，协助砍掉非核心噪音，确保每日重点真正闭环。',
    ].join('\n\n'),
  },
  {
    id: 'geek',
    title: '极客搭档',
    subtitle: '技术语境 · 精准克制',
    prompt: [
      '角色定位：硬核务实的极客研发搭档，深度对齐代码仓库与工程上下文。',
      '沟通风格：使用精准克制的技术语境沟通，聚焦架构约束、代码事实与可验证结论，言简意赅。',
      '盘点与复盘：串联研发会话、看板任务与技术决策，清晰呈现改动脉络、潜在技术债与验证步骤。',
      '记忆与协作：主动沉淀项目架构规范、踩坑记录与技术偏好到长期记忆，严守只读与安全边界。',
    ].join('\n\n'),
  },
]);
const LEGACY_SOUL_PROMPTS = new Set([
  '回复直接给结论与优先级清单，减少寒暄铺垫；盘点待办与会话时突出阻塞项和下一步动作。',
  '语气温和有条理，像贴心的工作区管家；在梳理繁杂任务时先缓解压力，再给出轻量可执行的第一步。',
  '风格直爽干脆，重点关注逾期与未闭环事项；发现任务停滞时直接提醒并协助拆解可落地的闭环动作。',
  '使用精准的工程与技术语境沟通，聚焦代码仓库、架构上下文与可验证事实，言简意赅。',
  ...SOUL_PRESETS.map(item => item.prompt.replace(/\n\n/g, '\n')),
]);
export function resolveSoulPresetPrompt(preset: ChatSoulPreset, prompt?: string): string {
  const trimmed = prompt?.trim();
  if (trimmed && !LEGACY_SOUL_PROMPTS.has(trimmed)) return trimmed;
  return (SOUL_PRESETS.find(item => item.id === preset) ?? SOUL_PRESETS[0]!).prompt;
}
export const SOUL_TRAITS: readonly { readonly id: ChatSoulTraitId; readonly label: string; readonly instruction: string }[] = Object.freeze([
  {
    id: 'conclusion-first',
    label: '结论先行',
    instruction: '每次回复先给核心结论或行动清单，再补充必要依据，杜绝冗长铺垫。',
  },
  {
    id: 'proactive-memory',
    label: '主动记偏好',
    instruction: '在对话中敏锐捕捉用户的长期偏好、项目背景与关键决策，主动调用长期记忆工具沉淀与检索。',
  },
  {
    id: 'code-rigor',
    label: '严守工程规范',
    instruction: '涉及技术方案与代码问题时保持极客严谨，尊重仓库现有架构约束与可验证事实。',
  },
  {
    id: 'blunt-risk',
    label: '直言指出风险',
    instruction: '发现任务逾期、逻辑漏洞或阻塞风险时直言不讳，直接给出纠偏建议。',
  },
  {
    id: 'emoji-vibe',
    label: '适度幽默带 Emoji',
    instruction: '语气自然松弛、有搭档感，恰当使用少量 Emoji 增强可读性与情绪价值，拒绝机械 AI 腔。',
  },
  {
    id: 'step-breakdown',
    label: '自动拆解小步',
    instruction: '面对复杂模糊的目标时，自动拆解为 2~4 个可立即落地的最小闭环步骤。',
  },
]);
export const DEFAULT_SOUL_TRAITS: readonly ChatSoulTraitId[] = Object.freeze([
  'conclusion-first',
  'proactive-memory',
  'emoji-vibe',
]);
export function resolveSoulTraitInstruction(
  id: ChatSoulTraitId,
  overrides?: Partial<Record<ChatSoulTraitId, string>>,
): string {
  const custom = overrides?.[id]?.trim();
  if (custom) return custom;
  return SOUL_TRAITS.find(t => t.id === id)?.instruction ?? '';
}
export function normalizeTraitOverrides(
  overrides: Partial<Record<ChatSoulTraitId, string>> | undefined,
): Partial<Record<ChatSoulTraitId, string>> | undefined {
  if (!overrides) return undefined;
  const result: Partial<Record<ChatSoulTraitId, string>> = {};
  for (const trait of SOUL_TRAITS) {
    const raw = overrides[trait.id];
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed && trimmed !== trait.instruction) {
      result[trait.id] = trimmed;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
export function buildDefaultTraitsMarkdown(
  traits: readonly ChatSoulTraitId[] | undefined,
  overrides?: Partial<Record<ChatSoulTraitId, string>>,
): string {
  return (traits ?? [])
    .map(id => SOUL_TRAITS.find(t => t.id === id))
    .filter((t): t is NonNullable<typeof t> => !!t)
    .map(t => `- **${t.label}**：${resolveSoulTraitInstruction(t.id, overrides)}`)
    .join('\n');
}
export function resolveSoulTraitsMarkdown(
  soul: Pick<ChatSoulConfig, 'traits' | 'traitsMarkdown' | 'traitOverrides'>,
): string {
  if (typeof soul.traitsMarkdown === 'string') {
    return soul.traitsMarkdown.trim();
  }
  return buildDefaultTraitsMarkdown(soul.traits, soul.traitOverrides);
}
export function syncTraitToggleInMarkdown(
  currentMarkdown: string,
  traitId: ChatSoulTraitId,
  prevTraits: readonly ChatSoulTraitId[],
  nextTraits: readonly ChatSoulTraitId[],
): string {
  const prevDefault = buildDefaultTraitsMarkdown(prevTraits).trim();
  const trimmed = currentMarkdown.trim();
  if (!trimmed || trimmed === prevDefault) {
    return buildDefaultTraitsMarkdown(nextTraits);
  }
  const trait = SOUL_TRAITS.find(t => t.id === traitId);
  if (!trait) return currentMarkdown;
  const escapedLabel = trait.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lineRegex = new RegExp(`^\\s*[-*+]?\\s*(?:\\*\\*)?${escapedLabel}(?:\\*\\*)?\\s*[：:].*$`, 'm');
  const isNowSelected = nextTraits.includes(traitId);
  if (isNowSelected) {
    if (lineRegex.test(trimmed)) return currentMarkdown;
    return `${trimmed}\n- **${trait.label}**：${trait.instruction}`;
  }
  const filteredLines = currentMarkdown
    .split('\n')
    .filter(line => !lineRegex.test(line.trim()));
  return filteredLines.join('\n').trim();
}
export const DEFAULT_CHAT_SOUL: ChatSoulConfig = Object.freeze({
  preset: 'efficient',
  prompt: SOUL_PRESETS[0]!.prompt,
  traits: DEFAULT_SOUL_TRAITS,
  syncSoulMarkdown: true,
});
export type ChatContent =
  | { type: 'text'; text: string }
  | { type: 'file'; receiptId: string }
  | { type: 'image'; mediaType: string; data: string; name?: string };

export function nativeChatModel(provider: string): boolean {
  return !!provider && !/^acp(?:[-:]|$)/i.test(provider);
}

export function readChatModel(value: unknown): ChatModelSelection | undefined {
  if (!value || typeof value !== 'object') return;
  const { provider, model, reasoningEffort } = value as Record<string, unknown>;
  if (typeof provider !== 'string' || !provider.trim() || provider.length > 256 ||
      typeof model !== 'string' || !model.trim() || model.length > 256 ||
      (reasoningEffort !== undefined && (typeof reasoningEffort !== 'string' || !reasoningEffort.trim() || reasoningEffort.length > 64))) return;
  return { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) };
}

export function readChatSoul(value: unknown): ChatSoulConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some(key => !['preset', 'botName', 'userName', 'avatarDataUrl', 'prompt', 'traits', 'traitsMarkdown', 'traitOverrides', 'syncSoulMarkdown'].includes(key))) return;
  const { preset, botName, userName, avatarDataUrl, prompt, traits, traitsMarkdown, traitOverrides, syncSoulMarkdown } = record;
  if (typeof preset !== 'string' || !SOUL_PRESETS.some(item => item.id === preset)) return;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 1200) return;
  if (botName !== undefined && (typeof botName !== 'string' || botName.length > 32)) return;
  if (userName !== undefined && (typeof userName !== 'string' || userName.length > 64)) return;
  if (avatarDataUrl !== undefined) {
    if (typeof avatarDataUrl !== 'string' || avatarDataUrl.length > MAX_AVATAR_DATA_URL_LENGTH) return;
    const trimmedUrl = avatarDataUrl.trim();
    if (trimmedUrl && !/^data:image\/(?:png|jpeg|jpg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=\s]+$/i.test(trimmedUrl)) return;
  }
  if (syncSoulMarkdown !== undefined && typeof syncSoulMarkdown !== 'boolean') return;
  if (traitsMarkdown !== undefined && (typeof traitsMarkdown !== 'string' || traitsMarkdown.length > 2000)) return;
  const validIds = new Set<string>(SOUL_TRAITS.map(item => item.id));
  let normalizedTraits: ChatSoulTraitId[] | undefined;
  if (traits !== undefined) {
    if (!Array.isArray(traits) || traits.length > 12) return;
    if (traits.some(item => typeof item !== 'string' || !validIds.has(item))) return;
    normalizedTraits = [...new Set(traits as ChatSoulTraitId[])];
  }
  let normalizedOverrides: Partial<Record<ChatSoulTraitId, string>> | undefined;
  if (traitOverrides !== undefined) {
    if (!traitOverrides || typeof traitOverrides !== 'object' || Array.isArray(traitOverrides)) return;
    const overrideRecord = traitOverrides as Record<string, unknown>;
    const overrideKeys = Object.keys(overrideRecord);
    if (overrideKeys.length > 12) return;
    for (const k of overrideKeys) {
      if (!validIds.has(k)) return;
      const v = overrideRecord[k];
      if (v !== undefined && (typeof v !== 'string' || v.length > 300)) return;
    }
    normalizedOverrides = normalizeTraitOverrides(overrideRecord as Partial<Record<ChatSoulTraitId, string>>);
  }
  const trimmedBotName = typeof botName === 'string' ? botName.trim() : '';
  const trimmedName = typeof userName === 'string' ? userName.trim() : '';
  const trimmedAvatar = typeof avatarDataUrl === 'string' ? avatarDataUrl.trim() : '';
  const defaultTraitsMd = buildDefaultTraitsMarkdown(normalizedTraits ?? DEFAULT_SOUL_TRAITS, normalizedOverrides).trim();
  const trimmedTraitsMd = typeof traitsMarkdown === 'string' ? traitsMarkdown.trim() : undefined;
  const effectiveCustomTraitsMd =
    trimmedTraitsMd !== undefined && trimmedTraitsMd !== defaultTraitsMd ? trimmedTraitsMd : undefined;
  return {
    preset: preset as ChatSoulPreset,
    ...(trimmedBotName ? { botName: trimmedBotName } : {}),
    ...(trimmedName ? { userName: trimmedName } : {}),
    ...(trimmedAvatar ? { avatarDataUrl: trimmedAvatar } : {}),
    prompt: prompt.trim(),
    ...(normalizedTraits !== undefined ? { traits: normalizedTraits } : {}),
    ...(effectiveCustomTraitsMd !== undefined ? { traitsMarkdown: effectiveCustomTraitsMd } : {}),
    ...(normalizedOverrides !== undefined ? { traitOverrides: normalizedOverrides } : {}),
    ...(syncSoulMarkdown !== undefined ? { syncSoulMarkdown } : {}),
  };
}

export function readOnboardingMemory(value: unknown): OnboardingMemoryOptions | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some(key => key !== 'sources' && key !== 'customNote')) return;
  const { sources, customNote } = record;
  if (!Array.isArray(sources) || sources.length > 6) return;
  const validSources = new Set<string>(['rules', 'sessions', 'board']);
  if (sources.some(item => typeof item !== 'string' || !validSources.has(item))) return;
  if (customNote !== undefined && (typeof customNote !== 'string' || customNote.length > 1000)) return;
  const trimmedNote = typeof customNote === 'string' ? customNote.trim() : '';
  return {
    sources: [...new Set(sources as OnboardingMemorySourceId[])],
    ...(trimmedNote ? { customNote: trimmedNote } : {}),
  };
}

export function formatSoulPrompt(soul: ChatSoulConfig | undefined): string {
  const active = soul ?? DEFAULT_CHAT_SOUL;
  const presetMeta = SOUL_PRESETS.find(item => item.id === active.preset) ?? SOUL_PRESETS[0]!;
  const resolvedPrompt = resolveSoulPresetPrompt(active.preset, active.prompt);
  const lines = ['【主理人设与沟通偏好（Soul）】'];
  const botName = active.botName?.trim() || DEFAULT_BOT_NAME;
  lines.push(`- 你的专属名字：${botName}（当用户询问你叫什么或自称时，请使用「${botName}」自称）`);
  if (active.userName?.trim()) lines.push(`- 对用户的称呼：${active.userName.trim()}`);
  lines.push(`- 角色基调：${presetMeta.title}（${presetMeta.subtitle}）`);
  lines.push(`- 沟通风格与要求：\n${resolvedPrompt}`);
  const traitsMarkdown = resolveSoulTraitsMarkdown(active);
  if (traitsMarkdown) {
    const traitLines = traitsMarkdown
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const cleaned = line.replace(/^[-*+]\s+/, '').replace(/\*\*(.*?)\*\*/g, '$1');
        return `  * ${cleaned}`;
      });
    if (traitLines.length > 0) {
      lines.push('- 行为特征约定：\n' + traitLines.join('\n'));
    }
  }
  return lines.join('\n');
}

export function renderSoulMarkdownDocument(soul: ChatSoulConfig | undefined): string {
  const active = soul ?? DEFAULT_CHAT_SOUL;
  const presetMeta = SOUL_PRESETS.find(item => item.id === active.preset) ?? SOUL_PRESETS[0]!;
  const botName = active.botName?.trim() || DEFAULT_BOT_NAME;
  const resolvedPrompt = resolveSoulPresetPrompt(active.preset, active.prompt);
  const traitsMarkdown = resolveSoulTraitsMarkdown(active);
  const lines: string[] = [
    `# ${botName} Soul 人设与协作契约 (.dsh/SOUL.md)`,
    '',
    `> 本文件由${botName}初始化引导生成，你可以随时直接编辑本文件以微调${botName}的性格、称呼与协作习惯。`,
    '',
    '## 一、 身份与称呼',
    `- **角色定位**：${botName}（工作区常驻主理搭档 · ${presetMeta.title}）`,
    `- **对用户的称呼**：${active.userName?.trim() || '直接自然称呼（未指定特定昵称）'}`,
    '',
    '## 二、 核心沟通风格',
    resolvedPrompt,
    '',
  ];
  if (traitsMarkdown) {
    lines.push('## 三、 行为准则与偏好特征');
    lines.push(traitsMarkdown);
    lines.push('');
  }
  return lines.join('\n');
}

export function readChatContent(value: unknown): ChatContent[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) return;
  const content: ChatContent[] = [];
  for (const part of value) {
    if (!part || typeof part !== 'object') return;
    if (part.type === 'text' && typeof part.text === 'string' && part.text.length <= 6000) {
      content.push({ type: 'text', text: part.text });
    } else if (part.type === 'file' && typeof part.receiptId === 'string' && part.receiptId.length > 0 && part.receiptId.length <= 256) {
      content.push({ type: 'file', receiptId: part.receiptId });
    } else if (part.type === 'image' && typeof part.mediaType === 'string' && /^image\/(?:png|jpeg|gif|webp)$/.test(part.mediaType) &&
        typeof part.data === 'string' && part.data.length > 0 &&
        (part.name === undefined || (typeof part.name === 'string' && part.name.length <= 512))) {
      content.push({ type: 'image', mediaType: part.mediaType, data: part.data, ...(part.name === undefined ? {} : { name: part.name }) });
    } else return;
  }
  if (content.some(part => part.type !== 'text' || part.text.trim())) return content;
}
