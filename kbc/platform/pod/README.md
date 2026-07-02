# platform/pod — 编译 box(Claude Agent SDK + kbc 大脑)

L3 落地里的**编译 box**:把 kbc 编译大脑跑成一个 **Claude Agent SDK** 任务 = 一个"封装入口的无头
Claude Code"。引擎/工具/compact 一行不重写;只加 kbc 护城河的结构化信号(park/done/summary)。
平台无关(kbc base);sicore 落地由 siclaw runtime 复用 agentbox 的 K8sSpawner 起它(`boxType=compile`)。

## 两种形态(同一大脑)

- **`compile_box.py`(served,生产形态)** —— aiohttp 服务,被 runtime 按 **compile 专属协议**驱动:
  - `POST /sources`  `{run_id?, workdir?, bundle_base64, bundle_sha256?}` → 上传冻结 raw bundle,安全解到 `workdir/raw/`(`drop/` 保留为兼容别名)
  - `POST /authoring` `{run_id?, workdir?, bundle_base64, bundle_sha256?}` → 上传 authoring/candidate/eval/release 资产,安全解到 `workdir/`
  - `POST /compile`  `{run_id, workdir?, round?, instruction?}` → 起一次编译;`instruction` 是文件导向任务单,实际纪律资产在 `workdir/authoring/`
  - `POST /rulings`  `{run_id, rulings:[{contradiction_id,option_index,note?}]}` → 解阻塞、带裁决续编
  - `GET  /events/{run_id}` → SSE 结构化事件:`summary` / `parked` / `done` / `log` / `error` / `end`
  - `GET  /health`

  护城河靠三个自定义工具,让 agent **显式发信号**(不靠猜输出):
  `report_summary`→`summary`,`park_contradictions`→`parked`(工具**阻塞 await 裁决** = 实时 steer、上下文不丢),
  `submit_bundle`→`done`(打包 `workdir/bundle` 交付)。
  runtime 再把这些事件转成 sicore 控制面的 `compile.parked/done/summary` RPC。

- **`compile_agent.py`(one-shot,本地调试)** —— 一次性 `query()`:读 `workdir/drop/`+`constitution.md`→编→写
  `workdir/bundle/`,无 park/HTTP。用来快验"大脑能在容器里编"。

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
#   POST :3000/compile {"run_id":"r1","instruction":"# KB Authoring Compile Task\n..."}
#   GET  :3000/events/r1(SSE) → POST :3000/rulings ...
```

## 鉴权 / mTLS

- **LLM**:本地复用 `~/.claude` 订阅(无需 key);容器/生产必须 `ANTHROPIC_API_KEY` 或 `ANTHROPIC_BASE_URL`→massapi(凭据不进 sandbox)。
- **传输**:存在 `SICLAW_CERT_PATH`(默认 `/etc/siclaw/certs`)的 `tls.crt/tls.key/ca.crt` → 起 HTTPS 且要求客户端证书(runtime/gateway);否则 HTTP(本地)。复用 agentbox 的每-box mTLS 外壳。

## 边界 / 下一步

- park/resume:本版支持 **owner 在场实时 steer**(park 工具阻塞 await 裁决);**spin-down→resume**(owner 走开、超时退出、裁决后起新 box 用 SDK `resume`+`session_store` 续)是后续增量。
- raw 输入:v1 由 sicore 冻结 raw source manifest + tar.gz bundle,runtime 在 `/compile` 前调用 `/sources` 物化到 `workdir/raw/`。`run_id`
  已启动后再次 `/sources` 会 409,避免运行中的编译被热改。
- authoring 资产:v1 由 sicore 打成 authoring bundle,runtime 在 `/compile` 前调用 `/authoring` 物化到 `workdir/authoring/`、`workdir/eval/`
  等目录。`/compile.instruction` 只告诉 Claude Code 该读哪些文件、冻结 manifest 是哪一个、输出纪律是什么。
- 这是 box 侧(②)。runtime 侧(③)`boxType=compile` + 镜像选择 + 事件→RPC 翻译、端到端串(④)未做。
- sicore 控制面(MySQL 状态机 + `compile.start/steer/resume`/`parked/done/summary`)已在 sicore worktree 实现(`internal/siclaw/compilation/`)。
