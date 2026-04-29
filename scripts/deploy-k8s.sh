#!/usr/bin/env bash
# Deploy siclaw to the current Kubernetes context.
#
# Reads scripts/images.txt (one fully-qualified image ref per line, three lines
# total — portal/runtime/agentbox), validates that all three share the same
# registry+tag, then runs `helm upgrade --install` against namespace=siclaw
# with the trace MySQL connection wired into runtime.env (auto-forwarded to
# every spawned AgentBox pod by k8s-spawner.ts).
#
# Non-invasive: does not modify the helm chart or any source code. All
# trace-store config flows through --set runtime.env.SICLAW_TRACE_*.
#
# Usage:
#   ./scripts/deploy-k8s.sh                      # default — reads scripts/images.txt
#   ./scripts/deploy-k8s.sh -f images-other.txt  # alternate manifest
#   DRY_RUN=1 ./scripts/deploy-k8s.sh            # render only, no apply
#
# Prereqs: kubectl context already pointing at the target cluster, helm v3,
# trace-db StatefulSet already deployed in namespace=siclaw with Service
# `siclaw-trace-db` on port 3306.

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────────────
NAMESPACE="${NAMESPACE:-siclaw}"
RELEASE="${RELEASE:-siclaw}"
CHART_DIR="${CHART_DIR:-$(cd "$(dirname "$0")/.." && pwd)/helm/siclaw}"
IMAGES_FILE_DEFAULT="$(cd "$(dirname "$0")" && pwd)/images.txt"
IMAGES_FILE="$IMAGES_FILE_DEFAULT"

# Trace store — in-cluster MySQL (siclaw-trace-db Service in ns=siclaw).
#
# Override the full URL with DEPLOY_TRACE_MYSQL_URL or individual pieces with
# TRACE_DB_HOST/PORT/USER/PASS/NAME. We deliberately do NOT honour the
# SICLAW_TRACE_MYSQL_URL env var here — that variable is the *runtime* config
# consumed by `cli-local.ts` against a kubectl-port-forwarded 127.0.0.1:3307,
# and people commonly leave it sourced in their shell. If we picked it up at
# deploy time, the runtime pod would inherit "127.0.0.1:3307" and try to talk
# to its own loopback (which has nothing listening) — exactly the bug that
# motivated this comment. Keep the two namespaces separated.
TRACE_DB_HOST="${TRACE_DB_HOST:-siclaw-trace-db}"
TRACE_DB_PORT="${TRACE_DB_PORT:-3306}"
TRACE_DB_USER="${TRACE_DB_USER:-root}"
TRACE_DB_PASS="${TRACE_DB_PASS:-siclawsiclawsiclaw}"
TRACE_DB_NAME="${TRACE_DB_NAME:-siclaw_traces}"
TRACE_MYSQL_URL="${DEPLOY_TRACE_MYSQL_URL:-mysql://${TRACE_DB_USER}:${TRACE_DB_PASS}@${TRACE_DB_HOST}:${TRACE_DB_PORT}/${TRACE_DB_NAME}}"

# Portal metadata DB — separate MySQL from the trace store. Portal stores
# users / sessions / chat history here. Without DATABASE_URL the portal pod
# crashes with "DATABASE_URL is required". Default points at the existing
# in-cluster `siclaw-portal-db` Service (a manually-applied MySQL Deployment,
# NOT the chart's mysql-demo). Override with DEPLOY_DATABASE_URL=... or the
# individual PORTAL_DB_* knobs.
PORTAL_DB_HOST="${PORTAL_DB_HOST:-siclaw-portal-db}"
PORTAL_DB_PORT="${PORTAL_DB_PORT:-3306}"
PORTAL_DB_USER="${PORTAL_DB_USER:-root}"
PORTAL_DB_PASS="${PORTAL_DB_PASS:-siclawsiclawsiclaw}"
PORTAL_DB_NAME="${PORTAL_DB_NAME:-siclaw}"
DATABASE_URL="${DEPLOY_DATABASE_URL:-mysql://${PORTAL_DB_USER}:${PORTAL_DB_PASS}@${PORTAL_DB_HOST}:${PORTAL_DB_PORT}/${PORTAL_DB_NAME}}"

# Defensive: refuse to deploy if the resolved URL points at loopback/localhost
# — that's never a valid in-cluster target and almost certainly means the
# operator's shell has SICLAW_TRACE_MYSQL_URL set for local dev and got
# confused about which variable to use.
for _name in TRACE_MYSQL_URL DATABASE_URL; do
  _val="${!_name}"
  if [[ "$_val" =~ @(127\.0\.0\.1|localhost)[:/] ]]; then
    cat >&2 <<EOF
[error] resolved $_name points at loopback: $_val
        That's a host-side dev URL (kubectl port-forward), not an in-cluster
        target. Pods cannot reach 127.0.0.1:<port> on the host.
        Override with DEPLOY_TRACE_MYSQL_URL / DEPLOY_DATABASE_URL or the
        per-piece *_HOST / *_PORT vars, or leave defaults to point at the
        in-cluster Service.
EOF
    exit 1
  fi
done

# Portal / runtime secrets — resolution happens AFTER args parsing (below) so
# that -n / -r overrides reach the kubectl lookup. See "Resolve secrets" block.

# ── Args ────────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    -f|--images-file) IMAGES_FILE="$2"; shift 2 ;;
    -n|--namespace)   NAMESPACE="$2"; shift 2 ;;
    -r|--release)     RELEASE="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[[ -f "$IMAGES_FILE" ]] || { echo "images file not found: $IMAGES_FILE" >&2; exit 1; }
[[ -d "$CHART_DIR" ]]   || { echo "chart dir not found: $CHART_DIR" >&2; exit 1; }
command -v helm    >/dev/null || { echo "helm not on PATH" >&2; exit 1; }
command -v kubectl >/dev/null || { echo "kubectl not on PATH" >&2; exit 1; }

# ── Resolve secrets ─────────────────────────────────────────────────────────
# Stay stable across redeploys. Rotating them invalidates all portal sessions
# and breaks runtime↔portal phone-home. Resolution order, first non-empty wins:
#   1. Caller-supplied env (PORTAL_JWT_SECRET / PORTAL_SECRET)
#   2. Existing k8s Secret in the target namespace (previous deploy)
#   3. Freshly generated random  (only on the very first deploy)
read_k8s_secret() {
  # $1 = secret name, $2 = data key — prints decoded value or empty.
  kubectl -n "$NAMESPACE" get secret "$1" -o "jsonpath={.data.$2}" 2>/dev/null \
    | { base64 -d 2>/dev/null || true; }
}

if [[ -z "${PORTAL_JWT_SECRET:-}" ]]; then
  PORTAL_JWT_SECRET="$(read_k8s_secret "${RELEASE}-portal" "jwt-secret")"
  if [[ -z "$PORTAL_JWT_SECRET" ]]; then
    PORTAL_JWT_SECRET="$(openssl rand -hex 32)"
    echo "  [secret] generated new portal.jwtSecret (first deploy)"
  else
    echo "  [secret] reused existing portal.jwtSecret from ${RELEASE}-portal"
  fi
fi
if [[ -z "${PORTAL_SECRET:-}" ]]; then
  PORTAL_SECRET="$(read_k8s_secret "${RELEASE}-portal" "portal-secret")"
  [[ -z "$PORTAL_SECRET" ]] && \
    PORTAL_SECRET="$(read_k8s_secret "${RELEASE}-runtime" "portal-secret")"
  if [[ -z "$PORTAL_SECRET" ]]; then
    PORTAL_SECRET="$(openssl rand -hex 32)"
    echo "  [secret] generated new portalSecret (first deploy)"
  else
    echo "  [secret] reused existing portalSecret from ${RELEASE}-{portal,runtime}"
  fi
fi

# ── Parse images.txt ────────────────────────────────────────────────────────
# Three lines, each: <registry>/siclaw-<component>:<tag>
# - <registry> may contain slashes (e.g. registry-cn-beijing.siflow.cn/k8s)
# - <component> ∈ {portal, runtime, agentbox}
# - <tag> must be identical across the three lines (chart enforces single tag).
declare -A IMG_BY_COMPONENT=()
declare -A REGISTRY_SET=()
declare -A TAG_SET=()

while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%%#*}"                       # strip trailing comments
  line="$(echo "$line" | tr -d '[:space:]')"
  [[ -z "$line" ]] && continue
  if [[ "$line" =~ ^(.+)/siclaw-([a-z0-9-]+):([^:]+)$ ]]; then
    reg="${BASH_REMATCH[1]}"
    comp="${BASH_REMATCH[2]}"
    tag="${BASH_REMATCH[3]}"
  else
    echo "cannot parse image line: $line" >&2; exit 1
  fi
  IMG_BY_COMPONENT["$comp"]="$line"
  REGISTRY_SET["$reg"]=1
  TAG_SET["$tag"]=1
done < "$IMAGES_FILE"

for comp in portal runtime agentbox; do
  [[ -n "${IMG_BY_COMPONENT[$comp]:-}" ]] \
    || { echo "missing image for component '$comp' in $IMAGES_FILE" >&2; exit 1; }
done

if [[ ${#REGISTRY_SET[@]} -ne 1 ]]; then
  echo "all three images must share one registry; found: ${!REGISTRY_SET[*]}" >&2
  exit 1
fi
if [[ ${#TAG_SET[@]} -ne 1 ]]; then
  echo "all three images must share one tag; found: ${!TAG_SET[*]}" >&2
  exit 1
fi
REGISTRY="${!REGISTRY_SET[*]}"
TAG="${!TAG_SET[*]}"

# ── Plan summary ────────────────────────────────────────────────────────────
echo "── deploy plan ──────────────────────────────────────────"
echo "  namespace : $NAMESPACE"
echo "  release   : $RELEASE"
echo "  chart     : $CHART_DIR"
echo "  registry  : $REGISTRY"
echo "  tag       : $TAG"
echo "  images    :"
for comp in portal runtime agentbox; do
  printf "    - %-9s %s\n" "$comp" "${IMG_BY_COMPONENT[$comp]}"
done
echo "  portal db : ${DATABASE_URL/$PORTAL_DB_PASS/***}"
echo "  trace db  : ${TRACE_MYSQL_URL/$TRACE_DB_PASS/***}"
echo "─────────────────────────────────────────────────────────"

# ── Namespace ───────────────────────────────────────────────────────────────
kubectl get ns "$NAMESPACE" >/dev/null 2>&1 \
  || kubectl create ns "$NAMESPACE"

# ── Helm install/upgrade ────────────────────────────────────────────────────
HELM_FLAGS=(
  upgrade --install "$RELEASE" "$CHART_DIR"
  --namespace "$NAMESPACE"
  --create-namespace
  --set "image.registry=${REGISTRY}"
  --set "image.tag=${TAG}"
  --set "image.pullPolicy=Always"
  --set-string "portal.jwtSecret=${PORTAL_JWT_SECRET}"
  --set-string "portal.portalSecret=${PORTAL_SECRET}"
  --set-string "runtime.portalSecret=${PORTAL_SECRET}"
  # Portal metadata DB — landed in the {release}-portal Secret as `database-url`
  --set-string "database.url=${DATABASE_URL}"
  # Trace store — runtime.env forwarded into spawned AgentBoxes by k8s-spawner.ts
  --set-string "runtime.env.SICLAW_TRACE_MYSQL_ENABLED=1"
  --set-string "runtime.env.SICLAW_TRACE_MYSQL_URL=${TRACE_MYSQL_URL}"
  --wait --timeout 5m
)

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  HELM_FLAGS+=(--dry-run --debug)
fi

echo "+ helm ${HELM_FLAGS[*]}"
helm "${HELM_FLAGS[@]}"

# ── Post-deploy sanity ──────────────────────────────────────────────────────
[[ "${DRY_RUN:-0}" == "1" ]] && exit 0

echo
echo "── post-deploy ──────────────────────────────────────────"
kubectl -n "$NAMESPACE" get deploy,sts,svc -l "app.kubernetes.io/instance=$RELEASE" || true
echo
echo "verify trace env on runtime pod:"
echo "  kubectl -n $NAMESPACE exec deploy/${RELEASE}-runtime -- printenv | grep SICLAW_TRACE"
echo
echo "verify a row lands in MySQL after a chat round-trip:"
echo "  kubectl -n $NAMESPACE exec -it deploy/siclaw-trace-db -- mysql -uroot -p\$PASS \\"
echo "    -e 'SELECT id, started_at, outcome FROM siclaw_traces.agent_traces ORDER BY id DESC LIMIT 3'"
