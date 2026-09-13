# Token 效率三方对比：siclaw / Claude Code / codex

> **修订 r3（经两轮 review）** —— r1 有多处源码误读会把实现带偏，逐条列于下方。**§7 的清单不可按 r1 直接落地。**
>
> **r3 相对 r2 的改动**：① codex 的 Code Mode 只完整渲染 `enabled_tools`，r2 写成「enabled + deferred 全部嵌入」是修过头了；② P0 的「最终请求计量」拆成三个口径，并指出现有哈希是变更事件流而非每轮记录；③ MCP 预算区分「描述截取」与「spec 准入」两种策略，不可并列抄数字；④ `defer_loading` 的「ROI 最高」撤回；⑤ cache key 表述限定模型版本，且不反推为完全零命中。
>
> 对比基线：siclaw `origin/main` @ `946e0675`；Claude Code 源码 `~/project/claude-code-init`；codex 源码 `~/project/codex`（Rust）。
> 姊妹文档：`2026-09-12-token-cost-analysis.zh-CN.md`（siclaw 自身的成本诊断）。

> ⚠️ **对标来源的时效限定**：`claude-code-init` 是 **2026-03 的非官方历史快照**，不代表 Claude Code 当前产品默认行为。快照中多项能力挂在 feature gate 后（聚合预算默认关闭、MCP 可用 `alwaysLoad` 退出延迟、自动阈值有字符估算 fallback）。引用其设计思路可以，**不能当作"业界现状"或默认配置**。

## 修订记录：r1 被推翻的结论

| r1 的说法 | 实际 | 证据 |
|---|---|---|
| codex 工具描述仅 **4,207 字符**，据此得出"胖 prompt 优于多个工具描述" | **数字误导，结论不成立。** 4,207 只是静态 handler spec 字面量；Code Mode 下 `build_exec_tool_description` 把 **`enabled_tools`** 的描述与 schema 生成的 TypeScript 声明动态嵌入 `exec` 的 description（**r3 再修正**：r2 写成「enabled + deferred 全部嵌入」是修过头了——`deferred_tools` 只贡献一个发现提示段与共享类型判断，测试明确断言延迟工具标题不进初始描述）。而且**工具定义同样参与缓存**，挪进 system prompt 本身没有缓存优势。三方应比较**最终渲染请求**，静态字面量不可比 | `code-mode-protocol/src/description.rs:261` |
| "codex 子代理继承父 cache key，是假说 C 的直接答案、配置级改动" | **引用错 + 逻辑错。** `{source}:{parent_thread_id}` 仅走 `SessionSource::Internal` 分支；Guardian 用的是派生的 `guardian:{parent_thread_id}`，**不是父会话原 key**；普通会话回退自己的 `session_id`。更根本的是：**`prompt_cache_key` 是路由分区提示，命中取决于前缀内容**——siclaw 父子的工具集（child 屏蔽 `task_*`/`spawn_subagent`）与 prompt（带 addendum）本就不同，**统一 key 不保证命中**（且作用按模型版本而异；亦不能反推为完全零命中——共同前缀仍可能复用）| `codex-rs/core/src/client.rs:491` |
| `defer_loading` 可无条件启用，收益等同 Claude Code 的"工具只占一个名字" | **两件事被混为一谈。** Claude Code 的 ToolSearch 是**客户端**实现，延迟工具只留 `tool.name`；OpenAI 的 `defer_loading` 是**服务端**特性，**名称和 description 仍进入上下文，主要推迟参数 schema**。要省成员工具描述需设计 namespace/MCP 分组。且官方要求模型支持（GPT-5.4+）并配置 `tool_search`，codex 另有模型/provider 能力检查 | OpenAI tool-search 文档 |
| "裁剪决定冻结"可直接替换 `context-pruning` | **目标不同，直接套用会耗尽容量。** Claude 冻结的是**结果首次进入上下文时的预算处理**；siclaw pruning 是**随历史增长清理旧结果**。若首次"不裁剪"也永久冻结，近期受保护的结果此后无法清理，最终仍会触发其他 guard 或压缩。须把"首次结果预算"与"后续历史压缩"分开设计 | — |
| 缓存断裂检测器能把"猜三个假说"变成"读输出" | **过满。** 它是**变化检测**：持续 `cache_read=0`、大量单轮子会话都不会触发"比上次下降"；只比较 system/tools 也看不到历史消息裁剪。参考实现自己保留了"可能 TTL / 可能服务端 / 未知原因"三档 | — |
| siclaw"无缓存断裂检测""`spawn_subagent` description 运行时拼装是缓存杀手" | **均不成立。** siclaw **已有**最终 payload 的 system/tools sha256 记录，且只在哈希变化时 log；`buildDescription()` 在工具对象构造时调用一次，**同一 session 内稳定**，运行时拼装 ≠ 每轮变化。另已有工具可用性过滤、整体 context guard，最新 main 的 `run_script` 还提供脚本内并发与聚合 | `pi-execution.ts:48-60`、`model-envelope.ts:74-88`、`spawn-subagent.ts:167` |
| siclaw"统一 8,000 字符上限"，建议"超限统一报错" | **都不成立。** 8,000 是**普通执行结果预览路径**的阈值，artifact 回读、其他工具、脚本 SDK 数据路径各有限制。Claude 那个实验只针对 **Read 超限**场景，不能推广到已执行完的命令或 MCP 查询——统一丢结果报错会增加重跑。应比较**完整任务成本**，并保留 artifact 引用与受控回读 | — |
| codex MCP 预算 8K/spec、64K 总计适用于全部 MCP | **仅适用于 agent-plugin MCP**（`agent_plugin_bytes` 只对 `is_agent_plugin()` 的 server 累加） | `core/src/mcp_tool_exposure.rs:99` |

**执行顺序据此改为**：补齐采集与**最终请求计量** → 验证现有 `run_script` 聚合效果 → 做**带能力检查的**工具搜索试点 → 按实测处理前缀变化。**共享 key、冻结裁剪、放宽结果上限降级为实验项。**

---

## 结论先行

**siclaw 有改进空间，但差距不在"描述写太长"，也不像 r1 说的那么一边倒。**

三家每轮都重发全部历史，**没有一家有传输层的增量协议**（codex 的 WebSocket delta 是唯一例外，见 §4）。所以：

> **token 节省 = 缓存命中率工程，不是传输量工程。**

siclaw 缺的主要是**缓存稳定性的制度化**（分区、边界、破坏需申报）和**按需加载**。但要修正 r1 的两处夸大：

- siclaw **已经有**最终 payload 的 system/tools sha256 记录（`pi-execution.ts:48-60`）、工具可用性过滤、整体 context guard，以及最新 main 的 `run_script` 脚本内并发聚合。**不是白纸一张。**
- `defer_loading` **不是**"开了就等于 Claude Code 那套"：它是服务端特性，**名称和 description 仍进上下文，主要推迟参数 schema**；还需模型支持（GPT-5.4+）与 `tool_search` 配置。收益需按 namespace/MCP 分组设计后实测，不能因同协议就全量开启。

---

## 一、三方基础数据

> ⚠️ **这张表的字符数不可直接横比**——三者的统计口径不同，且都不是最终渲染请求的实测值。**要得出可比结论，必须抓三方的真实 payload 计量。** 详见每行脚注。

| | siclaw (SRE) | Claude Code | codex |
|---|---:|---:|---:|
| 模型可见工具数 | **30**（全量注入） | ~22（默认）**+ 26 个延迟** | 2（Code Mode，7/9 模型）ᴬ |
| 工具 description 字符 | 55,551 ᴮ | 60,905 ᴰ | 4,207 ᴬ |
| system prompt 字符 | 12,779 | ~25,889 源码 / 实发 12–20K | 20,903（default.md）|
| 单次工具结果上限 | 8,000 字符 ᶜ | Bash 30,000 字符 / Read 25,000 tok | 10,000 tokens |
| 每轮结果聚合上限 | 无 | 200,000 字符（**默认关闭的 gate 后**）| — |
| 延迟加载工具 | 无 | ToolSearch（客户端，**只留名字**）| `defer_loading`（服务端，**仍留 name+desc**）|
| MCP 描述上限 | **无** | 2,048 字符 | 8 KB/spec、64 KB 总计（**仅 agent-plugin MCP**）|
| 子代理缓存 | 独立 key | 共享父的 rendered prompt + 替换状态 | Internal 分支用派生 key，**非父原 key** |
| 缓存断裂检测 | **已有 payload 哈希**，未接 usage | 有，按维度归因 | 有 telemetry |
| 并行工具调用 | 默认 | **大力鼓励**（4 处提示）| **新模型禁用**，改 Code Mode |

**ᴬ** codex 的 2 个工具 / 4,207 字符**只是静态 handler spec 字面量**。Code Mode 下 `build_exec_tool_description`（`description.rs:301`）把 **`enabled_tools`** 的描述与 schema 生成的 TS 声明动态嵌入 `exec` 的 description，真实上下文成本远高于此；`deferred_tools` 只贡献一个发现提示段，不完整渲染。
**ᴮ** siclaw 的 55,551 是**下界**——只统计 description 与嵌套 description，未计 schema 结构（`task_create` 实测 141 vs 实际 1,047）。见成本分析文档 §1.1。
**ᶜ** 8,000 只是**普通执行结果预览路径**的阈值，artifact 回读、其他工具、脚本 SDK 数据路径各有限制，不是统一上限。
**ᴰ** 条件拼装的工具（Bash / Agent / Grep）按全分支计，单次会话实际渲染更少。

---

## 二、工具体积：两种策略，以及一个不可比的数字

**Claude Code：肥描述 + 延迟加载。** 单个 `BashTool` 12,184 字符、`AgentTool` 11,274、`TodoWriteTool` 9,401——比 siclaw 最肥的 `node_exec`（7,991）还大。但它有逃生阀：

`ToolSearchTool/prompt.ts:115-117` 的核心就三行——
```ts
export function formatDeferredToolLine(tool: Tool): string {
  return tool.name
}
```

延迟的工具**只占一个名字**，没有 description、没有 schema。模型需要时调 `ToolSearch` 把完整 schema 取回，编码与静态列表完全一致。**26 个内置工具标了 `shouldDefer`，MCP 工具一律强制延迟**，自动触发阈值是上下文窗口的 10%（真实 token 计数，非估算）。

例外都写了理由：Agent 工具不延迟，因为"必须第一轮可用，不能藏在一次 ToolSearch 往返后面"。**延迟与否按往返成本逐个论证。**

**codex：静态 spec 很瘦，但真实成本不在那里。** 静态字面量确实是一行：

- `exec_command` — 80 字符："Runs a command in a PTY, returning output or a session ID for ongoing interaction."
- `apply_patch` — 108 字符
- 全部 handler spec 合计 4,207 字符

> ⚠️ **r1 据此得出"胖 prompt 优于 N 个工具描述"，这个结论已撤回。** 两个理由：
> 1. Code Mode 下 `build_exec_tool_description`（`description.rs:301`）把 **`enabled_tools`** 的描述、以及 schema 生成的 TypeScript 声明动态嵌入 `exec` 的 description——工具内容并没有消失，只是换了个位置。（**r3 再修正**：`deferred_tools` 只贡献一个发现提示段与共享类型判断，并不完整渲染；r2 把两者并列是修过头了。）
> 2. **工具定义同样参与缓存**。把内容从 tools 字段挪进 system prompt，本身没有缓存优势。
>
> 真正可比的只有**最终渲染请求**的计量，静态字面量不可比。

**siclaw 的位置**：描述肥度接近 Claude Code，但没有按需加载机制；**30 个工具无条件全量注入，MCP 无上限、无截断、还绕过 `allowedTools`**——最后这条是三家里唯一没有任何 MCP 预算约束的。

---

## 三、缓存稳定性：制度化程度的差距

Claude Code 把"前缀逐字节稳定"当成一等工程约束，建了五层机制。逐条对照 siclaw：

| Claude Code 的机制 | siclaw 现状 |
|---|---|
| **system prompt 分区 + 哨兵边界**：静态段在前（可跨 org 全局缓存），动态段在后，注释写死 "Do not remove or reorder"（`prompts.ts:105-115, 560-576`） | 无分区概念 |
| **破坏缓存要在代码里申报理由**：`systemPromptSection()` 默认 memoize，想每轮重算必须调 `DANGEROUS_uncachedSystemPromptSection(name, compute, _reason)`。全仓只有一个 DANGEROUS 调用（`systemPromptSections.ts:20-38`）| 无此约束 |
| **runtime 布尔挪到边界之后**：前缀里每多一个开关 = 2^N 个前缀哈希变体（`prompts.ts:343-351`）| 条件拼接散在 prompt 组装里 |
| **易变内容改尾部 delta**：MCP instructions 不回头改 system prompt，而是尾部追加一条持久 attachment，按 server 名字 diff（`mcpInstructionsDelta.ts:29-60`）| 无 |
| **tool schema 按 session memoize**：注释直说工具定义在服务端 position 2，**任何字节变化炸掉整个 ~11K token 工具块及下游全部**（`toolSchemaCache.ts:3-11`）| **已等效满足**：`buildDescription()` 在工具对象构造时调用一次，同一 session 内稳定（`spawn-subagent.ts:167`）。r1 称其为缓存杀手，错误。真正要防的是**跨 session 的非必要漂移**与把环境态（集群列表、连接状态）写进 description |

还有两条 sticky 锁存，代价都标了价：beta header 一旦发过就整个 session 继续发（一次翻转 ~50–70K tokens，`claude.ts:1405-1442`）；1h TTL 资格在 bootstrap 锁死（~20K/次，`claude.ts:403-413`）。

**codex 的同类做法**：合成 tool output 的 UUID 命名空间被硬编码，注释写"改这个值会改变模型可见 ID 并使 prompt cache 失效"（`normalize.rs:18-19`）；"Responses Lite" 把 instructions 和 tools 移进 input 数组，ID 用内容寻址的 UUIDv5，**相同内容 ⇒ 相同 ID ⇒ 前缀跨重试与恢复会话字节稳定**（`client.rs:770-802`）。

### 对照 siclaw 的两个已知问题

1. **`context-pruning` 每轮从完整历史重新裁剪**。Claude Code 的对应设计是**决定冻结**（`toolResultStorage.ts:372-412`）。

   > ⚠️ **但不能直接替换 siclaw 的 pruning——两者目标不同。** Claude 冻结的是**结果首次进入上下文时的预算处理**；siclaw pruning 是**随历史增长清理旧结果**。若首次"不裁剪"也永久冻结，近期受保护的结果此后无法清理，最终仍会触发其他 guard 或压缩。
   >
   > 正确做法是**拆成两层**：「首次结果预算」（可冻结）与「后续历史压缩」（必须可持续回收），并补齐容量耗尽、恢复与证据回读规则。降级为**实验项**。

2. **每个 subagent 独立 session、独立 cache key**。

   > ⚠️ **r1 称"共享 cache key 是假说 C 的直接答案、配置级改动"，两处都错。**
   >
   > - **引用错**：codex 的 `{source}:{parent_thread_id}` 仅走 `SessionSource::Internal` 分支；Guardian 用的是派生的 `guardian:{parent_thread_id}`，**不是父会话原 key**；普通会话回退自己的 `session_id`（`client.rs:491-503`）。
   > - **逻辑错**：`prompt_cache_key` 的作用按**模型版本**而异（OpenAI 文档区分 GPT-5.6 前后行为），准确的结论是**同 key 不保证命中**——命中仍取决于前缀内容。siclaw 的 child 屏蔽了 `task_*`/`spawn_subagent`、system prompt 还带 addendum，所以**统一 key 不足以带来命中**；但也**不能推成完全零命中**——父子的共同前缀（公共 system 段、共享工具）仍可能复用，收益取决于**共同前缀有多长**，这需要实测。
   >
   > Claude Code 的做法之所以成立，是因为它连**内容**一起对齐：`renderedSystemPrompt` 在 turn 开始时冻结给 fork 复用，`contentReplacementState` **克隆**，保证 fork 与父产出相同的 wire 前缀（`Tool.ts:301-323`）。**要抄就得抄这一整套，不是只改个 key。** 降级为实验项。

---

## 四、Responses API 特有的机会（附启用前提）

siclaw 走 `openai-responses`，与 codex 同协议。codex 用到的 Responses 原生省 token 能力：

| 能力 | codex 怎么用 | siclaw |
|---|---|---|
| **`defer_loading: true`** | 服务端延迟加载工具定义，MCP 默认延迟（`features/lib.rs:220-223`）；模型调 `tool_search` 按需取回（默认一次 8 个）。codex 另有模型/provider 能力检查，且用的是客户端执行的搜索 | 未使用 |
| **`prompt_cache_key`** | = session id，**刻意冻结**，有测试保证"跨模型/effort 切换都不变"（`prompt_caching.rs:543,811`）| pi 自动设为 sessionId |

> ⚠️ **`defer_loading` 的语义不等于 Claude Code 的 ToolSearch，r1 把两者混为一谈了：**
>
> | | Claude Code ToolSearch | OpenAI `defer_loading` |
> |---|---|---|
> | 实现层 | **客户端** | **服务端** |
> | 延迟的工具在上下文里剩什么 | **只剩 `tool.name`** | **name + description 仍在**，主要推迟**参数 schema** |
>
> 所以在 Responses 上启用它，**省的是 schema 不是描述**。要省成员工具的描述，需要设计 **namespace / MCP 分组**。
>
> 前提还有：官方要求模型支持（**GPT-5.4 及以后**）并配置 `tool_search`。**不能因为协议相同就全量开启**——须先验证实际服务、fallback 行为与子模型，做带能力检查的试点。
| **`previous_response_id` + delta input** | **WebSocket 上**只发增量；**服务端返回的 items 算作已知基线，永不重传**（`client.rs:1220-1257`）| `store:false`，每轮全量重发 |
| 服务端压缩 | `compact_remote_v2.rs` | 无 |

> **注意一个被我先前猜错的点**：codex **也是 `store: false`**（`client.rs:855`），同样拒绝了 stateful HTTP 路线。它的 delta 走的是 **Responses-over-WebSocket**——`previous_response_id` 只出现在 `responses_websocket.rs`，在 `responses.rs` 里**从不出现**。所以"改成 `store: true` 就能省"这个想法两家都没采纳，不要照搬。

> ⚠️ **r1 称 `defer_loading` 是「ROI 最高的一项」「codex 已用成无条件默认」，两句都已撤回。** 它省的是**参数 schema**而非 name+description；需模型支持（GPT-5.4+）与 `tool_search` 配置，codex 另有模型/provider 能力检查。收益必须先按 namespace / MCP 分组设计、再用 P0 的计量实测，**不能凭同协议就判定 ROI**。

---

## 五、结果截断：口径需先对齐再比较

| | 单次上限 | 策略 |
|---|---|---|
| siclaw | 8,000 字符（头 3,000 + 尾 3,000）**——仅普通执行结果预览路径** | 超出转 artifact，可受控回读 |
| Claude Code | Bash 30,000 字符、Read 25,000 tokens、Grep 250 条 | 逐工具设定 + 50K 落盘 + 2KB 预览 + 每轮聚合 200K（**默认关闭的 gate 后**）|
| codex | 10,000 tokens（≈40,000 字符）| 中间截断 50/50 头尾，标注 "…N tokens truncated…" |

> ⚠️ **r1 说 siclaw"统一 8,000、三家最严"，不成立。** 8,000 只覆盖普通执行结果的预览路径；artifact 回读、其他工具、脚本 SDK 数据路径各有自己的限制。要比较得先把各路径列全。

关于"报错比截断更省"（`FileReadTool/limits.ts:1-14`）：

> ⚠️ **那个实验只针对 Read 超限场景**——用户显式指定了超出字节上限的读取，报错能逼模型重新收窄再读。**不能推广到已经执行完的命令或 MCP 查询**：结果已经产生，丢掉它报错只会导致重跑，总成本更高。
>
> siclaw 现有的 **artifact 引用 + 受控回读**在这类场景下比"报错"更合适，应保留。要评估就比较**完整任务成本**（含重跑），而不是单次结果的字节数。

仍然成立的一条：**每轮聚合预算**。单个结果都没超限，但一轮 10 个并行 × 40K = 400K。siclaw 没有这一层——不过 Claude Code 那边它也在一个默认关闭的 gate 后面，属可选设计而非业界默认。

---

## 六、并发策略：两家结论相反

- **Claude Code 大力鼓励并行**：全局 system prompt、Bash 描述、Agent 描述、Explore 子代理 prompt 四处都讲。而且不是抽象建议——git/PR 流程被写成**预先并行化的编号步骤**（"Run the following bash commands in parallel"）。
- **codex 对新模型直接禁用并行工具调用**（`client.rs:853`，`!model_info.use_responses_lite`），改用 **Code Mode**：并发发生在 JS 脚本内部（`await Promise.all([...])`），而不是 N 个并行 `function_call`。

Code Mode 里有个对 siclaw 特别有价值的设计：**`store(key, value)` / `load(key)` 让中间值跨 `exec` 调用持久化，完全不经过模型上下文**。对可观测性查询这类"取大量数据、只要结论"的场景，这是结构性的省法。

还有 `// @exec: {"max_output_tokens": 1000}` 首行 pragma——**让模型自己设定本次调用的输出预算**。

---

## 七、siclaw 可执行清单（r2 · 已按 review 重排）

> r1 把"共享 key""冻结裁剪""放宽结果上限"列为可直接落地项，都是误读。**这三项降级为实验项**，且顺序改为：**先计量 → 验证已有能力 → 带能力检查的试点 → 按实测处理前缀变化。**

### P0 · 补齐计量（前置条件，其余全部依赖它）

**1. 补齐调用 usage 采集**。成本分析文档 §3.0b：subagent 完全没有 `llm_call`，`aux_calls` / `discarded_llm_calls` 未展开。**不补这个，后面任何改动都无法验证收益。**

**2. 最终请求计量**（**不是「加个长度统计」那么简单**）。三个口径必须分开记，谁都不能替谁：

| 口径 | 含义 |
|---|---|
| **payload 字节数** | 真实发出的请求体大小 |
| **token 估算** | 本地估算值，用于预算判断 |
| **服务端 usage** | provider 返回的权威计费值 |

两个现成的坑：
- 现有 `inspectModelEnvelope` **只在哈希变化时才 log**（`pi-execution.ts:56-59` 的 `if`）——它是**变更事件流，不是每轮记录**，无法与每轮 usage 对齐。必须改成每轮落一条，并用**调用 / 尝试 ID**（`round`、`attempt`）关联到对应的 usage。
- 它的 system 哈希来自**提取后拼接的文本**，既不等于真实 payload 字节，也不覆盖完整历史结构。

**3. 把已有的 envelope 哈希接上 usage**。siclaw 已有变化检测的一半（`model-envelope.ts:74-88`），缺的是与 `cache_read` 关联。

> ⚠️ **但检测器解决不了全部归因**（r1 此处过满）：持续 `cache_read=0`、大量单轮子会话都不会触发"比上次下降"；只比较 system/tools 也看不到历史消息裁剪。
>
> 需要一并记录：**历史前缀变化、调用间隔、cache key、模型配置**；输出要区分「相关变化」与「已确认原因」，并保留「可能 TTL / 可能服务端 / 未知」三档——参考实现自己就是这么做的。

### P1 · 先验证已有能力，再谈新建

**4. 验证 `run_script` 的脚本内并发与聚合效果**。最新 main 已提供，与 codex Code Mode 的 `store`/`load` 思路同源（中间值不进上下文）。**先测它覆盖了多少场景，再决定是否需要别的机制**——避免重复建设。

**5. MCP 预算**。三家里 siclaw 是唯一没有任何 MCP 预算约束的，这条**不依赖任何假说**。

> ⚠️ **但两家的数字是两种策略，不能并列当参考值直接抄**：
> - Claude Code 的 **2,048 是描述截取**（超出部分截断，工具仍可用）；
> - codex 的 **8KB/spec、64KB 总计是准入门槛**（超限**隐藏**该 spec），且**仅适用于 agent-plugin 来源**。
>
> siclaw 要设计的是**完整预算**，至少覆盖：描述、参数 schema、**重复的 server context**（当前 `serverDescription` 会被 prepend 到该 server 的每个工具，N 个工具就是 N 份）、工具数量、以及总量上限。先量再定阈值。

### P2 · 带能力检查的试点

**6. 工具搜索 / `defer_loading` 试点**。**不能无条件启用**：
- 需模型支持（GPT-5.4+）+ 配置 `tool_search`，并验证实际服务、fallback 与子模型行为；
- **省的是参数 schema，不是 name + description**——要省成员工具描述得设计 namespace / MCP 分组；
- 先在 MCP 与低频工具（`manage_schedule` 3,537、`skill_preview` 1,747）上试点，按 P0 的计量看真实收益。

**7. system prompt 分区 + 哨兵边界**，静态在前动态在后；section 注册表默认 memoize，破坏缓存需显式申报理由。这条不依赖外部能力，是纯内部纪律。

### P3 · 实验项（需要先设计，不可直接照搬）

**8. 结果预算分层**。把「首次结果预算」（可冻结）与「后续历史压缩」（必须可持续回收）拆开，补齐容量耗尽、恢复与证据回读规则。**直接用"冻结"替换现有 pruning 会导致近期结果无法清理。**

**9. 子代理缓存复用**。要抄就抄 Claude Code 的一整套（冻结 rendered prompt + 克隆替换状态使前缀内容对齐），**只统一 `prompt_cache_key` 无效**——父子前缀本就不同。

**10. 重估结果上限**。先列全各路径（预览 8,000 / artifact 回读 / 脚本 SDK）的实际限制，按**完整任务成本**（含重跑）评估，保留 artifact 引用与受控回读。**不要统一改成超限报错。**

**11. 裁剪要告知模型**。若 P3-8 落地，需在 prompt 里说明"旧结果会被清理，重要信息请写进回复"，否则模型会引用已消失的内容（`prompts.ts:836-841`）。

---

## 八、两个反直觉的点

1. **message 级 cache breakpoint 只用 1 个，不是 4 个**（`claude.ts:3078-3088`）。多打不等于多命中——多余 marker 会让服务端保护一个永远不会被 resume 的 KV page，纯浪费。

2. **压缩摘要请求本身应该走 fork 复用主线程前缀**。Claude Code 实测该项从 **98% cache miss** 变为命中，占全队 `cache_creation` 的 0.76%（**~38B tokens/天**，`compact.ts:432-436`）。坑也标了：别给这个 fork 设 `maxOutputTokens`，它会 clamp thinking budget，而 thinking config 在 cache key 里。

---

## 附：证据来源与限度

- siclaw 侧数据来自 `946e0675` 实测，工具字符数为**下界**（见成本分析文档 §1.1 的修订说明）。
- Claude Code / codex 侧为源码阅读结论，字符数由脚本统计模板字面量得出，条件拼装的工具（Bash / Agent / Grep）按全分支计，实际渲染更少。
- **未做的**：三方的真实请求抓包对比、siclaw 改造后的收益实测。本文给的是机制差距，不是收益承诺。
