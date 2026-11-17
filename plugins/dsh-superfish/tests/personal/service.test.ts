import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PersonalService } from '../../src/app/personal/service.js';
import { DynamicPluginBridge, withDynamicPluginContext } from '../../src/app/plugins/bridge.js';
import { PluginSpaceRegistry } from '../../src/app/plugins/registry.js';
import { BOARD_CONTEXT, type ContextAccess } from '../../src/tools/context.js';
import type { CapturedTask } from '../../src/app/projections/types.js';

test('个人待办持久化、请求去重、冲突与作用域变化', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wsa-personal-'));
  let session = 'router-A', allowed = true;
  let taskAvailable = true;
  const task: CapturedTask = { id:'task-A',workspaceId:'workspace-A',resolvedProjectId:'workspace-A',title:'看板卡',
    description:'',status:'todo',updatedAt:1,archivedAt:null,parentId:null,executions:[] };
  let scheduledAt = '2026-11-12T12:00:00.000Z';
  const binding = { workspaceId:'workspace-A',sessionId:()=>session,assertCurrent:()=>{ if (!allowed) throw Error('REVOKED'); },
    tasks:()=>{ if (!taskAvailable) throw Error('UNAVAILABLE'); return [task]; },
    schedule:()=>({view:async ({id}:{id:string})=>({id,title:'日报',status:'active' as const,kind:'daily',time:'20:00:00',scheduledAt})}),
    scheduleIds:()=>['schedule-A'] };
  const path = join(directory, 'personal.sqlite');
  let service = new PersonalService(path,binding);
  try {
    const requestId = randomUUID();
    const create = {op:'create',requestId,title:'查看看板',localDate:'2026-11-11',boardTaskId:'task-A'};
    const one = await service.mutate('router-A',create);
    const two = await service.mutate('router-A',create);
    assert.equal(one.todos.items.length,1);
    assert.equal(two.todos.items[0]?.id,one.todos.items[0]?.id);
    await assert.rejects(service.mutate('router-A',{...create,title:'另一件事'}),/REQUEST_ID_REUSED/);
    await assert.rejects(service.mutate('router-A',{...create,requestId:randomUUID()}));
    const item = one.todos.items[0]!;
    const upcoming = await service.mutate('router-A',{op:'create',requestId:randomUUID(),title:'即将待办事项',localDate:'2026-11-18'});
    const upcomingItem = upcoming.todos.items.find(t => t.title === '即将待办事项')!;
    assert.equal(upcomingItem.localDate, '2026-11-18');
    const movedToToday = await service.mutate('router-A',{op:'move',requestId:randomUUID(),id:upcomingItem.id,revision:upcomingItem.revision,localDate:'2026-11-17'});
    assert.equal(movedToToday.todos.items.find(t => t.id === upcomingItem.id)?.localDate, '2026-11-17');
    const movedItem = movedToToday.todos.items.find(t => t.id === upcomingItem.id)!;
    // 未完成待办不允许归档
    await assert.rejects(service.mutate('router-A',{op:'archive',requestId:randomUUID(),id:movedItem.id,revision:movedItem.revision}),/PERSONAL_INVALID/);
    const afterDone = await service.mutate('router-A',{op:'update',requestId:randomUUID(),id:item.id,revision:item.revision,done:true});
    const doneItem = afterDone.todos.items.find(t => t.id === item.id)!;
    // 已完成待办不允许编辑标题或日期
    await assert.rejects(service.mutate('router-A',{op:'update',requestId:randomUUID(),id:doneItem.id,revision:doneItem.revision,title:'修改标题'}),/PERSONAL_COMPLETED_READONLY/);
    await assert.rejects(service.mutate('router-A',{op:'move',requestId:randomUUID(),id:doneItem.id,revision:doneItem.revision,localDate:'2026-11-19'}),/PERSONAL_COMPLETED_READONLY/);
    // 单条归档与批量归档已完成待办
    await service.mutate('router-A',{op:'update',requestId:randomUUID(),id:movedItem.id,revision:movedItem.revision,done:true});
    const afterSingleArchive = await service.mutate('router-A',{op:'archive',requestId:randomUUID(),id:movedItem.id,revision:movedItem.revision + 1});
    assert.equal(afterSingleArchive.todos.items.find(t => t.id === movedItem.id)?.archived, true);
    assert.equal(service.listTodos().some(t => t.id === movedItem.id), false);
    await assert.rejects(service.mutate('router-A',{op:'update',requestId:randomUUID(),id:item.id,revision:item.revision,done:false}),/REVISION_CONFLICT/);
    scheduledAt = '2026-11-13T12:00:00.000Z';
    assert.equal((await service.read('router-A')).schedules.items[0]?.scheduledAt,scheduledAt);
    taskAvailable = false;
    const unavailable = await service.read('router-A');
    assert.equal(unavailable.boardCandidates.available,false);
    assert.equal(unavailable.todos.items[0]?.boardTaskId,undefined);
    service.close();
    service = new PersonalService(path,binding);
    assert.equal((await service.read('router-A')).todos.items[0]?.done,true);
    session = 'router-B';
    await assert.rejects(service.read('router-A'),/CHAT_SESSION_CHANGED/);
    assert.equal(service.listTodos()[0]?.done,true);
    allowed = false;
    assert.throws(() => service.listTodos(),/REVOKED/);
    await assert.rejects(service.read('router-B'),/REVOKED/);
  } finally { service.close(); rmSync(directory,{recursive:true,force:true}); }
});

test('大肥鱼插件空间自动发现宿主 DSH 插件、一键开关授权与手动关联持久化', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wsa-plugin-space-'));
  const filePath = join(directory, 'plugins.json');
  try {
    let rev = 1;
    const createRegistry = () =>
      new PluginSpaceRegistry({
        filePath,
        baseGrants: BOARD_CONTEXT,
        contextService: () => ({
          catalog: () => ({}),
          status: () => [],
          query: async () => ({}),
          listRegistered: () => [
            {
              protocol: 1 as const,
              id: 'pomodoro.focus_stats',
              source: '番茄钟专注计时器',
              provider: '@local/dsh-pomodoro-clock',
              description: '读取专注计时统计',
              scope: 'workspace' as const,
            },
          ],
        }),
        policyRevision: () => `rev-${rev}`,
      });

    const registry = createRegistry();
    // 初始无人工变更时保持原 baseGrants 引用
    assert.equal(registry.hasMutations(), false);
    assert.equal(registry.effectiveGrants(), BOARD_CONTEXT);

    const initialSnap = registry.snapshot();
    const discoveredPomodoro = initialSnap.items.find(item => item.packageName === '@local/dsh-pomodoro-clock');
    assert.ok(discoveredPomodoro);
    assert.equal(discoveredPomodoro.source, 'discovered');
    assert.equal(discoveredPomodoro.enabled, false);
    assert.equal(initialSnap.contextGrants['pomodoro.focus_stats'], undefined);

    // 1. 一键开启自动发现的插件
    rev++;
    const afterToggle = registry.togglePlugin('@local/dsh-pomodoro-clock', true);
    assert.equal(registry.hasMutations(), true);
    assert.equal(afterToggle.contextGrants['pomodoro.focus_stats'], '@local/dsh-pomodoro-clock');
    assert.equal(registry.effectiveGrants()['pomodoro.focus_stats'], '@local/dsh-pomodoro-clock');

    // 2. 手动关联第三方插件
    rev++;
    const afterManual = registry.registerManualPlugin({
      packageName: '@local/dsh-git-radar',
      capabilityId: 'git-radar.branches',
      title: 'Git 仓库健康雷达',
    });
    assert.equal(afterManual.contextGrants['git-radar.branches'], '@local/dsh-git-radar');
    assert.equal(afterManual.items[0]?.packageName, '@local/dsh-git-radar');
    assert.equal(afterManual.items[0]?.source, 'manual');

    // 3. 重启后从磁盘恢复启用状态与手动关联项
    const reloaded = createRegistry();
    assert.equal(reloaded.hasMutations(), true);
    assert.equal(reloaded.effectiveGrants()['pomodoro.focus_stats'], '@local/dsh-pomodoro-clock');
    assert.equal(reloaded.effectiveGrants()['git-radar.branches'], '@local/dsh-git-radar');

    // 4. 移除手动关联插件并校验非法格式拦截
    const afterRemove = reloaded.removeManualPlugin('@local/dsh-git-radar');
    assert.equal(afterRemove.contextGrants['git-radar.branches'], undefined);
    assert.throws(
      () => reloaded.registerManualPlugin({ packageName: 'invalid package', capabilityId: 'bad_id' }),
      /PLUGIN_INVALID/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('自动检索第三方插件（默认待启用）、动态合成 Context 协议与原生写/控制类 Tool 代理注入', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wsa-plugin-bridge-'));
  const filePath = join(directory, 'plugins.json');
  try {
    let pomodoroState = {
      mode: 'focus',
      status: 'idle',
      remainingMs: 25 * 60 * 1000,
      endsAt: null as number | null,
      serverNow: 1_700_000_000_000,
    };
    let activeAtlasPath = '/repo/main';

    const fakeServices: Record<string, unknown> = {
      localPomodoro: {
        async operate(input: { action?: string; mode?: string }) {
          if (input.action === 'start') {
            pomodoroState = {
              mode: input.mode ?? pomodoroState.mode,
              status: 'running',
              remainingMs: 25 * 60 * 1000,
              endsAt: pomodoroState.serverNow + 25 * 60 * 1000,
              serverNow: pomodoroState.serverNow,
            };
          } else if (input.action === 'pause') {
            pomodoroState = {
              ...pomodoroState,
              status: 'paused',
              endsAt: null,
            };
          }
          return pomodoroState;
        },
      },
      workspaceAtlas: {
        async getSnapshot() {
          return {
            linked: true,
            workspace: { path: activeAtlasPath, name: 'Main Atlas' },
            availableWorkspaces: [{ path: activeAtlasPath, title: 'Main Atlas', workspaceId: undefined }],
            repos: [
              {
                id: 'core-engine',
                path: `${activeAtlasPath}/core-engine`,
                col: 'foundation',
                mounted: true,
                branch: undefined,
                dirtyLabel: undefined,
                stack: ['ts'],
                lenses: ['aigc'],
                summary: '核心引擎仓库',
              },
            ],
            edges: [],
            sdkGates: undefined,
          };
        },
        selectWorkspace(targetPath: string) {
          activeAtlasPath = targetPath;
          return activeAtlasPath;
        },
      },
    };

    let registry!: PluginSpaceRegistry;
    let mutationCalls = 0;
    const bridge = new DynamicPluginBridge({
      host: () => ({
        get: (name: string) => fakeServices[name],
      }),
      scanFilesystem: false,
      isPluginEnabled: pkg => registry.isPluginEnabled(pkg),
      getManualBridgeSpecs: () => registry.manualBridgeSpecs(),
    });

    registry = new PluginSpaceRegistry({
      filePath,
      baseGrants: BOARD_CONTEXT,
      dynamicBridge: () => bridge,
      onMutation: () => {
        mutationCalls += 1;
      },
    });

    // 1. 自动检索本地已安装的第三方插件，默认状态为「待启用」(enabled: false)
    const initialSnap = registry.snapshot();
    const pomodoroItem = initialSnap.items.find(i => i.packageName === '@local/dsh-pomodoro-clock');
    const atlasItem = initialSnap.items.find(i => i.packageName === '@local/dsh-workspace-atlas');
    assert.ok(pomodoroItem, '应自动检索到番茄钟插件');
    assert.ok(atlasItem, '应自动检索到工作区全景星图插件');
    assert.equal(pomodoroItem.enabled, false, '自动发现的第三方插件默认应为待启用');
    assert.equal(pomodoroItem.source, 'discovered');
    assert.equal(pomodoroItem.bridgeMode, 'dynamic');
    assert.equal(atlasItem.enabled, false, '自动发现的第三方插件默认应为待启用');
    assert.ok(pomodoroItem.capabilities.some(c => c.kind === 'context' && c.id === 'pomodoro.status'));
    assert.ok(pomodoroItem.capabilities.some(c => c.kind === 'action' && c.id === 'pomodoro'));
    assert.ok(atlasItem.capabilities.some(c => c.kind === 'context' && c.id === 'workspace-atlas.snapshot'));
    assert.ok(atlasItem.capabilities.some(c => c.kind === 'action' && c.id === 'workspace_atlas'));

    // 未启用时，不应生成任何动态 Action Tool，且 dsh_context_query 拒绝访问
    const compositeContext = withDynamicPluginContext(() => undefined, () => bridge);
    const makeAccess = (): ContextAccess => ({
      scope: { workspaceId: 'ws-1', projectIds: ['ws-1'] },
      grants: registry.hasMutations() ? registry.effectiveGrants() : BOARD_CONTEXT,
      binding: 'fp-1',
      signal: new AbortController().signal,
      assertCurrent() {},
    });

    assert.equal(bridge.isEnabledPluginActionTool('pomodoro'), false);
    assert.equal(
      bridge.buildEnabledActionToolDefinitions(() => ({ session: 'router-1', turn: 1 })).length,
      0,
    );
    const deniedRes = (await compositeContext.query(makeAccess(), {
      capability: 'pomodoro.status',
    })) as { status: string };
    assert.equal(deniedRes.status, 'denied');

    // 2. 用户手动点开关开启番茄钟与 Workspace Atlas 注入
    registry.togglePlugin('@local/dsh-pomodoro-clock', true);
    registry.togglePlugin('@local/dsh-workspace-atlas', true);
    assert.equal(mutationCalls, 2);
    assert.equal(registry.effectiveGrants()['pomodoro.status'], '@local/dsh-pomodoro-clock');
    assert.equal(registry.effectiveGrants()['workspace-atlas.snapshot'], '@local/dsh-workspace-atlas');

    // 3. 验证动态合成的 Context 协议（dsh_context_catalog 与 dsh_context_query）
    const catalogRes = compositeContext.catalog(makeAccess()) as {
      status: string;
      capabilities: { id: string; status: string; provider?: string }[];
    };
    assert.equal(catalogRes.status, 'ok');
    const pomoCap = catalogRes.capabilities.find(c => c.id === 'pomodoro.status');
    assert.equal(pomoCap?.status, 'available');
    assert.equal(pomoCap?.provider, '@local/dsh-pomodoro-clock');

    const pomoQueryRes = (await compositeContext.query(makeAccess(), {
      capability: 'pomodoro.status',
    })) as {
      status: string;
      items: Record<string, unknown>[];
    };
    assert.equal(pomoQueryRes.status, 'ok');
    assert.equal(pomoQueryRes.items.length, 1);
    assert.equal(pomoQueryRes.items[0]?.workspaceId, 'ws-1');
    assert.deepEqual(pomoQueryRes.items[0]?.ref, { kind: 'pomodoro', id: 'pomodoro-active' });
    assert.equal(pomoQueryRes.items[0]?.status, 'idle');

    // 4. 验证动态代理注入的写操作/控制类原生 Tool（例如直接让大肥鱼帮用户启动/暂停番茄钟、切换工作区星图）
    assert.equal(bridge.isEnabledPluginActionTool('pomodoro'), true);
    assert.equal(bridge.isEnabledPluginActionTool('workspace_atlas'), true);
    const injectedTools = bridge.buildEnabledActionToolDefinitions(() => ({
      session: 'router-1',
      turn: 1,
    }));
    const pomoTool = injectedTools.find(t => t.name === 'pomodoro');
    const atlasTool = injectedTools.find(t => t.name === 'workspace_atlas');
    assert.ok(pomoTool, '应注入原生控制工具 pomodoro');
    assert.ok(atlasTool, '应注入原生控制工具 workspace_atlas');

    const started = (await pomoTool.execute(
      { action: 'start', mode: 'focus' },
      { name: 'pomodoro', signal: new AbortController().signal },
    )) as { status: string; mode: string; remainingSeconds: number };
    assert.equal(started.status, 'running');
    assert.equal(started.mode, 'focus');
    assert.equal(started.remainingSeconds, 1500);

    const paused = (await pomoTool.execute(
      { action: 'pause' },
      { name: 'pomodoro', signal: new AbortController().signal },
    )) as { status: string };
    assert.equal(paused.status, 'paused');

    const atlasSnap = (await atlasTool.execute(
      {},
      { name: 'workspace_atlas', signal: new AbortController().signal },
    )) as Record<string, unknown>;
    // 校验返回对象严格满足 lossless JSON（不含任何 undefined 属性值）
    const assertLosslessJson = (val: unknown): void => {
      assert.notEqual(val, undefined, 'Tool output must not contain undefined');
      if (Array.isArray(val)) {
        for (const item of val) assertLosslessJson(item);
      } else if (val && typeof val === 'object') {
        for (const v of Object.values(val)) assertLosslessJson(v);
      }
    };
    assertLosslessJson(atlasSnap);
    assert.deepEqual(atlasSnap, JSON.parse(JSON.stringify(atlasSnap)));

    const switchedAtlas = (await atlasTool.execute(
      { action: 'selectWorkspace', workspacePath: '/repo/switched' },
      { name: 'workspace_atlas', signal: new AbortController().signal },
    )) as { workspace: { path: string } };
    assertLosslessJson(switchedAtlas);
    assert.equal(switchedAtlas.workspace.path, '/repo/switched');

    // 系统提示词目录同步包含已启用插件的 Context Capability 与控制 Tool
    const promptSection = bridge.renderEnabledPluginsPromptSection();
    assert.ok(promptSection.includes('pomodoro.status'));
    assert.ok(promptSection.includes('`pomodoro`'));
    assert.ok(promptSection.includes('workspace-atlas.snapshot'));

    // 5. 关闭开关后立即收回控制 Tool 权限
    registry.togglePlugin('@local/dsh-pomodoro-clock', false);
    assert.equal(bridge.isEnabledPluginActionTool('pomodoro'), false);
    await assert.rejects(
      () =>
        pomoTool.execute(
          { action: 'start' },
          { name: 'pomodoro', signal: new AbortController().signal },
        ),
      (err: { code?: string; message?: string }) =>
        err?.code === 'PLUGIN_DISABLED' && Boolean(err.message?.includes('番茄钟专注计时器')),
    );
    // 6. 未加载的插件（宿主运行时未提供其 Service / Tool）不应出现在插件列表中
    delete fakeServices.localPomodoro;
    registry.clearAll();
    const afterUnloadSnap = registry.snapshot();
    assert.equal(
      afterUnloadSnap.items.some(i => i.packageName === '@local/dsh-pomodoro-clock'),
      false,
      '未加载的插件不应展示在插件列表中',
    );
    assert.equal(
      afterUnloadSnap.items.some(i => i.packageName === '@local/dsh-workspace-atlas'),
      true,
      '已加载的插件仍应正常展示',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
