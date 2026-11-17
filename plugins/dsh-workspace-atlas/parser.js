import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const ARCHITECTURAL_COLUMNS = [
  { id: 'hosts', label: 'CLIENT HOSTS', zhLabel: '客户端宿主域' },
  { id: 'sdks', label: 'CLIENT SDKS', zhLabel: '客户端 SDK 与基础库' },
  { id: 'gateways', label: 'API GATEWAYS', zhLabel: 'API 网关与内容分发' },
  { id: 'services', label: 'AI & INFRA SERVICES', zhLabel: 'AI · 云控 · 支付 · 数据服务' },
];

export const FEATURE_LENSES = [
  { id: 'all', label: 'All Repos', zhLabel: '全部仓库' },
  { id: 'mounted', label: 'Mounted', zhLabel: '已挂载' },
  { id: 'aigc', label: 'AIGC & Rizz', zhLabel: 'AIGC / Rizz' },
  { id: 'monetization', label: 'Ad & Billing', zhLabel: '商业化与支付' },
  { id: 'cloud', label: 'Cloud & UTS', zhLabel: '云控与埋点' },
  { id: 'input', label: 'Input & Theme', zhLabel: '输入引擎与皮肤' },
];

const SDK_FLAG_METADATA = {
  latinIsDependOnCode: { module: ':latin-beta', repoId: 'simeji-global', baseline: true },
  treastureIsDependOnCode: { module: 'TreasureBowl (:plutus)', repoId: 'TreasureBowl', baseline: false },
  richIsDependOnCode: { module: 'TreasureBowl (:rich)', repoId: 'TreasureBowl', baseline: false },
  kmmIsDependOnCode: { module: ':facemojiKmm', repoId: 'facemoji-ios', baseline: false },
  baseIsDependOnCode: { module: ':base', repoId: 'simeji-global', baseline: false },
  routerIsDependOnCode: { module: ':router', repoId: 'simeji-global', baseline: false },
  gstartupIsDependOnCode: { module: ':GStartup', repoId: 'simeji-global', baseline: false },
};

function safeReadText(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function unquote(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function repoPathFromRemote(remoteUrl) {
  const raw = String(remoteUrl || '').trim();
  if (!raw || raw.startsWith('#')) return null;
  // ssh://git@icode.baidu.com:8235/<group>/<dept>/<repo>
  const sshMatch = raw.match(/^ssh:\/\/[^/]+\/(.+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1].replace(/\/+$/, '');
  // https://console.cloud.baidu-int.com/devops/icode/repos/<group>/<dept>/<repo>/tree/...
  const consoleMatch = raw.match(/\/devops\/icode\/repos\/(.+?)(?:\/tree\/.*)?$/);
  if (consoleMatch) return consoleMatch[1].replace(/\/+$/, '');
  // Generic URL
  try {
    const parsed = new URL(raw);
    return parsed.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '') || null;
  } catch {
    return raw.replace(/^\/+|\/+$/g, '') || null;
  }
}

export function isRomaWorkspace(dirPath) {
  if (!dirPath || typeof dirPath !== 'string' || dirPath === '@custom') return false;
  return (
    existsSync(join(dirPath, 'repos', '.repo-list')) ||
    existsSync(join(dirPath, '.roma', 'init-selection.json')) ||
    existsSync(join(dirPath, 'repos', 'index.md'))
  );
}

export function detectGitRemoteFromDir(dirPath) {
  if (!dirPath || typeof dirPath !== 'string') return null;
  const gitConfig = safeReadText(join(dirPath, '.git', 'config'));
  if (gitConfig) {
    const match = gitConfig.match(/\[remote\s+"origin"\][\s\S]*?\burl\s*=\s*([^\r\n]+)/);
    if (match && match[1]) return match[1].trim();
  }
  return null;
}

export function createUnlinkedSnapshot(availableWorkspaces = []) {
  return {
    version: 'phase1-v1',
    linked: false,
    sampledAt: Date.now(),
    workspace: null,
    availableWorkspaces,
    columns: ARCHITECTURAL_COLUMNS,
    lenses: FEATURE_LENSES,
    repos: [],
    edges: [],
    sdkGates: { available: false, filePath: '', flags: [], nonBaselineCount: 0 },
  };
}

/**
 * Parse `relations:` list from either `repos/index.md` fenced YAML or `capabilities.yaml`.
 */
export function parseYamlRelationsBlock(yamlText, defaultFrom = null) {
  if (!yamlText) return [];
  const lines = yamlText.split(/\r?\n/);
  const relations = [];
  let inRelations = false;
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (/^relations:\s*$/.test(line)) {
      inRelations = true;
      continue;
    }
    if (inRelations && /^[a-zA-Z0-9_-]+:/.test(line)) {
      break;
    }
    if (!inRelations) continue;

    const itemStart = line.match(/^\s*-\s+([a-zA-Z0-9_]+):\s*(.*)$/);
    if (itemStart) {
      if (current) relations.push(current);
      current = {
        from: defaultFrom,
        to: null,
        kind: 'consumer',
        contract: '',
        joint_regression: false,
        note: '',
      };
      const [, key, val] = itemStart;
      applyRelationField(current, key, val);
      continue;
    }

    const propMatch = line.match(/^\s+([a-zA-Z0-9_]+):\s*(.*)$/);
    if (propMatch && current) {
      const [, key, val] = propMatch;
      applyRelationField(current, key, val);
    }
  }
  if (current) relations.push(current);
  return relations.filter(r => r.from && r.to);
}

function applyRelationField(target, key, rawVal) {
  const val = unquote(rawVal);
  if (key === 'from') target.from = val;
  else if (key === 'to') target.to = val;
  else if (key === 'kind') target.kind = val;
  else if (key === 'contract') target.contract = val;
  else if (key === 'joint_regression') target.joint_regression = val === 'true';
  else if (key === 'note') target.note = val;
}

/**
 * Parse `roma.repo-capabilities/v1` YAML file without external dependencies.
 */
export function parseCapabilitiesYaml(yamlText, repoPath) {
  if (!yamlText) return null;
  const lines = yamlText.split(/\r?\n/);
  const result = {
    schema: 'roma.repo-capabilities/v1',
    repo: repoPath,
    runtime: {},
    packageManager: null,
    commands: [],
    relations: parseYamlRelationsBlock(yamlText, repoPath),
  };

  let section = null;
  let currentCmd = null;
  let inRequires = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const topMatch = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
    if (topMatch) {
      const [, key, rest] = topMatch;
      section = key;
      currentCmd = null;
      inRequires = false;
      if (key === 'package_manager' && rest) {
        result.packageManager = unquote(rest);
      }
      continue;
    }

    if (section === 'runtime') {
      const rtMatch = line.match(/^\s{2}([a-zA-Z0-9_]+):\s*(.+)$/);
      if (rtMatch) {
        result.runtime[rtMatch[1]] = unquote(rtMatch[2]);
      }
    } else if (section === 'commands') {
      const cmdHeader = line.match(/^\s{2}([a-zA-Z0-9_-]+):\s*$/);
      if (cmdHeader) {
        currentCmd = {
          name: cmdHeader[1],
          run: '',
          cwd: '.',
          requires: [],
          produces: null,
          source: null,
          verified: null,
        };
        result.commands.push(currentCmd);
        inRequires = false;
        continue;
      }
      if (!currentCmd) continue;

      const cmdProp = line.match(/^\s{4}([a-zA-Z0-9_]+):\s*(.*)$/);
      if (cmdProp) {
        const [, k, v] = cmdProp;
        inRequires = k === 'requires' && !v.trim();
        if (k === 'run') currentCmd.run = unquote(v);
        else if (k === 'cwd') currentCmd.cwd = unquote(v);
        else if (k === 'produces') currentCmd.produces = unquote(v);
        else if (k === 'source') currentCmd.source = unquote(v);
        else if (k === 'verified') currentCmd.verified = unquote(v) === 'null' ? null : unquote(v);
        continue;
      }

      if (inRequires) {
        const reqItem = line.match(/^\s{6}-\s*(.+)$/);
        if (reqItem) {
          currentCmd.requires.push(unquote(reqItem[1]));
        }
      }
    }
  }

  return result;
}

/**
 * Parse `repos/index.md` tables and `roma.repo-relations/v1` block.
 */
export function parseReposIndexMarkdown(mdText) {
  const byRepoPath = new Map();
  let relations = [];
  if (!mdText) return { byRepoPath, relations };

  const yamlBlockMatch = mdText.match(/```yaml\s*\n([\s\S]*?)```/);
  if (yamlBlockMatch && yamlBlockMatch[1].includes('roma.repo-relations/v1')) {
    relations = parseYamlRelationsBlock(yamlBlockMatch[1], null);
  }

  const lines = mdText.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map(c => c.trim());
    if (cells.length < 4) continue;
    const firstCell = cells[0].replace(/`/g, '').trim();
    if (!firstCell.includes('/') || firstCell.startsWith('-')) continue;

    // Mounted table has 5 columns: | 仓库 | 源码入口 | 所属项目 | 主要职责 | 介绍文档 |
    // Skipped table has 4 columns: | 仓库 | 领域分类 | 主要职责与契约边界 | 与已挂载 Android 仓的关联入口 |
    if (cells.length >= 5 && cells[1].includes('.source/')) {
      byRepoPath.set(firstCell, {
        domainLabel: cells[2],
        summary: cells[3],
        entryHint: '',
      });
    } else {
      byRepoPath.set(firstCell, {
        domainLabel: cells[1],
        summary: cells[2],
        entryHint: cells[3] || '',
      });
    }
  }

  return { byRepoPath, relations };
}

/**
 * Parse `docs/architecture/system-topology.md` for tech stack and section grouping.
 */
export function parseSystemTopologyMarkdown(mdText) {
  const byRepoPath = new Map();
  if (!mdText) return byRepoPath;

  const lines = mdText.split(/\r?\n/);
  let currentCol = null;

  for (const line of lines) {
    if (line.startsWith('### 2.1')) currentCol = 'hosts';
    else if (line.startsWith('### 2.2')) currentCol = 'sdks';
    else if (line.startsWith('### 2.3')) currentCol = 'gateways';
    else if (line.startsWith('### 2.4')) currentCol = 'services';
    else if (line.startsWith('## 3.')) currentCol = null;

    if (!currentCol || !line.trim().startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map(c => c.trim());
    if (cells.length < 3) continue;
    const repoPath = cells[0].replace(/`/g, '').trim();
    if (!repoPath.includes('/') || repoPath.startsWith('-')) continue;

    byRepoPath.set(repoPath, {
      col: currentCol,
      stack: cells[1].replace(/`/g, ''),
      topologyRole: cells[2],
      endpointInfo: (cells[3] || '').replace(/<br\s*\/?>/gi, ' · '),
    });
  }

  return byRepoPath;
}

function classifyColumnFallback(repoId, domainLabel = '') {
  const id = repoId.toLowerCase();
  if (id === 'simeji-global' || id === 'facemoji-ios' || domainLabel.includes('宿主')) return 'hosts';
  if (id.includes('appui') || domainLabel.includes('网关') || domainLabel.includes('公共库')) return 'gateways';
  if (
    id === 'ime-android-lib' ||
    id === 'treasurebowl' ||
    id === 'facemojisdk' ||
    id === 'ime' ||
    domainLabel.includes('SDK') ||
    domainLabel.includes('组件')
  ) {
    return 'sdks';
  }
  return 'services';
}

function inferFeatureLenses(repoId) {
  const map = {
    'simeji-global': ['aigc', 'monetization', 'cloud', 'input'],
    'facemoji-ios': ['aigc', 'monetization', 'cloud', 'input'],
    'ime-android-lib': ['cloud'],
    'TreasureBowl': ['monetization'],
    'facemojisdk': ['input'],
    'ime': ['input'],
    'gdp-facemoji-appui': ['aigc', 'monetization', 'cloud', 'input'],
    'odp-facemoji-appui': ['input'],
    'gdp-appui-library': ['input', 'cloud'],
    'facemoji-python-server': ['aigc'],
    'gdp-push-center': ['cloud'],
    'gdp-simeji-report': ['cloud'],
    'gdp-translator-pay': ['monetization'],
    'gdp-simeji-ipquery': ['cloud'],
    'gdp-aws-service': ['aigc', 'input'],
  };
  return map[repoId] || [];
}

function buildImplicitTopologyEdges(knownIds) {
  const candidates = [
    {
      from: 'simeji-global',
      to: 'gdp-push-center',
      kind: 'protocol-contract',
      contract: 'CloudConfig encrypt & MESSAGE_SERVER push',
      joint_regression: false,
      source: 'system-topology',
    },
    {
      from: 'simeji-global',
      to: 'gdp-simeji-report',
      kind: 'protocol-contract',
      contract: 'UtsUtil & SubdivideMonitor telemetry ingestion',
      joint_regression: false,
      source: 'system-topology',
    },
    {
      from: 'simeji-global',
      to: 'gdp-translator-pay',
      kind: 'protocol-contract',
      contract: 'Google Play Billing 9.1.0 & real-time translation API',
      joint_regression: true,
      source: 'system-topology',
    },
    {
      from: 'simeji-global',
      to: 'gdp-simeji-ipquery',
      kind: 'protocol-contract',
      contract: 'RegionManager IP geolocation & compliance policy',
      joint_regression: false,
      source: 'system-topology',
    },
    {
      from: 'simeji-global',
      to: 'gdp-aws-service',
      kind: 'protocol-contract',
      contract: 'S3 upload signing & global sticker/theme CDN',
      joint_regression: false,
      source: 'system-topology',
    },
    {
      from: 'simeji-global',
      to: 'odp-facemoji-appui',
      kind: 'protocol-contract',
      contract: 'Legacy /appui/ online resource routes',
      joint_regression: false,
      source: 'system-topology',
    },
    {
      from: 'facemoji-ios',
      to: 'gdp-facemoji-appui',
      kind: 'protocol-contract',
      contract: 'iOS shared AppUI gateway protocol',
      joint_regression: false,
      source: 'system-topology',
    },
    {
      from: 'facemoji-ios',
      to: 'facemoji-python-server',
      kind: 'protocol-contract',
      contract: 'iOS shared AIGC / Genmoji / GPT API',
      joint_regression: false,
      source: 'system-topology',
    },
    {
      from: 'gdp-facemoji-appui',
      to: 'gdp-appui-library',
      kind: 'consumer',
      contract: 'Shared Go middleware, crypto & DAO module',
      joint_regression: false,
      source: 'system-topology',
    },
  ];
  return candidates.filter(e => knownIds.has(e.from) && knownIds.has(e.to));
}

async function inspectGitStatus(targetDir) {
  try {
    const [branchRes, statusRes] = await Promise.all([
      execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: targetDir, timeout: 1500 }),
      execFileAsync('git', ['status', '--porcelain'], { cwd: targetDir, timeout: 1500 }),
    ]);
    const branch = branchRes.stdout.trim() || 'HEAD';
    const lines = statusRes.stdout
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean);
    let modified = 0;
    let untracked = 0;
    for (const line of lines) {
      if (line.startsWith('??')) untracked += 1;
      else modified += 1;
    }
    const dirtyCount = lines.length;
    const parts = [];
    if (modified > 0) parts.push(`${modified}M`);
    if (untracked > 0) parts.push(`${untracked}?`);
    return {
      branch,
      dirtyCount,
      modifiedCount: modified,
      untrackedCount: untracked,
      dirtyLabel: dirtyCount === 0 ? 'clean' : parts.join(' '),
    };
  } catch {
    return {
      branch: 'unknown',
      dirtyCount: 0,
      modifiedCount: 0,
      untrackedCount: 0,
      dirtyLabel: '—',
    };
  }
}

export function parseAndroidSdkFlags(workspaceRoot) {
  const propsPath = join(
    workspaceRoot,
    'repos',
    '.source',
    'app',
    'gensoft',
    'ipcs-mobile',
    'simeji-global',
    'LatinIME',
    'gradle.properties'
  );
  const content = safeReadText(propsPath);
  if (!content) {
    return { available: false, filePath: 'repos/.source/.../LatinIME/gradle.properties', flags: [], nonBaselineCount: 0 };
  }

  const lines = content.split(/\r?\n/);
  const flags = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith('#')) continue;
    const m = raw.match(/^([a-zA-Z0-9_]*IsDependOnCode)\s*=\s*(true|false)\b/);
    if (!m) continue;
    const [, key, valStr] = m;
    const value = valStr === 'true';
    const meta = SDK_FLAG_METADATA[key] || { module: key, repoId: 'simeji-global', baseline: false };
    flags.push({
      key,
      value,
      baseline: meta.baseline,
      isNonBaseline: value !== meta.baseline,
      module: meta.module,
      repoId: meta.repoId,
      line: i + 1,
    });
  }

  const nonBaselineCount = flags.filter(f => f.isNonBaseline).length;
  return {
    available: true,
    filePath: 'LatinIME/gradle.properties',
    flags,
    nonBaselineCount,
  };
}

function formatRuntimeBadge(capabilities, topologyMeta, domainLabel) {
  if (capabilities?.runtime && Object.keys(capabilities.runtime).length > 0) {
    const parts = [];
    if (capabilities.runtime.kotlin) parts.push(`Kotlin ${capabilities.runtime.kotlin}`);
    if (capabilities.runtime.jdk) parts.push(`JDK ${capabilities.runtime.jdk}`);
    if (capabilities.runtime.android_sdk) parts.push(`SDK ${capabilities.runtime.android_sdk}`);
    if (capabilities.runtime.go) parts.push(`Go ${capabilities.runtime.go}`);
    if (capabilities.runtime.python) parts.push(`Python ${capabilities.runtime.python}`);
    if (parts.length > 0) return parts.join(' · ');
  }
  if (topologyMeta?.stack) return topologyMeta.stack;
  if (domainLabel) return domainLabel;
  return 'Repository';
}

/**
 * Main workspace snapshot builder.
 */
export async function parseWorkspaceAtlas(workspaceRoot, extraRepos = []) {
  const isCustom = !workspaceRoot || workspaceRoot === '@custom';
  const root = isCustom ? '@custom' : resolve(workspaceRoot);
  const repoListText = isCustom ? '' : safeReadText(join(root, 'repos', '.repo-list')) || '';
  const initSelectionText = isCustom ? null : safeReadText(join(root, '.roma', 'init-selection.json'));
  const indexMdText = isCustom ? '' : safeReadText(join(root, 'repos', 'index.md')) || '';
  const topologyMdText = isCustom ? '' : safeReadText(join(root, 'docs', 'architecture', 'system-topology.md')) || '';

  const initSelection = initSelectionText ? JSON.parse(initSelectionText) : { repos: [] };
  const initSelectionMap = new Map();
  for (const item of initSelection.repos || []) {
    if (item?.repo) initSelectionMap.set(item.repo, item);
  }

  const { byRepoPath: indexMap, relations: indexRelations } = parseReposIndexMarkdown(indexMdText);
  const topologyMap = parseSystemTopologyMarkdown(topologyMdText);

  const extraRepoMap = new Map();
  const extraRepoByName = new Map();
  for (const ext of extraRepos || []) {
    if (!ext || !ext.repoPath) continue;
    extraRepoMap.set(ext.repoPath, ext);
    extraRepoByName.set(basename(ext.repoPath), ext);
  }

  // Ordered repo paths from .repo-list + init-selection.json + index.md + extraRepos
  const repoPathsSet = new Set();
  for (const line of repoListText.split(/\r?\n/)) {
    const rp = repoPathFromRemote(line);
    if (rp) repoPathsSet.add(rp);
  }
  for (const item of initSelection.repos || []) {
    if (item?.repo) repoPathsSet.add(item.repo);
  }
  for (const rp of indexMap.keys()) {
    repoPathsSet.add(rp);
  }
  for (const rp of extraRepoMap.keys()) {
    repoPathsSet.add(rp);
  }

  // If user linked a standalone project directory (non-Roma directory), treat the directory itself as a mounted repo node
  if (!isCustom && !isRomaWorkspace(root) && repoPathsSet.size === 0 && existsSync(root)) {
    const detectedRemote = detectGitRemoteFromDir(root);
    const singleRepoPath = repoPathFromRemote(detectedRemote) || basename(root);
    repoPathsSet.add(singleRepoPath);
    const selfEntry = {
      repoPath: singleRepoPath,
      remote: detectedRemote || `local://${root}`,
      localPath: root,
    };
    extraRepoMap.set(singleRepoPath, selfEntry);
    extraRepoByName.set(basename(singleRepoPath), selfEntry);
  }

  const repoPaths = [...repoPathsSet];
  const allRelations = [...indexRelations];

  const repos = await Promise.all(
    repoPaths.map(async repoPath => {
      const id = basename(repoPath);
      const initEntry = initSelectionMap.get(repoPath);
      const indexEntry = indexMap.get(repoPath) || {};
      const topoEntry = topologyMap.get(repoPath) || {};
      const extraEntry = extraRepoMap.get(repoPath) || extraRepoByName.get(id) || null;

      // Inspect mount at repos/.source/<repoPath> or user-linked localPath
      let mounted = false;
      let mountKind = 'skipped';
      let symlinkTarget = null;
      let resolvedSourceDir = null;

      if (!isCustom) {
        const sourceEntryPath = join(root, 'repos', '.source', repoPath);
        try {
          const lstat = lstatSync(sourceEntryPath);
          if (lstat.isSymbolicLink()) {
            symlinkTarget = readlinkSync(sourceEntryPath);
            try {
              const targetStat = statSync(sourceEntryPath);
              if (targetStat.isDirectory()) {
                mounted = true;
                mountKind = 'symlink';
                resolvedSourceDir = sourceEntryPath;
              } else {
                mountKind = 'broken';
              }
            } catch {
              mountKind = 'broken';
            }
          } else if (lstat.isDirectory()) {
            mounted = true;
            mountKind = 'directory';
            resolvedSourceDir = sourceEntryPath;
          }
        } catch {
          mountKind = 'skipped';
        }
      }

      if (!mounted && extraEntry?.localPath) {
        try {
          const st = statSync(extraEntry.localPath);
          if (st.isDirectory()) {
            mounted = true;
            mountKind = 'directory';
            symlinkTarget = extraEntry.localPath;
            resolvedSourceDir = extraEntry.localPath;
          }
        } catch {
          // localPath not accessible
        }
      }

      // Inspect profile docs under repos/<repoPath>/
      const profileDir = isCustom ? null : join(root, 'repos', repoPath);
      const capText = profileDir ? safeReadText(join(profileDir, 'capabilities.yaml')) : null;
      const overviewText = profileDir ? safeReadText(join(profileDir, 'overview.md')) : null;
      const setupText = profileDir ? safeReadText(join(profileDir, 'setup.md')) : null;
      const testText = profileDir ? safeReadText(join(profileDir, 'test.md')) : null;

      const capabilities = parseCapabilitiesYaml(capText, repoPath);
      if (capabilities?.relations?.length) {
        for (const rel of capabilities.relations) {
          allRelations.push(rel);
        }
      }

      const profileFiles = {
        capabilities: Boolean(capText),
        overview: Boolean(overviewText),
        setup: Boolean(setupText),
        test: Boolean(testText),
      };
      const profileCount = Object.values(profileFiles).filter(Boolean).length;

      const git = mounted && resolvedSourceDir ? await inspectGitStatus(resolvedSourceDir) : null;
      const col = topoEntry.col || classifyColumnFallback(id, indexEntry.domainLabel);
      const stack = formatRuntimeBadge(capabilities, topoEntry, indexEntry.domainLabel);

      return {
        id,
        path: repoPath,
        col,
        stack,
        domainLabel: indexEntry.domainLabel || topoEntry.stack || col,
        summary: indexEntry.summary || topoEntry.topologyRole || `${id} repository`,
        entryHint: indexEntry.entryHint || topoEntry.endpointInfo || '',
        remote: extraEntry?.remote || initEntry?.remote || `ssh://git@icode.baidu.com:8235/${repoPath}`,
        mounted,
        mountKind,
        symlinkTarget: symlinkTarget || initEntry?.options?.[0]?.path || null,
        branch: git?.branch || null,
        dirtyCount: git?.dirtyCount ?? 0,
        dirtyLabel: git?.dirtyLabel || null,
        lenses: inferFeatureLenses(id),
        profileCount,
        profileFiles,
        runtime: capabilities?.runtime || {},
        packageManager: capabilities?.packageManager || null,
        commands: capabilities?.commands || [],
        docs: {
          overview: overviewText,
          setup: setupText,
          test: testText,
          capabilities: capText,
        },
      };
    })
  );

  const repoByPath = new Map(repos.map(r => [r.path, r]));
  const repoById = new Map(repos.map(r => [r.id, r]));
  const knownIds = new Set(repos.map(r => r.id));

  // Normalize edges to short repo IDs and deduplicate
  const edgeMap = new Map();
  for (const rel of allRelations) {
    const fromRepo = repoByPath.get(rel.from) || repoById.get(basename(rel.from));
    const toRepo = repoByPath.get(rel.to) || repoById.get(basename(rel.to));
    if (!fromRepo || !toRepo || fromRepo.id === toRepo.id) continue;
    const key = `${fromRepo.id}->${toRepo.id}`;
    if (!edgeMap.has(key)) {
      edgeMap.set(key, {
        id: key,
        from: fromRepo.id,
        fromPath: fromRepo.path,
        to: toRepo.id,
        toPath: toRepo.path,
        kind: rel.kind || 'consumer',
        contract: rel.contract || '',
        jointRegression: Boolean(rel.joint_regression),
        note: rel.note || '',
        source: 'roma.repo-relations/v1',
      });
    }
  }

  for (const implicit of buildImplicitTopologyEdges(knownIds)) {
    const key = `${implicit.from}->${implicit.to}`;
    const reverseKey = `${implicit.to}->${implicit.from}`;
    if (!edgeMap.has(key) && !edgeMap.has(reverseKey)) {
      const fromRepo = repoById.get(implicit.from);
      const toRepo = repoById.get(implicit.to);
      edgeMap.set(key, {
        id: key,
        from: implicit.from,
        fromPath: fromRepo?.path || implicit.from,
        to: implicit.to,
        toPath: toRepo?.path || implicit.to,
        kind: implicit.kind,
        contract: implicit.contract,
        jointRegression: implicit.joint_regression,
        note: implicit.contract,
        source: implicit.source,
      });
    }
  }

  const edges = [...edgeMap.values()];
  const sdkGates = isCustom
    ? { available: false, filePath: '', flags: [], nonBaselineCount: 0 }
    : parseAndroidSdkFlags(root);

  // Mark repos with active non-baseline SDK flags
  const flaggedRepoIds = new Set(
    sdkGates.flags.filter(f => f.isNonBaseline).map(f => f.repoId)
  );
  for (const repo of repos) {
    repo.sdkFlagActive = flaggedRepoIds.has(repo.id);
  }

  // Count workspace skills & agents
  let skillCount = 0;
  let agentCount = 0;
  if (!isCustom) {
    const skillsDir = join(root, 'skills');
    const agentsDir = join(root, 'agents');
    try {
      if (existsSync(skillsDir)) {
        skillCount = readdirSync(skillsDir, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.')).length;
      }
      if (existsSync(agentsDir)) {
        agentCount = readdirSync(agentsDir, { withFileTypes: true }).filter(d => d.isFile() && d.name.endsWith('.md') && d.name !== 'README.md').length;
      }
    } catch {
      // ignore
    }
  }

  return {
    version: 'phase1-v1',
    linked: true,
    sampledAt: Date.now(),
    workspace: {
      name: isCustom ? '自定义仓库集' : basename(root),
      path: root,
      isRoma: isCustom ? false : isRomaWorkspace(root),
      totalRepos: repos.length,
      mountedRepos: repos.filter(r => r.mounted).length,
      skippedRepos: repos.filter(r => !r.mounted).length,
      skillCount,
      agentCount,
    },
    columns: ARCHITECTURAL_COLUMNS,
    lenses: FEATURE_LENSES,
    repos,
    edges,
    sdkGates,
  };
}

