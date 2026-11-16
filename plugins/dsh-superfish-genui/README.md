# `@local/dsh-superfish-genui`

基于 [OpenTiny GenUI SDK](https://github.com/opentiny/genui-sdk/blob/dev/README.zh-CN.md) 规范设计的 **大肥鱼 (`@local/dsh-superfish`) 生成式 UI 中间层插件**。

## 核心职责

1. **Host 侧服务 (`superagentGenui`)**
   - `genPrompt(framework, materialsMeta, customConfig)`：将注册的组件物料元数据 (`MaterialMeta`) 动态编译为 LLM 系统提示词与 Schema 规范。
   - `repairJson(raw)`：针对流式/残缺 JSON 块进行栈式括号与引号闭合修复。
   - `StreamPatternExtractor`：从流式文本中提取 `schema-json` 块。
   - `registerMaterialMeta(meta)` / `getMaterialsMeta()`：供大肥鱼与扩展插件动态注册自定义可视化物料描述。

2. **Client 侧服务 (`superagentGenuiClient`)**
   - `registerMaterial(name, Component)`：动态向大肥鱼 `<GenuiConfigProvider>` 注入自定义 React 物料组件。
   - `registerAction(name, handler)`：动态注入受控前端交互动作（`customActions`）。
