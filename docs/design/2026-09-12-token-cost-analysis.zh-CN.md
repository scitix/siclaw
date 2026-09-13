# siclaw Token 成本分析与优化方案

> **修订 r6（2026-09-13）** —— 基线 `origin/main` @ `946e0675`。
> **P0 已实现**，含接收端与事实表；实现记录与剩余缺口见 **§7.8.9**。
> **P0 方案定稿见 §7.8**，五项决策与三处补正均已并入。
> r1 有多处实质错误已被推翻，逐条列于「修订记录」。**r1 的诊断路径不可执行，勿按 r1 实施。**
>
> **r3 相对 r2 的改动**：①「子代理历史无可回灌」过满，改为「可回灌范围待查」（pi 的 JSONL 另有一份，且无正文的 assistant 也能带 usage）；② `PI_CACHE_RETENTION=long` 不等于直接拿到 24h（分支可能发 `ttl=30m`）；③「50 item = 50 次前缀 write」撤回为「前缀复用率未知」。

## 修订记录：r1 被推翻的结论

| r1 的说法 | 实际 | 证据 |
|---|---|---|
| 「数据完整，只缺聚合」「无需新增采集」「历史不丢」 | **错。** subagent 走独立持久化路径，assistant 行的 metadata 只有 `phase`/`stop_reason`/`assistant_item`，**没有 `llm_call`**；且 `if (text)` 守卫使无正文的调用不落行。**头号怀疑对象恰恰在 Portal 侧无数据可查**（r3 补正：pi 的 JSONL 另有一份完整 assistant 消息且可携带 usage，可回灌范围见 §7.7 待查清单）| `session.ts:2921-2945` |
| §3.1 的 SQL 能区分三个假说 | **错。** `round` 是 **prompt 内**轮次、每个 prompt 重置，故「rnd=1 多」只说明 prompt 多，不能证明 subagent 多；首轮 `since_prev_ms` 是准备耗时而非距上次提问的间隔 | `llm-call-recorder.ts:49` |
| 「写一次要读 ≥2 次才回本」 | **算错了。** 写 1.25 + 读 0.1 = **1.35 < 2.0**，**一次复用即回本**。故 write 高本身不等于赔钱，只有在几乎没有对应 read 时才是 | 算术 |
| 「有独立 cache_write 计费项 ⇒ Anthropic 风格或自建计费」 | **不成立。** OpenAI 官方对 GPT-5.6 及以后模型亦有 cache-write 计价 | OpenAI 文档 |
| `tool-result-context-guard` 原地改写 ⇒「不改共享对象则前缀恒定」 | **前提与结论都错。** `context-pruning` 本就只返回请求视图（复制数组 + 构造新消息）；而且只要**发出去的历史**变了，缓存照样受影响 | `context-pruning.ts:142` |
| 后台通知无合并窗口，50 item = 最多 50 次 `runPrompt` | **错。** group 在 reduce 后算**一次**完成；独立通知路径另有 600ms 合并窗口 | `background-work-turn.ts:78-79`、`session.ts:312` |
| 台账语义「强制」每个 milestone 拆成独立回合 | **过度推断。** 工具明确支持「完成上一项 + 下一次独立工具调用」同批提交；禁止提前宣告验证成功 ≠ 禁止批量 | `task-tools.ts:259` |
| 每轮固定开销 17,100 tokens | **低估，需重测。** 只统计了 description 与嵌套 description 字符串，未计 schema 结构本身（`task_create` 实际 1,047 vs 记为 141；`task_update` 1,411 vs 141），也未计文件/artifact 工具、运行时追加 prompt 与新增的 `run_script` |
| 「没有任何 token 读取能力」 | **写过满。** 已有 `siclaw_tokens_total{type,provider,model,user_id}` 与 `siclaw_cost_usd_total` Prometheus counter；缺的是**调用明细与下钻**，不是全部能力 | `shared/metrics.ts:75-88` |
| §7.4「token 挂在没有主人的子会话上」 | **错。** 子会话建会话时即写入 `request.userId`，有主人。真正的缺口是**没有 token 数据**，不是归属 | `session.ts:2829` |
| 「292K tokens 重复计费」 | **口径不严。** 那是按假定前缀推算的累计输入量，其中命中缓存的部分不按 input 单价计费，不能直接当作损失额 |

**因此顺序改为：补齐采集与计费口径 → 测量真实请求与缓存复用 → 再决定 TTL / 裁剪 / 子会话优化。** `C > B > A` 现在只是待验证假设，三者可以同时成立，且尚未排除服务端路由、缓存淘汰与断点等外部原因。

---

> 分析基线：`origin/main` @ `946e0675`（2026-09-12）
> 依赖库：`@earendil-works/pi-ai` **0.85.1**（注意：本地 `node_modules` 仍是 0.80.7，行号会对不上，本文引用的是 0.85.1）
> 线上协议：**OpenAI Responses**（`openai-responses`）

---

## 背景

模型服务方的计费显示 siclaw 消耗异常，且统计里 **cache_write 占比特别高**。

本文回答三件事：钱花在哪、cache_write 高说明什么、怎么改。

**文档分两部分**：

- **§1–§6 诊断与止血** —— 账的构成、cache_write 偏高的三个假说、定位方法与降本方案。
- **§7 Token 可观测性建设** —— 要新建的能力：provider/model 维度的开发者 dashboard、按用户的管理员视图。含四个需要 review 的设计决策。

**需要先说明的**：

1. **§2.3 的三个假说目前都未被证实**，且**可以同时成立**；也尚未排除服务端路由漂移、缓存淘汰、断点策略等客户端观测不到的原因。在补齐采集（§3.0b）之前，任何一条都不足以支撑改代码。
2. 所有 `file:line` 引用基于 **`origin/main` @ `946e0675`**。若在落后的本地工作区核对会对不上行号。
3. pi 系列依赖引用 **0.85.1**（`package.json` 声明值）。本地 `node_modules` 若仍是 0.80.7，行号同样对不上。

---

## 一、成本结构

### 1.1 每轮固定开销 ≳ 17,100 tokens（**低估，需重测**）

每一次模型往返都要重发 system prompt + 全部工具定义。下表**只统计了 description 与嵌套的 description 字符串，未计 schema 结构本身**，因此是下界：

| 工具 | 下表记为 | 实际 `JSON.stringify(parameters)` |
|---|---:|---:|
| `task_create` | 141 | **1,047** |
| `task_update` | 141 | **1,411** |

另漏计：实际启用的文件工具与 artifact 工具、运行时追加的 prompt（PROFILE / 知识目录 / 引用说明）、以及最新 main 新增的 `run_script`。

**重测方式**：在 `pi-execution.ts:52` 的 `inspectModelEnvelope` 处直接量真实 payload——它本就对 system + tools schema 做 sha256 指纹，加一个长度统计即可，比逐文件数字符串准确。

字符数（SRE agent，web 模式）：

| 组成 | 字符 | ~tokens |
|---|---:|---:|
| system prompt | 12,779 | 3,200 |
| **工具定义（30 个 siclaw 工具）** | **55,551** | **13,900** |
| MCP 工具 | **无上限** | 视配置 |
| **合计（不含 MCP）** | **68,330** | **~17,100** |

**工具块是 system prompt 的 4.3 倍。** 优化 prompt 措辞的收益远小于压缩工具描述。

按 agent type 的差异：

| Agent type | 工具数 | 工具字符 | prompt 字符 | ~tokens |
|---|---:|---:|---:|---:|
| **sre**（默认） | 30 | 55,551 | 12,779 | **~17,100** |
| coordinator | 6 | 8,331 | 9,084 | ~4,350 |
| knowledge_qa | 2 | 2,601 | 6,767 | ~2,340 |

### 1.2 最肥的工具描述

| 工具 | desc | param | 合计 | 位置 |
|---|---:|---:|---:|---|
| `node_exec` | 6,823 | 1,168 | **7,991** | `cmd-exec/node-exec.ts:101` |
| `spawn_subagent` | 5,268 | 1,174 | **6,442** | `workflow/spawn-subagent.ts:166` |
| `manage_schedule` | 3,064 | 473 | 3,537 | `workflow/manage-schedule.ts:27` |
| `task_create` | 3,175 | 141 | 3,316 | `workflow/task-tools.ts:126` |
| `host_exec` | 2,211 | 1,009 | 3,220 | `cmd-exec/host-exec.ts:112` |
| `task_update` | 2,980 | 141 | 3,121 | `workflow/task-tools.ts:224` |

具体的水分：

- **`node_exec`** 内嵌一份 1,573 字符的命令白名单散文（`:128-142`），重复 `command-sets.ts` 的内容。枚举不该进 description，而且会与真正的执行源静默漂移。另有约 2,000 字符是示例，含一段 6 行的 tcpdump/curl 演练。
- **`spawn_subagent`** 5,268 字符的描述里是三个完整示例 + 一篇写 task 模板的教程，而 `subagent_type` 菜单**只有一个选项**（`general-purpose`，`subagent-registry.ts:159-172`）。
- **`BACKGROUND_EXEC_DESCRIPTION`** 596 字符被内联进 7 个工具（`background-launch.ts:10`），源码层面是 DRY 的，但模型每轮读同一段话 **7 遍 = 4,172 字符**。
- **8 个 `*_exec` / `*_script` 工具共 18,871 字符**，实际只有 2 个契约。
- **`task_create` + `task_update` = 6,437 字符**，外加 system prompt 里 2,027 字符的 Planning 段。同文件里 `task_list` 82 字符、`task_get` 33 字符——说明正确的标定尺度本来就存在。

### 1.3 为什么一直没被发现

三个测量盲区叠在一起：

| 盲区 | 位置 | 后果 |
|---|---|---|
| 预算检查只量 system prompt（阈值 20,000 字符），**不量工具块** | `prompt-inspection.ts:220-223` | 55K 字符的工具定义从不触发任何告警 |
| 成本表硬编码全零 `{input:0, output:0, cacheRead:0, cacheWrite:0}` | `model-compat.ts:474` | siclaw 自报花费**永远是 $0** |
| Portal `/admin/dashboard/usage` 只 `COUNT(*)` 消息条数 | `siclaw-api.ts:3619` | token 数据记了三个月没人聚合 |

**主会话的数据一直在记**——`chat_messages.metadata.llm_call.usage` 有 `input / output / reasoning / cache_read / cache_write`（`llm-call-recorder.ts:38-45`），另有 Prometheus 的 `siclaw_tokens_total` / `siclaw_cost_usd_total`（`shared/metrics.ts:75-88`）。

缺的是**调用级下钻**与**覆盖完整性**：subagent 既不落库也不进 counter（§3.0b），成本曲线又因零价格表恒为 0。所以真实账单只能靠外部反查。

### 1.4 往返次数：×17

2026-08 全量实测（1540 条 trace，40321 次工具调用）：

- 平均 **17.1 次模型往返 / 对话**
- **77% 的往返只发 1 个工具调用**
- 模型往返占墙上时间 75%，工具执行仅 25%

17.1 × 17,100 ≈ **292K tokens 的累计输入量**（仅固定前缀部分，未计历史累积与 tool result）。

> ⚠️ **这是累计输入量，不是损失额。** 其中命中缓存的部分按 cache_read 单价（约 0.1×）计费，不能直接当作"重复计费"或可节省金额——r1 此处口径不严。真实损失取决于缓存复用率，而那正是当前测不出来的（§3.0b）。

往返被系统性放大的四处：

| 来源 | 位置 | 机制 |
|---|---|---|
| ~~后台完成通知无合并窗口~~ **已撤回** | `background-work-turn.ts:78-79`、`session.ts:312` | r1 称"50 item = 最坏 50 次 `runPrompt`"，**错**。group 在 reduce 后算**一次**完成；独立通知路径另有 `NOTIFICATION_COALESCE_MS = 600` 合并窗口。仅多个**互相独立**的 spawn / 后台 bash 才各自唤醒 |
| ~~台账语义强制拆回合~~ **已撤回** | `task-tools.ts:259` | r1 称语义"禁止批量"，**过度推断**。工具明确支持"完成上一项 + 下一次独立工具调用"同批提交；禁止提前宣告未到达的验证结果 ≠ 禁止批量，也不必然新增独立回合 |
| fallback 候选数无上限 | `model-routing.ts:455` | 只去重不限量；`empty_response` 在 `DEFAULT_FALLBACK_ON` 里，一次空响应重跑**整个 agentic loop** |
| `task_output` 教模型翻页读全量 | `task-output.ts:39` | "follow next_offset until complete"，8MB ÷ 32KB = **256 次往返**，无上限提示 |

台账那条代码里已有自述（`task-tools.ts:29-39`）：*"9841 task_\* calls, 96% of them the only tool call in their turn"*——**但那是数组批量落地之前的历史观测**。批量形式已经就位，当前是否仍独占回合，需要按现版本重新取数，不能沿用旧结论。

> **本节整体存疑**：17.1 次往返来自 2026-08 的实测，此后代码已有多次相关改动。§1.4 保留的两条（fallback、`task_output` 翻页）也只是**可能路径**，未在当前版本实测其发生频率。

### 1.5 output 侧：thinking 默认 high

`session-thinking.ts:8` 的 `?? "high"` 是**无配置时的兜底**，不是"全部强制 high"——r1 此处写过满。模型级设置（`getModelThinkingLevel`）优先，且 pi 会按模型能力 clamp。实际生效档位需按 provider/model 逐个确认，不能假定全线 high。

Responses 协议下 reasoning token 计入 `max_output_tokens`，而 `DEFAULT_MAX_TOKENS = 16384`（`model-compat.ts:158`）——reasoning 与正文抢同一预算。另外 `params.include = ["reasoning.encrypted_content"]`（`openai-responses.js:262`），这些加密 reasoning 内容会累积进历史并每轮重发。

---

## 二、cache_write 偏高说明什么

### 2.1 回本点在哪（r1 此处算错，已更正）

以常见的 1.25× / 0.1× 计（**实际单价必须以所用模型服务方的计费规则为准**，见 §6）：

| | 相对 input |
|---|---|
| cache write | **1.25×** |
| cache read | **0.1×** |
| 普通 input | 1.0× |

**回本点在一次复用。** 同一前缀用 n 次：

- 不缓存：`n × 1.0`
- 缓存：`1.25 + (n−1) × 0.1`
- n=2 时 **1.35 < 2.0**，已经回本；打平点约 n≈1.28。

> **r1 在此处写成"要读 ≥2 次才回本"并据此断言"比不用缓存还贵 25%"，是算术错误。** 结论应更正为：
>
> **write 高本身不是问题，只有当它几乎没有对应的 read 时才是。** 判据是 `cache_read / cache_write` 的比值，而非 write 的绝对值。write 随流量增长是正常的。

另外，**不能从"存在独立的 cache_write 计费项"推断计费风格**——OpenAI 官方对 GPT-5.6 及以后模型同样有 cache-write 计价。

### 2.2 协议层面缓存标记是发出去的（但这不证明链路正常）

需要澄清一个容易搞错的点：Responses 与 Completions 两条路径行为不同。

| | `openai-completions` | `openai-responses`（线上用这条） |
|---|---|---|
| 缓存标记 | 仅 `provider==="openrouter"` 且 `model.id` 以 `anthropic/` 开头才发（`:601`、`:1000`） | **`prompt_cache_key` 无条件发**（`:230`） |
| siclaw 是否需要配置 | 需要 `cacheControlFormat`，而全仓未设 | 不需要 |

所以"缓存标记没发出去"这个猜测**不适用于线上**。`prompt_cache_key` 取 `options.sessionId`，由 pi 自己管理（`agent-session.js:697,2691`），有值。

但 `store: false`（`:233`），无 `previous_response_id`，**每轮仍然全量重发**。

> ⚠️ **发送了 cache key ≠ 缓存链路正常。** 网关是否识别、上游是否命中、是否发生路由漂移或提前淘汰，都不是客户端能从发送动作推断的。另外 pi 0.85.1 的 `long` 分支并非只有一种形态——可能发 `24h`，也可能发 `prompt_cache_options.ttl=30m`，取决于 compat 判断，改配置前需实际抓一次请求确认。

### 2.3 三个假说

写多读少，只可能是缓存建完就失效了。三种失效方式，都在 siclaw 侧。

**优先级依据**（2026-09-12 经上游控制面的平台概览接口取得，7 天窗口）：

| 观测 | 数值 | 对假说的影响 |
|---|---|---|
| a2a 入口占比 | **786 / 1128 = 70%** | 主流量是程序连续调用，非人在回路 → **假说 A 权重大幅下调** |
| 每 prompt 工具调用数 | **49832 / 1128 ≈ 44** | 单次任务往返极多，放大一切固定开销 |
| 每 trace 的 `sessionCount` | **9~16**（`rootCount` 恒为 1） | 每次任务派生十几个子会话 → **假说 C 权重最高** |
| SRE 类型占比 | 1019 prompts / 47118 toolCalls | 成本几乎全部集中在 SRE agent（即 §1.1 中最重的那个 17K 配置） |

> ⚠️ **这些只是"值得优先排查"的次序，不是结论。** 三个假说**可以同时成立**，上表也没有排除服务端路由漂移、缓存淘汰、缓存断点策略等客户端看不见的原因。更关键的是：权重最高的 C **当前根本没有数据可查**（§3.0b）。
>
> **`C > B > A` 仅作排查假设使用；补齐采集前不要据此改代码。**

---

**假说 A — TTL 太短，撑不过调用间隔**（权重已下调）

`PI_CACHE_RETENTION` 全仓从未设置 → `resolveCacheRetention` 返回 `"short"` → `prompt_cache_retention` 为 `undefined`（`openai-responses.js:230-231`）。

SRE 排障是人在回路的节奏：agent 给一批结果 → 人看几分钟 → 再问下一个。每次停顿超过保留期，下一轮就要重新 write 整个 17K 前缀。

`supportsLongCacheRetention` 默认 `true`（`:55`）。但 **`long` 分支并非只有一种形态**：可能发 `prompt_cache_retention: "24h"`，也可能发 `prompt_cache_options.ttl=30m`，取决于 compat 判断（`supportsExplicitPromptCacheMode`）。**改配置前必须抓一次真实请求确认实际发的是哪种**，并确认网关是否识别该字段。

**假说 B — 前缀每轮被自己改写**

`context-pruning.ts` 挂在 `"context"` 事件上，**每次 LLM 调用前都跑**。context 超 `SOFT_TRIM_RATIO = 0.3`（`:7`）就改写历史里最老的 tool result，超 `HARD_CLEAR_RATIO = 0.5`（`:10`）直接清空。

裁剪本身幂等，所以前缀不会整体失效；但只要 ratio 持续高于 30%，每轮都可能在历史前部新增一处改写，该点之后的缓存前缀作废。

两处裁剪器的行为**不同**，r1 把它们混为一谈了：

| | 是否改写共享对象 | 对缓存的影响 |
|---|---|---|
| `context-pruning.ts` | **否**——`messages.slice()` + 构造新消息，只返回本次请求视图（`:142`起） | **仍有影响**：缓存看的是发出去的内容 |
| `tool-result-context-guard.ts` | **是**——`applyMessageMutationInPlace` 用 `Object.assign` 原地改写（`:248`） | 影响持续到后续轮次 |

> ⚠️ **两个纠正**：
> 1. r1 提出的修法「改成只影响请求视图，前缀就恒定」不成立——`context-pruning` 本来就只改视图，而**只要发给模型的历史变了，缓存照样失效**。
> 2. **"持续出现 write" 不能证明这条假说**：每轮正常追加 assistant + tool result 本身就会产生新的 cache write。要证实需要能观测「同一前缀被复用了几次」，当前数据做不到。

**假说 C — 每个 subagent 是独立 session，前缀各写一遍**

`session.ts:2706` 每个 child 走 `createSiclawSession` → 新 sessionId → 新 `prompt_cache_key`。每个 child 继承约 12K tokens 的工具定义（`allowedTools` 全量继承，仅屏蔽 `task_*` 与 `spawn_subagent`）。

> ⚠️ **r1 写"一次 50 item 的 batch = 50 次独立的前缀 write"，这个数字不能这么用。** 它假定每个 child 都完整写一遍前缀且都没命中，而：
> - 并发上限是 10，且 child 的前缀与父**部分重合**（公共 system 段、共享工具），共同前缀部分仍可能命中；
> - `prompt_cache_key` 相同与否只影响路由分区，**命中取决于前缀内容**；
> - **整条假说本身尚未被任何数据证实**（§3.0b：subagent 在 Portal 侧没有 `llm_call`）。
>
> 正确表述：**每个 child 是独立会话、独立缓存生命周期，其前缀复用率未知**。具体损失需等 P0 计量。

---

## 三、诊断

### 3.0 现有工具拿不到 token 数据

2026-09-12 实测 `siclaw-dev` MCP 三个接口，**均无 token 维度**：

| 接口 | 返回什么 | token |
|---|---|---|
| 控制面 trace 列表接口 | `messageCount` / `contentChars` / `toolCallCount` | ❌ |
| 控制面 trace 消息接口 | 投影结构，**字段中没有 `metadata`** | ❌ |
| 控制面平台概览接口 | sessions / prompts / toolCalls / distinctUsers | ❌ |

但**已有** Prometheus 指标可用（r1 漏了这一层）：

```
siclaw_tokens_total{type, provider, model, user_id}
siclaw_cost_usd_total{provider, model, user_id}
```

见 `shared/metrics.ts:75-88`。所以"完全没有 token 读取能力"的说法不成立——**缺的是调用级明细与下钻**，不是全部能力。注意 `cost` counter 只在 `dCost > 0` 时累加（`metrics.ts:197`），而 Portal 托管模型的价格表硬编码为零（`model-compat.ts:474`），所以**成本那条曲线对这批模型恒为 0**：指标名存，值实亡。

### 3.0b 致命缺口：subagent 根本没有 token 数据

`chat_messages.metadata.llm_call` 只覆盖主会话。**subagent 走的是另一条持久化路径**（`session.ts:2921-2945`）：

- assistant 行的 metadata 只有 `phase` / `stop_reason` / `error_message` / `assistant_item`，**没有 `llm_call`**；
- 且被 `if (text)` 守卫——**没有正文的模型调用连行都不落**。

主会话侧也不完整：压缩调用挂在 `aux_calls` 里、被路由丢弃的挂在 `discarded_llm_calls` 里，都需要展开；而**一次 prompt 结尾处的 aux 调用没有后续 agent 调用来承载，会直接丢失**。

**后果**：§2.3 里权重最高的假说 C（subagent 各写一遍前缀）**在 Portal 侧恰恰是唯一查不到的**。

> **r3 补正**：这不等于历史彻底丢失。pi 的 `SessionManager` 会把完整 assistant 消息写入 JSONL，**且无正文的 assistant 也能携带 usage**（0.85.1 已合成验证）。所以 r1 的「历史不丢」与 r2 的「无可回灌」**都过满**——可回灌范围取决于 session dir 的存储位置与保留策略，见 §7.7 的待查清单。

**必须先补采集，才谈得上定位。**

### 3.1 定位 SQL（r1 版本无效，此处说明为什么）

> ⚠️ **r1 给的 SQL 不能区分三个假说，不要执行。** 两个语义误读：
>
> 1. **`round` 是 prompt 内轮次，每个 prompt 从 1 重新开始**（`llm-call-recorder.ts:49`："index of this model call **within the prompt**"）。因此"`rnd=1` 占绝大多数"只说明 prompt 多，**不能推出 subagent 多**。
> 2. **首轮的 `since_prev_ms` 是准备耗时**（`request_at − prompt_received_at`），不是距上次用户提问的间隔，拿它判 TTL 过期是错的。
>
> 更根本的是：**秒级间隔持续出现 write 也不能证明前缀被裁剪**——正常追加历史（每轮新增 assistant + tool result）同样会产生新的 cache write。三个假说**可以同时成立**，且都未排除服务端路由漂移、缓存淘汰、断点策略等客户端看不见的原因。

补齐采集后，真正能分辨的口径应当是：

- **按「同一前缀被复用了几次」而非按 round 聚合** —— 需要请求级的前缀指纹或稳定的会话键；
- **read/write 比值**，而非 write 绝对值（§2.1）；
- **区分主会话与子会话**，两者的缓存生命周期完全不同。

以下 SQL 仅可用于**主会话的量级摸底**，不能用于结论：

```sql
SELECT
  CAST(JSON_EXTRACT(metadata,'$.llm_call.round') AS UNSIGNED) AS rnd,
  COUNT(*) calls,
  ROUND(AVG(CAST(JSON_EXTRACT(metadata,'$.llm_call.usage.cache_write') AS UNSIGNED))) avg_write,
  ROUND(AVG(CAST(JSON_EXTRACT(metadata,'$.llm_call.usage.cache_read')  AS UNSIGNED))) avg_read,
  ROUND(AVG(CAST(JSON_EXTRACT(metadata,'$.llm_call.since_prev_ms')     AS UNSIGNED))) avg_gap_ms
FROM chat_messages
WHERE metadata LIKE '%llm_call%' AND created_at >= NOW() - INTERVAL 7 DAY
GROUP BY rnd ORDER BY rnd LIMIT 20;
```

**能读出什么**：主会话的 `cache_read / cache_write` 比值（§2.1 的判据）、以及 input 的量级。

**不能读出什么**：subagent 的任何数据（§3.0b）、TTL 是否过期、前缀是否被裁剪打碎。r1 的判读表基于错误的 `round` 语义，已删除。

### 3.2 按会话来源拆分（覆盖面受限，勿据此下结论）

> ⚠️ 因 §3.0b，`subagent` 行**查不到任何 token**。该查询只能说明各 origin 的**主会话**分布，不能用来证伪或坐实假说 C。补齐采集后此查询才有意义。

```sql
SELECT COALESCE(s.origin,'web') AS origin,
       COUNT(*) calls,
       COUNT(DISTINCT s.id) sessions,
       SUM(CAST(JSON_EXTRACT(m.metadata,'$.llm_call.usage.cache_write') AS UNSIGNED)) cache_write,
       SUM(CAST(JSON_EXTRACT(m.metadata,'$.llm_call.usage.cache_read')  AS UNSIGNED)) cache_read
FROM chat_messages m
JOIN chat_sessions s ON m.session_id = s.id
WHERE m.metadata LIKE '%llm_call%' AND m.created_at >= NOW() - INTERVAL 7 DAY
GROUP BY COALESCE(s.origin,'web')
ORDER BY cache_write DESC;
```

### 3.3 总量视图（确认量级）

> ⚠️ 此查询同样不完整：漏掉 subagent（§3.0b）、`aux_calls` 中的压缩调用、`discarded_llm_calls` 中被路由丢弃的调用，以及 prompt 结尾无后续 agent 调用承载的 aux。另外 **Responses 的 `reasoning` 是 `output` 的子集**，两列不可相加。

```sql
SELECT DATE(created_at) day, COUNT(*) calls,
       SUM(CAST(JSON_EXTRACT(metadata,'$.llm_call.usage.input')       AS UNSIGNED)) input_tok,
       SUM(CAST(JSON_EXTRACT(metadata,'$.llm_call.usage.cache_read')  AS UNSIGNED)) cache_read,
       SUM(CAST(JSON_EXTRACT(metadata,'$.llm_call.usage.cache_write') AS UNSIGNED)) cache_write,
       SUM(CAST(JSON_EXTRACT(metadata,'$.llm_call.usage.output')      AS UNSIGNED)) output_tok,
       SUM(CAST(JSON_EXTRACT(metadata,'$.llm_call.usage.reasoning')   AS UNSIGNED)) reasoning_tok
FROM chat_messages
WHERE metadata LIKE '%llm_call%' AND created_at >= NOW() - INTERVAL 7 DAY
GROUP BY DATE(created_at);
```

---

## 四、优化方案

> **执行顺序已按 review 意见改写。** r1 让 §4.1–4.3 依据一次 SQL"择一优先"，但那个 SQL 判不了（§3.1），而权重最高的假说根本无数据（§3.0b）。**正确顺序是：**
>
> **① 补齐采集与计费口径（§7）→ ② 测量真实请求体积与缓存复用率 → ③ 再决定 TTL / 裁剪 / 子会话优化。**
>
> **§4.4、§4.6 与 §7 可以立即动手**（它们不依赖假说成立）；**§4.1–4.3 与 §4.5 必须等测量结果**。

### 4.1 【假说 A · 待测量】缓存保留期改 long

一行环境变量，`prompt_cache_retention` 由 undefined 变为长保留。

两个前提未确认：**(a)** pi 0.85.1 的 `long` 有条件分支，可能发 `24h`，也可能发 `prompt_cache_options.ttl=30m`，改之前需实际抓一次请求确认发的是哪种；**(b)** 需确认所用的模型网关认不认这个 Responses 字段（§6）。

另外 a2a 占 70% 意味着调用间隔通常很短，TTL 过期作为主因的可能性本来就偏低。

### 4.2 【假说 B · 待测量】裁剪阈值（r1 的修法有误）

> **r1 的修法「改成只影响请求视图、不改写共享对象，前缀就恒定」是错的**：`context-pruning` 本来就只改视图（`:142`起），而缓存看的是**发出去的历史**——只要内容变了照样失效。

可考虑的方向仍是抬高 `SOFT_TRIM_RATIO`（当前 `0.3`），但：

- **不能只动 soft 不动 hard**：soft 提到 0.65–0.7 而 `HARD_CLEAR_RATIO` 留在 0.5，会让 hard 先于 soft 触发，两段裁剪的触发关系被颠倒。要改就两个一起重新设计。
- 收益前提是"缓存复用被裁剪打断"确实在发生，而这**当前测不出来**（正常追加历史同样产生 write）。

`tool-result-context-guard.ts` 的 in-place 改写（`:248`）是另一回事，它的影响会延续到后续轮次，可以单独评估。

### 4.3 【假说 C · 待测量】降低 subagent 的前缀成本

### 4.3 【假说 C】降低 subagent 的前缀成本

两个方向：

- 给 child 传更窄的 `allowedTools`（当前是全量继承，`session.ts:2721`）。child 大多只需要少数几个工具——**这一条不依赖假说成立**，缩小 payload 本身就有收益。
- 让同一个 batch 的 child 共享 `prompt_cache_key`——它们的前缀本来就完全相同。需先确认网关侧按该 key 做亲和。

**但"每个 child 各写一遍前缀"当前无法验证**（§3.0b），能省多少要等采集补齐。

### 4.4 压缩工具描述（无条件做）

优先级从高到低：

| 动作 | 省字符 |
|---|---:|
| `node_exec` 删掉白名单散文（枚举不该进 description） | ~1,600 |
| `spawn_subagent` 教程砍到菜单（只有一个选项） | ~3,000 |
| `BACKGROUND_EXEC_DESCRIPTION` 收敛，不再 7 份内联 | ~3,500 |
| `task_create` / `task_update` 向同文件的 `task_list` 看齐 | ~3,000 |
| 8 个 exec/script 工具归并为 2 个契约的表述 | ~6,000 |

保守砍掉 40%（约 22K 字符 ≈ 5,500 tokens），按 17.1 轮计 **≈ 每次对话省 94K tokens**，且每个 subagent 同样受益。

### 4.5 thinking 默认降档

`session-thinking.ts:8` 的 `?? "high"` 改为 `"medium"` 或按 agent type 区分。SRE 排障未必需要 high，而它同时吃掉 `max_output_tokens` 预算。

### 4.6 补上测量（防止回潮）

- `prompt-inspection.ts` 的预算检查纳入工具块，否则瘦身完还会长回来；
- `model-compat.ts:474` 的成本表填真实单价，让 siclaw 能自报花费；
- Portal 加一个 token 聚合视图，数据本来就在库里（`/admin/dashboard/usage` 当前只 `COUNT(*)`）；
- 上游控制面的 trace 消息接口投影补回 `metadata`（见 §3.0），否则每次排查都要直连数据库。

### 4.7 需要架构改动的

| 动作 | 位置 |
|---|---|
| ~~`BackgroundWorkTurn.next()` 加合并窗口~~ **已撤回**——group 已合并为一次完成，独立路径已有 600ms 窗口 | `background-work-turn.ts:78-79`、`session.ts:312` |
| fallback 候选数加上限（如 3） | `model-routing.ts:455` |
| MCP 工具注入加预算与截断（当前无上限、绕过 `allowedTools`） | `mcp-client.ts:637-648`、`tool-append.ts:19-20` |
| `cluster_list` 加分页/截断（当前不走 `postExecSecurity`，无界 pretty-print JSON） | `query/cluster-list.ts:157` |

---

## 五、不是问题的部分

避免误伤，以下几处已经做得对：

- **skill 是懒加载的**：28 个 skill 的 SKILL.md 共 224KB，但只索引 frontmatter **7KB**（`agent-factory.ts:262-266`）。32 倍的节省已经在位——这正是工具描述该学的模式。
- **tool result 体积管得很紧**：`processToolOutput` 统一 8,000 字符截断（头 3,000 + 尾 3,000，`tool-render.ts:11-13`），唯一调用点在 `security-pipeline.ts:167`，是所有 exec 工具的强制出口。超出部分转 artifact 按需取。
- **`k8s_inspect` 是预算控制的模范**：`MAX_TOTAL_CHARS = 7_000`，刻意低于 8,000，并有 `worstCaseChars()` 从 relation 表算上界 + 测试盯着。它本身就是为省往返而生的。

---

## 六、未确认的前提

无法从代码确定，需要业务侧确认后才能定优先级：

1. **模型服务方的 cache write / read 实际单价是多少？** §2.1 用的 1.25× / 0.1× 是常见值，**不是实测单价**。
   > r1 曾据"存在独立 cache_write 项"推断是 Anthropic 风格或自建计费，**这个推断不成立**——OpenAI 官方对 GPT-5.6 及以后模型同样有 cache-write 计价。单价必须查实际计费规则，回本点（§2.1）随单价变化。

2. **网关的缓存链路是否真的工作？** 客户端发出 `prompt_cache_key` 不能证明任何事——网关是否识别、上游是否命中、是否发生路由漂移或提前淘汰，都要在网关侧确认。

3. **网关认不认 `prompt_cache_retention`？** 它是 OpenAI Responses 的字段。另需确认 pi 0.85.1 在你们这条 compat 分支上**实际发的是 `24h` 还是 `prompt_cache_options.ttl=30m`**——抓一次真实请求即可。

---

## 七、Token 可观测性建设

**已有的能力**：`siclaw_tokens_total{type,provider,model,user_id}` 与 `siclaw_cost_usd_total` 两个 Prometheus counter（`shared/metrics.ts:75-88`）。所以本章**不是从零建设**——r1 写"没有任何 token 读取能力"过满，已更正。

**缺的是**：调用级明细与下钻能力（counter 无法按会话/请求回溯，也无法回答"同一前缀复用了几次"），以及 §7.2 那三个采集缺口导致的**覆盖不全**——subagent 的消耗既不在 counter 里，也不在库里。

### 7.1 目标

| 视图 | 受众 | 维度 |
|---|---|---|
| 开发者平台 dashboard | 平台开发者 | 按 **provider / model** 的 token 与成本统计 |
| 管理员视图 | 管理员 | 按**用户**（平台用户 + 渠道用户）的 token 消耗 |
| 排查视图 | SRE / 开发 | 按 round / origin 下钻，即 §3 的诊断能力常态化 |

指标口径统一为五项：`input` / `output` / `reasoning` / `cache_read` / `cache_write`，外加派生的**缓存命中率**与**成本**。

### 7.2 数据来源：envelope 够用，但**采集路径不完整**（r1 此处错误）

`LlmCallEnvelope`（`llm-call-recorder.ts`）本身携带了所需字段：

| 需要的维度 | envelope 中的位置 |
|---|---|
| 五项 token | `usage.{input,output,reasoning,cache_read,cache_write}` |
| provider / model | `model.{provider,id,response_model}` |
| 轮次 / 间隔 | `round`（**prompt 内**轮次，每 prompt 重置）、`since_prev_ms`（首轮为准备耗时） |
| 重试 / 附属 | `attempt`、`aux_calls`（压缩调用） |

**但落库路径有三个缺口，必须先补**：

| 缺口 | 位置 | 后果 |
|---|---|---|
| **subagent 不落 `llm_call`** | `session.ts:2921-2945` | 子会话 token **完全缺失**；且 `if (text)` 守卫使无正文的调用不落行 |
| `aux_calls` / `discarded_llm_calls` 需展开 | `sse-consumer.ts` | 压缩调用与被路由丢弃的调用不计入，低估用量 |
| prompt 末尾的 aux 无承载 | 同上 | 没有后续 agent 调用来挂载，**直接丢失** |

> **r1 写的"不需要新增采集，只需要新增存储与读取"是错的，已撤回。** 正确表述是：**先补采集，再谈聚合**。至于回灌：Portal 侧确实没有 subagent 的 `llm_call`，但 pi 的 JSONL 里另有一份（r3 补正），**可回灌范围待查**，见 §7.7。

**统计口径注意**：Responses 的 `reasoning` 是 `output` 的**子集**，五项不可直接相加；展示与求和时需明确口径，否则 output 会被重复计算。

### 7.3 决策一：聚合方式（需 review）

| 方案 | 改动量 | 问题 |
|---|---|---|
| A. 直接 `JSON_EXTRACT` 查 `chat_messages` | 零 | `metadata` 是 TEXT，配合 `LIKE '%llm_call%'` 即全表扫。当前 7 天就有 ~5 万条工具消息，不可持续 |
| **B. 新建 `llm_calls` 事实表，写入时同步落** | 中 | **推荐**。一次模型调用一行，维度列独立成列可索引 |
| C. 在 B 之上加日粒度 rollup | 小 | dashboard 查 rollup，排查查事实表 |

建议 **B + C**：事实表保证可下钻，rollup 保证 dashboard 快。A 仅用于本次一次性定位（§3）。

事实表的最小列集：

```
llm_calls(
  id, org_id, user_id, session_id, message_id,
  agent_id, agent_type, session_origin,
  provider, model_id, api_type,
  round, attempt, since_prev_ms,
  input_tokens, output_tokens, reasoning_tokens,
  cache_read_tokens, cache_write_tokens,
  cost_micros,                    -- 见 7.5
  occurred_at
)
```

索引至少覆盖 `(org_id, occurred_at)`、`(provider, model_id, occurred_at)`、`(user_id, occurred_at)`。

### 7.4 决策二：归属维度（r1 的前提有误）

> **r1 称"token 会挂在没有主人的子会话上"，错。** 子会话建会话时即写入 `request.userId`（`session.ts:2829`），**有主人**。真正的缺口是那些会话**没有 token 数据**（§7.2），不是归属丢失。

归属仍需设计，但要解决的是另一组问题：

| 维度 | 说明 |
|---|---|
| **用户** | 子会话已带 `user_id`，直接可用 |
| **根请求关联** | 需要把子会话的消耗归拢到发起它的那次请求上，才能回答"这一次排障花了多少钱" |
| **入口归属** | `PARENT_ATTRIBUTED_ORIGINS` 解决的是入口口径；注意 **`task`（定时任务）不在该列表**——它本身就是独立入口，无父可继承 |
| **调用去重** | 同一次调用可能经多个事件抵达，事实表需要稳定的去重键（参考 `llmCallEnvelopeKey` 的构造） |
| **缺失 usage** | provider 未返回 usage 时要显式标记，不能记 0 混入统计 |
| **渠道发送者** | 见 §7.6 |

另注意 `adapter.ts` 有 HTTP + WS 两套镜像查询，改一处不够；孤儿行（父已删除）需要显式处理，不能落进任何用户的账。

**仅在 SSE 写入点旁 double-write 是不够的**——那条路径本身就漏了 subagent（§7.2）。采集点应当放在更靠近 `llm-call-recorder` 的位置，或在子会话持久化路径上同步补写。

### 7.5 决策三：成本单价（需 review）

当前 `model-compat.ts:474` 的成本表硬编码全零，所以 `getSessionStats().cost` 对所有 Portal 托管模型永远返回 $0。

单价存哪里有两种选择：

| 方案 | 问题 |
|---|---|
| `model_entries` 加价格列 | 简单，但价格变更后历史数据会被按新价重算 |
| **独立 `model_pricing` 表，带生效时间** | **推荐**。历史账单按当时单价计算，价格调整可追溯 |

单价需要区分四档：`input` / `output` / `cache_read` / `cache_write`——正是 §2.1 那张表，缺任何一档都算不出 cache 是省钱还是赔钱。

建议事实表落库时即算出 `cost_micros` 冻结下来，而非查询时 join 价格表：一来避免历史重算，二来 dashboard 不必每次做区间匹配。

### 7.6 决策四：渠道用户的身份（需 review · 有硬约束）

需求里的"飞书用户"不能直接复用平台用户 id —— 渠道消息的发送者未必绑定过平台账号。现有的渠道审计已经确立了口径：以 **sender 的渠道原生标识（open_id + channel_id）** 归属，不引入外部平台的用户 id。

> ⚠️ **上游仓库约束**：`github.com/scitix/siclaw` 内不得出现上游控制面的产品名、内部仓库路径或内部表名。涉及该侧的表述一律用中性词（如 "Upstream mode"）。本功能的列名与文案需遵守。

因此用户维度实际是两类主体，dashboard 需要分别呈现而非强行合并：

- **平台用户**：`chat_sessions.user_id`
- **渠道用户**：渠道原生 sender 标识，可能无对应平台账号

### 7.7 落地顺序

0. **先补采集**（§7.2 的三个缺口）：subagent 路径落 `llm_call`、展开 `aux_calls` / `discarded_llm_calls`、处理 prompt 末尾无承载的 aux。**这是前置条件，跳过它后面全部失真。**
1. 建 `llm_calls` 事实表（`migrate.ts` 需同时兼容 MySQL 与 SQLite，禁用 `JSON` 列类型），采集点见 §7.4 末段
2. 补 `model_pricing` 与 `cost_micros` 计算；同时修正 `model-compat.ts:474` 的零成本表，让现有 `siclaw_cost_usd_total` 也恢复有效
3. 开发者平台 dashboard：provider / model 维度
4. 管理员视图：两类用户主体
5. rollup 表 + 排查下钻视图
6. 回填：**可回灌范围待定，先查再定**。Portal 侧确实没有 subagent 的 `llm_call`，但 **pi 的 SessionManager 会把完整 assistant 消息写入 JSONL，且无正文的 assistant 也能携带 usage**（0.85.1 已合成验证）。所以 r1 的"历史不丢"与 r2 的"无可回灌"**都过满**。

   待查清单（P0 的一部分）：
   - `SessionManager.create(process.cwd())`（`agent-factory.ts:427`）的 session dir 实际落在哪，是否在 NFS/PVC 上——注意它与 `userDataDir`（`:468`）是分别计算的，不一定同路径；
   - agentbox pod 回收后 JSONL 是否留存、保留多久；
   - 历史覆盖率（多少比例的会话还能找到 JSONL）。

   查清之前，回填规模不做承诺；回填后的数据必须标注覆盖范围，避免被当作全量

### 7.8 P0 方案定稿（已对齐，可开工）

经两轮 review 对齐，P0 = **完整调用采集 + 固定样例计量报告**。Dashboard、价格表、rollup 全部后置。

#### 7.8.1 采集架构：core 只产事件，Runtime 负责持久化

在 recorder / 执行适配边界统一生成调用记录，AgentBox 经 `GatewayClient` 交给 Runtime 落库——**core 不直接写数据库**。

**aux、无正文、失败调用独立结算**，不再等待下一条聊天消息承载（这正是 §7.2 第三个缺口"prompt 末尾的 aux 无承载"的解法）。

#### 7.8.2 `round`/`attempt` 不能当唯一 ID —— 必须新增 `call_id`

> ⚠️ r3 早先写"用 `round`/`attempt` 关联 usage"是错的：
> - `round` **每个 prompt 重置**（`llm-call-recorder.ts:49`）；
> - **aux 调用的 `round` 为 0**，多条 aux 无法互相区分。

正确做法：

| 标识 | 用途 |
|---|---|
| **`call_id`（新增，稳定唯一）** | 关联 session、prompt、父／根请求；**投递重试按它去重** |
| 底层 HTTP 重试 | **另记为网络尝试**，不与 `call_id` 混淆 |

#### 7.8.2b 记录结构（第 1 步产物）

**设计原则：来源在产生处显式记录，不做事后推断。**

> ⚠️ 早先提议用 `stop_reason === "pending"` + 「该 session 是否 handoff 过」推断来源，**已作废**。两个反例（Pi 0.85.1 合成验证）：
> - **未返回 usage 也能正常结束为 `stop_reason: "stop"`**，异常路径还会变成 `error`/`aborted` —— 查 `pending` 会漏判；
> - **重建不只由 handoff 触发**。`session.ts:3193-3210` 的分支表明：会话被驱逐（`evictedSessions`）、或本地历史缺失（`!hasRestorableSessionContext`，**pod 重启后的常态**）都会从控制面重建。且**同一 session 内可能混有重建消息与其后的真实调用** —— 按 session 判断必然出错，**只能逐消息／逐调用标记**。

```ts
interface LlmCallRecord {
  // ── 身份：call_id 对应一次真实调用的生命周期 ──
  call_id: string;              // 稳定唯一；投递重试按它去重
  session_id: string;
  prompt_id: string;            // 一次 prompt（含其多轮）
  root_request_id?: string;     // 根请求，跨父子关联
  parent_call_id?: string;      // 发起该 subagent 的调用

  // ── 分类：round/attempt 仅供诊断，不作标识 ──
  kind: "agent" | "aux";
  round: number;                // prompt 内轮次，每 prompt 重置；aux 为 0
  attempt: number;              // 模型路由尝试
  network_attempts: number;     // 底层 HTTP 重试，独立计，不产生新 call_id

  // ── 模型 ──
  provider: string;
  model_id: string;
  api_type: string;

  // ── usage：状态与来源分开，token 可空，一律存服务端原值 ──
  usage_status: "reported" | "partial" | "missing" | "unknown";
  usage_source: "provider" | "sdk_default" | "rehydrated" | "unknown";
  reported_fields: string[];    // 服务端实际报告了哪些字段（按该 API 的契约判定）
  input_tokens_total:  number | null;  // 原值；Responses 下含 cached + cache-write
  output_tokens_total: number | null;  // 原值；含 reasoning
  reasoning_tokens:    number | null;
  cache_read_tokens:   number | null;
  cache_write_tokens:  number | null;

  // ── 请求快照：缓存与裁剪验证的依据 ──
  request_snapshot: {
    prompt_cache_key: string | null;
    cache_retention_sent: "none" | "24h" | "ttl_30m" | null;  // null = 未发送该字段
    model_settings: Record<string, unknown>;   // thinking level、max_tokens 等
    system_sha256: string;
    tools_sha256: string;
    history_prefix_sha256: string;   // 历史前缀指纹，用于识别裁剪/改写
    history_message_count: number;
  };

  // ── 请求计量：三个口径互不替代 ──
  payload_bytes: number | null;            // 真实请求体字节
  payload_tokens_estimated: number | null; // 本地估算

  // ── 时间 ──
  request_at: string;
  response_end_at: string;
  since_prev_ms: number | null;  // 首轮为准备耗时，非距上次提问

  // ── 归属 ──
  org_id: string; user_id: string | null;
  agent_id: string; agent_type: string; session_origin: string;

  // ── 成本：P0 阶段一律 null（单价未核实）──
  cost_micros: null;
}
```

**三组语义的判定规则**：

| 字段 | 规则 |
|---|---|
| `usage_source` | 响应适配层按**服务端是否报告**打 `provider` / `sdk_default`；恢复路径（`writeRehydratedSession`）打 `rehydrated`；历史无标记则 `unknown` |
| `usage_status` | 按**该 provider/API 的字段契约**判定「全」，**不能固定要求五项都在**——不同 API 报告的字段集本就不同。全 → `reported`；部分 → `partial`；SDK 占位 → `missing`；来源不可信 → `unknown`。⚠️ **空的 `reported_fields` 自身区分不了 `missing` 与 `unknown`**，必须结合 `usage_source` 的采集证据 |
| token 字段 | **明确报告的零保留为 `0`**；未报告一律 `null`。`null ≠ 0` 是本设计的核心约束 |

**派生值走共享 helper，不靠各消费方记纪律**：

```
output_non_reasoning_tokens = output_tokens_total - reasoning_tokens
input_tokens_uncached       = input_tokens_total - cache_read_tokens - cache_write_tokens  // 仅 Responses
```

**任一输入为 `null`，派生结果即为 `null`。** 正确聚合放进共享实现 + 测试，避免「不可相加」变成每个消费方得记住的口头约定。

> ⚠️ **`usage.input` 在两个协议下语义不同，这是必须存原值的硬理由**：
> - **Responses**：pi 已扣除缓存部分 —— `input: Math.max(0, input_tokens - cachedTokens - cacheWriteTokens)`（`openai-responses-shared.js:441-445`，注释原文 "OpenAI includes cached and cache-write tokens in input_tokens, so subtract both"）。那个 `Math.max(0, …)` 钳制**又是一个零的来源**。
> - **Anthropic**：`usage.input = input_tokens` 直接赋值（`anthropic-messages.js:409`），原始值本就不含 cache。
>
> 直接存 pi 的 `usage.input` 会得到「未缓存输入」而非「总输入」，且跨协议不可比。

**重建消息不是调用**：`writeRehydratedSession` 产出的合成 assistant 消息**不分配 `call_id`、不入事实表**——否则虚增调用数。

> ⚠️ **但也不能反推丢了多少调用**：一条工具结果同样会生成合成 assistant，**消息数 ≠ 原始调用数**。覆盖率报告只记「排除的重建消息数／会话数」，**无法确认的调用数保持 `unknown`**，不做估算。

#### 7.8.3 缺失语义进 schema —— 以及 pi 的全零陷阱

`usage_status` 四态：`reported` / `partial` / `missing` / `unknown`；token 字段**可空**；报告同步展示覆盖率。

> ⚠️ **pi 0.85.1 在发请求之前就把 usage 初始化为全零**（`openai-responses.js:94-101`，此时 `stopReason: "pending"`）。因此：
> - **不能只检查 `message.usage` 是否存在**——它总是存在；
> - **不能把全零直接判成缺失**——`cache_read = 0` 是完全可能的真实值。
>
> 必须在**响应适配层**保留"服务端是否报告、哪些字段实际存在"的信息。
>
> **全零共有三个来源**（见 §7.8.7）：pi 的请求前初始化、handoff 后 `ZERO_USAGE` 重建、以及真实的零值。三者在数据里无法自动区分，**无法判定来源的一律标 `unknown`，不得填零**。

#### 7.8.4 保留现有变更回调，并行新增逐调用计量回调

现有 `onModelEnvelope`（哈希变化时触发）**不改语义**——它有明确的现存契约：KBC worker 用它发送 `model_envelope` 事件，SDK 契约测试要求"两次请求、一次变更回调"。外部日志消费者未知，P0 没有必要动它。

计量走**新增的逐调用回调**。

#### 7.8.5 验证：双层，且网关测试不需要真实集群

| 层 | 覆盖 | 方式 |
|---|---|---|
| **离线夹具** | 主／子会话、aux、失败、重试、取消、缺失 usage、去重与关联 | 复用现有测试设施 |

**必须覆盖的五个反例**（都来自 Pi 0.85.1 合成验证，每一个都能让朴素实现判错）：

1. **正常结束但无 usage** —— `stop_reason: "stop"` 配全零 usage，不能判成 `reported`
2. **失败／取消后的初始化零** —— `error` / `aborted` 同样带全零
3. **无 handoff 的重建** —— 驱逐或本地历史缺失即可触发
4. **重建与真实调用混合在同一 session** —— 证明按 session 判断不可行
5. **明确报告的 `cache_read = 0`** —— 必须保留为 `0`，不得转成 `null` 或判为缺失
| **真实网关** | 冷／热缓存、历史追加、裁剪 | **固定合成输入 + 合成工具定义**，打真实网关 |

缓存参数有**三种**形态需覆盖，不是两种：pi 默认 `short` 时**根本不发**这两个字段；`long` 分支才可能发 `prompt_cache_retention: "24h"` 或 `prompt_cache_options.ttl=30m`。离线夹具覆盖全部三种，真实请求验证当前走哪条。

> ⚠️ **网关返回成功只说明它接受了请求，不能证明兑现了 TTL。** 短期重复请求也只验证当时命中。

真实 SRE 剧本留给后续的任务质量与 `run_script` 收益评估，**不进 P0**。

#### 7.8.6 交付物

1. 固定夹具
2. 网关探测脚本
3. **机器可读结果**
4. 报告：记录版本／配置／覆盖率

可重复脚本是硬要求——否则后续改动（如 `defer_loading`）无法证明收益。

#### 7.8.7 JSONL 回灌：路径已确定，剩余为部署侧待查

child **不走** factory 的默认 `SessionManager.create()`，而是显式传入 `continueRecent(cwd, childSessionDir)`（`session.ts:2683`）。目录由代码确定：

```
resolve(process.cwd(), config.paths.userDataDir)/agent/sessions/<childSessionId>
```

（`session.ts:755-774` 的 `getBaseSessionDir()` + `getSessionDir()`）

**K8s 侧代码事实**：

- `userDataDir` 默认 `.siclaw/user-data`，可被 `SICLAW_USER_DATA_DIR` 覆盖（`config.ts:259,401`）
- agentbox pod 显式设 `PI_CODING_AGENT_DIR = .siclaw/user-data/agent`（`k8s-spawner.ts:590`）——pi 目录确实在 user-data 之下
- `user-data` 卷在 PVC 与 `emptyDir` 之间二选一（`k8s-spawner.ts:726-730`）

> ⚠️ **r4 据此写成"一个全局二元开关"，错了。** 决策是**逐 agent**的（`k8s-spawner.ts:706-713`，注释原文 "Persistence decision is per-agent"）：
>
> ```ts
> const wantsPersistence = boxConfig.persistence ?? !!this.config.persistence?.enabled;
> const persistenceEnabled = wantsPersistence && !!persistenceClaimName;
> ```
>
> 全局关闭时单个 agent 仍可挂 PVC，反之亦可显式关闭。**必须查目标 Pod 的实际 volume / mount / subPath**，而且**当前配置不代表历史配置**。

#### 存储可用 ≠ 数据可信（本轮最重要的一条）

即使 JSONL 文件在，里面的 usage 也**可能是占位零**：

| 全零的来源 | 位置 | 含义 |
|---|---|---|
| pi 发请求**之前**的初始化 | `openai-responses.js:94-101` | 服务端从未报告 |
| **handoff 后从控制面重建** | `session-rehydrate.ts:84,148,172` 的 `ZERO_USAGE` | 原始记录**已被删除**后重建的历史 |
| 真实的零值 | — | `cache_read = 0` 完全合法 |

handoff 会调 `removeCachedSessionTranscript()`（`session.ts:3151`，调用点 `:3202`、`:4070`）删掉旧 JSONL，之后重建的 assistant 消息带 `ZERO_USAGE`。

**所以回灌必须做来源核验**：三种全零在文件里长得一样，含义完全不同。无法判定来源的一律标 `unknown`（§7.8.3），**不得填零**。

反向的一条也成立：**使用 `emptyDir` 的 Pod 只要尚未删除，数据仍可提取**——不是"关了 persistence 就一定没有"。

#### 已从代码排除的一项

r4 担心 `scheduleToolOutputCleanup`（`session.ts:768`）会清掉 JSONL——**可以排除**。`sweepSessionToolOutputs` 只进入 `<session>/.tool-results` 子目录（`tool-output-cleanup.ts:20-21`），不碰会话 JSONL；每个 base 只注册一次，启动清扫后每十分钟跑一次，其 24 小时窗口是 tool-result 产物的保留期，不是 JSONL 的。

**剩余待查（需要生产环境）**：

1. 目标 Pod 的**实际** volume / mount / subPath（逐 agent，且历史配置可能不同）
2. 抽样核验：文件里的 usage 是原始记录还是 `ZERO_USAGE` 重建
3. 历史文件的实际覆盖率

顺序建议：**先查配置 → 再抽样 → 最后才谈覆盖率普查**。但来源与覆盖率核验不可取消。


#### 7.8.8 两项不阻塞 P0 的前提

| 项 | 处理 |
|---|---|
| 实际单价未核实 | **先只记 token，成本字段留"未知"**，不因缺价格而阻塞采集 |
| 网关缓存链路是否工作 | **它是实测结果，不是前提**。注意：短期重复请求只能验证当时命中，**不能证明网关兑现了长期 TTL** |

### 7.8.9 P0 实现记录

分支 `worktree-token-metering-p0`，基线 `946e0675`。经多轮 review 修订，根仓库全量 **373 文件 / 7592 测试通过**、portal-web **32 文件 / 280 测试通过**，两侧 `tsc --noEmit` 均干净。

#### 落地文件

| 文件 | 作用 |
|---|---|
| `src/shared/llm-call-record.ts` | 记录结构、协议契约表、派生 helper、一致性校验 |
| `src/shared/llm-call-validation.ts` | 线上契约，发送与接收共用 |
| `src/core/raw-usage-observer.ts` | HTTP 层原始 usage 观察 + 最终请求指纹 |
| `src/core/llm-call-recorder.ts` | 注入 fetch、产出 measurement（**附加式**） |
| `src/shared/session-rehydrate.ts` | 重建消息打 `rehydrated` 标记 |
| `src/agentbox/llm-call-dispatcher.ts` | 批量投递：有界队列、重试、交付统计 |
| `src/agentbox/session.ts` | 主/子会话接线 + 四条关闭路径收尾 + 子代理继承请求关联 |
| `src/agentbox/http-server.ts` | 把 `turnId` 绑成该轮的请求关联 |
| `src/gateway/channels/{lark,dingtalk}.ts`、`task-coordinator.ts` | 在入口铸稳定 turn id（此前这三条路一个都没带） |
| `src/gateway/llm-call-api.ts` | 接收端：校验、归属解析、持久化 |
| `src/portal/llm-call-repo.ts` | 按 `call_id` 幂等写入 |
| `src/portal/llm-usage-repo.ts` | 读取端聚合：按 provider×模型 / 按用户，服务端排序 |
| `src/portal/siclaw-api.ts` | `GET /metrics/token-usage`（admin） |
| `portal-web/…/TokenUsageCard.tsx`、`useMetrics.ts` | Portal 上的用量表（四列 + 可排序 + 覆盖率） |
| `src/portal/migrate.ts` | `llm_calls` 事实表 + 3 个索引 |
| `scripts/smoke/token-cache-probe.mjs` | 网关探测脚本（三种 retention 形态） |

#### 采集为何在 HTTP 层

`streamFn` 边界只能看到 pi 归一化后的 usage，而 pi 在请求发出前就把 `input`/`output`/`cacheRead`/`cacheWrite` 初始化为全零且类型必填——**"报了 0"与"没报"在那里不可区分**。`reasoning?` 也不是可用信号（实测未报告时被填为 `0`）。

因此改用 `options.fetch`（pi 公开入参）：逐调用组合、不替换调用方自带的 fetch、tee 响应体、**原始字节原样交给 SDK**，只在自己那份上解析。

#### 三值语义与四种零

| 概念 | 取值 |
|---|---|
| `usage_source` | `provider` / `sdk_default`（读到了，确实没有）/ `rehydrated` / `unknown`（没读到或未插桩）|
| token 字段 | `number`（含明确报告的 `0`）或 `null`（未报告）。**`null ≠ 0`** |
| `request_snapshot.cache_retention_sent` | 字段缺失=未采集；`null`=采集了且确认未发送；`"24h"`/`"ttl_30m"`/`"none"` |

已知会产生全零的四条路径：pi 的请求前初始化、`session-rehydrate` 的 `ZERO_USAGE`、`Math.max(0,…)` 钳制、真实的零。它们在数据里长得一样，所以来源**在产生处打标**，不做事后推断。

#### review 修订记录（各轮暴露的实际缺陷）

| 问题 | 修法 |
|---|---|
| 时序竞态：seal 同步、观察异步 | measurement 等待观察，250ms 宽限后降级 `unknown` |
| 重试只记首次响应 | 每次 attempt 独立 latch + 编号；取**最后发起**的那次 |
| Anthropic input/cache 被丢弃 | 按**字段合并**而非整体覆盖（`message_start` 与 `message_delta` 各带一半）|
| 观察失败被记成"服务端未报" | 三态 `outcome`，失败归 `unknown` |
| 延迟记录串到下一个 prompt | `promptId` 在 `openCall` 时快照 |
| SSE 按行拆分 | 按空行分帧，帧内多个 `data:` 按规范拼接 |
| 坏帧被已读 usage 掩盖 | 有坏帧或**无终态标记**即 `failed`，values 保留作证据 |
| 瞬时发送失败永久丢批 | 确认前不出队，退避重试 3 次 |
| 上限没约束在途批次 | 单队列单消费循环，`queue + inFlight` 统一计数 |
| 空队列 flush 后永久卡死 | 空队列不进入 draining 状态 |
| `close` 无时间上限 | 墙钟预算 5s，超时部分计入 `dropped` 并清空 |
| 预算信号晚于它要限制的等待 | `close` 设置截止时刻的**同时**就挂定时器：在 close 之前开始的发送没有 deadline 可挂定时器、只挂在 cutoff 闩上，而 close 自己的 `await drain()` 等的正是那次发送——把信号放在循环之后，等于让限制者等待被限制者（实测 5s 预算跑到 9s） |
| 并发收尾丢尾部 | 按 session 共享同一个收尾 Promise |
| 收尾漏掉未结束的调用 | `activeCalls` 跟踪，先等调用再等 measurement |
| 指纹取自 SDK 输入 context | 改取**最终请求 body**（`onPayload` 可改写 instructions）|

#### 主子关联：一次用户请求的完整开销

子代理的调用本来就是这套计量要补的那块（Portal 从没见过它们），但"补上了行"不等于"能按请求汇总"——还得知道**哪些行属于同一次请求**。

契约有三条，每条都对应一种实际会算错的形态：

**一、关联由生产方带，绝不在接收端推。** 只有 box 知道一次调用服务的是哪个 turn。接收端能拿到的只有会话血缘，而一段对话里的多次请求共用同一个会话——按血缘推会把整段对话折成一个 id。所以 `root_request_id` 走 measurement 本身，接收端只在生产方**没带**时写 `null`（旧版 box），不自己造。

**一之二、两个问题，两个字段。** `root_request_id` 只回答"这些调用属于同一次请求"，回答不了"是**哪一次模型调用**派发了这个 child"。后者是 `parent_call_id`，同样由生产方带：tool-call id 命名的是工具调用、不是产生它的那次 LLM 调用；会话血缘更看不出一个 turn 的哪一轮做了派发。取值是**刚封口的那次 agent 调用**——它的 tool 正在执行，正是派发者；aux 调用（摘要之类）不发工具，跳过，否则会指认一个不可能派发的调用。下一轮开始就会覆盖它，所以必须在 dispatch 那一刻同步读。

**二、复用 `turnId`，不另造协议字段。** `turnId` 已经是"一次被接受的 prompt 执行"的标识，且**跨 model-routing 重试保持不变**——重试是同一次用户请求换个候选模型，正是需要归到一起的情况。再造一个 id 只会多出一个要对齐的东西。

**二之二、id 在入口铸，不在 client 铸。** `chat.send`（web / api / a2a 都走它）本来就会补 `turnId`，但飞书、钉钉、定时任务是**直接调 `AgentBoxClient`** 的，此前一个 id 都没带——这些入口的每一次调用（含子代理）都落成无关联的行。补在 client 里是错的：**一个 turnId 命名一个 turn，而 client 是每次 attempt 调一遍**，`promptWithBusyRetry` 会重试，那样一条消息会裂成两个关联。所以在构造 `promptOpts` 处铸，重试复用同一个对象。定时任务直接用已有的 `runId`——它本来就命名这次执行，这样计量行与运维看的那条 run 记录天然对齐。

> 仍有一处没覆盖：上游模式下走 `ConversationClient → conversation.start` 的那条路，turn 身份由控制面派发时决定，不在本仓库内。

**三、子代理在 dispatch 时刻快照继承，不事后回读父会话。** 与 trace id 完全同一个理由：后台子代理可能在父 prompt 结束、甚至父会话已释放之后才启动，那时回读得到的要么是空，要么是另一次请求的值。因此捕获点在 `createSpawnSubagentExecutor`（父 turn 还活着），随 `SubagentDispatchContext` 一路传到每个 child。

三种刻意留 `null` 的情况（都是"不知道"而不是"没有"）：

| 情况 | 为什么是 `null` |
|---|---|
| 旧版 box 不带该字段 | 加性上线的代价，不能靠猜补齐 |
| 上游模式下走控制面 `conversation.start` 的 turn | turn 身份在控制面那侧决定，本仓库看不到 |
| synthetic turn（后台任务完成后唤醒父会话） | 它不属于任何一次用户请求；且通知会**合并**，一个 turn 可能同时回应来自不同请求的多个 job。开销仍归到 session/agent/user，只是不折进某一次请求 |
| id 超过列宽（64 字符） | 截断会把不同请求的调用**串到一起**；宁可丢关联也不丢测量——行照写，只是 `root_request_id` 为空，并 warn 一次 |

#### 读取端：聚合的三条纪律

采集侧花了很大力气把"报了 0"和"没报"分开，而**聚合正是这些区分被重新抹掉的地方**。所以下面三条不是各调用方自己注意，是写进 `llm-usage-repo.ts` 的：

**一、`SUM(col)` 会跳过 NULL。** 一个字段只有一半调用报了，`SUM` 照样给出一个**看起来像总数**的数。所以每个字段都返回 `{total, reportedCalls}` 两个值，页面拿 `reportedCalls` 和该行的 `calls` 一比就知道这个和的分母是多少；不等时标星号并在 hover 里写明"N 次中的 M 次"。全都没报时 `total` 是 `null`、渲染成 `—`，**绝不写 0**。

**二、不可信的行排除在外，且把排除了多少说出来。** `sdk_default` / `rehydrated` / `unknown` 的行全是零，混进 SUM 会静默拉低每个数字。它们不参与求和，单独计数，接口返回 `coverage: {trustworthy, excluded}`，卡片上直接显示 `7/10 measured`——否则一份覆盖不全的统计和完整的长得一模一样。

**三、"总 token"在不同协议下是不同的算式。** openai-responses 的 `input_tokens` **已经包含** cache 部分，anthropic-messages 不包含。五列一视同仁地加，会在前者上把每个缓存 token 数两遍、在后者上少数。所以聚合**按 `api_type` 分组**，再逐组调 `billableTokens()`——那条规则在 `llm-call-record.ts` 里只有一份，不在 SQL 里再答一遍。一个 actor 的调用跨了协议时打 `mixedProtocols` 标记；其中任何一片算不出来，整个 actor 的总数就是 `null`，不拿已知的那部分冒充总数。

补充两条：

- **排序在服务端。** 结果是**截断**的，把返回的那一页在浏览器里重排会排错行——"cache write 最高的 50 个"不等于"总量最高的 50 个里 cache write 最高的"。`sort` 参数支持 `billable / input / output / cacheRead / cacheWrite / calls`，截断在排序**之后**。
- **算不出总数的行排最后，不当 0。** 它不是"最便宜的那个"，是"算不出来的那个"——按 0 排会把一个可能很贵的对象沉到底，而那正是这张表要找的东西。

actor 维度要**沿父会话取身份**：`sender_external_id` 只盖在渠道会话上，子代理的子会话没有。注意不能逐列 COALESCE——子会话**有自己的 origin**（`subagent`），COALESCE 永远取不到父的。判断要先问"这个会话该用谁的身份"（复用 `PARENT_ATTRIBUTED_ORIGINS`），再整体从那一侧读列。

#### 仍未完成

| 项 | 说明 |
|---|---|
| **端到端验证** | 接收端只有单元测试，未跑过真实 box → Runtime；Portal 那张表也只跑过 SSR 渲染断言，没在浏览器里看过真实数据 |
| **上游模式控制台的审计页** | 本轮做的是 **siclaw Portal** 的 Metrics。上游模式下控制台是另一套前端，它的数据得先让 `llmCall.persist` 在那侧落库——两件事 |
| **`org_id`** | 事实表已有该列，缺的是**可信来源**：`chat_sessions` 无此列，而 LocalSpawner 证书里的 `default` 是占位符，填进去等于造一个假租户。按 review 结论先留空——这确实使"按组织汇总"暂不可用，但它是数据缺口，不是本次实现的遗留 |
| **成本** | `cost_micros` 恒为 `null`——单价未核实，错误的成本比缺失更糟 |
| **回灌** | 范围仍取决于 §7.8.7 的部署侧待查项 |

#### 部署顺序（三段，不可颠倒）

数据流是 **AgentBox → Runtime → 数据库持有方**，所以升级必须**逆着数据流**走：接收方先就位，发送方最后。

| 次序 | 组件 | 内容 | 为什么必须在前 |
|---|---|---|---|
| **1** | 数据库持有方（控制面 / Portal） | `llm_calls` DDL + 索引；`llmCall.persist` handler | Runtime 转发无处可去时会 500，且 DDL 未就位时 handler 本身报错 |
| **2** | Runtime | `/api/internal/llm-call-measurements` 路由、校验、鉴权、RPC 转发 | 早于 AgentBox，否则投递撞 404 |
| **3** | AgentBox | recorder / observer / dispatcher / 会话接线 | 最后开采集，前两段已能接住 |

**混合版本期间的行为**（每一段都设计成可降级）：

| 组合 | 结果 |
|---|---|
| 新 AgentBox + 旧 Runtime | 投递 404 → dispatcher 重试耗尽 → 计入 `siclaw_metering_unconfirmed_total`。**不影响对话** |
| 新 Runtime + 旧数据库持有方 | `llmCall.persist` method-not-found → 500 → 同上 |
| 旧 AgentBox + 新 Runtime/DB | 不产出计量，表为空。无副作用 |

**验收**（按段做，不要等全部上完再看）：

1. 第 1 段后：确认表与三个索引存在
2. 第 2 段后：手工 POST 一个合法批次，期望 200 + `inserted`；用**另一个 agent 的证书**打同一 session，期望 **403**
3. 第 3 段后：跑一轮真实对话，查 `llm_calls` 是否有 `usage_source='provider'` 的行，以及 `unconfirmed` counter 是否为 0
4. 第 3 段后：跑一轮**带子代理**的对话，确认父与子的行共享同一个 `root_request_id`，且子的 `parent_call_id` 等于父那一轮的 `call_id`——前者是"一次请求花了多少"的判据，后者是"哪一次调用派发的"，两个都要看
5. 第 3 段后：从**飞书**和**定时任务**各跑一轮，确认 `root_request_id` 非空——这两条路是直连 AgentBoxClient 的，不经过 `chat.send` 的 turnId 补值

**回滚**：逆序回退（AgentBox → Runtime → 控制面）。**表和数据不必回滚**——写入幂等，旧版本不读它，留着即可。只有确认不再启用时才 DROP。

⚠️ `imagePullPolicy: Always` **只在 pod CREATE 时拉取**：存量 pod 继续跑旧代码，拿存量会话验证等于没验证。

### 7.9 顺带解决的问题

该事实表建成后，§3.0 的控制面取数缺口可由它直接回答，不必再给 trace 消息接口的投影补 `metadata`（那会把大量无关字段一起暴露）。§4.6 的"补上测量"亦由本章覆盖。

---

## 附：部署影响

§4.2–4.5 涉及的文件（`src/core/`、`src/tools/`）都在 **agentbox 镜像**里。改完需要：重建 agentbox 镜像 → 更新 `SICLAW_AGENTBOX_IMAGE` → 回收 pod。

注意 `imagePullPolicy: Always` 只在 pod **CREATE** 时拉取，存量 pod 会继续跑旧代码——拿存量会话验证等于没验证。

§4.1 若走环境变量，需确认该变量能透传进 agentbox 容器。
