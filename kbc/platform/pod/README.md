# platform/pod — 编译 box(Claude Agent SDK + kbc 大脑)

siclaw 平台的**编译 box**:把 kbc 编译大脑跑成一个 **Claude Agent SDK** 持久会话 = 一个"封装入口的无头
Claude Code"。引擎/工具/compact 一行不重写;只加 kbc 护城河的结构化信号工具。
平台无关(kbc base);由 siclaw runtime 复用 agentbox 的 K8sSpawner 按 BoxProfile 起它
(`kb-compile` / `kb-test`),事件经 runtime 翻成通用 `capability.*` 转给消费者(sicore 等)。

## 两种形态(同一大脑)

- **`compile_box.py`(served,生产形态)** —— aiohttp 服务,被 runtime 按 **box 自有 HTTP+SSE 契约**驱动:
  - `POST /sources`  `{run_id?, workdir?, bundle_base64, bundle_sha256?}` → 上传冻结 raw bundle,安全解到 `workdir/raw/`(`drop/` 保留为兼容别名);run 已启动后再调返回 409
  - `POST /authoring` `{run_id?, workdir?, bundle_base64, bundle_sha256?}` → 上传 authoring/candidate/eval/release 资产,安全解到 `workdir/`;live run 上也允许(工作区再水化走这里)
  - `POST /session/{run_id}` `{workdir?, instruction?, allowed_tools?}` → 起该 run 的持久对话会话(等首条 /message);幂等,live run 上是 no-op attach
  - `POST /message/{run_id}` `{message}` → 向持久会话注入一轮用户消息;prepare、编译、按裁决回修都是**普通 turn**
  - `GET  /events/{run_id}` → SSE 结构化事件:`session` / `log` / `summary` / `turn_done` / `syncArtifacts` / `plan_proposed` / `error` / `end`
  - `POST /test-session/{run_id}` → **起测试会话**:把父 run 当前草稿(`candidate/`)钉成不可变快照 + 起一个只读消费者会话(复用本 pod,零新 infra);返回 `test_session_id` + `snapshot_hash` + `pages`
  - `POST /test-message/{tid}` / `GET /test-events/{tid}` / `POST /test-session/{tid}/close` → 测试会话的注入/直播/销毁
  - `GET  /health` → `{status, runs, test_sessions}`

  护城河靠自定义工具,让 agent **显式发信号**(不靠猜输出):
  `report_summary`→`summary`,`propose_plan`→`plan_proposed`,
  `resolve_ticket`→写 `authoring/CONTRADICTIONS.json` 的 `agent_report`(矛盾工单回修登记)。
  **矛盾永不阻塞**:agent best-guess 落页 + 标存疑 + 落工单,负责人事后异步裁决(矛盾-as-turn 模型)。

- **`compile_agent.py`(one-shot,本地调试)** —— 一次性 `query()`:读 `workdir/drop/`+`constitution.md`→编→写
  `workdir/bundle/`,无 HTTP。用来快验"大脑能在容器里编"。

## 跑(本地,订阅鉴权)

```bash
# kbc 仓根 —— 一次性形态
mkdir -p /tmp/wd/drop && cp drop/aliyun-fc/*.md /tmp/wd/drop/ && cp constitution.md /tmp/wd/
platform/pod/.venv/bin/python platform/pod/compile_agent.py --workdir /tmp/wd

# served 形态 + 协议冒烟(假驱动,不烧 LLM)
platform/pod/.venv/bin/python platform/pod/test_compile_box.py
```

## 跑(容器,生产形态)

```bash
docker build -f platform/pod/Dockerfile -t kbc-compile-box .
docker run --rm -p 3000:3000 \
  -e ANTHROPIC_BASE_URL=https://<massapi>/ \   # 模型走公司 massapi(key 代理侧注入)
  -v /tmp/wd:/work \
  kbc-compile-box
# 然后:
#   POST :3000/sources {"run_id":"r1","bundle_base64":"...","bundle_sha256":"..."}
#   POST :3000/authoring {"run_id":"r1","bundle_base64":"...","bundle_sha256":"..."}
#   POST :3000/session/r1 {"instruction":"..."}
#   POST :3000/message/r1 {"message":"把 raw/ 编译成候选页"} → GET :3000/events/r1(SSE)
```

## 鉴权 / mTLS

- **LLM**:本地复用 `~/.claude` 订阅(无需 key);容器/生产必须 `ANTHROPIC_API_KEY` 或 `ANTHROPIC_BASE_URL`→massapi(凭据不进 sandbox)。
- **传输**:存在 `SICLAW_CERT_PATH`(默认 `/etc/siclaw/certs`)的 `tls.crt/tls.key/ca.crt` → 起 HTTPS 且要求客户端证书(runtime/gateway);否则 HTTP(本地)。复用 agentbox 的每-box mTLS 外壳。

## Layer-1 自检:覆盖账本 + lint(`selfcheck.py`)

完成判据从"模型自证"换成"代码核查"(设计:improve_siclaw/DESIGN-kb-compile-self-verification-2026-07-03.md §8.1):

- **契约**:每个 candidate 页 frontmatter `compiled_from` 列真实 raw 相对路径(纯综合页标
  `derived: true`);不编的源写 `authoring/EXCLUSIONS.json`(`[{pattern, reason}]`)。
- **核对**:每轮 turn 结束、candidate 状态有变(幂等键=candidate 树+EXCLUSIONS 内容)且
  `candidate/index.md` 存在时,机械核对「raw 全部文本源 = compiled_from 并集 + EXCLUSIONS 匹配」
  并跑结构 lint(provenance 缺失/坏链);结果写 `authoring/SELFCHECK.json`(随 workspace 同步
  到 sicore,发布卡消费),一行叙述走 `summary` 事件。
- **回修**:`turn_done` 照常发(never-stuck 不变);未入账时注入**一条**回修指令
  (`KBC_L1_REPAIR_ROUNDS`,默认 1),额度用尽标 `unconverged`,余项交负责人。全程 fail-open。
- **引擎中立**:selfcheck.py 纯 stdlib 零 SDK 依赖;驱动只提供"何时触发"+
  `CompileRun.inject_user_message()` 一个注入缝——换引擎(如 Codex)只重实现这一个方法。
## Layer-2 自检:红蓝队 PK(`redblue.py` + `engine.py`)

一写多考的非对称设计:**裁判**(强档,读 raw+快照,`KBC_PK_JUDGE_MODEL` 默认 claude-opus-4-6)
调研出题面→出题(含变式,优先 冲突/WIP/边界+存疑工单)→判分(四分类归因 覆盖/路由/契约/媒介,
"正确标未覆盖"=通过);**蓝队**(门槛档=生产消费档,`KBC_PK_BLUE_MODEL` 默认 claude-sonnet-4-6,
persona=TEST_ROLE 单源共用)只读钉死的 wiki 快照,raw 被多根路径守卫机械屏蔽。

- **编排全在代码**(redblue.py):题量=clamp(8, 页数×1.5, 40)、出题面按 raw 指纹缓存
  (`authoring/PK_SURVEY_CACHE.json`)、分块答题/判分(`KBC_PK_CHUNK=5`,并发
  `KBC_PK_CONCURRENCY=2`)、定向复测原语(`questions_override`)、全局墙钟
  `KBC_PK_WALL_SECS=1800`、任一阶段坏 JSON 重试 1 次后 fail-open(state=failed 不抛)。
- **引擎中立**(engine.py):`ReadonlyAgentEngine` Protocol 是唯一引擎面;结构化输出=
  文本 JSON+宽松解析(刻意不用 SDK 工具强制);换 Codex 底座=加一个 adapter,model/effort
  是普通字符串旋钮。
- **S0 校准跑器 = 本模块**:`python redblue.py --raw <dir> (--workdir <dir>|--wiki <dir>)
  [--questions N] [--retest 上次结果.json] [--out pk-result.json]`——离线校准跑的就是
  生产管线。结果写 SELFCHECK.json 的 `pk` 段(单写点 `selfcheck.update_pk_section`,
  L1 复检不会抹掉它)。
- **接线待 S0 过门**:compile_box 的自动触发(L1 passed 后台跑+回修注入+stale 判定)
  按设计文档 §9.4 在校准通过后接入。

## 边界 / 下一步

- **resume**:box 重启后会话不续(`InMemorySessionStore`);runtime 侧靠"冷 box 再水化"(重新物化 raw + durable workspace)兜底,SDK `resume`+file-backed `session_store` 是后续增量。
- **测试会话隔离**:只读靠 allowed_tools 白名单(默认 `Read/Glob/Grep`),但 bypassPermissions 下绝对路径 Read 仍可逃出快照目录(评审 C4)——路径围栏是测试会话 slice 的待办。
- 测试会话上限 `KBC_MAX_TEST_SESSIONS`(默认 3),快照落 `KBC_TEST_SNAPSHOT_ROOT`(默认 `/tmp/kbc-tests`),close 即销毁。
- `KBC_SMOKE=1` → 假驱动(不调 LLM),在集群里免费验 box↔runtime↔消费者 的接线(events + artifact sync)。
