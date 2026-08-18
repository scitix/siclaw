---
name: node-logs
description: >-
  Retrieve logs from a Kubernetes node — systemd units (journalctl) or files
  under /var/log. Use when you need node-level evidence: containerd, kubelet,
  kernel/OOM, or anything the pod's own log cannot show.
  Three access paths in order: host_script (SSH), node_script (debug pod), and
  local_script against the kubelet log endpoint when neither is possible.
---

# Node Logs

## Read this first: what an empty result means

Every command here can come back with nothing, and the reason matters more than
the emptiness. So both scripts print exactly one `status:` line and it is always
the **last line of the output**, with any explanation above it — one rule, every
outcome. (A bad argument is rejected on stderr with exit 2 before any report, so
there is no status line to read in that case.)

| `status:` | Meaning | What you may conclude |
|-----------|---------|-----------------------|
| `ok` | Source read, lines matched | Read the lines |
| `no_match` | Source read fine, filter matched nothing | **Nothing about the node.** Bounded non-evidence for that one query |
| `source_error` | The log source itself failed (see stderr) | Nothing — the output above it is partial |
| `filter_error` | Your pattern was rejected; nothing was searched | Nothing — fix the pattern and rerun |
| `not_found` / `not_a_log_file` / `empty_source` | The path is wrong, is a directory, or the handler is off | Nothing about the node's health |
| `query_unsupported` | This kubelet cannot serve journald over the API | Nothing — use a file, or tier 1/2 |
| `forbidden` | The agent lacks `nodes/proxy` | Nothing — an access fact, not a node fact |

`no_match` is the one that gets misread. "No PLEG messages in the last hour" is
not "PLEG is healthy": journald retention, a `--since` that misses the event, a
unit that never logged to this source, and a pattern that does not match this
component's wording all produce it. Report what you queried, not just that it
was empty. The header's `scanned:` count is what tells you whether anything was
actually read.

## Pick an access path

Try them in this order and say which one produced the evidence.

### Tier 1 — `host_script` (preferred)

The node is a bound SSH host: check `host_list` by node name or IP. No debug pod,
lowest latency, full journal access.

```
host_script: host="<host>", skill="node-logs", script="get-node-logs.sh", args="<args>"
```

### Tier 2 — `node_script`

The node is not a bound SSH host. Runs `get-node-logs.sh` inside the host's
namespaces via a privileged debug pod. Same arguments, same output.

```
node_script: node="<node>", skill="node-logs", script="get-node-logs.sh", args="<args>"
```

### Tier 3 — `local_script` against the kubelet log endpoint

Only when tier 1 and tier 2 are both impossible: no SSH binding **and** the debug
pod will not start (the node is NotReady, tainted, out of resources, or the image
cannot be pulled there). This path uses the agent's own kubectl, so it needs
nothing from the node beyond a responsive kubelet.

```
local_script: cluster="<cluster>", skill="node-logs",
              script="get-node-logs-via-api.sh", args="--node <node> --list"
```

**Set `cluster`** to the target cluster's credential name (from `cluster_list`);
`local_script` resolves it to a kubeconfig and exports `KUBECONFIG` for the
script. Do not pass `--kubeconfig` in `args`.

It is a genuinely weaker source, in three specific ways — all three matter when
you report:

- **It serves FILES under `/var/log`, not the journal.** If the node's journald
  does not forward to syslog/messages, kubelet and containerd messages are not
  reachable this way *at all*. A `journal/` entry in the listing means journald
  is persistent, but those files are binary and only `journalctl` can read them —
  which is exactly what tier 1 and 2 give you.
- **No server-side tail, no time filter, no ranges.** A file read transfers the
  whole file. `--head-bytes` can bound it, but it truncates from the *start* of
  the file, i.e. keeps the OLDEST bytes — useless for "what happened 10 minutes
  ago". Prefer a small, specific file over a multi-gigabyte syslog.
- **The journald query path is usually off.** `--query <unit>` uses the kubelet
  node log query (k8s ≥1.30 beta, opt-in alpha in 1.27–1.29). When the feature is
  off the kubelet answers with the `/var/log` **directory listing** and HTTP 200 —
  no error at all. The script detects that and reports `query_unsupported`
  instead of counting HTML as log lines. Always start with `--list`.

## `get-node-logs.sh` (tiers 1 and 2)

Source — one of, repeatable:

| Parameter | Description |
|-----------|-------------|
| `--unit UNIT` | Systemd unit (`containerd`, `kubelet`). Repeat to OR several units in one pass. |
| `--file PATH` | Log file path (`/var/log/messages`). Repeat for several files. |

Time window (journalctl only):

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--since T` | `1h ago` | Window start. Dropped when `--boot` is given, so the boot is not clipped. |
| `--until T` | now | Window end. **Requires an explicit `--since`** — otherwise the default hour would end before it. |
| `--boot ID` | — | `0` = current boot, `-1` = previous, or a boot ID |
| `--list-boots` | — | List boots with IDs and time ranges, then exit |

`T` accepts journalctl syntax (`30m ago`, `today`, `2026-08-18 14:00:00`), RFC3339
(`2026-08-18T06:00:00Z` — converted for you, journalctl rejects that form) or an
epoch (`@1755526800`). The header echoes both what you passed and what was
actually queried.

Filtering — case-insensitive, repeatable, applied in the same single pass:

| Parameter | Description |
|-----------|-------------|
| `--grep PATTERN` | **Extended regular expression.** `pod-a\|pod-b` means a OR b. Repeat for more alternatives. |
| `--grep-fixed STR` | Literal string — no metacharacters. Use for image refs, paths, UUIDs. |

`--grep` and `--grep-fixed` cannot be combined. An invalid ERE is reported as
`filter_error`, never as "nothing found".

Other:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--tail N` | `200` | Max log lines printed; matches are counted in full regardless. Clamped to 20000 (the buffer lives on the node) with a `note:` when it clamps. |
| `--include-rotated` | off | With `--file`, also read `PATH.1`, `PATH.2.gz`, … oldest first. Numeric rotations only; name date-suffixed files explicitly. |

Exit codes: `0` ok/no_match · `2` usage or filter error · `3` source unavailable
on this node (no journalctl) · `4` file missing/unreadable · `5` source failed.

### Output

```
source:      journalctl unit=kubelet
window:      since=2026-08-18T06:00:00Z (journalctl: @1755496800)  until=2026-08-18T07:00:00Z (journalctl: @1755500400)
boot:        not restricted (all boots in the window)
filter:      ERE, case-insensitive, 2 pattern(s): pod-a|pod-b
scanned:     14233 line(s) from the source
matched:     17 line(s)
---
Aug 18 06:11:02 node-1 kubelet[1820]: E0818 06:11:02.881 ... pod-a ...
---
status:      ok
```

### Examples

Containerd around an image pull failure — a registry reference is a literal, so
`--grep-fixed` avoids `.` and `-` behaving as regex:

```
host_script: host="node-1", skill="node-logs", script="get-node-logs.sh",
             args='--unit containerd --grep-fixed "myregistry.com/myapp:v1.2" --since "2h ago"'
```

Two pods in one pass over an exact incident window:

```
node_script: node="node-1", skill="node-logs", script="get-node-logs.sh",
             args='--unit kubelet --grep "pod-a|pod-b" --since 2026-08-18T06:00:00Z --until 2026-08-18T07:00:00Z'
```

Kernel OOM evidence across log rotations:

```
node_script: node="node-1", skill="node-logs", script="get-node-logs.sh",
             args='--file /var/log/messages --include-rotated --grep "out of memory|oom-kill"'
```

Did the node reboot, and what did the previous boot end with:

```
host_script: host="node-1", skill="node-logs", script="get-node-logs.sh", args="--list-boots"
host_script: host="node-1", skill="node-logs", script="get-node-logs.sh", args='--unit kubelet --boot -1 --tail 100'
```

## `get-node-logs-via-api.sh` (tier 3)

| Parameter | Description |
|-----------|-------------|
| `--node NODE` | Required |
| `--list [SUBDIR]` | List `/var/log` (or a subdirectory). **Start here** — file names differ per distro: Ubuntu `syslog`, RHEL/CentOS `messages`. |
| `--file NAME` | Read `/var/log/NAME`. Relative path only. |
| `--query UNIT` | Try journald via the kubelet node log query (often unsupported — see above) |
| `--since T` / `--until T` | `--query` only, RFC3339 or epoch. Rejected for file reads, where no time filter exists. |
| `--grep` / `--grep-fixed` | Same semantics as tier 1/2, applied locally |
| `--tail N` | Max log lines printed (default 200, clamped to 20000; in `--query` mode it is also the kubelet's own `tailLines`) |
| `--include-rotated` | Also read `NAME.1`, `NAME.2.gz`, … discovered from one directory listing |
| `--head-bytes N` | Stop each transfer after N bytes — from the file's **oldest** end, and the last line is cut mid-line |

Exit codes: `0` ok/no_match · `2` usage or filter error · `3` not a log file /
query unsupported / handler disabled · `4` file absent · `5` fetch failed ·
`6` forbidden (`nodes/proxy` missing).

```
local_script: cluster="prod", skill="node-logs", script="get-node-logs-via-api.sh",
              args="--node node-1 --list"
local_script: cluster="prod", skill="node-logs", script="get-node-logs-via-api.sh",
              args='--node node-1 --file syslog --grep "kubelet|containerd" --tail 300'
```

## Efficiency: one read, all the questions

The whole pipeline streams once and counts as it goes, in constant memory, so a
long window costs one journalctl read no matter how many patterns you ask about.
Pass every pattern to one invocation (`--grep a --grep b` or `--grep 'a|b'`)
instead of running the script once per pattern — repeating a two-hour journal
read for each keyword is the expensive mistake here, and on tier 3 it re-transfers
the entire file every time.

## Use cases

### Container runtime failures
`--unit containerd` (or `crio`) when pods will not start, images fail to pull, or
containers exit unexpectedly. Match the registry reference with `--grep-fixed`.

### Kubelet problems
`--unit kubelet` for evictions, volume mount failures, PLEG complaints, resource
pressure. Bound the window to the incident with `--since`/`--until` rather than a
wide `2h ago`: a wide window pulls in older, unrelated evictions that are easy to
misattribute to the pod you are investigating.

### Kernel and system events
`--file /var/log/messages` (RHEL) or `/var/log/syslog` (Ubuntu) with
`--include-rotated` for OOM kills, disk errors, and network driver resets. Note
these files only carry what journald forwards to them.

### Node reboots
`--list-boots`, then `--boot -1` to read the end of the previous boot — the
window before an unexpected restart is otherwise easy to miss entirely.

## See also

- `node-health-check` — node conditions, pressure, allocatable vs requested
- `image-pull-debug` — the pull-failure flow that reads containerd through this skill
