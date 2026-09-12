# KBC uses the same pinned Pi execution core and root lockfile as AgentBox.
# Build from the repository root: docker build -f kbc/platform/pod/Dockerfile .
FROM node:22.19-slim AS pi-builder
WORKDIR /pi-worker
COPY package.json package-lock.json ./
COPY patches/ ./patches/
COPY scripts/install/ ./scripts/install/
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc && npm prune --omit=dev

FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates poppler-utils ripgrep libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

# PyYAML backs deterministic OKF frontmatter validation. python-pptx/openpyxl/
# python-docx let office_ingest pre-render .pptx/.xlsx/.docx sources to markdown
# (PDFs are rendered by the agent's Read tool through poppler-utils; text and
# images are read directly).
COPY kbc/platform/pod/requirements.txt /tmp/kbc-requirements.txt
RUN pip install --no-cache-dir -r /tmp/kbc-requirements.txt

COPY --from=pi-builder /usr/local/bin/node /usr/local/bin/node
COPY --from=pi-builder /pi-worker/package.json /app/pi-worker/package.json
COPY --from=pi-builder /pi-worker/node_modules /app/pi-worker/node_modules
COPY --from=pi-builder /pi-worker/dist /app/pi-worker/dist

WORKDIR /app
# The one-shot Pi CLI loads this compiler instruction file explicitly.
# Do NOT set KBC_PLAYBOOK here: the served box selects its playbook from the
# locale prompt packs (prompts/<locale>/playbook.md); the env is a local-dev
# escape hatch and setting it in the image would override every locale.
COPY kbc/CLAUDE.md /app/CLAUDE.md
# All pod modules via a glob so a new one can never be forgotten again (2026-07-07:
# incremental.py was omitted from the explicit list and crashed the box on startup
# with ModuleNotFoundError). test_*.py are excluded via kbc/.dockerignore.
COPY kbc/platform/pod/*.py /app/
COPY kbc/platform/pod/prompts/ /app/prompts/
COPY kbc/tools/ /app/tools/

# Docker preserves build-context modes for copied files. Normalize the whole
# application tree so a checkout created under a restrictive umask cannot make
# the root-owned sources unreadable after the image switches to USER kbc.
# Keep the tree root-owned and non-writable by the runtime user.
RUN chmod -R u=rwX,go=rX /app

# Default served port (overridable via SICLAW_AGENTBOX_PORT, aligned with agentbox).
ENV SICLAW_AGENTBOX_PORT=3000

# Host tools run as the unprivileged compiler user.
RUN useradd -m -u 1000 kbc
USER kbc

EXPOSE 3000

# Served form: spawned by the siclaw runtime, driven over the box's own
# HTTP+SSE contract (POST /session, /message, SSE /events). The one-shot CLI
# form remains in compile_agent.py (local debugging: python compile_agent.py
# --workdir /work).
ENTRYPOINT ["python", "/app/compile_box.py"]
