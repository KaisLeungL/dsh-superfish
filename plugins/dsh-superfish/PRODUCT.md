# 大肥鱼 · 工作区主理 Agent (`@local/dsh-superfish`)

面向 DeepSeek Harness（DSH）工作区使用者，提供集 **Personal Agent（个人长期主理）** 与 **Super Agent（超级执行主理）** 于一体的常驻协同入口。共享任务看板仍是唯一任务账本，大肥鱼负责跨工作区记忆沉淀、待办与长周期目标规划、看板派工协调、自动化定时提醒与进度复盘。

## 1.0 里程碑核心能力

1. **双层身份与人设（Personal Soul & Identity）**：支持全局（`~/.dsh/SOUL.md`、`~/.dsh/USER.md`）与工作区（`<workspace>/.dsh/SOUL.md`）双层人设注入与双向同步，提供冷启动开发者画像自动探测与初始记忆一键导入。
2. **双层联邦记忆（Dual-Scope Federated Memory）**：支持 `global` 与 `workspace` 双作用域 SQLite FTS5 全文检索、核心记忆置顶、Markdown 镜像同步（`~/.dsh/GLOBAL_MEMORY.md` 与 `<workspace>/.dsh/MEMORY.md`）及后台静默会话反思提炼。
3. **程序性技能体系（Procedural Skills）**：内置 `skills-creator`、`dsh-quick-actions`、`dsh-genui` 三大底层技能，支持在对话或右侧面板沉淀符合 `kebab-case` 规范的自定义 `.dsh/skills/<slug>/SKILL.md`。
4. **长周期目标与事件自驱（Autonomous Goals & EventMonitor）**：支持多阶段里程碑（Milestones）管理并与看板卡片绑定，监听看板任务执行完成事件自动推进下一里程碑并触发委派。
5. **超级执行力与安全哨兵（Super Execution & Security Sentinel）**：支持同轮多张提案草稿卡（看板建卡与定时任务）、`read-only` / `workspace-write` 沙盒权限与多角色 ACP `mode` 委派、Worker 受控文件读写/白名单命令执行、防 SSRF 外部 HTTPS 连接器及敏感凭据自动脱敏。
6. **多模态协同工作台（GenUI + 四栏面板）**：支持 OpenTiny GenUI 动态可视化卡片与右侧四栏个人面板（工作概览 / 记忆库 / 技能库 / 主理配置）。
