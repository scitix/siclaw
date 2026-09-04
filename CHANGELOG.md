# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

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
- **A lost continuation abandoned a parked peer.** The
  `localSessionId → waitingTaskId` map is process-local; on a miss the transport
  now asks the control plane (`GET /tasks?contextId=…&status=working`) and
  adopts a task in `TASK_STATE_INPUT_REQUIRED` before opening a new one.
- **An unexpected SSE end errored out** although the code comment promised a
  `GET` fallback; the documented fallback is now implemented, keeping whatever
  had already streamed.
- **Every delegated call ran as the workload's service identity**, collapsing
  user-level authorization, audit attribution and no-self-approval onto one
  account. Both the `message:send` and `message:stream` bodies now carry
  `siclaw.onBehalfOfUserId` — taken only from a validated parent session's owner,
  and OMITTED rather than substituted when the originating user is unknown.
- **`SICLAW_DELEGATION_TRANSPORT=a2a` with a missing URL/token downgraded
  silently** to the legacy transport, so an operator believed they were on the
  durable path when they were not. It is now a loud startup/dispatch error. A
  non-`https:` base URL is refused unless `SICLAW_INNER_A2A_ALLOW_PLAINTEXT=1`
  is set (a long-lived bearer token over plaintext is capturable), and that
  escape hatch logs a warning every time.
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

#### Experimental A2A delegation transport (`SICLAW_DELEGATION_TRANSPORT=a2a`)

Opt-in third transport for `delegate_to_agent`: the peer task is submitted to
the management plane's inner A2A profile (durable task, waiting/resume,
budgets, dispatch retries) and its frames are translated back into the existing
peer-event vocabulary — tool inputs, coordinator SSE frames and roster
authorization unchanged. Includes per-leg redaction of model-visible text and
best-effort remote cancel on abort. Default off (legacy relay); design:
`docs/design/2026-09-02-a2a-delegation-transport.md`.

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
