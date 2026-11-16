---
name: skills-creator
description: 创建或更新大肥鱼自定义程序性技能（SKILL.md）的底层元技能规范，约束英文 kebab-case 命名、YAML Frontmatter 结构、三阶段渐进式披露与 SOP 编写准则。
---

# Skills Creator（大肥鱼技能创建与规范化指南）

当用户要求教大肥鱼一套固定的办事流程、沉淀标准作业程序（SOP）、创建或更新自定义技能（`SKILL.md`）时，必须遵循本技能规范。

## 1. 核心原则（Core Principles）

1. **假设模型已具备基础推理能力（Assume Capability）**：
   - 只在技能中写入真正改变决策、明确工具调用顺序或约束输出格式的**非显而易见信息（Non-obvious guidance）**。
   - 剔除空洞的套话、重复的常规礼貌用语和与任务无关的边缘假设。
2. **严守用户意图与权限边界（Preserve Intent & Scope）**：
   - 技能用于固化办事流程与判断标准，不得暗自扩大执行权限、绕过审批卡片或将单次临时特例硬编码为全局死规矩。
3. **精准低成本发现与渐进式披露（Progressive Disclosure）**：
   - **第一阶段（Frontmatter `name` + `description`）**：在技能目录中常驻可见。`description` 必须用 1~2 句话精准说明“该技能做什么”及“何时触发”，避免宽泛包揽导致误触发。
   - **第二阶段（`SKILL.md` 正文 SOP）**：仅在命中技能并调用 `steward_load_custom_skill` 时加载。包含具体步骤、真实工具调用链、数据核实护栏与输出模板。
   - **第三阶段（按需参考）**：保持技能自包含，仅引用目标环境中真实存在的工具或资源。

---

## 2. 宿主强制命名与 Frontmatter 规范（Mandatory Host Specification）

DSH 宿主与技能管理器对 `SKILL.md` 的 YAML Frontmatter 有严格的格式校验：

```yaml
---
name: friday-board-audit
description: 每周五盘点看板时，汇总进行中的卡片并对比长周期目标标出阻塞项，按「模块 | 负责人 | 风险」输出表格。
triggers: ["周五盘点", "看板周报", "friday audit"]
---
```

### 命名铁律（Naming Invariants）
- **`name` 与 `slug` 必须是纯英文 Kebab-Case**：
  - 仅允许使用**英文小写字母（`a-z`）、数字（`0-9`）与单连字符（`-`）**，必须满足正则 `^[a-z0-9]+(?:-[a-z0-9]+)*$`（长度 2~64 字符）。
  - 推荐使用简短的动词/领域组合名，例如：`friday-board-audit`、`weekly-progress-diff`、`pr-risk-review`、`daily-standup-digest`。
  - **严禁在 `name` 字段中使用中文（如 `周五看板盘点`）、大写字母、下划线（`_`）或空格**——否则 DSH 宿主会拒绝启用并报错「宿主不支持此技能名称格式（仅支持英文小写字母、数字与连字符），无法启用」。
- **中文名称的位置**：
  - 技能的中文标题（如 `周五看板盘点 SOP`）应传入 `displayName` 参数，或直接作为 `SKILL.md` 正文的一级标题（`# 周五看板盘点 SOP`），绝不能写入 Frontmatter 的 `name` 字段。

---

## 3. 编写高质量技能正文的四个要素

在组织 `instructions`（即 `SKILL.md` 正文）时，应包含以下结构：

1. **触发时机与适用边界**：明确什么用户诉求或定时任务场景下启用该技能，什么情况不适用。
2. **确定性工具调用步骤**：
   - 写明每一步应调用的大肥鱼工具名称（如 `steward_list_tasks`、`steward_read_task`、`steward_list_goals`、`steward_list_todos`、`steward_list_sessions`、`steward_external_fetch`、`steward_render_genui` 等）及关键筛选参数。
3. **数据真实性与异常分流约束**：
   - 所有任务 ID、状态、负责人、结论必须来自当轮工具真实返回，严禁凭标题臆测或编造。
   - 明确区分「查询结果为空」「工具不可用/超时」「权限不足」三种状态的处理方式。
4. **交付物格式模板**：
   - 给出明确的表格列定义、GenUI 组件结构或简报段落模板，以及“结论先行”等表达约束。

---

## 4. 创建与更新执行闭环

1. 根据用户口述的流程，先提炼符合 `^[a-z0-9]+(?:-[a-z0-9]+)*$` 规范的英文 `name`（同时作为 `slug`）与中文 `displayName`。
2. 编写精炼的 `description`（含触发场景）与结构化的 Markdown `instructions` 正文。
3. 调用 `steward_save_custom_skill`（传入英文 kebab-case 的 `name` / `slug`、`displayName`、`description`、`triggers`、`instructions` 及 `scope: 'workspace' | 'global'`）完成持久化落盘。
