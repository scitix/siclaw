# SSH Jump Host (ProxyJump) — Design Contract

> Multi-level bastion support for `host_exec` / `host_script` and the Portal host
> connection test. Records the contracts and rationale; implementation lives in
> the code.
>
> Covers the full path: topology (§2), how a target's whole bastion chain is
> resolved server-side and transported (§3–§6), the broker-free execution layer
> (§7), authorization (§8), and managed targets (§9).

## §1 Why

Production hosts (bare-metal, storage, GPU nodes) are frequently unreachable from
the agentbox except through a bastion. Bastions are modeled with standard OpenSSH
`ProxyJump` semantics rather than any platform-specific scheme, so the same host
inventory works standalone (TUI + local Portal) and when driven by an external
management server.

The target's **whole** bastion chain is resolved **server-side**, by id, and
shipped as an ordered `jump_chain` inside the target's single `credential.get`
response. The Runtime consumes it directly — **no per-hop credential fetch, no
name-recursion**. An earlier protocol carried only the nearest bastion's *name*
and recursed hop-by-hop; that path is retained as a fallback (§5, §6.6) but is
superseded.

## §2 Topology contract

- A host's optional `hosts.jump_host_id` self-reference names the next-hop
  bastion. Each bastion is itself a host row with its own credentials — equivalent
  to ssh_config `ProxyJump <named-host>`. Multi-level = a chain of references.
- **Depth is capped at 3** (`MAX_JUMP_DEPTH`). Cycles are rejected. The cap and
  cycle guard are enforced both on write (`validateJumpChain` in `host-api.ts`,
  invariant ①) and at resolve/dial time (invariant ②), because a row can be edited
  into a cycle after a child already references it.
- No FK constraint backs `jump_host_id` (mirrors `chat_sessions.parent_session_id`);
  integrity is an app-level concern and dangling references fail closed.

## §3 Transport protocol (`jump_chain`)

The credential boundary (`adapter.ts` WS-RPC + REST mirrors, `cli-snapshot-api.ts`)
identifies bastions by **host name** + IP/port/username, never an internal id. An
upstream id model never leaks into the standard SSH layer (`ssh-dial.ts`,
broker-free), which stays ignorant of any source system.

### §3.1 Shape and order

`credential.jump_chain` (`shared/credential-types.ts`) is an ordered array of
`ChainHop`, **`[outermost … nearest-to-target]`**:

- `outermost` = the directly-reachable bastion (dialed over plain TCP first).
- `nearest` = the bastion that fronts the target (the host's direct `jump_host_id`).
- Effective dial order is `jump_chain ++ [target]`.
- **Absent or empty `jump_chain` ⇒ direct connect.** There is no implicit jump.

Each `ChainHop` carries `name?` (diagnostics only — the chain is already resolved
server-side), `metadata` (`ip`, `port`, `username`, `auth_type`), and `files` (that
hop's own `host.key` [+ `host.passphrase`] or `host.password`).

### §3.2 A bastion is always explicit

A `ChainHop.auth_type` is `"password" | "key"` only — **never `"managed"`**
(invariant ③). A managed host has no key of its own; it sources its key *from* a
bastion at dial time (§9), so it can only ever be a chain **endpoint** (the target),
never an intermediate hop. The type system encodes this; emission enforces it.

## §4 Invariants (all fail-closed)

| # | Invariant | Enforced by |
|---|-----------|-------------|
| ① | **Write-time integrity** — a persisted `jump_host_id` is not a self-reference, dangling, cyclic, or deeper than `MAX_JUMP_DEPTH` (3). | `validateJumpChain` on host create/update |
| ② | **Resolve-time integrity** — re-checked at emission, because a row can be edited into a cycle / over-depth / dangling state *after* a child already references it. | `walkJumpChainRows` |
| ③ | **A bastion is explicit, never managed** — an intermediate hop must authenticate itself; a managed hop has no key to do so. | `chainHopFromRow` |
| ④ | **A bastion carries its own credential** — an explicit bastion's key/password material must be non-empty. | `chainHopFromRow` |

A violation of any of ①–④ **throws**; the target's `credential.get` fails rather
than silently degrading to a direct (bastion-less) connection (§6.5).

## §5 Emission (server boundary)

`buildHostSshCredential` resolves the chain once: `walkJumpChainRows` returns the
bastion rows `[outermost … nearest]` (invariant ②), each projected to a `ChainHop`
by `chainHopFromRow` (invariants ③ ④), attached as `credential.jump_chain`.

**Dual-emit for backward compatibility.** Alongside `jump_chain`, emission also sets
`metadata.jump_host` to the **nearest** bastion's name. A not-yet-migrated Runtime
ignores `jump_chain` and falls back to legacy name-recursion on `metadata.jump_host`;
a migrated Runtime prefers `jump_chain` and ignores the name.

The walk and projection are **shared** with the Portal's own dial path
(`resolveHostDialChain` reuses `walkJumpChainRows`), so the connection-test and the
emitted chain can never diverge.

## §6 Consumption (Runtime)

### §6.1 Nesting onto `SshTarget.jumpHost`

`ssh-client.ts` folds the ordered chain into the `ProxyJump` nest:
`target.jumpHost = nearest`, `nearest.jumpHost = second-nearest`, …,
`outermost.jumpHost = undefined` (directly reachable). No recursion, no per-hop
`credential.get`. `ssh-dial` then flattens this nest to its inline hop list exactly
as it did for the legacy recursion path — so the dialer is unchanged.

### §6.2 Registry keyed by `credential.name`

The broker registry is keyed by `credential.name`. When a caller's handle is not the
name (e.g. a host id), `get(handle)` misses; `ensureHost` falls back to
`get(response.credential.name)` from the just-acquired response before failing.

### §6.3 Isolated per-hop materialization

Each hop's files are written under an isolated prefix **`<name>.hop<i>.<file>`** and
kept **out of the target's `filePaths`**. This is load-bearing: `ssh-client` selects
the target's key/password/passphrase by **filename suffix** (`.endsWith(".key")`, …).
If a bastion's identically-named `host.key` lived in the target's `filePaths`, the
suffix match could hand the target the **bastion's** key. Hop files are tracked
separately and unlinked on evict/expiry/dispose alongside the target's own files
(`unlinkEntry`), so nothing leaks.

### §6.4 Fail-closed at consume

If emission already failed an invariant (§4), the target never materializes. On the
consume side, a hop missing its expected materialized file (e.g. an `auth_type=key`
hop with no `.key`) throws rather than dialing that hop credential-less.

### §6.5 No silent direct-connect

A broken jump (dangling/cyclic/over-deep, a managed bastion, or a credential-less
bastion) **fails the whole `credential.get`**. The target does not fall back to a
direct connection that skips the bastion — connecting straight to a host that is
*only* reachable through a bastion would both break and, worse, silently bypass the
intended network boundary.

### §6.6 Managed-target precondition

A managed target requires a jump (the bastion to source its key from). The
precondition is satisfied by **either** a non-empty `jump_chain` (new protocol) **or**
a non-empty `metadata.jump_host` (legacy) — checked at acquire (`acquireSshTarget`)
and at payload validation (`inferHostMetaFromResponse`).

## §7 Execution contract (`ssh-dial`, broker-free)

`ssh-dial.ts` dials the chain hop-by-hop: the outermost bastion connects over plain
TCP, each subsequent hop is reached via the previous hop's `forwardOut`
(`direct-tcpip`) channel passed as the next `ssh2` connection's `sock`. Every hop
performs its own end-to-end SSH handshake, so bastions relay only ciphertext and
never see downstream sessions or credentials. The chain is torn down in reverse
(final hop first). TOFU host-key verification is per `host:port` and shared with the
single-hop path. `ssh-dial` is **unchanged** by the `jump_chain` protocol — it still
receives an ordered inline hop list, whether built from `jump_chain` (§6.1) or from
the legacy name-recursion.

## §8 Authorization contract (security-sensitive)

Binding an agent to a target host **transitively authorizes its whole jump chain**:
`credential.get` for a bastion succeeds if the bastion is the jump host (within depth
3) of some directly-bound host (`isJumpOfBoundHost`).

**What the agentbox receives.** The agentbox authenticates *every* hop itself, so an
**explicit-credential** bastion's key/password is materialized onto the agentbox
(0600 broker files) exactly like any bound host — it is *not* kept server-side-only.
The sole exception is a **managed** target, whose key stays on the bastion and is read
at dial time (§9).

**Blast radius — binding a target hands that agentbox the credentials of every
explicit bastion in its chain.** And because `is_production` is enforced only on the
directly-bound entry host (not on transitively-pulled bastions), binding a *test*
target whose chain includes a *prod* bastion materializes that prod bastion's key onto
a *test* agentbox. This is the intended trust model: keep a chain within one trust
tier, or use `managed` so the key never leaves the bastion. The agent still cannot
point a materialized bastion key at an arbitrary host — `host_exec`/`host_script`
targets must be bound (visible via `host_list`).

## §9 Managed target auth (`auth_type=managed`)

Supported (see ADR-013). A managed host stores **no credential of its own**; the final
hop authenticates with a private key discovered on the bastion
(`~/.ssh/id_{ed25519,rsa,ecdsa,dsa}`, first readable), the target username comes from
the host record, and an optional `passphrase` decrypts an encrypted bastion key.
Contract:

- A managed host **requires a jump host** (the bastion to source the key from) —
  enforced on write (`host-api`), at the boundary (`adapter` emits no key/password
  file, only `auth_type:"managed"` + the jump via `jump_chain` and/or `jump_host`),
  at acquire (`acquireSshTarget`, §6.6), and at dial (`dialSshChain` rejects a managed
  first hop).
- `ssh-dial` sources the key by running a `cat` of the candidate paths over the
  already-connected bastion session, then dials the target through the tunnel with it
  (`MANAGED_KEY_FETCH_CMD`).
- **Security tradeoff (deliberate):** the key lives on the bastion and is read into
  agentbox memory at dial time — it is **not** broker-materialized/0600/agent-scoped.
  This is the cost of the convenience (one credential on the bastion fronting many
  targets). Use explicit per-hop credentials when you want full broker governance.

## §10 Out of scope (intentional)

- Identity-layer access (SSM/EICE/Teleport-style short-lived certs): future.
- The legacy `.ssh_config` (`ssh`-via-restricted-bash) path does not consume
  ProxyJump or passphrases yet; only `host_exec`/`host_script` and the Portal test do.
- Retiring the legacy name-recursion fallback (§5, §6.6) is a separate follow-up,
  gated on every emitter shipping `jump_chain`.
