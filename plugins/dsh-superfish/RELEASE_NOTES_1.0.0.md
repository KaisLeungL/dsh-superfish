# @local/dsh-superfish v1.0.0 Release Notes

**发布日期**：2026-11-16  
**里程碑版本**：`1.0.0`（Personal Agent & Super Agent 正式里程碑版本）  
**宿主兼容范围**：`dsh >=0.2.2-rc.1 <0.3.0`

---

## 一、里程碑概述

`v1.0.0` 标志着 **大肥鱼（`@local/dsh-superfish`）** 从早期工作区只读主理正式演进为具备完整闭环能力的 **Personal Agent（个人长期主理）+ Super Agent（超级执行主理）**：

1. **个人身份与双层心智（Personal Soul & Identity）**
   - 支持全局（`~/.dsh/SOUL.md`、`~/.dsh/USER.md`）与工作区（`<workspace>/.dsh/SOUL.md`）双层人设注入与双向同步。
   - 支持冷启动自动探测本机开发者画像（Git、Shell、IDE、Agent 生态配置）并一键导入核心记忆。

2. **双层联邦记忆与后台反思提炼（Dual-Scope Federated Memory）**
   - `MemoryService` 支持 `global`（跨工作区共享）与 `workspace`（项目级隔离）双作用域、SQLite FTS5 全文检索、核心记忆置顶（`pinned`）。
   - 自动镜像同步 `~/.dsh/GLOBAL_MEMORY.md` 与 `<workspace>/.dsh/MEMORY.md`。
   - `MemoryConsolidator` 在后台静默巡检已完成会话，自动提炼个人沟通偏好与关键架构决策。

3. **程序性技能习得与 `skills-creator`（Procedural Skills）**
   - 内置 `skills-creator`、`dsh-quick-actions`、`dsh-genui` 三大底层技能。
   - `DynamicSkillRegistry` 支持在对话或右侧面板将高频办事流程沉淀为标准 `.dsh/skills/<slug>/SKILL.md`（支持 `global` 与 `workspace` 作用域）。
   - 强制校验 `slug` 与 frontmatter `name` 符合英文小写 `kebab-case`（`^[a-z0-9]+(?:-[a-z0-9]+)*$`），确保宿主 100% 兼容识别。

4. **长周期目标与事件自驱推进（Autonomous Goals & Event Monitor）**
   - `GoalService`（`steward_list_goals` / `steward_manage_goal`）支持创建多阶段里程碑（Milestones）并绑定看板任务卡。
   - `EventMonitor` 实时监听 `taskBoard` 执行状态：当前置阶段看板卡执行完成且 `autoAdvance=true` 时，自动推进下一阶段里程碑并触发看板卡委派派工。

5. **超级执行力、沙盒工具与安全哨兵（Super Execution & Security Sentinel）**
   - `steward_propose_action` 支持直接生成携带 `permission: 'read-only' | 'workspace-write'` 与 `mode: 'claude-code' | 'codex' | 'gemini'` 的看板任务草稿卡，并支持简写参数自动归一化。
   - 委派 `workspace-write` 看板卡片时自动完成宿主权限确认并启动 Worker 执行。
   - Worker 沙盒支持受控文件读写（`steward_worker_read_file` / `steward_worker_write_file`）、白名单命令执行（`steward_worker_run_command`）与外部 HTTPS 连接器（`steward_external_fetch`，含 SSRF 防护与 `DSH_CONNECTOR_TOKEN_<NAME>` 凭证代持）。
   - `scrubSensitiveText` 安全哨兵在落盘记忆、技能与外部响应前自动抹除 API Key、Token、OTP 验证码、鉴权链接与防注入伪造标签。

6. **右侧四栏主理工作台（Right-Side Personal Panel UI）**
   - 顶部紧凑四栏导航：**工作概览**（今日待办 / 长周期目标 / 定时任务 / 近期活动）、**记忆库**、**技能库**、**主理配置**（基础信息 / 模型选择 / 人设 Soul / 初始记忆）。

---

## 二、质量门禁与构建指纹

- **构建检查（`npm run build`）**：`dependencies: 0`、`typecheck: 0`、`declarations: 0`、`bundle: 0`
- **合规校验（`npm run check`）**：23/23 项通过（覆盖 `lib/index.js`、`lib/preset.js`、`lib/client.js`、`icon.png`、`icon.svg`、`skills/*/SKILL.md` 及双语清单）
- **自动化测试（`npm test`）**：290/290 项通过（覆盖全部 15 个测试套件，0 失败）
- **发布产物包**：
  - `local-dsh-superfish-1.0.0.tgz`（SHA-256：`7d23288a02212cb1fa1dfcb8aacd6c96e2ab9eea0d0db416439e8e8dce7d53a2`）
  - `local-dsh-superfish-genui-0.1.0.tgz`（SHA-256：`18c23b203ad7971bc9a974fe5824c49264169848566ad3ecba3d65701a4d1020`）
