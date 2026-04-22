#!/usr/bin/env bash
#
# dev-local.sh — rebuild and (re)start `siclaw local` in the background.
#
# Usage:
#   scripts/dev-local.sh              # kill + rebuild backend + restart
#   scripts/dev-local.sh --web        # also rebuild portal-web (slow, ~30s)
#   scripts/dev-local.sh --wipe       # also delete DB/secrets/certs (full reset)
#   scripts/dev-local.sh --tail       # stream the log after start (Ctrl+C to detach)
#   scripts/dev-local.sh --stop       # stop any running instance and exit
#   scripts/dev-local.sh --help
#
# Flags can be combined, e.g. `scripts/dev-local.sh --web --wipe --tail`.

set -euo pipefail

REBUILD_WEB=0
WIPE=0
TAIL=0
STOP_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --web)    REBUILD_WEB=1 ;;
    --wipe)   WIPE=1 ;;
    --tail)   TAIL=1 ;;
    --stop)   STOP_ONLY=1 ;;
    -h|--help)
      awk '/^#!/{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"
      exit 0
      ;;
    *)
      echo "Unknown flag: $arg" >&2
      exit 2
      ;;
  esac
done

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

LOG_DIR="$PROJECT_ROOT/.siclaw/logs"
LOG_FILE="$LOG_DIR/local.log"
PID_FILE="$PROJECT_ROOT/.siclaw/local.pid"

# ── stop any running instance ──────────────────────────────────────────

stop_running() {
  local stopped=0
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "[dev-local] stopping pid $pid (from pid file)"
      kill "$pid" 2>/dev/null || true
      stopped=1
    fi
    rm -f "$PID_FILE"
  fi

  for port in 3000 3001 3002 4000 4001 4002 4003; do
    local occupants
    occupants="$(lsof -ti :"$port" 2>/dev/null | tr '\n' ' ' || true)"
    if [[ -n "${occupants// }" ]]; then
      echo "[dev-local] stopping pid(s) ${occupants% } on :$port"
      kill $occupants 2>/dev/null || true
      stopped=1
    fi
  done

  if (( stopped )); then
    sleep 1
  fi
}

stop_running

if (( STOP_ONLY )); then
  echo "[dev-local] stopped."
  exit 0
fi

# ── optional wipe ──────────────────────────────────────────────────────

if (( WIPE )); then
  echo "[dev-local] --wipe: removing .siclaw/{data,certs,local-secrets.json}"
  rm -rf "$PROJECT_ROOT/.siclaw/data"
  rm -rf "$PROJECT_ROOT/.siclaw/certs"
  rm -f  "$PROJECT_ROOT/.siclaw/local-secrets.json"
else
  # Certs are ephemeral per-boot (CA regenerated every restart), so always clear
  # them to prevent a stale AgentBox cert from the previous CA causing handshake
  # failures. DB + secrets are kept so state/admin account persists.
  rm -rf "$PROJECT_ROOT/.siclaw/certs"
fi

# ── rebuild ────────────────────────────────────────────────────────────

if [[ ! -d node_modules ]]; then
  echo "[dev-local] node_modules missing — running npm install"
  npm install
fi

echo "[dev-local] building backend (tsc)..."
npm run build >/dev/null

if (( REBUILD_WEB )); then
  if [[ ! -d portal-web/node_modules ]]; then
    echo "[dev-local] portal-web/node_modules missing — installing..."
    (cd portal-web && npm install)
  fi
  echo "[dev-local] building portal-web (vite)..."
  (cd portal-web && npm run build >/dev/null)
fi

# ── start ──────────────────────────────────────────────────────────────

mkdir -p "$LOG_DIR"
# Truncate log; keep one rotation of the previous run for post-mortem.
if [[ -f "$LOG_FILE" ]]; then
  mv -f "$LOG_FILE" "$LOG_FILE.prev"
fi

echo "[dev-local] starting siclaw local..."
nohup node siclaw.mjs local >"$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
PID="$(cat "$PID_FILE")"

# Wait until Portal's health endpoint responds (or timeout).
printf "[dev-local] waiting for Portal to come up"
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    echo " — ok"
    break
  fi
  if ! kill -0 "$PID" 2>/dev/null; then
    echo ""
    echo "[dev-local] ✗ process died during startup. Last log lines:"
    tail -n 40 "$LOG_FILE" >&2
    exit 1
  fi
  printf "."
  sleep 0.5
done

if ! curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
  echo ""
  echo "[dev-local] ✗ Portal did not become healthy within 15s. See $LOG_FILE"
  exit 1
fi

cat <<EOF
[dev-local] ✅ running
  pid      : $PID
  portal   : http://127.0.0.1:3000
  runtime  : http://127.0.0.1:3001
  db       : sqlite:./.siclaw/data/portal.db
  log      : $LOG_FILE
  stop     : scripts/dev-local.sh --stop
EOF

if (( TAIL )); then
  echo "[dev-local] tailing log (Ctrl+C to detach; process keeps running)..."
  exec tail -f "$LOG_FILE"
fi
