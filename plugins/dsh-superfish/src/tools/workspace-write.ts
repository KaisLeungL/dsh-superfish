import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { scrubSensitiveText } from '../app/sentinel/scrubber.js';
import {
  CallerAuthority,
  CallerDenied,
  WORKER_SANDBOX_TOOLS,
  type CallerAgent,
  type Invocation,
} from './authority.js';

export interface WorkerSandboxHost {
  workspacePath(taskId: string): string | null;
  taskPermission(taskId: string): string | undefined;
}

export interface WorkerSandboxInvocation<A extends CallerAgent> extends Invocation<A> {
  readonly name: string;
}

const MAX_READ_BYTES = 64 * 1024;
const MAX_WRITE_BYTES = 128 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const MAX_COMMAND_TIMEOUT_MS = 60_000;

const PROTECTED_PATH_SEGMENTS = new Set(['.git', '.dsh', 'node_modules']);
const PROTECTED_FILE_PATTERNS: readonly RegExp[] = [
  /^\.env(?:\..+)?$/i,
  /\.(?:pem|key|p12|pfx|keystore)$/i,
];

const BLOCKED_COMMAND_PATTERNS: readonly RegExp[] = [
  /\b(?:sudo|su|chown|chmod\s+777|mkfs|dd|shutdown|reboot)\b/i,
  /\b(?:curl|wget|nc|netcat|ssh|scp|sftp|rsync|ftp|telnet)\b/i,
  /\bgit\s+(?:push|remote\s+add|config\s+--global)\b/i,
  /\b(?:npm|pnpm|yarn)\s+publish\b/i,
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+(?:\/|~|\.\.)/i,
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const asRecord = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) throw new CallerDenied('INVALID_ARGUMENTS', '工具参数必须是对象。');
  return value;
};

/**
 * 解析并校验工作区受限路径，防御目录穿越、符号链接逃逸与受保护目录修改。
 */
export function resolveConfinedWorkspacePath(
  workspaceRoot: string,
  userRelativePath: string,
  mode: 'read' | 'write',
): { readonly absolutePath: string; readonly relativePath: string } {
  const raw = userRelativePath.trim();
  if (!raw || raw.includes('\0') || isAbsolute(raw)) {
    throw new CallerDenied('SANDBOX_PATH_DENIED', '仅允许使用相对于工作区根目录的相对路径。');
  }

  const realRoot = existsSync(workspaceRoot) ? realpathSync(workspaceRoot) : resolve(workspaceRoot);
  const candidate = resolve(realRoot, normalize(raw));
  const rel = relative(realRoot, candidate);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new CallerDenied('SANDBOX_PATH_DENIED', '路径越出当前工作区沙盒边界。');
  }

  const segments = rel.split(sep);
  const baseName = segments.at(-1) ?? '';
  if (PROTECTED_FILE_PATTERNS.some(pattern => pattern.test(baseName))) {
    throw new CallerDenied('SANDBOX_PATH_PROTECTED', '禁止读写密钥或环境变量敏感文件。');
  }
  if (mode === 'write' && segments.some(seg => PROTECTED_PATH_SEGMENTS.has(seg))) {
    throw new CallerDenied('SANDBOX_PATH_PROTECTED', '禁止向受保护目录（.git / .dsh / node_modules）写入文件。');
  }

  // 检查现有目标或其最近存在的父目录真实路径，防止符号链接逃逸
  let probe = candidate;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  if (existsSync(probe)) {
    const realProbe = realpathSync(probe);
    if (realProbe !== realRoot && !realProbe.startsWith(realRoot + sep)) {
      throw new CallerDenied('SANDBOX_SYMLINK_ESCAPE', '检测到符号链接指向工作区外部，已拒绝访问。');
    }
  }

  return Object.freeze({
    absolutePath: candidate,
    relativePath: rel.split(sep).join('/'),
  });
}

export function validateWorkerCommand(command: string): void {
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > 1000 || trimmed.includes('\0')) {
    throw new CallerDenied('SANDBOX_COMMAND_INVALID', '命令长度无效或包含非法字符。');
  }
  for (const blocked of BLOCKED_COMMAND_PATTERNS) {
    if (blocked.test(trimmed)) {
      throw new CallerDenied('SANDBOX_COMMAND_DENIED', '安全网关拦截：禁止在受管 Worker 中执行外联、提权或高危破坏性命令。');
    }
  }
}

export function workerSandboxToolDefinitions<A extends CallerAgent>(
  authority: CallerAuthority<A>,
  host: WorkerSandboxHost,
) {
  const requireWorkerContext = (
    exec: WorkerSandboxInvocation<A>,
    toolName: string,
    requireWritePermission: boolean,
  ): { taskId: string; executionId: string; workspaceRoot: string } => {
    const lease = authority.capture(exec);
    if (lease.role !== 'worker' || !lease.taskId || !lease.executionId) {
      throw new CallerDenied('WORKER_ONLY_TOOL', '该沙盒执行工具仅授予已准入的看板受管 Worker。');
    }
    lease.require(toolName, 'read', { taskId: lease.taskId, executionId: lease.executionId });
    const permission = host.taskPermission(lease.taskId);
    if (requireWritePermission && permission !== 'workspace-write') {
      throw new CallerDenied(
        'WORKSPACE_WRITE_REQUIRED',
        '当前看板卡片权限为 read-only，禁止修改文件或运行命令；需将卡片权限设为 workspace-write。',
      );
    }
    const workspaceRoot = host.workspacePath(lease.taskId);
    if (!workspaceRoot) {
      throw new CallerDenied('WORKSPACE_PATH_UNAVAILABLE', '无法解析当前任务所属的工作区目录。');
    }
    return { taskId: lease.taskId, executionId: lease.executionId, workspaceRoot };
  };

  return [
    {
      name: WORKER_SANDBOX_TOOLS[0],
      description: '读取当前工作区内的文本文件内容（受沙盒路径边界与 Sentinel 脱敏保护）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: {
            type: 'string',
            minLength: 1,
            maxLength: 512,
            description: '相对于工作区根目录的文件路径。',
          },
          startLine: {
            type: 'integer',
            minimum: 1,
            description: '可选起始行号（从 1 开始）。',
          },
          endLine: {
            type: 'integer',
            minimum: 1,
            description: '可选结束行号（含）。',
          },
        },
        required: ['path'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (rawArgs: unknown, exec: WorkerSandboxInvocation<A>) => {
        const { workspaceRoot } = requireWorkerContext(exec, WORKER_SANDBOX_TOOLS[0], false);
        const input = asRecord(rawArgs);
        if (typeof input.path !== 'string') {
          throw new CallerDenied('INVALID_ARGUMENTS', '必须提供有效的文件路径。');
        }
        const { absolutePath, relativePath } = resolveConfinedWorkspacePath(workspaceRoot, input.path, 'read');
        if (!existsSync(absolutePath)) {
          return { status: 'not_found', path: relativePath };
        }
        const stat = statSync(absolutePath);
        if (!stat.isFile()) {
          throw new CallerDenied('SANDBOX_PATH_DENIED', '目标路径不是普通文件。');
        }
        if (stat.size > MAX_READ_BYTES * 2) {
          throw new CallerDenied('SANDBOX_FILE_TOO_LARGE', '文件体积超出沙盒单次读取上限（128KB）。');
        }
        const rawContent = readFileSync(absolutePath, 'utf8');
        const allLines = rawContent.split(/\r?\n/);
        const start = typeof input.startLine === 'number' ? Math.max(1, Math.trunc(input.startLine)) : 1;
        const end = typeof input.endLine === 'number' ? Math.min(allLines.length, Math.trunc(input.endLine)) : allLines.length;
        const sliced = allLines.slice(start - 1, Math.max(start - 1, end)).join('\n');
        const scrubbed = scrubSensitiveText(sliced.slice(0, MAX_READ_BYTES));
        return {
          status: 'ok',
          path: relativePath,
          totalLines: allLines.length,
          startLine: start,
          endLine: end,
          content: scrubbed.text,
          redactedCount: scrubbed.redactedCount,
        };
      },
    },
    {
      name: WORKER_SANDBOX_TOOLS[1],
      description: '在当前工作区沙盒内创建或覆盖写入文本文件（要求看板任务卡片具备 workspace-write 权限，禁止写入 .git / .dsh / .env）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: {
            type: 'string',
            minLength: 1,
            maxLength: 512,
            description: '相对于工作区根目录的文件路径。',
          },
          content: {
            type: 'string',
            maxLength: MAX_WRITE_BYTES,
            description: '要写入的完整文本内容。',
          },
        },
        required: ['path', 'content'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (rawArgs: unknown, exec: WorkerSandboxInvocation<A>) => {
        const { workspaceRoot } = requireWorkerContext(exec, WORKER_SANDBOX_TOOLS[1], true);
        const input = asRecord(rawArgs);
        if (typeof input.path !== 'string' || typeof input.content !== 'string') {
          throw new CallerDenied('INVALID_ARGUMENTS', '必须提供 path 与 content。');
        }
        if (Buffer.byteLength(input.content, 'utf8') > MAX_WRITE_BYTES) {
          throw new CallerDenied('SANDBOX_FILE_TOO_LARGE', '写入内容超出 128KB 限制。');
        }
        const { absolutePath, relativePath } = resolveConfinedWorkspacePath(workspaceRoot, input.path, 'write');
        mkdirSync(dirname(absolutePath), { recursive: true });
        writeFileSync(absolutePath, input.content, 'utf8');
        return {
          status: 'ok',
          path: relativePath,
          bytesWritten: Buffer.byteLength(input.content, 'utf8'),
        };
      },
    },
    {
      name: WORKER_SANDBOX_TOOLS[2],
      description: '在当前工作区沙盒内运行本地构建、单测或脚本命令（要求看板任务卡片具备 workspace-write 权限，自动拦截外联与破坏性指令）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: {
            type: 'string',
            minLength: 1,
            maxLength: 1000,
            description: '要执行的命令字符串。',
          },
          timeoutMs: {
            type: 'integer',
            minimum: 1000,
            maximum: MAX_COMMAND_TIMEOUT_MS,
            description: '超时时间（毫秒，默认 15000，最大 60000）。',
          },
        },
        required: ['command'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (rawArgs: unknown, exec: WorkerSandboxInvocation<A>) => {
        const { workspaceRoot } = requireWorkerContext(exec, WORKER_SANDBOX_TOOLS[2], true);
        const input = asRecord(rawArgs);
        if (typeof input.command !== 'string') {
          throw new CallerDenied('INVALID_ARGUMENTS', '必须提供 command 字符串。');
        }
        validateWorkerCommand(input.command);
        const timeoutMs =
          typeof input.timeoutMs === 'number'
            ? Math.min(MAX_COMMAND_TIMEOUT_MS, Math.max(1000, Math.trunc(input.timeoutMs)))
            : DEFAULT_COMMAND_TIMEOUT_MS;

        return await new Promise<Record<string, unknown>>(resolvePromise => {
          execFile(
            '/bin/sh',
            ['-c', input.command as string],
            {
              cwd: workspaceRoot,
              timeout: timeoutMs,
              maxBuffer: 256 * 1024,
              signal: exec.signal,
            },
            (error, stdout, stderr) => {
              const cleanStdout = scrubSensitiveText(String(stdout ?? '').slice(0, 16384)).text;
              const cleanStderr = scrubSensitiveText(String(stderr ?? '').slice(0, 16384)).text;
              const exitCode =
                error && typeof (error as { code?: unknown }).code === 'number'
                  ? ((error as { code: number }).code)
                  : error
                    ? 1
                    : 0;
              resolvePromise({
                status: exitCode === 0 ? 'ok' : 'failed',
                exitCode,
                stdout: cleanStdout,
                stderr: cleanStderr,
              });
            },
          );
        });
      },
    },
  ];
}
