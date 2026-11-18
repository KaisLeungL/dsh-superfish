import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionService } from '../../src/actions/service.js';
import { BOARD, SCHEDULE, currentLocalDate, parseCandidate, readScheduleWriteCandidates, readToolCandidates } from '../../src/actions/protocol.js';
import { parseBoardTaskDraft } from '../../src/actions/parse-draft.js';
import { DatabaseSync } from 'node:sqlite';

function fixture(path = ':memory:') {
  const tasks: { id: string; workspaceId: string; projectId: string; status: string }[] = [];
  const results = new Map<string, { id: string; scheduledAt: string }>();
  let boardWrites = 0, scheduleWrites = 0, reject = false, loseReceipt = false;
  const at = '2026-11-12T01:00:00.000Z';
  const binding = {
    workspaceId:'workspace-A', workspacePath:'/fixture', check() { if (reject) throw Error('DRAFT_SCOPE_CHANGED'); },
    board: () => ({ snapshot: () => ({tasks}), isExtensionEnabled: () => true,
      apply: async (_key: string, action: { id: string; input: { workspaceId: string; projectId: string; status: string } }) => {
        boardWrites++;
        tasks.push({ id:action.id, workspaceId:action.input.workspaceId, projectId:action.input.projectId, status:action.input.status });
      },
    }),
    schedule: () => ({
      previewConfirmedCreate: () => ({scheduledAt:at}),
      createConfirmed: async (_request: unknown, key: string) => {
        scheduleWrites++;
        results.set(key,{ id:'schedule-'+key,scheduledAt:at });
        if (loseReceipt) throw Error('transport interrupted');
        return results.get(key);
      },
      viewConfirmedCreate: async (_request: unknown,key: string) => results.get(key) ?? { code:'schedule_not_found' },
    }),
  };
  return { tasks, results, at, binding, service:new ActionService(path,binding), get boardWrites() {return boardWrites;}, get scheduleWrites() {return scheduleWrites;},
    revoke(){reject=true;}, loseReceipt(){loseReceipt=true;} };
}
const proposal = (actionId: string, params: object = {}) => parseCandidate({actionId,version:1,params});
const candidate = () => proposal(SCHEDULE, { title:'日报', instruction:'生成验收日报',schedule:{kind:'daily',time:'09:00',timeZone:'Asia/Shanghai'} });

test('创建入口掉线时仍可编辑并保存；入口恢复后才能确认', async () => {
  const f = fixture(), svc = f.service;
  const schedule = f.binding.schedule;
  let available = false;
  Object.assign(f.binding, { schedule: () => available ? schedule() : undefined });
  try {
    const draft = svc.propose('s',1,proposal(SCHEDULE),false);
    assert.equal(draft.status,'needs_input');
    assert.equal(draft.submissionIssue,'entry_unavailable');
    const saved = await svc.handle('s',{ op:'save',id:draft.id,revision:draft.revision,proposal:candidate() },()=>{});
    assert.equal(saved?.status,'unavailable');
    assert.equal(saved?.candidate.params.title,'日报');
    const confirm = { op:'confirm',id:draft.id,revision:saved!.revision };
    assert.equal((await svc.handle('s',confirm,()=>{}))?.status,'unavailable');
    assert.equal(f.scheduleWrites,0);
    available = true;
    const ready = await svc.handle('s',{ op:'read',turn:1 },()=>{});
    assert.equal(ready?.status,'ready');
    assert.equal((await svc.handle('s',{ ...confirm,expectedNextRunAt:ready?.nextRunAt },()=>{}))?.status,'succeeded');
    assert.equal(f.scheduleWrites,1);
  } finally { svc.close(); }
});

test('草稿只准备数据；精确修订和工作区确认后建一张看板卡，不自动执行', async () => {
  const f = fixture(), svc=f.service, auth=()=>{};
  try {
    const first=svc.propose('s',0,proposal(BOARD),false);
    assert.equal(first.status,'needs_input');
    assert.equal(f.boardWrites,0);
    await assert.rejects(svc.handle('s',{op:'confirm',id:first.id,revision:1},auth),/DRAFT_NOT_READY/);
    await assert.rejects(svc.handle('s',{op:'save',id:first.id,revision:1,proposal:proposal(BOARD,{title:'卡',projectId:'other'})},auth),/DRAFT_SCOPE_CHANGED/);
    const ready=await svc.handle('s',{op:'save',id:first.id,revision:1,proposal:proposal(BOARD,{title:'卡',column:'backlog'})},auth);
    assert.equal(ready?.status,'ready');
    assert.equal((await svc.handle('s',{op:'confirm',id:first.id,revision:1},auth))?.revision,2);
    await assert.rejects(svc.handle('other',{op:'confirm',id:first.id,revision:2},auth),/DRAFT_NOT_FOUND/);
    const confirm={op:'confirm',id:first.id,revision:2};
    const [one,two]=await Promise.all([svc.handle('s',confirm,auth),svc.handle('s',confirm,auth)]);
    assert.equal(one?.status,'succeeded');
    assert.ok(['submitting','succeeded'].includes(two!.status));
    assert.equal(f.boardWrites,1);
    assert.deepEqual(f.tasks,[{id:first.id,workspaceId:'workspace-A',projectId:'workspace-A',status:'backlog'}]);
    assert.equal((await svc.handle('s',{op:'open',id:first.id,revision:2},auth))?.resultId,first.id);
    f.revoke();
    await assert.rejects(svc.handle('s',{op:'open',id:first.id,revision:2},auth),/DRAFT_SCOPE_CHANGED/);
  } finally { svc.close(); }
});

test('定时创建回执丢失时重启只查同一确认，结果可回读且不重复创建', async () => {
  const folder=mkdtempSync(join(tmpdir(),'wsa-actions-')), path=join(folder,'actions.sqlite');
  const f=fixture(path), svc=f.service, auth=()=>{};
  try {
    const ready=svc.propose('s',3,candidate(),false);
    assert.equal(ready.nextRunAt,f.at);
    const input={op:'confirm',id:ready.id,revision:ready.revision,expectedNextRunAt:f.at};
    assert.equal((await svc.handle('s',{...input,expectedNextRunAt:'changed'},auth))?.status,'ready');
    assert.equal(f.scheduleWrites,0);
    f.loseReceipt();
    assert.equal((await svc.handle('s',input,auth))?.status,'unknown');
    svc.close();
    const recovered=new ActionService(path,f.binding);
    try {
      assert.equal((await recovered.handle('s',input,auth))?.status,'unknown');
      const back=await recovered.handle('s',{op:'reconcile',id:ready.id,revision:ready.revision},auth);
      assert.equal(back?.resultId,'schedule-'+ready.id);
      assert.equal(back?.nextRunAt,f.at);
      assert.equal(f.scheduleWrites,1);
    } finally { recovered.close(); }
  } finally { rmSync(folder,{recursive:true,force:true}); }
});

test('补充上张草稿换到真实新回合；模型参数不能携带权限或执行指令', async () => {
  const f=fixture(), svc=f.service;
  try {
    const one=svc.propose('s',7,proposal(SCHEDULE,{instruction:'日报'}),false);
    const next=svc.propose('s',8,proposal(SCHEDULE,{schedule:{kind:'daily',time:'09:00'}}),true);
    assert.equal(next.id,one.id);
    assert.equal(next.revision,2);
    assert.equal(next.status,'ready');
    assert.equal(await svc.handle('s',{op:'read',turn:7},()=>{}),null);
    assert.throws(()=>proposal(BOARD,{title:'卡',runAfterCreate:true}),/INVALID_DRAFT/);
    assert.throws(()=>proposal(SCHEDULE,{target:'manager'}),/INVALID_DRAFT/);
    assert.throws(()=>proposal(SCHEDULE,{schedule:{kind:'daily',time:'25:00'}}),/INVALID_DRAFT/);
  } finally { svc.close(); }
});

test('看板任务卡片支持选择其他已注册项目、填写独立 prompt 并交由看板默认配置管理', async () => {
  const createdInputs: Record<string, unknown>[] = [];
  const tasks: { id: string; workspaceId: string; projectId: string; status: string }[] = [];
  const svc = new ActionService(':memory:', {
    workspaceId: 'ws-main',
    workspacePath: '/main',
    check() {},
    projects: () => [
      { id: 'ws-main', label: 'dsh-super-workbench' },
      { id: 'ws-latin', label: 'LatinIME' },
    ],
    board: () => ({
      snapshot: () => ({ tasks }),
      isExtensionEnabled: () => true,
      apply: async (_key: string, action: { id: string; input: Record<string, unknown> }) => {
        createdInputs.push(action.input);
        tasks.push({
          id: action.id,
          workspaceId: String(action.input.workspaceId),
          projectId: String(action.input.projectId),
          status: String(action.input.status),
        });
      },
    }),
    schedule: () => undefined,
  });
  try {
    const draft = svc.propose('s', 1, proposal(BOARD, { title: '完成AI提效文档的编写', projectId: 'LatinIME' }), false);
    assert.equal(draft.candidate.actionId, BOARD);
    assert.equal(draft.candidate.params.projectId, 'ws-latin');
    assert.equal(draft.candidate.params.column, 'todo');
    assert.equal(draft.candidate.params.targetDate, currentLocalDate());
    assert.equal(draft.projects?.length, 2);
    const updated = proposal(BOARD, {
      title: '完成AI提效文档的编写',
      description: '补充背景说明',
      prompt: '请编写完整的AI提效文档并输出到 docs/',
      projectId: 'ws-latin',
      column: 'todo',
      targetDate: '2026-11-15',
    });
    const result = await svc.handle('s', { op: 'confirm', id: draft.id, revision: draft.revision, proposal: updated }, () => {});
    assert.equal(result?.status, 'succeeded');
    assert.equal(createdInputs.length, 1);
    assert.deepEqual(createdInputs[0], {
      title: '完成AI提效文档的编写',
      description: '补充背景说明',
      prompt: '请编写完整的AI提效文档并输出到 docs/',
      projectId: 'ws-latin',
      workspaceId: 'ws-latin',
      status: 'todo',
      targetDate: '2026-11-15',
      applyCardDefaults: true,
    });
  } finally { svc.close(); }
});

test('看板任务卡片支持设置执行时间与泳道联动、AI 解析提示词与立即委派执行', async () => {
  const createdInputs: Record<string, unknown>[] = [];
  const delegatedCalls: { sessionId: string; operationId: string; taskId: string }[] = [];
  const tasks: { id: string; workspaceId: string; projectId: string; status: string }[] = [];
  const fixedNow = Date.parse('2026-11-14T10:00:00.000Z');
  const expectedToday = currentLocalDate(fixedNow);
  const svc = new ActionService(':memory:', {
    workspaceId: 'ws-main',
    workspacePath: '/main',
    now: () => fixedNow,
    check() {},
    board: () => ({
      snapshot: () => ({ tasks }),
      isExtensionEnabled: () => true,
      apply: async (_key: string, action: { id: string; input: Record<string, unknown> }) => {
        createdInputs.push(action.input);
        tasks.push({
          id: action.id,
          workspaceId: String(action.input.workspaceId),
          projectId: String(action.input.projectId),
          status: String(action.input.status),
        });
      },
    }),
    schedule: () => undefined,
    delegate: async (sessionId, operationId, taskId) => {
      delegatedCalls.push({ sessionId, operationId, taskId });
      return { state: 'accepted', executionId: 'exec-' + taskId };
    },
    parseTaskDraft: async text => parseBoardTaskDraft(
      {
        async *stream() {
          yield {
            type: 'text-delta',
            text: JSON.stringify({
              title: '检查项目结构与依赖拓扑',
              description: `基于用户输入「${text}」拆解结构检查任务`,
              prompt: '1. 检查 packages 与 plugins 目录结构；2. 核对 package.json 依赖边界；3. 输出检查报告。',
            }),
          };
        },
      },
      { provider: 'deepseek', model: 'deepseek-chat' },
      text,
    ),
  });
  try {
    // 1. 默认待办自动填充当前日期；若待办未设置执行时间则处于 needs_input 不可确认
    const draft = svc.propose('s', 1, proposal(BOARD, { title: '检查项目结构' }), false);
    assert.equal(draft.status, 'ready');
    assert.equal(draft.candidate.actionId, BOARD);
    assert.equal(draft.candidate.params.column, 'todo');
    assert.equal(draft.candidate.params.targetDate, expectedToday);

    const missingDateSave = await svc.handle('s', {
      op: 'save',
      id: draft.id,
      revision: draft.revision,
      proposal: proposal(BOARD, { title: '检查项目结构', column: 'todo' }),
    }, () => {});
    assert.equal(missingDateSave?.status, 'needs_input');
    await assert.rejects(
      svc.handle('s', { op: 'confirm', id: draft.id, revision: missingDateSave!.revision }, () => {}),
      /DRAFT_NOT_READY/,
    );

    // 2. 切换到待规划则不设置执行时间，且可直接就绪
    const backlogSave = await svc.handle('s', {
      op: 'save',
      id: draft.id,
      revision: missingDateSave!.revision,
      proposal: parseCandidate({
        actionId: BOARD,
        version: 1,
        params: { title: '检查项目结构', column: 'backlog', targetDate: '2026-11-20' },
      }),
    }, () => {});
    assert.equal(backlogSave?.status, 'ready');
    assert.equal(backlogSave?.candidate.actionId, BOARD);
    assert.equal(backlogSave?.candidate.params.column, 'backlog');
    assert.equal(backlogSave?.candidate.params.targetDate, undefined);

    // 3. AI 解析执行提示词，自动生成详细 prompt 并保留用户已选泳道/日期
    const parsed = await svc.handle('s', {
      op: 'parse_prompt',
      id: draft.id,
      revision: backlogSave!.revision,
      text: '检查项目结构',
      proposal: proposal(BOARD, {
        title: '检查项目结构',
        column: 'todo',
        targetDate: expectedToday,
      }),
    }, () => {});
    assert.equal(parsed?.status, 'ready');
    assert.equal(parsed?.candidate.actionId, BOARD);
    assert.equal(parsed?.candidate.params.column, 'todo');
    assert.equal(parsed?.candidate.params.targetDate, expectedToday);
    assert.match(parsed?.candidate.params.prompt ?? '', /检查 packages 与 plugins 目录结构/u);
    assert.match(parsed?.candidate.params.description ?? '', /拆解结构检查任务/u);

    // 4. 点击「立即委派执行」(confirm + delegateNow: true) 创建卡片并立即触发委派
    const confirmedAndDelegated = await svc.handle('s', {
      op: 'confirm',
      id: draft.id,
      revision: parsed!.revision,
      delegateNow: true,
    }, () => {});
    assert.equal(confirmedAndDelegated?.status, 'succeeded');
    assert.equal(confirmedAndDelegated?.delegation?.state, 'accepted');
    assert.equal(confirmedAndDelegated?.delegation?.executionId, 'exec-' + draft.id);
    assert.equal(delegatedCalls.length, 1);
    assert.deepEqual(delegatedCalls[0], {
      sessionId: 's',
      operationId: 'delegate:action:' + draft.id,
      taskId: draft.id,
    });
    assert.equal(createdInputs[0]?.targetDate, expectedToday);
    assert.equal(createdInputs[0]?.status, 'todo');

    // 5. 若不设置执行时间（未选 todo），创建为待规划泳道卡片；创建后也可单独点击「立即委派执行」(op: 'delegate')
    const draft2 = svc.propose('s', 2, proposal(BOARD, { title: '待规划重构任务', column: 'backlog' }), false);
    assert.equal(draft2.candidate.actionId, BOARD);
    assert.equal(draft2.candidate.params.column, 'backlog');
    assert.equal(draft2.candidate.params.targetDate, undefined);
    const createdOnly = await svc.handle('s', {
      op: 'confirm',
      id: draft2.id,
      revision: draft2.revision,
    }, () => {});
    assert.equal(createdOnly?.status, 'succeeded');
    assert.equal(createdOnly?.delegation, undefined);
    assert.equal(createdInputs[1]?.status, 'backlog');
    assert.equal('targetDate' in (createdInputs[1] ?? {}), false);

    const delegatedLater = await svc.handle('s', {
      op: 'delegate',
      id: draft2.id,
      revision: createdOnly!.revision,
    }, () => {});
    assert.equal(delegatedLater?.delegation?.state, 'accepted');
    assert.equal(delegatedCalls.length, 2);
  } finally {
    svc.close();
  }
});

test('同一轮支持生成多张创建卡片并分别预览、修改与确认；兼容旧库 UNIQUE(session, turn) 自动迁移', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'wsa-actions-multi-')), path = join(folder, 'actions.sqlite');
  const legacyDb = new DatabaseSync(path);
  legacyDb.exec(`CREATE TABLE proposal (
    id TEXT PRIMARY KEY, session TEXT NOT NULL, turn INTEGER NOT NULL, revision INTEGER NOT NULL,
    state TEXT NOT NULL, body TEXT NOT NULL, expires INTEGER NOT NULL, result TEXT, UNIQUE(session, turn)
  ) STRICT`);
  legacyDb.close();
  const f = fixture(path), svc = f.service, auth = () => {};
  try {
    const batch = readToolCandidates({
      proposals: [
        {
          actionId: SCHEDULE,
          version: 1,
          params: {
            title: '每日早间总结与工作建议',
            instruction: '结合个人待办、任务看板和最近几天的会话记录给出今日优先建议。',
            schedule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' },
          },
        },
        {
          actionId: SCHEDULE,
          version: 1,
          params: {
            title: '每日晚间复盘',
            instruction: '结合个人待办、任务看板和今日会话记录总结已完成、未闭环事项并给出明日建议。',
            schedule: { kind: 'daily', time: '20:30', timeZone: 'Asia/Shanghai' },
          },
        },
      ],
    });
    assert.equal(batch.candidates.length, 2);
    const morning = svc.propose('s', 2, batch.candidates[0]!, false);
    const evening = svc.propose('s', 2, batch.candidates[1]!, false);
    assert.notEqual(morning.id, evening.id);
    assert.equal(morning.status, 'ready');
    assert.equal(evening.status, 'ready');

    const list = await svc.handle('s', { op: 'list', turn: 2 }, auth);
    assert.equal(list.length, 2);
    assert.deepEqual(list.map(item => item.candidate.params.title), ['每日早间总结与工作建议', '每日晚间复盘']);

    const confirmedMorning = await svc.handle('s', {
      op: 'confirm',
      id: morning.id,
      revision: morning.revision,
      expectedNextRunAt: morning.nextRunAt,
    }, auth);
    assert.equal(confirmedMorning?.status, 'succeeded');

    const afterFirstConfirm = await svc.handle('s', { op: 'list', turn: 2 }, auth);
    assert.equal(afterFirstConfirm[0]?.status, 'succeeded');
    assert.equal(afterFirstConfirm[1]?.status, 'ready');

    const confirmedEvening = await svc.handle('s', {
      op: 'confirm',
      id: evening.id,
      revision: evening.revision,
      expectedNextRunAt: evening.nextRunAt,
    }, auth);
    assert.equal(confirmedEvening?.status, 'succeeded');
    assert.equal(f.scheduleWrites, 2);
    assert.deepEqual(svc.ownedScheduleIds('s'), ['schedule-' + morning.id, 'schedule-' + evening.id]);

    // P2: 支持按指定 id 或 ids 数组精准读取草稿（供 GenUI DshProposalEmbed 跨组件内嵌渲染）
    const singleRead = await svc.handle('s', { op: 'read', id: morning.id }, auth);
    assert.equal(singleRead?.id, morning.id);
    const idsList = await svc.handle('s', { op: 'list', ids: [evening.id, morning.id] }, auth);
    assert.deepEqual(idsList.map(item => item.id), [evening.id, morning.id]);

    // 确认创建后 hasDailyReviewSchedule 为 true，且提示词上下文反映已确认创建
    assert.equal(svc.hasDailyReviewSchedule('s'), true);
    assert.match(svc.renderPromptHint('s'), /此前已在界面确认创建成功/u);

    // 用户在定时任务管理页自行删除已创建的两个定时任务后，刷新状态可感知删除并允许新轮次重新生成卡片
    f.results.clear();
    assert.equal(await svc.refreshScheduleStates('s'), false);
    assert.equal(svc.hasDailyReviewSchedule('s'), false);
    const hintAfterDelete = svc.renderPromptHint('s');
    assert.match(hintAfterDelete, /此前已确认创建，但原任务现已被用户删除/u);
    assert.match(hintAfterDelete, /必须在当前轮次重新调用 steward_propose_action 生成新草稿卡片/u);

    const recreatedMorning = svc.propose('s', 3, batch.candidates[0]!, false);
    const recreatedEvening = svc.propose('s', 3, batch.candidates[1]!, false);
    assert.notEqual(recreatedMorning.id, morning.id);
    assert.notEqual(recreatedEvening.id, evening.id);
    assert.equal(recreatedMorning.status, 'ready');
    assert.equal(recreatedEvening.status, 'ready');
    const turn3List = await svc.handle('s', { op: 'list', turn: 3 }, auth);
    assert.equal(turn3List.length, 2);
  } finally {
    svc.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('createScheduleDirect 与 readScheduleWriteCandidates 支持直接创建定时任务并保持同轮幂等与失败可核实', async () => {
  const f = fixture(), svc = f.service;
  try {
    const parsedBatch = readScheduleWriteCandidates({
      schedules: [
        {
          title: '每日早间简报',
          instruction: '结合个人待办与任务看板生成今日优先级建议。',
          kind: 'daily',
          time: '09:00',
          timeZone: 'Asia/Shanghai',
        },
        {
          title: '每周周报汇总',
          instruction: '总结本周完成的会话与看板进展。',
          kind: 'weekly',
          time: '18:00',
          weekdays: [5],
          timeZone: 'Asia/Shanghai',
        },
      ],
    });
    assert.equal(parsedBatch.length, 2);
    assert.throws(() => readScheduleWriteCandidates({
      instruction: '冲突混用',
      schedules: [{ instruction: 'a', kind: 'daily', time: '09:00' }],
    }), /INVALID_DRAFT/);

    const created = await svc.createScheduleDirect('s', 1, parsedBatch[0]!);
    assert.equal(created.status, 'succeeded');
    assert.equal(created.resultId, 'schedule-' + created.id);
    assert.equal(f.scheduleWrites, 1);
    assert.deepEqual(svc.ownedScheduleIds('s'), [created.resultId]);
    assert.equal(svc.hasDailyReviewSchedule('s'), true);
    assert.match(svc.renderPromptHint('s'), /此前已在界面确认创建成功/u);

    // 同轮相同候选幂等复用，不重复写定时系统
    const repeated = await svc.createScheduleDirect('s', 1, parsedBatch[0]!);
    assert.equal(repeated.id, created.id);
    assert.equal(f.scheduleWrites, 1);

    // 缺少字段或非定时任务拒绝
    await assert.rejects(
      svc.createScheduleDirect('s', 2, parseCandidate({
        actionId: SCHEDULE,
        version: 1,
        params: { instruction: '缺 weekdays', schedule: { kind: 'weekly', time: '09:00', timeZone: 'Asia/Shanghai' } },
      })),
      /DRAFT_NOT_READY/,
    );
    await assert.rejects(
      svc.createScheduleDirect('s', 2, proposal(BOARD, { title: '看板任务不能走直接定时' })),
      /INVALID_DRAFT/,
    );
  } finally {
    svc.close();
  }
});

test('大肥鱼定时任务直接投递至大肥鱼主会话，且 refreshScheduleStates 与 open 自动迁移存量 new_once 与旧定时会话任务', async () => {
  const createdRequests: Record<string, unknown>[] = [];
  const editedPatches: { id: string; patch: Record<string, unknown> }[] = [];
  const catalogEntries: {
    id: string;
    status: string;
    target: Record<string, unknown>;
    involvedSessionIds: string[];
  }[] = [
    {
      id: 'schedule-legacy-new-once',
      status: 'active',
      target: {
        kind: 'new_once',
        sessionId: 'session-reserved-1',
        create: { cwd: '/fixture', agentPreset: 'workspace-superagent-scheduled' },
      },
      involvedSessionIds: ['session-reserved-1'],
    },
    {
      id: 'schedule-other-workspace',
      status: 'active',
      target: {
        kind: 'new_once',
        create: { cwd: '/other-workspace', agentPreset: 'workspace-superagent-scheduled' },
      },
      involvedSessionIds: [],
    },
    {
      id: 'schedule-legacy-ran-once',
      status: 'active',
      target: {
        kind: 'session',
        sessionId: 'session-legacy-scheduled-1',
      },
      involvedSessionIds: ['session-legacy-scheduled-1'],
    },
    {
      id: 'schedule-unrelated',
      status: 'active',
      target: {
        kind: 'session',
        sessionId: 'session-normal-user',
      },
      involvedSessionIds: ['session-normal-user'],
    },
  ];
  const at = '2026-11-15T01:30:00.000Z';
  const results = new Map<string, { id: string; scheduledAt: string; target?: Record<string, unknown> }>();
  const svc = new ActionService(':memory:', {
    workspaceId: 'workspace-A',
    workspacePath: '/fixture',
    check() {},
    isLegacyScheduledSession: sid => sid === 'session-legacy-scheduled-1',
    board: () => undefined,
    schedule: () => ({
      previewConfirmedCreate: (req: Record<string, unknown>) => {
        createdRequests.push(req);
        return { scheduledAt: at };
      },
      createConfirmed: async (req: Record<string, unknown>, key: string) => {
        createdRequests.push(req);
        const item = { id: 'schedule-' + key, scheduledAt: at, target: req.target as Record<string, unknown> };
        results.set(key, item);
        return item;
      },
      viewConfirmedCreate: async (_req: Record<string, unknown>, key: string) =>
        results.get(key) ?? { id: key, code: 'schedule_not_found' },
      view: async (req: { id: string }) => {
        for (const item of results.values()) {
          if (item.id === req.id) return item;
        }
        return catalogEntries.find(e => e.id === req.id) ?? { id: req.id, code: 'schedule_not_found' };
      },
      catalog: async () => catalogEntries,
      edit: async (req: { id: string; action: string; patch: Record<string, unknown> }) => {
        editedPatches.push({ id: req.id, patch: req.patch });
        for (const item of results.values()) {
          if (item.id === req.id && req.patch.target) {
            item.target = req.patch.target as Record<string, unknown>;
          }
        }
        const found = catalogEntries.find(e => e.id === req.id);
        if (found && req.patch.target) {
          found.target = req.patch.target as Record<string, unknown>;
        }
        return found;
      },
    }),
  });
  try {
    const routerSessionId = 'session-superagent-router-1';
    const created = await svc.createScheduleDirect(
      routerSessionId,
      1,
      proposal(SCHEDULE, {
        title: '每日 09:30 晨间工作简报',
        instruction: '盘点个人待办、看板任务与近期会话并生成今日早报。',
        schedule: { kind: 'daily', time: '09:30', timeZone: 'Asia/Shanghai' },
      }),
    );
    assert.equal(created.status, 'succeeded');
    assert.equal(created.candidate.actionId, SCHEDULE);
    assert.equal(created.candidate.params.target, 'router_session');
    assert.deepEqual(createdRequests.at(-1)?.target, {
      kind: 'session',
      sessionId: routerSessionId,
    });

    // 模拟卡片创建时的任务是旧版 new_once，点击「查看定时任务」(op: 'open') 时也会立即热修补 target 到主会话
    results.get(created.id)!.target = {
      kind: 'new_once',
      sessionId: 'session-old-once',
      create: { cwd: '/fixture', agentPreset: 'workspace-superagent-scheduled' },
    };
    const opened = await svc.handle(routerSessionId, { op: 'open', id: created.id, revision: created.revision }, () => {});
    assert.equal(opened?.status, 'succeeded');
    assert.deepEqual(results.get(created.id)?.target, {
      kind: 'session',
      sessionId: routerSessionId,
    });

    editedPatches.length = 0;
    const hasSchedule = await svc.refreshScheduleStates(routerSessionId);
    assert.equal(hasSchedule, true);
    assert.equal(editedPatches.length, 2);
    assert.deepEqual(editedPatches, [
      {
        id: 'schedule-legacy-new-once',
        patch: { target: { kind: 'session', sessionId: routerSessionId } },
      },
      {
        id: 'schedule-legacy-ran-once',
        patch: { target: { kind: 'session', sessionId: routerSessionId } },
      },
    ]);
    const owned = svc.ownedScheduleIds(routerSessionId);
    assert.ok(owned.includes(created.resultId!));
    assert.ok(owned.includes('schedule-legacy-new-once'));
    assert.ok(owned.includes('schedule-legacy-ran-once'));
    assert.equal(owned.includes('schedule-unrelated'), false);
    assert.equal(owned.includes('schedule-other-workspace'), false);
    editedPatches.length = 0;
    await svc.refreshScheduleStates(routerSessionId);
    assert.deepEqual(editedPatches, []);
  } finally {
    svc.close();
  }
});
