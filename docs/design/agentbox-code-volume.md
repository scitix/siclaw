# Read-only AgentBox code volume

## Problem

An agent that operates a project's clusters can read live state but cannot read
the project's source. Diagnosis then runs backwards from symptoms with no way to
check what the running code actually does, and the agent has no cheap way to
acquire it either:

- the AgentBox image ships no `git`;
- `restricted_bash` is a command whitelist that, in the box's context, contains
  no `file` group at all — no `ls`, no `cat`, no `find` — and refuses text
  operands containing `/`;
- the pod's root filesystem is read-only.

So the source has to arrive as a mounted filesystem, prepared by something else,
and the agent has to reach it through the file tools it already has.

## Contract and ownership

Siclaw is a pure READER of this volume. An external supplier owns it end to end:
it creates the PVC, decides which repositories and which commits an agent may
see, writes the trees, and garbage-collects them. Nothing in this repository ever
writes to the volume, and no part of the control-plane protocol carries a "this
agent has code" field. The entire interface between the two systems is the layout
below plus one marker file.

### Volume layout

```
<volume root>/
└── agents/<agentId>/                 one directory per agent, subPath-scoped
    ├── <repo>@<view>/                a complete source tree at one commit
    ├── <repo>@<other-view>/
    └── .ready                        the supplier's completion marker
```

- `<agentId>` is sanitized with the same rule the Runtime uses for the
  `user-data` subPath: every character outside `[A-Za-z0-9._-]` becomes `_`, then
  truncated to 63 characters. This is an implicit cross-repository contract — the
  supplier writes these directory names and the Runtime mounts them, so a
  divergence in one character produces a mount pointing at a directory nobody
  fills. `k8s-spawner.test.ts` pins the rule against the `user-data` subPath so
  the two can never drift apart on this side.
- The layout is FLAT: one top-level directory per repository-and-view. Nesting
  views under a repository directory would collapse them into a single row in the
  prompt table whose file count is the sum of every view, and a `grep` for one
  symbol would match once per view.
- Dot-prefixed entries are not listed in the prompt table (the scanner keeps only
  directories and skips names starting with `.` while counting), which is why the
  marker and any supplier metadata belong there. Anything the supplier leaves as
  a NON-dot directory inside `agents/<agentId>/` is presented to the agent as a
  repository.

### The ready marker

`agents/<agentId>/.ready` — not a control-plane flag — decides whether a pod gets
the mount. Three reasons, in order of how much they cost when ignored:

1. **kubelet creates a missing subPath.** A mount whose subPath does not exist
   does not fail; kubelet creates the directory on the underlying writable mount
   and the pod starts normally. The agent then sees an EMPTY directory, and an
   agent that reads no files concludes the code says nothing. Checking the marker
   is the only thing standing between "no code" and "wrong answer".
2. **A pod's mounts are decided once.** `spawn()` reuses a Running pod after
   checking only its profile and its certificate; it does not re-evaluate
   volumes. A box that comes up without the mount stays without it for its whole
   life — until its idle self-destruct, an image roll, a certificate rotation, or
   an explicit terminate. The most common sequence for a newly prepared agent
   (prepare, then immediately talk to it) is therefore also the worst one, which
   is why the supplier is expected to create the directory and the marker
   SYNCHRONOUSLY before it reports the agent ready.
3. **Two sources for one fact always diverge.** The marker already states
   "a supplier has prepared this agent"; a delivered boolean saying the same thing
   can only be inconsistent with the filesystem for some window.

A missing marker is checked twice, ~200ms apart, before the Runtime concludes the
tree is absent. The volume is NFS-backed and a negative lookup for a
just-created file can be served from the client attribute cache; given (2), being
wrong is expensive and long-lived, while the retry is paid only on the miss path
and only when a code PVC is configured at all.

A missing marker is NOT an error. The supplier is an independent system and "not
prepared" is the normal steady state of every agent that has no source
configured. The box spawns without the mount and the Runtime logs why.

### What the agent sees

The mount path is `/app/.siclaw/repos` — the configured `paths.reposDir` — and
that choice is what makes this feature invisible inside the box:

- it is already in the file tools' read whitelist;
- its top-level directories are already scanned into the system prompt as the
  "Code Repositories" table;
- the AgentBox entrypoint chowns `credentials`, `skills`, `user-data` and
  `config` and deliberately does NOT touch `repos`, so a read-only mount there
  cannot fail its `set -e` startup.

The trees are readable but not a working copy: no `.git`, no shell access, and
`readOnly: true` on the mount. The agent reads them with `read`, `grep`, `find`
and `ls`.

### Permissions

The supplier writes directories `0755` and files `0644`; the box process (uid
1000) reads through the other bits.

🔴 **Do not add `fsGroup`.** kubelet chowns a volume RECURSIVELY at mount time.
On an NFS-backed tree of hundreds of thousands of files that is one SETATTR per
file; it consumes the entire `startupProbe` window and the container is killed
before it answers a single probe. The same failure is recorded in
`docker/agentbox-entrypoint.sh` for `user-data`. The other bits are the mechanism
here; group ownership is not.

🔴 **`readOnly: true` goes on the volumeMount, never on the volume source.** A
`readOnly` persistentVolumeClaim source is staged read-only by the CSI driver and
leaves the pod in `ContainerCreating` until the spawn deadline expires — a
multi-minute failure whose events blame the driver rather than the pod spec.

## Configuration

One switch, and it is infrastructure only:

| Where | Key | Meaning |
|---|---|---|
| Helm | `agentbox.codeVolume.claimName` | Name of the pre-existing RWX PVC. Empty (default) ⇒ feature off. |
| Runtime env | `SICLAW_CODE_CLAIM_NAME` | Same value; what the chart injects. |

When set, the chart also mounts that PVC read-only into the Runtime at
`/app/.siclaw/code-root`, which is how the Runtime reads the markers. That path
is never handed to an AgentBox; each box receives a subPath-scoped mount of its
own `agents/<agentId>/` subtree and can reach neither another agent's trees nor
the volume root.

There is no paired `enabled` policy flag and nothing arrives per-agent over the
control-plane protocol — see "The ready marker" (3). The chart never provisions
the PVC.

**With the claim name unset, pods are byte-identical to a deployment that never
had this feature**, and the Runtime does not touch the filesystem: the claim-name
check short-circuits before the marker lookup.

## Prompt table truncation

The knowledge overview gives the "Code Repositories" table a fixed character
budget and stops at the first row that would exceed it — roughly 16 rows,
ordered by file count descending. Before this change the remainder was dropped
silently, which is the worst possible failure for a table an agent treats as a
directory listing: it presents the surviving prefix as the complete set, so the
agent answers "that repository is not here" about a directory that is mounted and
readable.

The table now ends with a line naming the count it dropped and the tool that
lists the rest, at the mount's real path — `config.paths.reposDir`, resolved
through `modelKnowledgePath()` exactly as the wiki catalog does. The bare
`repos/` this file's prose once used is not a path any box has, so a note
carrying it would have pointed the agent at nothing. It is an improvement for every agent type, not only this one, and
it is counted against the same budget rather than exempted from it. Suppliers are
still expected to cap the number of views per agent — a visible truncation is a
cheap second step, not a substitute for a list that fits.

## The `coding` type

`coding` is the shared wire key in Runtime configuration and the Portal
type picker. Deployments upgrading from a product-specific key must migrate their
stored agent types before starting the new Runtime; no alias is provided. Keep
control-plane migrations and business prompts with the system that owns them.

A built-in agent type whose capability set is byte-identical to `sre`. This type
exists because the control plane wants to manage one fleet's prompt and lifecycle
separately, not because the mount needs different tools — the mount is decided by
the ready marker and is available to any agent the supplier prepares.

Its built-in `defaultPrompt` states only the three facts this runtime owns: the
trees are a read-only snapshot rather than a checkout, they are reachable only
through the file tools, and `.siclaw/repos/.revision.json` — not the truncating
prompt table — is the authoritative listing of what is mounted. The business
prompt (what a project's views mean, how to compare them) is owned and released
by the control plane, so the two stay single-source.

🔴 **A new agent type is six edits, and TypeScript catches only one of them.**
`AGENT_TYPES` is typed as `Record<AgentType, …>`, so widening the union does flag
that one — and `MATERIALIZED_TYPE_PROMPTS`. The rest are hand-written literal
comparisons that stay valid when the union grows:

| Place | On omission |
|---|---|
| `AgentType` union (`src/core/agent-types.ts`) | compile error at the registry |
| `AGENT_TYPES` | compile error |
| `MATERIALIZED_TYPE_PROMPTS` | compile error |
| `normalizeAgentType()` | silently downgrades the type to `custom` |
| `requireAgentType()` | THROWS — every session of that type fails to build |
| `portal-web/src/lib/agentTypes.ts` | the type picker cannot show it |

`requireAgentType()` is the sharp one: it is on the path of every session build
(`agent-context.ts`, `gateway/internal-api.ts`, `agentbox/local-spawner.ts`,
`portal/cli-snapshot-api.ts`) and it throws rather than degrading, so a forgotten
entry does not produce a weaker agent — it produces an agent that cannot start.
`agent-types.test.ts` now drives both functions from `Object.keys(AGENT_TYPES)`,
which turns each omission into a failing assertion that names the type.

A seventh copy used to exist in the AgentBox tools sync handler, where an unknown
`agentType` in a tool-capabilities payload THROWS and leaves the box with no
resolved tool schema at all. It is now derived from the registry rather than
re-listed; `agent-types.ts` is a dependency-free leaf, so importing it keeps that
module a leaf too.

## Scope and limitations

- Reading only. Nothing here creates, writes, prunes or quota-checks the volume,
  and the Runtime never reports on it.
- The mount decision is per-pod-creation. A running box does not gain or lose the
  mount when the volume changes underneath it; that takes a cold start.
- The trees carry no freshness signal that this repository interprets. Whatever
  a view's directory name means, and how stale it is, is the supplier's contract
  with its own users.
