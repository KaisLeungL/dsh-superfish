import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PersonalService } from '../../src/app/personal/service.js';
import { PluginSpaceRegistry } from '../../src/app/plugins/registry.js';
import { BOARD_CONTEXT } from '../../src/tools/context.js';
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
    await service.mutate('router-A',{op:'update',requestId:randomUUID(),id:item.id,revision:item.revision,done:true});
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
