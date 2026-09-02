# 提问口径：哪些 user 行算是人在提问

## 背景

Portal 的「提问」统计数的是 `chat_messages` 里 `role='user'` 的行。但运行时为了驱动流程，
会以用户身份写入若干**流程行**——它们走 user 通道只是因为那是模型读取输入的通道，不是因为
有人问了什么：

| kind | role | 是什么 | 生产 30 天 |
|---|---|---|---:|
| `task_event` | user | Agent 自己维护的待办 ledger，每次增删改都持久化一条 | **19,502** |
| `delegation_event` | user | 子 Agent 的进度回报 | 3,065 |
| `task_notification` | user | 后台作业完成后用来唤醒模型的注入文本 | 21 |
| `exec_job_event` | user | 后台作业的完成标记 | 3 |
| `steer` | user | **人**在一轮跑着的时候插话——是真提问，见下 | — |
| `error_response` | assistant | 失败轮次的持久化，压根不在 user 通道 | — |
| `model_route_notice` | assistant | 模型路由切换/恢复的留痕，同样不在 user 通道 | — |
| （无 kind） | user | 真正的人类提问 | 7,512 |

改动前，四处统计只排除了 `delegation_event`，于是 `task_event` 那两万条全部被算作提问——
这个数因此虚高数倍。

## 词表与谓词分在两处

```
┌─────────────────────────────────────────────────────────────────┐
│ src/shared/message-kinds.ts          词表（运行时写入方也依赖） │
│   CHAT_MESSAGE_KINDS   metadata.kind 允许出现的全部取值         │
│   SYNTHETIC_USER_KINDS 其中属于「流程行」的子集                 │
│   ChatMessageMetadata  把 kind 收窄到词表的元数据类型           │
└───────────────────────────────┬─────────────────────────────────┘
                                │ 只被读取，不含 SQL
┌───────────────────────────────┴─────────────────────────────────┐
│ src/portal/human-prompt.ts           谓词（需要 db.driver）      │
│   humanPromptPredicate(db, alias)                               │
└───────────────────────────────┬─────────────────────────────────┘
                                │
┌───────────────────────────────┴─────────────────────────────────┐
│ src/gateway/dialect-helpers.ts       方言差异的唯一出口          │
│   jsonScalarOrNull(db, column, path)                            │
└─────────────────────────────────────────────────────────────────┘
```

分开是因为 `src/shared` 会被打进 AgentBox 镜像，不能反向依赖 gateway；而谓词必须拿到
`db.driver` 才能选方言。词表留在 shared，是因为**写入方**（agentbox / gateway / tools）也要
用它。

四处调用点改为 `AND ${humanPromptPredicate(db, "m")}`：

| 位置 | 接口 |
|---|---|
| `src/portal/siclaw-api.ts` totalPrompts | `GET /api/v1/siclaw/metrics/summary` |
| `src/portal/siclaw-api.ts` dailyPrompts | 同上（趋势图） |
| `src/portal/adapter.ts` totalPrompts | `GET /api/internal/siclaw/metrics/summary` |
| `src/portal/adapter.ts` totalPrompts | RPC `metrics.summary` |

## 为什么不再用 LIKE

原判定是 `m.metadata NOT LIKE '%"kind":"delegation_event"%'`，有两个毛病：

1. **依赖序列化形状**。它假设冒号后没有空格。JSON 序列化方式一变，判定静默失效。
2. **匹配整个列**。任何字段只要在别处提到某个 kind 的名字，那一行就被丢出统计。

改为读 `metadata.kind`。没有 metadata、metadata 不可解析、或者没有 `kind` 字段的行都
**保留**——一条普通提问本来就不带 kind，那是常态而非边界情况。

## ⚠️ JSON 读法必须走方言分支

这不是可选项，两边的函数不一样：

```
MySQL :  CASE WHEN JSON_VALID(col) THEN JSON_UNQUOTE(JSON_EXTRACT(col, '$.kind')) END
SQLite:  CASE WHEN JSON_VALID(col) THEN json_extract(col, '$.kind')               END
```

- MySQL 的 `JSON_EXTRACT` 返回的是 **JSON 字符串**（`"task_event"`，带引号），不套
  `JSON_UNQUOTE` 就永远等不上普通字面量——谓词会静默退化成恒真。
- SQLite 的 `json_extract` 本身就返回去引号文本，而 **`JSON_UNQUOTE` 在 SQLite 里根本不
  存在**。这一条第一版踩过：谓词硬编码了 MySQL 语法，`siclaw local`（SQLite）下四个
  metrics 接口全部 `no such function: JSON_UNQUOTE`。
- `JSON_VALID` 外壳两边都不能省：列内容不是合法 JSON 时，MySQL 抛 ER_INVALID_JSON_TEXT、
  SQLite 抛 `malformed JSON`，**都不是返回 NULL**。少一行脏数据就能让整条查询失败。

`COALESCE(<kind>, '') NOT IN (…)` 而不是 `<kind> IS NULL OR <kind> NOT IN (…)`：语义相同，
但每行只解析一次 JSON 而不是两次。

**测试必须真跑一遍。** 第一版有测试，断言的是 SQL 字符串形状，SQLite 那条从头到尾没被执行
过，所以全绿。`src/portal/human-prompt.test.ts` 现在拿真的 `node:sqlite` 建表、插行、执行
谓词、比对计数。

## 新增 kind 是编译期约束，不是注释

`ChatMessageMetadata.kind` 被收窄到 `CHAT_MESSAGE_KINDS`，并且写入路径上的
`AppendMessageInput` / `DelegationAppendMessagePayload`（以及对应的 Update 版本）都用了这个
类型。于是：

- 写一个没登记的 kind → **编译不过**；
- 要登记就必须打开 `message-kinds.ts`，而那里紧接着问的就是「它算不算人类提问」。

这条规则第一版是写成注释的——`session-origin.ts` 当年也是注释，`subagent` 上线时八处硬编码
谓词无一知情。类型收窄第一次接上时，编译器当场找出了两个作者没枚举的 kind（`steer` 与
`error_response`）。

### 这个机制有一个洞，位置不在直觉上

TypeScript 会拒绝**内联字面量**里的未登记 kind，但一个以 `Record<string, unknown>` 形式抵达
的值可以无错赋给 `ChatMessageMetadata`——源的索引签名并不需要满足目标已声明的可选属性。于是
「先用 helper 构造 metadata 再传进去」这条路径完全不受检查，`model_route_notice` 就是这样在
类型已经收窄、测试全绿的情况下上线了一个版本而从未登记。

改类型的形状解决不了：去掉索引签名后，任何带 payload 字段的字面量都会被拒——也就是全部。
所以是把 **builder 自己的返回类型**标成 `ChatMessageMetadata`（`sse-consumer.ts` 两处），
未登记的 kind 才会在那里编译不过。

`src/portal/message-kind-invariants.test.ts` 盯住的是这个机制本身——写入路径六个接口的
`metadata` 类型，以及那两个 builder 的返回类型。谁把任何一处放回 `Record<string, unknown>`，
测试就红；否则退化是完全无声的。

### `steer` 为什么不算流程行

`steer` 是**人**在一轮还在跑的时候插进来的话，打这个 tag 只是为了让前端画成 steer 气泡而不是
普通用户消息。tag 描述的是「什么时候发的」，不是「谁写的」。把它当流程行排掉，等于专门少数
互动最频繁的那批用户。

## origin 那半不用动

`session-origin.ts` 已经收敛过了：`TRACE_ORIGINS = ["task", "delegation", "subagent"]`，
四处调用点走 `nonTraceOriginPredicate()`。两者是**两根正交的轴**，都需要：合成行落在普通用户
会话里，origin 过滤根本看不见它们。

## 与 sicore 的关系：**没有对等清单**

本次改动的早期版本（含 PR 描述与代码注释）声称本清单与 sicore 的
`chatfields.syntheticUserKinds`（`internal/siclaw/chatfields/message_kind.go`）逐字相同。
**这三点全是错的**：那个文件不存在（`chatfields/` 下只有 `title.go`），那个符号不存在，
sicore 也没有反向指认的注释。已核对 sicore 当前 main。

sicore 的实际情况：

| 位置 | 回答的问题 | 状态 |
|---|---|---|
| `internal/siclaw/metrics/handler.go` totalPrompts | 提问总数 | **完全没有 kind 过滤**，注释写的就是 "user messages (role=user)" |
| `internal/siclaw/adapter/rpc.go` metrics.summary | 同上 | 同上 |
| `internal/siclaw/metrics/trace_kinds.go` `TraceNonPromptUserKinds` | 哪条 user 行可以当 trace 的标题 / 分析输入 | 8 个 kind，**含 `steer`** |
| `internal/siclaw/chat/service.go` `previousUserMessageSnapshot` | 某条 assistant 回复的是哪条提问（反馈归属） | 3 个 kind 的 LIKE，缺 `exec_job_event` |

所以 sicore 面板上的提问数比本仓库改动前**还要虚高**——它连 `delegation_event` 都没排除。
这是一个跨仓库问题，不在本 PR 范围内，但应当单独处理。

至于 `trace_kinds.go`，它和本清单**问题不同**，正因如此集合也不同：`steer` 属于它（一句中途
插话当会话标题很差），但必须**不**属于本清单（那是真人问的真问题）。把任一份清单照抄到另一边，
两个方向都是错的。

结论：本清单只对本仓库负责，不声明任何跨仓库等价。

## ⚠️ 这会让 Portal 上的提问数明显下降

与 sicore 在 2026-08-24 经历的是同一件事：数字变小是因为口径变准，不是用量下滑。发布时应当
说明变更日期与原因——那次没有说明，结果是有人发现数字不对再回头查，本次改动即由此而来。
