import { genPrompt, type MaterialsMetaMap, type SchemaJson } from './core.js';

export const P1_MATERIALS_META: MaterialsMetaMap = Object.freeze({
  GenuiCard: {
    componentName: 'GenuiCard',
    aliases: ['TinyCard', 'AntdCard', 'Card'],
    category: 'layout',
    description: '顶层或分区卡片容器，支持标题、副标题、右上角状态角标以及嵌套子组件。',
    allowChildren: true,
    props: {
      title: { type: 'string', description: '卡片主标题，例如「今日早间总结 · 11月14日」' },
      subtitle: { type: 'string', description: '副标题或工作区说明' },
      badge: { type: 'string', description: '右上角状态标签，例如「早报」「待处理 3 项」' },
      tone: {
        type: 'string',
        description: '视觉强调色调',
        enum: ['default', 'brand', 'success', 'warning', 'danger'],
      },
    },
  },
  GenuiGrid: {
    componentName: 'GenuiGrid',
    aliases: ['AntdRow', 'TinyGrid', 'Grid'],
    category: 'layout',
    description: '多列响应式网格容器，用于在卡片内并排排列多个模块。',
    allowChildren: true,
    props: {
      columns: { type: 'number', description: '列数（1~4，默认 2）' },
    },
  },
  GenuiTabs: {
    componentName: 'GenuiTabs',
    aliases: ['AntdTabs', 'TinyTabs', 'Tabs'],
    category: 'layout',
    description: '多标签页切换容器，适合在单张卡片中切换「今日待办」「近期会话」「看板任务」等不同维度视图。',
    allowChildren: true,
    props: {
      defaultActiveKey: { type: 'string', description: '默认激活的标签页 key' },
      items: {
        type: 'array',
        description: '标签页列表，每项为 { key: string, label: string, badge?: string, children: SchemaJson[] }',
        required: true,
      },
    },
  },
  GenuiSection: {
    componentName: 'GenuiSection',
    aliases: ['AntdCollapse', 'TinyCollapse', 'Collapse'],
    category: 'layout',
    description: '可折叠的分组区块，适合收纳次要列表或长盘点内容。',
    allowChildren: true,
    props: {
      title: { type: 'string', description: '分组标题', required: true },
      subtitle: { type: 'string', description: '分组辅助信息' },
      badge: { type: 'string', description: '分组数量角标，如「4 项」' },
      defaultOpen: { type: 'boolean', description: '是否默认展开，默认 true' },
    },
  },
  GenuiAlert: {
    componentName: 'GenuiAlert',
    aliases: ['AntdAlert', 'TinyAlert', 'Alert'],
    category: 'feedback',
    description: '高优先级提示条或今日核心推进建议横幅。',
    props: {
      title: { type: 'string', description: '提示标题，例如「今日优先工作建议」' },
      text: { type: 'string', description: '提示正文内容', required: true },
      tone: {
        type: 'string',
        description: '提示类型',
        enum: ['info', 'success', 'warning', 'danger'],
      },
    },
  },
  DshMetricGroup: {
    componentName: 'DshMetricGroup',
    aliases: ['MetricGroup', 'AntdStatisticGroup'],
    category: 'domain',
    description: '工作区核心指标概览卡组，展示逾期未完、今日待办、进行中看板卡片、近期活跃会话等关键数字。',
    props: {
      title: { type: 'string', description: '可选指标栏标题' },
      items: {
        type: 'array',
        required: true,
        description: '指标数组，每项包含 { label: string, value: string | number, subtext?: string, tone?: "default" | "brand" | "success" | "warning" | "danger" }',
      },
    },
  },
  DshTodoChecklist: {
    componentName: 'DshTodoChecklist',
    aliases: ['TodoChecklist'],
    category: 'domain',
    description: '交互式个人待办清单组件。用户可在卡片内直接勾选完成待办、顺延至明天、打开关联看板任务，或将建议项一键加入今日待办。',
    props: {
      title: { type: 'string', description: '清单分组标题，如「今日待办与逾期清理」' },
      emptyText: { type: 'string', description: '列表为空时的提示语' },
      items: {
        type: 'array',
        required: true,
        description: '待办数组，每项包含 { id?: string, title: string, localDate?: string, done?: boolean, category?: "overdue" | "today" | "upcoming" | "doneToday", boardTaskId?: string, note?: string }。已有待办务必传入真实 id；新建议项可省略 id 以显示「+ 加入待办」按钮。',
      },
    },
    events: {
      'dsh.personal.toggleTodo': '直接在卡片中勾选或取消勾选待办状态',
      'dsh.personal.moveTodoToday': '将即将待办迁移至今日待办（今天完成）',
      'dsh.personal.moveTodoTomorrow': '将未完成待办顺延至明天',
      'dsh.personal.createTodo': '将无 ID 的推荐待办项一键加入个人今日待办',
      'dsh.taskBoard.open': '打开待办关联的看板任务卡片',
    },
  },
  DshSessionDigestList: {
    componentName: 'DshSessionDigestList',
    aliases: ['SessionDigestList'],
    category: 'domain',
    description: '跨工作区用户会话进展盘点列表，展示会话状态、核心进展摘要、未闭环事项，并提供「打开会话」快捷跳转按钮。',
    props: {
      title: { type: 'string', description: '列表标题，如「近期会话进展脉络」' },
      emptyText: { type: 'string', description: '无相关会话时的提示文案' },
      items: {
        type: 'array',
        required: true,
        description: '会话数组，每项包含 { sessionId: string, title: string, workspaceTitle?: string, status?: "completed" | "running" | "needs_input" | "blank", summary?: string, nextStep?: string, updatedAt?: string }。sessionId 必须来自真实会话列表。',
      },
    },
    events: {
      'dsh.session.open': '在工作台中直接切换到目标用户会话',
    },
  },
  DshTaskTable: {
    componentName: 'DshTaskTable',
    aliases: ['TaskTable', 'DshBoardOverview'],
    category: 'domain',
    description: '任务看板卡片概览与阻塞诊断表，支持按状态筛选展示卡片标题、所属项目、当前状态、阻塞原因及「查看卡片」跳转动作。',
    props: {
      title: { type: 'string', description: '表格标题，如「重点看板卡片与阻塞项」' },
      emptyText: { type: 'string', description: '无匹配看板卡片时的提示文案' },
      items: {
        type: 'array',
        required: true,
        description: '看板卡片数组，每项包含 { taskId: string, title: string, status: string, projectLabel?: string, column?: string, summary?: string, blocker?: string }。taskId 必须来自真实看板查询结果。',
      },
    },
    events: {
      'dsh.taskBoard.open': '在任务看板中打开对应卡片详情',
    },
  },
  DshProposalEmbed: {
    componentName: 'DshProposalEmbed',
    aliases: ['DshProposalCard', 'DshActionCard', 'DshProposalGroup'],
    category: 'domain',
    description:
      '【P2 受控事务嵌入组件】将 steward_propose_action 生成的看板任务卡或定时任务可编辑草稿内嵌到 GenUI 布局中，支持单张或批量修改、预览与确认创建，同时自动去重避免底部重复出卡。',
    props: {
      title: { type: 'string', description: '内嵌事务区标题，例如「建议落地的看板任务与定时提醒」' },
      description: { type: 'string', description: '内嵌事务区辅助说明' },
      proposalId: { type: 'string', description: 'steward_propose_action 返回的单张草稿 ID（可选，省略时默认嵌入本轮全部草稿）' },
      proposalIds: {
        type: 'array',
        description: 'steward_propose_action 返回的多张草稿 ID 数组（可选，省略时默认嵌入本轮全部草稿）',
      },
    },
  },
  DshSessionCompareGrid: {
    componentName: 'DshSessionCompareGrid',
    aliases: ['DshSessionMatrix', 'DshSessionCompare'],
    category: 'domain',
    description:
      '【P3 跨会话成果对比矩阵】并排对比多个工作区会话的核心结论、涉及模块与遗留问题，支持一键跳转会话或将遗留问题批量转为今日个人待办。',
    props: {
      title: { type: 'string', description: '对比矩阵标题，如「跨会话成果与遗留项对比」' },
      sessions: {
        type: 'array',
        required: true,
        description:
          '会话对比数组，每项为 { sessionId: string, title: string, workspaceTitle?: string, status?: string, conclusion: string, modules?: string[], openItems?: { title: string, boardTaskId?: string }[] }',
      },
    },
    events: {
      'dsh.session.open': '跳转到目标用户会话',
      'dsh.personal.createTodo': '将某个会话的遗留问题一键加入今日个人待办',
    },
  },
  DshTimeBlockList: {
    componentName: 'DshTimeBlockList',
    aliases: ['DshFocusPlanner', 'DshTimeBlocks', 'DshPomodoroPlanner'],
    category: 'domain',
    description:
      '【P3 个人专注时间块规划器】按时间段规划专注节奏，每个时间块内置「开启专注」按钮联动工作台番茄钟 (@local/dsh-pomodoro-clock)，并支持内联勾选关联待办或跳转看板卡。',
    props: {
      title: { type: 'string', description: '规划器标题，如「今日下午专注时间块规划」' },
      blocks: {
        type: 'array',
        required: true,
        description:
          '时间块数组，每项为 { timeRange: string, title: string, mode?: "focus" | "break" | "review", durationMinutes?: number, priority?: "high" | "medium" | "low", todoId?: string, taskId?: string, note?: string }',
      },
    },
    events: {
      'dsh.pomodoro.start': '联动工作台番茄钟开启 25 分钟专注计时',
      'dsh.personal.toggleTodo': '直接勾选完成该时间块关联的个人待办',
      'dsh.taskBoard.open': '打开该时间块关联的看板任务卡片',
    },
  },
  DshPomodoroWidget: {
    componentName: 'DshPomodoroWidget',
    aliases: ['DshPomodoroCard', 'DshPomodoroControl'],
    category: 'domain',
    description:
      '【P3 跨插件番茄钟实时微视图】在 GenUI 面板内实时同步展示 @local/dsh-pomodoro-clock 的倒计时与状态（专注中/短休息/已暂停），并提供开始专注、暂停、继续、切换模式与重置按钮。',
    props: {
      title: { type: 'string', description: '番茄钟微视图标题，如「当前专注计时器」' },
      focusLabel: { type: 'string', description: '当前建议专注的目标任务说明' },
    },
    events: {
      'dsh.pomodoro.start': '开始专注或短休息',
      'dsh.pomodoro.pause': '暂停计时',
      'dsh.pomodoro.resume': '继续计时',
      'dsh.pomodoro.reset': '重置计时器',
    },
  },
});

export const P1_DAILY_BRIEFING_EXAMPLE: SchemaJson = {
  componentName: 'GenuiCard',
  props: {
    title: '今日早间工作台简报',
    subtitle: '综合个人待办、任务看板与近期会话记录',
    badge: '早报盘点',
    tone: 'brand',
  },
  children: [
    {
      componentName: 'DshMetricGroup',
      props: {
        items: [
          { label: '逾期未完', value: 1, subtext: '建议优先清理', tone: 'danger' },
          { label: '今日待办', value: 3, subtext: '已完成 1 项', tone: 'brand' },
          { label: '进行中卡片', value: 2, subtext: '看板活跃任务', tone: 'warning' },
          { label: '近期会话', value: 2, subtext: '含 1 项未闭环', tone: 'default' },
        ],
      },
    },
    {
      componentName: 'GenuiAlert',
      props: {
        title: '今日优先推进建议',
        text: '建议上午先闭环昨日「看板权限联调」会话遗留的单测问题，随后处理逾期的接口核对任务。',
        tone: 'info',
      },
    },
    {
      componentName: 'DshTodoChecklist',
      props: {
        title: '个人待办清单',
        items: [
          { id: 'todo-1', title: '核对 Cap4 准入边界回归测试', localDate: '2026-11-13', done: false, category: 'overdue' },
          { id: 'todo-2', title: '完善早晚报 GenUI 卡片交互验收', localDate: '2026-11-14', done: false, category: 'today' },
        ],
      },
    },
    {
      componentName: 'DshSessionDigestList',
      props: {
        title: '近期关键会话进展',
        items: [
          {
            sessionId: 'session-demo-1',
            title: '看板权限联调与回归测试',
            workspaceTitle: 'dsh-super-workbench',
            status: 'completed',
            summary: '已完成主理只读权限校验，定位到一处边界用例待补齐。',
            nextStep: '补齐回归单测并更新看板状态',
          },
        ],
      },
    },
    {
      componentName: 'DshTaskTable',
      props: {
        title: '看板重点关注卡片',
        items: [
          {
            taskId: 'card-demo-1',
            title: '实现大肥鱼 P1 GenUI 可视化插件层',
            status: 'running',
            projectLabel: 'dsh-super-workbench',
            summary: '正在接入 OpenTiny GenUI SDK 渲染器与四大领域组件',
          },
        ],
      },
    },
  ],
};

export function buildGenuiPrompt(extraMeta?: MaterialsMetaMap): string {
  const merged: MaterialsMetaMap = extraMeta ? { ...P1_MATERIALS_META, ...extraMeta } : P1_MATERIALS_META;
  return genPrompt('React', merged, {
    rules: [
      '所有 todo.id、session.sessionId、task.taskId、proposalId 必须取自当前轮次只读工具或 steward_propose_action 返回的真实数据，严禁伪造 ID。',
      '若向用户推荐一条尚未在个人待办中创建的新待办事项，可在 DshTodoChecklist.items 中省略 id 字段，前端会自动展示「+ 加入待办」按钮供用户一键添加。',
      '当在早晚报、复盘或规划分析的同时通过 steward_propose_action 生成了看板草稿卡或定时任务草稿时，可在 GenuiCard 底部嵌入 DshProposalEmbed 节点，将「分析盘点 + 草稿审批确认」整合在同一张面板内。',
      '总结对比多个近期会话并梳理遗留问题时，优先使用 DshSessionCompareGrid；为用户规划上午/下午工作节奏或专注时间块时，使用 DshTimeBlockList 并搭配 DshPomodoroWidget 联动番茄钟。',
      '调用 steward_render_genui 生成卡片后，文字回复保持精简（2~4 句话提炼重点），避免把卡片里的列表内容在正文重复抄写一遍。',
    ],
    examples: [P1_DAILY_BRIEFING_EXAMPLE],
  });
}
