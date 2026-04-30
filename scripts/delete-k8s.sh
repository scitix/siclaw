#!/usr/bin/env bash
# Tear down the siclaw deployment created by scripts/deploy-k8s.sh.
#
# This is the inverse of deploy-k8s.sh: it removes the portal + runtime
# workloads (and any stray AgentBox pods spawned by the runtime), so nothing
# from images.txt continues running and nothing auto-restarts. A subsequent
# ./scripts/deploy-k8s.sh re-installs everything.
#
# DATA SAFETY — read this before running:
#   The two MySQL pods you saw (siclaw-portal-db, siclaw-trace-db) are NOT
#   managed by the Helm release that deploy-k8s.sh installs. They were applied
#   manually, do not carry the `app.kubernetes.io/instance=siclaw` label, and
#   own their own PVCs (`siclaw-portal-db`, `siclaw-trace-db-pvc`). This
#   script intentionally leaves them — and their PVCs — completely alone.
#   Therefore:
#     - re-running deploy-k8s.sh   → portal/runtime redeploy, DB pods + data untouched
#     - running this delete script → portal/runtime + agentbox gone, DB pods + data untouched
#   The portal/runtime images themselves are stateless (config flows in via
#   env / Secrets at deploy time), so removing them is non-destructive.
#
# If you ever DO want to wipe the data too, do it explicitly and separately:
#   kubectl -n siclaw delete deploy siclaw-portal-db siclaw-trace-db
#   kubectl -n siclaw delete pvc siclaw-portal-db siclaw-trace-db-pvc
# (this script will never do that for you.)
#
# Usage:
#   ./scripts/delete-k8s.sh                       # uninstall release "siclaw" in ns "siclaw"
#   ./scripts/delete-k8s.sh -n other -r myrel     # alternate namespace/release
#   ./scripts/delete-k8s.sh -f images-other.txt   # show which images we are tearing down
#   DRY_RUN=1 ./scripts/delete-k8s.sh             # print plan only, do nothing
#   KEEP_SECRETS=1 ./scripts/delete-k8s.sh        # leave the portal/runtime Secrets behind
#                                                   so a redeploy reuses jwtSecret/portalSecret
#                                                   (default: helm uninstall removes them; the
#                                                   next deploy-k8s.sh will regenerate fresh
#                                                   ones, which logs out all portal sessions)

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────────────
NAMESPACE="${NAMESPACE:-siclaw}"
RELEASE="${RELEASE:-siclaw}"
IMAGES_FILE_DEFAULT="$(cd "$(dirname "$0")" && pwd)/images.txt"
IMAGES_FILE="$IMAGES_FILE_DEFAULT"

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

command -v helm    >/dev/null || { echo "helm not on PATH" >&2; exit 1; }
command -v kubectl >/dev/null || { echo "kubectl not on PATH" >&2; exit 1; }

# ── Plan summary ────────────────────────────────────────────────────────────
echo "── delete plan ──────────────────────────────────────────"
echo "  namespace : $NAMESPACE"
echo "  release   : $RELEASE"
if [[ -f "$IMAGES_FILE" ]]; then
  echo "  images    : (these workloads will be removed)"
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"
    line="$(echo "$line" | tr -d '[:space:]')"
    [[ -z "$line" ]] && continue
    echo "    - $line"
  done < "$IMAGES_FILE"
else
  echo "  images    : (images file not found, skipping listing: $IMAGES_FILE)"
fi
echo "  preserved : siclaw-portal-db, siclaw-trace-db (deployments + PVCs)"
echo "─────────────────────────────────────────────────────────"

# ── Confirm release exists ──────────────────────────────────────────────────
if ! helm -n "$NAMESPACE" status "$RELEASE" >/dev/null 2>&1; then
  echo "  [info] helm release '$RELEASE' not found in ns '$NAMESPACE' — skipping uninstall"
  RELEASE_PRESENT=0
else
  RELEASE_PRESENT=1
fi

# ── Defensive guard: refuse to touch unmanaged DB resources ────────────────
# Belt-and-braces. We never list these in any kubectl delete command, but make
# the invariant explicit so future edits cannot regress it.
PROTECTED_DEPLOYMENTS=(siclaw-portal-db siclaw-trace-db)
PROTECTED_PVCS=(siclaw-portal-db siclaw-trace-db-pvc)

# ── Dry run ─────────────────────────────────────────────────────────────────
if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo
  echo "[dry-run] would run:"
  if [[ "$RELEASE_PRESENT" == "1" ]]; then
    echo "  helm uninstall $RELEASE -n $NAMESPACE --wait"
  fi
  echo "  kubectl -n $NAMESPACE delete pod -l siclaw.dev/component=agentbox --ignore-not-found --wait=false"
  if [[ "${KEEP_SECRETS:-0}" != "1" ]]; then
    echo "  # (helm uninstall already removes ${RELEASE}-portal / ${RELEASE}-runtime Secrets)"
  fi
  echo
  echo "[dry-run] would NOT touch:"
  for d in "${PROTECTED_DEPLOYMENTS[@]}"; do echo "  deploy/$d"; done
  for p in "${PROTECTED_PVCS[@]}"; do echo "  pvc/$p"; done
  exit 0
fi

# ── Helm uninstall ──────────────────────────────────────────────────────────
# Removes everything labelled app.kubernetes.io/instance=$RELEASE — i.e.
# portal + runtime Deployments, Services, ServiceAccount, Secrets, ConfigMaps,
# PodMonitors, ServiceMonitors, PrometheusRules, the dashboard ConfigMap, and
# the siclaw-data PVC. The unlabeled DB Deployments + their PVCs are NOT in
# the release manifest, so helm cannot and will not touch them.
if [[ "$RELEASE_PRESENT" == "1" ]]; then
  if [[ "${KEEP_SECRETS:-0}" == "1" ]]; then
    # Snapshot the secrets, run uninstall, restore them. Cheap; avoids
    # rotating jwtSecret/portalSecret which would log everyone out on the
    # next deploy.
    SECRETS_KEEP_DIR="$(mktemp -d)"
    trap 'rm -rf "$SECRETS_KEEP_DIR"' EXIT
    for s in "${RELEASE}-portal" "${RELEASE}-runtime"; do
      if kubectl -n "$NAMESPACE" get secret "$s" >/dev/null 2>&1; then
        kubectl -n "$NAMESPACE" get secret "$s" -o yaml \
          | sed -e '/resourceVersion:/d' -e '/uid:/d' -e '/creationTimestamp:/d' \
          > "$SECRETS_KEEP_DIR/$s.yaml"
        echo "  [secret] snapshotted $s for restore"
      fi
    done
  fi

  echo "+ helm uninstall $RELEASE -n $NAMESPACE --wait"
  helm uninstall "$RELEASE" -n "$NAMESPACE" --wait

  if [[ "${KEEP_SECRETS:-0}" == "1" ]]; then
    for f in "$SECRETS_KEEP_DIR"/*.yaml; do
      [[ -f "$f" ]] || continue
      echo "  [secret] restoring $(basename "$f" .yaml)"
      kubectl apply -f "$f" >/dev/null
    done
  fi
fi

# ── Sweep stray AgentBox pods ───────────────────────────────────────────────
# Runtime spawns these dynamically (one per user session) via k8s-spawner.ts.
# They are bare Pods, NOT owned by any Deployment/StatefulSet, so they did not
# get the helm release label and survive `helm uninstall`. Without this sweep
# you would still see `agentbox-<uuid>` lingering. Once the runtime Deployment
# is gone, nothing recreates them.
echo "+ kubectl -n $NAMESPACE delete pod -l siclaw.dev/component=agentbox --ignore-not-found --wait=false"
kubectl -n "$NAMESPACE" delete pod \
  -l siclaw.dev/component=agentbox \
  --ignore-not-found --wait=false || true

# Fallback: some older spawns may not carry the component label. Match by name
# prefix as a safety net. Never matches the DB pods (different prefixes).
STRAY_AGENTBOX_PODS="$(kubectl -n "$NAMESPACE" get pod \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null \
  | grep -E '^agentbox-' || true)"
if [[ -n "$STRAY_AGENTBOX_PODS" ]]; then
  echo "  [sweep] removing unlabeled agentbox pods: $(echo "$STRAY_AGENTBOX_PODS" | tr '\n' ' ')"
  # shellcheck disable=SC2086
  kubectl -n "$NAMESPACE" delete pod $STRAY_AGENTBOX_PODS --ignore-not-found --wait=false || true
fi

# ── Post-delete sanity ──────────────────────────────────────────────────────
echo
echo "── post-delete ──────────────────────────────────────────"
echo "remaining helm-managed resources (should be empty):"
kubectl -n "$NAMESPACE" get deploy,sts,svc,secret,cm \
  -l "app.kubernetes.io/instance=$RELEASE" 2>/dev/null || true
echo
echo "preserved DB workloads (should still be Running):"
kubectl -n "$NAMESPACE" get deploy siclaw-portal-db siclaw-trace-db 2>/dev/null || true
kubectl -n "$NAMESPACE" get pvc   siclaw-portal-db siclaw-trace-db-pvc 2>/dev/null || true
echo
echo "all siclaw pods now:"
kubectl -n "$NAMESPACE" get pods 2>/dev/null || true
echo
echo "done. Re-run ./scripts/deploy-k8s.sh to bring the workloads back."
