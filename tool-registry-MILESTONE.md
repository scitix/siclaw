# Tool Registry — 里程碑

> 基于 [tool-registry-DESIGN.md](./tool-registry-DESIGN.md) 生成

## 步骤总览

| # | 名称 | 描述 | 依赖 | 预估文件数 | 状态 |
|---|------|------|------|-----------|------|
| 1 | 提取共享类型到 `core/types.ts` | 模块 0：搬迁 Ref 类型 + SessionMode + DP 类型 | 无 | ~20 | ✅ |
| 2 | 创建 ToolRegistry | 模块 1：`core/tool-registry.ts` 接口和类 | #1 | 1 | ✅ |
| 3 | 添加 registration 导出 | 模块 2：19 个工具文件各添加 `export const registration` | #2 | 19 | ✅ |
| 4 | 创建汇总入口 + 重构 agent-factory | 模块 3 + 4：`all-entries.ts` + agent-factory 使用 registry | #3 | 3 | ✅ |
| 5 | 验证 + 文档更新 | 全量测试、类型检查、更新 tools.md | #4 | ~2 | ✅ |

## 详细步骤

### 步骤 1：提取共享类型到 `core/types.ts`

- **目标**：新建 `src/core/types.ts`，集中所有散落的共享类型，消除 core→tools 类型循环依赖
- **涉及文件**：
  - 新增：`src/core/types.ts`
  - 修改（删除原定义）：`agent-factory.ts`（KubeconfigRef、LlmConfigRef、SessionMode）、`tools/workflow/deep-search/tool.ts`（MemoryRef）、`tools/workflow/dp-tools.ts`（DpStatus、DpHypothesis、DpStateRef、MutableDpStateRef）
  - 修改（更新 import 路径）：~19 个文件
- **验收标准**：
  - `npx tsc --noEmit` 通过，零类型错误
  - `npm test` 通过
  - `src/core/types.ts` 不 import 任何 `tools/` 文件
  - 原定义文件中不再有被搬迁的 interface/type 定义
- **对应设计章节**：DESIGN.md > 模块 0

### 步骤 2：创建 ToolRegistry

- **目标**：新建 `src/core/tool-registry.ts`，实现 `ToolEntry` 接口和 `ToolRegistry` 类
- **涉及文件**：
  - 新增：`src/core/tool-registry.ts`
- **验收标准**：
  - `npx tsc --noEmit` 通过
  - `ToolEntry` 接口包含 `category`、`create`、`modes?`、`platform?`、`available?` 五个字段
  - `ToolRegistry.resolve()` 实现三步过滤：mode + available → 实例化 → allowedTools（platform 豁免）
  - 从 `./types.js` import 所有 Ref 类型，无 tools/ 依赖
- **对应设计章节**：DESIGN.md > 模块 1

### 步骤 3：添加 registration 导出

- **目标**：在 18 个工具文件中各添加 `export const registration: ToolEntry`
- **涉及文件**：
  - `src/tools/cmd-exec/node-exec.ts`、`pod-exec.ts`、`restricted-bash.ts`
  - `src/tools/script-exec/node-script.ts`、`pod-script.ts`、`local-script.ts`
  - `src/tools/query/credential-list.ts`、`cluster-info.ts`、`knowledge-search.ts`、`resolve-pod-netns.ts`、`memory-search.ts`、`memory-get.ts`
  - `src/tools/workflow/deep-search/investigation-feedback.ts`、`tool.ts`
  - `src/tools/workflow/save-feedback.ts`、`manage-schedule.ts`、`create-skill.ts`、`update-skill.ts`、`fork-skill.ts`
- **验收标准**：
  - `npx tsc --noEmit` 通过
  - 每个工具文件有且仅有一个 `export const registration: ToolEntry`
  - 条件工具的 `modes` 与原 agent-factory 的 if 条件一致：`manage_schedule` → `["web", "channel"]`，skill 工具 → `["web"]`
  - platform 工具标记与原 `PLATFORM_TOOLS` Set 一致：`credential_list`、`cluster_info`、`knowledge_search`、`save_feedback`、`manage_schedule`
  - memory 工具有 `available: (refs) => !!refs.memoryIndexer`
  - 现有 `createXxxTool` 函数签名不变
- **对应设计章节**：DESIGN.md > 模块 2

### 步骤 4：创建汇总入口 + 重构 agent-factory

- **目标**：创建 `src/tools/all-entries.ts`，重构 `agent-factory.ts` 使用 ToolRegistry，提前 memoryIndexer 初始化
- **涉及文件**：
  - 新增：`src/tools/all-entries.ts`
  - 修改：`src/core/agent-factory.ts`
- **验收标准**：
  - `npx tsc --noEmit` 通过
  - `npm test` 通过
  - agent-factory.ts 中不再有硬编码的 `createXxxTool()` 调用列表和 `PLATFORM_TOOLS` Set
  - agent-factory.ts 中不再有 `if (mode !== "cli")` / `if (mode === "web")` 的工具注册条件
  - agent-factory.ts 中不再有 L607-632 的 memory 工具单独注册逻辑
  - `allToolEntries` 顺序与原 customTools 一致（investigationFeedback 在 query 分区第 1 位）
  - MCP 工具仍受 allowedTools 过滤
  - 文件 I/O 工具不受 allowedTools 过滤
  - agent-factory.ts 顶部的 ~20 行 createXxxTool import 已清理
- **对应设计章节**：DESIGN.md > 模块 3 + 模块 4

### 步骤 5：验证 + 文档更新

- **目标**：全量验证、更新设计文档
- **涉及文件**：
  - `docs/design/tools.md`（§7 Registration 章节）
- **验收标准**：
  - `npm test` 全部通过
  - `npx tsc --noEmit` 零错误
  - `docs/design/tools.md` §7 更新为 ToolRegistry 模式的描述
  - MILESTONE.md 各步骤标记为已完成
