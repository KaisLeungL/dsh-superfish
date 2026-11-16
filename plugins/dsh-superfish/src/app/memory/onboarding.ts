import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  DEFAULT_BOT_NAME,
  type ChatSoulConfig,
  type OnboardingDiscoverySummary,
  type OnboardingMemoryCandidate,
  type OnboardingMemoryOptions,
} from '../health/chat-input.js';
import { AUTO_MEMORY_MIRROR_HEADER, AUTO_SOUL_HEADER, truncateUtf8Safe } from '../../prompts/soul.js';
import type { CapturedTask } from '../projections/types.js';
import type { PublicTodo } from '../personal/service.js';
import type { MemoryService, MemoryUpsertInput } from './service.js';

export interface OnboardingSessionBrief {
  readonly title: string;
  readonly workspaceTitle?: string | null;
  readonly status?: string;
  readonly turnCount?: number;
  readonly lastUserMessage?: string | null;
}

export interface OnboardingProjectBrief {
  readonly path: string;
  readonly name?: string;
}

export interface OnboardingDiscoveryContext {
  readonly workspacePath: string;
  readonly workspaceName?: string;
  readonly projects?: readonly OnboardingProjectBrief[];
  readonly dshHome?: string;
  readonly tasks?: readonly CapturedTask[];
  readonly todos?: readonly PublicTodo[];
  readonly recentSessions?: readonly OnboardingSessionBrief[];
}

function readSafeFile(absPath: string, maxBytes = 6144): string | undefined {
  try {
    const info = statSync(absPath);
    if (!info.isFile() || info.size <= 0) return undefined;
    const raw = readFileSync(absPath, 'utf8');
    if (raw.startsWith(AUTO_MEMORY_MIRROR_HEADER) || raw.startsWith(AUTO_SOUL_HEADER)) return undefined;
    const text = truncateUtf8Safe(raw, maxBytes).trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

function extractMarkdownHighlights(content: string, maxItems = 4): string[] {
  const results: string[] = [];
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('<!--') || line.startsWith('```')) continue;
    const bullet = line.replace(/^(?:[-*+]|\d+\.)\s+/u, '').replace(/^#+\s+/u, '').trim();
    if (bullet.length >= 6 && bullet.length <= 120 && !results.includes(bullet)) {
      results.push(bullet);
      if (results.length >= maxItems) break;
    }
  }
  return results;
}

function discoverRuleDocs(
  workspacePath: string,
  dshHome: string,
  projects?: readonly OnboardingProjectBrief[],
): {
  readonly foundFiles: readonly { label: string; content: string; highlights: readonly string[] }[];
  readonly projectFallbacks: readonly { name: string; description: string }[];
} {
  const projectDirs: { path: string; label: string }[] = [];
  const seenPaths = new Set<string>();
  const rawProjects = projects && projects.length > 0 ? projects : [{ path: workspacePath }];
  for (const item of rawProjects) {
    if (!item.path?.trim()) continue;
    const abs = resolve(item.path);
    if (seenPaths.has(abs)) continue;
    seenPaths.add(abs);
    projectDirs.push({ path: abs, label: item.name?.trim() || basename(abs) });
  }
  if (projectDirs.length === 0) {
    const abs = resolve(workspacePath);
    projectDirs.push({ path: abs, label: basename(abs) });
  }

  const candidates: { label: string; path: string }[] = [
    { label: '全局 ~/.dsh/AGENTS.md', path: join(dshHome, 'AGENTS.md') },
    { label: '全局 ~/.dsh/CLAUDE.md', path: join(dshHome, 'CLAUDE.md') },
    { label: '全局 ~/.dsh/MEMORY.md', path: join(dshHome, 'MEMORY.md') },
    { label: '全局 ~/.agents/AGENTS.md', path: join(homedir(), '.agents', 'AGENTS.md') },
  ];
  const multiProject = projectDirs.length > 1;
  for (const proj of projectDirs) {
    const prefix = multiProject ? `项目「${proj.label}」` : '工作空间 ';
    candidates.push(
      { label: `${prefix}AGENTS.md`, path: join(proj.path, 'AGENTS.md') },
      { label: `${prefix}CLAUDE.md`, path: join(proj.path, 'CLAUDE.md') },
      { label: `${prefix}MEMORY.md`, path: join(proj.path, 'MEMORY.md') },
      { label: `${prefix}.dsh/AGENTS.md`, path: join(proj.path, '.dsh', 'AGENTS.md') },
    );
  }

  const foundFiles: { label: string; content: string; highlights: readonly string[] }[] = [];
  for (const item of candidates) {
    const content = readSafeFile(item.path, 4096);
    if (!content) continue;
    foundFiles.push({
      label: item.label,
      content,
      highlights: extractMarkdownHighlights(content, 4),
    });
  }

  const projectFallbacks: { name: string; description: string }[] = [];
  for (const proj of projectDirs.slice(0, 5)) {
    const pkgRaw = readSafeFile(join(proj.path, 'package.json'), 4096);
    const readmeRaw = readSafeFile(join(proj.path, 'README.md'), 2048);
    if (!pkgRaw && !readmeRaw) continue;
    let pkgName = proj.label;
    let pkgDesc = '';
    if (pkgRaw) {
      try {
        const parsed = JSON.parse(pkgRaw) as { name?: string; description?: string; packageManager?: string };
        if (typeof parsed.name === 'string' && parsed.name.trim()) pkgName = parsed.name.trim();
        if (typeof parsed.description === 'string' && parsed.description.trim()) pkgDesc = parsed.description.trim();
        else if (typeof parsed.packageManager === 'string') pkgDesc = `使用 ${parsed.packageManager} 管理的工程项目`;
      } catch {
        // ignore invalid package.json
      }
    }
    if (!pkgDesc && readmeRaw) {
      const readmeHighlights = extractMarkdownHighlights(readmeRaw, 2);
      pkgDesc = readmeHighlights.join('；');
    }
    if (pkgName || pkgDesc) {
      projectFallbacks.push({
        name: pkgName,
        description: pkgDesc || `已接入工程项目（目录 ${basename(proj.path)}）`,
      });
    }
  }

  return { foundFiles, projectFallbacks };
}

export function discoverDshOnboardingMemory(context: OnboardingDiscoveryContext): OnboardingDiscoverySummary {
  const workspacePath = resolve(context.workspacePath);
  const dshHome = resolve(context.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'));

  // 1. Rules & Markdown Memory discovery
  const { foundFiles, projectFallbacks } = discoverRuleDocs(workspacePath, dshHome, context.projects);
  const ruleItems: string[] = [];
  for (const file of foundFiles) {
    const preview = file.highlights[0] ? `：${file.highlights[0]}` : '';
    ruleItems.push(`${file.label}${preview}`.slice(0, 90));
  }
  for (const fb of projectFallbacks) {
    if (ruleItems.length >= 3) break;
    ruleItems.push(`项目工程基线：${fb.name}（${fb.description.slice(0, 60)}）`);
  }
  const rulesCandidate: OnboardingMemoryCandidate = {
    id: 'rules',
    title: 'DSH 规则与项目记忆文档',
    badge: foundFiles.length > 0 ? `已探测到 ${foundFiles.length} 份文档` : '全局与项目上下文',
    summary:
      foundFiles.length > 0
        ? `已发现 ${foundFiles.map(f => f.label).join('、')}，包含开发规范与项目约定。`
        : '提取全局工作空间与已接入项目的工程结构、包管理规范与 README 核心背景。',
    count: Math.max(1, foundFiles.length + projectFallbacks.length),
    items: ruleItems.length > 0 ? ruleItems.slice(0, 3) : ['全局工作空间与已接入项目基础工程上下文'],
  };

  // 2. Recent DSH Sessions & Behavioral Profile discovery
  const sessions = (context.recentSessions ?? []).filter(s => s.title?.trim());
  const sessionItems: string[] = [];
  for (const s of sessions.slice(0, 3)) {
    const turns = s.turnCount ? `（${s.turnCount} 轮）` : '';
    sessionItems.push(`近期会话：${s.title.trim()}${turns}`.slice(0, 80));
  }
  if (sessionItems.length === 0) {
    sessionItems.push('全局工作空间跨项目协作（沉淀技术栈偏好与高频指令习惯）');
  }
  const sessionsCandidate: OnboardingMemoryCandidate = {
    id: 'sessions',
    title: '近期会话画像与行为习惯',
    badge: sessions.length > 0 ? `${sessions.length} 个近期会话` : '全局行为画像',
    summary:
      sessions.length > 0
        ? `从近期 ${sessions.length} 个活跃 DSH 会话中提炼你的关注模块、提问风格与未闭环事项。`
        : '结合全局工作空间跨项目活动建立你的初始开发者画像与日常协作偏好。',
    count: Math.max(1, sessions.length),
    items: sessionItems,
  };

  // 3. TaskBoard & Personal Todos Baseline discovery
  const activeTasks = (context.tasks ?? []).filter(t => t.archivedAt === null && !t.hidden && t.status !== 'done');
  const pendingTodos = (context.todos ?? []).filter(t => !t.done);
  const boardItems: string[] = [];
  for (const task of activeTasks.slice(0, 2)) {
    boardItems.push(`看板任务 [${task.status}]：${task.title.trim()}`.slice(0, 80));
  }
  for (const todo of pendingTodos.slice(0, 2)) {
    boardItems.push(`待办事项 (${todo.localDate})：${todo.title.trim()}`.slice(0, 80));
  }
  if (boardItems.length === 0) {
    boardItems.push('全局工作空间跨项目看板与个人待办基线快照');
  }
  const totalBoardCount = activeTasks.length + pendingTodos.length;
  const boardCandidate: OnboardingMemoryCandidate = {
    id: 'board',
    title: '看板在途任务与待办基线',
    badge: totalBoardCount > 0 ? `${totalBoardCount} 项在途事项` : '看板基线就绪',
    summary:
      totalBoardCount > 0
        ? `同步当前 ${activeTasks.length} 张活跃看板卡与 ${pendingTodos.length} 条待办事项作为初始项目记忆。`
        : '记录全局工作空间跨项目任务看板与待办初始基线，便于后续盘点与每日复盘对比。',
    count: Math.max(1, totalBoardCount),
    items: boardItems.slice(0, 3),
  };

  return Object.freeze({
    workspacePath,
    sources: Object.freeze([rulesCandidate, sessionsCandidate, boardCandidate]),
  });
}

export function importDshOnboardingMemory(
  memoryService: Pick<MemoryService, 'saveMemory'>,
  context: OnboardingDiscoveryContext,
  options: OnboardingMemoryOptions | undefined,
  soul?: ChatSoulConfig,
): number {
  let importedCount = 0;
  const workspacePath = resolve(context.workspacePath);
  const dshHome = resolve(context.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'));
  const entries: MemoryUpsertInput[] = [];

  // 始终将用户在引导中配置的 Soul 称呼与协作偏好写入核心画像记忆
  if (soul) {
    const botName = soul.botName?.trim() || DEFAULT_BOT_NAME;
    const profileParts: string[] = [];
    profileParts.push(`主理专属名字设定为「${botName}」。`);
    if (soul.userName?.trim()) {
      profileParts.push(`用户偏好的称呼为「${soul.userName.trim()}」。`);
    }
    profileParts.push(`期望${botName}的沟通基调：${soul.prompt.trim()}`);
    if (soul.traits && soul.traits.length > 0) {
      profileParts.push(`选定的协作特征标签：${soul.traits.join('、')}。`);
    }
    entries.push({
      category: 'profile',
      title: '用户称呼与协作风格偏好',
      content: profileParts.join(' ').slice(0, 1500),
      tags: ['onboard', 'soul', 'profile'],
      pinned: true,
      importance: 5,
    });
  }

  const selected = new Set(options?.sources ?? []);

  if (selected.has('rules')) {
    const { foundFiles, projectFallbacks } = discoverRuleDocs(workspacePath, dshHome, context.projects);
    for (const file of foundFiles.slice(0, 3)) {
      const highlights = file.highlights.length > 0 ? file.highlights.join('；') : file.content.slice(0, 600);
      entries.push({
        category: 'preference',
        title: `DSH 规则记忆：${file.label}`,
        content: `从 ${file.label} 导入的工程规范与偏好要点：${highlights}`.slice(0, 1800),
        tags: ['onboard', 'dsh-rules'],
        pinned: true,
        importance: 4,
      });
    }
    for (const fb of projectFallbacks.slice(0, 3)) {
      entries.push({
        category: 'project',
        title: `已接入项目背景：${fb.name}`,
        content: `工作空间已接入项目「${fb.name}」：${fb.description}`.slice(0, 1800),
        tags: ['onboard', 'project-baseline'],
        pinned: true,
        importance: 4,
      });
    }
  }

  if (selected.has('sessions')) {
    const sessions = (context.recentSessions ?? []).filter(s => s.title?.trim());
    if (sessions.length > 0) {
      const topics = sessions
        .slice(0, 5)
        .map(s => `「${s.title.trim()}」${s.lastUserMessage ? `（近期关注：${s.lastUserMessage.slice(0, 60)}）` : ''}`)
        .join('；');
      entries.push({
        category: 'profile',
        title: '近期 DSH 会话关注焦点与行为习惯',
        content: `用户在全局工作空间近期活跃会话主题包括：${topics}。日常沟通中倾向于围绕这些模块跟进未闭环事项与优先级建议。`.slice(0, 1800),
        tags: ['onboard', 'session-habits'],
        pinned: true,
        importance: 4,
      });
    } else {
      entries.push({
        category: 'profile',
        title: '工作空间日常开发与协作画像',
        content: '用户在全局工作空间跨项目进行研发与任务协同，关注代码质量、待办闭环与跨会话进度梳理。',
        tags: ['onboard', 'session-habits'],
        pinned: true,
        importance: 3,
      });
    }
  }

  if (selected.has('board')) {
    const activeTasks = (context.tasks ?? []).filter(t => t.archivedAt === null && !t.hidden && t.status !== 'done');
    const pendingTodos = (context.todos ?? []).filter(t => !t.done);
    const summaryParts: string[] = [];
    if (activeTasks.length > 0) {
      summaryParts.push(
        `看板在途任务（共 ${activeTasks.length} 项）：` +
          activeTasks
            .slice(0, 5)
            .map(t => `[${t.status}] ${t.title.trim()}`)
            .join('；'),
      );
    }
    if (pendingTodos.length > 0) {
      summaryParts.push(
        `未完成个人待办（共 ${pendingTodos.length} 项）：` +
          pendingTodos
            .slice(0, 5)
            .map(t => `${t.title.trim()} (${t.localDate})`)
            .join('；'),
      );
    }
    if (summaryParts.length > 0) {
      entries.push({
        category: 'project',
        title: '初始化看板与待办基线快照',
        content: summaryParts.join('。').slice(0, 1800),
        tags: ['onboard', 'board-baseline'],
        pinned: true,
        importance: 4,
      });
    }
  }

  const customNote = options?.customNote?.trim();
  if (customNote) {
    entries.push({
      category: 'preference',
      title: '用户初始化补充记忆与习惯要求',
      content: customNote.slice(0, 1800),
      tags: ['onboard', 'user-note'],
      pinned: true,
      importance: 5,
    });
  }

  for (const entry of entries) {
    try {
      memoryService.saveMemory(null, entry);
      importedCount++;
    } catch {
      // 单条记忆超出容量或校验不中断整体引导流程
    }
  }
  return importedCount;
}
