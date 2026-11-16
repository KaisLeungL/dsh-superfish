import type { MemoryCategory, MemoryScope, MemoryService, PublicMemoryItem } from './service.js';
import { scrubSensitiveText } from '../sentinel/scrubber.js';

export interface ConsolidatableSessionSummary {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly turnCount: number;
  readonly updatedAt: number;
  readonly workspacePath?: string;
  readonly lastUserSummary?: string;
  readonly lastAssistantSummary?: string;
}

export interface ConsolidatableSessionTurn {
  readonly turnNumber: number;
  readonly user: {
    readonly text: string;
  };
  readonly assistant?: {
    readonly text: string;
  };
}

export interface ConsolidatableSessionDetail {
  readonly session: ConsolidatableSessionSummary;
  readonly turns: readonly ConsolidatableSessionTurn[];
}

export interface MemoryConsolidatorHost {
  readonly memoryService: MemoryService;
  listSessions(): Promise<readonly ConsolidatableSessionSummary[]>;
  readSession(sessionId: string): Promise<ConsolidatableSessionDetail | undefined>;
}

export interface ConsolidationItemResult {
  readonly sessionId: string;
  readonly action: 'created' | 'updated';
  readonly item: PublicMemoryItem;
}

export interface ConsolidationRunReport {
  readonly scannedSessions: number;
  readonly consolidatedSessions: number;
  readonly memoriesSaved: readonly ConsolidationItemResult[];
}

interface ExtractedCandidate {
  readonly category: MemoryCategory;
  readonly scope: MemoryScope;
  readonly title: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly pinned: boolean;
  readonly importance: number;
}

const PREFERENCE_PATTERNS: readonly RegExp[] = [
  /(?:以后(?:默认|都|请)|请记住|我的偏好是|习惯(?:于|用)|默认使用|always\s+use|prefer\s+to)[^。\n;；]{4,160}/giu,
];

const DECISION_PATTERNS: readonly RegExp[] = [
  /(?:最终决定|决定采用|架构决策|技术选型确定为|方案确定为|统一采用|约定使用|decided\s+to\s+use|architecture\s+decision)[^。\n;；]{4,200}/giu,
];

function truncateClean(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, Math.max(1, maxChars - 1)).trimEnd() + '…';
}

/**
 * 从单个已完成的用户会话轮次中提炼可沉淀的长期记忆候选项（偏好、决策与会话里程碑）。
 */
export function extractSessionMemories(detail: ConsolidatableSessionDetail): readonly ExtractedCandidate[] {
  const candidates: ExtractedCandidate[] = [];
  const seenTitles = new Set<string>();

  const pushCandidate = (candidate: ExtractedCandidate) => {
    const cleanTitle = scrubSensitiveText(candidate.title).text.trim();
    const cleanContent = scrubSensitiveText(candidate.content).text.trim();
    if (!cleanTitle || !cleanContent) return;
    const key = `${candidate.category}:${cleanTitle.toLowerCase()}`;
    if (seenTitles.has(key)) return;
    seenTitles.add(key);
    candidates.push({
      ...candidate,
      title: truncateClean(cleanTitle, 110),
      content: truncateClean(cleanContent, 1800),
    });
  };

  for (const turn of detail.turns) {
    const userText = turn.user?.text ?? '';
    const assistantText = turn.assistant?.text ?? '';

    for (const pattern of PREFERENCE_PATTERNS) {
      for (const match of userText.matchAll(pattern)) {
        const snippet = match[0].trim();
        if (snippet.length >= 6) {
          pushCandidate({
            category: 'preference',
            scope: 'global',
            title: `用户偏好：${truncateClean(snippet, 48)}`,
            content: `${snippet}（提炼自会话「${detail.session.title}」第 ${turn.turnNumber} 轮）`,
            tags: ['auto-consolidated', 'preference'],
            pinned: false,
            importance: 4,
          });
        }
      }
    }

    const combinedText = `${userText}\n${assistantText}`;
    for (const pattern of DECISION_PATTERNS) {
      for (const match of combinedText.matchAll(pattern)) {
        const snippet = match[0].trim();
        if (snippet.length >= 6) {
          pushCandidate({
            category: 'decision',
            scope: 'workspace',
            title: `会话决策：${truncateClean(snippet, 48)}`,
            content: `${snippet}（来源会话：「${detail.session.title}」#${turn.turnNumber}）`,
            tags: ['auto-consolidated', 'decision'],
            pinned: false,
            importance: 4,
          });
        }
      }
    }
  }

  // 若会话已完成且具备至少 2 轮有效问答，生成一条项目归档备忘供跨会话检索
  const lastTurn = detail.turns.at(-1);
  const firstTurn = detail.turns[0];
  if (
    detail.session.status === 'completed' &&
    detail.session.turnCount >= 2 &&
    firstTurn &&
    lastTurn?.assistant?.text
  ) {
    const goalSnippet = truncateClean(firstTurn.user.text, 200);
    const conclusionSnippet = truncateClean(lastTurn.assistant.text, 400);
    if (goalSnippet && conclusionSnippet) {
      pushCandidate({
        category: 'project',
        scope: 'workspace',
        title: `会话复盘：${truncateClean(detail.session.title || goalSnippet, 60)}`,
        content: `初始诉求：${goalSnippet}\n最终结论：${conclusionSnippet}`,
        tags: ['auto-consolidated', 'session-summary'],
        pinned: false,
        importance: 3,
      });
    }
  }

  return Object.freeze(candidates);
}

/**
 * 后台记忆反思与自动提炼服务（Background Memory Consolidation）：
 * 静默巡检已完成的用户会话，将尚未提炼的关键决策、个人偏好与完成复盘归档至 MemoryService。
 */
export class MemoryConsolidator {
  #running = false;

  constructor(private readonly host: MemoryConsolidatorHost) {}

  async consolidate(options: { readonly maxSessions?: number } = {}): Promise<ConsolidationRunReport> {
    if (this.#running) {
      return { scannedSessions: 0, consolidatedSessions: 0, memoriesSaved: Object.freeze([]) };
    }
    this.#running = true;
    try {
      const maxSessions = Math.max(1, Math.min(options.maxSessions ?? 10, 50));
      const allSessions = await this.host.listSessions();
      const eligible = allSessions
        .filter(
          item =>
            (item.status === 'completed' || item.turnCount >= 2) &&
            item.turnCount > this.host.memoryService.getConsolidatedSessionTurnCount(item.id),
        )
        .slice(0, maxSessions);

      const saved: ConsolidationItemResult[] = [];
      let consolidatedCount = 0;

      for (const summary of eligible) {
        const detail = await this.host.readSession(summary.id);
        if (!detail || detail.turns.length === 0) {
          this.host.memoryService.markConsolidatedSession(summary.id, summary.turnCount);
          continue;
        }
        const candidates = extractSessionMemories(detail);
        for (const candidate of candidates) {
          const res = this.host.memoryService.saveMemory(summary.id, {
            category: candidate.category,
            scope: candidate.scope,
            title: candidate.title,
            content: candidate.content,
            tags: candidate.tags,
            pinned: candidate.pinned,
            importance: candidate.importance,
            sourceSessionId: summary.id,
          });
          saved.push(Object.freeze({ sessionId: summary.id, action: res.action, item: res.item }));
        }
        this.host.memoryService.markConsolidatedSession(summary.id, summary.turnCount);
        consolidatedCount++;
      }

      return Object.freeze({
        scannedSessions: eligible.length,
        consolidatedSessions: consolidatedCount,
        memoriesSaved: Object.freeze(saved),
      });
    } finally {
      this.#running = false;
    }
  }
}
