---
name: dsh-genui
description: 基于 OpenTiny GenUI SDK SchemaJson 协议，在 DSH 会话中动态生成每日早晚报、待办盘点、近期会话总结与任务看板态势等交互式可视化卡片。
---

当用户请求以下场景时，使用 `steward_render_genui` 生成交互式可视化界面，替代冗长的纯文本罗列：
1. **每日早报 / 晚间复盘 / 今日待办与工作建议**（结合 `personal.todos`、`task-board.list`、`session.list`）。
2. **近期用户会话进展盘点与成果对比矩阵**（结合 `steward_list_sessions` 与 `steward_read_session`，使用 `DshSessionDigestList` 或 `DshSessionCompareGrid`）。
3. **任务看板进度概览、待规划梳理或阻塞诊断**（结合 `steward_list_tasks` 与 `steward_read_execution`，使用 `DshTaskTable`）。
4. **复合工作流审批与草稿内嵌（P2）**：当在盘点或早晚报的同时通过 `steward_propose_action` 为用户准备了看板卡片或定时任务草稿时，可在 GenUI 的 `SchemaJson` 中嵌入 `DshProposalEmbed` 节点，实现「分析盘点 → 行动建议 → 草稿确认创建」一屏闭环（无需在面板外重复渲染草稿卡）。
5. **个人专注时间块规划与番茄钟联动（P3）**：当用户要求安排上午/下午工作节奏或开启专注计时时，使用 `DshTimeBlockList` 与 `DshPomodoroWidget` 联动工作台番茄钟插件（`@local/dsh-pomodoro-clock`）。
6. **用户明确要求以卡片、面板、表格、仪表盘或可视化视图呈现信息**。

### 核心规则
1. **先查真实数据，再出 GenUI 卡片**：所有 `todoId`、`taskId`、`sessionId`、`proposalId` 必须来自当前轮次只读工具或 `steward_propose_action` 返回的真实数据，严禁凭空编造 ID 或状态。
2. **文卡协同、精炼回复**：调用 `steward_render_genui` 出卡后，回复正文只需用 2~3 句话给出核心结论与重点建议，详细列表与交互交由下方的 GenUI 卡片呈现，不要在正文中重复抄写整张表格。
3. **读写职责与直写协同**：`steward_render_genui` 负责展示洞察与内联快捷交互（如直接勾选完成待办、顺延待办、一键打开会话、启动番茄钟或查看看板卡片）；当用户**明确要求直接加入/完成/顺延个人待办**时，应先调用 `steward_create_todo` / `steward_update_todo` 真实写入，再用返回的真实 `id` 渲染 `DshTodoChecklist`；若是你主动梳理建议的候选待办，则不传真实 `id`，由用户在 `DshTodoChecklist` 点击「+ 加入待办」。若涉及新建看板卡片或参数未齐备的定时任务，调用 `steward_propose_action` 生成草稿并通过 `DshProposalEmbed` 内嵌呈现；参数齐全的定时任务可直接调用 `steward_create_schedule`。

### SchemaJson 协议格式（兼容 `@opentiny/genui-sdk-core`）
根节点与子节点均遵循 `{ componentName, props, children, actions }` 结构：

| 组件名称 (`componentName`) | 用途说明 | 关键 `props` 参数 |
| --- | --- | --- |
| `GenuiCard` (`TinyCard` / `AntdCard`) | 顶层或分区卡片容器 | `title` (标题)、`subtitle` (副标题)、`badge` (右上角状态角标)、`tone` (`default` \| `brand` \| `success` \| `warning` \| `danger`) |
| `GenuiGrid` (`AntdRow`) | 多列网格布局容器 | `columns` (`1` \| `2` \| `3` \| `4`，默认 `2`) |
| `GenuiTabs` (`AntdTabs`) | 多标签页切换容器 | `defaultActiveKey`、`items`: `[{ key, label, badge, children: [SchemaNode] }]` |
| `GenuiSection` (`AntdCollapse`) | 可折叠分组容器 | `title`、`subtitle`、`badge`、`defaultOpen` (`boolean`) |
| `GenuiAlert` (`AntdAlert`) | 重点结论或风险提示条 | `title`、`text` (必填)、`tone` (`info` \| `success` \| `warning` \| `danger`) |
| `DshMetricGroup` | 顶部核心指标概览卡组 | `title` (可选)、`items`: `[{ label, value, subtext, tone }]` |
| `DshTodoChecklist` | 可直接勾选/顺延的个人待办清单 | `title`、`emptyText`、`items`: `[{ id, title, localDate, done, category, boardTaskId, note }]`（`category` 可为 `overdue` \| `today` \| `upcoming` \| `doneToday`） |
| `DshSessionDigestList` | 带「打开会话」按钮的会话摘要列表 | `title`、`emptyText`、`items`: `[{ sessionId, title, workspaceTitle, status, summary, nextStep, updatedAt }]` |
| `DshTaskTable` | 带「查看卡片」按钮的看板任务视图 | `title`、`emptyText`、`items`: `[{ taskId, title, status, projectLabel, column, summary, blocker }]` |
| `DshProposalEmbed` (`DshProposalCard`) | 【P2】内嵌受控的看板/定时任务创建草稿卡 | `title`、`description`、`proposalId` (可选)、`proposalIds` (可选，省略时默认内嵌当前轮次全部草稿) |
| `DshSessionCompareGrid` (`DshSessionMatrix`) | 【P3】跨会话成果与遗留项对比矩阵 | `title`、`sessions`: `[{ sessionId, title, workspaceTitle, status, conclusion, modules, openItems: [{ title, boardTaskId }] }]` |
| `DshTimeBlockList` (`DshFocusPlanner`) | 【P3】个人专注时间块规划器（联动番茄钟） | `title`、`blocks`: `[{ timeRange, title, mode, durationMinutes, priority, todoId, taskId, note }]` |
| `DshPomodoroWidget` (`DshPomodoroCard`) | 【P3】工作台番茄钟实时状态与控制微视图 | `title`、`focusLabel` |
