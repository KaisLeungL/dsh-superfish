import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StewardStore } from '../../src/storage/store.js';
import {
  CallerAuthority,
  CallerDenied,
  CONTEXT_TOOLS,
  MEMORY_TOOLS,
  MEMORY_WRITE_TOOLS,
  PERSONAL_TOOLS,
  READ_TOOLS,
  SCHEDULE_PRESET,
  SESSION_TOOLS,
  WORKER_PRESET,
  type CallerHost,
} from '../../src/tools/authority.js';
import { BOARD_CONTEXT, contextToolDefinitions } from '../../src/tools/context.js';
import {
  ScopedMemoryReads,
  memoryReadToolDefinitions,
  memoryWriteToolDefinitions,
  withMemoryContext,
} from '../../src/tools/memory.js';
import { MemoryService, type MemoryCounts, type PublicMemoryItem } from '../../src/app/memory/service.js';
import { DEFAULT_CHAT_SOUL } from '../../src/app/health/chat-input.js';
import { AUTO_MEMORY_MIRROR_HEADER, AUTO_SOUL_HEADER, WorkspaceMarkdownLoader, truncateUtf8Safe } from '../../src/prompts/soul.js';
import { ROUTER_PRESET } from '../../src/sessions/manager.js';

const root = process.env.B03_RUN_DIR;
assert.ok(root?.includes('/.superagent-product-lab/b03/runs/'));

function fixture(t: TestContext) {
  const runId = randomUUID();
  const wsDir = resolve(root!, 'ws-' + runId);
  const globalDir = resolve(root!, 'dsh-home-' + runId);
  mkdirSync(resolve(wsDir, '.dsh'), { recursive: true });
  mkdirSync(globalDir, { recursive: true });

  const identity = { instanceId: randomUUID(), domainId: 'memory-and-soul-tools' };
  const store = StewardStore.initializeFresh(resolve(root!, runId + '.sqlite'), identity);
  t.after(() => store.close());
  store.registerResource('R', { workspaceId: 'W1', repositoryId: 'P1' });
  store.appendPolicy(0, { resources: ['R'], audiences: [], mandate: { actions: ['read'], expiresAt: 9999999999999 }, proofRef: 'human' });
  const reserved = store.reserveManager(store.manager().revision, 'router-session', 'W1', ROUTER_PRESET);
  store.bindManager(reserved.revision, { sessionId: 'router-session', workspaceId: 'W1', preset: ROUTER_PRESET, nativeLogRef: 'native:router' });
  store.recordLifecycle(store.manager().revision, 'running', false);

  const routerAgent = { id: 'router-session' };
  const scheduledAgent = { id: 'scheduled-summary-1' };
  const workerAgent = { id: 'worker-session' };
  let foreground = true;
  let scheduledAllowed = true;
  const fixedNow = new Date(2026, 10, 14, 9, 0, 0).getTime();

  const host: CallerHost<{ id: string }> = {
    identity,
    agent: id => {
      if (id === routerAgent.id) return routerAgent;
      if (id === scheduledAgent.id) return scheduledAgent;
      if (id === workerAgent.id) return workerAgent;
      return undefined;
    },
    isRuntimeRoot: () => true,
    preset: candidate => {
      if (candidate === routerAgent) return ROUTER_PRESET;
      if (candidate === scheduledAgent) return SCHEDULE_PRESET;
      return WORKER_PRESET;
    },
    workspace: () => 'W1',
    policy: () => ({
      revision: 'host-memory',
      backend: 'native',
      resources: ['R'],
      tools: [...READ_TOOLS, ...CONTEXT_TOOLS, ...SESSION_TOOLS, ...PERSONAL_TOOLS, ...MEMORY_TOOLS],
      actions: ['read'],
      audiences: [],
      maxTokens: 2048,
      allBoardProjects: true,
    }),
    admission: () => undefined,
    task: () => undefined,
    defaultPermission: () => 'read-only',
    hasForegroundInput: candidate => foreground && candidate === routerAgent,
    isScheduledSession: candidate => scheduledAllowed && candidate === scheduledAgent,
    assertAvailable() {},
    now: () => fixedNow,
  };

  const markdownLoader = new WorkspaceMarkdownLoader(wsDir, globalDir);
  const memoryService = new MemoryService(store.path + '.memory.sqlite', {
    workspaceId: 'W1',
    workspacePath: wsDir,
    assertCurrent() {},
    readUserMemoryMarkdown: () => markdownLoader.readUserMemoryMarkdown(),
  });
  t.after(() => memoryService.close());

  const authority = new CallerAuthority(store, host);
  const memoryReads = new ScopedMemoryReads(authority, {
    assertAvailable() {},
    workspaceId: () => 'W1',
    searchMemories: filter => memoryService.searchMemories(filter),
    now: () => fixedNow,
  });
  t.after(() => memoryReads.dispose());

  return {
    store,
    wsDir,
    globalDir,
    markdownLoader,
    memoryService,
    authority,
    memoryReads,
    routerAgent,
    scheduledAgent,
    workerAgent,
    setForeground: (value: boolean) => { foreground = value; },
    setScheduledAllowed: (value: boolean) => { scheduledAllowed = value; },
    callSearch: (agent: { id: string } = routerAgent) => ({
      agent,
      signal: new AbortController().signal,
      name: MEMORY_TOOLS[0],
    }),
  };
}

test('WorkspaceMarkdownLoader 加载全局与工作区 SOUL.md、支持 mtime 缓存更新与 UTF-8 安全截断，并跳过自动导出的 .dsh/MEMORY.md', t => {
  const f = fixture(t);
  assert.equal(f.markdownLoader.renderSoulSection(), '');

  writeFileSync(resolve(f.globalDir, 'SOUL.md'), '# 全局人设\n- 称呼用户为老梁\n- 模板占位符 {{USER_NAME}} 原样保留\n', 'utf8');
  writeFileSync(resolve(f.wsDir, 'SOUL.md'), '# 工作区规范\n- 代码示例优先使用 TypeScript Strict 模式\n', 'utf8');

  const rendered = f.markdownLoader.renderSoulSection();
  assert.match(rendered, /来自 soul\.md/u);
  assert.match(rendered, /\[全局 SOUL\.md\]/u);
  assert.match(rendered, /称呼用户为老梁/u);
  assert.match(rendered, /\{\{USER_NAME\}\}/u);
  assert.match(rendered, /\[当前工作区 SOUL\.md\]/u);
  assert.match(rendered, /TypeScript Strict/u);

  // 自动导出的 .dsh/MEMORY.md 带有 AUTO_MEMORY_MIRROR_HEADER，不会被当成用户手写 MEMORY.md 重复注入
  writeFileSync(resolve(f.wsDir, '.dsh/MEMORY.md'), `${AUTO_MEMORY_MIRROR_HEADER}\n# 自动镜像\n`, 'utf8');
  assert.equal(f.markdownLoader.readUserMemoryMarkdown(), undefined);

  // 用户在工作区根目录手写的 MEMORY.md 会被正常读取
  writeFileSync(resolve(f.wsDir, 'MEMORY.md'), '- 核心架构：采用 Cordis 插件体系与 SQLite WAL 存储\n', 'utf8');
  const userMem = f.markdownLoader.readUserMemoryMarkdown();
  assert.ok(userMem);
  assert.equal(userMem.name, 'MEMORY.md');
  assert.match(userMem.content, /Cordis 插件体系/u);

  // UTF-8 多字节字符安全截断不产生乱码替换符
  const longChinese = '鱼'.repeat(100);
  const truncated = truncateUtf8Safe(longChinese, 32);
  assert.equal(truncated.includes('\uFFFD'), false);
  assert.equal(Buffer.byteLength(truncated, 'utf8') <= 32, true);
});

test('WorkspaceMarkdownLoader 跳过未手动修改的自动生成 .dsh/SOUL.md 避免与内存 Soul 配置重复注入，并在用户手工编辑后生效', t => {
  const f = fixture(t);
  f.markdownLoader.syncWorkspaceSoulMarkdown({ ...DEFAULT_CHAT_SOUL, syncSoulMarkdown: true });

  // 自动生成且未改动时，renderSoulSection 跳过 .dsh/SOUL.md，避免与 workspace-superagent-soul 重复注入
  assert.equal(f.markdownLoader.renderSoulSection(DEFAULT_CHAT_SOUL.botName, DEFAULT_CHAT_SOUL), '');

  // 用户在编辑器中手动追加了自定义要求（即便保留了 AUTO_SOUL_HEADER 注释头），renderSoulSection 会识别并注入且剥离注释头
  const autoSoulPath = resolve(f.wsDir, '.dsh/SOUL.md');
  const existing = readFileSync(autoSoulPath, 'utf8');
  writeFileSync(autoSoulPath, `${existing}\n- **专属暗号**：每次复盘结尾附带一句粤语鼓励\n`, 'utf8');
  const editedRendered = f.markdownLoader.renderSoulSection(DEFAULT_CHAT_SOUL.botName, DEFAULT_CHAT_SOUL);
  assert.match(editedRendered, /每次复盘结尾附带一句粤语鼓励/u);
  assert.equal(editedRendered.includes(AUTO_SOUL_HEADER), false);

  // 关闭 syncSoulMarkdown 时自动清理带 AUTO_SOUL_HEADER 的生成文件
  f.markdownLoader.syncWorkspaceSoulMarkdown({ ...DEFAULT_CHAT_SOUL, syncSoulMarkdown: false });
  assert.equal(f.markdownLoader.renderSoulSection(DEFAULT_CHAT_SOUL.botName, DEFAULT_CHAT_SOUL), '');
});

test('MemoryService 支持 SQLite FTS5 中英文检索、同名覆盖去重、核心记忆渲染与 .dsh/MEMORY.md 自动镜像同步', t => {
  const f = fixture(t);
  writeFileSync(resolve(f.wsDir, 'MEMORY.md'), '- 工作区固定背景：DSH Super Workbench 桌面端工作台', 'utf8');

  const first = f.memoryService.saveMemory('router-session', {
    category: 'preference',
    title: '早报输出格式偏好',
    content: '早报控制在 5 条以内，先列逾期项再列今日高优待办',
    tags: ['早报', '格式'],
    pinned: true,
  });
  assert.equal(first.action, 'created');
  assert.equal(first.item.pinned, true);

  // 相同 category + title 自动更新原记录而非重复插入
  const updated = f.memoryService.saveMemory('router-session', {
    category: 'preference',
    title: '早报输出格式偏好',
    content: '早报控制在 3 条核心重点以内，先列逾期项再列今日高优待办',
    tags: ['早报', '精简'],
    pinned: true,
  });
  assert.equal(updated.action, 'updated');
  assert.equal(updated.item.id, first.item.id);
  assert.equal(updated.item.revision, 2);

  const arch = f.memoryService.saveMemory('router-session', {
    category: 'decision',
    title: 'SQLite schema_hash 校验排障经验',
    content: 'StewardStore 主库校验固定 schema_hash，新增业务表必须使用独立 sidecar SQLite 文件',
    tags: ['sqlite', 'schema'],
    pinned: false,
  });
  assert.equal(arch.action, 'created');

  // FTS5 中文关键词搜索
  const zhSearch = f.memoryService.searchMemories({ query: '逾期 早报' });
  assert.equal(zhSearch.items.length, 1);
  assert.equal(zhSearch.items[0]!.id, first.item.id);

  // FTS5 英文+中文混合搜索
  const mixSearch = f.memoryService.searchMemories({ query: 'sidecar 排障' });
  assert.equal(mixSearch.items.length, 1);
  assert.equal(mixSearch.items[0]!.id, arch.item.id);

  // 核心记忆渲染同时包含用户手写 MEMORY.md 与 pinned=true 条目，不包含普通归档条目
  const coreSection = f.memoryService.renderCoreMemorySection();
  assert.match(coreSection, /DSH Super Workbench 桌面端工作台/u);
  assert.match(coreSection, /早报输出格式偏好/u);
  assert.equal(coreSection.includes('SQLite schema_hash 校验排障经验'), false);

  // 验证 .dsh/MEMORY.md 镜像已自动生成且包含全部记忆
  const mirrorText = readFileSync(resolve(f.wsDir, '.dsh/MEMORY.md'), 'utf8');
  assert.equal(mirrorText.startsWith(AUTO_MEMORY_MIRROR_HEADER), true);
  assert.match(mirrorText, /早报输出格式偏好/u);
  assert.match(mirrorText, /SQLite schema_hash 校验排障经验/u);

  // 删除记忆后同步更新
  const del = f.memoryService.deleteMemory(arch.item.id);
  assert.equal(del.deleted, true);
  assert.equal(f.memoryService.counts().total, 1);
});

test('前台主理与定时会话可通过 steward_search_memories 与 dsh_context_query(personal.memory) 读取记忆，写工具仅限前台已接纳主理调用', async t => {
  const f = fixture(t);

  const readTools = memoryReadToolDefinitions(f.memoryReads);
  assert.equal(readTools.length, 1);
  assert.equal(readTools[0]!.name, 'steward_search_memories');

  let writeAdmitted = true;
  const writeTools = memoryWriteToolDefinitions(
    {
      saveMemory: (sessionId, item) => f.memoryService.saveMemory(sessionId, item),
      deleteMemory: id => f.memoryService.deleteMemory(id),
    },
    exec => {
      if (!writeAdmitted || exec.agent !== f.routerAgent) throw new CallerDenied('PROPOSAL_NOT_ADMITTED');
      return { session: f.routerAgent.id, turn: 1 };
    },
  );
  const saveTool = writeTools.find(tool => tool.name === MEMORY_WRITE_TOOLS[0])!;
  const deleteTool = writeTools.find(tool => tool.name === MEMORY_WRITE_TOOLS[1])!;

  // 前台主理写入两条长期记忆
  const saved1 = await saveTool.execute(
    {
      category: 'decision',
      title: 'PR 提交规范',
      content: '所有 PR 标题遵循 Conventional Commits，合并前必须通过 build 与 check',
      tags: ['git', 'pr'],
      pinned: true,
    },
    { agent: f.routerAgent, signal: new AbortController().signal, name: saveTool.name },
  ) as { status: string; action: string; item: PublicMemoryItem };
  assert.equal(saved1.status, 'ok');
  assert.equal(saved1.action, 'created');

  await saveTool.execute(
    {
      category: 'project',
      title: '看板周报汇总口径',
      content: '每周五晚报需汇总本周完成的看板卡片与遗留阻塞项',
      pinned: false,
    },
    { agent: f.routerAgent, signal: new AbortController().signal, name: saveTool.name },
  );

  // 非前台或定时会话尝试调用写工具立即拒绝
  writeAdmitted = false;
  await assert.rejects(
    async () => saveTool.execute(
      { category: 'fact', title: '非法写入', content: '不应成功' },
      { agent: f.scheduledAgent, signal: new AbortController().signal, name: saveTool.name },
    ),
    { code: 'PROPOSAL_NOT_ADMITTED' },
  );
  writeAdmitted = true;

  // 前台主理通过 steward_search_memories 检索
  const routerRes = await f.memoryReads.execute(
    { selector: { query: 'Conventional Commits' } },
    f.callSearch(f.routerAgent),
  ) as { readScope: string; items: PublicMemoryItem[]; counts: MemoryCounts };
  assert.equal(routerRes.readScope, 'workspace-personal-memory');
  assert.equal(routerRes.counts.total, 2);
  assert.equal(routerRes.counts.pinned, 1);
  assert.equal(routerRes.items.length, 1);
  assert.equal(routerRes.items[0]!.title, 'PR 提交规范');

  // 定时会话在主理 paused 时仍可调用 steward_search_memories 与 dsh_context_query(personal.memory)
  f.store.recordLifecycle(f.store.manager().revision, 'paused', false);
  f.setForeground(false);

  const scheduledRes = await f.memoryReads.execute(
    { selector: { category: 'project' } },
    f.callSearch(f.scheduledAgent),
  ) as { items: PublicMemoryItem[] };
  assert.equal(scheduledRes.items.length, 1);
  assert.equal(scheduledRes.items[0]!.title, '看板周报汇总口径');

  const compositeContext = withMemoryContext(() => undefined, () => f.memoryReads);
  const ctxTools = contextToolDefinitions(
    f.authority,
    { grants: BOARD_CONTEXT, service: () => compositeContext },
    'W1',
  );
  const catalogTool = ctxTools.find(tool => tool.name === 'dsh_context_catalog')!;
  const queryTool = ctxTools.find(tool => tool.name === 'dsh_context_query')!;

  const catalogRes = await catalogTool.execute(
    {},
    { agent: f.scheduledAgent, signal: new AbortController().signal, name: 'dsh_context_catalog' },
  ) as { capabilities: { id: string }[] };
  assert.ok(catalogRes.capabilities.some(c => c.id === 'personal.memory'));

  const ctxQueryRes = await queryTool.execute(
    { capability: 'personal.memory', filter: { pinned: true } },
    { agent: f.scheduledAgent, signal: new AbortController().signal, name: 'dsh_context_query' },
  ) as { status: string; items: PublicMemoryItem[] };
  assert.equal(ctxQueryRes.status, 'ok');
  assert.equal(ctxQueryRes.items.length, 1);
  assert.equal(ctxQueryRes.items[0]!.title, 'PR 提交规范');

  // 恢复前台主理并删除记忆
  f.store.recordLifecycle(f.store.manager().revision, 'running', false);
  f.setForeground(true);
  const delRes = await deleteTool.execute(
    { id: saved1.item.id },
    { agent: f.routerAgent, signal: new AbortController().signal, name: deleteTool.name },
  ) as { status: string; deleted: boolean };
  assert.equal(delRes.status, 'ok');
  assert.equal(delRes.deleted, true);
});
