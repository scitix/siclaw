# Tool Registry — 方案设计

## 背景与目标

### 现状

`agent-factory.ts`（~715 行）是 Siclaw 的会话工厂，负责创建工具、组装工具列表、初始化 Brain。当前工具注册采用**硬编码数组 + 条件分支**模式：

```typescript
// 295-313: 硬编码工具列表
const customTools: ToolDefinition[] = [
  createNodeExecTool(kubeconfigRef, userId),
  createPodExecTool(kubeconfigRef),
  // ... 13 个工具
];

// 317-326: 条件分支散落
if (mode !== "cli") { customTools.push(createManageScheduleTool(...)); }
if (mode === "web") { customTools.push(createCreateSkillTool(), ...); }

// 356-369: 白名单过滤
const PLATFORM_TOOLS = new Set([...]);
if (Array.isArray(allowedTools)) { /* filter */ }

// 607-632: 延迟注册（依赖 memoryIndexer）
customTools.push(createMemorySearchTool(memoryIndexer));
```

### 问题

1. **新增工具改动面大**：添加一个工具需要改 agent-factory.ts 的 4 处（import + 数组 + 条件分支 + PLATFORM_TOOLS），全在同一个 300+ 行的函数里
2. **条件逻辑与工具定义耦合**：`mode === "web"` 等条件散落在工厂中，工具自身不声明自己的可用条件。修改工具可用 mode 要改 agent-factory 而非工具文件
3. **先全部创建再过滤**：L295-313 先创建所有工具实例（调用工厂函数、传入 refs），L356-369 再把不需要的过滤掉。被过滤的工具白白创建，逻辑上是"先做再撤销"
4. **元数据缺失**：PLATFORM_TOOLS 豁免、mode 限制等信息只存在于工厂代码中，要理解某个工具何时可用需要在 agent-factory 中搜索

### 目标

引入 **Tool Registry**，将工具注册从命令式代码变为声明式数据：
- 工具在自己的文件中声明可用条件（mode、platform 豁免、运行时依赖等）——谁最了解工具，谁声明元数据
- 工厂函数只做 `registry.resolve(context)` 一次调用
- resolve 一步到位：mode + available 过滤 → 实例化 → allowedTools 过滤，只创建最终需要的工具
- 保持现有 `ToolDefinition` 接口不变（pi-coding-agent 契约）
- 不改变运行时行为——纯重构，已知行为差异仅限 SDK brain 路径新增 memoryIndexer 初始化（当前未使用 SDK brain 模式，无实际影响）

### 不在范围

- **Extension 工具**（DP 工具 `propose_hypotheses`、`end_investigation`）：通过 pi-agent extension API 注册，生命周期由 extension 管理，不纳入本次重构
- **MCP 工具**：运行时动态发现，注册时机在 resolve 之后，保持现有逻辑
- **文件 I/O 工具**（read/edit/write/grep/find/ls）：来自 pi-coding-agent 框架，需要路径限制的 operations 注入，创建逻辑复杂且与其他工具模式不同

## 整体方案

### 核心思路

每个工具在自己的文件中 `export const registration`，声明元数据 + factory 函数。`ToolRegistry` 收集所有 registration，`resolve()` 一步完成过滤 + 实例化。

```
┌───────────────────────────────────────────────────────────┐
│                     agent-factory.ts                       │
│                                                            │
│  1. 创建 refs（kubeconfigRef, llmConfigRef, ...）          │
│  2. registry.resolve({ mode, refs,                         │
│                         allowedTools }) → ToolDefinition[] │
│  3. 追加 MCP 工具、文件 I/O 工具                            │
│  4. 传给 Brain                                             │
└───────────────────────────────────────────────────────────┘
         ↑ resolve()
┌───────────────────────────────────────────────────────────┐
│                      ToolRegistry                          │
│                                                            │
│  entries: ToolEntry[]                                      │
│                                                            │
│  resolve(opts) {                                           │
│    1. mode 过滤 + available 检查（零开销，未调用 create）     │
│    2. 只创建通过过滤的工具实例                               │
│    3. allowedTools 白名单过滤（platform 豁免）               │
│    return tools[]                                          │
│  }                                                         │
└───────────────────────────────────────────────────────────┘
         ↑ register()
┌────────────────────┐ ┌────────────────────┐
│ src/tools/index.ts │ │ 每个工具文件        │
│ allToolEntries[]   │←│ export registration │
└────────────────────┘ └────────────────────┘
```

### 关键设计决策

**1. 元数据 co-located 在工具文件中**

每个工具文件（如 `node-exec.ts`）在现有 `createXxxTool` 函数旁 export 一个 `registration` 对象。看工具文件就能知道它何时可用、是否 platform 豁免。不需要到 agent-factory 中搜索。

**2. Eager registration + lazy creation**

工具创建需要 refs（kubeconfigRef 等），这些 refs 在 `createSiclawSession` 内部创建。因此：
- **注册时**：只声明元数据（modes、platform）+ factory 函数
- **resolve 时**：传入 refs，只对通过 mode/available 过滤的工具调用 factory

**3. resolve 一步到位**

`resolve()` 内部完成 mode 过滤 → available 检查 → 实例化 → allowedTools 过滤，避免"先全部创建再删除"。

## 详细设计

### 模块 0：提取共享 Ref 类型到 `src/core/types.ts`

**做什么**：将散落在各文件的 Ref 接口集中到 `src/core/types.ts`，消除 `core/ → tools/` 的类型循环依赖

**为什么**：`tool-registry.ts`（core/）的 `ToolRefs` 接口需要引用 `MemoryRef`（定义在 tools/）和 `DpStateRef`（定义在 tools/）。如果直接 import，会形成 `core/tool-registry.ts → tools/deep-search/tool.ts → core/agent-factory.ts → core/tool-registry.ts` 的循环。虽然 `import type` 运行时无影响，但趁此重构一并清理。

**怎么做**：

新文件 `src/core/types.ts`，从现有文件**原样复制**以下接口（不修改接口定义）：

```typescript
// src/core/types.ts

import type { MemoryIndexer } from "../memory/indexer.js";

// ── 会话模式 ──

/** 来自 core/agent-factory.ts:69 */
export type SessionMode = "web" | "channel" | "cli";

// ── Ref 类型 ──

/** 来自 core/agent-factory.ts:71 */
export interface KubeconfigRef {
  credentialsDir?: string;
}

/** 来自 core/agent-factory.ts:76 */
export interface LlmConfigRef {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  api?: string;
}

/** 来自 tools/workflow/deep-search/tool.ts:13 */
export interface MemoryRef {
  indexer?: MemoryIndexer;
  dir?: string;
}

// ── DP 状态类型 ──

/** 来自 tools/workflow/dp-tools.ts:34 */
export type DpStatus =
  | "idle"
  | "investigating"
  | "awaiting_confirmation"
  | "deep_searching"
  | "completed";

/** 来自 tools/workflow/dp-tools.ts:42 */
export interface DpHypothesis {
  text: string;
  confidence: number;
  confirmed?: boolean;
  markdown?: string;
}

/** 来自 tools/workflow/dp-tools.ts:82 */
export interface DpStateRef {
  readonly status: DpStatus;
  readonly triageContextDraft?: string;
  readonly confirmedHypotheses?: DpHypothesis[];
  readonly question?: string;
  readonly round?: number;
}

/** 来自 tools/workflow/dp-tools.ts:94 */
export interface MutableDpStateRef {
  status: DpStatus;
  triageContextDraft?: string;
  confirmedHypotheses?: DpHypothesis[];
  question?: string;
  round?: number;
}
```

然后更新所有 import 路径：

| 原 import 来源 | 搬迁的类型 | 受影响文件数 |
|---------------|-----------|-------------|
| `core/agent-factory.js` | `KubeconfigRef`, `LlmConfigRef`, `SessionMode` | ~15 个 |
| `tools/workflow/deep-search/tool.js` | `MemoryRef` | 3 个 |
| `tools/workflow/dp-tools.js` | `DpStateRef`, `MutableDpStateRef`, `DpStatus`, `DpHypothesis` | ~5 个 |

原文件中的类型定义直接删除（不 re-export），让 tsc 报错暴露所有需要更新 import 路径的文件，一次性修复。

**关键决策**：
- `DpStatus` 和 `DpHypothesis` 也一并搬到 `types.ts`——它们是 `DpStateRef` 字段类型的依赖，如果留在 `dp-tools.ts` 中再 re-export，`core/types.ts` 对 `tools/` 仍有方向依赖，违背搬迁的初衷
- `SessionMode` 搬入 `types.ts`——`tool-registry.ts` 和 `agentbox/session.ts` 都需要它，放在 `types.ts` 是共享类型的自然归属
- 原文件直接删除定义而非 re-export——re-export 会隐藏遗漏的 import 路径，直接删除让编译器帮忙检查
- 纯机械操作：不修改任何接口定义，只改位置和 import 路径

**影响范围**：新增 `src/core/types.ts`（~60 行），修改 ~19 个文件的 import 路径

### 模块 1：ToolEntry 接口与 ToolRegistry 类

**做什么**：定义注册接口和注册表核心逻辑

**怎么做**：

新文件 `src/core/tool-registry.ts`：

```typescript
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type {
  SessionMode, KubeconfigRef, LlmConfigRef, MemoryRef, DpStateRef,
} from "./types.js";
import type { MemoryIndexer } from "../memory/indexer.js";

export type { SessionMode }; // re-export for consumers

/** 所有工具工厂共享的依赖 */
export interface ToolRefs {
  kubeconfigRef: KubeconfigRef;
  userId: string;
  sessionIdRef: { current: string };
  llmConfigRef: LlmConfigRef;
  memoryRef: MemoryRef;
  dpStateRef: DpStateRef;
  knowledgeIndexer?: MemoryIndexer;
  memoryIndexer?: MemoryIndexer;
  memoryDir?: string;
}

/** 每个工具的注册声明 */
export interface ToolEntry {
  /** 工具分类，纯文档用途 */
  category: "cmd-exec" | "script-exec" | "query" | "workflow";

  /** 工厂函数，接收统一的 refs 对象 */
  create: (refs: ToolRefs) => ToolDefinition;

  /**
   * 在哪些 mode 下可用。省略 = 所有 mode 都可用。
   * 对应原来 agent-factory.ts 里的 if (mode === "web") 等逻辑。
   */
  modes?: SessionMode[];

  /** 是否为平台工具（豁免 allowedTools 过滤） */
  platform?: boolean;

  /**
   * 运行时可用性检查。返回 false 时跳过此工具（不调用 create）。
   * 用于依赖可能不可用的运行时资源（如 memoryIndexer 初始化失败）。
   * 省略 = 始终可用。
   */
  available?: (refs: ToolRefs) => boolean;
}

export class ToolRegistry {
  private entries: ToolEntry[] = [];

  register(...entries: ToolEntry[]): void {
    this.entries.push(...entries);
  }

  /**
   * 一步完成：mode + available 过滤 → 实例化 → allowedTools 过滤。
   * 只创建最终需要的工具实例。
   */
  resolve(opts: {
    mode: SessionMode;
    refs: ToolRefs;
    allowedTools?: string[] | null;
  }): ToolDefinition[] {
    const { mode, refs, allowedTools } = opts;

    // 1. mode 过滤 + available 检查（未调用 create，零开销）
    const applicable = this.entries.filter(
      (e) =>
        (!e.modes || e.modes.includes(mode)) &&
        (!e.available || e.available(refs)),
    );

    // 2. 只创建通过过滤的工具实例
    const tools = applicable.map((e) => ({
      def: e.create(refs),
      platform: e.platform ?? false,
    }));

    // 3. 如果有 allowedTools 白名单，再过滤（platform 工具豁免）
    if (Array.isArray(allowedTools)) {
      const allowed = new Set(allowedTools);
      return tools
        .filter((t) => t.platform || allowed.has(t.def.name))
        .map((t) => t.def);
    }

    return tools.map((t) => t.def);
  }
}
```

**影响范围**：新文件，无存量代码影响

**关键决策**：
- `ToolEntry` 不包含 `name` 字段——name 已存在于 `ToolDefinition` 中，由 `create()` 返回，避免重复声明和不一致风险
- `category` 纯文档用途，resolve 不使用它过滤，但保留用于日志和未来审计
- `allowedTools` 过滤集成在 `resolve()` 内，而非让调用方事后再过滤
- 不设 `brains` 字段——当前唯一候选用例是 memory 工具限定 pi-agent，但 SDK brain 后续也会支持 memory。改用 `available` 守卫检查运行时依赖（memoryIndexer 是否可用），不绑定 brain type

### 模块 2：每个工具文件声明 registration

**做什么**：在每个工具文件中，紧挨 `createXxxTool` 函数，添加 `export const registration`

**怎么做**：

在每个工具文件末尾添加 registration 导出。以下列出所有 18 个工具的声明：

**cmd-exec/**：

```typescript
// src/tools/cmd-exec/node-exec.ts — 添加导出
export const registration: ToolEntry = {
  category: "cmd-exec",
  create: (refs) => createNodeExecTool(refs.kubeconfigRef, refs.userId),
};

// src/tools/cmd-exec/pod-exec.ts
export const registration: ToolEntry = {
  category: "cmd-exec",
  create: (refs) => createPodExecTool(refs.kubeconfigRef),
};

// src/tools/cmd-exec/restricted-bash.ts
export const registration: ToolEntry = {
  category: "cmd-exec",
  create: (refs) => createRestrictedBashTool(refs.kubeconfigRef),
};
```

**script-exec/**：

```typescript
// src/tools/script-exec/node-script.ts
export const registration: ToolEntry = {
  category: "script-exec",
  create: (refs) => createNodeScriptTool(refs.kubeconfigRef, refs.userId),
};

// src/tools/script-exec/pod-script.ts
export const registration: ToolEntry = {
  category: "script-exec",
  create: (refs) => createPodScriptTool(refs.kubeconfigRef),
};

// src/tools/script-exec/local-script.ts
export const registration: ToolEntry = {
  category: "script-exec",
  create: (refs) => createLocalScriptTool(refs.kubeconfigRef, refs.sessionIdRef),
};
```

**query/**：

```typescript
// src/tools/query/credential-list.ts
export const registration: ToolEntry = {
  category: "query",
  create: (refs) => createCredentialListTool(refs.kubeconfigRef),
  platform: true,
};

// src/tools/query/cluster-info.ts
export const registration: ToolEntry = {
  category: "query",
  create: (refs) => createClusterInfoTool(refs.kubeconfigRef),
  platform: true,
};

// src/tools/query/knowledge-search.ts
export const registration: ToolEntry = {
  category: "query",
  create: (refs) => createKnowledgeSearchTool(refs.knowledgeIndexer),
  platform: true,
};

// src/tools/query/resolve-pod-netns.ts
export const registration: ToolEntry = {
  category: "query",
  create: (refs) => createResolvePodNetnsTool(refs.kubeconfigRef, refs.userId),
};

// src/tools/query/memory-search.ts
export const registration: ToolEntry = {
  category: "query",
  create: (refs) => createMemorySearchTool(refs.memoryIndexer!),
  available: (refs) => !!refs.memoryIndexer,  // memoryIndexer 初始化失败 → 跳过
};

// src/tools/query/memory-get.ts
export const registration: ToolEntry = {
  category: "query",
  create: (refs) => createMemoryGetTool(refs.memoryDir!),
  available: (refs) => !!refs.memoryIndexer,  // 与 memory_search 同条件
};
```

**workflow/**：

```typescript
// src/tools/workflow/deep-search/investigation-feedback.ts
export const registration: ToolEntry = {
  category: "workflow",
  create: (refs) => createInvestigationFeedbackTool(refs.memoryRef),
};

// src/tools/workflow/deep-search/tool.ts
export const registration: ToolEntry = {
  category: "workflow",
  create: (refs) => createDeepSearchTool(
    refs.kubeconfigRef, refs.llmConfigRef, refs.memoryRef, refs.dpStateRef,
  ),
};

// src/tools/workflow/save-feedback.ts
export const registration: ToolEntry = {
  category: "workflow",
  create: (refs) => createSaveFeedbackTool(refs.sessionIdRef),
  platform: true,
};

// src/tools/workflow/manage-schedule.ts
export const registration: ToolEntry = {
  category: "workflow",
  create: (refs) => createManageScheduleTool(refs.kubeconfigRef),
  modes: ["web", "channel"],  // ← 原来的 if (mode !== "cli")
  platform: true,
};

// src/tools/workflow/create-skill.ts
export const registration: ToolEntry = {
  category: "workflow",
  create: (_refs) => createCreateSkillTool(),
  modes: ["web"],  // ← 原来的 if (mode === "web")
};

// src/tools/workflow/update-skill.ts
export const registration: ToolEntry = {
  category: "workflow",
  create: (_refs) => createUpdateSkillTool(),
  modes: ["web"],
};

// src/tools/workflow/fork-skill.ts
export const registration: ToolEntry = {
  category: "workflow",
  create: (_refs) => createForkSkillTool(),
  modes: ["web"],
};
```

**关键决策**：
- registration 直接放在工具文件中，而非独立的 `registrations.ts`——元数据和工具定义 co-located，改 mode 只需改工具文件
- 不修改 `createXxxTool` 的函数签名——registration 是新增导出，不侵入现有实现
- memory 工具使用 `available` 守卫而非 `brains` 约束——不绑定 brain type，未来 SDK brain 支持 memory 时无需修改 registration

**影响范围**：修改 18 个工具文件（每个文件添加 ~5 行 registration 导出）

### 模块 3：统一入口 + 重构 agent-factory.ts

**做什么**：创建工具汇总入口，重构 agent-factory.ts 使用 Registry

**怎么做**：

**`src/tools/all-entries.ts`**（汇总入口）：

```typescript
import type { ToolEntry } from "../core/tool-registry.js";

// cmd-exec
import { registration as nodeExec } from "./cmd-exec/node-exec.js";
import { registration as podExec } from "./cmd-exec/pod-exec.js";
import { registration as restrictedBash } from "./cmd-exec/restricted-bash.js";
// script-exec
import { registration as nodeScript } from "./script-exec/node-script.js";
import { registration as podScript } from "./script-exec/pod-script.js";
import { registration as localScript } from "./script-exec/local-script.js";
// query
import { registration as credentialList } from "./query/credential-list.js";
import { registration as clusterInfo } from "./query/cluster-info.js";
import { registration as knowledgeSearch } from "./query/knowledge-search.js";
import { registration as resolvePodNetns } from "./query/resolve-pod-netns.js";
import { registration as memorySearch } from "./query/memory-search.js";
import { registration as memoryGet } from "./query/memory-get.js";
// workflow
import { registration as investigationFeedback } from "./workflow/deep-search/investigation-feedback.js";
import { registration as deepSearch } from "./workflow/deep-search/tool.js";
import { registration as saveFeedback } from "./workflow/save-feedback.js";
import { registration as manageSchedule } from "./workflow/manage-schedule.js";
import { registration as createSkill } from "./workflow/create-skill.js";
import { registration as updateSkill } from "./workflow/update-skill.js";
import { registration as forkSkill } from "./workflow/fork-skill.js";

/**
 * 所有工具的注册清单。顺序决定 LLM 看到的工具列表顺序，
 * 保持与原 agent-factory.ts 的注册顺序一致。
 */
export const allToolEntries: ToolEntry[] = [
  // ── cmd-exec ──
  nodeExec, podExec, restrictedBash,
  // ── script-exec ──
  nodeScript, podScript, localScript,
  // ── query (investigationFeedback 物理在 workflow/deep-search/，但保持原始注册位置) ──
  investigationFeedback, credentialList, clusterInfo,
  knowledgeSearch, resolvePodNetns, memorySearch, memoryGet,
  // ── workflow ──
  deepSearch, saveFeedback, manageSchedule,
  createSkill, updateSkill, forkSkill,
];
```

**agent-factory.ts 改动**：

替换原来 L295-369 的 ~75 行代码为 ~10 行：

```typescript
import { ToolRegistry } from "./tool-registry.js";
import { allToolEntries } from "../tools/all-entries.js";

// ... 在 createSiclawSession 内部 ...

const registry = new ToolRegistry();
registry.register(...allToolEntries);

const allowedTools = opts?.allowedTools ?? config.allowedTools;

const customTools = registry.resolve({
  mode,
  refs: {
    kubeconfigRef, userId, sessionIdRef, llmConfigRef,
    memoryRef, dpStateRef,
    knowledgeIndexer: opts?.knowledgeIndexer,
    memoryIndexer,   // undefined = memory 工具被 available 守卫跳过
    memoryDir,
  },
  allowedTools,
});

// MCP 工具——也受 allowedTools 过滤（保持原行为：原代码中 MCP 在 L327 追加，L356 过滤）
if (mcpTools.length > 0) {
  if (Array.isArray(allowedTools)) {
    const allowed = new Set(allowedTools);
    customTools.push(...mcpTools.filter(t => allowed.has(t.name)));
  } else {
    customTools.push(...mcpTools);
  }
}

// 文件 I/O 工具——不受 allowedTools 过滤（保持原行为：原代码中在 L376 追加，在过滤之后）
customTools.push(...restrictedFileTools);
```

同时：
- **删除**原 L295-369 的硬编码工具列表、条件分支、PLATFORM_TOOLS Set
- **删除**原 L607-632 的 memory 工具单独注册逻辑（已统一到 registry）
- **清理** agent-factory.ts 顶部不再需要的 createXxxTool import（~20 行）
- **保留** agent-factory.ts 中 memoryIndexer 的初始化逻辑（只是不再单独 push memory 工具）

**关键决策**：
- `allToolEntries` 的顺序严格保持与原 customTools 数组一致——LLM 可能对工具顺序敏感
- `registry` 在函数内部创建而非模块级单例——每次 `createSiclawSession` 调用都是独立的，不共享状态
- MCP 和文件 I/O 工具不走 registry，在 resolve 之后追加——它们有独立的生命周期

**影响范围**：修改 `agent-factory.ts`（删 ~95 行，新增 ~15 行），新增 `src/tools/all-entries.ts`

### 模块 4：memoryIndexer 初始化顺序调整

**做什么**：将 memoryIndexer 初始化从 pi-agent 专属路径提前到 `registry.resolve()` 调用之前，使其对所有 brain type 可用

**怎么做**：

当前 agent-factory.ts 的执行顺序：
```
L295:  customTools 数组（无 memory 工具）
L327:  MCP 工具
L356:  allowedTools 过滤
L376:  文件 I/O 工具
L542:  if claude-sdk → return early（不初始化 memoryIndexer）
L607:  memoryIndexer 初始化 + push memory 工具    ← 只在 pi-agent 路径
L648:  createAgentSession
```

调整为：
```
L~290: memoryIndexer 初始化（try-catch，失败 = undefined）
L~310: registry.resolve(refs)
         ├─ memoryIndexer 可用 → available 通过 → memory 工具被创建
         └─ memoryIndexer = undefined → available 返回 false → 跳过
L~330: MCP 工具 + 文件 I/O 工具追加
L~350: if claude-sdk → 构建 SDK brain + return
L~360: createAgentSession（pi-agent 路径）
```

memoryIndexer 初始化对所有 brain type 执行。memory 工具不绑定 brain type，仅通过 `available` 守卫检查 memoryIndexer 是否可用。这样：
- **当前行为不变**：SDK brain 目前不传 `opts.memoryIndexer`，初始化走 per-session 路径，memory 工具正常创建
- **初始化失败时优雅降级**：`available` 返回 false，memory 工具被跳过，与原始代码的 try-catch 降级行为一致
- **未来 SDK brain 需要 memory 时**：无需修改任何 registration，只要确保 memoryIndexer 初始化成功即可

原始代码中 memoryIndexer 初始化后还做了两件事（L627-629）：
1. `memoryRef.indexer = memoryIndexer` — 供 deep_search 访问调查历史
2. `memoryRef.dir = memoryDir` — 供 deep_search 访问 memory 目录

这两行保持不变，仍在 memoryIndexer 初始化的 try 块内执行。

**memoryRef 时序说明**：`memoryRef` 是 mutable ref（`{}` 对象，按引用传递）。`resolve()` 中 `createDeepSearchTool(refs.memoryRef, ...)` 只传递引用，deep_search 在**实际执行时**（用户触发调查）才读取 `.indexer` 和 `.dir`。因此 `memoryRef` 的字段赋值不必在 resolve 之前完成——只需在 session 开始处理用户消息之前完成即可。初始化顺序：memoryIndexer init → memoryRef 赋值 → resolve()（传引用）→ ... → 用户消息 → deep_search 读取 memoryRef，功能正确。

**影响范围**：`agent-factory.ts` 内部代码重排（memoryIndexer 初始化上移 ~300 行），删除原 L607-632 的 memory 工具单独注册逻辑

## 接口与数据结构

### 新增类型

```typescript
// src/core/tool-registry.ts

type SessionMode = "web" | "channel" | "cli";

interface ToolRefs {
  kubeconfigRef: KubeconfigRef;
  userId: string;
  sessionIdRef: { current: string };
  llmConfigRef: LlmConfigRef;
  memoryRef: MemoryRef;
  dpStateRef: DpStateRef;
  knowledgeIndexer?: MemoryIndexer;
  memoryIndexer?: MemoryIndexer;
  memoryDir?: string;
}

interface ToolEntry {
  category: "cmd-exec" | "script-exec" | "query" | "workflow";
  create: (refs: ToolRefs) => ToolDefinition;
  modes?: SessionMode[];
  platform?: boolean;
  available?: (refs: ToolRefs) => boolean;
}

class ToolRegistry {
  register(...entries: ToolEntry[]): void;
  resolve(opts: {
    mode: SessionMode;
    refs: ToolRefs;
    allowedTools?: string[] | null;
  }): ToolDefinition[];
}
```

### 不变的类型

- `ToolDefinition`（来自 pi-coding-agent）：不修改
- `KubeconfigRef`、`LlmConfigRef`、`MemoryRef`、`DpStateRef`：不修改
- `SiclawSessionResult`：不修改

## 改造前后对比

| 场景 | 改造前 | 改造后 |
|------|--------|--------|
| 新增一个工具 | 改 agent-factory.ts 的 4 处（import + 数组 + 条件 + platform set） | 在工具文件里加 `export const registration`，在 `all-entries.ts` 加一行 |
| 修改工具可用 mode | 改 agent-factory.ts 的 if 条件 | 改工具文件里的 `modes: [...]` |
| 标记为平台工具 | 改 agent-factory.ts 的 PLATFORM_TOOLS Set | 改工具文件里的 `platform: true` |
| 理解某个工具何时可用 | 在 agent-factory.ts 里搜索工具名，找到分散的条件 | 看工具文件的 registration 导出，一目了然 |
| agent-factory.ts 复杂度 | ~75 行工具注册 + 条件 + 过滤 | ~10 行 resolve 调用 |

## 风险与边界情况

### 风险 1：注册顺序 → 工具列表顺序

当前工具在 customTools 数组中的顺序是固定的（cmd-exec → script-exec → query → workflow）。LLM 可能对工具顺序敏感。

**缓解**：`allToolEntries` 数组严格保持与原 customTools 相同的顺序，resolve 按注册顺序输出。`investigation_feedback` 虽然物理目录在 `workflow/deep-search/`，但在 `allToolEntries` 中保持原始位置（query 分区第 1 位），避免工具顺序变化影响 LLM 行为。

### 风险 2：factory 函数的 refs 类型安全

`ToolRefs` 是一个大对象，部分字段是 optional（memoryIndexer、knowledgeIndexer）。如果工具的 `create` 错误地访问了 undefined 的 ref，会在运行时报错。

**缓解**：
- memory 工具使用 `available: (refs) => !!refs.memoryIndexer` 守卫，确保 create 只在 indexer 可用时调用
- knowledgeIndexer 在 `createKnowledgeSearchTool` 内部已处理 undefined（现有行为）
- TypeScript 的 optional 类型标注提供编译期提示

### 风险 3：agent-factory.ts import 清理

移除硬编码注册后，agent-factory.ts 中 ~20 行 createXxxTool 的 import 将变为未使用。

**缓解**：这些 import 移动到了各工具文件的 registration 中（同文件内引用）和 `all-entries.ts` 中。清理是机械性的，tsc 会报错提示。

### 风险 4：ToolEntry 与 ToolDefinition 的 name 不一致

`ToolEntry` 没有 `name` 字段（name 由 `create()` 返回的 ToolDefinition 携带）。如果 `platform: true` 的工具 name 在 ToolDefinition 中被改了，allowedTools 过滤会用新 name，但注册时无法预检。

**缓解**：这和当前行为一致——原来的 `PLATFORM_TOOLS` Set 也是靠字符串匹配。如果需要更强保证，可以在测试中验证 platform 工具的 name 稳定性。

## 预估

- 改动文件：~24 个
  - 新增：`src/core/types.ts`（~60 行）、`src/core/tool-registry.ts`（~70 行）、`src/tools/all-entries.ts`（~40 行）
  - 修改：18 个工具文件（每个 +5 行 registration）、`agent-factory.ts`（删 ~95 行，加 ~15 行）、~19 个文件的 import 路径（类型搬迁）
- 改动行数：~270 行新增，~130 行删除
- 净变化：~140 行（共享类型 + 声明式元数据）

## 决策记录

| # | 问题 | 决策 | 理由 |
|---|------|------|------|
| 1 | 元数据放哪里 | co-located 在工具文件中（`export const registration`） | 谁最了解工具谁声明元数据；改 mode 只改工具文件，不改 agent-factory |
| 2 | resolve 是否包含 allowedTools | 包含在 resolve 内一步到位 | 避免"先全部创建再过滤"的浪费，逻辑更清晰 |
| 3 | memory 工具如何处理 memoryIndexer 依赖 | `available: (refs) => !!refs.memoryIndexer`，不绑定 brain type | SDK brain 后续也会用 memory；available 守卫同时处理初始化失败的降级 |
| 4 | memoryIndexer 初始化时机 | 提前到 resolve 之前，所有 brain type 共享 | 支持未来 SDK brain 使用 memory 工具；available 守卫确保初始化失败时优雅跳过 |
| 5 | ToolEntry 是否需要 name 字段 | 不需要 | name 已在 ToolDefinition 中，重复声明有不一致风险 |
| 6 | ToolEntry 是否需要 brains 字段 | 不需要 | 唯一用例是 memory 工具，但 SDK brain 后续也会支持；用 available 守卫更精确 |
| 7 | MCP / 文件 I/O / Extension 工具是否纳入 | 不纳入 | 各有独立生命周期，强行统一增加复杂度无收益 |
| 8 | registry 单例 vs 函数内创建 | 函数内创建 | 每次 createSiclawSession 独立，无共享状态风险 |
| 9 | Ref 类型是否需要提取到共享位置 | 是，提取到 `src/core/types.ts` | 消除 core→tools 类型循环依赖；tool-registry.ts 的 ToolRefs 需要这些类型 |
| 10 | Ref 接口本身是否需要重构 | 不需要 | 各 ref 职责清晰，mutable ref 模式合理，DpStateRef 已有 readonly/mutable 分离 |
| 11 | `DpStatus`/`DpHypothesis` 留在 dp-tools 还是搬到 types.ts | 一并搬迁 | 如果只搬 DpStateRef 而保留依赖的类型在 dp-tools，core/types.ts 仍需 re-export 形成 core→tools 依赖；一并搬迁彻底消除 |
| 12 | `SessionMode` 归属 | 搬到 `types.ts` | tool-registry.ts 和 agentbox/session.ts 都需要它，共享类型的自然归属 |
| 13 | 原文件 re-export 还是直接删除 | 直接删除 | 让 tsc 报错暴露所有需更新的 import 路径，一次性修复；re-export 会隐藏遗漏 |
| 14 | `investigationFeedback` 在 allToolEntries 中的位置 | 保持原始位置（query 分区第 1 位） | 纯重构不改工具顺序，避免 LLM 行为变化；category 声明为 workflow 仅用于文档分类 |
