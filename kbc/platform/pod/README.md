# platform/pod — compile box (Claude Agent SDK + kbc brain)

The siclaw platform's **compile box**: runs the kbc compile brain as a **Claude Agent SDK** persistent session = a "headless
Claude Code with a wrapped entry point". The engine / tools / compact are not rewritten by a single line; it only adds structured-signal tools for the kbc moat.
Platform-agnostic (kbc base); the siclaw runtime reuses agentbox's K8sSpawner to start it per BoxProfile
(`kb-compile` / `kb-test`), and events are translated by the runtime into the generic `capability.*` and forwarded to consumers (a downstream platform, etc.).

## Two forms (same brain)

- **`compile_box.py` (served, production form)** — an aiohttp service, driven by the runtime over the **box's own HTTP+SSE contract**:
  - `POST /sources`  `{run_id?, workdir?, bundle_base64, bundle_sha256?}` → upload the frozen raw bundle, safely unpack into `workdir/raw/` (`drop/` kept as a compatibility alias); calling it after the run has started returns 409
  - `POST /authoring` `{run_id?, workdir?, bundle_base64, bundle_sha256?}` → upload authoring/candidate/eval/release assets, safely unpack into `workdir/`; also allowed on a live run (workspace re-hydration goes through here)
  - `POST /session/{run_id}` `{workdir?, instruction?, allowed_tools?}` → start this run's persistent conversation session (waits for the first /message); idempotent, on a live run it is a no-op attach
  - `POST /message/{run_id}` `{message}` → inject one round of user message into the persistent session; prepare, compile, and adjudication-driven fix-up are all **ordinary turns**
  - `GET  /events/{run_id}` → SSE structured events: `session` / `log` / `summary` / `turn_done` / `syncArtifacts` / `plan_proposed` / `error` / `end`
  - `POST /test-session/{run_id}` → **start a test session**: pin the parent run's current draft (`candidate/`) into an immutable snapshot + start a read-only consumer session (reuses this pod, zero new infra); returns `test_session_id` + `snapshot_hash` + `pages`
  - `POST /test-message/{tid}` / `GET /test-events/{tid}` / `POST /test-session/{tid}/close` → the test session's inject / live-stream / teardown
  - `GET  /health` → `{status, runs, test_sessions}`

  The moat relies on custom tools that let the agent **signal explicitly** (rather than guessing from output):
  `report_summary`→`summary`, `propose_plan`→`plan_proposed`,
  `resolve_ticket`→writes the `agent_report` in `authoring/CONTRADICTIONS.json` (contradiction-ticket fix-up registration).
  **Contradictions never block**: the agent lands a best-guess page + marks it uncertain + files a ticket, and the owner adjudicates asynchronously afterward (contradiction-as-turn model).

- **`compile_agent.py` (one-shot, local debugging)** — a one-off `query()`: reads `workdir/drop/`+`constitution.md`→compiles→writes
  `workdir/bundle/`, no HTTP. Used to quickly verify "the brain can compile inside the container".

## Run (local, subscription auth)

```bash
# kbc repo root — one-shot form
mkdir -p /tmp/wd/drop && cp drop/example-kb/*.md /tmp/wd/drop/ && cp constitution.md /tmp/wd/
platform/pod/.venv/bin/python platform/pod/compile_agent.py --workdir /tmp/wd

# served form + protocol smoke test (fake driver, does not burn LLM)
platform/pod/.venv/bin/python platform/pod/test_compile_box.py
```

## Run (container, production form)

```bash
docker build -f platform/pod/Dockerfile -t kbc-compile-box .
docker run --rm -p 3000:3000 \
  -e ANTHROPIC_BASE_URL=https://<massapi>/ \   # model goes through the company massapi (key injected on the proxy side)
  -v /tmp/wd:/work \
  kbc-compile-box
# then:
#   POST :3000/sources {"run_id":"r1","bundle_base64":"...","bundle_sha256":"..."}
#   POST :3000/authoring {"run_id":"r1","bundle_base64":"...","bundle_sha256":"..."}
#   POST :3000/session/r1 {"instruction":"..."}
#   POST :3000/message/r1 {"message":"compile raw/ into candidate pages"} → GET :3000/events/r1 (SSE)
```

## Auth / mTLS

- **LLM**: locally reuses the `~/.claude` subscription (no key needed); container/production must use `ANTHROPIC_API_KEY` or `ANTHROPIC_BASE_URL`→massapi (credentials do not enter the sandbox).
- **Transport**: if `tls.crt/tls.key/ca.crt` exist under `SICLAW_CERT_PATH` (default `/etc/siclaw/certs`) → serve HTTPS and require a client certificate (runtime/gateway); otherwise HTTP (local). Reuses agentbox's per-box mTLS shell.

## Layer-1 self-check: coverage ledger + lint (`selfcheck.py`)

The completion criterion moves from "the model certifies itself" to "code verifies it" (design: improve_siclaw/DESIGN-kb-compile-self-verification-2026-07-03.md §8.1):

- **Contract**: every candidate page's frontmatter `compiled_from` lists the real raw-relative paths it was compiled from (a pure synthesis page is marked `derived: true`); a source you decide not to compile goes into `authoring/EXCLUSIONS.json` (`[{pattern, reason}]`).
- **Check**: at each turn end, when the candidate state changed (idempotency key = candidate tree + EXCLUSIONS content) and `candidate/index.md` exists, mechanically verify "all raw text sources = union of compiled_from + EXCLUSIONS matches" and run a structural lint (missing provenance / broken links); the result is written to `authoring/SELFCHECK.json` (synced to the consumer with the workspace, consumed by the publish card), with a one-line narration on the `summary` event.
- **Repair**: `turn_done` still fires as usual (the never-stuck invariant holds); when something is unaccounted, a bounded repair instruction is injected (`KBC_L1_REPAIR_ROUNDS`, default 1). The budget is **per gap-episode** — it resets each time coverage closes, so a long restructuring compile that reopens and re-closes gaps can trigger repeated rounds (each episode still terminates; the count is not bounded over the whole run). Once the budget for the current episode is spent the report is marked `unconverged` and the rest is left to the owner. Fail-open throughout.
- **Engine-neutral**: selfcheck.py is pure stdlib with zero SDK dependency; the driver only provides "when to trigger" plus one injection seam, `CompileRun.inject_user_message()` — swapping engines (e.g. Codex) only reimplements this one method.

## Layer-2 self-check: red-blue PK (`redblue.py` + `engine.py`)

An asymmetric "one writer, many examiners" design: the **judge** (strong tier, reads raw + snapshot, `KBC_PK_JUDGE_MODEL` default claude-opus-4-6) surveys the question surface → writes questions (with variants, prioritizing conflict / WIP / boundary + flagged tickets) → grades with four-category attribution (coverage / routing / contract / medium; "correctly said not-covered" = pass); the **blue team** (gate tier = production consumer tier, `KBC_PK_BLUE_MODEL` default claude-sonnet-4-6, persona = TEST_ROLE, single-sourced) reads only the pinned wiki snapshot, with raw mechanically blocked by multi-root path guards.

- **Orchestration is all in code** (redblue.py): question budget = clamp(8, pages×1.5, 40); the question surface is cached by raw fingerprint (`authoring/PK_SURVEY_CACHE.json`); chunked answering/grading (`KBC_PK_CHUNK=5`, concurrency `KBC_PK_CONCURRENCY=2`); a targeted-retest primitive (`questions_override`); a global wall clock `KBC_PK_WALL_SECS=1800`; any stage's bad JSON is retried once, then fails open (state=failed, never raises).
- **Engine-neutral** (engine.py): the `ReadonlyAgentEngine` Protocol is the only engine surface; structured output = text JSON + lenient parse (deliberately not SDK tool-forcing); swapping to a Codex base = adding one adapter, with model/effort as plain string knobs.
- **S0 calibration runner = this module**: `python redblue.py --raw <dir> (--workdir <dir>|--wiki <dir>) [--questions N] [--retest last-result.json] [--out pk-result.json]` — offline calibration runs the exact production pipeline. Results are written to the `pk` section of SELFCHECK.json (single write point `selfcheck.update_pk_section`; an L1 re-check never wipes it).
- **Wiring pending S0 sign-off**: compile_box's automatic trigger (background run after L1 passes + repair injection + staleness detection) is wired in per design doc §9.4 once calibration passes.

## Boundaries / next steps

- **resume**: the session does not survive a box restart (`InMemorySessionStore`); the runtime side falls back on "re-hydrate a cold box" (re-materialize raw + durable workspace), with SDK `resume` + a file-backed `session_store` as a later increment.
- **test session isolation**: read-only relies on the allowed_tools allowlist (default `Read/Glob/Grep`), but under bypassPermissions an absolute-path Read can still escape the snapshot directory (review C4) — a path fence is a to-do for the test-session slice.
- Test-session cap `KBC_MAX_TEST_SESSIONS` (default 3), snapshots land in `KBC_TEST_SNAPSHOT_ROOT` (default `/tmp/kbc-tests`), destroyed on close.
- `KBC_SMOKE=1` → fake driver (does not call the LLM), verifies the box↔runtime↔consumer wiring (events + artifact sync) for free in the cluster.
