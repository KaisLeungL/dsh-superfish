# 大肥鱼 (`@local/dsh-superfish`)

面向 DeepSeek Harness（DSH）的 **Personal Agent（个人长期主理）+ Super Agent（超级执行主理）** 核心插件。

- **当前版本**：`1.0.0`
- **宿主兼容范围**：`dsh >=0.2.2-rc.1 <0.3.0`
- **版本发布说明**：[RELEASE_NOTES_1.0.0.md](./RELEASE_NOTES_1.0.0.md)
- **产品与设计规格**：[PRODUCT.md](./PRODUCT.md) · [DESIGN.md](./DESIGN.md)

## 核心特性

1. **双层身份与心智（Personal Soul & Identity）**：全局（`~/.dsh/SOUL.md`、`~/.dsh/USER.md`）与工作区（`.dsh/SOUL.md`）人设双向同步，冷启动自动探测本机开发者画像。
2. **双层联邦记忆（Dual-Scope Federated Memory）**：`global` 与 `workspace` 双层 SQLite FTS5 全文检索、置顶记忆、Markdown 镜像同步与后台会话自动反思提炼。
3. **程序性技能体系（Procedural Skills）**：内置 `skills-creator`、`dsh-quick-actions`、`dsh-genui` 技能，支持将高频流程沉淀为 `.dsh/skills/<slug>/SKILL.md`。
4. **长周期目标与事件自驱（Autonomous Goals & EventMonitor）**：多阶段里程碑绑定看板任务卡，监听看板执行完成事件自动推进下一里程碑并派工。
5. **超级执行力与安全哨兵（Super Execution & Security Sentinel）**：看板建卡与定时任务多卡草案、`read-only`/`workspace-write` 权限与 ACP `mode` 委派、Worker 沙盒文件读写/白名单命令、防 SSRF 外部连接器与敏感凭据自动脱敏。
6. **右侧四栏工作台**：集成工作概览、记忆库、技能库、主理配置四栏面板，支持 OpenTiny GenUI 动态卡片渲染。
7. **输入准入驱动内联（Agent Loop Cap4）**：Cap4 驱动以子路径 `@local/dsh-superfish/input-admission` 随本包发布（源码 `src/input-admission/runtime.js`，构建产物 `lib/input-admission/index.js`），本包的 `cordis.patch.yml` 负责禁用宿主原 `agent-loop` 条目并注册该驱动（`inputAdmissionVersion === 4`）。因此只需安装大肥鱼一个包，插件列表里只有大肥鱼一张卡；驱动未生效时，受管运行会以「输入准入能力4未提供」失败，而不是静默退回旧驱动。驱动为官方 AgentLoop 源码构建，随附 MIT 许可（`LICENSE-input-admission-cap4`）。
8. **内置 GenUI 生成式界面、上下文总线与定时任务协同**：随包集成 OpenTiny GenUI 中间层宿主与客户端注册中心（`@local/dsh-superfish/genui` / `superagentGenuiClient`）、只读工作区上下文总线（`@local/dsh-superfish/workspace-context` 及看板、定时任务、跨会话适配器）、定时任务宿主生命周期服务（`@local/dsh-superfish/schedule-host`）以及客户端定时任务面板联动定位服务（`scheduleNavigation`），单包安装即可闭环使用。

## 构建、校验与测试

```sh
# 构建类型声明与 Host/Preset/Client/Subpath 产物
pnpm --filter @local/dsh-superfish run build

# 运行产物完整性、双语键与浏览器沙盒导入合规检查
pnpm --filter @local/dsh-superfish run check

# 运行全部 16 个测试套件（291 项单元与集成测试）
pnpm --filter @local/dsh-superfish test

# 打包发布产物 (.tgz)
node plugins/dsh-superfish/scripts/pack.mjs
```

仓库为 pnpm workspace，包含 5 个插件包；输入准入驱动已内联为大肥鱼的子路径，不再是独立 workspace 包，打包时无需同步额外依赖版本。
