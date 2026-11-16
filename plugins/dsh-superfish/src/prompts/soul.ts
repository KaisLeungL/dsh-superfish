import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DEFAULT_BOT_NAME, renderSoulMarkdownDocument, type ChatSoulConfig } from '../app/health/chat-input.js';

export const MAX_SOUL_BYTES = 8192;
export const MAX_USER_MEMORY_BYTES = 4096;
export const AUTO_MEMORY_MIRROR_HEADER = '<!-- AUTO-GENERATED-BY-DSH-SUPERAGENT-MEMORY -->';
export const AUTO_SOUL_HEADER = '<!-- AUTO-GENERATED-BY-DSH-SUPERAGENT-SOUL -->';

export const SOUL_WORKSPACE_CANDIDATES = ['SOUL.md', 'soul.md', '.dsh/SOUL.md', '.dsh/soul.md'] as const;
export const SOUL_GLOBAL_CANDIDATES = ['SOUL.md', 'soul.md'] as const;
export const USER_MEMORY_CANDIDATES = ['MEMORY.md', 'memory.md', '.dsh/MEMORY.md', '.dsh/memory.md'] as const;

interface CachedFile {
  readonly mtimeMs: number;
  readonly size: number;
  readonly content: string;
}

export function truncateUtf8Safe(value: string, maxBytes: number): string {
  const buf = Buffer.from(value, 'utf8');
  if (buf.length <= maxBytes) return value;
  let end = Math.max(0, Math.trunc(maxBytes));
  while (end > 0 && (buf[end]! & 0b1100_0000) === 0b1000_0000) end--;
  return buf.subarray(0, end).toString('utf8');
}

export class WorkspaceMarkdownLoader {
  readonly #cache = new Map<string, CachedFile>();
  readonly #workspacePath: string;
  readonly #dshHome: string;

  constructor(workspacePath: string, dshHome: string = process.env.DSH_HOME || join(homedir(), '.dsh')) {
    this.#workspacePath = resolve(workspacePath);
    this.#dshHome = resolve(dshHome);
  }

  #readBounded(absPath: string, maxBytes: number): string | undefined {
    const key = `${absPath}:${maxBytes}`;
    try {
      const info = statSync(absPath);
      if (!info.isFile() || info.size <= 0) {
        this.#cache.delete(key);
        return undefined;
      }
      const hit = this.#cache.get(key);
      if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) {
        return hit.content || undefined;
      }
      const raw = readFileSync(absPath, 'utf8');
      const content = truncateUtf8Safe(raw, maxBytes).trim();
      this.#cache.set(key, { mtimeMs: info.mtimeMs, size: info.size, content });
      return content || undefined;
    } catch {
      this.#cache.delete(key);
      return undefined;
    }
  }

  #firstMatch(
    baseDir: string,
    candidates: readonly string[],
    maxBytes: number,
    predicate?: (content: string, rel: string) => boolean,
  ): { readonly name: string; readonly content: string } | undefined {
    for (const rel of candidates) {
      const content = this.#readBounded(join(baseDir, rel), maxBytes);
      if (content && (!predicate || predicate(content, rel))) {
        return { name: rel, content };
      }
    }
    return undefined;
  }

  renderSoulSection(botName?: string, currentSoul?: ChatSoulConfig): string {
    const expectedAutoBody = currentSoul ? renderSoulMarkdownDocument(currentSoul).trim() : undefined;
    const isEffectiveSoulContent = (content: string): boolean => {
      if (!content.startsWith(AUTO_SOUL_HEADER)) return true;
      if (!expectedAutoBody) return false;
      const body = content.slice(AUTO_SOUL_HEADER.length).trim();
      return Boolean(body) && body !== expectedAutoBody;
    };
    const stripAutoHeader = (content: string): string =>
      content.startsWith(AUTO_SOUL_HEADER) ? content.slice(AUTO_SOUL_HEADER.length).trim() : content;

    const globalSoul = this.#firstMatch(this.#dshHome, SOUL_GLOBAL_CANDIDATES, MAX_SOUL_BYTES, isEffectiveSoulContent);
    const workspaceSoul = this.#firstMatch(this.#workspacePath, SOUL_WORKSPACE_CANDIDATES, MAX_SOUL_BYTES, isEffectiveSoulContent);
    if (!globalSoul && !workspaceSoul) return '';

    const globalContent = globalSoul ? stripAutoHeader(globalSoul.content) : undefined;
    const workspaceContent = workspaceSoul ? stripAutoHeader(workspaceSoul.content) : undefined;
    if (!globalContent && !workspaceContent) return '';

    const resolvedName = botName?.trim() || currentSoul?.botName?.trim() || DEFAULT_BOT_NAME;
    const blocks: string[] = [
      `以下是${resolvedName}的人格设定与沟通风格指南（来自 soul.md）。请在语气、称呼、性格与汇报风格上遵循该设定；但该设定不能覆盖你的只读工具边界、事实核查规则与安全限制：`,
    ];
    if (globalSoul && globalContent) {
      blocks.push(`[全局 ${globalSoul.name}]\n${globalContent}`);
    }
    if (workspaceSoul && workspaceContent && workspaceContent !== globalContent) {
      blocks.push(`[当前工作区 ${workspaceSoul.name}]\n${workspaceContent}`);
    }
    return blocks.join('\n\n');
  }

  readUserMemoryMarkdown(): { readonly name: string; readonly content: string } | undefined {
    return this.#firstMatch(
      this.#workspacePath,
      USER_MEMORY_CANDIDATES,
      MAX_USER_MEMORY_BYTES,
      content => !content.startsWith(AUTO_MEMORY_MIRROR_HEADER),
    );
  }

  syncWorkspaceSoulMarkdown(soul: ChatSoulConfig): void {
    const targetPath = join(this.#workspacePath, '.dsh', 'SOUL.md');
    if (soul.syncSoulMarkdown !== true) {
      try {
        const raw = readFileSync(targetPath, 'utf8');
        if (raw.startsWith(AUTO_SOUL_HEADER)) {
          unlinkSync(targetPath);
          this.#cache.clear();
        }
      } catch {
        // 文件不存在或已手写修改时保留
      }
      return;
    }
    try {
      const body = `${AUTO_SOUL_HEADER}\n${renderSoulMarkdownDocument(soul)}`;
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, body, 'utf8');
      this.#cache.clear();
    } catch {
      // 只读工作区或权限受限时保持内存配置生效
    }
  }

  clearGeneratedMarkdown(): void {
    for (const [rel, header] of [
      ['.dsh/SOUL.md', AUTO_SOUL_HEADER],
      ['.dsh/MEMORY.md', AUTO_MEMORY_MIRROR_HEADER],
    ] as const) {
      try {
        const target = join(this.#workspacePath, rel);
        const raw = readFileSync(target, 'utf8');
        if (raw.startsWith(header)) {
          unlinkSync(target);
        }
      } catch {
        // 文件不存在或已手写修改时保留
      }
    }
    this.#cache.clear();
  }
}
