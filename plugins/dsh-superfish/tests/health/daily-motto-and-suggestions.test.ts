import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanMotto, createDailyMotto, type MottoLlm } from '../../src/app/health/daily-motto.js';
import {
  FIXED_DAILY_REVIEW_SUGGESTION,
  assembleSuggestionPayload,
  createChatSuggestions,
  isTopicOverlap,
  parseLlmSuggestions,
} from '../../src/app/health/suggestions.js';
import { discoverDshOnboardingMemory, importDshOnboardingMemory } from '../../src/app/memory/onboarding.js';
import { MemoryService } from '../../src/app/memory/service.js';
import { ActionService } from '../../src/actions/service.js';
import { StewardStore } from '../../src/storage/store.js';

function fakeLlm(responseText: string, onPrompt?: (prompt: string) => void): MottoLlm {
  return {
    async *stream(options) {
      const text = options.messages[0]?.content[0]?.text ?? '';
      onPrompt?.(text);
      yield { type: 'text-delta', text: responseText };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
}

test('daily-motto 保留复合 Emoji、过滤 AI 味陈词滥调并在无 Emoji 时自动补齐', async () => {
  // 1. 复合 Emoji（含 \uFE0F / \u200D）完整保留
  const kept = cleanMotto('☕️ 先喝口冰美式，今天把遗留单子利落收掉。');
  assert.equal(kept, '☕️ 先喝口冰美式，今天把遗留单子利落收掉。');

  // 2. AI 味陈词滥调被拒绝（返回空字符串）
  assert.equal(cleanMotto('先把眼前这一步做好，项目就会多一分清晰。'), '');
  assert.equal(cleanMotto('一步一个脚印，未来可期。'), '');

  // 3. 缺少 Emoji 时自动补齐前置鲜活 Emoji
  const autoEmoji = cleanMotto('把最顺手的那件事先敲定，节奏就稳了。');
  assert.ok(autoEmoji.length > 0);
  assert.match(autoEmoji, /^\p{Extended_Pictographic}/u);

  // 4. createDailyMotto 生成并缓存带 Emoji 的去 AI 味激励语
  const dir = mkdtempSync(join(tmpdir(), 'wsa-motto-'));
  try {
    const mottoPath = join(dir, 'manager.sqlite.daily-motto.json');
    const abort = new AbortController();
    let promptReceived = '';
    const readMotto = createDailyMotto(mottoPath, abort.signal);
    const motto = await readMotto(
      fakeLlm('🛠️ 顺手把卡点理清，下午就能早点收工喝茶～', prompt => {
        promptReceived = prompt;
      }),
      { provider: 'deepseek', model: 'deepseek-chat' },
      {
        soul: {
          preset: 'efficient',
          userName: '凯哥',
          prompt: '干练直接，先给结论。',
        },
        pendingTodoCount: 3,
      },
    );
    assert.equal(motto?.text, '🛠️ 顺手把卡点理清，下午就能早点收工喝茶～');
    assert.match(promptReceived, /凯哥/);
    assert.match(promptReceived, /先把眼前这一步做好/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Suggestion List 首位固定为每日复盘引导（已配置后自动隐藏），其余最多 3 条由 LLM 根据记忆生成', async () => {
  const llmRaw = JSON.stringify([
    {
      label: '开启每日早晚总结与复盘',
      prompt: '重复的固定项应被过滤',
      icon: 'clock',
    },
    {
      label: '复盘大肥鱼记忆升级进展',
      prompt: '请帮我结合近期大肥鱼长期记忆与 Soul 升级进展，梳理接下来的验证事项。',
      icon: 'route',
    },
    {
      label: '推进看板高优待办卡片',
      prompt: '请帮我盘点当前看板和个人待办里的优先任务，给出今天最值得先做的 2 件事。',
      icon: 'check',
    },
    {
      label: '检查构建与测试状态',
      prompt: '请帮我核对当前工作区构建和单元测试状态，看看有没有遗漏项。',
      icon: 'board',
    },
    {
      label: '第 4 条动态建议应被截断',
      prompt: '这条建议超过 3 条上限，不应出现。',
      icon: 'edit',
    },
  ]);

  const parsed = parseLlmSuggestions(llmRaw);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0]?.label, '复盘大肥鱼记忆升级进展');

  // 未配置每日复盘时：第 1 条固定为每日复盘引导 + 3 条 LLM 动态建议（共 4 条）
  const unconfigured = assembleSuggestionPayload(false, parsed);
  assert.equal(unconfigured.dailyReviewConfigured, false);
  assert.equal(unconfigured.items.length, 4);
  assert.equal(unconfigured.items[0]?.id, FIXED_DAILY_REVIEW_SUGGESTION.id);
  assert.equal(unconfigured.items[0]?.label, '开启每日早晚总结与复盘');
  assert.equal(unconfigured.items[0]?.primary, true);

  // 已配置每日复盘时：隐藏第 1 条固定引导，仅展示最多 3 条 LLM 动态建议
  const configured = assembleSuggestionPayload(true, parsed);
  assert.equal(configured.dailyReviewConfigured, true);
  assert.equal(configured.items.length, 3);
  assert.equal(configured.items.some(item => item.id === FIXED_DAILY_REVIEW_SUGGESTION.id), false);
  assert.equal(configured.items[0]?.label, '复盘大肥鱼记忆升级进展');

  // E2E createChatSuggestions 调用验证
  const dir = mkdtempSync(join(tmpdir(), 'wsa-suggestions-'));
  try {
    const cachePath = join(dir, 'manager.sqlite.suggestions.json');
    const abort = new AbortController();
    let capturedPrompt = '';
    const generateSuggestions = createChatSuggestions(cachePath, abort.signal);
    const model = { provider: 'deepseek', model: 'deepseek-chat' };
    const snapshotBase = {
      soul: {
        preset: 'efficient' as const,
        userName: '凯哥',
        prompt: '结论先行',
        traits: ['conclusion-first' as const],
      },
      memories: [
        {
          id: 'm1',
          category: 'profile' as const,
          subject: '用户日程偏好',
          content: '习惯早上 9:30 先看看板，下午集中写代码',
          pinned: true,
          importance: 5,
          revision: 1,
          updatedAt: Date.now(),
        },
      ],
      todos: [
        {
          id: 't1',
          title: '完成大肥鱼引导与记忆注入测试',
          localDate: '2026-11-14',
          done: false,
          revision: 1,
          updatedAt: Date.now(),
        },
      ],
      recentSessions: [{ title: '大肥鱼 Soul 与记忆接入方案', status: 'idle' }],
    };

    const res1 = await generateSuggestions(
      fakeLlm(llmRaw, p => {
        capturedPrompt = p;
      }),
      model,
      { ...snapshotBase, dailyReviewConfigured: false },
    );
    assert.match(capturedPrompt, /习惯早上 9:30 先看看板/);
    assert.equal(res1.items.length, 4);
    assert.equal(res1.items[0]?.id, FIXED_DAILY_REVIEW_SUGGESTION.id);

    // 当 dailyReviewConfigured 变为 true 时，缓存读取也会立即隐藏固定复盘引导
    const res2 = await generateSuggestions(undefined, model, {
      ...snapshotBase,
      dailyReviewConfigured: true,
    });
    assert.equal(res2.dailyReviewConfigured, true);
    assert.equal(res2.items.length, 3);
    assert.equal(res2.items.some(item => item.id === FIXED_DAILY_REVIEW_SUGGESTION.id), false);

    // 点击使用某条动态 Suggestion 后，传入 dismiss 即可将其永久移除，不再出现在后续返回中
    const res3 = await generateSuggestions(undefined, model, {
      ...snapshotBase,
      dailyReviewConfigured: true,
      dismiss: ['复盘大肥鱼记忆升级进展'],
    });
    assert.equal(res3.items.length, 2);
    assert.equal(res3.items.some(item => item.label === '复盘大肥鱼记忆升级进展'), false);
    assert.equal(res3.items[0]?.label, '推进看板高优待办卡片');

    // 后续无 dismiss 参数拉取时，已使用过的 Suggestion 依然保持被移除状态
    const res4 = await generateSuggestions(undefined, model, {
      ...snapshotBase,
      dailyReviewConfigured: true,
    });
    assert.equal(res4.items.length, 2);
    assert.equal(res4.items.some(item => item.label === '复盘大肥鱼记忆升级进展'), false);

    // 话题级去重：换动词/换说法但围绕同一项目词（如 facemoji / GenUI P1-P3）时会被精准拦截
    assert.equal(
      isTopicOverlap('梳理 facemoji workspace 构建依赖', ['梳理 facemoji 构建任务拆解']),
      true,
    );
    assert.equal(
      isTopicOverlap('规划 GenUI P1-P3 交互走查', ['跟进 GenUI P1-P3 进展']),
      true,
    );
    assert.equal(
      isTopicOverlap('检视并整理我的长期记忆库', ['梳理 facemoji 构建任务拆解']),
      false,
    );

    // 当其余 2 条也全部点击完后，会自动触发 LLM 生成新一批不重复的 Suggestion，并过滤掉同话题换皮项
    let replenishPrompt = '';
    const nextBatchRaw = JSON.stringify([
      {
        label: '整理今日已完成事项归档',
        prompt: '请帮我汇总今天已完成的待办和卡片，整理成简短归档记录。',
        icon: 'calendar',
      },
      {
        label: '规划接下来一小时专注目标',
        prompt: '结合当前剩余任务，帮我规划接下来一小时优先推进的 1 件事。',
        icon: 'route',
      },
    ]);
    const res5 = await generateSuggestions(
      fakeLlm(nextBatchRaw, p => {
        replenishPrompt = p;
      }),
      model,
      {
        ...snapshotBase,
        dailyReviewConfigured: true,
        dismiss: ['推进看板高优待办卡片', '检查构建与测试状态'],
      },
    );
    assert.match(replenishPrompt, /复盘大肥鱼记忆升级进展/);
    assert.match(replenishPrompt, /推进看板高优待办卡片/);
    assert.equal(res5.items.length, 2);
    assert.equal(res5.items[0]?.label, '整理今日已完成事项归档');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('引导向导发现并导入 DSH 现有记忆与 Soul 设定到 MemoryService', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wsa-onboard-'));
  try {
    const wsDir = join(dir, 'workspace');
    const dshDir = join(wsDir, '.dsh');
    mkdirSync(dshDir, { recursive: true });
    writeFileSync(
      join(wsDir, 'AGENTS.md'),
      '# 项目协作规范\n- 提交前必须执行 typecheck 与单元测试\n- 严禁使用未声明的全局变量\n',
      'utf8',
    );
    writeFileSync(
      join(wsDir, 'package.json'),
      JSON.stringify({ name: 'demo-workbench', description: 'DSH 超级工作台测试工程' }),
      'utf8',
    );

    const context = {
      workspacePath: wsDir,
      workspaceName: 'demo-workbench',
      dshHome: join(dir, 'dsh-home'),
      recentSessions: [
        { title: '重构记忆系统与引导流', turnCount: 8, status: 'idle' },
        { title: '修复定时任务卡片状态同步', turnCount: 5, status: 'idle' },
      ],
      todos: [
        {
          id: 'todo-1',
          title: '核对引导向导 4 步交互',
          localDate: '2026-11-14',
          done: false,
          revision: 1,
          updatedAt: Date.now(),
        },
      ],
    };

    const discovery = discoverDshOnboardingMemory(context);
    assert.equal(discovery.sources.length, 3);
    assert.ok((discovery.sources.find(c => c.id === 'rules')?.count ?? 0) >= 1);
    assert.equal(discovery.sources.find(c => c.id === 'sessions')?.count, 2);
    assert.equal(discovery.sources.find(c => c.id === 'board')?.count, 1);

    const memoryService = new MemoryService(join(dir, 'manager.sqlite.memory.sqlite'), {
      workspaceId: 'ws-1',
      workspacePath: wsDir,
      assertCurrent: () => {},
    });
    const importedCount = importDshOnboardingMemory(
      memoryService,
      context,
      {
        sources: ['rules', 'sessions', 'board'],
        customNote: '平时喜欢早上 9:30 做计划，沟通直接给结论',
      },
      {
        preset: 'efficient',
        userName: '凯哥',
        prompt: '结论先行，遇到风险请直接提醒',
        traits: ['conclusion-first', 'blunt-risk'],
        syncSoulMarkdown: true,
      },
    );
    assert.ok(importedCount >= 4);
    const allMemories = memoryService.listMemories();
    assert.ok(allMemories.some(item => item.category === 'profile' && item.content.includes('凯哥')));
    assert.ok(allMemories.some(item => item.category === 'preference' && item.content.includes('9:30')));
    assert.ok(allMemories.some(item => item.category === 'preference' && item.content.includes('typecheck')));
    assert.ok(allMemories.some(item => item.category === 'project' && item.content.includes('demo-workbench')));
    assert.ok(existsSync(join(wsDir, '.dsh', 'MEMORY.md')));
    assert.match(readFileSync(join(wsDir, '.dsh', 'MEMORY.md'), 'utf8'), /凯哥/);
    memoryService.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ActionService.hasDailyReviewSchedule 能准确识别每日复盘定时任务，StewardStore.resetManagerBinding 可安全清空绑定回到引导态', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wsa-reset-'));
  try {
    const dbPath = join(dir, 'manager.sqlite');
    const nextRunIso = '2026-11-15T01:00:00.000Z';
    const actionService = new ActionService(`${dbPath}.actions.sqlite`, {
      workspaceId: 'ws-1',
      workspacePath: dir,
      check: () => {},
      board: () => undefined,
      schedule: () => ({
        previewConfirmedCreate: () => ({ scheduledAt: nextRunIso }),
        createConfirmed: async () => ({ id: 'sched-1', scheduledAt: nextRunIso }),
        viewConfirmedCreate: async () => ({ id: 'sched-1', scheduledAt: nextRunIso }),
      }),
    });

    assert.equal(actionService.hasDailyReviewSchedule('session-1'), false);
    const proposal = actionService.propose(
      'session-1',
      1,
      {
        actionId: 'dsh.schedule.create',
        version: 1,
        params: {
          title: '每日早间总结与复盘',
          instruction: '每天早上帮我盘点待办与日程',
          schedule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' },
        },
      },
      false,
    );
    assert.equal(proposal.status, 'ready');
    await actionService.handle(
      'session-1',
      {
        op: 'confirm',
        id: proposal.id,
        revision: proposal.revision,
        expectedNextRunAt: proposal.nextRunAt,
      },
      () => {},
    );
    assert.equal(actionService.hasDailyReviewSchedule('session-1'), true);
    actionService.clearAll();
    assert.equal(actionService.hasDailyReviewSchedule('session-1'), false);
    actionService.close();

    // 验证 StewardStore.resetManagerBinding 重置后仍可通过 openExisting 校验并回到未初始化状态
    const identity = {
      instanceId: 'inst-1',
      domainId: 'dom-1',
    };
    const store = StewardStore.initializeFresh(dbPath, identity);
    const reserved = store.reserveManager(store.manager().revision, 'session-1', 'ws-1', 'steward');
    const bound = store.bindManager(reserved.revision, {
      sessionId: 'session-1',
      workspaceId: 'ws-1',
      preset: 'steward',
      nativeLogRef: 'log-1',
    });
    assert.equal(bound.bindingState, 'bound');
    assert.equal(bound.sessionId, 'session-1');

    const afterReset = store.resetManagerBinding(bound.revision, 'owner-reset-test');
    assert.ok(afterReset.revision > bound.revision);
    assert.equal(afterReset.bindingState, 'none');
    assert.equal(afterReset.sessionId, null);
    assert.equal(afterReset.lifecycle, 'paused');
    store.close();

    const reopened = StewardStore.openExisting(dbPath, identity);
    assert.equal(reopened.manager().bindingState, 'none');
    assert.equal(reopened.manager().sessionId, null);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
