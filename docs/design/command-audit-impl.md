# 命令审计系统 — 技术实现方案

> 基于 `command-audit-spec.md` (Draft v3)，拆解为 6 个可独立开发、独立合并的子项。

---

## 架构总览

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            数据流                                           │
│                                                                             │
│  AgentBox                    Gateway                       Frontend         │
│  ┌──────────┐    SSE     ┌──────────────────┐    WS    ┌──────────────┐    │
│  │tool exec │──events──→ │ rpc-methods.ts   │──push──→ │ chat panel   │    │
│  │          │            │   ├─start: t₀    │          │              │    │
│  │          │            │   └─end: append  │          │              │    │
│  └──────────┘            │     + userId     │          └──────────────┘    │
│                          │     + outcome    │                              │
│                          │     + durationMs │          ┌──────────────┐    │
│                          │                  │←──RPC──→ │ AuditTab     │    │
│                          │  audit.list      │          │  筛选+列表   │    │
│                          │  audit.detail    │          │  展开详情    │    │
│                          └────────┬─────────┘          └──────────────┘    │
│                                   │                                        │
│                          ┌────────▼─────────┐                              │
│                          │  SQLite messages  │                              │
│                          │  + user_id        │                              │
│                          │  + outcome        │                              │
│                          │  + duration_ms    │                              │
│                          │  + 2 indexes      │                              │
│                          └──────────────────┘                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 子项拆分

### P1: Schema — messages 表加字段 + 索引

**目标**：让数据库准备好接收审计数据，不改任何业务逻辑。

**改动文件**：

| 文件 | 改动 |
|------|------|
| `src/gateway/db/schema-sqlite.ts` L60-71 | messages 表加 3 列 |
| `src/gateway/db/migrate-sqlite.ts` L45-54 | CREATE TABLE 加 3 列 |
| `src/gateway/db/migrate-sqlite.ts` INDEX_STATEMENTS | 加 2 索引 |
| `src/gateway/db/migrate-sqlite.ts` MIGRATIONS | 加 3 条 ALTER TABLE |

**schema-sqlite.ts messages 表改动**：

```typescript
export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id")
    .notNull()
    .references(() => sessions.id),
  role: text("role").notNull(),
  content: text("content").notNull(),
  toolName: text("tool_name"),
  toolInput: text("tool_input"),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
  timestamp: integer("timestamp", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  // ── Audit fields (nullable — only populated for role='tool') ──
  userId: text("user_id"),
  outcome: text("outcome"),       // "success" | "error" | "blocked"
  durationMs: integer("duration_ms"),
});
```

**migrate-sqlite.ts CREATE TABLE 改动**：

```sql
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'tool')),
  content TEXT NOT NULL,
  tool_name TEXT,
  tool_input TEXT,
  metadata TEXT,
  timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
  user_id TEXT,
  outcome TEXT CHECK(outcome IN ('success', 'error', 'blocked')),
  duration_ms INTEGER
)
```

**新增索引**（追加到 INDEX_STATEMENTS）：

```sql
CREATE INDEX IF NOT EXISTS idx_messages_audit ON messages(role, user_id, timestamp)
CREATE INDEX IF NOT EXISTS idx_messages_tool_name ON messages(tool_name)
```

**MIGRATIONS 追加**（兼容已有数据库）：

```sql
ALTER TABLE messages ADD COLUMN user_id TEXT
ALTER TABLE messages ADD COLUMN outcome TEXT
ALTER TABLE messages ADD COLUMN duration_ms INTEGER
```

**验证**：`npm test` 通过；启动 Gateway，`SELECT * FROM messages LIMIT 1` 能看到新列（值为 NULL）。

---

### P2: Repository — ChatRepository 扩展

**目标**：`appendMessage()` 支持写入审计字段；新增 `getMessageById()` 和 `queryAuditLogs()` 方法。

**改动文件**：

| 文件 | 改动 |
|------|------|
| `src/gateway/db/repositories/chat-repo.ts` | 扩展 appendMessage + 新增 2 个查询方法 |

**appendMessage 签名扩展**：

```typescript
async appendMessage(msg: {
  sessionId: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
  toolInput?: string;
  metadata?: Record<string, unknown>;
  // ── Audit fields ──
  userId?: string;
  outcome?: string;
  durationMs?: number;
}): Promise<string> {
  const id = crypto.randomUUID();
  await this.db.insert(messages).values({
    id,
    sessionId: msg.sessionId,
    role: msg.role,
    content: msg.content,
    toolName: msg.toolName ?? null,
    toolInput: msg.toolInput ?? null,
    metadata: msg.metadata ?? null,
    userId: msg.userId ?? null,
    outcome: msg.outcome ?? null,
    durationMs: msg.durationMs ?? null,
  });
  return id;
}
```

**新增 getMessageById**：

```typescript
async getMessageById(messageId: string) {
  const rows = await this.db
    .select()
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  return rows[0] ?? null;
}
```

**新增 queryAuditLogs**：

```typescript
async queryAuditLogs(opts: {
  userId?: string;
  toolName?: string;
  outcome?: string;
  startDate?: number;   // unix timestamp
  endDate?: number;
  cursorTs?: number;
  cursorId?: string;
  limit: number;
}): Promise<Array<{
  id: string;
  userId: string | null;
  toolName: string | null;
  toolInput: string | null;
  outcome: string | null;
  durationMs: number | null;
  timestamp: Date;
}>>
```

实现要点：
- WHERE 条件使用 `and()` 动态组装，仅添加非空筛选条件
- `role = 'tool'` 是固定条件
- 游标分页：`(timestamp < cursorTs) OR (timestamp = cursorTs AND id < cursorId)`
- `SELECT` 不包含 `content`（列表接口不返回工具输出）
- `LIMIT opts.limit + 1`，取多一条用于判断 `hasMore`

**验证**：编写单元测试 `chat-repo.test.ts`，测试：
- appendMessage 写入审计字段
- queryAuditLogs 基础筛选
- queryAuditLogs 游标分页
- getMessageById 返回完整记录

---

### P3: 数据写入 — SSE 事件处理补充审计数据

**目标**：在工具执行流程中填充 `userId`、`outcome`、`durationMs`。

**改动文件**：

| 文件 | 改动 |
|------|------|
| `src/gateway/rpc-methods.ts` ~L520-560 | SSE 事件处理 |

**改动细节**：

1. 在 `pendingToolInput` 旁新增时间戳变量：

```typescript
let pendingToolInput = "";
let pendingToolStartTime = 0;  // 新增
```

2. `tool_execution_start` 处记录开始时间：

```typescript
} else if (eventType === "tool_execution_start") {
  const args = eventData.args as Record<string, unknown> | undefined;
  pendingToolInput = args ? JSON.stringify(args) : "";
  pendingToolStartTime = Date.now();  // 新增
}
```

3. `tool_execution_end` 处计算 outcome 和 duration，传入 appendMessage：

```typescript
if (chatRepo && eventType === "tool_execution_end") {
  const toolResult = eventData.result as {
    content?: Array<{ type: string; text?: string }>;
    details?: { blocked?: boolean; error?: boolean };   // 扩展类型
  } | undefined;

  // outcome 判断优先级：blocked > error > success
  let outcome: "success" | "error" | "blocked" = "success";
  if (toolResult?.details?.blocked) {
    outcome = "blocked";
  } else if (toolResult?.details?.error) {
    outcome = "error";
  }

  const durationMs = pendingToolStartTime > 0
    ? Date.now() - pendingToolStartTime
    : undefined;

  const text = toolResult?.content
    ?.filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("") ?? "";
  const toolName = (eventData.toolName as string) || "tool";

  dbMessageId = await chatRepo.appendMessage({
    sessionId: result.sessionId,
    role: "tool",
    content: redactText(text, redactionConfig),
    toolName,
    toolInput: pendingToolInput ? redactText(pendingToolInput, redactionConfig) : undefined,
    userId,           // 新增 — 闭包中已有
    outcome,          // 新增
    durationMs,       // 新增
  });
  await chatRepo.incrementMessageCount(result.sessionId);
  pendingToolInput = "";
  pendingToolStartTime = 0;  // 重置
}
```

**关键验证**：`eventData.result.details` 是否在 SSE 事件中传递。

需确认 AgentBox SSE 序列化路径。`tool_execution_end` 事件由 pi-agent / claude-sdk brain 产生，结果对象包含 `content` 和 `details`。查看 `tool-adapter.ts:148`：

```typescript
const isError = !!(result as any).details?.error;
```

这表明 `details` 确实存在于 result 对象中并通过 SSE 传递。**但需要实际测试验证 `details.blocked` 在 blocked 场景下是否可达**。

验证方法：本地启动，执行一条会被 blocked 的命令（如 `rm -rf /`），在 `tool_execution_end` 处加 `console.log(JSON.stringify(eventData.result))` 查看 details 字段。

**验证**：手动测试 3 种 outcome 场景（success / error / blocked），确认数据库中记录正确。

---

### P4: 查询 API — audit.list + audit.detail RPC

**目标**：新增 2 个 RPC 方法，供前端调用。

**改动文件**：

| 文件 | 改动 |
|------|------|
| `src/gateway/rpc-methods.ts` | 新增 `audit.list` + `audit.detail` 两个 methods.set 注册 |

**audit.list 实现**：

```typescript
methods.set("audit.list", async (params, context: RpcContext) => {
  const userId = requireAuth(context);
  if (!chatRepo) throw new Error("Database not available");

  const p = params as {
    userId?: string;
    toolName?: string;
    outcome?: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
    cursorTs?: number;
    cursorId?: string;
  };

  // 权限：非 admin 强制只查自己
  const queryUserId = isAdminUser(context) ? (p.userId || undefined) : userId;
  const limit = Math.min(p.limit ?? 50, 200);

  const rows = await chatRepo.queryAuditLogs({
    userId: queryUserId,
    toolName: p.toolName,
    outcome: p.outcome,
    startDate: p.startDate ? Math.floor(new Date(p.startDate).getTime() / 1000) : undefined,
    endDate: p.endDate ? Math.floor(new Date(p.endDate).getTime() / 1000) : undefined,
    cursorTs: p.cursorTs,
    cursorId: p.cursorId,
    limit,
  });

  const hasMore = rows.length > limit;
  const logs = hasMore ? rows.slice(0, limit) : rows;

  return { logs, hasMore };
});
```

**audit.detail 实现**：

```typescript
methods.set("audit.detail", async (params, context: RpcContext) => {
  const userId = requireAuth(context);
  if (!chatRepo) throw new Error("Database not available");

  const { messageId } = params as { messageId: string };
  if (!messageId) throw new Error("messageId is required");

  const msg = await chatRepo.getMessageById(messageId);
  if (!msg || msg.role !== "tool") throw new Error("Message not found");

  // 权限校验：通过 session 获取 owner userId
  const session = await chatRepo.getSession(msg.sessionId);
  if (!session) throw new Error("Session not found");
  if (!isAdminUser(context) && session.userId !== userId) {
    throw new Error("Forbidden: not your message");
  }

  return {
    id: msg.id,
    content: msg.content,
    toolName: msg.toolName,
    toolInput: msg.toolInput,
    outcome: msg.outcome,
    durationMs: msg.durationMs,
    timestamp: msg.timestamp,
  };
});
```

**验证**：用 wscat 或前端 devtools 直接发 RPC 调用，验证返回格式和权限控制。

---

### P5: 前端 — Metrics 页面 Audit Tab

**目标**：在 Metrics 页面新增 Audit Tab，实现筛选 + 列表 + 展开详情。

**改动文件**：

| 文件 | 改动 |
|------|------|
| `src/gateway/web/src/pages/Metrics/index.tsx` | Tab 类型扩展 + 渲染 AuditTab |
| `src/gateway/web/src/pages/Metrics/AuditTab.tsx` | **新建** — 完整 Audit 组件 |

**index.tsx 改动**：

```typescript
type Tab = 'dashboard' | 'audit' | 'grafana';
//                        ^^^^^^^ 新增

// Tab 按钮区域新增 Audit 按钮（Dashboard 和 Grafana 之间）
<button onClick={() => setTab('audit')} className={cn(...)}>
  Audit
</button>

// 内容区域
{tab === 'dashboard' ? (
  <DashboardTab ... />
) : tab === 'audit' ? (
  <AuditTab />
) : (
  <GrafanaTab ... />
)}
```

**AuditTab.tsx 组件结构**：

```
AuditTab
├── 筛选栏
│   ├── User 下拉（仅 admin 可见，用 usePermissions().isAdmin 判断）
│   ├── Tool 下拉（All / bash / run_skill / node_exec / pod_exec / ...）
│   ├── Status 下拉（All / success / error / blocked）
│   ├── Date Range 下拉（Last 1h / 6h / 24h / 7d / 30d / Custom）
│   └── Search 按钮
├── 审计列表
│   ├── 表头：Time | User | Tool | Command | Status | Duration
│   ├── 行数据（调用 audit.list RPC）
│   │   ├── Time — timestamp 格式化
│   │   ├── User — userId
│   │   ├── Tool — toolName
│   │   ├── Command — 解析 toolInput JSON，按 toolName 类型展示
│   │   ├── Status — outcome 图标（✓/✗/⊘）
│   │   └── Duration — durationMs 格式化（<1s 显示 ms，>=1s 显示 s）
│   └── Load More 按钮（游标分页）
└── 展开详情（点击行展开）
    ├── 按需调用 audit.detail RPC 加载 content
    ├── 缓存已加载的 content（避免重复请求）
    └── 折叠/展开 content 显示
```

**toolInput 解析逻辑**（工具函数）：

```typescript
function parseToolInput(toolName: string, toolInput: string): string {
  try {
    const parsed = JSON.parse(toolInput);
    switch (toolName) {
      case "bash":
      case "restricted_bash":
        return parsed.command ?? toolInput;
      case "run_skill":
        return `${parsed.skill}/${parsed.script}`;
      case "node_exec":
      case "pod_exec":
        return parsed.command ?? toolInput;
      default:
        return toolInput.slice(0, 100);
    }
  } catch {
    return toolInput.slice(0, 100);
  }
}
```

**验证**：本地启动前端，Metrics → Audit Tab 能加载数据、筛选、翻页、展开详情。

---

### P6: 集成测试 + 文档更新

**目标**：端到端验证完整流程；更新 CLAUDE.md 文件清单。

**内容**：

1. **端到端测试场景**：

| 场景 | 操作 | 预期 |
|------|------|------|
| success | 执行 `kubectl get pods` | outcome=success, durationMs>0 |
| error | 执行 `ls /nonexistent` | outcome=error, durationMs>0 |
| blocked | 执行 `rm -rf /` | outcome=blocked, durationMs 很小或 0 |
| 翻页 | 产生 >50 条记录后查询 | hasMore=true, Load More 正常 |
| 权限 | 普通用户查 admin 的数据 | 返回空或被拒绝 |
| 详情加载 | 点击展开某条记录 | content 正确显示 |

2. **确认 `details.blocked` 可达性**：
   - 在 `rpc-methods.ts` SSE 处理中临时加 log，执行 blocked 命令，确认 `eventData.result` 中包含 `details: { blocked: true }`
   - 如果不可达，需要调整 outcome 判断逻辑（fallback 到检查 content 中的 "blocked" 文本）

3. **文档更新**：
   - `CLAUDE.md` Key File Map 中添加 `AuditTab.tsx`
   - `command-audit-spec.md` 状态从 Draft v3 更新为 Implemented

---

## 子项依赖关系与开发顺序

```
P1 (Schema)
  │
  ▼
P2 (Repository)
  │
  ├──→ P3 (数据写入) ──→ P6 (集成测试)
  │                        ▲
  └──→ P4 (查询 API) ─────┘
         │
         ▼
       P5 (前端)
```

| 子项 | 依赖 | 可并行 | 预估改动量 |
|------|------|--------|-----------|
| **P1** Schema | 无 | — | ~30 行 DDL |
| **P2** Repository | P1 | — | ~80 行 TS |
| **P3** 数据写入 | P2 | 与 P4 并行 | ~30 行 TS |
| **P4** 查询 API | P2 | 与 P3 并行 | ~60 行 TS |
| **P5** 前端 | P4 | — | ~250 行 TSX |
| **P6** 集成测试 | P3+P4+P5 | — | 测试+文档 |

**推荐开发顺序**：P1 → P2 → P3 // P4（并行）→ P5 → P6
