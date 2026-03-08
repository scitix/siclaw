# 技术方案：Prometheus 可观测性集成

> 状态：草案 v2（采纳架构师 review 后更新）
> 基于需求文档：`observability-requirements.md`
> 日期：2026-03-08

---

## 1. 整体架构设计

### 1.1 架构总览

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                          Local 模式（同进程）                                     │
│                                                                                  │
│  Gateway 进程                                                                    │
│  ┌────────────────────────────────────────────────────────────────────────────┐  │
│  │  HTTP Server (port 3001)                                                  │  │
│  │  GET /metrics ◄── metricsRegistry.metrics()                               │  │
│  └──────┬─────────────────────────────────────────────────────────────────────┘  │
│         │ 直接引用（同进程）                                                      │
│  ┌──────▼─────────────────────────────────────────────────────────────────────┐  │
│  │  src/shared/metrics.ts  (订阅者 — prom-client 隔离在此)                    │  │
│  │  ┌─────────────┐ ┌──────────────┐ ┌──────────────────────┐                │  │
│  │  │ metricsReg  │ │ 指标定义      │ │ handleDiagnostic()  │                │  │
│  │  │ (Registry)  │ │ Counter/Hist │ │ 事件 → 指标映射      │                │  │
│  │  └─────────────┘ └──────────────┘ └──────────┬───────────┘                │  │
│  └──────────────────────────────────────────────┼────────────────────────────┘  │
│                                                  │ onDiagnostic(handleDiagnostic)│
│  ┌──────────────────────────────────────────────▼────────────────────────────┐  │
│  │  src/shared/diagnostic-events.ts  (事件总线 — 零依赖)                      │  │
│  │  ┌────────────────────┐  ┌──────────────────────┐                         │  │
│  │  │ emitDiagnostic()   │  │ DiagnosticEvent type │                         │  │
│  │  │ onDiagnostic()     │  │ (联合类型定义)        │                         │  │
│  │  └────────────────────┘  └──────────────────────┘                         │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
│          ▲                  ▲                  ▲                  ▲             │
│          │                  │                  │                  │             │
│  ┌───────┴────┐  ┌─────────┴─────┐  ┌────────┴────────┐  ┌─────┴──────────┐  │
│  │ session.ts │  │ http-server.ts│  │ session.ts      │  │ gateway/       │  │
│  │ session_   │  │ prompt_       │  │ tool_call       │  │ server.ts      │  │
│  │ created/   │  │ complete      │  │ (tool 事件)     │  │ ws_connected/  │  │
│  │ released   │  │               │  │                 │  │ disconnected   │  │
│  └────────────┘  └───────────────┘  └─────────────────┘  └────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────────┐
│                          K8s 模式（多进程 / 多 Pod）                              │
│                                                                                  │
│  Gateway Pod                              AgentBox Pod (per user)                │
│  ┌───────────────────┐                   ┌──────────────────────┐                │
│  │ GET /metrics      │                   │ GET /metrics         │                │
│  │ (Gateway 自身指标) │                   │ (session 级指标)     │                │
│  │ ws_connections    │                   │ prom-client registry │                │
│  └───────────────────┘                   └──────────────────────┘                │
│         │                                         │                              │
│         ▼                                         ▼                              │
│    Prometheus (ServiceMonitor 自动发现两类 Pod)                                   │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 核心设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 指标库 | `prom-client` | 依赖少（1 个包），Prometheus 原生兼容，覆盖第一期 + 第二期 |
| Registry 策略 | 自定义 Registry（非 defaultRegistry） | 避免与第三方库指标冲突，按需暴露 |
| **解耦层** | **事件总线（diagnostic-events.ts）** | 核心代码只 emit 事件，不 import prom-client；指标收集作为纯订阅者 |
| 埋点位置 | BrainSession 消费侧（http-server.ts） | 一处埋点覆盖两种 brain type，无需在各 brain 实现中重复 |
| `user_id` 标签 | 加入，可通过环境变量关闭 | 企业场景核心需求，超 500 用户时可禁用 |
| K8s 指标聚合 | Pod 级 `/metrics`（非 Gateway 聚合） | 让 Prometheus 做聚合，应用层不负责跨 Pod 汇总 |
| `context_tokens` 类型 | Gauge（非 Histogram） | 瞬时快照用 Gauge 更合适，需要看分布可在 Grafana 侧做 |
| `/metrics` 安全 | 可选 bearer token（`SICLAW_METRICS_TOKEN`） | K8s 环境下保护敏感指标（user_id、成本数据） |

### 1.3 事件总线解耦架构

参考 OpenClaw 的 `diagnostic-events.ts` 事件总线模式，但采用更轻量的实现：

```
┌──────────────────────────────────────────────────────────────────┐
│                       职责分离                                    │
│                                                                  │
│  业务代码                    事件总线                 订阅者       │
│  (session.ts,               (diagnostic-events.ts)  (metrics.ts) │
│   http-server.ts)                                                │
│                                                                  │
│  emitDiagnostic({     ──►   listeners[]      ──►   prom-client  │
│    type: "...",              (try-catch 保护)        Counter.inc()│
│    ...payload                                       Hist.observe()
│  })                                                              │
│                                                                  │
│  ● 零 prom-client 依赖      ● 零外部依赖           ● 唯一依赖   │
│  ● 只依赖事件类型定义        ● 纯回调数组            prom-client  │
│  ● 单测无需 mock metrics    ● 同步调用               的文件       │
└──────────────────────────────────────────────────────────────────┘
```

**为什么不用 Node.js EventEmitter**：EventEmitter 如果订阅者抛异常会影响后续订阅者和调用方。我们用纯回调数组 + try-catch 包装，确保单个订阅者异常不影响业务代码和其他订阅者。

**未来扩展性**：结构化日志迁移（roadmap scope-out）时，只需增加第二个订阅者（`onDiagnostic(logHandler)`），无需改动任何业务代码。

### 1.4 与现有架构的约束适配

**Local 模式共进程**：`LocalSpawner` 运行所有 AgentBox 实例与 Gateway 同进程。`diagnostic-events.ts` 作为共享模块，所有 session 的事件写入同一个事件总线，`metrics.ts` 订阅并更新同一个 Registry，Gateway 的 `GET /metrics` 直接读取，零额外通信开销。

**K8s 模式隔离**：每个 AgentBox Pod 独立运行事件总线 + `prom-client`，各自暴露 `/metrics`。Gateway Pod 只暴露自身指标（WebSocket 连接数）。Prometheus 通过 ServiceMonitor 分别发现两类 Pod。

**两种 Brain 统一覆盖**：`BrainSession` 接口的 `getSessionStats()` 和 `getModel()` 在两种 brain 实现中返回格式一致的数据（`BrainSessionStats` + `BrainModelInfo`）。业务代码只 `emitDiagnostic()`，不需要修改 brain 内部代码。

---

## 2. 指标定义详细设计

### 2.1 事件总线定义

```typescript
// src/shared/diagnostic-events.ts — 零外部依赖

import type { BrainSessionStats, BrainModelInfo } from "../core/brain-session.js";

// ── 事件类型 ──

export type DiagnosticEvent =
  // 第一期：核心指标
  | {
      type: "prompt_complete";
      prev: BrainSessionStats;
      curr: BrainSessionStats;
      model: BrainModelInfo | undefined;
      durationMs: number;
      outcome: "completed" | "error";
      userId?: string;
    }
  | { type: "session_created"; sessionId: string }
  | { type: "session_released"; sessionId: string }
  // 第一期：Tool 指标
  | {
      type: "tool_call";
      toolName: string;
      outcome: "success" | "error";
      durationMs: number;
    }
  // 第一期：WebSocket 指标
  | { type: "ws_connected" }
  | { type: "ws_disconnected" }
  // 第二期：会话健康
  | {
      type: "context_usage";
      provider: string;
      model: string;
      tokensUsed: number;
      tokensLimit: number;
    }
  | { type: "session_stuck"; sessionId: string; idleMs: number };

// ── 事件总线 ──

type Listener = (event: DiagnosticEvent) => void;
const listeners: Listener[] = [];

/**
 * Emit a diagnostic event. All registered listeners are called synchronously.
 * Listener exceptions are caught and logged — never propagated to the caller.
 */
export function emitDiagnostic(event: DiagnosticEvent): void {
  for (const fn of listeners) {
    try {
      fn(event);
    } catch (err) {
      console.warn("[diagnostic] listener error:", err);
    }
  }
}

/**
 * Subscribe to diagnostic events. Returns an unsubscribe function.
 */
export function onDiagnostic(fn: Listener): () => void {
  listeners.push(fn);
  return () => {
    const idx = listeners.indexOf(fn);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}
```

### 2.2 第一期 — 核心指标（7 个）

指标定义和事件订阅逻辑统一在 `metrics.ts` 中，这是唯一依赖 `prom-client` 的文件。

```typescript
// src/shared/metrics.ts

import { Counter, Gauge, Histogram, Registry } from "prom-client";
import { onDiagnostic, type DiagnosticEvent } from "./diagnostic-events.js";

export const metricsRegistry = new Registry();

/** 是否在指标中包含 user_id 标签 */
const INCLUDE_USER_ID = process.env.SICLAW_METRICS_USER_ID !== "false";

// ── 1. Token 消耗 ──
const tokensTotal = new Counter({
  name: "siclaw_tokens_total",
  help: "Cumulative token consumption",
  labelNames: ["type", "provider", "model", "user_id"] as const,
  registers: [metricsRegistry],
});

// ── 2. LLM 费用 ──
const costUsdTotal = new Counter({
  name: "siclaw_cost_usd_total",
  help: "Cumulative LLM cost in USD",
  labelNames: ["provider", "model", "user_id"] as const,
  registers: [metricsRegistry],
});

// ── 3. Prompt 延迟 ──
const promptDurationMs = new Histogram({
  name: "siclaw_prompt_duration_ms",
  help: "Prompt end-to-end processing latency in milliseconds",
  labelNames: ["provider", "model", "outcome"] as const,
  buckets: [500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000],
  registers: [metricsRegistry],
});

// ── 4. Prompt 计数 ──
const promptsTotal = new Counter({
  name: "siclaw_prompts_total",
  help: "Total prompts processed",
  labelNames: ["provider", "model", "outcome"] as const,
  registers: [metricsRegistry],
});

// ── 5. 活跃会话数 ──
const sessionsActive = new Gauge({
  name: "siclaw_sessions_active",
  help: "Current number of active sessions",
  registers: [metricsRegistry],
});

// ── 6. Tool 调用计数 ──
const toolCallsTotal = new Counter({
  name: "siclaw_tool_calls_total",
  help: "Total tool invocations",
  labelNames: ["tool_name", "outcome"] as const,
  registers: [metricsRegistry],
});

// ── 7. WebSocket 连接数 ──
const wsConnections = new Gauge({
  name: "siclaw_ws_connections",
  help: "Current number of WebSocket connections",
  registers: [metricsRegistry],
});

// ── 事件 → 指标映射 ──

function handleDiagnostic(event: DiagnosticEvent): void {
  switch (event.type) {
    case "prompt_complete": {
      const { prev, curr, model, durationMs, outcome, userId } = event;
      const provider = model?.provider ?? "unknown";
      const modelId = model?.id ?? "unknown";

      // Token 增量（session stats 是累计值，取差值得到 per-prompt 增量）
      const dInput = curr.tokens.input - prev.tokens.input;
      const dOutput = curr.tokens.output - prev.tokens.output;
      const dCacheRead = curr.tokens.cacheRead - prev.tokens.cacheRead;
      const dCacheWrite = curr.tokens.cacheWrite - prev.tokens.cacheWrite;

      const baseLabels = INCLUDE_USER_ID && userId
        ? { provider, model: modelId, user_id: userId }
        : { provider, model: modelId };

      if (dInput > 0)      tokensTotal.inc({ ...baseLabels, type: "input" }, dInput);
      if (dOutput > 0)     tokensTotal.inc({ ...baseLabels, type: "output" }, dOutput);
      if (dCacheRead > 0)  tokensTotal.inc({ ...baseLabels, type: "cache_read" }, dCacheRead);
      if (dCacheWrite > 0) tokensTotal.inc({ ...baseLabels, type: "cache_write" }, dCacheWrite);

      // Cost 增量
      const dCost = curr.cost - prev.cost;
      if (dCost > 0) costUsdTotal.inc(baseLabels, dCost);

      // Prompt 延迟 + 计数
      const outcomeLabels = { provider, model: modelId, outcome };
      promptDurationMs.observe(outcomeLabels, durationMs);
      promptsTotal.inc(outcomeLabels);
      break;
    }

    case "session_created":
      sessionsActive.inc();
      break;

    case "session_released":
      sessionsActive.dec();
      break;

    case "tool_call":
      toolCallsTotal.inc({ tool_name: event.toolName, outcome: event.outcome });
      break;

    case "ws_connected":
      wsConnections.inc();
      break;

    case "ws_disconnected":
      wsConnections.dec();
      break;

    // 第二期事件在下方处理
    default:
      break;
  }
}

// 自动注册订阅（模块被 import 时生效）
onDiagnostic(handleDiagnostic);
```

**与 v1 的关键差异**：
- 指标对象不再 export — 外部代码通过 `emitDiagnostic()` 间接驱动指标，无直接 `import { sessionsActive }`
- 新增 `siclaw_tool_calls_total` 和 `siclaw_ws_connections` 两个指标
- `promptDurationMs` 桶增加了 `120_000, 300_000`（覆盖 Deep Investigation 场景）

### 2.3 第二期 — 会话健康指标（4 个）

```typescript
// src/shared/metrics.ts（续，追加到 handleDiagnostic switch 中）

// ── 8. 上下文窗口已用 ──
const contextTokensUsed = new Gauge({
  name: "siclaw_context_tokens_used",
  help: "Current context window tokens used (sampled per turn)",
  labelNames: ["provider", "model"] as const,
  registers: [metricsRegistry],
});

// ── 9. 上下文窗口上限 ──
const contextTokensLimit = new Gauge({
  name: "siclaw_context_tokens_limit",
  help: "Context window token limit (sampled per turn)",
  labelNames: ["provider", "model"] as const,
  registers: [metricsRegistry],
});

// ── 10. 卡死会话计数 ──
const sessionStuckTotal = new Counter({
  name: "siclaw_session_stuck_total",
  help: "Number of stuck sessions detected",
  registers: [metricsRegistry],
});

// ── 11. 卡死会话持续时长 ──
const sessionStuckAgeMs = new Histogram({
  name: "siclaw_session_stuck_age_ms",
  help: "Duration of stuck sessions in milliseconds",
  buckets: [30_000, 60_000, 120_000, 300_000],
  registers: [metricsRegistry],
});

// handleDiagnostic switch 中追加：
    case "context_usage":
      contextTokensUsed.set({ provider: event.provider, model: event.model }, event.tokensUsed);
      contextTokensLimit.set({ provider: event.provider, model: event.model }, event.tokensLimit);
      break;

    case "session_stuck":
      sessionStuckTotal.inc();
      sessionStuckAgeMs.observe(event.idleMs);
      break;
```

**设计变更说明**：需求文档中 `siclaw_context_tokens` 使用 Histogram 且有 `bound` 标签。这里改为两个 Gauge（`_used` 和 `_limit`），原因是上下文利用率是瞬时状态快照，Gauge 更合适。利用率百分比可在 Grafana 用 `used / limit` 计算。

---

## 3. 具体实现方案

### 3.1 文件改动清单

```
┌──────────────────────────────────────────────────┬────────────┬─────────────────────────────────────┐
│ 文件                                              │ 改动类型   │ 内容                                │
├──────────────────────────────────────────────────┼────────────┼─────────────────────────────────────┤
│ package.json                                     │ 修改       │ 新增 prom-client 依赖                │
│ src/shared/diagnostic-events.ts                  │ 新建       │ 事件类型定义 + emit/subscribe 总线   │
│ src/shared/metrics.ts                            │ 新建       │ 指标定义 + 事件订阅映射（唯一依赖    │
│                                                  │            │ prom-client 的文件）                 │
│ src/agentbox/http-server.ts                      │ 修改       │ prompt 完成时 emitDiagnostic +       │
│                                                  │            │ /metrics 路由                        │
│ src/agentbox/session.ts                          │ 修改       │ session/tool 事件 emit               │
│ src/gateway/server.ts                            │ 修改       │ /metrics 路由 + ws 事件 emit         │
│ src/agentbox/session.ts (第二期)                  │ 修改       │ 卡死会话扫描器                       │
└──────────────────────────────────────────────────┴────────────┴─────────────────────────────────────┘
```

注意：**不需要修改** `claude-sdk-brain.ts` 和 `pi-agent-brain.ts`。埋点统一在消费侧完成。

### 3.2 `http-server.ts` 埋点方案（核心改动）

prompt 的异步执行流程：

```
POST /api/prompt
  │
  ├─ getOrCreate(sessionId)  ◄── session 事件在 session.ts 中 emit
  ├─ prevStats = brain.getSessionStats()   ◄── [新增] 拍快照
  ├─ startTime = Date.now()                ◄── [新增] 记录开始时间
  │
  ├─ brain.prompt(text)                    ◄── 异步执行，立即返回
  │     │
  │     ├─ .then() → onPromptFinish("completed")
  │     └─ .catch() → onPromptFinish("error")
  │
  └─ sendJson(200, { ok, sessionId })      ◄── 立即返回给 Gateway
         │
         ▼
    actuallyFinish()                        ◄── prompt 真正完成（含 compaction/retry）
      ├─ currStats = brain.getSessionStats()      ◄── [新增]
      ├─ emitDiagnostic({                         ◄── [新增] 通过事件总线记录
      │    type: "prompt_complete",
      │    prev: prevStats, curr: currStats,
      │    model, durationMs, outcome, userId
      │  })
      └─ scheduleRelease()
```

关键代码变更位置：

```typescript
// src/agentbox/http-server.ts — POST /api/prompt handler

import { emitDiagnostic } from "../shared/diagnostic-events.js";

// [新增] 在 prompt 执行前拍快照
const prevStats = managed.brain.getSessionStats();
const promptStartTime = Date.now();

// 需要将 outcome 传递到 actuallyFinish
let promptOutcome: "completed" | "error" = "completed";

// ... 现有的 brain.prompt(promptText) 调用 ...

managed.brain.prompt(promptText).then(() => {
  promptOutcome = "completed";
  onPromptFinish();
}).catch((err) => {
  promptOutcome = "error";
  console.error(`[agentbox-http] Prompt error for session ${managed.id}:`, err);
  onPromptFinish();
});

const actuallyFinish = () => {
  managed._promptDone = true;

  // [新增] 通过事件总线记录指标
  const currStats = managed.brain.getSessionStats();
  const model = managed.brain.getModel();
  emitDiagnostic({
    type: "prompt_complete",
    prev: prevStats,
    curr: currStats,
    model,
    durationMs: Date.now() - promptStartTime,
    outcome: promptOutcome,
    userId: sessionManager.userId,
  });

  // ... 现有的 buffer unsub + callback + scheduleRelease 逻辑不变 ...
};
```

### 3.3 `session.ts` 会话 + Tool 事件方案

```typescript
// src/agentbox/session.ts

import { emitDiagnostic } from "../shared/diagnostic-events.js";

// ── 会话生命周期事件 ──

// 在 getOrCreate() 中，sessions.set() 后：
this.sessions.set(id, managed);
emitDiagnostic({ type: "session_created", sessionId: id });

// 在 release() 中，sessions.delete() 处：
if (this.sessions.get(sessionId) === managed) {
  this.sessions.delete(sessionId);
  emitDiagnostic({ type: "session_released", sessionId });
  this.onSessionRelease?.();
}

// 在 close() 中，sessions.delete() 处：
if (managed) {
  this.sessions.delete(sessionId);
  emitDiagnostic({ type: "session_released", sessionId });
}

// 在 closeAll() 中：
for (const [id] of this.sessions) {
  emitDiagnostic({ type: "session_released", sessionId: id });
}
this.sessions.clear();
```

**注意**：`getOrCreate()` 在 session 复用时（Map 中已存在）直接返回，不触发 emit。只有真正新建时才 emit `session_created`。这与 Map 的 set/delete 严格对齐。

`closeAll()` 中改用逐个 emit `session_released` 而非原方案的 `sessionsActive.set(0)` — 事件总线模式下无法直接操作 Gauge，且逐个 emit 能让其他订阅者（如未来的日志）也收到每个 session 的关闭通知。

```typescript
// ── Tool 执行事件 ──

// 在 getOrCreate() 中已有的 brain 事件订阅中追加 tool 指标
result.brain.subscribe((event: any) => {
  // [新增] 任何事件都更新 lastActiveAt（用于第二期卡死检测）
  managed!.lastActiveAt = new Date();

  // [新增] Tool 执行指标
  if (event.type === "tool_execution_end") {
    emitDiagnostic({
      type: "tool_call",
      toolName: event.toolName ?? "unknown",
      outcome: event.isError ? "error" : "success",
      durationMs: 0, // tool_execution_end 无耗时数据，暂为 0
    });
  }

  // ... 现有的 isAgentActive / isCompacting / isRetrying 逻辑不变 ...
});
```

**关于 tool durationMs**：当前 brain 事件中 `tool_execution_end` 不包含执行耗时数据。需要配合 `tool_execution_start` 事件计算差值。在 subscribe 闭包中维护一个 `toolStartTimes` Map：

```typescript
const toolStartTimes = new Map<string, number>();

result.brain.subscribe((event: any) => {
  managed!.lastActiveAt = new Date();

  if (event.type === "tool_execution_start") {
    // 用 toolName 作 key（同一时刻不会有同名 tool 并发执行）
    toolStartTimes.set(event.toolName, Date.now());
  } else if (event.type === "tool_execution_end") {
    const startTime = toolStartTimes.get(event.toolName);
    toolStartTimes.delete(event.toolName);
    emitDiagnostic({
      type: "tool_call",
      toolName: event.toolName ?? "unknown",
      outcome: event.isError ? "error" : "success",
      durationMs: startTime ? Date.now() - startTime : 0,
    });
  }

  // ... 现有逻辑 ...
});
```

### 3.4 `server.ts` Gateway 端改动

```typescript
// src/gateway/server.ts

import { emitDiagnostic } from "../shared/diagnostic-events.js";

// ── /metrics 端点 ──
// 放在 /api/health 判断后面（行 ~398）
if (url === "/metrics" && method === "GET") {
  // 可选 bearer token 校验
  const metricsToken = process.env.SICLAW_METRICS_TOKEN;
  if (metricsToken) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${metricsToken}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
  }
  const { metricsRegistry } = await import("../shared/metrics.js");
  const body = await metricsRegistry.metrics();
  res.writeHead(200, { "Content-Type": metricsRegistry.contentType });
  res.end(body);
  return;
}

// ── WebSocket 连接指标 ──
// 在 WebSocket connection handler 中：

wss.on("connection", (ws, req) => {
  clients.add(ws);
  emitDiagnostic({ type: "ws_connected" });

  ws.on("close", () => {
    clients.delete(ws);
    emitDiagnostic({ type: "ws_disconnected" });
    // ... 现有 cleanup 逻辑 ...
  });

  // ... 现有逻辑 ...
});
```

**`/metrics` 安全设计**：
- 默认无认证（Local 开发模式）
- 设置 `SICLAW_METRICS_TOKEN` 环境变量后启用 bearer token 校验
- K8s 环境下可额外通过 NetworkPolicy 限制只有 Prometheus namespace 的 Pod 可访问

### 3.5 AgentBox `/metrics` 端点

```typescript
// src/agentbox/http-server.ts — 新增路由

addRoute("GET", "/metrics", async (req, res) => {
  const metricsToken = process.env.SICLAW_METRICS_TOKEN;
  if (metricsToken) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${metricsToken}`) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }
  }
  const { metricsRegistry } = await import("../shared/metrics.js");
  res.writeHead(200, { "Content-Type": metricsRegistry.contentType });
  res.end(await metricsRegistry.metrics());
});
```

**注意 `import("../shared/metrics.js")` 使用动态 import**：这确保 `metrics.ts` 模块在首次访问 `/metrics` 时才被加载和初始化（注册 `onDiagnostic` 订阅）。如果需要从启动时就开始收集指标，应改为在 `createHttpServer()` 顶部静态 import。推荐静态 import — 确保 prompt 指标从第一次请求起就被收集。

### 3.6 第二期 — 卡死会话扫描器方案

```typescript
// src/agentbox/session.ts — AgentBoxSessionManager 新增

private stuckScanTimer: ReturnType<typeof setInterval> | null = null;

/** 可配置阈值（默认 120s） */
private stuckThresholdMs = parseInt(
  process.env.SICLAW_STUCK_THRESHOLD_MS || "120000", 10
);

/**
 * 启动卡死会话扫描器（30s 间隔）。
 * 在 ensureSharedComponents() 末尾调用一次。
 */
startStuckScanner(): void {
  if (this.stuckScanTimer) return;
  this.stuckScanTimer = setInterval(() => this.scanStuckSessions(), 30_000);
}

private scanStuckSessions(): void {
  const now = Date.now();
  for (const managed of this.sessions.values()) {
    // 只检查正在执行 prompt 的会话
    if (!managed.isAgentActive) continue;

    const idleMs = now - managed.lastActiveAt.getTime();
    if (idleMs > this.stuckThresholdMs && !managed._reportedStuck) {
      managed._reportedStuck = true;
      emitDiagnostic({ type: "session_stuck", sessionId: managed.id, idleMs });
    }
  }
}
```

**防重复计数**：`ManagedSession` 接口新增 `_reportedStuck: boolean` 字段（初始 `false`）。同一个 stuck session 只上报一次。当 session 恢复活跃时（收到新事件），在 brain subscribe 中重置：

```typescript
// brain subscribe 中（已有 lastActiveAt 更新的位置）
managed!.lastActiveAt = new Date();
managed!._reportedStuck = false;  // [新增] 恢复活跃时重置 stuck 标记
```

**上下文利用率事件**：在 prompt 完成时 emit：

```typescript
// http-server.ts — actuallyFinish() 中，emitDiagnostic prompt_complete 之后
const usage = managed.brain.getContextUsage();
if (usage && model) {
  emitDiagnostic({
    type: "context_usage",
    provider: model.provider,
    model: model.id,
    tokensUsed: usage.tokens,
    tokensLimit: usage.contextWindow,
  });
}
```

**检测逻辑**：只有 `isAgentActive === true`（即 agent_start 到 agent_end 之间）且 `lastActiveAt` 超过阈值的会话才判定为卡死。单纯 idle 的会话已经通过 `scheduleRelease()` 的 30s TTL 自动释放，不属于卡死。

---

## 4. 开发模块拆分

将实现拆分为 **7 个独立模块**，每个模块可独立 review 和合并。

### Module 1: 事件总线 + 指标基础设施

**目标**：建立解耦的事件总线和 `prom-client` 指标订阅层

**改动文件**：
- `package.json` — 新增 `prom-client` 依赖
- `src/shared/diagnostic-events.ts` — **新建**，事件类型定义 + `emitDiagnostic()` / `onDiagnostic()` 总线
- `src/shared/metrics.ts` — **新建**，prom-client Registry + 指标定义 + `handleDiagnostic()` 订阅

**验收标准**：
- `npm install` 成功
- `import { emitDiagnostic } from "./shared/diagnostic-events.js"` 编译通过，零外部依赖
- `import "./shared/metrics.js"` 后，`emitDiagnostic({ type: "session_created", sessionId: "test" })` 触发 `sessionsActive` Gauge +1
- `npx tsc --noEmit` 无错误

**预估代码量**：~150 行（diagnostic-events.ts ~60 行 + metrics.ts ~90 行）

**无外部依赖，可第一个开发。**

---

### Module 2: Prompt 指标埋点

**目标**：在 prompt 完成时通过事件总线记录 token/cost/duration/count

**改动文件**：
- `src/agentbox/http-server.ts` — 在 `POST /api/prompt` handler 中：
  1. 顶部 `import { emitDiagnostic } from "../shared/diagnostic-events.js"`
  2. prompt 开始前调用 `brain.getSessionStats()` 拍快照 + 记录 `promptStartTime`
  3. `.then()` / `.catch()` 设置 `promptOutcome`
  4. 在 `actuallyFinish()` 中 `emitDiagnostic({ type: "prompt_complete", ... })`

**具体改动点**：
```
行 155 (POST /api/prompt handler 入口)
  └─ 新增：prevStats + promptStartTime + promptOutcome 声明

行 283-298 (actuallyFinish 函数)
  └─ 新增：currStats 获取 + emitDiagnostic() 调用

行 323-328 (brain.prompt then/catch)
  └─ 修改：设置 promptOutcome 变量
```

**验收标准**：
- 执行一次 prompt 后，`metricsRegistry.metrics()` 输出包含 `siclaw_tokens_total`、`siclaw_cost_usd_total`、`siclaw_prompt_duration_ms`、`siclaw_prompts_total` 且值正确

**依赖 Module 1。**

**预估代码量**：~30 行改动

---

### Module 3: 会话生命周期事件

**目标**：`session_created` / `session_released` 事件与 `sessions` Map 的 set/delete 严格同步

**改动文件**：
- `src/agentbox/session.ts` — 在 4 个位置添加 `emitDiagnostic()` 调用：
  1. `getOrCreate()` 行 313（`sessions.set` 后） → `session_created`
  2. `release()` 行 415-416（`sessions.delete` 处） → `session_released`
  3. `close()` 行 484（`sessions.delete` 处） → `session_released`
  4. `closeAll()` 行 501（`sessions.clear` 前） → 逐个 `session_released`

**验收标准**：
- 创建 session 后 `siclaw_sessions_active` 为 1，release 后回到 0
- closeAll 后 Gauge 恢复为 0

**依赖 Module 1。可与 Module 2 并行开发。**

**预估代码量**：~15 行改动

---

### Module 4: Tool 执行指标

**目标**：追踪每种 tool 的调用频率和成功/失败率

**改动文件**：
- `src/agentbox/session.ts` — 在 `getOrCreate()` 的 brain 事件订阅中，处理 `tool_execution_start/end` 事件，维护 `toolStartTimes` Map 计算耗时，emit `tool_call` 事件

**验收标准**：
- 执行一次包含 tool 调用的 prompt 后，`siclaw_tool_calls_total` 按 `tool_name` 和 `outcome` 正确递增

**依赖 Module 1。可与 Module 2/3 并行开发。**

**预估代码量**：~20 行改动

---

### Module 5: `/metrics` 端点 + 安全

**目标**：在 AgentBox 和 Gateway 上暴露 Prometheus 抓取端点，支持可选 bearer token 校验

**改动文件**：
- `src/agentbox/http-server.ts` — 新增 `GET /metrics` 路由（含 token 校验）
- `src/gateway/server.ts` — 在 `/api/health` 后新增 `GET /metrics` 路由（含 token 校验）+ WebSocket 连接 `emitDiagnostic`

**设计注意**：
- 在 AgentBox 的 `http-server.ts` 中，`/metrics` 路由加在 `/health` 路由后面
- 在 Gateway 的 `server.ts` 中，`/metrics` 路由加在 `/api/health` 判断后面（行 ~398）
- 使用静态 `import "../shared/metrics.js"` 确保订阅从启动时生效
- `SICLAW_METRICS_TOKEN` 环境变量启用 bearer token 校验

**验收标准**：
- 本地启动后 `curl http://localhost:3001/metrics` 返回 Prometheus 文本格式
- `curl http://localhost:4000/metrics`（AgentBox 端口）返回相同内容
- 设置 `SICLAW_METRICS_TOKEN=secret` 后，无 token 的请求返回 401
- 输出包含 `siclaw_ws_connections` 指标

**依赖 Module 1-4（确保有指标数据可返回）。**

**预估代码量**：~30 行改动

---

### Module 6: 单元测试

**目标**：验证事件总线和指标映射的正确性

**改动文件**：
- `src/shared/__tests__/diagnostic-events.test.ts` — **新建**
- `src/shared/__tests__/metrics.test.ts` — **新建**

**测试用例**：

```typescript
// diagnostic-events.test.ts
describe("emitDiagnostic", () => {
  it("should call all listeners", () => { /* ... */ });
  it("should not throw when a listener throws", () => { /* ... */ });
  it("should support unsubscribe", () => { /* ... */ });
});

// metrics.test.ts
describe("metrics subscriber", () => {
  beforeEach(() => metricsRegistry.resetMetrics());

  it("should increment token counters with correct delta on prompt_complete", async () => {
    emitDiagnostic({
      type: "prompt_complete",
      prev: { tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 }, cost: 0.01 },
      curr: { tokens: { input: 250, output: 120, cacheRead: 30, cacheWrite: 10, total: 410 }, cost: 0.05 },
      model: { id: "claude-sonnet-4-20250514", name: "Sonnet", provider: "anthropic", contextWindow: 200000, maxTokens: 16384, reasoning: false },
      durationMs: 3500,
      outcome: "completed",
      userId: "user-1",
    });

    const metrics = await metricsRegistry.getMetricsAsJSON();
    // 验证 token 增量 = curr - prev (input: 150, output: 70, cacheRead: 30, cacheWrite: 10)
    // 验证 cost 增量 = 0.04
    // 验证 duration histogram 有一个观测值 3500
    // 验证 prompts_total = 1
  });

  it("should handle zero-delta gracefully", async () => { /* ... */ });
  it("should omit user_id when SICLAW_METRICS_USER_ID=false", async () => { /* ... */ });

  it("should track session lifecycle", async () => {
    emitDiagnostic({ type: "session_created", sessionId: "s1" });
    emitDiagnostic({ type: "session_created", sessionId: "s2" });
    // sessions_active = 2
    emitDiagnostic({ type: "session_released", sessionId: "s1" });
    // sessions_active = 1
  });

  it("should track tool calls", async () => {
    emitDiagnostic({ type: "tool_call", toolName: "restricted_bash", outcome: "success", durationMs: 1200 });
    emitDiagnostic({ type: "tool_call", toolName: "restricted_bash", outcome: "error", durationMs: 500 });
    // tool_calls_total{tool_name="restricted_bash", outcome="success"} = 1
    // tool_calls_total{tool_name="restricted_bash", outcome="error"} = 1
  });
});
```

**依赖 Module 1。可与 Module 2-5 并行开发。**

**预估代码量**：~100 行

---

### Module 7: 第二期 — 会话健康指标 + 卡死扫描器

**目标**：添加上下文窗口 Gauge、卡死会话检测（含防重复计数）

**改动文件**：
- `src/shared/metrics.ts` — 追加 4 个指标定义 + `handleDiagnostic` 中追加 `context_usage` 和 `session_stuck` case
- `src/agentbox/session.ts` — 新增：
  1. `ManagedSession` 接口添加 `_reportedStuck: boolean` 字段
  2. `startStuckScanner()` 方法（30s interval）
  3. `scanStuckSessions()` 私有方法（含 `_reportedStuck` 防重复）
  4. brain 事件订阅中重置 `_reportedStuck = false`（已在 Module 4 中添加的 `lastActiveAt` 更新旁）
  5. 在 `ensureSharedComponents()` 末尾调用 `startStuckScanner()`
  6. 在 `closeAll()` 中 `clearInterval(stuckScanTimer)`
- `src/agentbox/http-server.ts` — 在 `actuallyFinish()` 中 emit `context_usage` 事件

**验收标准**：
- 模拟一个 120s 无事件的会话，扫描器检测到后 `siclaw_session_stuck_total` 递增 1（不重复计数）
- 同一会话恢复活跃后再次卡死，Counter 再次递增
- prompt 完成后 `siclaw_context_tokens_used` 更新为正确值

**依赖 Module 1-5 已合并。独立 PR。**

**预估代码量**：~60 行

---

## 5. 模块依赖关系与开发顺序

```
Module 1 (事件总线 + 指标基础设施)
  │
  ├──► Module 2 (Prompt 埋点) ─────┐
  │                                 │
  ├──► Module 3 (Session 事件) ─────┤
  │                                 │
  ├──► Module 4 (Tool 指标) ────────┤
  │                                 │
  ├──► Module 6 (单元测试)          ├──► Module 5 (/metrics 端点 + 安全)
  │                                 │
  └─────────────────────────────────┘
                                         │
                                         ▼
                                Module 7 (第二期：健康指标)
```

**推荐开发顺序**：

| 顺序 | 模块 | 说明 |
|------|------|------|
| 1 | Module 1 | 事件总线 + 指标基础设施，无依赖 |
| 2 | Module 2 + 3 + 4 + 6 | 可并行开发，互不依赖 |
| 3 | Module 5 | 依赖 1-4，端到端验证 |
| 4 | Module 7 | 第二期，独立 PR |

**建议 PR 策略**：
- **PR #1**：Module 1 + 2 + 3 + 4 + 5 + 6 合为一个 PR（第一期完整交付）
- **PR #2**：Module 7（第二期独立 PR）

---

## 6. 风险与注意事项

### 6.1 prom-client 在 ESM 环境的兼容性

项目使用 ESM-only（`"type": "module"`）。`prom-client` v15+ 支持 ESM，需确认版本。安装后需验证 `import { Counter } from "prom-client"` 在 `npx tsc --noEmit` 下通过。

### 6.2 Token 增量计算的准确性

`getSessionStats()` 返回的是 session 级累计值。如果一次 prompt 期间有 auto-retry（token 被重复消耗），增量会包含 retry 的 token，这是正确行为 — 用户实际消耗了这些 token。

但如果 `getSessionStats()` 在 brain 异步操作未完全结束时被调用（如 compaction 还在进行），可能拿到不完整的数据。方案中将 `emitDiagnostic` 放在 `actuallyFinish()` 中（等待 agent_end + compaction_end + retry_end 都完成后），确保数据完整。

### 6.3 pi-agent brain 的 getModel() 行为

`PiAgentBrain.getModel()` 返回的 `provider` 字段来自 pi-coding-agent 内部的 model registry。需要确认它返回的 provider 字符串（如 `"anthropic"`）与 claude-sdk-brain 的硬编码值一致，否则标签会不统一。

### 6.4 Hot-path 性能

`emitDiagnostic()` 是同步回调数组遍历 + try-catch，`prom-client` 的 Counter.inc() 和 Histogram.observe() 是 O(1) 内存操作。每次 prompt 完成和 tool 执行结束时各调用一次，性能影响可忽略。

`/metrics` 端点的序列化开销在指标数量 < 100 时可忽略。

### 6.5 Local 模式多用户标签隔离

`LocalSpawner` 下多个用户共享同一个事件总线和 Registry。`user_id` 标签确保指标按用户隔离。如果禁用 `user_id` 标签（`SICLAW_METRICS_USER_ID=false`），所有用户的 token/cost 会合并计数 — 这在单用户开发环境下是可接受的。

### 6.6 事件总线的启动时序

`metrics.ts` 通过模块顶层 `onDiagnostic(handleDiagnostic)` 注册订阅。它必须在第一个 `emitDiagnostic()` 调用之前被 import。推荐在 `agentbox-main.ts` 和 `gateway-main.ts` 入口文件顶部添加：

```typescript
import "../shared/metrics.js";  // 注册指标订阅（副作用 import）
```

这确保无论哪个路径先触发事件，订阅者都已就绪。

### 6.7 Tool durationMs 精度

tool 执行耗时通过 `tool_execution_start` 和 `tool_execution_end` 的时间差计算。如果 brain 内部有 tool 并发执行（同一 tool name 同时执行多次），`toolStartTimes` Map 会被覆盖。当前 Siclaw 的 agent 是单线程顺序执行 tool 的，不存在这个问题。但如果未来引入 tool 并发，需要改用 `toolName + 序号` 作为 Map key。

---

## 7. 与需求文档的偏差说明

| 需求文档内容 | 本方案调整 | 理由 |
|------------|-----------|------|
| 在 `claude-sdk-brain.ts` 中埋 token/cost | 改为在 `http-server.ts` 消费侧通过事件总线 emit | 一处代码覆盖两种 brain，业务代码零 prom-client 依赖 |
| 直接 import prom-client 到业务文件 | 引入 `diagnostic-events.ts` 事件总线解耦 | 业务代码只依赖事件类型定义，未来可无痛切换指标后端 |
| `siclaw_context_tokens` 用 Histogram + `bound` 标签 | 改为两个 Gauge（`_used` / `_limit`） | 瞬时状态用 Gauge 更准确 |
| K8s 模式 Gateway 聚合各 Pod 指标 | 改为 Pod 级 `/metrics` + ServiceMonitor | 应用层不做跨 Pod 聚合，交给 Prometheus |
| `session.ts` 的 create/release 时更新 Gauge | 改为 emit 事件，与 `sessions` Map 的 set/delete 对齐 | 避免异步释放导致的计数偏差 |
| 待决策项 #3：pi-agent 是否需要埋点 | 不需要单独埋，消费侧统一覆盖 | 两种 brain 的 `getSessionStats()` 返回格式一致 |
| 5 个第一期指标 | 扩展为 7 个（+tool_calls_total, +ws_connections） | SRE agent 的 tool 执行和 Gateway WS 连接是核心运行指标 |
| `/metrics` 无认证 | 支持可选 bearer token（`SICLAW_METRICS_TOKEN`） | K8s 环境下保护含 user_id 和成本数据的敏感指标 |
| 第二期卡死扫描重复计数 | 新增 `_reportedStuck` flag 防重复 | 避免同一 stuck session 每 30s 被重复计入 Counter |
| `promptDurationMs` 最大桶 60s | 扩展到 300s | 覆盖 Deep Investigation 长耗时场景 |

---

## 8. 未来扩展方向（不在本次范围内）

| 方向 | 触发条件 | 预估工作量 |
|------|---------|-----------|
| Deep Investigation 指标 | IM Phase 2 完成、Investigation Engine API 稳定后 | ~30 行（新增 DiagnosticEvent 类型 + metrics 订阅） |
| 结构化日志（Pino/Winston） | 独立 roadmap 项 | 新增第二个 `onDiagnostic` 订阅者，业务代码不变 |
| OTel SDK 迁移 | 需要 OTLP push 到 Grafana Cloud 时 | 替换 `metrics.ts` 中的 `prom-client` → `@opentelemetry/sdk-metrics`，事件总线和业务代码不变 |
| `command_rejected_total` | 安全审计需求明确后 | 在 `command-sets.ts` 的 `validateCommand()` 中 emit 新事件 |
