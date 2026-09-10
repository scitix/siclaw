# 网页对话的公开进展说明

## 问题与证据

既有 UI 可以显示 commentary，但生成端只靠公共提示词中的文字要求，模型只输出 tool_calls 时没有独立的公开说明。真实接口的通用虚构任务验证确认 GPT 可以同时产生正文和工具调用，因此不能把缺少旁白归因于 GPT 不具备能力。尚未取得线上完整 Agent 生效配置，不能宣称已经复现全部线上原因。

## 执行约定

网页主对话增加平台拥有的 mode.web_progress 层，位于 Agent addendum 后、安全规则前。首次工具批次说明目标，后续批次衔接实际发现与下一步，交接说明理由，结尾保留一个完整结果。CLI、channel、task、spawned child、delegated worker 不增加此约定。

对网页主执行者的普通 object 工具 schema 增加必填非空 `_siclaw_progress` 字符串，文字由当前模型生成。既有工具的名称、权限、参数约束、执行方式及返回值不变。包装器在调用 domain prepareArguments/execute 之前剥离该字段。复杂组合/$ref schema 或预占同名字段的第三方工具保持原状，依靠原生正文；不粗暴改写其验证语义。

Brain 仅对已包装工具拆分公开说明和业务参数，产出内部 publicProgress 字段。Gateway 先处理原生正文；没有正文的工具批次才补一条 progress_update，按工具调用身份关联，以 assistant/commentary/source=tool_intent 持久化，再转发工具开始事件。此行不进入最终结果累积器、不伪造 message_end、不展示 thinking。每个模型 step 最多补一条，模型的下一轮才能产生新的证据说明；长时间工具内部运行期间不会编造动态发现。

外部 Portal 按当前 hop 的真实作者标注事件，复制共享 map 后再加字段。前端用持久化 ID 更新独立旁白，完成时继续复用整体折叠行为；命令项保持独立可展开。未持久化工具使用唯一客户端 ID，避免毫秒碰撞；已知调用的重复结束事件不得关闭其他调用。

## 验证与部署边界

真实接口测试用虚构实验室数据，不访问集群，不发送仓库完整提示词。路径包括原生正文与强制 tool-only 两种，实际运行 pi engine → Brain → Gateway SSE，再用这些事件回放前端。生产数据库、完整 Agent prompt、在线交接和部署仍需环境验收。

先发布 外部 Portal API/web 的 progress_update 支持，再发布 SiClaw Runtime 和 AgentBox。AgentBox 工具 schema/提示词在创建 session 时生效；只更新 web 或只更新 Runtime 不会启用完整生成链路。已有会话应在确认执行结束后重新创建 brain，禁止中断在途工具后假定它已停止。

实测该模型网关对 Chat Completions + 工具 + high 返回 400；Responses + high、Chat Completions 不启用 reasoning 均完成测试。生产如需 high，应核查模型 API 绑定支持 Responses，不能默默降低用户配置，也不能在已有工具副作用后自动切换 API 重跑。
