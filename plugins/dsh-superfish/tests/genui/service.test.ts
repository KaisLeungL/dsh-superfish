import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  repairJson,
  StreamPatternExtractor,
  genPrompt,
  parseAndValidateSchema,
} from '../../src/genui/core.js';
import { P1_DAILY_BRIEFING_EXAMPLE, P1_MATERIALS_META } from '../../src/genui/materials-meta.js';
import { GenuiService } from '../../src/genui/service.js';
import { GENUI_SKILL, LOAD_GENUI_SKILL, RENDER_GENUI_TOOL, renderGenuiSkillContent } from '../../src/genui/skill.js';
import { GENUI_PROMPT } from '../../src/prompts/package.js';

test('OpenTiny GenUI SDK Core: repairJson、StreamPatternExtractor 与 genPrompt 正常工作', () => {
  const truncated =
    '```schema-json\n{"componentName":"GenuiCard","props":{"title":"今日工作简报"},"children":[{"componentName":"DshMetricGroup","props":{"items":[{"label":"逾期","value":2,"tone":"danger"';
  const repaired = JSON.parse(repairJson(truncated));
  assert.equal(repaired.componentName, 'GenuiCard');
  assert.equal(repaired.props.title, '今日工作简报');
  assert.equal(repaired.children[0].componentName, 'DshMetricGroup');
  assert.equal(repaired.children[0].props.items[0].value, 2);

  const extractor = new StreamPatternExtractor();
  const step1 = extractor.handleContent('思考中...\n```schema-json\n{"componentName":"GenuiCard"');
  assert.equal(step1.schemas.length, 1);
  assert.equal(step1.schemas[0]!.complete, false);
  const step2 = extractor.handleContent(',"props":{"title":"早报"}}\n```\n完成');
  assert.equal(step2.schemas.length, 1);
  assert.equal(step2.schemas[0]!.complete, true);

  const prompt = genPrompt('React', P1_MATERIALS_META, {
    rules: ['禁止直接执行破坏性写操作'],
    examples: [P1_DAILY_BRIEFING_EXAMPLE],
  });
  assert.match(prompt, /DshMetricGroup/);
  assert.match(prompt, /DshTodoChecklist/);
  assert.match(prompt, /DshSessionDigestList/);
  assert.match(prompt, /DshTaskTable/);
  assert.match(prompt, /禁止直接执行破坏性写操作/);
});

test('GenuiService 持久化、同轮去重、replaceTurn、dismiss 与 clearAll 正常工作', async () => {
  let scopeRejected = false;
  const svc = new GenuiService(':memory:', {
    check() {
      if (scopeRejected) throw Error('GENUI_SCOPE_CHANGED');
    },
  });
  try {
    const view1 = svc.render('session-1', 0, {
      title: '今日工作简报',
      schema: P1_DAILY_BRIEFING_EXAMPLE,
    });
    assert.equal(view1.status, 'active');
    assert.equal(view1.turn, 0);
    assert.equal(view1.title, '今日工作简报');
    assert.ok(view1.nodeCount >= 4);

    // 同一轮重复提交相同 schema 幂等返回同一视图
    const duplicate = svc.render('session-1', 0, {
      title: '今日工作简报',
      schema: P1_DAILY_BRIEFING_EXAMPLE,
    });
    assert.equal(duplicate.id, view1.id);
    assert.equal(duplicate.revision, 1);

    // replaceTurn 更新当前轮次视图
    const updated = svc.render('session-1', 0, {
      title: '更新后的晚间复盘',
      replaceTurn: true,
      schema: {
        componentName: 'GenuiCard',
        props: { title: '晚间复盘', subtitle: '20:30 汇总' },
        children: [
          {
            componentName: 'DshTodoChecklist',
            props: {
              title: '待收尾事项',
              items: [{ title: '核对 GenUI 单元测试', dueDate: '2026-11-14', done: false }],
            },
          },
        ],
      },
    });
    assert.equal(updated.id, view1.id);
    assert.equal(updated.revision, 2);
    assert.equal(updated.title, '更新后的晚间复盘');

    const listed = await svc.handle('session-1', { op: 'list', turn: 0 }, () => {});
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.title, '更新后的晚间复盘');

    // dismiss 隐藏视图
    const dismissed = await svc.handle('session-1', { op: 'dismiss', id: view1.id }, () => {});
    assert.ok(dismissed);
    assert.equal(dismissed.status, 'dismissed');

    const afterDismiss = await svc.handle('session-1', { op: 'list', turn: 0 }, () => {});
    assert.equal(afterDismiss.length, 0);

    // 作用域失效时拒绝读取或渲染
    scopeRejected = true;
    await assert.rejects(svc.handle('session-1', { op: 'list', turn: 0 }, () => {}), /GENUI_SCOPE_CHANGED/);
  } finally {
    svc.close();
  }
});

test('白名单校验拒绝未知组件与越权动作；支持通过插件中间件动态注册新物料', () => {
  assert.throws(
    () =>
      parseAndValidateSchema(
        {
          componentName: 'EvilScriptRunner',
          props: { code: 'alert(1)' },
        },
        P1_MATERIALS_META,
      ),
    /INVALID_GENUI_COMPONENT:EvilScriptRunner/,
  );

  assert.throws(
    () =>
      parseAndValidateSchema(
        {
          componentName: 'GenuiCard',
          props: { title: '测试' },
          actions: {
            onClick: { action: 'dsh.board.forceDeleteAll' },
          },
        },
        P1_MATERIALS_META,
      ),
    /INVALID_GENUI_ACTION:dsh\.board\.forceDeleteAll/,
  );

  // 通过插件中间件注入自定义物料后可通过校验并写入技能文档
  const svc = new GenuiService(':memory:', {
    plugin: () => ({
      getMaterialsMeta: () => [
        {
          componentName: 'PluginSprintChart',
          description: '由外部插件注入的迭代进度图表。',
          props: { sprint: { type: 'string', description: '迭代名' } },
        },
      ],
    }),
  });
  try {
    const view = svc.render('session-plugin', 1, {
      schema: {
        componentName: 'GenuiCard',
        props: { title: '扩展插件视图' },
        children: [
          {
            componentName: 'PluginSprintChart',
            props: { sprint: 'Sprint-12' },
          },
        ],
      },
    });
    assert.equal(view.status, 'active');
    assert.equal(view.nodeCount, 2);

    const skillDoc = renderGenuiSkillContent(svc.materialsMeta());
    assert.match(skillDoc, /PluginSprintChart/);
    assert.match(GENUI_PROMPT, new RegExp(LOAD_GENUI_SKILL));
    assert.match(GENUI_PROMPT, new RegExp(RENDER_GENUI_TOOL));
    assert.equal(GENUI_SKILL, 'dsh-genui');
  } finally {
    svc.close();
  }
});

test('P2 与 P3 物料（DshProposalEmbed、DshSessionCompareGrid、DshTimeBlockList、DshPomodoroWidget）及受控动作通过校验与持久化', () => {
  const svc = new GenuiService(':memory:', { check() {} });
  try {
    const view = svc.render('session-p2-p3', 3, {
      title: '全工作台复合审批与时间块规划',
      schema: {
        componentName: 'GenuiCard',
        props: {
          title: '工作台协同大盘 (P2 + P3)',
          subtitle: '事务卡内嵌 · 会话对比 · 番茄时间块',
          badge: 'P2/P3',
        },
        children: [
          {
            componentName: 'DshProposalEmbed',
            props: {
              title: '待确认的看板与定时草稿',
              proposalIds: ['prop-board-1', 'prop-sched-2'],
              turn: 3,
            },
          },
          {
            componentName: 'DshSessionCompareGrid',
            props: {
              title: '多会话横向对比矩阵',
              sessions: [
                {
                  sessionId: 'sess-alpha',
                  title: 'GenUI 架构评审',
                  status: '已对齐',
                  conclusion: '采用 OpenTiny GenUI SDK + 受控动作白名单',
                  modules: ['plugins/dsh-superfish-genui', 'plugins/dsh-superfish'],
                  openItems: ['补充 P2/P3 集成单测'],
                },
              ],
            },
          },
          {
            componentName: 'DshTimeBlockList',
            props: {
              title: '今日专注时间块',
              blocks: [
                {
                  id: 'tb-1',
                  timeRange: '14:00 - 14:25',
                  title: '专注推进 P2 事务卡内嵌',
                  mode: 'focus',
                  durationMinutes: 25,
                  taskId: 'task-101',
                },
              ],
            },
          },
          {
            componentName: 'DshPomodoroWidget',
            props: {
              title: '番茄专注时钟',
              label: 'P3 跨插件联调',
              mode: 'focus',
            },
            actions: {
              onStart: {
                action: 'dsh.pomodoro.start',
                params: { mode: 'focus' },
              },
            },
          },
        ],
      },
    });
    assert.equal(view.status, 'active');
    assert.equal(view.nodeCount, 5);

    const skillDoc = renderGenuiSkillContent(svc.materialsMeta());
    assert.match(skillDoc, /DshProposalEmbed/);
    assert.match(skillDoc, /DshSessionCompareGrid/);
    assert.match(skillDoc, /DshTimeBlockList/);
    assert.match(skillDoc, /DshPomodoroWidget/);
    assert.match(skillDoc, /dsh\.pomodoro\.start/);
  } finally {
    svc.close();
  }
});
