# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

#### Handoff: one agent per network region, one agent as far as the user is concerned

A region's cluster APIs, host SSH, internal MCP servers and model endpoints are
reachable only from a box sitting inside that region, so a multi-region
deployment needs one Agent per region. The user should still see ONE agent. This
is the transfer mechanism that makes both true at once.

- **`transfer_to_agent`** — a terminal tool, shaped like `request_input`: it
  emits a `handoff_requested` control frame, drops this box's local copy of the
  session, and ends the turn. It does NOT flip any state itself; the control
  plane validates the target against the facade's roster, moves the session, and
  re-dispatches the brief on the same response stream, so the user sees one
  continuous answer with no card and nothing restated. Its destination menu
  lists each target's **bound clusters and hosts by name** — unlike
  `delegate_to_agent`, which gives counts only — because "which region owns this
  machine" IS the routing decision, and there are a handful of destinations
  rather than hundreds of peers.
- **`GET /api/internal/handoff-targets`** → `config.getHandoffTargets`. Scoped to
  the caller's mTLS identity like `/api/internal/delegates`: a facade gets its
  backends, a backend gets its facade (the hand-back) plus its siblings, an
  ordinary agent gets nothing and grows no tool.
- **`chat.send` honours `skipInitialPersistence` on a handoff hop**, not only on
  a cross-Runtime delegation. The brief is already persisted as the transfer
  tool's arguments, so re-persisting it would show the user their own question
  twice. The arriving turn is also framed as a handover in its prompt (this turn
  only, never persisted) — without it the receiving agent reads the brief as the
  user repeating themselves and apologises for it.
- **After a handoff, the rest of that turn is cut at the event pump.** The
  transfer tool is terminal by contract and its result text says so, but a model
  does not have to obey — and in the test environment it did not: the facade
  handed the conversation away, then retried the tool that had just failed, ran
  another, and wrote "the transfer seems broken, it came back to me". That
  paragraph reached the user AHEAD of the answer the receiving agent was already
  producing, and it was persisted, so every later turn would read it as history.
  `consumeAgentSse` now relays and writes nothing after `handoff_requested`
  (that event itself still passes; `prompt_done` is emitted outside the loop, so
  the chain still gets its dispatch signal). The abandoned box keeps burning
  tokens until its turn ends on its own — stopping the brain is the follow-up.
- **Every assistant/tool row now records WHICH agent produced it**
  (`chat_messages.from_agent_id`, stamped by `consumeAgentSse`). A handed-over
  session's `agent_id` stays the facade forever, so without this a transcript
  answered by two agents reads as one undifferentiated stream — and an analysis
  pass attributing a bad answer would attribute it to the wrong one. Absent
  caller → NULL, which is right when nothing ever moved.
- **A handed-away session loses its local transcript.** The local copy is a
  cache; the control plane is the authority. Marked at transfer time (the brain
  is still writing) and consumed either by `release`, which deletes the
  directory, or by a hand-back's `ensureSessionContext`, which drops it and
  reloads everything the other agent did in between. ⚠️ The mark is in-memory, so
  a box that crashes between the two keeps a stale transcript on its PV.
- **New capability group `transfer_conversation`**, deliberately not folded into
  `delegate_agents`: delegation calls a peer and keeps the turn, a transfer gives
  the session away for good, and granting one must not silently grant the other.
  Held by the `sre` and `coordinator` types — an agent with no facade and no
  backends has no destinations, so it expands to nothing.

### Fixed

#### Dispatch idempotency: released reservations and a cross-restart turn ledger

- **A pre-prompt failure silently dropped the dispatch.** The `(sessionId,
  dispatchId)` key was written before the awaits and no failure path removed it,
  so after a box-spawn / lock / persistence failure every retry was answered
  `duplicate: true` for a turn that had never run. The reservation is now
  *pending* → *confirmed* (once `client.prompt()` resolves, or the input is
  delivered as a steer) → or *released* on every failure path before the error
  is reported, so a retry re-dispatches.
- **The same dispatch could execute twice across a Runtime restart**, since the
  dedupe map is process-local. The AgentBox — which runs the turn and outlives
  the Runtime — now keeps a bounded per-session ledger of accepted `turnId`s
  beside the session history; `/api/prompt` answers a known `turnId` with
  `duplicate: true` without starting a turn. A corrupt or missing ledger reads as
  empty and never fails a turn.

#### A2A delegation transport: fast completions, bridge recovery, delegated identity

- **A fast task was reported as a failure.** After a successful resume the
  transport unconditionally issued `tasks/{id}:subscribe`, which the control
  plane answers 400 `UNSUPPORTED_OPERATION` for a terminal task — while the
  resume response body (previously discarded) may already carry the terminal
  Task. The body is now parsed and short-circuits when terminal; a 400/409 on
  subscribe falls back to `GET /tasks/{id}`.
- **Replay protection was structurally dead.** Each resume attempt sent a fresh
  `messageId: randomUUID()`, so the idempotency key could never match. Messages
  now carry a stable id derived from the logical message
  (`sha256(delegationId:taskId:text)`), and the initial `message:stream` — which
  sent none at all — carries one too, so a retried open cannot create a
  duplicate task.
- **A lost continuation abandoned a parked peer.** The remote conversation
  handle and the waiting task id both lived only in an in-process map, which
  gave a continuation three silent ways to vanish (a restart, the 500-entry
  cap's eviction, any gateway that had not opened the thread) — and the next leg
  then opened a task on a fresh context, so the peer parked mid-question was
  abandoned and the human's answer landed on a new turn. The context is now
  **derived** from the local peer session id, so it needs no storage and any
  process addresses the same remote thread; the task id is a hint whose miss
  costs one `GET /tasks?contextId=…&status=TASK_STATE_INPUT_REQUIRED` rather
  than a duplicate task.
- **An unexpected SSE end errored out** although the code comment promised a
  `GET` fallback; the documented fallback is now implemented, keeping whatever
  had already streamed.
- **Every delegated call ran as one service identity**, collapsing user-level
  authorization, audit attribution and no-self-approval onto a single account.
  The peer now executes as **its own owner**, resolved control-plane side from
  the peer agent's row. The on-behalf-of field this used to carry is gone with
  the identity it belonged to — as implemented it let a caller name any member
  of the org.
- **The transport asked for parked tasks by a spelling the control plane
  refuses.** `?status=working` is a 400, and the transport's own
  `if (!res.ok) return undefined` swallowed it, so recovery never once fired.
  Corrected to `TASK_STATE_INPUT_REQUIRED`; the mismatch survived 22 green tests
  on this side because the fixture registered the wrong spelling as a route.
- `delegate_to_agent` accepts optional `evidence_refs`;
  the delegation transport carries them as a structured `data` part
  (`application/vnd.siclaw.context+json`) so an investigation's basis crosses the
  agent boundary. References only — no inlined file bytes.

#### Repository hygiene

- Removed a raw NUL byte from `src/gateway/server.ts` (a composite map-key
  separator, now written as the `\u0000` escape — same runtime string). The NUL
  made standard tooling treat the file as binary: `grep` silently returned
  nothing for it and `rg` stopped early, so a reviewer could conclude a pattern
  was absent when the file was merely unreadable. `src/shared/repo-hygiene.test.ts`
  now fails on any NUL byte in a tracked `src/**/*.ts`.

### Changed

#### KB compile box: distinct image name + pod prefix (operations)

Renamed the KB compile box so operators can tell it apart from chat agentboxes at a glance during production troubleshooting (previously every pod was `agentbox-<id>` and the compile box could only be isolated by label/image filter).

- **Image rename**: `kbc-compile-box` → `siclaw-kbc-box` (Makefile build/push targets, helm `siclaw.compileBoxImage` derivation, Dockerfile/README/docs). `agentbox.compileBoxImage` explicit-override semantics are unchanged.
- **Pod-name prefix**: compile boxes now spawn as `kbc-box-<id>` instead of `agentbox-<id>`, declared on the BoxProfile (`podNamePrefix`) for the `kb-compile` / `kb-compile-codex` profiles. Derived resources (cert Secret, hostname) follow the prefix. Chat agentboxes and the read-only `kb-test` box keep the `agentbox-` prefix.
- **Upgrade behavior**: on the first compile spawn after upgrade, the spawner reaps any pod left under the old `agentbox-<id>` name for that agent (guarded to compile boxes only — a chat box under the same name is never touched), so the old and new pods do not coexist.
- **Legacy alias retirement**: releases `v0.2.8` through `v0.3.10` published the KBC image under both repository names. Starting with the next release, `make push-kbc` publishes only `siclaw-kbc-box`; update any explicit `agentbox.compileBoxImage` or `SICLAW_COMPILE_BOX_IMAGE` override before upgrading.
- **DevOps action required**: the internal registry replication rule must gain an entry for `siclaw-kbc-box` (the old `kbc-compile-box` was not in the rule and had to be pushed manually). Until the rule is added, push `siclaw-kbc-box` to the production registry manually.

### Added

#### Session resume guarantees and opt-in input requests (`chat.send`)

Two paired, per-call opt-ins for management-plane callers (design:
`docs/design/2026-09-02-session-resume-and-input-requests.md`):

- **`requireExistingSession`** — a continuation turn must land on a restorable
  session context (live, or persisted JSONL with real messages) or fail closed
  with `SESSION_CONTEXT_UNAVAILABLE` (HTTP 412, non-retriable) *before* any
  session is created; the failure reaches the caller as the standard
  `stream_error` + `prompt_done` pair, and the Runtime skips its compensating
  abort for it. AgentBox never silently starts a fresh session for a caller
  that asked to continue an old one.
- **`allowInputRequest`** — exposes `request_input` on non-delegated turns so an
  externally submitted task can pause, ask its caller one question, and resume
  in the SAME session. Joins the warm-session reuse predicate; never inherited
  by subagents; the emitted `input_required` carries `delegationId` only on
  delegated turns.
- `/api/prompt` 200 acks and `prompt_done` now carry `resumed: boolean` so the
  caller's control plane can verify the context really came back.
- `chat.send` accepts an optional `dispatchId`: retries of a dispatch whose ack
  was lost are idempotent per `(sessionId, dispatchId)` — a duplicate returns
  the original turn (`duplicate: true`) instead of starting a second turn or
  degrading into a steer.

#### A2A is the only delegation transport

`delegate_to_agent` submits the peer task to the management plane's internal
A2A entrance — durable task, waiting/resume, budgets, dispatch retries — and
translates its frames back into the peer-event vocabulary the coordinator box
already consumes. Tool inputs, the coordinator SSE frames and the delegation
card are unchanged. Includes per-leg redaction of model-visible text, a
structured `data` part for `evidence_refs`, remote `:cancel` on abort, and
translation of the entrance's tool records into the rich
`tool_execution_start` / `_end` events the box translator already parses.
Design: `docs/design/2026-09-02-a2a-delegation-transport.md`.

It needs **no configuration**: it reuses `SICLAW_SERVER_URL` and
`SICLAW_PORTAL_SECRET`, both of which a Runtime already needs to function. So
it cannot be pointed at the wrong control plane, cannot be handed a stale
token, and has no rotation story of its own.

Removed with it:

- The private start/event/control relay between Runtimes, and the
  `SICLAW_DELEGATION_TRANSPORT` switch that chose between them. There is no
  dual stack and nothing to select.
- The three control-plane RPCs the relay needed to route a leg itself
  (`delegation.resolveRoute` / `.terminal` / `.control`) — the entrance derives
  where the peer runs from the peer's own row, so the caller no longer decides.
- `delegation.readOnly`: a caller-set dial that also replaced the peer's
  persona. What a called agent may do is the called agent's configuration, not
  a request parameter.

#### Prometheus Observability Layer

Integrated Prometheus metrics via a decoupled event bus architecture. Business code emits diagnostic events; a single prom-client subscriber maps them to 11 Prometheus metrics covering token usage, cost, latency, tool calls, sessions, and health.

**New Components:**
- `diagnostic-events.ts` — zero-dependency event bus (`emitDiagnostic()` / `onDiagnostic()`)
- `metrics.ts` — prom-client subscriber, the only file that depends on prom-client
- `prom-federation-aggregator.ts` — Gateway-side federation: pulls each AgentBox's prom-client snapshot and delta-accumulates it into one stable series re-exported from `gateway:3001/metrics`. AgentBox metrics are NOT scraped directly (see below).

**Helm Chart:**
- ServiceMonitor for Gateway (`gateway:3001/metrics`) — the single, stable scrape target. AgentBox metrics reach Prometheus via Gateway federation, so there is no AgentBox PodMonitor.
- Grafana dashboard auto-import via ConfigMap with `grafana_dashboard: "1"` label
- PrometheusRule with preset alerts (opt-in)

**Breaking Changes:**
- AgentBox container port name changed from `http` to `https` in K8s manifests and `k8s-spawner.ts`. If you have external configurations (NetworkPolicies, custom Services, Istio VirtualServices) that reference the AgentBox port by name `http`, update them to `https`.
- AgentBox metrics are collected by Gateway federation (30s pull + SIGTERM final flush), not by Prometheus scraping the pod directly. There is no AgentBox `:9090` metrics server, no `metrics` container port, and no AgentBox PodMonitor.

**Dependencies:**
- Added `prom-client` for Prometheus metrics

---

#### mTLS Authentication for Gateway-AgentBox Communication

Implemented mutual TLS (mTLS) authentication to secure internal APIs between Gateway and AgentBox instances. This provides certificate-based authentication and authorization for all internal endpoints.

**Security Features:**
- Gateway acts as Certificate Authority (CA)
- Each AgentBox receives unique client certificate with embedded identity (userId, workspaceId, boxId)
- Certificate-based authorization for protected endpoints
- 30-day certificate validity with automatic renewal on AgentBox restart

**New Components:**
- `CertificateManager` class for CA operations and certificate issuance/verification
- `createMtlsMiddleware()` for HTTP request authentication
- `GatewayClient` class for AgentBox to make authenticated requests to Gateway
- Automatic certificate provisioning in K8s spawner (via Kubernetes Secrets)

**New API Endpoints:**
- `GET /api/internal/cron-list?userId={userId}` - List cron jobs for a user (with authorization check)

**Modified Components:**
- `K8sSpawner`: Issues client certificates and mounts them as Secrets in AgentBox Pods
- `agentbox-main.ts`: Uses `GatewayClient` instead of plain fetch for settings sync
- `manage_schedule` tool: Uses `GatewayClient` for listing cron jobs with mTLS authentication

**Documentation:**
- [mTLS Deployment Guide](docs/design/mtls-deployment.md) - Deployment and ops guide
- [mTLS API Reference](docs/design/mtls-api.md) - Developer reference
- [Security Architecture](docs/design/security.md) - Defense-in-depth model including mTLS

**Dependencies:**
- Added `node-forge` for X.509 certificate generation and verification

**Migration Notes:**
- Existing deployments continue to work (backward compatible)
- New AgentBox Pods automatically receive certificates
- Gateway URL must use `https://` scheme for mTLS to activate
- Certificate files mounted at `/etc/siclaw/certs` in AgentBox Pods

**Breaking Changes:**
- None (mTLS is additive and backward compatible)

**Performance:**
- TLS handshake overhead: ~50-100ms per connection (amortized with keep-alive)
- Certificate verification: ~1-5ms per request

**Testing:**
- All code compiles successfully with TypeScript strict mode
- Manual testing required for certificate generation and verification
- See [Testing section](docs/design/mtls-deployment.md#testing-mtls) for integration tests

---

## [0.1.0] - Previous Releases

(Add previous release notes here as they are created)

---

## Release Process

1. Update this CHANGELOG.md with all changes under [Unreleased]
2. Change [Unreleased] to version number and date: `## [X.Y.Z] - YYYY-MM-DD`
3. Create git tag: `git tag -a vX.Y.Z -m "Release X.Y.Z"`
4. Push tag: `git push origin vX.Y.Z`
5. Build and publish release artifacts

## Version Format

This project uses [Semantic Versioning](https://semver.org/):
- MAJOR version for incompatible API changes
- MINOR version for new functionality (backward compatible)
- PATCH version for bug fixes (backward compatible)
