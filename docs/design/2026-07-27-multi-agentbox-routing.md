# Multiple AgentBoxes per agent

**Status:** proposed
**Date:** 2026-07-27 (revised 2026-07-29 — scope narrowed to the AgentBox tier)

## Context

### One pod per agent, shared by everyone who uses it

An AgentBox pod is keyed on `agentId` alone — `AgentBoxManager` says so outright
(`src/gateway/agentbox/manager.ts:4-7`) and `K8sSpawner.podName()` derives the pod name from the
agentId with no instance component (`src/gateway/agentbox/k8s-spawner.ts:104-113`).

Every user of an agent therefore shares one Node.js process:

| Resource | Value | Where |
|---|---|---|
| Event loop | 1 (single-threaded) | one `AgentBoxSessionManager` per process, `src/agentbox-main.ts:84` |
| CPU | limit 2000m | `k8s-spawner.ts:557` |
| Memory | request 256Mi / limit 4Gi (Burstable) | `k8s-spawner.ts:558` |
| Sub-agent concurrency | **4, pod-wide** | `session.ts:450`, `subagent-registry.ts:87` |
| Group reserve | `max(1, 4-1)` = 3, pod-wide | `session.ts:461` |

The limiter is an instance field on `AgentBoxSessionManager` (`session.ts:298`, `:450`) and the
code states the consequence at `:448`: *"Shared by every session in the pod so the cap is per-pod,
not per-conversation."* Latency is therefore a function of how many people use the agent, which
matches the reported symptom that the product got slower as adoption grew.

A prompt-level decision amplifies it: `src/core/prompt.ts:163` forbids the main agent from running
work in parallel itself and directs all concurrency to `spawn_subagent` — straight into that cap
of 4. Relaxing that is a separate, independent optimisation, out of scope here.

### The memory request sits below the idle floor

Three production boxes sampled while idle (CPU 3–4m, i.e. doing nothing):

| Pod | CPU | Memory | vs request 256Mi |
|---|---|---|---|
| agentbox-2d78… | 3m | 164Mi | 64% |
| agentbox-ba0f… | 4m | **282Mi** | **110% — already over** |
| agentbox-d6bd… | 4m | 213Mi | 83% |

A box exceeds its request while doing nothing. The scheduler packs nodes on 256Mi, real usage is
higher even at rest, and Burstable QoS makes these the first evicted under node pressure. This
sample establishes a floor only — it says nothing about the ceiling, which needs load data.

### New AgentBox images never take effect on their own

Pod reuse compares three things — phase, the `boxType`/profile label, and the CA fingerprint
(`k8s-spawner.ts:196-236`). **It does not compare the image.** So changing
`SICLAW_AGENTBOX_IMAGE` leaves running boxes on the old image indefinitely, which is why the
current deploy process requires deleting pods by hand — and that delete is a hard kill, not a
drain. A CA change takes the same hard-kill path.

### Two defects found while inspecting a live cluster

- **Cert Secrets leak.** A `${podName}-cert` Secret is created per pod with no `ownerReferences`,
  so nothing collects it when the pod goes. 47 orphans across four namespaces, the oldest 99 days.
- **Completed pods are never reaped.** `restartPolicy: Never` plus a clean idle exit leaves the
  pod in `Succeeded` indefinitely; the existing orphan sweep covers only capability boxes.

## Decision

Give each agent **N AgentBox pods at a fixed count**. No autoscaling.

The Runtime is a single replica, so it is the sole writer of every pool by construction. That
removes the machinery multi-writer designs need — **no lease, no registry, no peer forwarding**.
Adding Runtime replicas later means replacing "sole writer" with a K8s Lease; nothing else in this
design changes.

### A session belongs to one box for that box's lifetime

**Round-robin places a new session. Affinity keeps it there.** RR is not applied per request — a
second turn landing on a different box would find none of its state.

Bouncing a session discards warm state that directly costs latency:

| Warm state | Cost of bouncing |
|---|---|
| Debug pod cache (keyed `userId+cluster+node`, 60s idle evict) | next `node_exec` may pay a full pod cold start |
| Brain instance / tool set / guards | full `createSiclawSession` rebuild |
| MCP connections | rebuild |
| `_eventBuffer` SSE replay buffer | reconnect loses the in-flight stream |
| **Background jobs in `JobRegistry`** | **cannot move at all** |

The last row is the hard limit: `job_stop`'s abort handle is an in-memory closure over a running
child agent or shell process. It is a live async operation, not serialisable state. This design
never moves a session rather than answering for it.

**Re-binding is permitted in exactly one case:** the session has been released from box memory
*and* the pool changed (a new box appeared, or its box is draining). A released session has no
in-flight turn and no background work, so moving it costs warm state and nothing else. Without
this narrow exception, raising `replicas` would never rebalance anything.

### Losing a box loses in-flight work, not history

`user-data` runs on the shared RWX PVC with its per-agent subPath `agents/{agentId}`
(`k8s-spawner.ts:403-407`, `:533`), so every box of an agent mounts the same session tree and a
replacement box restores the conversation from JSONL. The turn in progress, background jobs, and
the SSE replay buffer are forfeit.

**No volume split is needed because memory is off.** `isMemoryEnabled()` defaults to false
(`src/core/config.ts:200-206`) and both the SQLite index and `PROFILE.md` are created only inside
`if (memoryEnabled)` blocks (`src/core/agent-factory.ts:357`, `:377`), so the shared subPath holds
nothing agent-scoped and nothing with concurrent writers.

### Placement metric: fewest in-flight turns

Two more intuitive metrics are wrong and are recorded here so they are not re-proposed:

- **Session count** — a box with two sessions can be saturated while one with six is idle.
- **Sub-agent slot occupancy** — tempting because it is the only thing with a visible queue, but
  most turns never spawn a sub-agent at all (LLM → tool → LLM → tool), so a box can be hammered
  with `activeCount` at zero. A slot is also not a unit of load: one child may run ten minutes and
  another five seconds.

In-flight turns (`_promptDone === false`) is cheap and counts actual concurrent work. Placement
only ever decides where *new* sessions go; what bounds existing ones is per-box concurrency, not
smarter placement.

### One certificate per agent, not per pod

The certificate already asserts the agent, not the pod: `CN = agentId` and every SAN is
agentId-derived, with the pod name appearing only in the informational `serialNumber` field
(`src/gateway/security/cert-manager.ts:159-176`). All boxes of an agent are the same principal —
they run the same code and hold the same credentials — so sharing one certificate is what the
certificate already means, not a compromise. Hostname verification is explicitly skipped on the
Runtime→box path (`src/gateway/agentbox/client.ts:151`), so sharing changes nothing about
verification.

This also **removes the Secret leak as a class** rather than patching it: the Secret's lifetime
follows the agent, so pods come and go without leaving orphans.

**One thing must change in the same release.** Metrics federation is keyed on the `boxId` carried
in the certificate (`src/gateway/internal-api.ts:730`); with a shared certificate every box
reports the same `boxId` and their metrics overwrite each other. The box must self-report its pod
name in the request body instead. Shipping this later would mean the phase-1 metrics are wrong.

### Two concurrency limits, for two different failures

Today's cap of 4 is pod-wide, so one session's fan-out starves everyone else's. Per-session is the
right shape — but it cannot be the only limit.

| Limit | Guards against |
|---|---|
| **Per session: 10** | one conversation's batch starving its neighbours |
| **Per pod: 50** | OOM |

Without a pod ceiling, ten sessions × ten children is a hundred full agent sessions in one process.
Queueing makes one user wait; **an OOMKill takes down every session on that box.** Both numbers
ship as helm values, mirroring the existing `SICLAW_SUBAGENT_CONCURRENCY` env path
(`subagent-registry.ts:97`). `groupChildLimiter` (`session.ts:461`) becomes per-session for the
same reason.

The pod ceiling of 50 is a **guess** — the only inputs are the measured idle floor (~200Mi) and the
memory limit. Per-child-session memory has never been measured, which is what phase 1 is for.

### Residency needs no new mechanism

All boxes are permanent, so they spawn with `SICLAW_AGENTBOX_IDLE_TIMEOUT = 0`. A non-positive
window already means resident (`src/agentbox/http-server.ts:523`, logged at `:555`). No keepalive
protocol, no role labels, no second watchdog.

The trade: a box never self-destructs, so a permanently removed Runtime leaves its pods behind.
Under fixed replicas that is acceptable — they are deliberately-resident infrastructure, and a
restarted Runtime re-adopts them from the K8s API, which the spawner already treats statelessly
(`manager.ts:9-10`).

### Changing `replicas` is asymmetric, and neither direction is instant

**Raising** spawns boxes immediately, but existing sessions stay put — the hot box stays hot and
relief arrives as new conversations land elsewhere. **Lowering** drains: mark the excess boxes,
stop routing new sessions to them, let the resident ones finish. Pick victims by ascending damage —
not-yet-Ready first, then zero bindings, then fewest bindings.

Draining boxes must be **observable** ("draining, N sessions left"), or an operator who sets
`replicas` from 4 to 2 sees four pods and no explanation.

### Deploys: compare the image, then drain

The image is already in the pod spec, so no version label is needed — compare it against the
configured `SICLAW_AGENTBOX_IMAGE`. The mismatch branch already exists for CA and profile
(`k8s-spawner.ts:203-230`); it changes from *hard kill* to *mark draining*.

Draining terminates in minutes. `channel_bindings.session_id` is a permanently **reused
identifier**, but a session resident in box memory is released after 30s idle
(`SESSION_RELEASE_TTL_MS`, `session.ts:187`) — a channel's permanent id does not mean a box holds
it forever. The `drained` condition is likewise already computed by the box for its own idle check
(`http-server.ts:537`) and only needs exposing.

The real tail is background work, not conversations: a sub-agent runs up to 600s
(`subagent-registry.ts:101`) and blocks its session from releasing (`_backgroundWorkCount`). A
five-minute deadline therefore covers normal conversations comfortably and cuts only long batches.

**Incompatible releases get a separate path.** Graceful drain assumes the new Runtime can keep
serving existing sessions on old boxes; where that does not hold, the window does not exist. A
helm flag declares a breaking release and takes the immediate-replacement path, so most deploys are
invisible and the rare disruptive one says so instead of silently mixing versions. This is not
hypothetical — `CLAUDE.md` already records a coupled change ("do not run a new agentbox against a
pre-routing-commit-gating gateway"). A box-advertised protocol version is the better long-term
answer, but there is no version number today; start with the declaration.

**Force-killed turns need an honest surface, not an automatic retry.** A turn killed midway may
already have run tools and persisted partial rows; replaying it means re-running on a mutilated
history, producing duplicated tool calls and text. The frontend should detect the dead turn and
offer a **manual** retry. On channel entrypoints the message simply fails and the user re-asks.

### Scope

Per-agent `replicas` lands in **Portal only**; the upstream control plane adapts to the same field
shape afterwards. **Absent `replicas` means 1, which is byte-identical to today**, so every phase
below ships safely before that adaptation exists.

Out of scope, and none of it blocked by this design: autoscaling, Runtime replication, control-plane
replication, regions.

## Contracts (what must hold)

- **A resident session never changes box.** Every request for it routes to its box. The only legal
  re-binding is a released session when the pool has changed.
- **RR places; affinity keeps.** Round-robin applies to new sessions only, never per request.
- **Placement never migrates load.** Raising `replicas` relieves future sessions only; existing
  ones stay where they are.
- **Pool state is read fresh every reconciliation round** and never cached across rounds as
  authoritative. This is what lets the loop tolerate restarts without any coordination.
- **A draining box does not count toward `replicas`**, so pod count exceeds it during a deploy.
  Node headroom must be sized for that peak.
- **A spawning box does count toward `replicas`**, or the loop opens several while waiting for
  readiness.
- **`drained` is reported by the box, never inferred.** A session can have no in-flight turn while
  a background sub-agent runs; only the box knows.
- **`replicas` absent ⇒ 1 ⇒ no behaviour change.** An agent that never opts in must observe
  nothing.
- **Deletion is graceful.** `terminationGracePeriodSeconds` must cover the box teardown
  (`agentbox-main.ts:99-124`, including `debugPodCache.evictAll()` which issues kubectl calls). It
  is currently unset anywhere in the repo, so the 30s default applies.
- **The CA must be stable across deploys.** A CA change hard-kills every box. Verified working in
  the test cluster (`helm.sh/resource-policy: keep`; the CA is 48 days older than the Runtime pod).
- **Memory stays disabled** unless `memoryDir` is first moved off the shared subPath — otherwise N
  processes write one SQLite file.
- **Phases 5 and 6 ship together.** Once boxes are resident they never idle out, so without
  image-mismatch draining a new AgentBox image can never take effect.

## Phasing

1. **Metrics** — in-flight turns, sub-agent active/pending, RSS, event-loop lag, under `siclaw_`
   names. Every later threshold is read from these, and they are useful against today's single box.
2. **Resources and prerequisites** — memory request to 1Gi and limit to 8Gi; sub-agents reuse the
   parent's `mcpManager` (`session.ts:1992` omits it, so each child takes the
   `new McpClientManager(...).initialize()` branch at `agent-factory.ts:459-462` — a child process
   per sub-agent per stdio server, awaited inside every spawn).
3. **Pod identity and certificates** — instance-suffixed pod names; one certificate per agent;
   `boxId` self-reported. Fixes both defects above. Still one box per agent, so no behaviour change.
4. **Affinity and reporting** — the binding table; the box exposes which sessions it holds and
   whether it is drained. Behaviour still unchanged; the interfaces multi-box needs exist.
5. **Fixed replicas** — the `replicas` field, the reconciliation loop, RR placement,
   `idle_timeout = 0`. Multi-box becomes real here.
6. **Image-mismatch draining** — plus `terminationGracePeriodSeconds`, the breaking-release flag,
   and the frontend's interrupted-turn surface. **Same release as phase 5.**
7. **Concurrency** — per-session 10 and a pod ceiling of 50, both from helm values.

Phases 1–3 are worth doing whether or not multi-box ships.

## Open

- **The pod ceiling of 50 is provisional.** Per-child-session memory is unmeasured; phase 1 supplies
  the data. Ship the guess, tune from values.
- **Startup must be rate-limited.** Bringing every active agent to its `replicas` at Runtime start
  means tens of pods created and images pulled at once.
