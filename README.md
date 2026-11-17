# DSH Super Workbench · DeepSeek Harness 智能体工作台

DSH Super Workbench 是一组面向 DeepSeek Harness（DSH）的插件。用任务看板管理项目工作，用 Super Agent 汇总待办和发起委派，通过 Agent Provider 接入外部智能体。定时任务和番茄钟分别服务于自动化安排和个人专注。

[是什么](#是什么) · [功能插件](#功能插件) · [快速上手](#快速上手) · [兼容性与已知限制](#兼容性与已知限制) · [项目来源](#项目来源)

## 是什么

工作台通过 DSH 的 profile 机制装配六个协同插件。任务看板负责记录任务和状态，大肥鱼（Super Agent）提供个人长期主理、联邦记忆、技能习得、目标自驱、协调派工、OpenTiny GenUI 生成式可视化卡片渲染、只读工作区上下文总线与定时任务生命周期/导航能力，仓库拓扑全景（Workspace Atlas）提供多仓架构拓扑与单仓知识画像速览，ACP Adapter 管理外部智能体接入及会话。

| 使用场景 | 从哪里开始 |
| --- | --- |
| 整理项目任务、查看执行进度 | 打开任务看板 |
| 汇总待办、管理记忆/技能/目标或跟进委派 | 打开大肥鱼（Super Agent）主页面与右侧四栏个人面板 |
| 浏览多仓架构拓扑、查看单仓知识画像与联调门禁 | 打开侧栏 All-In-One Workspace（仓库拓扑全景） |
| 接入外部 ACP 智能体 | 在 DSH 设置中配置 Agent Provider |
| 查看或管理定时任务 | 打开自动化任务面板（大肥鱼已内置定时任务 Host 服务与面板跳转导航） |
| 开始一段专注时间 | 点击侧栏底部的番茄钟 |

## 功能插件

| 插件 | 包名 | 版本 | 功能 |
| --- | --- | --- | --- |
| [大肥鱼 (SuperFish)](plugins/dsh-superfish/README.md) | `@local/dsh-superfish` | `1.0.0` | 个人长期主理与超级执行主理：联邦记忆、技能构建、长周期目标、待办、快捷提案、Worker 沙盒派工，内置 OpenTiny GenUI 生成式卡片服务（`superagentGenui` / `superagentGenuiClient`）、工作区只读上下文总线（`workspaceContext`）与定时任务宿主/导航服务（`schedule-host` / `scheduleNavigation`） |
| [仓库拓扑全景 (Workspace Atlas)](plugins/dsh-workspace-atlas/README.md) | `@local/dsh-workspace-atlas` | `0.1.0` | 多仓架构拓扑全景可视化、单仓四件套知识画像速览、SDK 联调门禁巡检与 `workspace_atlas` 工具 |
| [任务看板](plugins/dsh-task-board/README.zh.md) | `@linxin666/dsh-client-ui-task-board` | `0.4.16` | 管理任务、调度与执行记录，内含巡检、森林、GitHub、团队和远程模块 |
| [Agent Provider](plugins/dsh-acp-adapter/README.md) | `@zaimokuza/dsh-acp-adapter` | `0.2.2-rc.1-local.8` | 外部 ACP 智能体的配置、接入和会话管理 |
| [番茄钟](plugins/dsh-pomodoro/README.md) | `@local/dsh-pomodoro-clock` | `1.1.0` | 专注、休息计时和完成提醒 |
| [受管输入准入](plugins/dsh-input-admission-cap4/README.md) | `@local/dsh-input-admission-cap4` | `0.1.0` | 为受管会话提供输入提交前的授权检查 |

## 快速上手

### 获取源码与构建

使用 pnpm 10.28.0。ACP Adapter 的开发工具链固定为 Node.js 24.21.0。

```sh
git clone https://github.com/KaisLeungL/dsh-superfish.git
cd dsh-superfish
pnpm install --frozen-lockfile
pnpm -r --if-present run build
```

### 在 DSH 桌面客户端安装

每个插件保留自己的 `cordis.patch.yml`。进入桌面客户端的插件管理，按包安装本地插件产物，再重启客户端。以下以大肥鱼（`@local/dsh-superfish`）为例，在仓库根目录执行：

```sh
pnpm --filter @local/dsh-superfish pack --pack-destination "$PWD"
```

将生成的 `local-dsh-superfish-1.0.0.tgz` 作为本地安装包（或直接从 GitHub Release 下载预构建 `.tgz` 产物）。现有桌面环境升级时，先核对已装版本和本地包路径，尤其是使用定制版看板或 ACP Adapter 的环境。

## 兼容性与已知限制

- 当前依赖基线为 DSH `0.2.2-rc.1`。Super Agent 的受管运行依赖宿主提供 Cap4 输入准入能力。
- 输入准入配置会替换默认 Agent Loop，大肥鱼内置的 `schedule-host` 会接管宿主定时服务并保留内置 `ui-schedule` 面板，首次联调宜使用独立 profile。
- 原 `@local/dsh-superfish-genui`、`@local/dsh-workspace-context`、`@local/dsh-quick-actions-schedule-host` 与 `@local/dsh-quick-actions-schedule-ui` 已整合进 `@local/dsh-superfish` 随包构建，无需再单独安装。

## 项目来源

任务看板来自 [dsh-web](https://github.com/zhu1090093659/dsh-web)，本文档参考其[项目介绍与安装指南](https://github.com/zhu1090093659/dsh-web/blob/main/README.md)的组织方式。ACP Adapter 源自 `dsh-agent-manager`，其余插件来自本地 DSH 工作台开发项目及桌面安装产物。各插件的说明和许可信息见对应目录。
