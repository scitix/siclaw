# AgentBox Certificate Renewal

**Status:** implemented 2026-09-01
**Supersedes:** nothing — this is the first time renewal existed at all.

## The outage

An agent went permanently dark 30 days after its mTLS certificate was minted.

`AgentBox` certificates are issued for `AGENTBOX_CERT_VALIDITY_DAYS` (30) and stored
in a **per-agent** Secret, `agentbox-<agentId>-cert`, shared by every replica of that
agent. Nothing ever renewed one. Two reuse checks in `K8sSpawner.spawn()` compared
only the CA fingerprint — which answers *who signed this*, never *is it still valid* —
so an expired certificate under an unrotated CA was reused indefinitely, and the
freshly minted replacement was discarded on the 409 path.

Symptoms, which do not name their cause:

- AgentBox → Gateway: `socket hang up` (the Gateway closes on an expired client cert)
- Gateway → AgentBox: `certificate has expired`

Recovery required a human with delete rights on the Secret. **Deleting the pod did not
work** — the replacement mounted the same expired Secret.

## Contracts

### C1 — Renewal is driven by the clock, not by traffic

A certificate expires on a schedule, so renewal runs on one: the periodic tick that
already drives the orphan sweep (`AgentBoxManager.startOrphanSweep`, every 10 min).

This is not a matter of taste. `AgentBoxManager.getOrCreateK8s` **warm-reuses a running
box without consulting the spawner** — `isCertFresh` compares the CA fingerprint and
nothing else — so `spawn()` is never called for a resident pod. Hanging renewal off the
spawn path means the agents least likely to be recycled are exactly the ones that go
dark. The pod that produced this outage had `Idle self-destruct disabled — pod is
resident` in its log.

`spawn()` retains a freshness check, but only as the **cold-start guarantee** that a
new pod never begins life with a certificate about to lapse. It is not the mechanism.

### C2 — Renewal never destroys a pod

Renewal fires while `CERT_RENEW_THRESHOLD_MS` (7 days) of validity remain, so at the
moment the Secret is replaced **every running pod's current certificate is still
valid**. Pods keep serving and pick up the new material from the mounted volume on
their own. No restart, no dropped turn, no cold start.

This depends on C3 and is void without it.

### C3 — Both mTLS consumers re-read their certificate

The AgentBox reads `/etc/siclaw/certs` for two purposes — the `GatewayClient` (outbound)
and its own HTTPS server (inbound). Both must observe changes to the mounted files:
the client re-resolves per request, the server is pushed a new context via
`setSecureContext`.

Before this, both read once at construction. That produced a second, subtler failure:
after a Secret *was* refreshed, pods started before the refresh kept presenting the old
certificate. **They did not look broken** — readiness probes the pod's own loopback
`/health`, which never exercises mTLS — so a dead box stayed `Ready` and in rotation,
and the agent worked or failed depending on which box a turn landed on. Observed
2026-09-01: a pod started 09:38 against a certificate reissued at 09:49 failed every
resource sync while a sibling started at 09:52 synced cleanly.

Detection is by **stat, not `fs.watch`**: a Secret volume update is an atomic swap of
the `..data` directory, which replaces the inode behind each file, and a watcher bound
to the old inode can miss it entirely.

### C3a — The 7-day head start is what makes C3 optional per consumer

Renewal lands a week before expiry, so **any** process still holding the previous
material keeps working for another seven days. That, not "every box re-reads", is the
invariant that makes renewal safe for consumers which cannot reload — a `kb-compile`
box runs a different image with no reloader, and a run measured in minutes has three
orders of magnitude of headroom.

The one consumer this does **not** cover is a pod that outlives the whole seven days
without reloading. See C4a.

### C4 — A pod is never stamped with its certificate's identity

The pod carries the CA fingerprint and nothing else about the certificate. Under C3 a
pod's certificate is whatever the mounted Secret currently holds, so a version recorded
at creation would go out of date and then be believed — recycling pods that had already
healed themselves.

A **rotated CA** remains the one case that recycles: no amount of re-reading fixes it,
because the Secret being re-read is signed by the same dead CA until replaced.

### C4a — A pod is stamped with whether it CAN reload, and recycled if it cannot

`siclaw.io/cert-reload: "1"`. A pod without it predates C3, will never see a renewal,
and would go dark seven days after one — the original outage, reproduced by this
design's own renewal.

Nothing else removes such a pod: `isStaleImage` compares image **strings**, and the
default deployment pins `tag: latest` with `pullPolicy: Always`, so a rebuilt image is
byte-identical and never rolls anything.

A capability rather than a version, deliberately. A version stamp goes stale the moment
a pod reloads, so comparing against one destroys pods that already healed. A capability
never expires, and once every pod carries it the check stops firing forever — which is
what a migration guard should do.

### C5a — Renewal signs only a subject an independent witness agrees with

`readAssertedIdentity` reads what the stored certificate *claims*, with no signature or
validity check. The renewal gate is otherwise a **label**. Without a cross-check,
anyone able to write the Secret's data — namespace Secret write, which does not require
reading the CA key — could plant a certificate claiming another agent's identity and
have the next tick sign it with the real CA into a Secret they control, forging the
`boxId` that authorizes metrics reporting.

The subject is therefore compared against the Secret's own `agent` label and name
before anything is signed.

### C5 — Renewal carries the subject forward; it does not reconstruct it

A renewed certificate must assert the same `CN` / `O` / `serialNumber` as the one it
replaces. The org appears nowhere in the Secret's metadata, and `serialNumber` is the
base pod name the Gateway authorizes a metrics flush against (`handleMetricsFlush`).
Both are read from the stored certificate.

`verifyCertificate` cannot be used for this: it refuses to speak about a certificate
outside its validity window, which is precisely the certificate a renewal exists for.
`readAssertedIdentity` reads the subject without checking the CA signature or the
validity window and is **not an authentication primitive** — it must never gate a
request.

### C6 — A still-valid certificate is not orphan debris

The orphan sweep skips any Secret whose recorded expiry is in the future.

This closes a TOCTOU by construction rather than by narrowing. `spawn()` leaves a
current Secret untouched instead of rewriting it, so the sweep's 10-minute age guard —
which assumes a spawning box's Secret was just created — no longer covers it: an agent
with no pods yet (the state a cold spawn starts from) could have a perfectly good Secret
swept out from under the pod being created, leaving that pod on a missing volume
forever. Since `spawn()` skips writing only when more than `CERT_RENEW_THRESHOLD_MS`
remains, and the sweep skips anything with any time remaining, the two sets cannot
intersect.

Expired Secrets stay sweepable — those really are debris.

The skip applies **only to per-agent (`boxType: agent`) Secrets**. A capability box's
Secret is per-RUN and freshly written on every spawn, so the age guard always covered
it; extending the skip there would pin every finished run's Secret for a full
certificate lifetime.

### C7 — Renewal only touches certificates a pod is mounting

C6 and renewal would otherwise trap each other. Renewal keeps pushing an expiry out;
the sweep skips anything unexpired; so an orphaned Secret that renewal kept refreshing
would become **immortal** — exactly the accumulation the sweep was built to stop.

Nothing is lost by skipping orphans. A certificate matters only to a process holding
one. If the agent spawns again, `spawn()` mints fresh; if it never does, the
certificate lapses and the sweep collects it.

This also bounds the blast radius of C3's absence in non-Node boxes: a `kb-compile`
box runs a different image with no reloader, but it is short-lived and its certificate
is minted at spawn, so renewal cannot reach it mid-run in any realistic case.

## Coupled constants

`CERT_RENEW_THRESHOLD_MS` (`k8s-spawner.ts`) must stay comfortably below
`AGENTBOX_CERT_VALIDITY_DAYS` (`cert-manager.ts`). A threshold at or above the validity
makes every certificate permanently "expiring": re-minted on every tick and every cold
spawn, forever. The two live in different files with nothing else tying them together,
so the relationship is asserted by test.

## Deliberately not done

- **Deferring unstamped Secrets to `spawn()`.** Tried and rejected: it contradicts C1.
  A resident agent never cold-starts, and *every* Secret written before this design is
  unstamped — including the one from the outage — so deferring meant renewal never
  looked at the pods that actually went dark. An unstamped Secret is treated as due
  now, which needs no certificate parsing and is self-clearing.
- **No CA rotation from the renewal pass.** Replacing a rotated-CA Secret there would
  hand a live pod material it cannot chain, while the pods that must be recreated for a
  rotation are recreated by `spawn()`.
- **No alerting.** A gauge on remaining validity is worth adding; the logic being
  correct is not a reason to have no observation of it.

## Bounded work per tick

Each mint is a synchronous RSA-2048 keygen that blocks the event loop, so a tick
renews at most `MAX_CERT_RENEWALS_PER_TICK`. Steady state never reaches it — issue
dates spread naturally — but the first tick after an upgrade sees every unstamped
Secret at once. Spreading is free: the renewal window is a week and the tick is ten
minutes, so a backlog has roughly a thousand ticks to drain before the earliest
certificate is in any danger.
