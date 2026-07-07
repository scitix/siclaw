# Compile-pod image = Python + Claude Agent SDK + the kbc compile brain.
#
# The Agent SDK ships the Claude Code binary — no separate CLI install.
#
# build:  docker build -f platform/pod/Dockerfile -t kbc-compile-pod .   (run from kbc/ = build ctx)
# run (production; LLM via the company massapi):
#   docker run --rm \
#     -e ANTHROPIC_BASE_URL=https://<massapi>/   \   # model goes through the proxy; key injected proxy-side
#     -e ANTHROPIC_API_KEY=<token>               \   # or pass a key directly
#     -v /path/to/workdir:/work                  \   # workdir with raw sources
#     kbc-compile-pod
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# claude-agent-sdk + aiohttp = the box runtime; python-pptx/openpyxl/python-docx
# let office_ingest pre-render .pptx/.xlsx/.docx sources to markdown (pdf/text/
# images are read natively by the agent's Read tool, so no parser is needed there).
RUN pip install --no-cache-dir claude-agent-sdk aiohttp python-pptx openpyxl python-docx

WORKDIR /app
# CLAUDE.md is only for the legacy CLI (compile_agent.py walks parents for it).
# Do NOT set KBC_PLAYBOOK here: the served box selects its playbook from the
# locale prompt packs (prompts/<locale>/playbook.md); the env is a local-dev
# escape hatch and setting it in the image would override every locale.
COPY CLAUDE.md /app/CLAUDE.md
COPY platform/pod/compile_agent.py /app/compile_agent.py
COPY platform/pod/compile_box.py /app/compile_box.py
COPY platform/pod/office_ingest.py /app/office_ingest.py
COPY platform/pod/prompts/ /app/prompts/
COPY tools/ /app/tools/

# Tenant isolation: never load external memory (prevents cross-tenant bleed).
ENV CLAUDE_CODE_DISABLE_AUTO_MEMORY=1
# Default served port (overridable via SICLAW_AGENTBOX_PORT, aligned with agentbox).
ENV SICLAW_AGENTBOX_PORT=3000

# Run as non-root (the Agent SDK's bypassPermissions refuses root; also sandbox
# best practice).
RUN useradd -m -u 1000 kbc
USER kbc

EXPOSE 3000

# Served form: spawned by the siclaw runtime, driven over the box's own
# HTTP+SSE contract (POST /session, /message, SSE /events). The one-shot CLI
# form remains in compile_agent.py (local debugging: python compile_agent.py
# --workdir /work).
ENTRYPOINT ["python", "/app/compile_box.py"]
