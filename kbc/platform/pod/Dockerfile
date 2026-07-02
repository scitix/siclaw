# 编译 pod 镜像 = Python + Claude Agent SDK + kbc 编译大脑
#
# 这是 L3 落地里"临时编译 pod"的镜像(managed-agents / Agent SDK Hybrid 模式)。
# Agent SDK 自带 Claude Code 二进制,无需单独装 CLI。
#
# build:  docker build -f platform/pod/Dockerfile -t kbc-compile-pod .   (在 kbc 仓根跑)
# run(生产,LLM 走公司 massapi):
#   docker run --rm \
#     -e ANTHROPIC_BASE_URL=https://<massapi>/   \   # 模型走代理,key 在代理侧注入
#     -e ANTHROPIC_API_KEY=<token>               \   # 或直接给 key
#     -v /path/to/workdir:/work                  \   # workdir 含 drop/ + constitution.md
#     kbc-compile-pod
#
# 产物:/work/bundle/*.md(+ 退出码 0=成功有产物)
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir claude-agent-sdk aiohttp

WORKDIR /app
COPY CLAUDE.md /app/CLAUDE.md
COPY platform/pod/compile_agent.py /app/compile_agent.py
COPY platform/pod/compile_box.py /app/compile_box.py
COPY tools/ /app/tools/

ENV KBC_PLAYBOOK=/app/CLAUDE.md
# 多租户隔离:不加载外部 memory(防租户串味)
ENV CLAUDE_CODE_DISABLE_AUTO_MEMORY=1
# served 形态默认端口(可被 SICLAW_AGENTBOX_PORT 覆盖,对齐 agentbox)
ENV SICLAW_AGENTBOX_PORT=3000

# 非 root 运行(Agent SDK bypassPermissions 不允许 root;也是 sandbox 最佳实践)
RUN useradd -m -u 1000 kbc
USER kbc

EXPOSE 3000

# served 形态:被 siclaw runtime 起、按 compile 协议驱动(POST /compile、/rulings、SSE /events)。
# 一次性 CLI 形态仍在 compile_agent.py(本地调试:python compile_agent.py --workdir /work)。
ENTRYPOINT ["python", "/app/compile_box.py"]
