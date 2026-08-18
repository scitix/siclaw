#!/bin/bash
# Retrieve logs from the node this script runs ON (host_script over SSH, or
# node_script via a privileged debug pod with nsenter).
#
# Two design rules drive everything below.
#
# 1. AN EMPTY RESULT IS NOT A FINDING. The previous version wrapped the whole
#    fetch pipeline in `|| true` and printed "No logs found" for every outcome:
#    a missing unit, a node without journalctl, an unreadable file, a journalctl
#    that failed, a filter that matched nothing, and a window that genuinely had
#    no messages all looked identical — and all exited 0. Agents read that as
#    evidence of health. Every one of those states is now reported separately,
#    with its own exit code, and the source's stderr is passed through untouched
#    instead of being merged into stdout and then fed to the filter.
#
# 2. ONE PASS, EVERY NUMBER. The pipeline counts lines scanned and lines matched
#    while it streams, in constant memory (a ring buffer of --tail lines), so a
#    long window costs one journalctl read no matter how many patterns are asked
#    about. Multiple --grep patterns OR together in that same pass.
#
# NOTE: `set -e` is deliberately OFF. This script must observe a non-zero exit
# from the log source and report it, not die halfway through its own report.
set -uo pipefail

# Byte-wise, locale-independent matching. Node logs are not guaranteed to be
# valid UTF-8 (kernel messages, truncated lines, binary noise in /var/log), and
# in a UTF-8 locale GNU grep can refuse or mismatch on invalid sequences — which
# would look like "nothing matched" for a reason that has nothing to do with the
# node.
export LC_ALL=C

UNITS=()
FILES=()
SINCE=""
UNTIL=""
BOOT=""
PATTERNS=()
PATTERN_MODE=""     # "ere" (--grep) or "fixed" (--grep-fixed); mutually exclusive
TAIL=200
INCLUDE_ROTATED=0
LIST_BOOTS=0

DEFAULT_SINCE="1h ago"

# Sentinel carrying the scanned-line count through the filter stage. It is
# emitted as the final line of the stream and matched explicitly by the filter,
# so "how many lines did we look at" survives even when nothing matched.
MARKER="__NODE_LOGS_SCANNED__"

usage() {
  # printf, not a here-doc: bash backs here-documents with a file in $TMPDIR.
  # This script runs on production nodes and must not write to their disk.
  printf '%s\n' \
    'Usage: get-node-logs.sh (--unit UNIT... | --file PATH...) [options]' \
    '' \
    'Log source (one of, repeatable):' \
    '  --unit UNIT         Systemd unit (e.g. containerd, kubelet). Repeat to OR units.' \
    '  --file PATH         Log file path (e.g. /var/log/messages). Repeat for several.' \
    '' \
    'Time window (journalctl sources only):' \
    '  --since T           Window start. Default: "1h ago" (dropped when --boot is given).' \
    '  --until T           Window end. Requires an explicit --since.' \
    '                      T accepts journalctl syntax ("30m ago", "today",' \
    '                      "2026-08-18 14:00:00"), RFC3339 ("2026-08-18T14:00:00Z",' \
    '                      converted for you — journalctl rejects the T/Z form) or an' \
    '                      epoch ("@1755526800" / "1755526800").' \
    '  --boot ID           Restrict to one boot: 0 = current, -1 = previous, or a boot ID.' \
    '  --list-boots        List known boots (with IDs and time ranges) and exit.' \
    '' \
    'Filtering (case-insensitive; repeat to OR patterns, matched in ONE pass):' \
    '  --grep PATTERN      Extended regular expression (ERE). "a|b" means a OR b.' \
    '  --grep-fixed STR    Literal string, no regex metacharacters.' \
    '                      --grep and --grep-fixed cannot be combined.' \
    '' \
    'Other:' \
    '  --tail N            Max log lines printed, most recent first-in-file order (default: 200)' \
    '  --include-rotated   With --file, also read numeric rotations (PATH.1, PATH.2.gz, ...)' \
    '  --help              Show this help' \
    '' \
    'Exit codes:' \
    '  0  source read successfully (status: ok or no_match)' \
    '  2  usage error' \
    '  3  log source unavailable on this node (e.g. no journalctl)' \
    '  4  requested file missing or unreadable' \
    '  5  the log source command itself failed (status: source_error)' \
    '' \
    'Examples (via node_script / host_script):' \
    '  --unit containerd --tail 50' \
    '  --unit kubelet --grep "pod123|pod456" --since 2026-08-18T06:00:00Z --until 2026-08-18T07:00:00Z' \
    '  --unit kubelet --grep-fixed "myregistry.com/app:v1" --since "2h ago"' \
    '  --file /var/log/messages --include-rotated --grep "oom|killed"'
}

die_usage() {
  printf 'Error: %s\n\n' "$1" >&2
  usage >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --unit)           [[ $# -ge 2 ]] || die_usage "--unit needs a value";        UNITS+=("$2");    shift 2 ;;
    --file)           [[ $# -ge 2 ]] || die_usage "--file needs a value";        FILES+=("$2");    shift 2 ;;
    --since)          [[ $# -ge 2 ]] || die_usage "--since needs a value";       SINCE="$2";       shift 2 ;;
    --until)          [[ $# -ge 2 ]] || die_usage "--until needs a value";       UNTIL="$2";       shift 2 ;;
    --boot)           [[ $# -ge 2 ]] || die_usage "--boot needs a value";        BOOT="$2";        shift 2 ;;
    --list-boots)     LIST_BOOTS=1; shift ;;
    --grep)
      [[ $# -ge 2 ]] || die_usage "--grep needs a value"
      [[ "$PATTERN_MODE" == "fixed" ]] && die_usage "--grep and --grep-fixed cannot be combined; pick one mode"
      PATTERN_MODE="ere"; PATTERNS+=("$2"); shift 2 ;;
    --grep-fixed)
      [[ $# -ge 2 ]] || die_usage "--grep-fixed needs a value"
      [[ "$PATTERN_MODE" == "ere" ]] && die_usage "--grep and --grep-fixed cannot be combined; pick one mode"
      PATTERN_MODE="fixed"; PATTERNS+=("$2"); shift 2 ;;
    --tail)           [[ $# -ge 2 ]] || die_usage "--tail needs a value";        TAIL="$2";        shift 2 ;;
    --include-rotated) INCLUDE_ROTATED=1; shift ;;
    --help|-h)        usage; exit 0 ;;
    # An unknown flag used to print the help text and exit 0, so a wrong
    # argument was indistinguishable from a successful run with no logs.
    *) die_usage "unknown option: $1" ;;
  esac
done

if [[ "$LIST_BOOTS" -eq 1 ]]; then
  # It answers one question and ignores the rest, so say so instead of accepting
  # a filter or a source and quietly dropping it.
  if [[ ${#UNITS[@]} -gt 0 || ${#FILES[@]} -gt 0 || ${#PATTERNS[@]} -gt 0 || -n "$SINCE" || -n "$UNTIL" || -n "$BOOT" ]]; then
    die_usage "--list-boots takes no other arguments; run it alone, then query the boot you want with --boot"
  fi
  if ! command -v journalctl >/dev/null 2>&1; then
    echo "Error: journalctl is not available on this node, so boots cannot be listed." >&2
    exit 3
  fi
  echo "source:      journalctl --list-boots"
  echo "---"
  journalctl --list-boots --no-pager
  rc=$?
  echo "---"
  echo "status:      $([[ $rc -eq 0 ]] && echo ok || echo "source_error (journalctl exited $rc)")"
  exit $(( rc == 0 ? 0 : 5 ))
fi

if [[ ${#UNITS[@]} -eq 0 && ${#FILES[@]} -eq 0 ]]; then
  die_usage "one of --unit or --file is required"
fi
if [[ ${#UNITS[@]} -gt 0 && ${#FILES[@]} -gt 0 ]]; then
  die_usage "--unit and --file read different sources; run the script twice rather than mixing them"
fi
if ! [[ "$TAIL" =~ ^[1-9][0-9]*$ ]]; then
  die_usage "--tail must be a positive integer, got: $TAIL"
fi
# The last --tail lines are held in memory while streaming. That is what keeps a
# multi-gigabyte journal read at constant cost, but it also means an unbounded
# --tail would grow the buffer on a production node — so it is clamped, loudly.
TAIL_MAX=20000
TAIL_REQUESTED="$TAIL"
[[ "$TAIL" -gt "$TAIL_MAX" ]] && TAIL="$TAIL_MAX"
if [[ ${#FILES[@]} -gt 0 && -n "$BOOT" ]]; then
  die_usage "--boot only applies to journalctl (--unit); a file has no boot index"
fi
# A default window silently overriding an explicit --until is exactly the kind of
# invisible clipping that produces an empty, misleading result: --until without
# --since would be read as "1h ago .. <old timestamp>", i.e. an inverted window.
if [[ -n "$UNTIL" && -z "$SINCE" ]]; then
  die_usage "--until requires an explicit --since (the default \"$DEFAULT_SINCE\" would end before it)"
fi

# ── Time normalisation ─────────────────────────────────────────────────
# journalctl accepts "2026-08-18 14:00:00" but NOT the RFC3339 "2026-08-18T14:00:00Z"
# that every alert and Kubernetes timestamp is written in. Convert instead of
# handing journalctl a value it will reject.
normalize_time() {
  local raw="$1" flag="$2" secs
  if [[ "$raw" =~ ^@?[0-9]{9,12}$ ]]; then
    printf '@%s\n' "${raw#@}"
    return 0
  fi
  if [[ "$raw" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt] ]]; then
    if secs=$(date -d "$raw" +%s 2>/dev/null); then
      printf '@%s\n' "$secs"
      return 0
    fi
    # BSD date (no -d). Nodes are GNU, but this also makes the conversion
    # verifiable off-node instead of only in production.
    if secs=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$raw" +%s 2>/dev/null); then
      printf '@%s\n' "$secs"
      return 0
    fi
    echo "Error: $flag: could not convert RFC3339 value '$raw' (date(1) rejected it)." >&2
    echo "       Pass \"YYYY-MM-DD HH:MM:SS\" (node-local time) or an epoch instead." >&2
    return 1
  fi
  printf '%s\n' "$raw"
}

SINCE_ARG=""
UNTIL_ARG=""
SINCE_DEFAULTED=0
if [[ ${#UNITS[@]} -gt 0 ]]; then
  if [[ -z "$SINCE" && -z "$BOOT" ]]; then
    # --boot already bounds the window; adding a default --since on top would
    # silently clip the boot to its last hour.
    SINCE="$DEFAULT_SINCE"
    SINCE_DEFAULTED=1
  fi
  if [[ -n "$SINCE" ]]; then
    SINCE_ARG=$(normalize_time "$SINCE" "--since") || exit 2
  fi
  if [[ -n "$UNTIL" ]]; then
    UNTIL_ARG=$(normalize_time "$UNTIL" "--until") || exit 2
  fi
fi

# ── Source preflight ───────────────────────────────────────────────────
SOURCE_LABEL=""
SOURCE_NOTES=()
READ_FILES=()

if [[ ${#UNITS[@]} -gt 0 ]]; then
  if ! command -v journalctl >/dev/null 2>&1; then
    echo "Error: journalctl is not available on this node — it may not run systemd," >&2
    echo "       or the journal is not reachable from this namespace." >&2
    echo "       Retry with --file (e.g. --file /var/log/messages --include-rotated)." >&2
    exit 3
  fi
  SOURCE_LABEL="journalctl unit=$(IFS=,; echo "${UNITS[*]}")"
  # journalctl exits 0 with no output for a unit it has never heard of, which is
  # the single most misleading case: "no logs" and "no such unit" look the same.
  if command -v systemctl >/dev/null 2>&1; then
    for u in "${UNITS[@]}"; do
      known=$(systemctl list-unit-files --no-legend -- "$u" "$u.service" 2>/dev/null)
      if [[ -z "$known" ]]; then
        # Offer the names that do exist: a wrong unit name ("containerd.service"
        # vs "containerd", "kubelet" vs "k3s") is the usual reason for silence.
        near=$(systemctl list-unit-files --no-legend 2>/dev/null \
                 | awk -v u="$u" 'tolower($1) ~ tolower(u) { printf "%s ", $1 }' \
                 | cut -c1-200)
        SOURCE_NOTES+=("unit '$u' is not a known systemd unit on this node${near:+ (similar: ${near% })}; historical journal entries may still exist")
      fi
    done
  else
    SOURCE_NOTES+=("systemctl unavailable — could not confirm the unit exists")
  fi
else
  HAVE_GZIP=1
  command -v gzip >/dev/null 2>&1 || HAVE_GZIP=0
  for f in "${FILES[@]}"; do
    before=${#READ_FILES[@]}
    if [[ "$INCLUDE_ROTATED" -eq 1 ]]; then
      # Oldest first so the output reads chronologically. Only NUMERIC rotations
      # are covered (logrotate's default); date-suffixed schemes such as
      # syslog-20260818 must be named with an explicit --file.
      for n in 9 8 7 6 5 4 3 2 1; do
        for cand in "$f.$n.gz" "$f.$n"; do
          if [[ -f "$cand" && -r "$cand" ]]; then
            if [[ "$cand" == *.gz && "$HAVE_GZIP" -eq 0 ]]; then
              SOURCE_NOTES+=("skipped $cand — gzip is not available on this node")
            else
              READ_FILES+=("$cand")
            fi
          fi
        done
      done
    fi
    if [[ ! -e "$f" ]]; then
      # Judged per requested file, not against the whole set: with several --file
      # arguments, one that yielded nothing at all is a missing source even when
      # an earlier file read fine.
      if [[ ${#READ_FILES[@]} -eq "$before" ]]; then
        echo "Error: '$f' does not exist on this node (and no rotation of it does either)." >&2
        echo "       Check the path (Ubuntu uses /var/log/syslog, RHEL /var/log/messages)," >&2
        echo "       or read the unit's journal with --unit instead." >&2
        exit 4
      fi
      SOURCE_NOTES+=("$f itself is absent — only its rotations were read")
    elif [[ ! -r "$f" ]]; then
      echo "Error: '$f' exists but is not readable by this process." >&2
      exit 4
    else
      READ_FILES+=("$f")
    fi
  done
  if [[ ${#READ_FILES[@]} -eq 0 ]]; then
    echo "Error: none of the requested files could be read." >&2
    exit 4
  fi
  SOURCE_LABEL="files: ${READ_FILES[*]}"
fi

# ── The report header ──────────────────────────────────────────────────
echo "source:      $SOURCE_LABEL"
if [[ ${#UNITS[@]} -gt 0 ]]; then
  win="since=${SINCE:-<none>}"
  [[ -n "$SINCE_ARG" && "$SINCE_ARG" != "$SINCE" ]] && win="$win (journalctl: $SINCE_ARG)"
  win="$win  until=${UNTIL:-now}"
  [[ -n "$UNTIL_ARG" && "$UNTIL_ARG" != "$UNTIL" ]] && win="$win (journalctl: $UNTIL_ARG)"
  [[ "$SINCE_DEFAULTED" -eq 1 ]] && win="$win  [--since defaulted]"
  echo "window:      $win"
  echo "boot:        ${BOOT:-not restricted (all boots in the window)}"
else
  # Saying so beats ignoring it: syslog-style lines carry no year, so a
  # reliable time filter is not something this path can offer.
  if [[ -n "$SINCE" || -n "$UNTIL" ]]; then
    echo "window:      IGNORED for file sources — --since/--until apply to journalctl only."
    echo "             Filter by time yourself from the timestamps in the output."
  else
    echo "window:      whole file (file sources cannot be time-filtered)"
  fi
fi

if [[ ${#PATTERNS[@]} -eq 0 ]]; then
  echo "filter:      none"
else
  if [[ "$PATTERN_MODE" == "ere" ]]; then
    echo "filter:      ERE, case-insensitive, ${#PATTERNS[@]} pattern(s): $(IFS='|'; echo "${PATTERNS[*]}")"
  else
    echo "filter:      fixed string, case-insensitive, ${#PATTERNS[@]} pattern(s): ${PATTERNS[*]}"
  fi
fi
if [[ "$TAIL_REQUESTED" != "$TAIL" ]]; then
  SOURCE_NOTES+=("--tail clamped to $TAIL (requested $TAIL_REQUESTED) — narrow the window or the pattern instead of buffering more on the node")
fi
if [[ ${#SOURCE_NOTES[@]} -gt 0 ]]; then
  for note in "${SOURCE_NOTES[@]}"; do
    echo "note:        $note"
  done
fi

# ── Fetch, filter and count in a single streaming pass ─────────────────
read_source() {
  if [[ ${#UNITS[@]} -gt 0 ]]; then
    local jargs=(--no-pager)
    for u in "${UNITS[@]}"; do jargs+=(-u "$u"); done
    [[ -n "$SINCE_ARG" ]] && jargs+=(--since "$SINCE_ARG")
    [[ -n "$UNTIL_ARG" ]] && jargs+=(--until "$UNTIL_ARG")
    [[ -n "$BOOT" ]] && jargs+=(-b "$BOOT")
    # stderr is NOT merged into stdout: a journalctl error must stay an error
    # instead of becoming a "log line" that the filter then silently drops.
    journalctl "${jargs[@]}"
  else
    local f rc=0 status
    for f in "${READ_FILES[@]}"; do
      case "$f" in
        *.gz) gzip -dc -- "$f" ;;
        *)    cat -- "$f" ;;
      esac
      # Capture first: a test would consume $? and always read as success. One
      # unreadable rotation is a gap in the evidence, so it must not be masked
      # by the next file succeeding.
      status=$?
      [[ "$status" -eq 0 ]] || rc="$status"
    done
    return "$rc"
  fi
}

# Stage 1 counts every line the source produced and appends the count as the
# final line. Stage 2 filters (the marker is matched explicitly so the count
# survives a zero-match filter). Stage 3 keeps only the last --tail lines in
# memory and prints the tallies, then reports "nothing matched" through its exit
# code (10) rather than printing a verdict: whether an empty result means
# no_match or source_error is only known once the source has exited, which
# happens after stage 3 has already written its output. Exactly one `status:`
# line is printed, by the shell, at the very end.
filter_stage() {
  if [[ ${#PATTERNS[@]} -eq 0 ]]; then
    cat
  elif [[ "$PATTERN_MODE" == "ere" ]]; then
    # -a: a log file can contain a NUL byte (utmp-style files, a truncated line),
    # and without it grep answers "binary file matches" and prints no lines at
    # all — an empty result produced by the tool, not by the node.
    local args=(-E -i -a -e "^$MARKER:")
    local p
    for p in "${PATTERNS[@]}"; do args+=(-e "$p"); done
    grep "${args[@]}"
  else
    # -F for the patterns, but the marker must still match as a regex-free
    # literal — it contains no metacharacters, so -F handles both.
    local args=(-F -i -a -e "$MARKER:")
    local p
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
        if (scanned >= 0) printf "scanned:     %d line(s) from the source\n", scanned
        else              printf "scanned:     unknown (line counter lost)\n"

        shown = matched < tailn ? matched : tailn
        printf "matched:     %d line(s)%s\n", matched,
               (matched > shown ? sprintf(" (showing the last %d)", shown) : "")

        print "---"
        for (i = n - shown + 1; i <= n; i++) print buf[i]
        exit (matched == 0 ? 10 : 0)
      }
    '
STAGES=("${PIPESTATUS[@]}")
SRC_RC="${STAGES[0]}"
FILTER_RC="${STAGES[2]}"
REPORT_RC="${STAGES[3]}"

# The verdict is ALWAYS the last line, with any explanation above it, so that one
# rule — read the last line — holds for every outcome of every invocation.
echo "---"
if [[ "$SRC_RC" -ne 0 ]]; then
  # The source itself failed. Its stderr went straight to the caller, so the
  # cause is visible instead of being folded into an empty "no logs" report.
  echo "Anything printed above is partial — it is what was read before the failure."
  echo "What is missing from it is unknown, not absent. See stderr for the cause."
  echo "status:      source_error (log source exited $SRC_RC)"
  exit 5
fi
# grep exits 1 for "no match" (impossible here: the line-count marker always
# matches) and >=2 for a real failure, which is nearly always an invalid ERE.
if [[ "$FILTER_RC" -gt 1 ]]; then
  echo "The pattern was rejected, so NOTHING was searched. Check the ERE syntax"
  echo "(unbalanced parenthesis or bracket), or pass the string via --grep-fixed."
  echo "status:      filter_error (grep exited $FILTER_RC)"
  exit 2
fi
if [[ "$REPORT_RC" -eq 10 ]]; then
  echo "The source was read successfully and produced no matching line. That is"
  echo "bounded non-evidence for THIS query, not proof that the condition did not"
  echo "occur: check that the window covers the event, that the pattern matches how"
  echo "this component words the message, and that the journal or file still retains"
  echo "that far back."
  echo "status:      no_match"
  exit 0
fi
if [[ "$REPORT_RC" -ne 0 ]]; then
  echo "status:      report_error (awk exited $REPORT_RC)"
  exit 5
fi
echo "status:      ok"
