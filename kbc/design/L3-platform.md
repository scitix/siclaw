# L3 Platformization — v1 Blueprint (converged 2026-06-25)

> L3 = turning kbc from "one person using it locally on the command line" into a service "a team uses online, hosted."
> L1 (spec) / L2 (tools) already run end-to-end locally; L3 adds multi-tenancy + hosting + read-only consumption.
>
> **Load-bearing stance**: do not build our own "runtime + storage + review UI" trio.
> Storage / data plane = reuse a **git forge (Forgejo) as headless git hosting** (we use only ~10% of it: git storage + versioning + auth + multi-tenancy);
> users are **completely unaware of the forge** (it runs on the internal network, our web sits in front). We build only: **a wrapper UI users don't perceive** + **the moat (contradiction → adjudication)**.

## 0. v1 in one sentence

> **"Local interactive compile mode + one publish button + read-only consumption," made hosted.** The maintainer experience ≈ drop documents + chat with the agent + click publish.

## 1. v1 locked scope — only 5 things exposed to the user

1. **Drop raw + compile with the agent** — the maintainer drops raw source documents and converses with the compile agent, which reads and writes the knowledge base following compile discipline (cite sources / never self-adjudicate contradictions / better to omit than to be wrong).
2. **For real contradictions, the agent asks you to adjudicate in the conversation** — no PR/issue; it just asks in chat "which reading applies here," and you adjudicate in one sentence (= the moat, moved into the conversation).
3. **Verify** — review ① the compile summary ② contradictions awaiting adjudication ③ the test-query results (see §5).
4. **Publish a version** — clicking publish = cutting an immutable version (git tag), automatically traceable.
5. **Read-only consumption** — consumers ask questions against **that published version** (read-only, sourced) and cannot see drafts.

**v1 explicitly does NOT do (written down, not forgotten):** per-change review / PR flow, concurrency / multi-writer conflict handling, multi-person collaboration / independent reviewers / skill spaces, batch operations, container orchestration / K8s, webhooks, billing quotas. Premise: there are only one or two maintainers, aligned privately. Add these once the team grows.

## 2. Two zones + a publish gate (replacing "per-change review")

- **Draft zone**: maintainer + agent change freely, no gate.
- **Published zone**: immutable versions, **consumers see only this**.
- **Publish gate** = the only "gate" retained = one deliberate "publish" action = tagging. It **gives "traceability" for free** (one tag per version, roll back anytime).

> Distinguish two kinds of "review": **per-change review** (every change waits for human approval) → ❌ cut (only needed for collaboration); **publish gate** (draft → deliberately publishing an immutable version) → ✅ keep (otherwise readers see half-finished work).

## 3. The forge's role: headless git hosting (using ~10%)

Your 5 underlying needs map onto git one by one: read/write = files; **concurrency + merge / line-level versioning / reviewable-before-change = git's core job**; auth / multi-tenancy.

- **The storage core must be git** (line-level diff / three-way merge / history) — S3 versioning / Nextcloud / DB are out (blob-level, no line-level merge, no review / no rollback semantics).
- **Full forge vs. bare git**: bare git is smaller, but you'd have to assemble auth / multi-tenancy / reviewed writes yourself; Forgejo is a single container + sqlite, **giving these for free**, extremely light on resources → v1 picks Forgejo.
- **Use only git storage + tag versioning + read-only access + token auth / org multi-tenancy; do not use its issue/PR UI.**
- Condition for replacing it: if we cut "multi-tenancy + auth + published-zone isolation," bare git would suffice and the forge becomes redundant. Currently not met, so it stays.

## 4. Two faces: maintain (write) / consume (read-only) — same git substrate

| | Maintain mode (write) | Consume mode (read-only) |
|---|---|---|
| Who | The KB's owner/maintainer (one or two) | People asking questions / siclaw mount |
| Sees what | Our compile web: chat compile + contradiction cards + test query + publish | Read-only Q&A box, mounted on the published version |
| Permission | forge write | forge read-only |
| Behavior contract (**loaded**) | `constitution.md` adjudication discipline | consume contract (use only KB content / cite sources / honest about not covered / refuse change commands) |
| Isolation | —— | **Physically no write path**: read-only published bundle, cannot reach drafts/compile |

> The maintainer's "test query" and the consumer's "Q&A" are the same thing — one connects to the draft, the other to the published version.

## 5. Review surface = compile summary + contradiction cards + test query (**not line-by-line diff**)

Line-by-line diff is for code; our product is "knowledge for people to query," and the agent rewrites/reorganizes the text → line-by-line diff is all semantically meaningless noise. We **care about Q&A quality**, so the review surface is:

1. **Compile summary** — the agent surfaces: which sources it read → which pages it produced → which contradictions it auto-merged (FYI) → which it left for you to adjudicate → which are "not covered." (Source: ledger findings + resolutions, already exists)
2. **Contradiction cards awaiting adjudication** — real conflicts: evidence inline + options ①②③④, adjudicate with one click. (Source: ledger parked, the moat)
3. **Test-query box** — before publishing, ask a few questions yourself and check whether the sourced answers are right = acceptance by "Q&A quality." (Source: consume mode / `kb_eval`, already exists)

> All three already exist in kbc **today** (summary = read the ledger, contradictions = parked, test query = consume/gate); the UI just presents them, no new engine needed.

Maintainer interface sketch (information architecture, not styling):
```
┌─ Knowledge Base X ───────────── [Draft]●──○ Published v? ─┐
│ banner: In draft · only visible to read-only users after "Publish" │
│ 📋 Compile summary: 5 sources→12 pages; 10 auto-merged; 2 to adjudicate; 3 not covered │
│ 🟡 Awaiting your confirmation (2) ▸ Trial quota 90 vs 30 days [①90][②30][③conditional][④mark-uncertain]│
│ 💬 Test query: [ question… ] → sourced answer                    │
│ [ Publish this version ]                  📜 Version history (drawer)│
└──────────────────────────────────────────────────┘
```

## 6. UI blueprint: lightly reference the siclaw skill lifecycle — but **styling not locked**

siclaw's skills are already a "draft → published version → traceable" model (the banner copy even says "drafts are test-env only; publishing goes to production"). **Lightly reference its information architecture / interaction patterns, do not replicate**:

- **Take**: the lifecycle dot bar (draft → verified → published) / the version-timeline drawer + rollback (each version's detail = that version's "compile summary," not line-by-line diff) / the status banner / contradiction cards (borrow its "approval-card inline accordion" skeleton, replacing the content with evidence + options) / the card·drawer·dialog architecture (few pages).
- **Drop**: line-by-line diff preview / independent-reviewer track / global contributions / skill spaces / batch.
- **Self-contained components that can be lifted directly**: `SkillLifecycleStatus.tsx`, `components/VersionHistoryDrawer.tsx`, the status banner. Source: `/Users/sdliu/project/siclaw_main/src/gateway/web/src/pages/Skills/`.

> ⚠️ **Visual styling is not frozen**. Only the information architecture / interaction patterns are locked; the concrete styling is decided when building the frontend.
> Styling reference: the existing **8080 consume-face demo** "GPU selection knowledge base · evidence desk" (`~/test-gpu-kb/app/`, uvicorn gpuwiki.server), with sourced/evidence-style Q&A — or find another suitable frontend sample.

## 7. Build vs. fork red line (the moat is not outsourced)

- **fork (the substrate, don't rewrite)**: Forgejo (git storage / tag / auth / multi-tenancy).
- **Build (~30%, the moat)**: ① the wrapper web users don't perceive (chat compile / compile summary / contradiction cards / test query / publish) ② the contradiction → self-adjudicate/escalate adjudication loop (verified) ③ two KB-specific gate metrics (bundle self-contradiction + source → compile coverage).
- Consumer Q&A / publish gate: kbc already has these; platformization just wraps a read-only shell + connects to the published version.

## 8. Impact on already-written code

- `platform/forge_client.py` — **keep** (data-plane access layer). v1 needs to add: **commit files** + **tag/release**. The current issue/PR methods are demoted to "not used for now."
- `platform/bridge.py` (contradiction → forge issue) — **shelved for v1** (contradictions are adjudicated in chat, not filed as forge issues; enable later if async / multi-person review is needed).
- `worker.py` — form TBD (see §9).

## 9. Runtime (axis B: run the compile agent remotely)

Orthogonal to "where the human reviews." v1 = run headless `claude -p` on the server (`llm.py` is already this backend, reusing subscription auth, no key needed; GPU-KB consumption verified) or keep a server-side agent session alive. Containerization (Docker per-job / agentbox) = v2.

## 10. Open items / load-bearing assumptions

- **Load-bearing assumption (accepted)**: forge-centric (platform = wrapper + headless forge), not a bespoke runtime.
- Gitea vs. **Forgejo** (leaning Forgejo, more open governance).
- UI visual styling: TBD (§6).
- Runtime form (§9): v1 headless, v2 containers.

## 11. Platform capability matrix (v1) — each row mapped to implementation + status

> Status: ✅ verified = implemented and actually run-verified / ✅ exists = implemented (pre-existing in L2 or already written) / 🟡 = in progress / ⏳ = explicitly v2.

**A. Data plane / storage (Forgejo headless git hosting)**
| Capability | Implementation | Status |
|---|---|---|
| git storage (versions/history/diff) | `platform/forge/docker-compose.yml` (Forgejo 11) | ✅ verified |
| Multi-tenancy (org/repo) | Forgejo org/repo | ✅ exists (single repo kbc/aliyun-fc) |
| Auth (read/write token) | Forgejo token + `.kbc.token` / `.kbc.ro.token` | ✅ verified |
| Read-only isolation (consumer has no write path) | Read-only token (read:repository) | ✅ verified (writes rejected with 401) |

**B. Data-plane access layer `platform/forge_client.py`**
| Capability | Method | Status |
|---|---|---|
| Read/write repo files / commit multiple files at once | get_file / put_file / commit_files | ✅ verified |
| Tag/release / list versions / list file tree | create_release / list_releases / list_tree | ✅ verified |
| issue / branch / PR | open_issue·get_comments… / create_branch / open_pr | ✅ exists (shelved for v1) |

**C. Maintain side (compile)**
| Capability | Implementation | Status |
|---|---|---|
| Drop raw (drop file CRUD, auto history trail) | git/forge (commit_files) | ✅ exists (git's native diff) |
| Pull raw / push bundle (repo↔local) | `platform/repo_sync.py` pull/push_bundle | ✅ verified (pull) / 🟡 (push, full loop in progress) |
| Compile (raw→bundle: ingest→compile→emit) | `tools/{ingest,compile_loop,emit}.py` | ✅ exists (L2) |
| Maintain-side full-loop orchestration (pull→compile→push) | `platform/compile_repo.py` | 🟡 verifying in background |
| Contradiction adjudication (the moat) | `tools/triage.py` / v1 adjudicates in chat | ✅ exists (L2) |
| Compile summary | ledger findings → release notes | ✅ verified |

**D. Publish gate**
| Capability | Implementation | Status |
|---|---|---|
| Publish a version (tag, a deliberate action) | `platform/publish.py` + create_release | ✅ verified (v1) |
| Release notes = compile summary | publish.summary_from_ledger | ✅ verified |
| Traceable (version history/rollback) | git tags / list_releases | ✅ verified (list versions) / 🟡 rollback UI (frontend) |

**E. Consume side (read-only Q&A)**
| Capability | Implementation | Status |
|---|---|---|
| Fetch published version (read-only) | `platform/consume.py` fetch_published(@tag) | ✅ verified |
| Sourced Q&A (consume contract) | consume.answer + `tools/llm.py` | ✅ verified (fc=300/fc-2-0=100, each sourced) |

**F. Runtime (axis B)**
| Capability | Implementation | Status |
|---|---|---|
| Run compile/Q&A agent remotely (headless, no key needed) | `tools/llm.py` (claude -p) | ✅ verified |

**G. Explicitly v2 / not done (written down, not forgotten)**
| Capability | Belongs to |
|---|---|
| webhook auto-trigger (drop diff → auto compile) | v2 (core `compile_repo` unchanged, wrap one layer around it) |
| Wrapper frontend UI (maintain web / consume web, §6 light reference, styling TBD) | L3 later stage |
| Incremental compile (recompile only the affected subgraph, `sources.hash` already designed) | v2 (v1 recompiles small KBs fully) |
| Multiple workers / container orchestration / billing quotas / multi-person collaborative review | v2 |

**v1 end-to-end acceptance line**: `drop/` files → compile → publish v1 → read-only consume with sourced answers — verified segment by segment; once the `compile_repo` full loop (background) runs through, this line closes with full automation (manual trigger).
