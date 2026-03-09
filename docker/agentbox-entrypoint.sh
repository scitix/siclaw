#!/bin/bash
set -e

# ── AgentBox Entrypoint ────────────────────────────────────────────
# Runs as root (no USER directive before ENTRYPOINT).
# Fixes volume mount permissions, then drops to agentbox user.
#
# See: docs/design/security.md, Dockerfile.agentbox

# ── Validate dual-user setup (fail-fast on build error) ───────────
if ! id sandbox &>/dev/null; then
  echo "FATAL: sandbox user not found — image build error." >&2
  exit 1
fi

if ! id agentbox &>/dev/null; then
  echo "FATAL: agentbox user not found — image build error." >&2
  exit 1
fi

# ── Fix volume mount permissions (best-effort) ───────────────────
# In K8s, the init-permissions container already handled this with full
# capabilities. The main container has CAP_CHOWN/DAC_OVERRIDE dropped,
# so these will silently fail — which is correct.
# In standalone Docker (no init container, full caps), these succeed.

chown -R agentbox:kubecred /app/.siclaw/credentials 2>/dev/null || true
chmod 0750 /app/.siclaw/credentials 2>/dev/null || true
find /app/.siclaw/credentials -type f -exec chmod 0640 {} \; 2>/dev/null || true

chown -R agentbox:agentbox /app/.siclaw/skills 2>/dev/null || true
chmod 0755 /app/.siclaw/skills 2>/dev/null || true

chown -R agentbox:agentbox /app/.siclaw/user-data 2>/dev/null || true
chmod 0777 /app/.siclaw/user-data 2>/dev/null || true

chown -R agentbox:agentbox /app/.siclaw/config 2>/dev/null || true
chmod 0700 /app/.siclaw/config 2>/dev/null || true

# ── Drop to agentbox and exec CMD ────────────────────────────────
exec runuser -u agentbox -- "$@"
