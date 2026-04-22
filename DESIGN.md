# Siclaw Local 模式 + SQLite 支持 — 方案设计

> 让 `siclaw local` 命令起单进程、零外部依赖、内嵌 SQLite 的完整 Gateway + Portal。
> 生产 K8s 部署继续用 MySQL,不变。

**状态**:Reviewer A/B 审查已完成并合并(2026-04-22),此文档为**定稿版**。

---

## 背景与目标

### 当前状态
- `siclaw`(TUI)— 终端单用户,不依赖 DB
- `siclaw local` — **当前只启动 Runtime 进程**,不起 Portal,不接 DB,基本不可用(README 在卖但未落地)
- K8s 生产 — Runtime + Portal 双进程,Portal 接 MySQL

### README 和 CLAUDE.md 的承诺
- README §2:"Local Server — A lightweight web UI backed by SQLite. **No MySQL, no Docker required.**"
- CLAUDE.md:`Gateway DB | sql.js (WASM) | Users, sessions, skills, MCP config.`
- 两处都承诺 local mode 可以 SQLite,**但实现被 2026-04-13 的 `6323dff` 提交("transform gateway into Agent Runtime with MySQL backend")砍掉了**,理由是当时架构整合把 DB 收到 Upstream 一家管
- 后来 Portal 作为 Upstream 的轻量替代接管了 DB,但继承了纯 MySQL 实现,SQLite 支持一直没加回来

### 本次目标
1. `siclaw local` 命令启动**单进程**,内嵌 Runtime + Portal + LocalSpawner + SQLite,零外部依赖
2. Portal 的数据层支持 SQLite(新增)和 MySQL(保留)二选一,按 `DATABASE_URL` 协议头分发
3. Schema 统一为一套 DDL,SQLite 和 MySQL 都能直接跑(接受秒精度时间戳、无 `ON UPDATE`、`JSON` 改 `TEXT` 三项取舍)
4. K8s 生产部署完全不受影响;老 MySQL 生产库零结构变更

### 显式不在本次范围
- ❌ MySQL → SQLite 数据迁移工具(二选一,独立部署)
- ❌ 改造业务代码到 ORM / query builder(保留 raw SQL,成本不成比例)
- ❌ Memory DB(`src/memory/`)的 driver 切换(它本来就是 node:sqlite,不动)
- ❌ `siclaw_users.username` 大小写敏感性差异的统一处理(除非后续需要)
- ❌ TUI 模式的任何变更

---

## 整体方案

```
┌─────────────────────────────────────────────────────────────┐
│                        siclaw local                          │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                    单 Node 进程                         │ │
│  │  ┌──────────┐   ┌──────────┐   ┌──────────────────┐   │ │
│  │  │ Portal   │◀──│ Runtime  │──▶│ LocalSpawner     │   │ │
│  │  │ (HTTP +  │WS │ (RPC +   │RPC│  └─ AgentBox #1  │   │ │
│  │  │  SPA)    │   │  mTLS)   │   │  └─ AgentBox #2  │   │ │
│  │  └────┬─────┘   └──────────┘   └──────────────────┘   │ │
│  │       │                                                 │ │
│  │       ▼                                                 │ │
│  │  ┌──────────────────────────────────────┐              │ │
│  │  │  node:sqlite (WAL 模式)               │              │ │
│  │  │  .siclaw/data/portal.db              │              │ │
│  │  └──────────────────────────────────────┘              │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘

prod K8s (不变):
┌──────────┐  ┌──────────┐  ┌─────────────────┐
│ Portal   │──│ MySQL    │  │ Runtime         │
│ pod      │  │ (外部)    │  │ + AgentBox pods │
└──────────┘  └──────────┘  └─────────────────┘
```

### 核心思路

1. **一个 DB driver 抽象层** — 拆成三件套:`src/gateway/db.ts`(工厂 + 接口)、`src/gateway/db-mysql.ts`(mysql2 包装)、`src/gateway/db-sqlite.ts`(node:sqlite 包装)。按 `DATABASE_URL` 协议头(`mysql://` vs `sqlite://` / `file://`)分发,对外暴露统一的 `query` / `execute` / `getConnection` 接口。
2. **一份 DDL** — `src/portal/migrate.ts` 的 schema 清洗成 MySQL + SQLite 都接受的"最大公约数"语法,两个 driver 都能直接跑
3. **薄方言 helper** — 3 处不可避免的 driver 差异(upsert、INSERT IGNORE、JSON_CONTAINS/JSON_TABLE)收到 `src/gateway/dialect-helpers.ts`,调用方按 driver 分发
4. **MySQL 日期函数全部移到应用层** — 9 处 `NOW()` / `DATE_SUB` / `CURDATE` / `INTERVAL` 改为 JS 算好 ISO 字符串传参,彻底脱离 DB 方言
5. **应用层显式管 `updated_at`** — 移除 `ON UPDATE CURRENT_TIMESTAMP`,所有对 10 张带 `updated_at` 表的 UPDATE 都显式 set `updated_at = CURRENT_TIMESTAMP`
6. **JSON 列双重解析防御** — 三种数据状态(老 MySQL JSON 列 / 新 MySQL TEXT / SQLite TEXT)下读取路径统一用 `safeParseJson()` helper
7. **bootstrap 重构** — 把 `portal-main.ts` / `gateway-main.ts` 的装配逻辑抽到 `bootstrapPortal()` / `bootstrapRuntime()`,`cli-local.ts` 顺序调用两者,prod 入口继续存在

### 边界明确

- **老 MySQL 生产库**:`CREATE TABLE IF NOT EXISTS` 保护,表结构零变更;应用层补 `SET updated_at = CURRENT_TIMESTAMP` 在 `ON UPDATE` 触发器存在时仍然正确(显式 set 优先)
- **新建 MySQL 库**:秒精度时间戳、`TEXT` 代替 `JSON`、无 `ON UPDATE`
- **SQLite 库**:同新 MySQL 库
- **三种状态业务代码必须兼容**(JSON 解析路径统一 + `ORDER BY ... , id` 兜底)

---

## 详细设计

### 模块 1:DB driver 抽象层

文件:`src/gateway/db.ts`(工厂,~60 行)、`src/gateway/db-mysql.ts`(~80 行)、`src/gateway/db-sqlite.ts`(~180 行)

**做什么**:按 `DATABASE_URL` 分发到 MySQL 或 SQLite,对外暴露统一的 `query` / `execute` / `getConnection` 接口,让 30+ 个文件的业务代码(共 ~386 处 `db.query` 调用)零改动继续工作。

#### 1.1 统一接口(`db.ts`)

```ts
export interface Db {
  /**
   * 返回形状严格对齐 mysql2:
   *   SELECT → [rows: T[], fields: undefined]
   *   INSERT/UPDATE/DELETE → [result: { affectedRows, insertId? }, undefined]
   *
   * 调用方可以统一用 `const [rows] = await db.query(...)`;
   * DML 场景 rows 其实是单个 OkPacket 形状的对象,读 rows.affectedRows。
   */
  query<T = any>(sql: string, params?: any[]): Promise<[T, unknown]>;
  /** 便捷方法:只关心 affectedRows/insertId 的场景 */
  execute(sql: string, params?: any[]): Promise<{ affectedRows: number; insertId?: string | number }>;
  /** 事务:手动模式,与现有 4 处调用对齐 */
  getConnection(): Promise<Conn>;
  readonly driver: "mysql" | "sqlite";
}

export interface Conn {
  query<T = any>(sql: string, params?: any[]): Promise<[T, unknown]>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

export function initDb(url: string): Db { /* URL 协议头分发 */ }
export function getDb(): Db { /* 单例 */ }
export async function closeDb(): Promise<void> { /* 清理 */ }
```

**DML 返回形状的关键决策**:mysql2 的 `db.query` 对 DML 返回 `[OkPacket, undefined]`,`OkPacket.affectedRows` 在第一个元素上。现有代码 `const [result] = ...; if (result.affectedRows === 0)` 依赖这个形状(`host-api.ts:124-126` 等)。SQLite driver 必须把 `stmt.run()` 的返回包装成 `{ affectedRows: changes, insertId: lastInsertRowid }` 放在元组第一位,与 mysql2 完全对齐。

**SQL 前缀判断 DML**:在 `query()` 里判断 `sql.trimStart().toUpperCase().startsWith("INSERT"|"UPDATE"|"DELETE"|"REPLACE"|"CREATE"|"DROP"|"ALTER"|"PRAGMA")` 来决定返回形状。对 DDL 和 PRAGMA 走 "DML" 路径(不返回行)。

#### 1.2 MySQL driver(`db-mysql.ts`)

薄包装 `mysql2/promise`:
- 直接持有 `mysql.Pool`,`query()` 转发到 `pool.query(...)`
- `getConnection()` 转发到 `pool.getConnection()`,返回的 `PoolConnection` 包装成 `Conn`
- `beginTransaction/commit/rollback` 直接调底层方法

#### 1.3 SQLite driver(`db-sqlite.ts`)

包装 Node 22+ 内置的 `node:sqlite`(而非 `better-sqlite3`,见决策记录 #2):

```ts
import { DatabaseSync } from "node:sqlite";
import { AsyncMutex } from "./async-mutex.js";  // 轻量 mutex,防止事务嵌套

class SqliteDb implements Db {
  readonly driver = "sqlite" as const;
  private readonly raw: DatabaseSync;
  private readonly mutex = new AsyncMutex();

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL");
    this.raw.exec("PRAGMA foreign_keys = ON");
    this.raw.exec("PRAGMA busy_timeout = 5000");
    this.raw.exec("PRAGMA synchronous = NORMAL");  // WAL 下足够安全
  }

  async query(sql, params = []) {
    // 预处理:清理 MySQL 特有语法残留
    const cleaned = preprocessSql(sql);
    const stmt = this.raw.prepare(cleaned);
    const kind = sqlKind(cleaned);  // "select" | "dml" | "ddl"
    if (kind === "select") {
      return [stmt.all(...params), undefined];
    }
    const r = stmt.run(...params);
    return [{ affectedRows: r.changes, insertId: r.lastInsertRowid }, undefined];
  }

  async execute(sql, params = []) {
    const [r] = await this.query(sql, params);
    return r;
  }

  async getConnection(): Promise<Conn> {
    await this.mutex.acquire();   // 排他化事务,避免 BEGIN 嵌套
    return new SqliteConn(this.raw, () => this.mutex.release());
  }
}
```

**SQL 预处理**`preprocessSql(sql)`—— 作为**防御层**(业务代码会尽量清理,但预处理兜底):
- `CURRENT_TIMESTAMP(3)` → `CURRENT_TIMESTAMP`
- `NOW(3)` → `CURRENT_TIMESTAMP`(注意:不处理 `NOW()`,后者会在应用层改造中移除)

#### 1.4 事务语义(重要)

**现状**:现有代码有 4 处手动事务(`agent-api.ts:240`、`skill-import.ts:168`、`siclaw-api.ts:2472`、`siclaw-api.ts:2539`),全部是手动 `beginTransaction → query... → commit/rollback → release` 模式。

**SQLite 侧实现**:
- `node:sqlite` 是同步单连接,**不能**让两个事务同时持有 BEGIN
- `getConnection()` 通过 `AsyncMutex` 排他化整个事务块,同一时刻只有一个 Conn 活跃
- 每个 Conn 的 `beginTransaction/commit/rollback` 直接 `db.exec("BEGIN|COMMIT|ROLLBACK")`,`release()` 释放 mutex
- `busy_timeout = 5000` 进一步缓解短暂竞争

**为什么这在 local 模式下够用**:LocalSpawner 的 AgentBox 写入全部通过 Runtime → Portal 的 WS 串行化,事务实际串行发生;mutex 等待时间极短。

**`FOR UPDATE` 在 SQLite 下怎么办**:`siclaw-api.ts:2478` 的唯一使用点改成 "事务内 `SELECT COALESCE(MAX(version), 0) + 1`"(已在模块 4 列出),不再需要行锁。论据:SQLite 在事务内默认 serializable 隔离,BEGIN IMMEDIATE 后其他写事务排队,语义等同。

#### 1.5 关键决策

- **不用 better-sqlite3**:项目 `src/memory/` 已经用 `node:sqlite`(见 CLAUDE.md §Two Separate Databases),避免两套 SQLite 绑定并存;零编译依赖(better-sqlite3 的 prebuild 在 Alpine/某些 ARM 平台可能失败)
- **Node 22 的 `node:sqlite` experimental flag**:项目 `engines` 已 `>=22.12.0`,`siclaw.mjs` 已有 `ExperimentalWarning` 抑制逻辑;需在其中补充 `--experimental-sqlite` flag 重新执行子进程或使用 `process.execArgv` 策略(与现有 ExperimentalWarning 抑制共享入口)。Node 24+ 已转正,长期无问题
- **不用 sql.js**:老方案选择,WASM 纯 JS 内存数据库,每次写都要手动 export 整个文件,性能差,不适合 Portal 持续写入负载
- **不引入 Drizzle/kysely**:30+ 个文件的 raw SQL 全重写不成比例

**影响范围**:
- 新建 `src/gateway/db.ts`(重写)、`src/gateway/db-mysql.ts`、`src/gateway/db-sqlite.ts`、`src/gateway/async-mutex.ts`(~15 行)
- `package.json`:**不新增依赖**(`node:sqlite` 内置;`mysql2` 已有)
- `siclaw.mjs`:补 `--experimental-sqlite` flag 的处理(spawn 子进程或 process.execArgv)
- 业务代码:**零改动**(`await db.query(sql, params)` 形状完全对齐 mysql2)

---

### 模块 2:Schema 一份化

文件:`src/portal/migrate.ts`(改写,~600 行)、`src/portal/migrate-compat.ts`(新增,~200 行)

**做什么**:把现在 MySQL 方言的 DDL 清洗成 SQLite + MySQL 都能跑的"最大公约数",放弃毫秒精度时间戳、`ON UPDATE CURRENT_TIMESTAMP`、原生 `JSON` 列、`ENGINE=InnoDB`、`COLLATE` 声明。

**A. 逐表改写规则**:
| 旧(MySQL only) | 新(两边通用) |
|---|---|
| `TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)` | `TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP` |
| `TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)` | `TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`(ON UPDATE 移除,应用层管) |
| `TIMESTAMP(3) NULL DEFAULT NULL` | `TIMESTAMP NULL DEFAULT NULL` |
| `JSON` / `JSON DEFAULT NULL` | `TEXT` / `TEXT DEFAULT NULL` |
| `) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci` | `)` |
| 行内 `INDEX idx_xxx (col)` | 拆出来走 `ensureIndex()` helper |
| 保留原样 | `CHAR(36)`, `VARCHAR(N)`, `TEXT`, `MEDIUMTEXT`, `LONGTEXT`, `LONGBLOB`, `TINYINT(1)`, `INT`, `PRIMARY KEY`, `UNIQUE KEY`, `FOREIGN KEY ... ON DELETE CASCADE` |

**B. 索引管理(`ensureIndex` helper)**:

MySQL 8.0.28 之前**不支持** `CREATE INDEX IF NOT EXISTS`,所以不能简单写成一条 SQL 两边跑。走 helper 分发:

```ts
// migrate-compat.ts
export async function ensureIndex(
  db: Db,
  table: string,
  name: string,
  columns: string,  // e.g. "user_id, created_at"
): Promise<void> {
  if (db.driver === "mysql") {
    const [rows] = await db.query(
      `SELECT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
      [table, name],
    );
    if ((rows as any[]).length > 0) return;
    await db.query(`CREATE INDEX \`${name}\` ON \`${table}\` (${columns})`);
  } else {
    await db.query(`CREATE INDEX IF NOT EXISTS \`${name}\` ON \`${table}\` (${columns})`);
  }
}
```

**索引名严格沿用现有名字**(老 MySQL 库已有):
`idx_chat_messages_session`、`idx_chat_messages_audit`、`idx_chat_sessions_user`、`idx_chat_sessions_agent`、`idx_chat_sessions_origin`、`idx_notifications_user`、`idx_api_keys_hash`、`idx_agent_task_runs_task`、`idx_agent_task_runs_session`、`idx_channel_bindings_agent`、`idx_kpe_created`、`idx_kpe_repo`、`idx_skills_overlay`、`idx_skills_org_name`(共 14 个)

**C. `safeAlterTable` 双实现**:

```ts
// migrate-compat.ts
export async function columnExists(db: Db, table: string, column: string): Promise<boolean> {
  if (db.driver === "mysql") {
    const [rows] = await db.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column],
    );
    return (rows as any[]).length > 0;
  }
  const [rows] = await db.query(`PRAGMA table_info(\`${table}\`)`);
  return (rows as any[]).some((r: any) => r.name === column);
}

export async function safeAlterTable(
  db: Db, table: string, column: string, definition: string,
): Promise<void> {
  if (await columnExists(db, table, column)) return;
  try {
    await db.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  } catch (err) {
    // 竞态下可能重复,swallow duplicate 错误
    if (isDuplicateColumnError(err)) return;
    throw err;
  }
}
```

**D. UNIQUE KEY 降级(skills.uq_skills_org_name → idx_skills_org_name)**:

现有 `migrate.ts:520-550` 有对老 MySQL 库的唯一键降级逻辑(overlay 需要同名 skill),走 MySQL 的 `SHOW INDEX` 和 `DROP INDEX`。SQLite 不存在这个历史问题(首次建库直接用新 schema),只在 MySQL 分支走这段逻辑,SQLite 分支直接 skip。

**E. DDL 中的 `UNIQUE KEY uq_xxx (col_a, col_b)` 保留原样** — SQLite 接受 `UNIQUE KEY` 作为约束(会创建匿名唯一索引);但为了索引名可控,建议把 `CREATE TABLE` 里的 `UNIQUE KEY uq_xxx (a, b)` 改成 `UNIQUE (a, b)` 匿名约束 + 单独 `CREATE UNIQUE INDEX uq_xxx ON ...`,两边行为一致。

**关键决策**:
- **`MEDIUMTEXT` / `LONGTEXT` / `LONGBLOB` 保留原样**,SQLite 类型亲和性容忍(归 TEXT/BLOB),不报错
- **`TINYINT(1)` 保留原样**,SQLite 接受任何类型名
- **`CHAR(36)` / `VARCHAR(N)` 保留原样**
- **FOREIGN KEY 的 `ON DELETE CASCADE` 保留**,SQLite 启动时 `PRAGMA foreign_keys = ON` 激活
- **放弃 `FULLTEXT INDEX`**:当前 schema 没用到

**影响范围**:
- `src/portal/migrate.ts` 改写约 600 行
- 新增 `src/portal/migrate-compat.ts` 约 200 行(ensureIndex、columnExists、safeAlterTable、indexExists、isDuplicateColumnError 双 driver 实现)

---

### 模块 3:方言 helper(`src/gateway/dialect-helpers.ts`)

**做什么**:收掉 3 处不可避免的 SQL 方言差异(`lockForUpdate` 已因唯一调用点改造而删除;日期函数改为应用层,不走 helper)。

```ts
import type { Db } from "./db.js";

/** 是否唯一约束冲突 */
export function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if ((err as any).errno === 1062) return true;           // MySQL ER_DUP_ENTRY
  if ((err as any).cause?.errno === 1062) return true;    // mysql2 可能包裹在 .cause
  if (err.message?.includes("Duplicate entry")) return true;
  if (err.message?.includes("UNIQUE constraint failed")) return true;  // SQLite
  return false;
}

/**
 * INSERT ... ON CONFLICT DO UPDATE,支持 SET 子句用 VALUES 复制或自定义表达式。
 *
 * @param updateColumns 两种形式:
 *   - "col_name" 字符串 → 冲突时复制 excluded.col_name(SQLite)/ VALUES(col_name)(MySQL)
 *   - { col: "last_active_at", expr: "CURRENT_TIMESTAMP" } → 冲突时用表达式
 */
export function buildUpsert(
  db: Db,
  table: string,
  columns: string[],
  values: any[],
  conflictColumns: string[],
  updateColumns: Array<string | { col: string; expr: string }>,
): { sql: string; params: any[] } {
  const cols = columns.map(c => `\`${c}\``).join(", ");
  const placeholders = columns.map(() => "?").join(", ");
  const renderUpdateMysql = (u: string | { col: string; expr: string }) =>
    typeof u === "string" ? `\`${u}\` = VALUES(\`${u}\`)` : `\`${u.col}\` = ${u.expr}`;
  const renderUpdateSqlite = (u: string | { col: string; expr: string }) =>
    typeof u === "string" ? `\`${u}\` = excluded.\`${u}\`` : `\`${u.col}\` = ${u.expr}`;

  if (db.driver === "mysql") {
    const updates = updateColumns.map(renderUpdateMysql).join(", ");
    return {
      sql: `INSERT INTO \`${table}\` (${cols}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updates}`,
      params: values,
    };
  }
  const conflictCols = conflictColumns.map(c => `\`${c}\``).join(", ");
  const updates = updateColumns.map(renderUpdateSqlite).join(", ");
  return {
    sql: `INSERT INTO \`${table}\` (${cols}) VALUES (${placeholders}) ON CONFLICT(${conflictCols}) DO UPDATE SET ${updates}`,
    params: values,
  };
}

/** INSERT IGNORE(SQLite 是 INSERT OR IGNORE) */
export function insertIgnorePrefix(db: Db): string {
  return db.driver === "mysql" ? "INSERT IGNORE" : "INSERT OR IGNORE";
}

/** JSON 数组包含检查 */
export function jsonArrayContains(db: Db, column: string, paramPlaceholder = "?"): string {
  if (db.driver === "mysql") {
    return `JSON_CONTAINS(${column}, ${paramPlaceholder})`;
  }
  return `EXISTS (SELECT 1 FROM json_each(${column}) WHERE value = ${paramPlaceholder})`;
}

/** JSON 数组拉平取 distinct 值 */
export function jsonArrayFlattenSql(
  db: Db, table: string, jsonColumn: string,
): { joinClause: string; valueColumn: string } {
  if (db.driver === "mysql") {
    return {
      joinClause: `${table}, JSON_TABLE(${jsonColumn}, '$[*]' COLUMNS(label VARCHAR(255) PATH '$')) AS jt`,
      valueColumn: "jt.label",
    };
  }
  return {
    joinClause: `${table}, json_each(${jsonColumn}) AS je`,
    valueColumn: "je.value",
  };
}

/**
 * JSON 列读取路径统一 — 老 MySQL 库 JSON 列 mysql2 pre-parse 成 object;
 * 新 MySQL 库 TEXT 列 / SQLite TEXT 列返回 string。统一转回 object。
 */
export function safeParseJson<T = unknown>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return value as T;
}
```

**15 个 JSON 列的读取路径必须统一用 `safeParseJson`**(否则老 MySQL 库升级后会崩):
- `skills.labels`、`skills.scripts`
- `skill_versions.specs`、`skill_versions.scripts`、`skill_versions.diff`、`skill_versions.labels`
- `skill_reviews.diff`、`skill_reviews.security_assessment`
- `mcp_servers.args`、`mcp_servers.env`、`mcp_servers.headers`
- `chat_messages.metadata`
- `channels.config`
- `agent_diagnostics.params`
- `skill_import_history.added` / `.updated` / `.deleted`
- `knowledge_publish_events.snapshot_before` / `.snapshot_after`

**影响范围**:
- 新文件 `src/gateway/dialect-helpers.ts` 约 120 行
- 调用方改动:
  - `src/portal/siclaw-api.ts:128` — JSON_TABLE 改 `jsonArrayFlattenSql`
  - `src/portal/siclaw-api.ts:160` — JSON_CONTAINS 改 `jsonArrayContains`
  - `src/portal/siclaw-api.ts:2385` — 1 处 ON DUPLICATE → `buildUpsert`
  - `src/portal/siclaw-api.ts:2478` — FOR UPDATE 改成事务内 `SELECT MAX(version)+1`
  - `src/portal/adapter.ts:539, 1063, 1114, 1584, 1799, 2054` — 6 处 ON DUPLICATE,**其中 539 和 1799 用 `{ col: "last_active_at", expr: "CURRENT_TIMESTAMP" }` 形式**
  - `src/portal/agent-api.ts:106` — 1 处 INSERT IGNORE → `insertIgnorePrefix`
- JSON 读取防御:15 个列 × 各自的读取 API,需 grep 逐个确认

---

### 模块 4:应用层改造(updated_at / 日期函数 / JSON 读取 / ORDER BY)

**改造面总览**(汇总所有"机械改动",共 ~110 处、10+ 文件):

| 类别 | 位置数 | 改法 |
|------|------|------|
| UPDATE 补 `updated_at = CURRENT_TIMESTAMP` | ~25 处 | setClauses push 或静态追加 |
| `CURRENT_TIMESTAMP(3)` / `NOW(3)` → `CURRENT_TIMESTAMP` | ~50 处 | 全局替换,两边都认 |
| MySQL 日期函数 9 处 | 9 处 | **JS 算好 ISO 字符串传参**(彻底脱离 DB 方言) |
| JSON 列读取点 | ~15 处 | 用 `safeParseJson()` 包装 |
| `ORDER BY created_at` 补 `, id` 兜底 | ~30 处(grep 确认) | 在 MILESTONE 里逐个审查 |

#### 4.1 `updated_at` 改造清单

10 张带 `updated_at` 的表(按 `ON UPDATE` 出现位置):
`agents` / `clusters` / `hosts` / `agent_tasks` / `channels` / `mcp_servers` / `skills` / `model_providers` / `agent_diagnostics` / `system_config`

**需改写的 UPDATE 清单**(25 处):

| 文件:行 | 表 | 改法 |
|---|---|---|
| `agent-api.ts:166` | `agents` | setClauses push `"updated_at = CURRENT_TIMESTAMP"` |
| `channel-api.ts:108` | `channels` | 同上 |
| `cluster-api.ts:121` | `clusters` | 同上 |
| `host-api.ts:123` | `hosts` | 同上 |
| `adapter.ts:599, 782, 883, 927, 1896, 1931, 1961, 1993` | `agent_tasks` | 每条补 `, updated_at = CURRENT_TIMESTAMP` |
| `siclaw-api.ts:1445` | `agent_tasks` | setClauses push |
| `siclaw-api.ts:1090, 1157` | `mcp_servers` | 补 |
| `siclaw-api.ts:365, 381, 553, 622, 683, 690, 735, 873` | `skills` | 补 |
| `siclaw-api.ts:1833` | `agent_diagnostics` | 补 |
| `siclaw-api.ts:1947` | `model_providers` | 补 |
| `skill-import.ts:200` | `skills` | **已手动 set**,只改精度 |
| `adapter.ts:1114, 1584` | `system_config`(upsert) | 走 `buildUpsert`,updateColumns 包含 `updated_at` 表达式形式 |

**验收测试**(防止漏改):写一个 schema-invariant 测试,grep 所有 `UPDATE <table_with_updated_at>` 语句,断言每条都包含 `updated_at` 字符串。详情见模块 6。

#### 4.2 日期函数 → 应用层

9 处 `NOW()` / `DATE_SUB` / `CURDATE` 全部改为 JS 算好 ISO 字符串传参:

| 文件:行 | 现状 | 改法 |
|---|---|---|
| `adapter.ts:944, 948, 1050, 2004, 2008, 2042` | `NOW() - INTERVAL ? DAY` / `expires_at > NOW()` 等 | JS 侧:`const cutoff = new Date(Date.now() - days * 86400e3).toISOString();` 传参 |
| `siclaw-api.ts:1737` | `expires_at < NOW()` | 同上 |
| `siclaw-api.ts:2093` | `DATE_SUB(NOW(), INTERVAL 24 HOUR)` | 同上 |
| `siclaw-api.ts:2124, 2133` | `DATE_SUB(CURDATE(), INTERVAL ? DAY)` | 同上 |

**理由**:这 9 处 SQL 写在纯方言上,改 helper 仍然要双分支;改 JS 算完传参后,DB 只做值比较,彻底通用;可读性也更好。

#### 4.3 JSON 读取路径 → `safeParseJson`

15 个 JSON 列的 **所有读取侧** 调用点都要走 `safeParseJson(row.col, fallback)`:
- grep 每个列名的所有 SELECT 后处理位置
- 现有代码有些已经在做 `typeof x === "string" ? JSON.parse(x) : x`(如 `siclaw-api.ts:342, 344` 等 11 处),统一替换成 `safeParseJson`
- 没做判断直接用的(如 `row.labels.map(...)`)要补上

**MILESTONE 里一项专门工作**:逐列 grep、逐处修补。

#### 4.4 ORDER BY 兜底

约 30 处 `ORDER BY created_at`(MILESTONE 阶段 grep 精确列表)需要追加 `, id`:老 MySQL 库毫秒精度 + 新库秒精度混存,同秒多条排序需要 id 兜底。

---

### 模块 5:单进程入口 + bootstrap 重构

**做什么**:把 `portal-main.ts` 和 `gateway-main.ts` 的"装配 + shutdown"逻辑抽成可 export 的 `bootstrapPortal(config)` / `bootstrapRuntime(config)`,三个入口(`portal-main` / `gateway-main` / `cli-local`)都只做 "读 env + 调 bootstrap + 注册 signal handler"。

#### 5.1 新的文件结构

```
src/lib/bootstrap-portal.ts     // 新:Portal 的装配逻辑(DB init、migration、startPortal、builtin skills/knowledge)
src/lib/bootstrap-runtime.ts    // 新:Runtime 的装配逻辑(spawner、agentBoxManager、frontendClient、taskCoordinator)

src/portal-main.ts              // 改:只读 env → await bootstrapPortal(config) → signal handler
src/gateway-main.ts             // 改:只读 env → await bootstrapRuntime(config) → signal handler
src/cli-local.ts                // 新:本地 secrets → await bootstrapPortal → await waitForListen → await bootstrapRuntime
```

#### 5.2 `cli-local.ts` 骨架

```ts
import { bootstrapPortal } from "./lib/bootstrap-portal.js";
import { bootstrapRuntime } from "./lib/bootstrap-runtime.js";
import { loadOrGenerateLocalSecrets } from "./cli-setup.js";  // 扩展现有
import { waitForListen } from "./lib/server-helpers.js";

const PORTAL_PORT = parseInt(process.env.PORTAL_PORT || "3000", 10);
const RUNTIME_PORT = parseInt(process.env.SICLAW_PORT || "3001", 10);
const INTERNAL_PORT = parseInt(process.env.SICLAW_INTERNAL_PORT || "3002", 10);
const DATABASE_URL = process.env.DATABASE_URL || "sqlite:./.siclaw/data/portal.db";

const secrets = loadOrGenerateLocalSecrets(".siclaw/local-secrets.json");

// Phase 1: Portal(DB + migrations + HTTP)
const portalHandle = await bootstrapPortal({
  port: PORTAL_PORT,
  databaseUrl: DATABASE_URL,
  jwtSecret: secrets.jwtSecret,
  runtimeUrl: `http://127.0.0.1:${RUNTIME_PORT}`,
  runtimeWsUrl: `ws://127.0.0.1:${RUNTIME_PORT}/ws`,
  runtimeSecret: secrets.runtimeSecret,
  portalSecret: secrets.portalSecret,
});
await waitForListen(portalHandle.server);   // 关键:避免 Runtime WS 先连
console.log(`[local] Portal: http://localhost:${PORTAL_PORT}`);

// Phase 2: Runtime(in-process)
const runtimeHandle = await bootstrapRuntime({
  spawnerType: "local",
  config: {
    port: RUNTIME_PORT,
    internalPort: INTERNAL_PORT,
    host: "127.0.0.1",
    runtimeSecret: secrets.runtimeSecret,
    serverUrl: `http://127.0.0.1:${PORTAL_PORT}`,
    portalSecret: secrets.portalSecret,
    jwtSecret: secrets.jwtSecret,
  },
});
console.log(`[local] Runtime: http://localhost:${RUNTIME_PORT}`);
console.log(`[local] DB: ${DATABASE_URL}`);

async function shutdown() {
  console.log("\n[local] Shutting down...");
  await runtimeHandle.close();
  await portalHandle.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
```

#### 5.3 `waitForListen` 实现

```ts
// src/lib/server-helpers.ts
export function waitForListen(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (server.listening) return resolve();
    server.once("listening", resolve);
    server.once("error", reject);
  });
}
```

**注意**:`portal/server.ts` 的 `startPortal()` 内部已经有 `server.listen(config.port, () => {...})`,但 callback 执行是异步的,返回的 `server` 不一定 listening。`bootstrapPortal` 内部用 `waitForListen` 等待。

#### 5.4 `siclaw.mjs` 路由修改

```js
if (subcommand === "local") {
  process.argv.splice(2, 1);
  await import("./dist/cli-local.js");     // 改:原来 import gateway-main
} else {
  await import("./dist/cli-main.js");
}
```

**`node:sqlite` experimental flag 处理**:
- `siclaw.mjs` 在启动时检查 Node 版本,若 < 24 且没有 `--experimental-sqlite`,用 `process.execArgv` 辅助或 spawn 子进程
- 最小实现:在 `siclaw.mjs` 头部,若 `process.execArgv` 不含 `--experimental-sqlite`,重新 spawn `node --experimental-sqlite <this-script> <args>` 并继承 stdio

#### 5.5 本地秘钥自动管理(`loadOrGenerateLocalSecrets`)

- 首次启动:生成随机 jwtSecret / runtimeSecret / portalSecret,写入 `.siclaw/local-secrets.json`(0600 权限)
- 后续启动:读取已有秘钥
- 避免零配置启动被 `JWT_SECRET required` 错误打断

**关键决策**:
- **Portal 先启,Runtime 后启,且 `waitForListen` 同步等待**(避免 Reviewer B 指出的 race)
- **各自独立监听一个端口**(3000 / 3001 / 3002)— 与生产拓扑等价,便于调试
- **LocalSpawner 继续 in-process**,符合 CLAUDE.md §Local Mode invariant
- **`portal-main.ts` 和 `gateway-main.ts` 继续存在**但瘦身,prod K8s 入口不受影响

**影响范围**:
- 新文件 `src/lib/bootstrap-portal.ts` 约 80 行(抄自 portal-main.ts 的 wiring 逻辑并封装)
- 新文件 `src/lib/bootstrap-runtime.ts` 约 150 行(抄自 gateway-main.ts 的 wiring 逻辑并封装)
- 新文件 `src/lib/server-helpers.ts` 约 15 行
- 新文件 `src/cli-local.ts` 约 80 行
- 改写 `src/portal-main.ts` 约 30 行(瘦到只读 env + bootstrap + signal)
- 改写 `src/gateway-main.ts` 约 30 行(同上)
- `siclaw.mjs` 改路由 + experimental-sqlite flag 处理 ~20 行
- 扩展 `src/cli-setup.ts`(已有)添加 `loadOrGenerateLocalSecrets()` ~40 行

---

### 模块 6:测试

**做什么**:验证 MySQL 和 SQLite 行为一致,并防止 `updated_at` / JSON / ORDER BY 机械改造漏改。

**测试项(精简后 ~250 行)**:
1. **`src/gateway/db.test.ts`**(重写,~150 行):
   - MySQL mock 路径(现有逻辑保留)
   - SQLite `:memory:` 路径:建表、增删改查、事务 commit/rollback、mutex 并发保护、`safeParseJson` 覆盖、DML 返回形状与 mysql2 对齐验证
2. **`src/gateway/dialect-helpers.test.ts`**(~60 行):
   - `buildUpsert`(含表达式 form)、`insertIgnorePrefix`、`jsonArrayContains`、`jsonArrayFlattenSql`、`safeParseJson` 各 5-10 个 case
3. **`src/portal/migrate-sqlite.test.ts`**(~70 行):
   - `:memory:` 跑完整 migration
   - 断言 27 张表 + 14 个索引都存在(`PRAGMA table_info` + `PRAGMA index_list`)
   - 再跑一次验证幂等
4. **`src/portal/schema-invariants.test.ts`**(新,~50 行):
   - 读取 `src/portal/migrate.ts`、`src/portal/adapter.ts`、`src/portal/*-api.ts`、`src/portal/skill-import.ts` 的源码
   - 用正则 grep 所有 `UPDATE <table>` 语句,对于 10 张 "ON UPDATE" 表,断言每条都包含 `updated_at = CURRENT_TIMESTAMP`(或已经用 buildUpsert 处理 system_config 的情形)
   - 防止漏改,是对 Reviewer B "拦截器方案" 批评的回应
5. 现有 adapter.test.ts / siclaw-api.*.test.ts **保持不变**(通过 mock `db.query` 测试,无需真实 driver)

**砍掉**(相比 v1 草稿):
- 独立的 `db-sqlite.test.ts` → 并入 `db.test.ts`
- `test/integration/local-mode.test.ts` → 推迟到后续 PR

---

## 接口与数据结构

### DATABASE_URL 协议

| URL | Driver | 说明 |
|---|---|---|
| `mysql://user:pass@host:3306/siclaw` | mysql2 | 生产 K8s 默认 |
| `sqlite:///absolute/path.db` | node:sqlite | 绝对路径 |
| `sqlite://./relative/path.db` | node:sqlite | 相对路径(相对 cwd) |
| `sqlite::memory:` | node:sqlite | 内存库,测试用 |
| `file:/path/to/db` | node:sqlite | sqlite: 的别名 |
| (未设置)| — | `cli-local.ts` 默认 `sqlite:./.siclaw/data/portal.db`;其他 entry 报错 |

### Db 接口(对 30+ 业务文件保持兼容)

```ts
export interface Db {
  /** 形状对齐 mysql2:SELECT → [rows, undefined];DML → [OkPacket, undefined] */
  query<T = any>(sql: string, params?: any[]): Promise<[T, unknown]>;
  execute(sql: string, params?: any[]): Promise<{ affectedRows: number; insertId?: string | number }>;
  getConnection(): Promise<Conn>;
  readonly driver: "mysql" | "sqlite";
}
```

---

## 风险与边界情况

### 风险 1:`node:sqlite` experimental flag(Node 22)

- Node 22 需要 `--experimental-sqlite`;Node 24+ 转正
- 缓解:`siclaw.mjs` 启动时检测并处理(若缺失则重 spawn 子进程带 flag)
- prod K8s Dockerfile 升到 Node 24 后此问题消失

### 风险 2:SQLite 并发写入

- SQLite 单写者锁(WAL 模式下 reader 不阻塞,但 writer 串行化)
- 缓解:WAL + `busy_timeout = 5000` + 事务排他 mutex;local 模式写入本身已被 RPC 串行化,实际不高并发

### 风险 3:三种数据状态的时间戳差异

- 老 MySQL 库毫秒精度 + 新库秒精度混存
- chat_messages 同秒多条需要 `ORDER BY created_at, id` 兜底
- MILESTONE 阶段 grep 30 处并全部补齐

### 风险 4:index 名冲突

- 索引名严格沿用老 MySQL 库里的名字(14 个 `idx_*`)
- `ensureIndex` helper 走 `information_schema` 查存在性,幂等
- 缓解:MILESTONE 里有一步"verify-index-parity",对照老 MySQL 库跑一次 `SHOW INDEX`

### 风险 5:SQLite SQL 语义差异

| 差异 | 影响 | 缓解 |
|---|---|---|
| 字符串 LIKE 默认区分大小写 | `WHERE name LIKE ?` 命中率可能差 | 不处理,local 单用户影响小 |
| `COUNT(*) AS c` 类型(bigint vs number) | `Number(rows[0].c)` | 已在做 |
| `CAST(x AS INTEGER)` | 两边都支持 | 无影响 |

### 风险 6:CLAUDE.md invariants 检查

- 🔴 Local Mode: Shared Filesystem — **不破坏**,本次不引入 `materialize()` 新调用
- 🔴 Two Separate Databases — **需要更新文档**,把 "sql.js (WASM)" 改成 "MySQL (prod) / SQLite (local via node:sqlite)"
- 🔴 Skill Bundle Contract / Shell Security / mTLS Scope — **不影响**

### 风险 7:JSON 列双重解析(Reviewer A 指出)

- 老 MySQL 库表结构仍是 `JSON` 列 → mysql2 **pre-parse 成 object** 返回
- 新 MySQL 库表结构是 `TEXT` / SQLite 也是 `TEXT` → 返回 **string**
- 三种数据状态共存,读取路径必须用 `safeParseJson()` 统一
- 漏一处就是 prod 升级直接崩
- 缓解:15 个 JSON 列全部 grep 审查,并用 schema-invariants.test.ts 兜底

### 风险 8:startPortal 的 listen race(Reviewer B 指出)

- Node `http.createServer()` 返回时 server 还没 listen
- local 模式下 Runtime `frontendClient.connect()` 会先打来,引发 ECONNREFUSED + 重连日志
- 缓解:`waitForListen()` 在 `bootstrapPortal` 内部同步等待

### 风险 9:重复索引(老 MySQL 库)

- 如果老 MySQL 库里有匿名索引与新 schema 的命名索引覆盖相同列
- `ensureIndex` 查 `information_schema.STATISTICS` 只匹配 INDEX_NAME,不比较列
- 缓解:MILESTONE 里加 "verify-index-parity" 步骤,对一个生产库快照跑 `SHOW INDEX`,手工 diff 14 个索引名

---

## 预估

- **改动文件数**:~25 个
- **改动行数**:~2000-2500 行
  - 新增:`db.ts`(~60)+ `db-mysql.ts`(~80)+ `db-sqlite.ts`(~180)+ `async-mutex.ts`(~15)+ `dialect-helpers.ts`(~120)+ `migrate-compat.ts`(~200)+ `bootstrap-portal.ts`(~80)+ `bootstrap-runtime.ts`(~150)+ `server-helpers.ts`(~15)+ `cli-local.ts`(~80)+ `loadOrGenerateLocalSecrets`(~40)+ 测试(~280)= **~1300 行新增**
  - 重写:`migrate.ts`(~600 行改写)
  - 小改:25 处 UPDATE、9 处日期函数、10 处 dialect(ON DUPLICATE/INSERT IGNORE/JSON 函数)、15 处 JSON 读取、30 处 ORDER BY、50 处 `CURRENT_TIMESTAMP(3)` 清理 ≈ **~150 处机械修改,约 400 行**
  - `portal-main.ts` / `gateway-main.ts` 瘦身 ~-100 行
  - 文档:CLAUDE.md §Two Separate Databases、README §tech stack 小幅更新
- **执行模式**:**subagent 执行**(> 1000 行,按 /dev 规则)
- **依赖新增**:**无**(`node:sqlite` 内置,`mysql2` 已有)
- **破坏性变更**:无(`CREATE TABLE IF NOT EXISTS` 保护老库)

---

## 决策记录

| # | 问题 | 决策 | 理由 |
|---|------|------|------|
| 1 | local 模式部署形态 | (a) 单进程 Runtime + Portal + SQLite,零外部依赖 | 兑现 README 承诺;LocalSpawner 本来就 in-process |
| 2 | SQLite 实现 | **`node:sqlite`**(Node 22+ 内置,Node 24 转正) | 项目 memory DB 已用 node:sqlite,统一 binding;零编译依赖;避免 better-sqlite3 的 prebuild 失败面 |
| 3 | MySQL vs SQLite 共存 | (a) 二选一,`DATABASE_URL` 协议头分发 | 避免数据迁移工具和双写复杂度 |
| 4 | Schema 归一化 | 走法 1:一份 DDL 两边通用 | 接受秒精度、无 ON UPDATE、TEXT 代 JSON 三项取舍 |
| 5 | SQLite 文件路径 | 支持 `DATABASE_URL=sqlite:///path`;默认 `./.siclaw/data/portal.db` | 符合 README 约定 |
| 6 | 毫秒精度放弃 | 是 | `ORDER BY created_at, id` 兜底即可 |
| 7 | 要不要回到 Drizzle | 否 | 30+ 文件 raw SQL 全重写成本不成比例 |
| 8 | `username` 大小写敏感性统一 | 不做 | 除非后续需要 |
| 9 | Memory DB driver | 不动 | 本来就是 node:sqlite |
| 10 | TUI 模式 | 不变 | 不接 portal DB |
| 11 | DB 抽象:统一 Db 接口 vs 双栈 adapter | 统一 Db 接口,且拆成 `db.ts` + `db-mysql.ts` + `db-sqlite.ts` 三件套 | 业务 386 处 `db.query` 不能双分支污染;拆成三件套单文件体积可控、单测隔离 |
| 12 | 自动注入 `updated_at`(db.ts 拦截 UPDATE) | 否,手改 + schema-invariants.test 兜底 | 文本正则拦截对字面量 / 多行 / RETURNING 有风险;手改透明可见、可被 grep 测试守护 |
| 13 | 单端口合并(Portal + Runtime 共 httpServer) | 否 | mTLS proxy 必须独立端口;prod 拓扑等价;自递归路由风险 |
| 14 | MySQL 日期函数 helper vs 应用层计算 | 应用层计算 ISO 字符串传参 | 彻底脱离 DB 方言,DB 只做值比较;可读性更好 |
| 15 | `lockForUpdate` helper | 删除 | 唯一调用点(siclaw-api.ts:2478)已改成事务内 MAX+1 |
