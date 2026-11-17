# `@local/dsh-workspace-atlas` (仓库拓扑全景图)

面向 **DeepSeek Harness (`dsh`)** 的多仓工作区全景拓扑与单仓知识画像详情展示插件。

## 已实现能力

1. **按需关联引导与实时聚合**：
   - 初始未关联时展示极简空白引导页，支持手动**关联项目目录**（Roma 多仓工作区或单仓目录）或**关联仓库地址**（Git SSH / HTTP URL），关联状态持久化于 `~/.dsh/workspace-atlas-state.json`，不自动混入无关工作区。
   - 关联后实时解析工作区 `repos/.repo-list`、`.roma/init-selection.json`、`repos/index.md`、`docs/architecture/system-topology.md` 与各仓 `capabilities.yaml` / `overview.md` / `setup.md` / `test.md`。
   - 自动检测 `repos/.source/<repo>` 软链挂载状态，并实时采集已挂载仓库的 Git 分支与脏文件状态。
2. **极简左向右 4 层架构拓扑画布 (`Topology`)**：
   - 按 `CLIENT HOSTS` → `CLIENT SDKS` → `API GATEWAYS` → `AI & INFRA SERVICES` 展示架构流向。
   - 悬停或选中仓库节点时动态高亮上下游依赖边（`consumer`、`protocol-contract`、`same-domain` 及 `joint_regression` 联合回归边），平时保持低噪收敛。
   - 底部悬浮业务特性透视镜胶囊（`全部仓库`、`已挂载`、`AIGC / Rizz`、`商业化与支付`、`云控与埋点`、`输入引擎与皮肤`）。
3. **多仓检索矩阵 (`Repositories`)**：
   - 支持按仓库名、路径、技术栈与挂载状态过滤检索。
4. **单仓详情展示 (`仓库详情`)**：
   - 展示单仓挂载状态、软链目标路径、运行时与技术栈、Git 分支状态、`capabilities.yaml` 意图命令列表、`overview/setup/test/capabilities` 四件套原文预览，以及上下游契约跳转。
5. **Agent Tool (`workspace_atlas`)**：
   - 向 DSH Agent 注册只读工具 `workspace_atlas`，供会话内 Agent 按需查询全量拓扑或单仓契约。

## 验证与测试

```bash
cd plugins/dsh-workspace-atlas
npm run check
npm test
```

## 在 DSH 中加载 / 安装

### 方式一：本地打包安装（支持 DSH 桌面端插件管理）

在 `dsh-super-workbench` 仓库根目录执行：

```bash
pnpm --filter @local/dsh-workspace-atlas pack --pack-destination "$PWD"
```

将生成的 `local-dsh-workspace-atlas-0.1.0.tgz` 在 DSH 插件管理中选择本地安装包导入并重启即可。

### 方式二：在 `~/.dsh/profiles/desktop` 或 `web` 中直接软链

执行 `node plugins/dsh-workspace-atlas/install-desktop.mjs` 即可自动注册并软链至 `~/.dsh/profiles/desktop` 与 `~/.dsh/profiles/web`。
