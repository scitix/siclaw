# SSH Jump Host (ProxyJump) — Design Contract

> Multi-level bastion support for `host_exec` / `host_script` and the Portal
> host connection test. Records the contracts and rationale; implementation
> lives in the code.

## Why

Production hosts (bare-metal, storage, GPU nodes) are frequently unreachable
from the agentbox except through a bastion. siclaw models this with standard
OpenSSH `ProxyJump` semantics rather than any platform-specific scheme, so the
same host inventory works standalone (TUI + local Portal) and when driven by an
external management server.

## Topology contract

- A host's optional `hosts.jump_host_id` self-reference names the next-hop
  bastion. Each bastion is itself a managed host row with its own credentials —
  equivalent to ssh_config `ProxyJump <named-host>`. Multi-level = a chain of
  references.
- **Depth is capped at 3** (`MAX_JUMP_DEPTH`).
  Cycles are rejected. The cap and cycle guard are enforced both on write
  (`validateJumpChain` in `host-api.ts`) and at acquire/dial time, because a row
  can be edited into a cycle after a child already references it.
- No FK constraint backs `jump_host_id` (mirrors `chat_sessions.parent_session_id`);
  integrity is an app-level concern and dangling references fail closed at dial.

## Wire-reference contract (stays platform-neutral)

The credential boundaries (`adapter.ts` WS-RPC + REST mirrors, `cli-snapshot-api.ts`)
carry the bastion's **host name**, never an internal id. The management server
resolves `jump_host_id → name` at the boundary; the broker stores it as
`HostMeta.jump_host` and `acquireSshTarget` recurses by name. This keeps the
execution layer (`ssh-dial.ts`, broker-free) ignorant of any source system, so an
upstream id model never leaks into siclaw's standard SSH layer.

## Execution contract

`ssh-dial.ts` dials the chain hop-by-hop: the outermost bastion connects over
plain TCP, each subsequent hop is reached via the previous hop's
`forwardOut` (`direct-tcpip`) channel passed as the next `ssh2` connection's
`sock`. Every hop performs its own end-to-end SSH handshake, so bastions relay
only ciphertext and never see downstream sessions or credentials. The chain is
torn down in reverse (final hop first). TOFU host-key verification is per
host:port and shared with the single-hop path.

## Authorization contract (security-sensitive)

Binding an agent to a target host **transitively authorizes its whole jump
chain**: `credential.get` for a bastion succeeds if the bastion is the jump host
(within depth 3) of some directly-bound host (`isJumpOfBoundHost`).

**What the agentbox receives.** The agentbox authenticates *every* hop itself, so
an **explicit-credential** bastion's key/password is materialized onto the
agentbox (0600 broker files) exactly like any bound host — it is *not* kept
server-side-only. The sole exception is a **managed** target, whose key stays on
the bastion and is read at dial time (see below).

**Blast radius — binding a target hands that agentbox the credentials of every
explicit bastion in its chain.** And because `is_production` is enforced only on
the directly-bound entry host (not on transitively-pulled bastions), binding a
*test* target whose chain includes a *prod* bastion materializes that prod
bastion's key onto a *test* agentbox. This is the intended trust model: keep a
chain within one trust tier, or use `managed` so the key never leaves the bastion.
The agent still cannot point a materialized bastion key at an arbitrary host —
`host_exec`/`host_script` targets must be bound (visible via `host_list`).

## Managed target auth (`auth_type=managed`)

Supported (see ADR-013). A managed host stores **no credential of its own**; the
final hop authenticates with a private key discovered on the bastion
(`~/.ssh/id_{ed25519,rsa,ecdsa,dsa}`, first readable), the target username comes
from the host record, and an optional `passphrase` decrypts an encrypted bastion
key. Contract:

- A managed host **requires a jump host** (the bastion to source the key from) —
  enforced on write (`host-api`), at the boundary (`adapter` emits no key/password
  file, only `auth_type:"managed"` + `jump_host`), at acquire (`acquireSshTarget`),
  and at dial (`dialSshChain` rejects a managed first hop).
- `ssh-dial` sources the key by running a `cat` of the candidate paths over the
  already-connected bastion session, then dials the target through the tunnel with
  it (`MANAGED_KEY_FETCH_CMD`).
- **Security tradeoff (deliberate):** the key lives on the bastion and is read into
  agentbox memory at dial time — it is **not** broker-materialized/0600/agent-scoped.
  This is the cost of the convenience (one credential on the bastion fronting many
  targets). Use explicit per-hop credentials when you want full broker governance.

## Out of scope (intentional)

- Identity-layer access (SSM/EICE/Teleport-style short-lived certs): future.
- The legacy `.ssh_config` (`ssh`-via-restricted-bash) path does not consume
  ProxyJump or passphrases yet; only `host_exec`/`host_script` and the Portal
  test do.
