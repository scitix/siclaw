# Tool 目录重构 — 里程碑

> 基于 [tool-restructure-DESIGN.md](./tool-restructure-DESIGN.md) 生成

## 步骤总览

| # | 名称 | 描述 | 依赖 | 预估文件数 |
|---|------|------|------|-----------|
| 1 | 消除 kubectl.ts | 搬移函数到 command-sets.ts，删除死代码 | 无 | ~5 |
| 2 | 移动 infra 文件 | 创建 infra/ 目录，git mv 基础设施文件，更新内部互引 | #1 | ~15 |
| 3 | 移动工具文件 | 创建 5 个类型目录，git mv 工具文件，更新工具对 infra 的引用 | #2 | ~25 |
| 4 | 更新外部 import + agent-factory 分组 | 更新 12 个外部消费者的 import 路径，重排 customTools 数组 | #3 | ~13 |
| 5 | 撰写 docs/design/tools.md | 工具开发规范文档 + CLAUDE.md 引用 | #4 | ~2 |
| 6 | 验证 | tsc + 全量测试 | #5 | 0 |

## 详细步骤

### 步骤 1：消除 kubectl.ts

- **目标**：将 `kubectl.ts` 中被依赖的 3 个函数搬到 `command-sets.ts`，删除 `kubectl.ts` 及其死代码
- **涉及文件**：
  - `src/tools/command-sets.ts` — 接收 `SAFE_SUBCOMMANDS`, `validateExecCommand()`, `hasAllNamespacesWithoutSelector()`, `ALL_NS_RESTRICTED`
  - `src/tools/restricted-bash.ts` — import 从 `./kubectl.js` 改为 `./command-sets.js`
  - `src/tools/kubectl.test.ts` — 删除 `createKubectlTool` 测试，保留 `validateExecCommand` / `hasAllNamespacesWithoutSelector` 测试，import 改为 `./command-sets.js`
  - `src/tools/sensitive-path-protection.test.ts` — import 从 `./kubectl.js` 改为 `./command-sets.js`
  - `src/tools/kubectl.ts` — 删除
- **验收标准**：
  - `npx tsc --noEmit` 通过
  - `npx vitest run src/tools/command-sets.test.ts src/tools/kubectl.test.ts src/tools/restricted-bash.test.ts src/tools/sensitive-path-protection.test.ts` 通过
  - `src/tools/kubectl.ts` 不再存在
  - `restricted-bash.ts` 不再从 `kubectl.js` 导入
- **对应设计章节**：DESIGN.md > 模块 1

### 步骤 2：移动 infra 文件

- **目标**：创建 `src/tools/infra/` 目录，将 13 个基础设施文件及其测试移入，更新 infra 文件之间的互相引用（应该不需要改，因为它们互引用的是 `./xxx.js`，移入同一目录后不变）
- **涉及文件**：
  - 移动：command-sets.ts, command-validator.ts, output-sanitizer.ts, kubectl-sanitize.ts, sanitize-env.ts, exec-utils.ts, debug-pod.ts, k8s-checks.ts, kubeconfig-resolver.ts, credential-manager.ts, tool-render.ts, script-resolver.ts
  - 测试一起移动：command-sets.test.ts, command-validator.test.ts（如有）, kubectl.test.ts（已改为 command-sets 测试）, output-sanitizer.test.ts, restricted-bash.test.ts（不移，属于 shell/）, pod-exec.test.ts（不移，属于 k8s-exec/）, node-exec.test.ts（不移）, kubeconfig-resolver.test.ts, sanitize-env.test.ts, sensitive-path-protection.test.ts, kubectl-sanitize.test.ts, credential-manager.test.ts
- **验收标准**：
  - `src/tools/infra/` 包含全部 13 个基础设施源文件
  - infra 文件内部互引（`./xxx.js`）无需修改
  - `npx tsc --noEmit` 会报错（外部引用尚未更新，这是预期的，步骤 3-4 修复）
- **对应设计章节**：DESIGN.md > 模块 2

### 步骤 3：移动工具文件

- **目标**：创建 5 个类型目录，将工具文件移入，更新工具文件内部对 infra 的引用
- **涉及文件**：
  - `k8s-exec/`：node-exec.ts, pod-exec.ts, pod-nsenter-exec.ts + 测试
  - `k8s-script/`：node-script.ts, pod-script.ts, netns-script.ts
  - `shell/`：restricted-bash.ts, run-skill.ts + restricted-bash.test.ts
  - `query/`：memory-search.ts, memory-get.ts, knowledge-search.ts, credential-list.ts, cluster-info.ts, investigation-feedback.ts
  - `workflow/`：dp-tools.ts, create-skill.ts, update-skill.ts, fork-skill.ts, manage-schedule.ts, save-feedback.ts + deep-search/（整体移动）
- **import 更新规则**：
  - 工具 → infra：`./xxx.js` → `../infra/xxx.js`
  - 工具 → 同目录工具：保持 `./xxx.js`
  - 工具 → 其他类型工具：`./xxx.js` → `../{category}/xxx.js`
  - deep-search/ 内部：`../xxx.js` → `../../infra/xxx.js` 或 `../../{category}/xxx.js`（见 DESIGN.md 表格）
  - deep-search/ → core/memory：`../../xxx/` → `../../../xxx/`
- **验收标准**：
  - `src/tools/` 根目录下不再有任何 `.ts` 文件（全部进入子目录）
  - 每个子目录包含正确的文件集
  - `npx tsc --noEmit` 会报错（外部引用尚未更新，步骤 4 修复）
- **对应设计章节**：DESIGN.md > 模块 2 + 模块 3 (3a)

### 步骤 4：更新外部 import + agent-factory 分组

- **目标**：更新所有 `src/tools/` 外部消费者的 import 路径，重排 agent-factory 中 customTools 数组
- **涉及文件**：
  - `src/core/agent-factory.ts` — 23 条 import 路径 + customTools 分组重排
  - `src/core/extensions/deep-investigation.ts` — 6 条
  - `src/core/extensions/setup.ts` — credential-manager → infra/
  - `src/core/brains/claude-sdk-brain.ts` — dp-tools → workflow/
  - `src/agentbox/session.ts` — dp-tools → workflow/
  - `src/agentbox/http-server.ts` — dp-tools + deep-search → workflow/
  - `src/gateway/rpc-methods.ts` — dp-tools → workflow/
  - `src/cli-main.ts` — debug-pod → infra/
  - `src/agentbox-main.ts` — debug-pod → infra/
  - `src/memory/topic-consolidator.ts` — deep-search → workflow/deep-search
  - `src/memory/knowledge-extractor.ts` — 同上
  - `src/memory/topic-consolidator.test.ts` — 同上
- **验收标准**：
  - `npx tsc --noEmit` 通过（零错误）
  - `npm test` 全量通过
  - agent-factory.ts 中 customTools 按 5 类分组，有注释标明
- **对应设计章节**：DESIGN.md > 模块 3 (3b, 3c)

### 步骤 5：撰写 docs/design/tools.md

- **目标**：新建工具开发规范文档，约束后续贡献者
- **涉及文件**：
  - 新建 `docs/design/tools.md`
  - 更新 `CLAUDE.md` — Key File Map 和 "When starting a session as developer" 中添加引用
- **验收标准**：
  - `docs/design/tools.md` 存在且覆盖 DESIGN.md 模块 4 定义的 7 个章节
  - `CLAUDE.md` 中有 `docs/design/tools.md` 的引用
- **对应设计章节**：DESIGN.md > 模块 4

### 步骤 6：最终验证

- **目标**：确认整个重构零行为变更
- **验证项目**：
  - `npx tsc --noEmit` — 零错误
  - `npm test` — 全量通过
  - `src/tools/` 根目录下无 `.ts` 文件残留
  - 无文件从 `src/tools/*.ts` 直接导入（只从子目录导入）
- **对应设计章节**：全文
