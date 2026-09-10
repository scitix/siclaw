# 网页旁白生成与真实 GPT 验证（2026-09-07）

## 实现

- 主网页对话新增 mode.web_progress 层与工具公开说明字段；保留原生正文优先，tool-only 批次用模型填写的说明兜底。模型思考不会被替代成公开旁白。
- 只有普通 object schema、顶层网页所有者启用工具包装。原始参数、prepareArguments、execute、权限标记、并行策略、结果与取消信号保持隔离；第三方复杂 schema、字段冲突、子任务和非网页模式保留原约定。
- Brain 只标记已包装工具；Gateway 在对应工具之前落一条独立 commentary，并发送 progress_update。每批最多补一次，不参与 resultText，不重复最终回答，交接后旧执行方不继续输出。
- 外部 Portal API 复制共享 map 后标注真实作者；Web 用消息 ID 接收旁白，保留整体完成折叠。修复无 DB ID 时工具行的毫秒 ID 碰撞，以及重复结束事件误关闭其他调用。

## 验证

- Runtime 8 个测试文件 342 项通过（prompt/context、工具包装、Brain、SSE、abort、AgentBox client/http）；最后针对组合 schema 保留行为再跑 5 文件 161 项通过。Runtime tsc --noEmit 通过。
- Web 作者/顺序、历史合并、过程布局和交互共 77 项通过。全量 tsc 仍有 5 个既有错误，涉及脚本版本页、MCP 版本属性、workflow 插件类型和两处 attachment 测试类型；本次修改无新增错误。
- Go proxy、agentroute 的 race 检查通过；新 progress_update 加入真实共享 WS 订阅不可变性测试。
- 使用用户授权的 GPT 模型接口，虚构实验室两步库存查询，测试原生正文和强制 tool-only 输出。实际经过 pi 0.80.7 的模型调用/工具执行、PiAgentBrain、consumeAgentSse；持久化另由回归测试验证，不连接生产数据库。
- 最终实时流式矩阵 4 轮通过：Chat Completions/off 与 Responses/high 各测原生正文、tool-only 两种；8/8 工具批次在开始前有公开说明，4/4 轮只保留一个最终答案。
- 真实返回的事件进入实际前端 store 和组件，Playwright 检查执行中的两段说明/两个工具、完成后只保留一份结论、整体展开回看、390px 窄屏无横向溢出，无页面脚本错误。

## 接口兼容性发现

对 gpt-5.6-sol 实测：Chat Completions + 工具 + high 返回 400，错误明确要求 Responses 或 reasoning_effort=none；Chat Completions 默认关闭 reasoning、Responses + high 均成功。不能由此推断线上 Agent 当前具体使用了哪种组合：完整生效配置未取得。外部 Portal 已有协议值 `openai_responses` 可映射到 Runtime 的 `openai-responses`，需在模型绑定中确认。没有自动修改生产模型绑定或降低推理设置。

## 复验

Runtime 仓库运行 `node --import tsx scripts/smoke/conversation-progress.mts`。必须设置 SICLAW_TEST_MODEL_URL 为已授权 API base URL；模型默认 gpt-5.6-sol，可用 SICLAW_TEST_MODEL 改写。凭据从 stdin 或 SICLAW_TEST_API_KEY 读取，不会写入仓库。终端输入凭据前关闭回显。

SICLAW_TEST_MATRIX=1 会验证 Chat Completions/off 与 Responses/high 的两个输出路径。也可用 SICLAW_TEST_API 和 SICLAW_TEST_THINKING 单独指定。SICLAW_TEST_TRACE_DIR 可保存仅含虚构任务的事件用于本地回放；含完整模型事件，不应用于公开发布内部思考。测试不给真实集群发命令，不发送完整仓库系统提示词。

## 发布范围与限制

先更新 外部 Portal API/Web，再更新 SiClaw Runtime/AgentBox；在旧执行确认结束后使已有 brain 正常重建，从而加载新提示词和工具 schema。单独发布 web 无法启用生成端修复。本次未部署。

尚未做线上完整 Agent 配置、真实资源、生产 DB 和端到端 handoff 的环境验收；没有证明全面达到 Codex 的任务执行质量。长工具执行期间不会凭空产生新发现，下一次模型响应才会结合返回结果继续说明。
