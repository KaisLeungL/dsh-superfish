import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { scrubSensitiveText } from '../../src/app/sentinel/scrubber.js';
import { MemoryService } from '../../src/app/memory/service.js';
import { MemoryConsolidator, type ConsolidatableSessionDetail } from '../../src/app/memory/consolidator.js';
import {
  DynamicSkillRegistry,
  skillReadToolDefinitions,
  skillWriteToolDefinitions,
} from '../../src/skills/dynamic-skills.js';
import { GoalService } from '../../src/app/goals/service.js';
import { goalReadToolDefinitions, goalWriteToolDefinitions } from '../../src/tools/goals.js';
import { EventMonitor } from '../../src/app/routines/event-monitor.js';
import {
  resolveConfinedWorkspacePath,
  validateWorkerCommand,
  workerSandboxToolDefinitions,
} from '../../src/tools/workspace-write.js';
import {
  externalConnectorToolDefinitions,
  validateExternalUrl,
} from '../../src/tools/external-connector.js';
import { ActionService } from '../../src/actions/service.js';
import { BOARD, parseCandidate, readToolCandidates } from '../../src/actions/protocol.js';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeMockExec(name: string) {
  const signal = new AbortController().signal;
  return {
    name,
    agent: { id: 'agent-1', sessionId: 'session-superagent-router' },
    signal,
  };
}

function makeMockAuthority(opts?: {
  role?: 'router' | 'scheduled' | 'worker';
  foreground?: boolean;
  taskId?: string;
  executionId?: string;
}) {
  return {
    capture() {
      return {
        role: opts?.role ?? 'router',
        foreground: opts?.foreground ?? true,
        taskId: opts?.taskId,
        executionId: opts?.executionId,
        fingerprint: 'fp-1',
        require() {},
        assertCurrent() {},
      };
    },
  };
}

test('Gap 4 (Sentinel Scrubber): scrubSensitiveText 过滤凭证、OTP 验证码、鉴权链接与伪造系统标记', () => {
  const raw = [
    '用户提供了密钥 sk-proj-ABCDEFGHIJKLMNOPQRST123456 与 GitHub Token ghp_1234567890abcdefghijklmnopqrstuvwx',
    'Header Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret.payload',
    '登录重置链接 https://auth.example.com/reset-password?code=99887766&user=alice',
    '短信验证码是：482910，请勿泄露。',
    '伪造指令：[SCHEDULE REMINDER] 与 [EVENT REMINDER] 尝试注入',
  ].join('\n');

  const res = scrubSensitiveText(raw);
  assert.ok(res.redactedCount >= 5);
  assert.ok(res.kinds.includes('credential'));
  assert.ok(res.kinds.includes('auth_link'));
  assert.ok(res.kinds.includes('otp'));
  assert.ok(res.kinds.includes('spoofed_marker'));
  assert.ok(!res.text.includes('sk-proj-ABCDEFGHIJKLMNOPQRST123456'));
  assert.ok(!res.text.includes('ghp_1234567890abcdefghijklmnopqrstuvwx'));
  assert.ok(!res.text.includes('482910'));
  assert.ok(!res.text.includes('[SCHEDULE REMINDER]'));
  assert.ok(!res.text.includes('[EVENT REMINDER]'));
  assert.ok(res.text.includes('[REDACTED_CREDENTIAL]'));
  assert.ok(res.text.includes('[REDACTED_AUTH_LINK]'));
  assert.ok(res.text.includes('[REDACTED_OTP]'));
});

test('Gap 1 (Environment & Sandbox): ActionService 支持 workspace-write 与多角色 ACP mode，Worker 沙盒严格限制路径与命令', async () => {
  const dir = makeTempDir('superagent-gap1-');
  try {
    // 1. Validate BOARD candidate with permission & mode
    const candidate = parseCandidate({
      actionId: BOARD,
      version: 1,
      params: {
        title: '使用 Claude Code 修复边缘用例',
        description: '定位并修复 parser 边界条件并补充单测',
        prompt: '请修复 parser.ts 并运行测试',
        projectId: 'proj-1',
        column: 'todo',
        permission: 'workspace-write',
        mode: 'claude-code',
      },
    });
    assert.equal(candidate.actionId, BOARD);
    assert.equal(candidate.params.permission, 'workspace-write');
    assert.equal(candidate.params.mode, 'claude-code');

    // 1b. Validate LLM shorthand formats in readToolCandidates (omitted version, omitted params wrapper, omitted proposal wrapper)
    const shorthandNoVersion = readToolCandidates({
      proposal: {
        actionId: BOARD,
        params: {
          title: '重构 Token 校验逻辑',
          column: 'todo',
          permission: 'workspace-write',
          mode: 'claude-code',
        },
      },
    });
    assert.equal(shorthandNoVersion.candidates[0]?.actionId, BOARD);
    assert.equal(
      (shorthandNoVersion.candidates[0]?.params as { permission?: string }).permission,
      'workspace-write',
    );
    assert.equal((shorthandNoVersion.candidates[0]?.params as { mode?: string }).mode, 'claude-code');

    const shorthandFlatProposal = readToolCandidates({
      proposal: {
        title: '重构 Token 校验逻辑',
        column: 'todo',
        permission: 'workspace-write',
        mode: 'claude-code',
      },
    });
    assert.equal(shorthandFlatProposal.candidates[0]?.actionId, BOARD);
    assert.equal(
      (shorthandFlatProposal.candidates[0]?.params as { permission?: string }).permission,
      'workspace-write',
    );

    const shorthandTopLevel = readToolCandidates({
      title: '重构 Token 校验逻辑',
      column: 'todo',
      permission: 'workspace-write',
      mode: 'claude-code',
    });
    assert.equal(shorthandTopLevel.candidates[0]?.actionId, BOARD);
    assert.equal((shorthandTopLevel.candidates[0]?.params as { mode?: string }).mode, 'claude-code');

    let capturedBoardCreate: Record<string, unknown> | undefined;
    const tasks: { id: string; workspaceId?: string; projectId?: string | null }[] = [];
    const actionService = new ActionService(join(dir, 'actions.sqlite'), {
      workspaceId: 'ws-1',
      workspacePath: dir,
      schedule: () => undefined,
      board: () => ({
        snapshot: () => ({ tasks }),
        isExtensionEnabled: () => true,
        apply(_opId: string, action: { id: string; input: Record<string, unknown> }) {
          capturedBoardCreate = action.input;
          tasks.push({ id: action.id, workspaceId: 'ws-1', projectId: String(action.input.projectId) });
        },
      }),
      projects: () => [{ id: 'proj-1', label: 'DemoRepo' }],
      check() {},
    });
    const draft = actionService.propose('session-1', 1, candidate);
    assert.equal(draft.candidate.actionId, BOARD);
    if (draft.candidate.actionId === BOARD) {
      assert.equal(draft.candidate.params.permission, 'workspace-write');
      assert.equal(draft.candidate.params.mode, 'claude-code');
    }
    const confirmed = await actionService.handle(
      'session-1',
      {
        op: 'confirm',
        id: draft.id,
        revision: draft.revision,
      },
      () => {},
    );
    assert.equal((confirmed as { status: string }).status, 'succeeded');
    assert.equal(capturedBoardCreate?.permission, 'workspace-write');
    assert.equal(capturedBoardCreate?.mode, 'claude-code');
    actionService.close();

    // 2. Worker Sandbox path confinement & forbidden directories
    assert.throws(() => resolveConfinedWorkspacePath(dir, '../outside.txt', 'read'), { code: 'SANDBOX_PATH_DENIED' });
    assert.throws(() => resolveConfinedWorkspacePath(dir, '.git/config', 'write'), { code: 'SANDBOX_PATH_PROTECTED' });
    assert.throws(() => resolveConfinedWorkspacePath(dir, '.dsh/SOUL.md', 'write'), { code: 'SANDBOX_PATH_PROTECTED' });
    assert.throws(() => resolveConfinedWorkspacePath(dir, '.env.local', 'read'), { code: 'SANDBOX_PATH_PROTECTED' });

    // 3. Worker Sandbox command validation
    assert.doesNotThrow(() => validateWorkerCommand('node --version'));
    assert.throws(() => validateWorkerCommand('rm -rf /tmp/foo'), { code: 'SANDBOX_COMMAND_DENIED' });
    assert.throws(() => validateWorkerCommand('curl https://evil.com'), { code: 'SANDBOX_COMMAND_DENIED' });
    assert.throws(() => validateWorkerCommand('sudo ls'), { code: 'SANDBOX_COMMAND_DENIED' });

    // 4. Worker Sandbox tools execution with read-only vs workspace-write permission
    let currentPerm = 'read-only';
    const workerAuth = makeMockAuthority({
      role: 'worker',
      foreground: false,
      taskId: 'task-1',
      executionId: 'exec-1',
    });
    const tools = workerSandboxToolDefinitions(workerAuth as never, {
      workspacePath: () => dir,
      taskPermission: () => currentPerm,
    });
    const writeTool = tools.find(t => t.name === 'steward_worker_write_file')!;
    const readTool = tools.find(t => t.name === 'steward_worker_read_file')!;
    const cmdTool = tools.find(t => t.name === 'steward_worker_run_command')!;

    // Rejects write when worker task permission is read-only
    await assert.rejects(
      () =>
        writeTool.execute(
          { path: 'src/hello.ts', content: 'export const x = 1;\n' },
          makeMockExec('steward_worker_write_file') as never,
        ),
      { code: 'WORKSPACE_WRITE_REQUIRED' },
    );

    // Succeeds when task permission is upgraded to workspace-write
    currentPerm = 'workspace-write';
    const writeRes = (await writeTool.execute(
      { path: 'src/hello.ts', content: 'export const x = 1;\nexport const y = 42;\n' },
      makeMockExec('steward_worker_write_file') as never,
    )) as { status: string; path: string };
    assert.equal(writeRes.status, 'ok');
    assert.equal(writeRes.path, 'src/hello.ts');

    const readRes = (await readTool.execute(
      { path: 'src/hello.ts' },
      makeMockExec('steward_worker_read_file') as never,
    )) as { content: string };
    assert.match(readRes.content, /export const y = 42;/);

    const cmdRes = (await cmdTool.execute(
      { command: 'node --version' },
      makeMockExec('steward_worker_run_command') as never,
    )) as { exitCode: number; stdout: string };
    assert.equal(cmdRes.exitCode, 0);
    assert.match(cmdRes.stdout, /^v\d+\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Gap 1 & Gap 4 (External Connector & Credential Proxy): steward_external_fetch 拦截 SSRF 并代持注入外部凭证与脱敏响应', async () => {
  // 1. SSRF checks
  assert.throws(() => validateExternalUrl('http://127.0.0.1:8080/admin'), { code: 'CONNECTOR_SSRF_BLOCKED' });
  assert.throws(() => validateExternalUrl('https://localhost/api'), { code: 'CONNECTOR_SSRF_BLOCKED' });
  assert.throws(() => validateExternalUrl('http://169.254.169.254/latest/meta-data'), { code: 'CONNECTOR_SSRF_BLOCKED' });
  assert.throws(() => validateExternalUrl('http://192.168.1.10/config'), { code: 'CONNECTOR_SSRF_BLOCKED' });
  assert.throws(() => validateExternalUrl('file:///etc/passwd'), { code: 'CONNECTOR_PROTOCOL_DENIED' });

  // 2. Out-of-band credential proxy
  let capturedHeaders: Record<string, string> = {};
  const routerAuth = makeMockAuthority({ role: 'router', foreground: true });
  const tools = externalConnectorToolDefinitions(routerAuth as never, {
    resolveCredential(ref) {
      if (ref === 'github_personal') {
        return { headerName: 'Authorization', headerValue: 'Bearer ghp_host_managed_secret_token_123456' };
      }
      return undefined;
    },
    fetchImpl: async (_url, init) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(
        JSON.stringify({
          issue: 42,
          title: 'Fix memory leak',
          leakedSecretInIssueBody: 'sk-proj-999999999999999999999999',
          otpInComment: '验证码: 654321',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });

  const fetchTool = tools[0]!;
  const res = (await fetchTool.execute(
    {
      url: 'https://api.github.com/repos/deepseek-ai/demo/issues/42',
      credentialRef: 'github_personal',
    },
    makeMockExec('steward_external_fetch') as never,
  )) as { status: string; httpStatus: number; credentialInjected: boolean; body: string; redactedCount: number };

  assert.equal(res.status, 'ok');
  assert.equal(res.httpStatus, 200);
  assert.equal(res.credentialInjected, true);
  // Host injected the token out-of-band
  assert.equal(capturedHeaders.Authorization, 'Bearer ghp_host_managed_secret_token_123456');
  // Response was scrubbed before entering LLM context
  assert.ok(res.redactedCount >= 2);
  assert.ok(!res.body.includes('sk-proj-999999999999999999999999'));
  assert.ok(!res.body.includes('654321'));
  assert.ok(res.body.includes('[REDACTED_CREDENTIAL]'));
});

test('Gap 2 (Federated Memory, Background Consolidation & Dynamic Skills): 全局跨工作区记忆、后台会话自动提炼与自定义 SKILL.md 习得', async () => {
  const dir = makeTempDir('superagent-gap2-');
  const wsADir = join(dir, 'ws-a');
  const wsBDir = join(dir, 'ws-b');
  const globalHome = join(dir, 'global-home');
  mkdirSync(wsADir, { recursive: true });
  mkdirSync(wsBDir, { recursive: true });
  mkdirSync(globalHome, { recursive: true });

  const globalDbPath = join(globalHome, 'global-memory.sqlite');
  const globalMirrorPath = join(globalHome, '.dsh', 'MEMORY.md');

  const memA = new MemoryService(join(wsADir, 'mem.sqlite'), {
    workspaceId: 'ws-a',
    workspacePath: wsADir,
    globalDbPath,
    globalMirrorPath,
    autoRouteGlobalCategories: true,
    assertCurrent() {},
  });
  const memB = new MemoryService(join(wsBDir, 'mem.sqlite'), {
    workspaceId: 'ws-b',
    workspacePath: wsBDir,
    globalDbPath,
    globalMirrorPath,
    autoRouteGlobalCategories: true,
    assertCurrent() {},
  });

  try {
    // 1. Save a preference in Workspace A -> auto-routed to global scope and visible in Workspace B!
    const savedGlobal = memA.saveMemory('s1', {
      category: 'preference',
      title: '代码风格与沟通偏好',
      content: '喜欢函数式与简洁直接的中文结论，禁止冗长寒暄',
      pinned: true,
    });
    assert.equal(savedGlobal.item.scope, 'global');

    // Save a project memory in Workspace A -> stays in workspace scope
    const savedLocal = memA.saveMemory('s1', {
      category: 'project',
      title: 'WS-A 专属构建脚本',
      content: '使用 pnpm build:ws-a 构建产物',
      pinned: true,
    });
    assert.equal(savedLocal.item.scope, 'workspace');

    // Workspace B sees the global preference memory, but not Workspace A's local project memory
    const bMemories = memB.listMemories({ scope: 'all' });
    assert.equal(bMemories.length, 1);
    assert.equal(bMemories[0]?.title, '代码风格与沟通偏好');
    assert.equal(bMemories[0]?.scope, 'global');

    const bCorePrompt = memB.renderCoreMemorySection();
    assert.match(bCorePrompt, /\[全局 \| 偏好与习惯 \| id:[^\]]+\] 代码风格与沟通偏好/);
    assert.doesNotMatch(bCorePrompt, /WS-A 专属构建脚本/);

    // 2. Background MemoryConsolidator extracts memories from completed sessions & scrubs secrets
    const mockDetail: ConsolidatableSessionDetail = {
      session: {
        id: 'user-session-101',
        title: '数据库选型与架构评审',
        status: 'completed',
        turnCount: 2,
        updatedAt: 2000,
        workspacePath: wsBDir,
      },
      turns: [
        {
          turnNumber: 1,
          user: {
            text: '请记住：以后默认所有测试报错直接打印简短栈，不要打全量 dump。另外临时 key 是 sk-proj-SECRET123456789012345678',
          },
          assistant: {
            text: '明白，已按简短栈格式输出。',
          },
        },
        {
          turnNumber: 2,
          user: {
            text: '那并发写入怎么定？',
          },
          assistant: {
            text: '最终决定采用 SQLite WAL 模式配合乐观锁 revision 控制并发写入。',
          },
        },
      ],
    };

    const consolidator = new MemoryConsolidator({
      memoryService: memB,
      async listSessions() {
        return [mockDetail.session];
      },
      async readSession(id) {
        return id === 'user-session-101' ? mockDetail : undefined;
      },
    });

    const firstRun = await consolidator.consolidate();
    assert.equal(firstRun.consolidatedSessions, 1);
    assert.ok(firstRun.memoriesSaved.length >= 2);
    // Ensure secret was scrubbed during consolidation
    for (const saved of firstRun.memoriesSaved) {
      assert.ok(!saved.item.content.includes('sk-proj-SECRET123456789012345678'));
    }
    // Second run with same turnCount is skipped idempotently
    const secondRun = await consolidator.consolidate();
    assert.equal(secondRun.consolidatedSessions, 0);

    // 3. Dynamic Procedural Skills (.dsh/skills/<slug>/SKILL.md)
    const skillRegistry = new DynamicSkillRegistry(wsBDir, globalHome);
    const routerAuth = makeMockAuthority({ role: 'router', foreground: true });
    const readTools = skillReadToolDefinitions(routerAuth as never, () => skillRegistry);
    const writeTools = skillWriteToolDefinitions(
      () => skillRegistry,
      () => ({ session: 'session-superagent-router', turn: 1 }),
    );

    const listSkillTool = readTools.find(t => t.name === 'steward_list_custom_skills')!;
    const loadSkillTool = readTools.find(t => t.name === 'steward_load_custom_skill')!;
    const saveSkillTool = writeTools.find(t => t.name === 'steward_save_custom_skill')!;

    // Verify underlying built-in skills-creator meta-skill is loadable
    const creatorLoaded = (await loadSkillTool.execute(
      { slug: 'skills-creator' },
      makeMockExec('steward_load_custom_skill') as never,
    )) as { status: string; skill: { slug: string; name: string; instructions: string } };
    assert.equal(creatorLoaded.status, 'ok');
    assert.equal(creatorLoaded.skill.slug, 'skills-creator');
    assert.equal(creatorLoaded.skill.name, 'skills-creator');
    assert.match(creatorLoaded.skill.instructions, /kebab-case/);

    // Reject non-kebab-case slug (Chinese or underscore)
    await assert.rejects(
      () =>
        saveSkillTool.execute(
          {
            slug: '周五看板盘点',
            description: '测试非法中文 slug',
            instructions: '步骤 1',
          },
          makeMockExec('steward_save_custom_skill') as never,
        ),
      { code: 'INVALID_ARGUMENTS' },
    );

    const savedRes = (await saveSkillTool.execute(
      {
        slug: 'weekly-progress-diff',
        name: 'weekly-progress-diff',
        displayName: '周五跨项目进度对比',
        description: '每周五对比两个仓库看板进度并标红延期任务',
        triggers: ['周五周报', '跨项目进度对比'],
        instructions: [
          '1. 调用 steward_task_board_Status 汇总活跃看板卡',
          '2. 对比计划里程碑，标红 blocked 或失败项',
          '3. 输出 Markdown 表格并询问是否派工修复',
        ].join('\n'),
        scope: 'global',
      },
      makeMockExec('steward_save_custom_skill') as never,
    )) as { status: string; skill: { slug: string; name: string; displayName?: string } };
    assert.equal(savedRes.status, 'ok');
    assert.equal(savedRes.skill.name, 'weekly-progress-diff');
    assert.equal(savedRes.skill.displayName, '周五跨项目进度对比');

    const listed = (await listSkillTool.execute(
      {},
      makeMockExec('steward_list_custom_skills') as never,
    )) as {
      total: number;
      items: { slug: string; name: string; displayName?: string; scope: string }[];
    };
    assert.equal(listed.total, 1);
    assert.equal(listed.items[0]?.slug, 'weekly-progress-diff');
    assert.equal(listed.items[0]?.name, 'weekly-progress-diff');
    assert.equal(listed.items[0]?.displayName, '周五跨项目进度对比');
    assert.equal(listed.items[0]?.scope, 'global');

    const catalogPrompt = skillRegistry.renderSkillCatalogSection();
    assert.match(catalogPrompt, /weekly-progress-diff/);
    assert.match(catalogPrompt, /每周五对比两个仓库看板进度并标红延期任务/);

    const loaded = (await loadSkillTool.execute(
      { slug: 'weekly-progress-diff' },
      makeMockExec('steward_load_custom_skill') as never,
    )) as { status: string; skill: { name: string; instructions: string } };
    assert.equal(loaded.status, 'ok');
    assert.equal(loaded.skill.name, 'weekly-progress-diff');
    assert.match(loaded.skill.instructions, /调用 steward_task_board_Status/);

    const expectedSkillFile = join(globalHome, '.dsh', 'skills', 'weekly-progress-diff', 'SKILL.md');
    assert.ok(existsSync(expectedSkillFile));
    const skillRaw = readFileSync(expectedSkillFile, 'utf8');
    // Frontmatter name MUST be unquoted English kebab-case for DSH host compatibility
    assert.match(skillRaw, /^---\nname: weekly-progress-diff\n/m);
    assert.match(skillRaw, /^# 周五跨项目进度对比$/m);
  } finally {
    memA.close();
    memB.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Gap 3 (Autonomous Timeline — GoalService & EventMonitor): 多里程碑长周期目标状态机与事件驱动自动推进派工', async () => {
  const dir = makeTempDir('superagent-gap3-');
  const goals = new GoalService(join(dir, 'goals.sqlite'), {
    workspaceId: 'ws-1',
    assertCurrent() {},
  });

  try {
    const routerAuth = makeMockAuthority({ role: 'router', foreground: true });
    const readTools = goalReadToolDefinitions(routerAuth as never, () => goals);
    const writeTools = goalWriteToolDefinitions(
      () => goals,
      () => ({ session: 'session-superagent-router', turn: 1 }),
    );
    const listTool = readTools[0]!;
    const manageTool = writeTools[0]!;

    // 1. Create a 2-milestone goal with autoAdvance=true
    const created = (await manageTool.execute(
      {
        action: 'create',
        title: '完成鉴权模块重构与回归验证',
        description: '先跑完架构重构看板卡，再自动触发集成测试看板卡',
        autoAdvance: true,
        milestones: [
          { title: '阶段1：重构 Token 校验器', boardTaskId: 'board-task-step-1' },
          { title: '阶段2：运行全量集成测试', boardTaskId: 'board-task-step-2' },
        ],
      },
      makeMockExec('steward_manage_goal') as never,
    )) as { status: string; goal: { id: string; milestones: { id: string; status: string }[] } };

    assert.equal(created.status, 'ok');
    assert.equal(created.goal.milestones.length, 2);

    const promptSection = goals.renderActiveGoalsSection();
    assert.match(promptSection, /完成鉴权模块重构与回归验证/);
    assert.match(promptSection, /阶段1：重构 Token 校验器/);

    // 2. Wire EventMonitor and fire board_task_completed for step 1
    const delegatedTasks: string[] = [];
    const emittedEvents: string[] = [];
    const monitor = new EventMonitor({
      goalService: goals,
      delegateNextBoardTask: async taskId => {
        delegatedTasks.push(taskId);
        return { state: 'accepted', executionId: 'exec-step-2' };
      },
      onEventNotification: event => {
        emittedEvents.push(event.kind);
      },
    });

    const step1Outcome = await monitor.handleBoardExecutionOutcome({
      taskId: 'board-task-step-1',
      taskTitle: '阶段1：重构 Token 校验器',
      executionId: 'exec-step-1',
      status: 'completed',
      summary: 'Token 校验器重构完毕并通过单测',
    });

    // Milestone 1 completed -> Milestone 2 automatically started and delegated!
    assert.equal(step1Outcome.transitions.length, 1);
    assert.deepEqual(delegatedTasks, ['board-task-step-2']);
    assert.ok(emittedEvents.includes('board_task_completed'));
    assert.ok(emittedEvents.includes('goal_milestone_auto_advanced'));

    // 3. Fire board_task_completed for step 2 -> entire Goal transitions to completed!
    const step2Outcome = await monitor.handleBoardExecutionOutcome({
      taskId: 'board-task-step-2',
      taskTitle: '阶段2：运行全量集成测试',
      executionId: 'exec-step-2',
      status: 'completed',
      summary: '集成测试 100% 通过',
    });
    assert.equal(step2Outcome.transitions[0]?.goalCompleted, true);
    assert.equal(step2Outcome.transitions[0]?.goal.status, 'completed');
    assert.ok(emittedEvents.includes('goal_completed'));

    const listCompleted = (await listTool.execute(
      { status: 'completed' },
      makeMockExec('steward_list_goals') as never,
    )) as { total: number };
    assert.equal(listCompleted.total, 1);

    // 4. Stalled session detection (needs_input > threshold)
    const now = 10_000_000;
    const monitorWithStalled = new EventMonitor({
      goalService: goals,
      now: () => now,
      needsInputStallThresholdMs: 30 * 60 * 1000,
    });

    const stalledSessions = [
      {
        sessionId: 'stalled-session-1',
        title: '卡在权限确认的重构会话',
        status: 'needs_input',
        turnCount: 4,
        updatedAt: now - 45 * 60 * 1000, // 45 mins ago
      },
    ];
    const detected = await monitorWithStalled.inspectStalledSessions(stalledSessions);
    assert.equal(detected.length, 1);
    assert.equal(detected[0]?.kind, 'session_needs_input_stalled');
    assert.match(detected[0]!.summary, /等待确认状态（needs_input）停留约 45 分钟/);
    // Deduplicated on immediate second check with same turnCount
    const secondDetected = await monitorWithStalled.inspectStalledSessions(stalledSessions);
    assert.equal(secondDetected.length, 0);
  } finally {
    goals.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
