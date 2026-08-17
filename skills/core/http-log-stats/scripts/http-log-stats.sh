#!/bin/bash
set -euo pipefail

# Aggregate HTTP status codes and request-duration buckets from an ingress
# controller's access log — in ONE pass per replica.
#
# Why this exists: computing "how many 503s" and "how many took >=60s" by
# running one `kubectl logs | grep -c` per question means re-streaming the whole
# window from the API server for every number you want. On a busy ingress that
# is 30-90s per call, and a four-bucket distribution across three replicas is
# twelve full pulls. This script pulls each replica's log exactly once and lets
# a single awk accumulate every dimension at the same time.
#
# It also reports COVERAGE. A statistic computed over a window the live log no
# longer covers is not a smaller truth, it is a wrong number — so the earliest
# retained line is compared against the requested window and the verdict is
# printed with the result.

NAMESPACE="ingress-nginx"
SELECTOR="app.kubernetes.io/name=ingress-nginx"
PODS=""
MATCH=""
SINCE=""
UNTIL=""
BUCKETS="1,10,60"
PRESET="nginx-ingress"

# printf, not a here-doc: bash backs here-documents and here-strings with a
# temporary file (pre-5.1, and for anything past the pipe buffer). It is
# unlinked immediately, but this script must not create a file at all — it runs
# read-only against production clusters.
usage() {
  printf '%s\n' \
    'Usage: http-log-stats.sh --since-time <RFC3339> [options]' \
    '' \
    'Required:' \
    '  --since-time T     Window start, RFC3339 UTC (e.g. 2026-08-17T12:02:06Z)' \
    '' \
    'Options:' \
    '  --until-time T     Window end, RFC3339 UTC. Default: now (open-ended).' \
    '  -n, --namespace N  Ingress controller namespace. Default: ingress-nginx' \
    '  --selector S       Pod label selector. Default: app.kubernetes.io/name=ingress-nginx' \
    '  --pod P[,P2]       Explicit pod name(s), comma-separated. Overrides --selector.' \
    '  --match S          Only count lines containing this substring (host, path,' \
    '                     service or ingress name). Omit to count all traffic.' \
    '  --buckets a,b,c    Duration bucket edges in seconds. Default: 1,10,60' \
    '                     (yields <1, 1-10, 10-60, >=60)' \
    '  --preset P         Access log format. Only "nginx-ingress" today.' \
    '  -h, --help         Show this help' \
    '' \
    'Example:' \
    '  http-log-stats.sh --since-time 2026-08-17T12:02:06Z \' \
    '    --until-time 2026-08-17T14:02:06Z --match my-service --buckets 1,10,60'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --since-time)    SINCE="$2";     shift 2 ;;
    --until-time)    UNTIL="$2";     shift 2 ;;
    -n|--namespace)  NAMESPACE="$2"; shift 2 ;;
    --selector)      SELECTOR="$2";  shift 2 ;;
    --pod)           PODS="$2";      shift 2 ;;
    --match)         MATCH="$2";     shift 2 ;;
    --buckets)       BUCKETS="$2";   shift 2 ;;
    --preset)        PRESET="$2";    shift 2 ;;
    -h|--help)       usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [[ -z "$SINCE" ]]; then
  echo "Error: --since-time is required. A rolling window (--since=2h) shifts between calls," >&2
  echo "       which makes successive numbers incomparable — pin an absolute start." >&2
  exit 1
fi
if [[ "$PRESET" != "nginx-ingress" ]]; then
  echo "Error: unknown --preset '$PRESET' (supported: nginx-ingress)" >&2
  exit 1
fi

# ── Resolve the replica set ────────────────────────────────────────────
if [[ -n "$PODS" ]]; then
  POD_LIST="${PODS//,/ }"
else
  POD_LIST=$(kubectl get pods -n "$NAMESPACE" -l "$SELECTOR" \
               -o jsonpath='{range .items[*]}{.metadata.name} {end}' 2>/dev/null || true)
fi
POD_LIST=$(echo "$POD_LIST" | tr -s ' ' | sed 's/^ *//; s/ *$//')

if [[ -z "$POD_LIST" ]]; then
  echo "window:    $SINCE .. ${UNTIL:-now}"
  echo "source:    live cluster (kubectl logs), ns=$NAMESPACE"
  echo "coverage:  UNAVAILABLE  (no controller pod matched ns=$NAMESPACE selector=$SELECTOR)"
  echo
  echo "No live source to count. The controller may have been replaced, or the"
  echo "namespace/selector is wrong. Verify with 'kubectl get pods -n $NAMESPACE',"
  echo "and if the pods are genuinely gone, this window can only be answered from"
  echo "a log/metrics backend — say so rather than reporting zero."
  exit 0
fi

POD_COUNT=$(echo "$POD_LIST" | wc -w | tr -d ' ')

# ── Coverage probe (cheap: first few KB per replica, not a full pull) ──
# --limit-bytes truncates from the START, so the first line is the oldest one
# still retained. Deliberately WITHOUT --since-time: we need to know how far
# back the log actually reaches, not where the window begins.
EARLIEST=""
for p in $POD_LIST; do
  first=$(kubectl logs -n "$NAMESPACE" "$p" --timestamps --limit-bytes=4096 2>/dev/null \
            | head -1 | cut -d' ' -f1 || true)
  [[ -z "$first" ]] && continue
  # Keep the LATEST of the per-replica earliest lines: if any replica's history
  # starts after the window opens, that replica's early traffic is missing, so
  # the aggregate is partial.
  if [[ -z "$EARLIEST" || "$first" > "$EARLIEST" ]]; then
    EARLIEST="$first"
  fi
done

COVERAGE="UNKNOWN"
COVERAGE_NOTE=""
if [[ -z "$EARLIEST" ]]; then
  COVERAGE="UNKNOWN"
  COVERAGE_NOTE="(could not read the earliest retained line)"
elif [[ "${EARLIEST:0:19}" > "${SINCE:0:19}" ]]; then
  COVERAGE="PARTIAL"
  COVERAGE_NOTE="(live log only reaches back to $EARLIEST — traffic before that is NOT counted)"
else
  COVERAGE="FULL"
  COVERAGE_NOTE="(earliest retained line $EARLIEST)"
fi

# ── Report header ──────────────────────────────────────────────────────
echo "window:    $SINCE .. ${UNTIL:-now}"
echo "source:    live cluster (kubectl logs), ns=$NAMESPACE, $POD_COUNT pod(s)"
echo "coverage:  $COVERAGE  $COVERAGE_NOTE"
[[ -n "$MATCH" ]] && echo "match:     $MATCH"

# ── Single full pull per replica, one awk pass over all of it ──────────
# Every replica's stream is concatenated into ONE awk so cross-replica totals
# come out already summed. Failures per replica are tolerated (a pod can be
# restarting) — unreadable replicas are reported via the parsed/total counters.
#
# awk formats the whole report itself. Piping its output through sort/read in
# the shell would be the only remaining way this script could touch disk (sort
# spills to /tmp above its memory threshold; read <<< is a here-string), and
# status codes are naturally ordered by walking 100..599 instead.
for p in $POD_LIST; do
  kubectl logs -n "$NAMESPACE" "$p" --timestamps --since-time="$SINCE" 2>/dev/null || true
done | awk -v until_t="$UNTIL" -v match_s="$MATCH" -v buckets="$BUCKETS" '
    BUCKET_INIT_ONCE == 0 {
      n = split(buckets, edge, ",")
      BUCKET_INIT_ONCE = 1
    }
    {
      # $1 is the RFC3339 stamp kubelet prepends via --timestamps. kubectl has
      # no --until, so the upper bound is enforced here; substr to seconds so a
      # fractional stamp cannot sort oddly against a whole-second bound.
      if (until_t != "" && substr($1, 1, 19) > substr(until_t, 1, 19)) next
      if (match_s != "" && index($0, match_s) == 0) next
      total++

      # $status sits right after the quoted request line ("GET /p HTTP/1.1" 200).
      # Anchoring on HTTP/x.y" survives referer/user-agent fields that contain
      # spaces, which makes positional field indexes unreliable.
      if (match($0, /HTTP\/[0-9.]+" [0-9][0-9][0-9]/)) {
        code = substr($0, RSTART + RLENGTH - 3, 3)
        codes[code]++
        parsed_status++
      }

      # $request_time is the fractional seconds immediately before the bracketed
      # $proxy_upstream_name. $request_length precedes it but is an integer, so
      # requiring a decimal point plus the trailing " [" pins the right field.
      if (match($0, / [0-9]+\.[0-9]+ \[/)) {
        rt = substr($0, RSTART + 1, RLENGTH - 3) + 0
        parsed_time++
        placed = 0
        for (i = 1; i <= n; i++) {
          if (rt < edge[i] + 0) { hist[i]++; placed = 1; break }
        }
        if (!placed) hist[n + 1]++
      }
    }
    END {
      printf "parsed:    %d lines (status %d, request_time %d)\n\n",
             total, parsed_status, parsed_time

      if (total == 0) {
        print "No matching lines in the window."
        print ""
        print "Before reporting this as \"no traffic\": confirm --match matches how the"
        print "access log names the target (ingress name / host / path, not the Deployment"
        print "name), and that this controller is the one serving it. An empty result is"
        print "bounded non-evidence for THIS command, not proof of zero requests."
        exit 0
      }

      print "status codes:"
      for (c = 100; c < 600; c++) {
        if (codes[c] > 0)
          printf "  %-5d %7d  %5.1f%%\n", c, codes[c], codes[c] * 100 / total
      }

      printf "\nrequest_time buckets (seconds):\n"
      for (i = 1; i <= n + 1; i++) {
        if (i == n + 1)   label = ">=" edge[n]
        else if (i == 1)  label = "<" edge[1]
        else              label = edge[i - 1] "-" edge[i]
        printf "  %-9s %7d  %5.1f%%\n", label, hist[i] + 0,
               parsed_time ? hist[i] * 100 / parsed_time : 0
      }

      # A parser that silently matched nothing would hand back a
      # confident-looking zero. Say so instead — the format is probably custom.
      if (parsed_status == 0 || parsed_time == 0) {
        printf "\nWARNING: parsed 0 %s from %d matching lines. This controller'"'"'s\n",
               (parsed_status == 0 ? "status codes" : "durations"), total
        print "log_format is probably not the nginx-ingress default — the counts above are"
        print "NOT trustworthy. Sample a few raw lines before drawing any conclusion."
      }
    }
  '
