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

# Verify the chowns above actually took effect, rather than trusting that they did.
#
# Every one of them ends in `|| true`, which is right — a standalone Docker run without CAP_CHOWN should
# not be bricked by it — but it means the isolation can fail to apply in complete silence. The volume is
# an emptyDir, mounted root-owned, so if the chown does not land the credential tree stays world-readable
# and every child process can read it. The group guard above does NOT catch this: it checks sandbox's
# group membership, which is a property of the image, not of the directory.
#
# The realistic way to get here is a spec change, not a bug: `runAsNonRoot: true`, a restricted Pod
# Security Standard on the namespace, or CHOWN dropped from the capability list. The pod would come up
# looking healthy.
# Each type directory as well as the parent: the chowns are independent, so a partial failure can leave
# one of them root-owned and readable while the parent looks correct.
for spec in "clusters:agentbox:kubecred:2750" "hosts:agentbox:hostcred:2750"; do
  d="${spec%%:*}"; rest="${spec#*:}"; want_own="${rest%:*}"; want_mode="${rest##*:}"
  [ -d "/app/.siclaw/credentials/$d" ] || continue
  got_own="$(stat -c '%U:%G' "/app/.siclaw/credentials/$d" 2>/dev/null || echo '?:?')"
  got_mode="$(stat -c '%a' "/app/.siclaw/credentials/$d" 2>/dev/null || echo '?')"
  if [ "$got_own" != "$want_own" ] || [ "$got_mode" != "$want_mode" ]; then
    echo "FATAL: /app/.siclaw/credentials/$d is $got_own mode $got_mode, expected $want_own mode $want_mode." >&2
    echo "       One credential type is not isolated even though the parent looks correct." >&2
    exit 1
  fi
done

cred_owner="$(stat -c '%U:%G' /app/.siclaw/credentials 2>/dev/null || echo '?:?')"
cred_mode="$(stat -c '%a' /app/.siclaw/credentials 2>/dev/null || echo '?')"
if [ "$cred_owner" != "agentbox:kubecred" ] || [ "$cred_mode" != "750" ]; then
  echo "FATAL: /app/.siclaw/credentials is $cred_owner mode $cred_mode, expected agentbox:kubecred mode 750." >&2
  echo "       The permission fix did not take effect, so the credential tree is not isolated from" >&2
  echo "       child processes. The container must start as root with CAP_CHOWN/CAP_FOWNER — check for" >&2
  echo "       runAsNonRoot, a restricted PodSecurity policy, or a dropped capability." >&2
  echo "       See docs/design/security.md §3 and ADR-010." >&2
  exit 1
fi

chown -R agentbox:agentbox /app/.siclaw/skills 2>/dev/null || true
chmod 0755 /app/.siclaw/skills 2>/dev/null || true

chown -R agentbox:agentbox /app/.siclaw/user-data 2>/dev/null || true
chmod 0777 /app/.siclaw/user-data 2>/dev/null || true

chown -R agentbox:agentbox /app/.siclaw/config 2>/dev/null || true
chmod 0700 /app/.siclaw/config 2>/dev/null || true

# ── Drop to agentbox and exec CMD ────────────────────────────────
exec runuser -u agentbox -- "$@"
