# Siclaw Local 模式 + SQLite 支持 — 里程碑

> 基于 [DESIGN.md](./DESIGN.md) 生成
> 执行模式:**subagent**(预估 2000-2500 行,跨 ~25 文件)

---

## 约束清单

必须遵守的项目约束,从 `CLAUDE.md` + 项目现状提取:

- **🔴 Local Mode: Shared Filesystem** — LocalSpawner 所有 AgentBox 共享一个文件系统;`skillsHandler.materialize()` 在 local 模式不能调(会擦掉所有用户的 skills)。本次改造**不**引入新的 `materialize` 调用
- **🔴 Two Separate Databases** — Gateway/Portal DB(新增 SQLite driver)和 Memory DB(保持 node:sqlite,不动)完全独立,使用不同文件
- **🔴 Shell Security: Defense-in-Depth** — 不触碰 `src/tools/infra/command-sets.ts` 等安全相关
- **🔴 mTLS Scope** — mTLS 仅 K8s 模式,local 模式不引入 mTLS 依赖;Runtime 和 Portal loopback 通信走普通 HTTP/WS
- **🟡 ESM-only / named exports** — 不使用 default export
- **🟡 TS strict + .js 扩展名** — 所有内部 import 写 `.js`
- **🟡 DDL parity** — schema-sqlite 和 MySQL 用一份 DDL(本次的关键目标)
- **📋 双 tsconfig 类型检查** — agentbox tsconfig 有独立 include,每次都要跑 `npx tsc --noEmit` + `npx tsc -p tsconfig.agentbox.json --noEmit`(记忆 feedback_dual_tsconfig.md)
- **📋 所有写操作限用户路径**(用户的全局指令),不触碰 root 路径
- **📋 没有毫秒精度依赖** — 已放弃(决策 #6)

## 否决方案

设计阶段讨论过但被否决的方案,执行时**不要重新发明**:

| # | 方案 | 否决理由 |
|---|------|---------|
| 1 | 用 `better-sqlite3` | 项目 memory DB 已用 node:sqlite,避免两套 SQLite binding 并存;零编译依赖 |
| 2 | 用 `sql.js` (WASM) | 老方案选择,要手动 export 整个文件,性能差 |
| 3 | 用 Drizzle/kysely 替换 raw SQL | 30+ 文件重写,成本远超本次范围 |
| 4 | 两份 DDL 文件(`migrate-mysql.ts` + `migrate-sqlite.ts`) | 维护成本大,容易飘移 |
| 5 | 保留 `ON UPDATE CURRENT_TIMESTAMP` + 翻译层 | SQLite 不支持,无法统一;走"一份 DDL + 应用层管 updated_at" |
| 6 | 保留毫秒精度时间戳 `TIMESTAMP(3)` | SQLite 不认,且应用无硬依赖(已由决策 #6 确认) |
| 7 | 在 `db.ts` 自动拦截 UPDATE 注入 `updated_at` | SQL 文本正则拦截黑盒、对字面量/多行/RETURNING 有风险;改走手改 + schema-invariants 测试 |
| 8 | 单端口 Portal + Runtime 合并 | mTLS proxy 必须独立端口;prod 拓扑等价要求 |
| 9 | 日期函数写 `dateSubDays(db, n)` helper | 直接在 JS 算 ISO 字符串传参,彻底脱离 DB 方言 |
| 10 | 给 MySQL 写 `CREATE INDEX IF NOT EXISTS` | MySQL 8.0.28 之前语法不支持;走 `ensureIndex` helper 分发 |

---

## 步骤总览

| # | 名称 | 描述 | 依赖 | 预估文件数 |
|---|------|------|------|-----------|
| 1 | DB driver 抽象层 | 拆 `db.ts` 为三件套,实现 mysql / sqlite 两个 driver,统一 `Db` 接口 | 无 | 4 |
| 2 | 方言 helper + migrate 工具 | `dialect-helpers.ts`(含 safeParseJson)+ `migrate-compat.ts`(ensureIndex 等) | #1 | 2 |
| 3 | Schema 一份化 | 改写 `migrate.ts` 的 27 张表 DDL 和 14 个索引,移除 ON UPDATE / 时间戳精度 / JSON / ENGINE | #2 | 1 |
| 4 | 应用层改造(机械修改) | 25 处 UPDATE 补 updated_at + 9 处日期函数 + 10 处 dialect + 15 处 JSON 读 + 30 处 ORDER BY + 50 处时间戳清理 | #2, #3 | ~10 |
| 5 | Bootstrap 重构 + cli-local 入口 | 抽 `bootstrapPortal/Runtime`;新建 `cli-local.ts`;siclaw.mjs 路由;experimental-sqlite flag | #1 | 7 |
| 6 | 测试 + schema-invariants | db.test 扩展 + dialect-helpers.test + migrate-sqlite.test + schema-invariants.test | #3, #4 | 4 |
| 7 | 文档更新 | CLAUDE.md §Two Separate Databases、README §tech stack | 全部 | 2 |

**依赖关系**:1 → 2 → 3 → 4;1 → 5;3,4 → 6;全部 → 7

---

## 详细步骤

### 步骤 1:DB driver 抽象层

**目标**:30+ 个业务文件的 `await db.query(sql, params)` 调用完全不用改就能在 MySQL 或 SQLite 下跑;DML 返回形状与 mysql2 完全对齐(`[OkPacket, undefined]`);事务手动 API 可用。

**涉及文件**:
- `src/gateway/db.ts`(重写)
- `src/gateway/db-mysql.ts`(新增)
- `src/gateway/db-sqlite.ts`(新增)
- `src/gateway/async-mutex.ts`(新增)

**验收标准**:
- `initDb("mysql://...")` 返回 MySQL driver,`driver === "mysql"`
- `initDb("sqlite::memory:")` / `initDb("sqlite://./path.db")` / `initDb("file:/path.db")` 返回 SQLite driver,`driver === "sqlite"`
- SELECT 查询返回 `[rows: T[], undefined]`,DML 返回 `[{ affectedRows, insertId }, undefined]`
- SQLite driver 启动时自动执行 WAL / foreign_keys / busy_timeout / synchronous PRAGMA
- `getConnection()` 返回的 Conn 支持 `beginTransaction / commit / rollback / release`
- SQLite Conn 通过 mutex 排他化,第二个 `getConnection()` 在第一个 `release()` 前等待
- SQLite `query()` 对 `CURRENT_TIMESTAMP(3)` / `NOW(3)` 做文本预处理兜底(变成 `CURRENT_TIMESTAMP`)
- `npx tsc --noEmit` 通过

**对应设计章节**:DESIGN.md §模块 1

**执行上下文**:
- **代码锚点**:当前 `src/gateway/db.ts` 是 34 行的纯 mysql2 Pool 包装(`initDb` / `getDb` / `closeDb` 三个导出)。重写:保持这三个导出签名(返回 `Db` 接口而非 `mysql.Pool`),内部分发到 `db-mysql.ts` 或 `db-sqlite.ts`
- **关键接口**:`src/gateway/db-mysql.ts` 内用 `mysql.createPool({ uri })`,行为必须与现有 34 行的 `initDb()` 语义完全一致(含 keepalive)。`db-sqlite.ts` 用 `import { DatabaseSync } from "node:sqlite"`,构造时 `new DatabaseSync(path)`
- **URL 解析**:`sqlite://./path.db` → 相对 cwd 的 `./path.db`;`sqlite:///abs/path.db` → 绝对路径 `/abs/path.db`;`sqlite::memory:` → `:memory:`;`file:/path` 同 sqlite:
- **DML 判定**:`sql.trimStart().match(/^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA)\b/i)` 为真就走"return OkPacket 形状"路径
- **async-mutex**:最小实现,一个 `Promise<void>` 队列;`acquire()` 返回的 Promise 在前一个 `release()` 后 resolve

---

### 步骤 2:方言 helper + migrate 工具

**目标**:3 处运行时 SQL 方言差异 + 15 个 JSON 列的读取防御 + migration 索引/列存在性检查,统一到两个独立文件。

**涉及文件**:
- `src/gateway/dialect-helpers.ts`(新增)
- `src/portal/migrate-compat.ts`(新增)

**验收标准**:
- `dialect-helpers.ts` 导出:`isUniqueViolation`、`buildUpsert`(支持 string 和 `{col, expr}` 两种 updateColumns)、`insertIgnorePrefix`、`jsonArrayContains`、`jsonArrayFlattenSql`、`safeParseJson`
- `buildUpsert` 对 MySQL 生成 `ON DUPLICATE KEY UPDATE`,对 SQLite 生成 `ON CONFLICT(...) DO UPDATE SET`
- `safeParseJson(null, [])` → `[]`;`safeParseJson('[1,2]', [])` → `[1,2]`;`safeParseJson([1,2], [])` → `[1,2]`(已经是 object)
- `migrate-compat.ts` 导出:`columnExists`、`indexExists`、`safeAlterTable`、`ensureIndex`、`ensureUniqueIndex`、`dropIndexIfExists`、`isDuplicateColumnError`
- `ensureIndex` 对 MySQL 走 `information_schema.STATISTICS` 查询 → `CREATE INDEX`;对 SQLite 走 `CREATE INDEX IF NOT EXISTS`
- `npx tsc --noEmit` 通过

**对应设计章节**:DESIGN.md §模块 2 + §模块 3

**执行上下文**:
- **代码锚点**:`src/portal/migrate.ts` 当前的 `safeAlterTable`(458-481 行)是 MySQL-only 的参考实现,新的 `migrate-compat.ts::safeAlterTable` 把它改成 driver 分发
- **buildUpsert 表达式 form 示例**:`buildUpsert(db, "chat_sessions", ["id","agent_id","user_id"], [...], ["id"], [{ col: "last_active_at", expr: "CURRENT_TIMESTAMP" }])`
- **safeParseJson 签名**:`<T>(value: unknown, fallback: T): T`,用于 `const labels = safeParseJson<string[]>(row.labels, [])`
- **索引 ensureIndex 错误处理**:MySQL `CREATE INDEX` 不带 IF NOT EXISTS,所以要先查 information_schema;捕获 `ER_DUP_KEYNAME` / errno 1061 作为"已存在"兜底

---

### 步骤 3:Schema 一份化

**目标**:一份 DDL 两边都能跑;老 MySQL 生产库零结构变更;14 个索引名严格沿用。

**涉及文件**:
- `src/portal/migrate.ts`(改写 ~600 行)

**验收标准**:
- 27 张表的 CREATE TABLE 都用"最大公约数"语法:无 `ENGINE=...`、无 `COLLATE=...`、无 `TIMESTAMP(3)` 精度、无 `ON UPDATE CURRENT_TIMESTAMP`、`JSON` 列改为 `TEXT`
- 所有内联 `INDEX idx_xxx (col)` 全部移出,通过 `ensureIndex(db, table, name, "cols")` 单独创建(14 个索引名严格沿用现有名字清单)
- `safeAlterTable` / 索引降级 / UNIQUE KEY drop 等调用全部切换到 `migrate-compat.ts` 的 helper
- **在 `:memory:` SQLite 上跑 `runPortalMigrations()` 成功,27 张表 + 14 个索引齐全**(测试在步骤 6 写)
- **在 MySQL(测试 mock 或真实库)上跑同一份 `runPortalMigrations()` 成功**
- 幂等:同一份 migration 跑两次不报错
- `npx tsc --noEmit` 通过

**对应设计章节**:DESIGN.md §模块 2

**执行上下文**:
- **代码锚点**:`src/portal/migrate.ts:13-447` 是 `PORTAL_SCHEMA_SQLS` 数组(27 张表);`:484-556` 是 `runPortalMigrations()`(包含 safeAlterTable 调用、UNIQUE KEY drop、data backfill)
- **索引名清单**(14 个,不要改动):`idx_chat_messages_session`、`idx_chat_messages_audit`、`idx_chat_sessions_user`、`idx_chat_sessions_agent`、`idx_chat_sessions_origin`、`idx_notifications_user`、`idx_api_keys_hash`、`idx_agent_task_runs_task`、`idx_agent_task_runs_session`、`idx_channel_bindings_agent`、`idx_kpe_created`、`idx_kpe_repo`、`idx_skills_overlay`、`idx_skills_org_name`
- **data backfill 保留**:`UPDATE chat_sessions SET origin = 'task' WHERE origin = 'cron'`、`UPDATE skills SET is_builtin = 1 WHERE created_by = 'system' AND is_builtin = 0` 这两条必须保留(SQLite 和 MySQL 都认)
- **`UNIQUE KEY uq_xxx (a, b)` 改写**:CREATE TABLE 里改成匿名 `UNIQUE (a, b)` + 步骤 3 末尾用 `ensureUniqueIndex` 显式建名(如 skills 表的历史处理)
- **MEDIUMTEXT / LONGTEXT / LONGBLOB 保留**:`skills.specs`、`chat_messages.tool_input`、`skill_import_history.snapshot`、`knowledge_versions.data`,这些字段直接保留原类型名,SQLite 类型亲和性会容忍

---

### 步骤 4:应用层改造(机械修改)

**目标**:所有分散在业务代码里的 MySQL-specific 写法,全部改为两边通用。

**涉及文件**:
- `src/portal/adapter.ts`(最大改动点,~30 处)
- `src/portal/siclaw-api.ts`(~40 处)
- `src/portal/agent-api.ts`、`channel-api.ts`、`cluster-api.ts`、`host-api.ts`(各几处)
- `src/portal/notification-api.ts`、`skill-import.ts`、`chat-gateway.ts`、`auth.ts`(少量)

**验收标准**:

A. **UPDATE 补 updated_at**(25 处,见 DESIGN §模块 4.1 清单):
- 每条对 10 张带 updated_at 的表(agents/clusters/hosts/agent_tasks/channels/mcp_servers/skills/model_providers/agent_diagnostics/system_config)的 UPDATE 都包含 `updated_at = CURRENT_TIMESTAMP`
- `setClauses.push("updated_at = CURRENT_TIMESTAMP")` 形式或静态追加均可
- `adapter.ts:1114, 1584`(system_config 的 upsert)走 `buildUpsert` 的表达式 form 自动带 updated_at

B. **时间戳精度统一**(50+ 处):
- 全仓 grep `CURRENT_TIMESTAMP(3)` 和 `NOW(3)`,全部改成 `CURRENT_TIMESTAMP`
- 注意 `NOW(3)` 不等于 `NOW()` — `NOW()` 不带精度,语义是当前时刻;`NOW(3)` 是毫秒精度版本;两边都简化为 `CURRENT_TIMESTAMP`

C. **日期函数 → 应用层 ISO 串**(9 处,见 DESIGN §模块 4.2 清单):
- `adapter.ts:944, 948, 1050, 2004, 2008, 2042`、`siclaw-api.ts:1737, 2093, 2124, 2133`
- 例子:`NOW() - INTERVAL ? DAY` 的位置,把 `?` 参数从 `days: number` 改成 `cutoff: string`(`new Date(Date.now() - days * 86400e3).toISOString()`),SQL 改成 `created_at < ?`
- `expires_at > NOW()` → 应用层算 `const now = new Date().toISOString()` 传参,SQL `expires_at > ?`
- `DATE_SUB(CURDATE(), INTERVAL ? DAY)` → 应用层算好 date-only 字符串(`new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10)`)传参

D. **dialect helper 调用**(10 处,见 DESIGN §模块 3 影响范围清单):
- 6 处 `ON DUPLICATE KEY UPDATE` 改为 `buildUpsert`,其中 `adapter.ts:539, 1799` 用表达式 form
- 1 处 `INSERT IGNORE`(`agent-api.ts:106`)改为 `insertIgnorePrefix(db) + " ..."` 拼接
- 1 处 `FOR UPDATE`(`siclaw-api.ts:2478`)改为**事务内 `SELECT COALESCE(MAX(version), 0) + 1 AS next_v FROM ...`**,外面继续在事务中 INSERT 下一个版本(SQLite serializable + busy_timeout 足够)
- 1 处 `JSON_TABLE`(`siclaw-api.ts:128`)和 1 处 `JSON_CONTAINS`(`siclaw-api.ts:160`)改为 `jsonArrayFlattenSql` / `jsonArrayContains` helper

E. **JSON 列读取防御**(15 个列,见 DESIGN §模块 3 清单):
- 逐列 grep:`skills.labels`、`skills.scripts`、`skill_versions.specs/scripts/diff/labels`、`skill_reviews.diff/security_assessment`、`mcp_servers.args/env/headers`、`chat_messages.metadata`、`channels.config`、`agent_diagnostics.params`、`skill_import_history.added/updated/deleted`、`knowledge_publish_events.snapshot_before/snapshot_after`
- 所有 `JSON.parse(row.col)` 或 `typeof row.col === "string" ? JSON.parse(row.col) : row.col` 改为 `safeParseJson(row.col, fallback)`
- 所有 `row.col.map/forEach/length` 等假设已 parsed 的位置,**上游**先 `safeParseJson`

F. **ORDER BY 兜底**(30 处):
- grep `ORDER BY .*created_at`,对所有没有 `, id` 次排序的都追加 `, id`
- 特别是 `chat_messages`(同秒多条)、`agent_task_runs`、`notifications`

**验收测试**:
- 步骤 6 的 `schema-invariants.test.ts` 会 grep 断言每条 10 张表的 UPDATE 都包含 `updated_at`
- 步骤 6 的 `dialect-helpers.test.ts` 覆盖 helper 的双 driver 输出
- 现有 adapter.test / siclaw-api.*.test 通过(它们 mock `db.query`,不涉及 driver)
- `npx tsc --noEmit` + `npx tsc -p tsconfig.agentbox.json --noEmit` 通过
- `npm test` 通过

**对应设计章节**:DESIGN.md §模块 3 + §模块 4

**执行上下文**:
- **代码锚点 A**(UPDATE 补 updated_at):逐个文件改;对 `${setClauses.join(", ")}` 动态构造的,在构造 setClauses 的循环后 push 一条;对静态 SQL 字符串,直接在字符串里加
- **代码锚点 B**(时间戳精度):全仓 grep `\(3\)`,注意有些 `TIMESTAMP(3)` 是在 `migrate.ts` 里已经被步骤 3 处理(应该已经没剩了);剩下的都是 UPDATE/SELECT SQL 里的 `CURRENT_TIMESTAMP(3)` 和 `NOW(3)`
- **代码锚点 C**(日期函数):改造时注意参数类型可能要变(`days: number` → `cutoffIso: string`),调用方也要改
- **代码锚点 D**(dialect):逐行替换即可;`FOR UPDATE` 那条要小心事务里 MAX+1 的逻辑
- **代码锚点 E**(JSON):这是最容易漏的一项,建议逐列 grep,如 `rg 'mcp_servers.*\b(args|env|headers)\b'`
- **代码锚点 F**(ORDER BY):`rg 'ORDER BY [^,;)]*created_at' src/portal src/gateway` 找全

---

### 步骤 5:Bootstrap 重构 + cli-local 入口

**目标**:`siclaw local` 单进程启动完整 Portal + Runtime + SQLite,零外部依赖、零手工配置;prod `portal-main` / `gateway-main` 入口继续可用。

**涉及文件**:
- `src/lib/bootstrap-portal.ts`(新增,~80 行)
- `src/lib/bootstrap-runtime.ts`(新增,~150 行)
- `src/lib/server-helpers.ts`(新增,~15 行)
- `src/cli-local.ts`(新增,~80 行)
- `src/portal-main.ts`(改写瘦身到 ~30 行)
- `src/gateway-main.ts`(改写瘦身到 ~30 行)
- `src/cli-setup.ts` 扩展 `loadOrGenerateLocalSecrets()`(+40 行)
- `siclaw.mjs`(改路由 + experimental-sqlite flag)

**验收标准**:
- `bootstrapPortal(config)` 返回 `{ server: http.Server, close: () => Promise<void> }`;内部完成 `initDb → runPortalMigrations → autoInitBuiltinSkillsIfEmpty → syncBuiltinKnowledge → startPortal → waitForListen`
- `bootstrapRuntime(config)` 返回 `{ close: () => Promise<void> }`;内部完成 spawner / agentBoxManager / frontendClient / taskCoordinator 装配
- `portal-main.ts` 只做:读 env → 调 `bootstrapPortal` → 注册 SIGINT/SIGTERM
- `gateway-main.ts` 只做:读 env → 调 `bootstrapRuntime` → 注册 SIGINT/SIGTERM
- `cli-local.ts`:读 env + `loadOrGenerateLocalSecrets` → 顺序调 bootstrapPortal(await listen) + bootstrapRuntime → signal handler
- `siclaw local` 命令启动无任何 env 变量的情况下能跑起来(首次自动生成秘钥、默认 SQLite 到 `.siclaw/data/portal.db`)
- `siclaw.mjs` 处理 Node 22 的 `--experimental-sqlite` flag:如果当前 `process.execArgv` 不含它,spawn 子进程 `node --experimental-sqlite <this> <args>` 替换当前进程
- `siclaw`(不加 local)的 TUI 入口不受影响
- `npx tsc --noEmit` + `npx tsc -p tsconfig.agentbox.json --noEmit` 通过
- 现有 `npm test` 通过(不要破坏现有测试)

**对应设计章节**:DESIGN.md §模块 5

**执行上下文**:
- **代码锚点**:`src/portal-main.ts:1-71`(71 行)和 `src/gateway-main.ts:1-158`(158 行)的所有 wiring 逻辑搬到 bootstrap 模块;保留 signal handler 在 main 入口
- **关键接口 `bootstrapPortal` config**:`{ port, databaseUrl, jwtSecret, runtimeUrl, runtimeWsUrl, runtimeSecret, portalSecret }`
- **关键接口 `bootstrapRuntime` config**:目前 `gateway-main.ts` 直接 `loadRuntimeConfig()` 读 env,bootstrap 版本改成接受 `{ config: RuntimeConfig, spawnerType: "local" | "k8s" | "process" }` 参数
- **spawner 初始化**需要 `CertificateManager.create()`,放在 bootstrapRuntime 内部
- **`waitForListen`**:`server.listening ? resolve : server.once("listening", resolve); server.once("error", reject)`
- **`loadOrGenerateLocalSecrets`**:检查文件存在 → 读 JSON → 否则 `crypto.randomBytes(32).toString("hex")` 生成三个 secret,mkdir、写文件、chmod 0600(ignore 错误,非 POSIX 系统)
- **`siclaw.mjs` experimental flag**:
  ```js
  const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
  if (nodeMajor < 24 && !process.execArgv.includes("--experimental-sqlite")) {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["--experimental-sqlite", process.argv[1], ...process.argv.slice(2)], { stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 0));
  } else {
    /* 原有路由逻辑 */
  }
  ```
- **`cli-local.ts` 的依赖顺序严格**:bootstrapPortal → waitForListen → bootstrapRuntime(Runtime 的 frontendClient 会立即连 Portal)

---

### 步骤 6:测试 + schema-invariants

**目标**:防止三种数据状态下的回归;防止步骤 4 的 110 处机械修改漏改。

**涉及文件**:
- `src/gateway/db.test.ts`(重写扩展 ~150 行)
- `src/gateway/dialect-helpers.test.ts`(新增 ~60 行)
- `src/portal/migrate-sqlite.test.ts`(新增 ~70 行)
- `src/portal/schema-invariants.test.ts`(新增 ~50 行)

**验收标准**:
- `db.test.ts`:同时覆盖 mysql mock 和 sqlite `:memory:` 路径;DML 返回形状对齐 mysql2;事务 commit/rollback;并发 getConnection 被 mutex 排他
- `dialect-helpers.test.ts`:每个 helper 的 MySQL/SQLite 两条 snapshot;`safeParseJson` 对 null/string/object/malformed string 的 4 种 case
- `migrate-sqlite.test.ts`:打开 `:memory:` driver 跑 `runPortalMigrations()` → `PRAGMA table_info` 断言 27 张表的关键列;`PRAGMA index_list` 断言 14 个索引存在;再跑一次幂等不报错
- `schema-invariants.test.ts`:`fs.readFileSync` 读 `src/portal/*.ts` 的源码,正则匹配所有 `UPDATE <table>` 语句,对 10 张 "ON UPDATE" 表的每条断言包含 `updated_at`;对 `buildUpsert(db, "system_config", ...)` 调用特殊处理(它自带 updated_at)
- `npm test` 全绿

**对应设计章节**:DESIGN.md §模块 6

**执行上下文**:
- **测试运行器**:vitest,`npm test` 执行 `vitest run`
- **dialect-helpers 双 snapshot 示例**:
  ```ts
  const mysqlDb = { driver: "mysql" } as Db;
  const sqliteDb = { driver: "sqlite" } as Db;
  const r1 = buildUpsert(mysqlDb, "t", ["a","b"], [1,2], ["a"], ["b"]);
  expect(r1.sql).toContain("ON DUPLICATE KEY UPDATE");
  const r2 = buildUpsert(sqliteDb, "t", ["a","b"], [1,2], ["a"], ["b"]);
  expect(r2.sql).toContain("ON CONFLICT(`a`) DO UPDATE");
  ```
- **schema-invariants 正则**:`/UPDATE\s+(\w+)\s+SET\s+([\s\S]*?)(?=WHERE|$)/g`,然后检查 `groups[1] in TABLES_WITH_UPDATED_AT && groups[2].includes("updated_at")`
- **`:memory:` 测试的 SQLite driver 初始化**:`const db = initDb("sqlite::memory:"); await runPortalMigrations();`

---

### 步骤 7:文档更新

**目标**:让 CLAUDE.md、README.md、docs/design/invariants.md 反映新的真实状态。

**涉及文件**:
- `CLAUDE.md`(§Two Separate Databases 更新表格)
- `README.md`(§Tech Stack 修正)
- `docs/design/invariants.md`(如有类似描述,同步)

**验收标准**:
- `CLAUDE.md` §Two Separate Databases 表格从 "Gateway DB | sql.js (WASM)" 更新为:
  ```
  | Gateway DB | MySQL (prod) / node:sqlite (local via DATABASE_URL) | ... |
  ```
- `README.md` §Tech Stack 的 "Database (gateway)" 行从 "MySQL or SQLite (via sql.js) + Drizzle ORM" 更新为 "MySQL (prod) or SQLite (local, via node:sqlite)"(去掉 Drizzle)
- `docs/design/invariants.md` 如果有任何 sql.js / Drizzle 描述,同步清理
- `README.md` §Local Server 部分补充一行:"Data is stored at `.siclaw/data/portal.db` by default. Override with `DATABASE_URL=sqlite:///path`."

**对应设计章节**:DESIGN.md §风险 6

**执行上下文**:
- `CLAUDE.md:60-66` 左右是 Two Separate Databases 表格
- `README.md:208` 是 Tech Stack 表格
- docs/design/invariants.md 可能还有其他提及,grep 后再处理

---

## 执行顺序与验证节奏

1. 步骤 1 完成 → 跑 `npm test`,确认现有测试不挂(Db 接口兼容)
2. 步骤 2 完成 → 无需单独测试,helper 会在步骤 4 + 6 里被验证
3. 步骤 3 完成 → 跑 `npm test`;重点 adapter.test / migrate 相关
4. 步骤 4 完成 → 跑 `npm test`;重点 adapter.test、siclaw-api.test、skill-import.test
5. 步骤 5 完成 → 跑 `npm test` + 手动 `npm run build && node dist/cli-local.js`(或通过 `siclaw local`)启动一次,打开 http://localhost:3000 看 Portal 页面
6. 步骤 6 完成 → 新测试全绿
7. 步骤 7 完成 → 最终 `npm test` + `npx tsc --noEmit` + `npx tsc -p tsconfig.agentbox.json --noEmit` 三绿

一次性 commit,不在每步后单独 commit。commit message 包含所有步骤的关键改动。
