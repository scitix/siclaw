# platform/ — L3 adapter prototype (a "hosting layer" experiment over the platform-agnostic base)

kbc is a **platform-agnostic knowledge base "compile + test" base** (compile brain + moat + adapter interface).
`platform/` holds the **adapter prototypes** that make the base **hosted / integrated into some platform** — proving the interface and getting the pipeline running end to end,
not production code. The first real landing (sicore) is designed in **a worktree of another repo** (see the end of this file).

See `../design/L3-platform.md` (standalone v1 blueprint).

## Two pieces inside

### 1. forge adapter (standalone: a git forge as the storage substrate)
A prototype that treats "a git forge (Forgejo)" as the KB's storage / versioning / publish / consume substrate.

| file | role |
|---|---|
| `forge/docker-compose.yml` | spin up a local Forgejo (headless git hosting) |
| `forge_client.py` | dumb wrapper over the forge REST (issue/file/branch/PR/tag/tree), domain-agnostic, pure urllib |
| `publish.py` | publish gate: bundle → commit + release/tag (release notes = the ledger compilation summary) |
| `consume.py` | read-only consume: fetch the bundle of a published tag + sourced Q&A (via `tools/llm.py`) |
| `repo_sync.py` / `compile_repo.py` | compile-side full loop: repo drop/ → compile → bundle back to repo |
| `bridge.py` | contradiction ↔ forge issue translation (shelved in v1; contradictions moved to chat) |

**Verified**: publish v1 → fetch the version with a read-only token (writes rejected 401) → sourced Q&A correct; `compile_repo` full loop (pull→ingest→compile→emit→push) runs end to end.

### 2. pod/ — compile runtime (platform-agnostic: an Agent SDK compile pod)
Runs the kbc compile brain as a **Claude Agent SDK** `query()` task, containerizable.

| file | role |
|---|---|
| `pod/compile_agent.py` | entry point: Agent SDK runs the kbc brain, reads drop → compiles → writes bundle |
| `pod/Dockerfile` | py3.11 + `claude-agent-sdk` (ships the claude binary) + non-root |
| `pod/README.md` | notes on local subscription vs production massapi auth |

**Verified**: local run drop → 4-page OKF bundle (sourced, contradictions placed side by side per constitution version, $0.77, subscription auth needs no key). Container: image builds, runs non-root; **production needs `ANTHROPIC_BASE_URL`→massapi** (subscription auth does not enter the container).

## Relationship to the sicore landing (important)

> These are **base adapter prototypes**. **The first real landing = sicore**, which **reuses sicore's own `siclaw_knowledge` module + Temporal** and **does not use Forgejo**.
> That landing design lives in a worktree of the sicore repo: `~/project/sicore-kb-authoring` → `docs/design/kb-authoring-platform.md`.
> The forge set is kept as: ① an interface reference ② a standalone deployment option for non-sicore customers.
> The `pod/` set (Agent SDK compile) **will be reused** — it is exactly what runs inside the sicore compile pod image.
