# Tool 目录重构 — 方案设计

## 背景与目标

`src/tools/` 目录下 40+ 文件平铺在一个目录中：工具定义、安全策略、K8s 执行基础设施、输出处理全部混在一起。随着团队扩展和新执行工具的增加，新贡献者必须理解完整的安全管道并手动复制 10 步编排流程，容易遗漏关键步骤（如输出消毒）导致安全漏洞。

**目标**：将工具按 5 种类型分组到子目录，共享基础设施独立为 `infra/`。纯结构重构，零行为变更。为后续每类工具独立做抽象（执行模板提取）铺路。

## 整体方案

### 分类依据

按 `execute()` 的实际行为模式分为 5 种类型：

| 类型 | 名称 | 工具数 | 核心特征 |
|------|------|--------|----------|
| A | K8s 命令执行 | 3 | 远程执行用户命令，需命令验证+输出消毒 |
| B | K8s 脚本执行 | 3 | 远程执行预置脚本，无命令验证 |
| C | 本地 Shell | 2 | 本地进程执行，各自逻辑独特 |
| D | 数据查询 | 6 | 纯内存/DB/文件操作，无进程 spawn |
| E | 用户工作流 | 5+ | 面向用户的高层业务动作 |

共享基础设施（安全策略、K8s 执行、输出处理）独立为 `infra/`。

### 目标目录结构

```
src/tools/
  ├── k8s-exec/              类型 A
  │   ├── node-exec.ts
  │   ├── pod-exec.ts
  │   └── pod-nsenter-exec.ts
  │
  ├── k8s-script/            类型 B
  │   ├── node-script.ts
  │   ├── pod-script.ts
  │   └── netns-script.ts
  │
  ├── shell/                 类型 C
  │   ├── restricted-bash.ts
  │   └── run-skill.ts
  │
  ├── query/                 类型 D
  │   ├── memory-search.ts
  │   ├── memory-get.ts
  │   ├── knowledge-search.ts
  │   ├── credential-list.ts
  │   ├── cluster-info.ts
  │   └── investigation-feedback.ts
  │
  ├── workflow/              类型 E
  │   ├── deep-search/         (已有子目录，整体迁移)
  │   ├── dp-tools.ts
  │   ├── create-skill.ts
  │   ├── update-skill.ts
  │   ├── fork-skill.ts
  │   ├── manage-schedule.ts
  │   └── save-feedback.ts
  │
  └── infra/                 共享基础设施
      ├── command-sets.ts      命令白名单 + 规则声明 + SAFE_SUBCOMMANDS 等
      ├── command-validator.ts 6-pass 验证管道
      ├── output-sanitizer.ts  后置消毒
      ├── kubectl-sanitize.ts  kubectl 敏感资源检测
      ├── sanitize-env.ts      环境变量消毒
      ├── exec-utils.ts        进程 spawn、环境准备
      ├── debug-pod.ts         Debug Pod 生命周期
      ├── k8s-checks.ts        Pod/Node 就绪检查
      ├── kubeconfig-resolver.ts 凭证解析
      ├── credential-manager.ts  凭证管理
      ├── tool-render.ts       输出格式化/截断/TUI 渲染
      └── script-resolver.ts   Skill 脚本路径解析
```

## 详细设计

### 模块 1：消除 kubectl.ts

- **做什么**：`kubectl.ts` 中的 `createKubectlTool()` 未被 agent-factory 注册，是死代码，连同其测试一并删除。其中 3 个函数被 `restricted-bash.ts` 依赖，需先搬走：
  - `SAFE_SUBCOMMANDS`
  - `validateExecCommand()`
  - `hasAllNamespacesWithoutSelector()`
- **怎么做**：将这 3 个函数及其依赖的辅助常量（`ALL_NS_RESTRICTED`）移入 `command-sets.ts`（它们本质上是命令级验证规则，属于安全策略层）。`kubectl.ts` 中还从 `command-sets.ts` 导入了 `ALLOWED_COMMANDS`, `CONTAINER_SENSITIVE_PATHS`, `parseArgs`, `validateCommandRestrictions`，移入后这些变成同文件内部引用。然后删除 `kubectl.ts`。
- **关键决策**：把验证函数放在 `command-sets.ts` 而非 `command-validator.ts`，因为 `validateExecCommand` 依赖 `ALLOWED_COMMANDS` 和 `validateCommandRestrictions`（都在 command-sets 中），放在一起避免引入新的跨文件依赖。
- **影响范围**：
  - `src/tools/restricted-bash.ts` — import 从 `./kubectl.js` 改为 `./command-sets.js`
  - `src/tools/kubectl.test.ts` — `createKubectlTool` 相关测试删除；`validateExecCommand`、`hasAllNamespacesWithoutSelector` 测试保留，import 改为从 `command-sets.js`
  - `src/tools/sensitive-path-protection.test.ts` — 从 `kubectl.ts` 导入 `validateExecCommand`，改为从 `command-sets.js` 导入
  - 删除 `src/tools/kubectl.ts`

### 模块 2：创建目录结构并移动文件

- **做什么**：创建 6 个子目录，移动所有工具和基础设施文件
- **怎么做**：使用 `git mv` 移动文件以保留 blame 历史。按上述目录结构逐一移动
- **关键决策**：测试文件跟随源文件一起移动（`command-sets.test.ts` → `infra/`，`pod-exec.test.ts` → `k8s-exec/` 等）
- **影响范围**：src/tools/ 下所有文件

### 模块 3：更新所有 import 路径 + agent-factory 分组

模块 2 移动文件后，一次性更新所有 import 路径（外部 + 内部），避免文件被反复修改。

#### 3a. 内部 import（工具 → infra）

工具文件移入子目录后，对 infra 文件的 import 从 `./xxx.js` 变为 `../infra/xxx.js`。同一子目录内的文件互相引用保持 `./xxx.js`。infra 内部互相引用保持 `./xxx.js` 不变。

**deep-search/ 特殊处理**：此子目录从 `src/tools/deep-search/` 移到 `src/tools/workflow/deep-search/`，路径多一层。具体变化：

| 文件 | 当前 import | 移动后 import |
|------|------------|--------------|
| `sub-agent.ts` → restricted-bash | `../restricted-bash.js` | `../../shell/restricted-bash.js` |
| `sub-agent.ts` → node-exec | `../node-exec.js` | `../../k8s-exec/node-exec.js` |
| `engine.ts` → kubeconfig-resolver | `../kubeconfig-resolver.js` | `../../infra/kubeconfig-resolver.js` |
| `tool.ts` → dp-tools | `../dp-tools.js` | `../dp-tools.js`（同在 workflow/，不变） |

对 `../../core/` 和 `../../memory/` 的 import 变为 `../../../core/` 和 `../../../memory/`。

#### 3b. 外部 import（src/tools/ 外的文件）

import 路径核心变化模式：
- `../tools/xxx.js` → `../tools/{category}/xxx.js`
- `../../tools/xxx.js` → `../../tools/{category}/xxx.js`
- `./tools/xxx.js` → `./tools/{category}/xxx.js`

**高影响**（多条 import）：
- `src/core/agent-factory.ts` — 23 条 import
- `src/core/extensions/deep-investigation.ts` — 6 条
- `src/core/extensions/setup.ts` — 9 条（全部指向 infra/credential-manager）
- `src/agentbox/http-server.ts` — 4 条

**低影响**（1-3 条 import）：
- `src/core/brains/claude-sdk-brain.ts` — dp-tools → workflow/
- `src/agentbox/session.ts` — dp-tools → workflow/
- `src/gateway/rpc-methods.ts` — dp-tools → workflow/
- `src/cli-main.ts` — debug-pod → infra/
- `src/agentbox-main.ts` — debug-pod → infra/
- `src/memory/topic-consolidator.ts` — deep-search/sub-agent → workflow/deep-search/sub-agent
- `src/memory/knowledge-extractor.ts` — deep-search/sub-agent → workflow/deep-search/sub-agent
- `src/memory/topic-consolidator.test.ts` — 同上

#### 3c. agent-factory customTools 分组

`customTools` 数组重排为：

```typescript
const customTools: ToolDefinition[] = [
  // ── K8s command execution ──
  createNodeExecTool(kubeconfigRef, userId),
  createPodExecTool(kubeconfigRef),
  createPodNsenterExecTool(kubeconfigRef, userId),
  // ── K8s script execution ──
  createNodeScriptTool(kubeconfigRef, userId),
  createPodScriptTool(kubeconfigRef),
  createNetnsScriptTool(kubeconfigRef, userId),
  // ── Local shell ──
  createRestrictedBashTool(kubeconfigRef),
  createRunSkillTool(kubeconfigRef, sessionIdRef),
  // ── Data query ──
  createInvestigationFeedbackTool(memoryRef),
  createCredentialListTool(kubeconfigRef),
  createClusterInfoTool(kubeconfigRef),
  createKnowledgeSearchTool(opts?.knowledgeIndexer),
  // ── Workflow ──
  createDeepSearchTool(kubeconfigRef, llmConfigRef, memoryRef, dpStateRef),
  createSaveFeedbackTool(sessionIdRef),
];
```

条件 push 的工具也加注释：memory tools（query）在 memoryIndexer 初始化后 push，skill CRUD（workflow）在 mode === "web" 时 push，manage_schedule（workflow）在 mode !== "cli" 时 push。

### 模块 4：撰写工具开发规范文档

- **做什么**：在 `docs/design/tools.md` 新建工具开发规范，约束后续贡献者如何新增和修改工具
- **怎么做**：文档用英文撰写（与 invariants.md / security.md 保持一致），覆盖以下内容：
- **影响范围**：新增 `docs/design/tools.md`，在 CLAUDE.md 的 Key File Map 中添加引用

文档结构：

```
# Tool Development Guide

## 1. Directory Structure & Classification
  - 6 个子目录的分类规则，每类的特征描述
  - 决策树：新工具应该放在哪个目录

## 2. Tool Definition Contract
  - ToolDefinition 接口的必填字段
  - 工厂函数 + 闭包注入模式
  - 统一返回格式 { content, details }

## 3. K8s Command Execution Tools (k8s-exec/)
  - 必须遵循的 10 步编排流程（带序号）
  - 每一步调用的 infra 函数
  - 安全要求：命令验证（validateCommand + context）和输出消毒（analyzeOutput + applySanitizer）不可省略

## 4. K8s Script Execution Tools (k8s-script/)
  - 编排流程（与 k8s-exec 的区别：无命令验证、无输出消毒、多 resolveScript）
  - 脚本传输方式（base64 注入 vs stdin pipe）

## 5. Local Shell Tools (shell/)
  - restricted-bash 的特殊性（管道验证、sudo sandbox）
  - run-skill 的脚本安全模型

## 6. Shared Infrastructure (infra/)
  - 安全管道概览：pre-exec 验证 → execution → post-exec 消毒
  - command-sets.ts：如何添加新命令到白名单、如何添加 COMMAND_RULES
  - command-validator.ts：6-pass 管道的扩展点
  - output-sanitizer.ts：如何添加新的输出消毒规则

## 7. Registration in agent-factory.ts
  - customTools 数组的分组约定
  - 条件 push 的规则（mode-based、memoryIndexer-dependent）
  - PLATFORM_TOOLS 豁免集的含义
```

同时在 CLAUDE.md 的 Key File Map 和 "When starting a session as developer" 中添加 `docs/design/tools.md` 的引用。

## 风险与边界情况

1. **deep-search/ 跨类别引用**：`deep-search/sub-agent.ts` 嵌套调用 `createRestrictedBashTool`（shell/）和 `createNodeExecTool`（k8s-exec/），移动后路径从 `../xxx.js` 变为 `../../{category}/xxx.js`，多两层。需逐条核实。

2. **测试文件中的 mock 路径**：`quality-gate.test.ts` 中 `vi.mock("./sub-agent.js")` 使用相对路径，因 deep-search/ 整体迁移所以不受影响。需确认无其他 mock 使用绝对路径或跨目录路径。

3. **kubectl.test.ts 拆分**：`createKubectlTool` 的 describe 块内嵌套了 rate protection、sensitive resource protection、timeout clamping 等测试。这些行为在 `restricted-bash.test.ts` 中已有独立测试覆盖，因此可安全删除。保留 `validateExecCommand` 和 `hasAllNamespacesWithoutSelector` 的独立测试，import 改为从 `command-sets.js`。

4. **sensitive-path-protection.test.ts**：此测试文件从 `kubectl.ts` 和 `pod-exec.ts` 导入，需同时更新两个 import 路径。

5. **infra/ 未来膨胀风险**：当前 13 个文件可管理，但内部实际分为 3 个子集群（命令验证链、执行基础设施、独立工具）。如果后续 infra/ 继续增长，可能需要进一步拆分。当前不处理。

## 决策记录

| # | 问题 | 决策 | 理由 |
|---|------|------|------|
| 1 | 类型 E 目录名 | `workflow/` | 这些工具的共同点是面向用户的高层工作流操作 |
| 2 | 是否需要 barrel 文件 | 不需要 | 项目现有惯例是直接文件导入，barrel 留到模板化阶段 |
| 3 | 是否需要 interface spec | 不需要 | 留到后续模板化阶段 |
| 4 | kubectl.ts 验证函数放哪 | `command-sets.ts` | validateExecCommand 依赖 ALLOWED_COMMANDS 和 validateCommandRestrictions（都在 command-sets 中） |
| 5 | customTools 重排和 tools.md 是否拆 PR | 放在本次重构 | 重排只是数组顺序调整，tools.md 是对重构后结构的说明，和重构一起提交最自然 |
| 6 | memory/ 对 deep-search/sub-agent 的跨模块依赖 | 不处理 | 超出纯结构重构范围，留到后续 |

## 预估

- 改动文件：~40 个（几乎全部是 import 路径更新，无逻辑改动）
- 新增文件：1 个（docs/design/tools.md）
- 删除文件：1 个（kubectl.ts）
- 改动行数：~400 行（import 语句 + 文档）
