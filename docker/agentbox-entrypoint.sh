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

# The property this whole layer rests on: sandbox must hold NO credential group. If it does, every reader
# binary in the image can open the credentials and the setgid bit on kubectl is decorative — the state
# this image shipped in between 2026-04 and 2026-08. Refuse to start rather than run with the isolation
# silently absent.
for grp in kubecred hostcred; do
  if id -nG sandbox 2>/dev/null | tr " " "\n" | grep -qx "$grp"; then
    echo "FATAL: sandbox is a member of $grp — credential isolation is not in effect." >&2
    echo "       Remove -G from the sandbox useradd; see docs/design/security.md §3 and ADR-010." >&2
    exit 1
  fi
done

# ── Fix volume mount permissions ──────────────────────────────────
# The main container has CAP_CHOWN + CAP_FOWNER so these succeed in
# both K8s and standalone Docker. Capabilities are dropped after
# runuser switches to the agentbox user (no security impact).

# Credentials.
#
# The parent MUST stay group-traversable by `kubecred`, because that is the group setgid `kubectl` runs
# with, and without traversal it cannot reach the kubeconfig at all — `permission denied` on every
# kubectl the agent issues. Measured the hard way: setting the parent to `agentbox:agentbox` locks the
# setgid reader out along with everyone else.
#
# What makes that safe is not this directory's mode, it is that `sandbox` belongs to NO credential group
# (Dockerfile.agentbox; asserted at build time and again at startup above). kubecred traversal then means
# "kubectl and the owner", not "every child process". Between 2026-04 and 2026-08 sandbox WAS in kubecred,
# and this same line is what let it walk in — the line was not the defect, the group grant was.
#
# The `-R` is gone, though: it flattened `hosts/` into kubecred as well, discarding the per-type split
# the image sets up. Each type is chowned separately below.
chown agentbox:kubecred /app/.siclaw/credentials 2>/dev/null || true
chmod 0750 /app/.siclaw/credentials 2>/dev/null || true
# setgid on each type directory, so whatever is materialized into it inherits that type's group.
chown -R agentbox:kubecred /app/.siclaw/credentials/clusters 2>/dev/null || true
chmod 2750 /app/.siclaw/credentials/clusters 2>/dev/null || true
chown -R agentbox:hostcred /app/.siclaw/credentials/hosts 2>/dev/null || true
chmod 2750 /app/.siclaw/credentials/hosts 2>/dev/null || true
# Group-readable files, for the setgid reader (kubectl) — not for sandbox, which is in no such group.
find /app/.siclaw/credentials -type f -exec chmod 0640 {} \; 2>/dev/null || true

chown -R agentbox:agentbox /app/.siclaw/skills 2>/dev/null || true
chmod 0755 /app/.siclaw/skills 2>/dev/null || true

chown -R agentbox:agentbox /app/.siclaw/user-data 2>/dev/null || true
chmod 0777 /app/.siclaw/user-data 2>/dev/null || true

chown -R agentbox:agentbox /app/.siclaw/config 2>/dev/null || true
chmod 0700 /app/.siclaw/config 2>/dev/null || true

# ── Drop to agentbox and exec CMD ────────────────────────────────
exec runuser -u agentbox -- "$@"
