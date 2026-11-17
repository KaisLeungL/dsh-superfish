import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  createUnlinkedSnapshot,
  detectGitRemoteFromDir,
  isRomaWorkspace,
  parseWorkspaceAtlas,
  repoPathFromRemote,
} from './parser.js';

const execFileAsync = promisify(execFile);

export const inject = ['connection'];

const DEFAULT_STATE_FILE = join(homedir(), '.dsh', 'workspace-atlas-state.json');

async function pickNativeDirectory(defaultDir = homedir()) {
  const startDir = defaultDir && existsSync(defaultDir) ? resolve(defaultDir) : homedir();
  if (process.platform === 'darwin') {
    const safeDefault = String(startDir).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `POSIX path of (choose folder with prompt "请选择工作区或项目目录" default location (POSIX file "${safeDefault}"))`;
    try {
      const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 120000 });
      const selected = stdout.trim().replace(/\/+$/, '') || '/';
      return { canceled: !stdout.trim(), path: stdout.trim() ? selected : null };
    } catch (err) {
      const msg = String(err?.stderr || err?.message || '');
      if (msg.includes('-128') || msg.toLowerCase().includes('cancel')) {
        return { canceled: true, path: null };
      }
      throw new Error('无法唤起系统目录选择器，请手动输入目录路径');
    }
  }
  if (process.platform === 'linux') {
    try {
      const { stdout } = await execFileAsync(
        'zenity',
        ['--file-selection', '--directory', '--title=请选择工作区或项目目录'],
        { timeout: 120000 }
      );
      const selected = stdout.trim().replace(/\/+$/, '');
      return { canceled: !selected, path: selected || null };
    } catch {
      return { canceled: true, path: null };
    }
  }
  if (process.platform === 'win32') {
    const psScript =
      "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; if ($f.ShowDialog() -eq 'OK') { $f.SelectedPath }";
    try {
      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', psScript], {
        timeout: 120000,
      });
      const selected = stdout.trim();
      return { canceled: !selected, path: selected || null };
    } catch {
      return { canceled: true, path: null };
    }
  }
  throw new Error('当前系统不支持原生目录选择器，请手动输入路径');
}

function loadPersistedState(stateFile) {
  try {
    if (!stateFile || !existsSync(stateFile)) {
      return { activeWorkspacePath: null, workspaces: [] };
    }
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
    const workspaces = Array.isArray(parsed?.workspaces)
      ? parsed.workspaces.filter(
          w => w && typeof w.path === 'string' && (w.path === '@custom' || existsSync(w.path))
        )
      : [];
    const active =
      parsed?.activeWorkspacePath && workspaces.some(w => w.path === parsed.activeWorkspacePath)
        ? parsed.activeWorkspacePath
        : workspaces[0]?.path || null;
    return {
      activeWorkspacePath: active,
      workspaces: workspaces.map(w => ({
        path: w.path,
        title: w.title || (w.path === '@custom' ? '自定义工作区' : basename(w.path)),
        isRoma: w.path === '@custom' ? false : isRomaWorkspace(w.path),
        extraRepos: Array.isArray(w.extraRepos) ? w.extraRepos : [],
      })),
    };
  } catch {
    return { activeWorkspacePath: null, workspaces: [] };
  }
}

function savePersistedState(stateFile, state) {
  if (!stateFile) return;
  try {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(
      stateFile,
      JSON.stringify(
        {
          activeWorkspacePath: state.activeWorkspacePath,
          workspaces: state.workspaces,
        },
        null,
        2
      ) + '\n',
      'utf8'
    );
  } catch {
    // ignore write errors in restricted environments
  }
}

function findRegistryWorkspaceId(ctx, targetPath) {
  if (!targetPath || targetPath === '@custom') return null;
  try {
    const registry = ctx.get?.('workspaceRegistry');
    if (registry && typeof registry.list === 'function') {
      const norm = resolve(targetPath);
      const matched = registry.list().find(ws => ws?.path && resolve(ws.path) === norm);
      return matched?.id || null;
    }
  } catch {
    // optional service
  }
  return null;
}

export async function apply(ctx, config = {}) {
  const stateFile =
    config.stateFile !== undefined
      ? config.stateFile
      : config.workspacePath
      ? null
      : DEFAULT_STATE_FILE;

  const state = loadPersistedState(stateFile);

  // If an explicit workspacePath is passed via config, seed it
  if (config?.workspacePath && state.workspaces.length === 0) {
    const resolved = resolve(config.workspacePath);
    if (existsSync(resolved)) {
      state.workspaces.push({
        path: resolved,
        title: basename(resolved),
        isRoma: isRomaWorkspace(resolved),
        extraRepos: [],
      });
      state.activeWorkspacePath = resolved;
    }
  }

  const cache = new Map();

  function buildAvailableWorkspaces() {
    return state.workspaces.map(w => ({
      workspaceId: findRegistryWorkspaceId(ctx, w.path),
      path: w.path,
      title: w.title,
      isRoma: w.path === '@custom' ? false : isRomaWorkspace(w.path),
    }));
  }

  async function getSnapshot(requestedPath, forceRefresh = false) {
    const availableWorkspaces = buildAvailableWorkspaces();

    let target = null;
    if (requestedPath) {
      const norm = requestedPath === '@custom' ? '@custom' : resolve(requestedPath);
      target = state.workspaces.find(w => w.path === norm) || null;
      if (!target && norm !== '@custom' && existsSync(norm)) {
        target = {
          path: norm,
          title: basename(norm),
          isRoma: isRomaWorkspace(norm),
          extraRepos: [],
        };
      }
    } else if (state.activeWorkspacePath) {
      target = state.workspaces.find(w => w.path === state.activeWorkspacePath) || state.workspaces[0] || null;
    } else if (state.workspaces.length > 0) {
      target = state.workspaces[0];
    }

    if (!target) {
      return createUnlinkedSnapshot(availableWorkspaces);
    }

    const now = Date.now();
    const cacheKey = `${target.path}::${JSON.stringify(target.extraRepos || [])}`;
    const cached = cache.get(cacheKey);
    const workspaceId = findRegistryWorkspaceId(ctx, target.path);

    if (!forceRefresh && cached && now - cached.at < 4000) {
      return {
        ...cached.snapshot,
        linked: true,
        workspace: {
          ...cached.snapshot.workspace,
          name: target.title || cached.snapshot.workspace.name,
          workspaceId,
        },
        availableWorkspaces,
      };
    }

    const snapshot = await parseWorkspaceAtlas(target.path, target.extraRepos || []);
    cache.set(cacheKey, { at: now, snapshot });
    return {
      ...snapshot,
      linked: true,
      workspace: {
        ...snapshot.workspace,
        name: target.title || snapshot.workspace.name,
        workspaceId,
      },
      availableWorkspaces,
    };
  }

  function linkDirectory(rawPath, appendToCurrent = false) {
    const trimmed = String(rawPath || '').trim();
    if (!trimmed) {
      throw new Error('请输入本地项目或工作区目录路径');
    }
    const resolved = resolve(trimmed);
    if (!existsSync(resolved)) {
      throw new Error(`本地路径不存在: ${resolved}`);
    }
    const st = statSync(resolved);
    if (!st.isDirectory()) {
      throw new Error(`该路径不是有效的文件夹: ${resolved}`);
    }

    const isRoma = isRomaWorkspace(resolved);
    const currentWs = state.workspaces.find(w => w.path === state.activeWorkspacePath);

    // If appending a single repo directory into an existing active workspace
    if (appendToCurrent && currentWs && !isRoma && currentWs.path !== resolved) {
      const detectedRemote = detectGitRemoteFromDir(resolved);
      const repoPath = repoPathFromRemote(detectedRemote) || basename(resolved);
      const existingIdx = currentWs.extraRepos.findIndex(
        r => r.repoPath === repoPath || basename(r.repoPath) === basename(repoPath)
      );
      const entry = {
        repoPath,
        remote: detectedRemote || `local://${resolved}`,
        localPath: resolved,
      };
      if (existingIdx >= 0) {
        currentWs.extraRepos[existingIdx] = { ...currentWs.extraRepos[existingIdx], ...entry };
      } else {
        currentWs.extraRepos.push(entry);
      }
      cache.clear();
      savePersistedState(stateFile, state);
      return currentWs.path;
    }

    let existing = state.workspaces.find(w => w.path === resolved);
    if (!existing) {
      existing = {
        path: resolved,
        title: basename(resolved),
        isRoma,
        extraRepos: [],
      };
      state.workspaces.push(existing);
    } else {
      existing.isRoma = isRoma;
    }
    state.activeWorkspacePath = resolved;
    cache.clear();
    savePersistedState(stateFile, state);
    return resolved;
  }

  function linkRemote(rawInput) {
    const lines = String(rawInput || '')
      .split(/[\r\n,]+/)
      .map(s => s.trim())
      .filter(Boolean);

    const parsedEntries = [];
    for (const line of lines) {
      const rp = repoPathFromRemote(line);
      if (rp && (line.includes('://') || line.startsWith('git@') || rp.includes('/'))) {
        parsedEntries.push({
          repoPath: rp,
          remote: line.includes('://') || line.startsWith('git@')
            ? line
            : `ssh://git@icode.baidu.com:8235/${rp}`,
          localPath: null,
        });
      }
    }

    if (parsedEntries.length === 0) {
      throw new Error('请输入有效的仓库地址（如 ssh://git@icode.baidu.com:8235/<group>/<dept>/<repo>）');
    }

    let targetWs = state.workspaces.find(w => w.path === state.activeWorkspacePath);
    if (!targetWs) {
      targetWs = {
        path: '@custom',
        title: parsedEntries.length === 1 ? basename(parsedEntries[0].repoPath) : '自定义工作区',
        isRoma: false,
        extraRepos: [],
      };
      state.workspaces.push(targetWs);
      state.activeWorkspacePath = '@custom';
    }

    for (const item of parsedEntries) {
      const exists = targetWs.extraRepos.some(r => r.repoPath === item.repoPath);
      if (!exists) {
        targetWs.extraRepos.push(item);
      }
    }

    if (targetWs.path === '@custom' && targetWs.extraRepos.length > 1) {
      targetWs.title = '自定义工作区';
    }

    cache.clear();
    savePersistedState(stateFile, state);
    return targetWs.path;
  }

  function unlinkWorkspace(targetPath) {
    const toRemove = targetPath || state.activeWorkspacePath;
    if (!toRemove) return null;
    const norm = toRemove === '@custom' ? '@custom' : resolve(toRemove);
    state.workspaces = state.workspaces.filter(w => w.path !== norm);
    if (state.activeWorkspacePath === norm) {
      state.activeWorkspacePath = state.workspaces[0]?.path || null;
    }
    cache.clear();
    savePersistedState(stateFile, state);
    return state.activeWorkspacePath;
  }

  function selectWorkspace(targetPath) {
    if (!targetPath) return state.activeWorkspacePath;
    const norm = targetPath === '@custom' ? '@custom' : resolve(targetPath);
    const matched = state.workspaces.find(w => w.path === norm);
    if (matched) {
      state.activeWorkspacePath = matched.path;
      savePersistedState(stateFile, state);
      return matched.path;
    }
    return state.activeWorkspacePath;
  }

  const service = {
    getSnapshot,
    linkDirectory,
    linkRemote,
    unlinkWorkspace,
    selectWorkspace,
  };

  ctx.provide?.('workspaceAtlas', service);

  ctx.effect(() =>
    ctx.connection.fetch.register({
      path: '/api/workspace-atlas',
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      async fetch(request) {
        try {
          const url = new URL(request.url, 'http://localhost');
          if (request.method === 'GET') {
            const wsPath = url.searchParams.get('workspacePath') || undefined;
            const force = url.searchParams.get('refresh') === '1';
            if (wsPath) selectWorkspace(wsPath);
            const data = await getSnapshot(wsPath, force);
            return Response.json(data, { headers: { 'cache-control': 'no-store' } });
          }

          const body = (await request.json()) || {};
          const action = body.action;

          if (action === 'pickDirectory') {
            const picker = typeof config?.pickDirectory === 'function' ? config.pickDirectory : pickNativeDirectory;
            const picked = await picker(body.defaultPath);
            return Response.json(picked, { headers: { 'cache-control': 'no-store' } });
          }

          if (action === 'linkDirectory') {
            const targetPath = linkDirectory(body.path, Boolean(body.appendToCurrent));
            const data = await getSnapshot(targetPath, true);
            return Response.json(data, { headers: { 'cache-control': 'no-store' } });
          }

          if (action === 'linkRemote') {
            const targetPath = linkRemote(body.remoteUrl || body.remote || body.path);
            const data = await getSnapshot(targetPath, true);
            return Response.json(data, { headers: { 'cache-control': 'no-store' } });
          }

          if (action === 'unlinkWorkspace') {
            const nextPath = unlinkWorkspace(body.workspacePath);
            const data = await getSnapshot(nextPath, true);
            return Response.json(data, { headers: { 'cache-control': 'no-store' } });
          }

          if (action === 'selectWorkspace') {
            const nextPath = selectWorkspace(body.workspacePath);
            const data = await getSnapshot(nextPath, Boolean(body.refresh));
            return Response.json(data, { headers: { 'cache-control': 'no-store' } });
          }

          const data = await getSnapshot(body?.workspacePath, true);
          return Response.json(data, { headers: { 'cache-control': 'no-store' } });
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : 'Workspace Atlas request failed.' },
            { status: 400, headers: { 'cache-control': 'no-store' } }
          );
        }
      },
    })
  );

  // Optional agent tool registration
  const registerTool = toolsSvc => {
    if (!toolsSvc || typeof toolsSvc.register !== 'function') return () => {};
    return toolsSvc.register({
      name: 'workspace_atlas',
      description:
        'Query or control the multi-repo Workspace Atlas panorama: list mounted/skipped repositories, architectural domains, cross-repo relations, verified build/test commands, or select/link/unlink workspace directories.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['snapshot', 'selectWorkspace', 'linkDirectory', 'linkRemote', 'unlinkWorkspace'],
            description: 'Optional action: defaults to snapshot.',
          },
          repoId: {
            type: 'string',
            description: 'Optional short repository ID (e.g. simeji-global, ime-android-lib, TreasureBowl) to inspect in detail.',
          },
          lens: {
            type: 'string',
            enum: ['all', 'mounted', 'aigc', 'monetization', 'cloud', 'input'],
            description: 'Optional feature routing lens filter.',
          },
          workspacePath: {
            type: 'string',
            description: 'Target workspace path for selectWorkspace or unlinkWorkspace.',
          },
          path: {
            type: 'string',
            description: 'Local directory path for linkDirectory.',
          },
          appendToCurrent: {
            type: 'boolean',
            description: 'Whether to append to the current custom atlas when linking a directory.',
          },
          remoteUrl: {
            type: 'string',
            description: 'Git remote URL for linkRemote.',
          },
          refresh: {
            type: 'boolean',
            description: 'Force refresh Git state cache.',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          return [{ type: 'text', text: JSON.stringify(value) }];
        },
      },
      async execute(input = {}) {
        const toLosslessJson = val => JSON.parse(JSON.stringify(val ?? null));
        const action = input.action || 'snapshot';
        if (action === 'selectWorkspace' && input.workspacePath) {
          const nextPath = selectWorkspace(input.workspacePath);
          return toLosslessJson(await getSnapshot(nextPath, true));
        }
        if (action === 'linkDirectory' && input.path) {
          const nextPath = linkDirectory(input.path, Boolean(input.appendToCurrent));
          return toLosslessJson(await getSnapshot(nextPath, true));
        }
        if (action === 'linkRemote' && input.remoteUrl) {
          const nextPath = linkRemote(input.remoteUrl);
          return toLosslessJson(await getSnapshot(nextPath, true));
        }
        if (action === 'unlinkWorkspace') {
          const nextPath = unlinkWorkspace(input.workspacePath);
          return toLosslessJson(await getSnapshot(nextPath || undefined, true));
        }
        const snap = await getSnapshot(input.workspacePath || undefined, Boolean(input.refresh));
        if (!snap.linked) {
          return toLosslessJson({
            linked: false,
            availableWorkspaces: snap.availableWorkspaces || snap.workspaces || [],
            message: 'No workspace or repository is currently linked in Workspace Atlas.',
          });
        }
        if (input.repoId) {
          const repo = snap.repos.find(r => r.id === input.repoId || r.path === input.repoId);
          if (!repo) return { error: `Repository not found: ${input.repoId}` };
          const relations = snap.edges.filter(e => e.from === repo.id || e.to === repo.id);
          return toLosslessJson({
            workspace: snap.workspace || null,
            repo,
            relations,
            sdkGates: snap.sdkGates || null,
          });
        }
        const repos = (snap.repos || [])
          .filter(r => {
            if (!input.lens || input.lens === 'all') return true;
            if (input.lens === 'mounted') return r.mounted;
            return Array.isArray(r.lenses) && r.lenses.includes(input.lens);
          })
          .map(r => ({
            id: r.id ?? '',
            path: r.path ?? '',
            col: r.col ?? null,
            mounted: Boolean(r.mounted),
            branch: r.branch ?? null,
            dirtyLabel: r.dirtyLabel ?? null,
            stack: Array.isArray(r.stack) ? r.stack : [],
            summary: r.summary ?? '',
          }));
        return toLosslessJson({
          linked: true,
          workspace: snap.workspace || null,
          availableWorkspaces: snap.availableWorkspaces || snap.workspaces || [],
          repos,
          edges: snap.edges || [],
          sdkGates: snap.sdkGates || null,
        });
      },
    });
  };

  try {
    const toolsSvc = ctx.get?.('tools');
    if (toolsSvc) {
      ctx.effect(() => registerTool(toolsSvc));
    } else if (typeof ctx.inject === 'function') {
      ctx.inject(['tools'], scoped => {
        scoped.effect(() => registerTool(scoped.get('tools')));
      });
    }
  } catch {
    // optional tool surface
  }
}
