#!/bin/bash
# Read a node's logs through the kubelet log endpoint, from the agent's own
# context — no SSH host, no debug pod.
#
# This is TIER 3. It exists because the first two tiers can both be unavailable
# at once: the node is not a bound SSH host (host_script impossible) and a
# privileged debug pod cannot start on it (node_script impossible). What still
# works in that state is the API server's proxy to the kubelet:
#
#   /api/v1/nodes/<node>/proxy/logs/<path>     files under /var/log on the node
#   /api/v1/nodes/<node>/proxy/logs/?query=…   journald, if NodeLogQuery is on
#
# Three properties of that endpoint shape this script, all verified against a
# live cluster (kubelet v1.29):
#
#   * `?query=<unit>` does NOT fail when the kubelet lacks the NodeLogQuery
#     feature — it silently returns the /var/log DIRECTORY LISTING as HTML. A
#     script that trusts the response body reports an HTML index as "log
#     content". Every response is therefore type-checked before it is counted.
#   * There is no Range, no tail and no time filter for FILE reads: the whole
#     file is transferred. Truncation is only possible from the START of the
#     file, which is the OLDEST end — useless for "what happened 10 minutes
#     ago". So --head-bytes is named for what it does and is never a default.
#   * The endpoint serves FILES. If the node's journald does not forward to
#     syslog/messages, kubelet and containerd logs are simply not there. An
#     empty result means this source cannot see them — not that nothing happened.
#
# NOTE: `set -e` is deliberately OFF — a non-zero exit from kubectl must be
# reported, not kill the report. The streaming counter below is duplicated from
# get-node-logs.sh on purpose: skill scripts are transmitted and executed one
# file at a time, so there is nothing to source a shared helper from.
set -uo pipefail

# Byte-wise, locale-independent matching — node logs are not guaranteed to be
# valid UTF-8, and in a UTF-8 locale grep can refuse or mismatch on invalid
# sequences. It also makes urlencode below operate on bytes, which is what
# percent-encoding is defined over.
export LC_ALL=C

NODE=""
MODE=""            # list | file | query
LIST_PATH=""
FILE_NAME=""
QUERY_UNIT=""
SINCE=""
UNTIL=""
PATTERNS=()
PATTERN_MODE=""    # ere | fixed
TAIL=200
INCLUDE_ROTATED=0
HEAD_BYTES=0

MARKER="__NODE_LOGS_SCANNED__"

usage() {
  printf '%s\n' \
    'Usage: get-node-logs-via-api.sh --node NODE (--list [SUBDIR] | --file NAME | --query UNIT) [options]' \
    '' \
    'Required:' \
    '  --node NODE         Kubernetes node name' \
    '' \
    'Mode (exactly one):' \
    '  --list [SUBDIR]     List what /var/log (or SUBDIR under it) exposes. Start here:' \
    '                      file names differ per distro (syslog vs messages) and per node.' \
    '  --file NAME         Read /var/log/NAME (e.g. syslog, messages, kubelet.log)' \
    '  --query UNIT        Read UNIT from journald via the kubelet node log query.' \
    '                      Requires the NodeLogQuery feature (k8s >= 1.30 beta,' \
    '                      opt-in alpha in 1.27-1.29). When it is off, the kubelet' \
    '                      answers with a directory listing instead of an error —' \
    '                      this script detects that and tells you, rather than' \
    '                      reporting HTML as logs.' \
    '' \
    'Time window (--query only; file reads cannot be time-filtered server-side):' \
    '  --since T           RFC3339 ("2026-08-18T06:00:00Z") or epoch ("@1755526800")' \
    '  --until T           Same formats' \
    '' \
    'Filtering (case-insensitive, applied locally; repeat to OR patterns):' \
    '  --grep PATTERN      Extended regular expression (ERE)' \
    '  --grep-fixed STR    Literal string' \
    '' \
    'Other:' \
    '  --tail N            Max log lines printed (default: 200)' \
    '  --include-rotated   Also read NAME.1, NAME.2.gz, ... (oldest first)' \
    '  --head-bytes N      Stop each transfer after N bytes. This truncates from the' \
    '                      START of the file, i.e. it keeps the OLDEST bytes — do not' \
    '                      use it to look for recent events.' \
    '  --help              Show this help' \
    '' \
    'Exit codes:' \
    '  0  source read successfully (status: ok or no_match)' \
    '  2  usage error' \
    '  3  endpoint returned something that is not a log file (e.g. NodeLogQuery off)' \
    '  4  requested file does not exist on the node' \
    '  5  fetch failed for another reason' \
    '  6  forbidden — the agent lacks nodes/proxy access' \
    '' \
    'Examples (via local_script):' \
    '  --node node-1 --list' \
    '  --node node-1 --file syslog --grep "kubelet|containerd" --tail 300' \
    '  --node node-1 --query kubelet --since 2026-08-18T06:00:00Z --grep oom'
}

die_usage() {
  printf 'Error: %s\n\n' "$1" >&2
  usage >&2
  exit 2
}

set_mode() {
  [[ -z "$MODE" ]] || die_usage "--list, --file and --query are different modes; pick one"
  MODE="$1"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --node)  [[ $# -ge 2 ]] || die_usage "--node needs a value"; NODE="$2"; shift 2 ;;
    --list)
      set_mode list
      # Optional argument: only consume the next token when it is not a flag.
      if [[ $# -ge 2 && "$2" != -* ]]; then LIST_PATH="$2"; shift 2; else shift; fi ;;
    --file)  [[ $# -ge 2 ]] || die_usage "--file needs a value";  set_mode file;  FILE_NAME="$2";  shift 2 ;;
    --query) [[ $# -ge 2 ]] || die_usage "--query needs a value"; set_mode query; QUERY_UNIT="$2"; shift 2 ;;
    --since) [[ $# -ge 2 ]] || die_usage "--since needs a value"; SINCE="$2"; shift 2 ;;
    --until) [[ $# -ge 2 ]] || die_usage "--until needs a value"; UNTIL="$2"; shift 2 ;;
    --grep)
      [[ $# -ge 2 ]] || die_usage "--grep needs a value"
      [[ "$PATTERN_MODE" == "fixed" ]] && die_usage "--grep and --grep-fixed cannot be combined; pick one mode"
      PATTERN_MODE="ere"; PATTERNS+=("$2"); shift 2 ;;
    --grep-fixed)
      [[ $# -ge 2 ]] || die_usage "--grep-fixed needs a value"
      [[ "$PATTERN_MODE" == "ere" ]] && die_usage "--grep and --grep-fixed cannot be combined; pick one mode"
      PATTERN_MODE="fixed"; PATTERNS+=("$2"); shift 2 ;;
    --tail)  [[ $# -ge 2 ]] || die_usage "--tail needs a value"; TAIL="$2"; shift 2 ;;
    --include-rotated) INCLUDE_ROTATED=1; shift ;;
    --head-bytes) [[ $# -ge 2 ]] || die_usage "--head-bytes needs a value"; HEAD_BYTES="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) die_usage "unknown option: $1" ;;
  esac
done

[[ -n "$NODE" ]] || die_usage "--node is required"
[[ -n "$MODE" ]] || die_usage "one of --list, --file or --query is required"
# The node name lands inside a URL path; keep it to what a Kubernetes object name
# can be so nothing else can be addressed through it.
[[ "$NODE" =~ ^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$ ]] || die_usage "invalid node name: $NODE"
[[ "$TAIL" =~ ^[1-9][0-9]*$ ]] || die_usage "--tail must be a positive integer, got: $TAIL"
# Same bound as the on-node script: the last --tail lines are buffered while
# streaming, and --tail also becomes the kubelet's own tailLines in query mode.
TAIL_MAX=20000
TAIL_REQUESTED="$TAIL"
[[ "$TAIL" -gt "$TAIL_MAX" ]] && TAIL="$TAIL_MAX"
[[ "$HEAD_BYTES" =~ ^[0-9]+$ ]] || die_usage "--head-bytes must be a non-negative integer, got: $HEAD_BYTES"
if [[ "$MODE" != "query" && ( -n "$SINCE" || -n "$UNTIL" ) ]]; then
  die_usage "--since/--until only work with --query; a file read has no server-side time filter"
fi
# Reject what a mode cannot honour rather than accepting and ignoring it — a
# silently dropped filter is how an empty answer comes to look conclusive.
if [[ "$MODE" == "query" && "$INCLUDE_ROTATED" -eq 1 ]]; then
  die_usage "--include-rotated applies to --file; journald has no rotated files to add"
fi
if [[ "$MODE" == "list" && ${#PATTERNS[@]} -gt 0 ]]; then
  die_usage "--grep/--grep-fixed filter log lines, not the directory index; run --list without them"
fi
if [[ "$MODE" == "list" && "$HEAD_BYTES" -gt 0 ]]; then
  die_usage "--head-bytes bounds a log transfer; a directory index is small and always read whole"
fi
for p in "$LIST_PATH" "$FILE_NAME"; do
  # No absolute paths and no traversal: this endpoint is rooted at /var/log and
  # must stay there.
  [[ "$p" == /* ]] && die_usage "paths are relative to /var/log — drop the leading '/': ${p#/}"
  [[ "$p" == *..* ]] && die_usage "'..' is not allowed in a log path: $p"
done

command -v kubectl >/dev/null 2>&1 || {
  echo "Error: kubectl is not available in this context." >&2
  exit 5
}

BASE="/api/v1/nodes/$NODE/proxy/logs"

urlencode() {
  local s="$1" out="" c i
  for ((i = 0; i < ${#s}; i++)); do
    c="${s:i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) out+="$c" ;;
      *) out+=$(printf '%%%02X' "'$c") ;;
    esac
  done
  printf '%s' "$out"
}

to_rfc3339() {
  local raw="$1" flag="$2" secs
  if [[ "$raw" =~ ^@?[0-9]{9,12}$ ]]; then
    secs="${raw#@}"
    date -u -d "@$secs" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null && return 0
    date -u -r "$secs" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null && return 0
    echo "Error: $flag: could not convert epoch '$raw'." >&2
    return 1
  fi
  if [[ "$raw" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt].*([Zz]|[+-][0-9]{2}:?[0-9]{2})$ ]]; then
    printf '%s' "$raw"
    return 0
  fi
  echo "Error: $flag: the kubelet node log query needs RFC3339 (2026-08-18T06:00:00Z) or an epoch; got '$raw'." >&2
  return 1
}

# ── Response classification ────────────────────────────────────────────
# One cheap probe per path (first 2 KB, then the transfer is dropped), then a
# decision made from kubectl's EXIT CODE and STDERR — never from the response
# body. Matching the body for "Error from server" or "forbidden" would misread a
# log file that simply contains those words, and `error:` appears in ordinary
# syslog constantly: the check meant to prevent a wrong verdict would produce one.
#
# The verdict is returned in globals rather than on stdout: a `$(classify …)`
# substitution runs in a subshell, so the error message read from stderr would be
# lost exactly on the paths that need to report it.
CLASSIFY_KIND=""
CLASSIFY_ERR=""
classify() {
  local path="$1" body rc
  CLASSIFY_KIND=""
  CLASSIFY_ERR=""
  # pipefail is on, so this is kubectl's own status — except for SIGPIPE (141),
  # which means head stopped a transfer that was working, i.e. success.
  body=$(kubectl get --raw "$path" 2>/dev/null | head -c 2048)
  rc=$?
  if [[ "$rc" -ne 0 && "$rc" -ne 141 ]]; then
    # On this path the body is empty and the message is on stderr, so reading it
    # costs one more request against a response that carries no log data.
    CLASSIFY_ERR=$(kubectl get --raw "$path" 2>&1 >/dev/null)
    case "$CLASSIFY_ERR" in
      *Forbidden*|*forbidden*)  CLASSIFY_KIND="forbidden" ;;
      *NotFound*|*"could not find the requested resource"*) CLASSIFY_KIND="notfound" ;;
      *) CLASSIFY_KIND="error" ;;
    esac
    return
  fi
  case "$body" in
    *"<pre>"*|*"<a href="*) CLASSIFY_KIND="listing"; return ;;
  esac
  if [[ -z "$body" ]]; then CLASSIFY_KIND="empty"; else CLASSIFY_KIND="logs"; fi
}

# ── --list ─────────────────────────────────────────────────────────────
if [[ "$MODE" == "list" ]]; then
  path="$BASE/"
  [[ -n "$LIST_PATH" ]] && path="$BASE/${LIST_PATH%/}/"
  echo "source:      kubelet log endpoint, node=$NODE, path=/var/log/${LIST_PATH:+${LIST_PATH%/}/}"
  classify "$path"
  case "$CLASSIFY_KIND" in
    forbidden)
      echo "The agent's credentials lack 'get' on nodes/proxy, so this tier is closed."
      echo "Report that rather than concluding anything about the node's logs."
      echo "status:      forbidden"
      exit 6 ;;
    notfound)
      echo "No such directory under /var/log on this node."
      echo "status:      not_found"
      exit 4 ;;
    error)
      echo "$CLASSIFY_ERR" >&2
      echo "The request failed; see stderr for the API server's message."
      echo "status:      fetch_error"
      exit 5 ;;
    empty)
      echo "The endpoint answered with nothing. On some kubelets the log handler is"
      echo "disabled (--enable-debugging-handlers=false / enableSystemLogHandler: false);"
      echo "in that case this whole tier is unavailable, which is a statement about"
      echo "the kubelet, not about the node's logs."
      echo "status:      empty"
      exit 3 ;;
  esac
  echo "---"
  # The listing is an HTML index; the file names are the href values.
  kubectl get --raw "$path" 2>/dev/null | sed -n 's/.*<a href="\([^"]*\)".*/\1/p'
  echo "---"
  echo "Names ending in '/' are directories (list them with --list <name>)."
  echo "Pick the file that actually carries the component you need — and note the"
  echo "evidence boundary before reading absence as health:"
  echo "  This endpoint serves FILES under /var/log. If this node's journald does"
  echo "  not forward to syslog/messages, kubelet and containerd messages are NOT"
  echo "  in any of these files."
  echo "status:      ok"
  exit 0
fi

# ── Resolve what to fetch ──────────────────────────────────────────────
FETCH_PATHS=()
SOURCE_LABEL=""
NOTES=()

if [[ "$MODE" == "query" ]]; then
  q="$BASE/?query=$(urlencode "$QUERY_UNIT")"
  if [[ -n "$SINCE" ]]; then
    s=$(to_rfc3339 "$SINCE" "--since") || exit 2
    q="$q&sinceTime=$(urlencode "$s")"
  fi
  if [[ -n "$UNTIL" ]]; then
    u=$(to_rfc3339 "$UNTIL" "--until") || exit 2
    q="$q&untilTime=$(urlencode "$u")"
  fi
  # tailLines is served by the kubelet, so ask for it there as well as trimming
  # locally: it is the only bound this tier can push to the server side.
  q="$q&tailLines=$TAIL"
  FETCH_PATHS=("$q")
  SOURCE_LABEL="kubelet node log query, node=$NODE, unit=$QUERY_UNIT"
else
  HAVE_GZIP=1
  command -v gzip >/dev/null 2>&1 || HAVE_GZIP=0
  if [[ "$INCLUDE_ROTATED" -eq 1 ]]; then
    # Discover the rotations from ONE directory listing rather than probing each
    # candidate name: a probe is an API round trip, and 20 of them to find two
    # files is a poor trade when the index already names them.
    dir="$(dirname -- "$FILE_NAME")"
    base="$(basename -- "$FILE_NAME")"
    listing_path="$BASE/"
    [[ "$dir" != "." ]] && listing_path="$BASE/$dir/"
    names="$(kubectl get --raw "$listing_path" 2>/dev/null \
               | sed -n 's/.*<a href="\([^"]*\)".*/\1/p')"
    prefix=""
    [[ "$dir" != "." ]] && prefix="$dir/"
    # Highest rotation number first — logrotate numbers ascending with age, so
    # that order makes the concatenated output read chronologically.
    for n in {20..1}; do
      for suffix in "$n.gz" "$n"; do
        printf '%s\n' "$names" | grep -Fxq -- "$base.$suffix" || continue
        if [[ "$suffix" == *.gz && "$HAVE_GZIP" -eq 0 ]]; then
          NOTES+=("skipped $base.$suffix — gzip is not available in this context")
          continue
        fi
        FETCH_PATHS+=("$BASE/$prefix$base.$suffix")
      done
    done
    if [[ ${#FETCH_PATHS[@]} -eq 0 ]]; then
      NOTES+=("no numeric rotations of $base found in the directory index (date-suffixed schemes need an explicit --file)")
    fi
  fi
  FETCH_PATHS+=("$BASE/$FILE_NAME")
  SOURCE_LABEL="kubelet log endpoint, node=$NODE, file=/var/log/$FILE_NAME"
fi

# ── Probe the primary path before counting anything ────────────────────
PRIMARY="${FETCH_PATHS[${#FETCH_PATHS[@]} - 1]}"
classify "$PRIMARY"

echo "source:      $SOURCE_LABEL"
# A live file that has just been rotated away is not a dead end when its
# rotations were found: drop it, note the gap, and read what does exist.
if [[ "$CLASSIFY_KIND" == "notfound" && "$MODE" == "file" && ${#FETCH_PATHS[@]} -gt 1 ]]; then
  NOTES+=("/var/log/$FILE_NAME itself is absent (rotated away?) — only its rotations were read")
  unset 'FETCH_PATHS[${#FETCH_PATHS[@]} - 1]'
  FETCH_PATHS=("${FETCH_PATHS[@]}")
  CLASSIFY_KIND="logs"
fi
case "$CLASSIFY_KIND" in
  forbidden)
    echo "The agent's credentials lack 'get' on nodes/proxy. This tier is closed;"
    echo "say so instead of reporting an absence of logs."
    echo "status:      forbidden"
    exit 6 ;;
  notfound)
    if [[ "$MODE" == "query" ]]; then
      echo "The kubelet rejected the log query path."
    else
      echo "/var/log/$FILE_NAME does not exist on this node. Run --list first: file"
      echo "names differ per distro (Ubuntu: syslog; RHEL/CentOS: messages)."
    fi
    echo "status:      not_found"
    exit 4 ;;
  error)
    echo "$CLASSIFY_ERR" >&2
    echo "The request failed; see stderr for the API server's message."
    echo "status:      fetch_error"
    exit 5 ;;
  listing)
    if [[ "$MODE" == "query" ]]; then
      echo "This kubelet answered a journald query with the /var/log DIRECTORY LISTING,"
      echo "which is what it does when the NodeLogQuery feature gate is off (default"
      echo "below k8s 1.30). No journald data is reachable this way on this node."
      echo "Fall back to a file: --list, then --file syslog (or messages)."
      echo "status:      query_unsupported"
    else
      echo "/var/log/$FILE_NAME is a directory, not a file. List it with:"
      echo "  --list $FILE_NAME"
      echo "status:      not_a_log_file"
    fi
    exit 3 ;;
  empty)
    echo "The endpoint returned no bytes. Either the file is empty, or the kubelet's"
    echo "log handler is disabled (enableSystemLogHandler: false). Both are facts"
    echo "about the source, not evidence about the node."
    echo "status:      empty_source"
    exit 3 ;;
esac

if [[ ${#FETCH_PATHS[@]} -gt 1 ]]; then
  echo "reading:     ${#FETCH_PATHS[@]} file(s), oldest rotation first"
fi
if [[ "$MODE" == "query" ]]; then
  echo "window:      since=${SINCE:-<none>} until=${UNTIL:-now} (enforced by the kubelet)"
else
  echo "window:      whole file — this endpoint has no server-side tail or time filter."
  if [[ "$HEAD_BYTES" -gt 0 ]]; then
    echo "             --head-bytes $HEAD_BYTES keeps the FIRST $HEAD_BYTES bytes, i.e. the"
    echo "             OLDEST part of the file. Recent events are NOT in this output,"
    echo "             and the last line shown is cut at that byte boundary."
  fi
fi
if [[ "$HEAD_BYTES" -gt 0 ]]; then
  for p in "${FETCH_PATHS[@]}"; do
    if [[ "$p" == *.gz ]]; then
      NOTES+=("compressed rotations are cut mid-member by --head-bytes, so each one stops decompressing at that point")
      break
    fi
  done
fi
if [[ ${#PATTERNS[@]} -eq 0 ]]; then
  echo "filter:      none"
elif [[ "$PATTERN_MODE" == "ere" ]]; then
  echo "filter:      ERE, case-insensitive, ${#PATTERNS[@]} pattern(s): $(IFS='|'; echo "${PATTERNS[*]}")"
else
  echo "filter:      fixed string, case-insensitive, ${#PATTERNS[@]} pattern(s): ${PATTERNS[*]}"
fi
if [[ "$TAIL_REQUESTED" != "$TAIL" ]]; then
  NOTES+=("--tail clamped to $TAIL (requested $TAIL_REQUESTED)")
fi
if [[ ${#NOTES[@]} -gt 0 ]]; then
  for note in "${NOTES[@]}"; do echo "note:        $note"; done
fi

# ── Fetch, filter and count in one streaming pass ──────────────────────
read_source() {
  local p rc=0 status stages
  for p in "${FETCH_PATHS[@]}"; do
    status=0
    if [[ "$HEAD_BYTES" -gt 0 ]]; then
      # head closing the pipe is what aborts the transfer — the only way to bound
      # cost on this endpoint. It therefore kills kubectl with SIGPIPE (128+13)
      # BY DESIGN, and cuts a .gz member mid-stream so gzip reports an unexpected
      # EOF after emitting what it could. Judging the fetch by the pipeline's
      # combined status would file both of those as source_error, i.e. call the
      # intended mechanism a failure — so only kubectl's own status is read, and
      # only a non-SIGPIPE value from it counts.
      if [[ "$p" == *.gz ]]; then
        kubectl get --raw "$p" | head -c "$HEAD_BYTES" | gzip -dc 2>/dev/null
      else
        kubectl get --raw "$p" | head -c "$HEAD_BYTES"
      fi
      stages=("${PIPESTATUS[@]}")
      if [[ "${stages[0]}" -ne 0 && "${stages[0]}" -ne 141 ]]; then
        status="${stages[0]}"
      fi
    elif [[ "$p" == *.gz ]]; then
      kubectl get --raw "$p" | gzip -dc
      status=$?
    else
      kubectl get --raw "$p"
      status=$?
    fi
    # Remember a failed file instead of letting the last one decide: a rotation
    # that failed to transfer is a gap in the evidence and must be reported.
    [[ "$status" -eq 0 ]] || rc="$status"
  done
  return "$rc"
}

filter_stage() {
  if [[ ${#PATTERNS[@]} -eq 0 ]]; then
    cat
  elif [[ "$PATTERN_MODE" == "ere" ]]; then
    # -a: without it a NUL byte anywhere makes grep answer "binary file matches"
    # and print no lines — an empty result manufactured by the tool.
    local args=(-E -i -a -e "^$MARKER:") p
    for p in "${PATTERNS[@]}"; do args+=(-e "$p"); done
    grep "${args[@]}"
  else
    local args=(-F -i -a -e "$MARKER:") p
    for p in "${PATTERNS[@]}"; do args+=(-e "$p"); done
    grep "${args[@]}"
  fi
}

read_source \
  | awk -v marker="$MARKER" '{ n++; print } END { printf "%s:%d\n", marker, n+0 }' \
  | filter_stage \
  | awk -v tailn="$TAIL" -v marker="$MARKER" '
      { n++; buf[n] = $0; if (n > tailn + 1) delete buf[n - tailn - 1] }
      END {
        scanned = -1
        if (n > 0 && index(buf[n], marker ":") == 1) {
          scanned = substr(buf[n], length(marker) + 2) + 0
          delete buf[n]
          n--
        }
        matched = n
        if (scanned >= 0) printf "scanned:     %d line(s) transferred\n", scanned
        else              printf "scanned:     unknown (line counter lost)\n"

        shown = matched < tailn ? matched : tailn
        printf "matched:     %d line(s)%s\n", matched,
               (matched > shown ? sprintf(" (showing the last %d)", shown) : "")

        print "---"
        for (i = n - shown + 1; i <= n; i++) print buf[i]
        # Whether an empty result is no_match or a failed transfer is only known
        # once kubectl has exited, which is after this stage has written its
        # output — so report the count through the exit code and let the shell
        # print the single verdict.
        exit (matched == 0 ? 10 : 0)
      }
    '
STAGES=("${PIPESTATUS[@]}")
SRC_RC="${STAGES[0]}"
FILTER_RC="${STAGES[2]}"
REPORT_RC="${STAGES[3]}"

# One `status:` line, always the last one, with the explanation above it.
echo "---"
if [[ "$SRC_RC" -ne 0 ]]; then
  echo "Output above is partial: it is what arrived before the transfer failed."
  echo "Anything missing from it is unknown, not absent. See stderr for the cause."
  echo "status:      source_error (kubectl exited $SRC_RC)"
  exit 5
fi
if [[ "$FILTER_RC" -gt 1 ]]; then
  echo "The pattern was rejected, so NOTHING was searched — the transfer was wasted."
  echo "Fix the ERE syntax, or pass the string via --grep-fixed."
  echo "status:      filter_error (grep exited $FILTER_RC)"
  exit 2
fi
if [[ "$REPORT_RC" -eq 10 ]]; then
  echo "The source was read and produced no matching line. Bounded non-evidence for"
  echo "THIS query, not proof the condition did not occur: this endpoint only sees"
  echo "FILES under /var/log, so on a node whose journald does not forward to"
  echo "syslog/messages, kubelet and containerd messages are not here at all."
  echo "status:      no_match"
  exit 0
fi
if [[ "$REPORT_RC" -ne 0 ]]; then
  echo "status:      report_error (awk exited $REPORT_RC)"
  exit 5
fi
echo "status:      ok"
