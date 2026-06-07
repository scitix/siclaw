---
name: exec-smoke
description: >-
  Reachability / execution smoke: sleep a few seconds then echo a marker line.
  Runs identically locally, on an SSH host, inside a pod, or on a node — used to
  validate that a target is reachable and that script execution (including
  background execution) completes and reports back. Not a diagnostic of the
  workload itself; it only proves the execution path works.
---

# Exec Smoke

A trivial, side-effect-free script used to verify the execution path of the
`*_script` tools (local / host / pod / node), including `run_in_background`.

## Router

| Need | Action |
| --- | --- |
| Prove a target can run a script and return output | `scripts/sleep-echo.sh` |

## Script

`scripts/sleep-echo.sh [--seconds N] [--marker TEXT]`

- `--seconds N` — how long to sleep before echoing (default 2). Use a few
  seconds when validating background execution so the launch/complete lifecycle
  is observable.
- `--marker TEXT` — the exact line to echo on completion (default
  `EXEC_SMOKE_OK`). Useful as a correlation token.

It prints a `sleeping …` line, sleeps, then echoes the marker. No mutation, no
cluster calls.

## Targets

```
local_script: skill="exec-smoke", script="sleep-echo.sh", args="--seconds 3 --marker OK"
host_script:  host="<host>",        skill="exec-smoke", script="sleep-echo.sh", args="--seconds 3 --marker OK"
pod_script:   pod="<pod>", namespace="<ns>", skill="exec-smoke", script="sleep-echo.sh", args="--seconds 3 --marker OK"
node_script:  node="<node>",       skill="exec-smoke", script="sleep-echo.sh", args="--seconds 3 --marker OK"
```
