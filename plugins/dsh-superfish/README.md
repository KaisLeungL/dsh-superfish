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

## 构建、校验与测试

```sh
# 构建类型声明与 Host/Preset/Client 产物
pnpm --filter @local/dsh-superfish run build

# 运行产物完整性、双语键与浏览器沙盒导入合规检查
pnpm --filter @local/dsh-superfish run check

# 运行全部 15 个测试套件（290 项单元与集成测试）
pnpm --filter @local/dsh-superfish test

# 打包发布产物 (.tgz)
node plugins/dsh-superfish/scripts/pack.mjs
```
