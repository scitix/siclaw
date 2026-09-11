# platform/pod — Pi compiler harness

The compile box runs every compiler and verifier session through Siclaw's shared
Pi execution core. Python owns the KB workflow, tools, durable workspace, quality
gates and recovery; a private Node worker owns the Pi SDK session. Claude Agent SDK is also available through the same host-owned tool and event
contract. The saved engine selects every compiler-owned session. The ordinary Siclaw agent uses the same Pi session
assembly while retaining its own prompts, tools and application services.

The Runtime starts a dedicated box per capability run and relays its HTTP/SSE
contract into `capability.*`. See [execution and rollout design](../../../docs/design/2026-09-10-pi-kbc-execution.md).

## Two forms (same brain)

- **`compile_box.py` (served, production form)** — an aiohttp service, driven by the runtime over the **box's own HTTP+SSE contract**:
  - `POST /sources`  `{run_id?, workdir?, bundle_base64, bundle_sha256?}` → upload the frozen raw bundle, safely unpack into `workdir/raw/` (`drop/` kept as a compatibility alias); calling it after the run has started returns 409
  - Source Snapshot v2/v3 (large/resumable raw input): `POST /sources/begin` with the immutable descriptor → upload only returned `missing_parts` through `POST /sources/part` → `POST /sources/commit`; `POST /sources/state` can recover progress after a container restart. v3 adds immutable external revision evidence but deliberately preserves the repository tree without product-specific parsing. Every compressed part and declared file is SHA-256 verified, and `raw/` changes only after a complete atomic commit. A part is bounded to 256 MiB compressed and unpacked by default so one accepted 200 MiB source file plus tar/gzip overhead remains deliverable; both limits are configurable through `KBC_MAX_SOURCE_PART_BYTES` and `KBC_MAX_SOURCE_PART_UNPACKED_BYTES`. Office sidecars are written incrementally and atomically with a 512 MiB total derived-text budget, a 512 MiB per-archive expansion budget, and a 10,000-entry archive budget (`KBC_MAX_OFFICE_DERIVED_BYTES`, `KBC_MAX_OFFICE_ARCHIVE_UNPACKED_BYTES`, `KBC_MAX_OFFICE_ARCHIVE_FILES`). A supported Office source that exceeds one of these budgets rejects the snapshot commit instead of becoming silently unreadable; corrupt individual Office files retain the existing recorded/fail-open behavior. The v1 `/sources` route remains supported for rolling upgrades and small bundles.
  - `POST /authoring` `{run_id?, workdir?, bundle_base64, bundle_sha256?}` → upload authoring/candidate/eval/release assets, safely unpack into `workdir/`; also allowed on a live run (workspace re-hydration goes through here)
  - `POST /session/{run_id}` `{workdir?, instruction?, allowed_tools?, llm?, settings?}` → start this run's persistent conversation session (waits for the first /message); idempotent, on a live run it is a no-op attach and does not hot-rotate the connected SDK client
  - `POST /message/{run_id}` `{message, message_id?}` → inject one genuine conversational turn; a repeated consumer-minted `message_id` is acknowledged without injecting a second turn; legacy control-prefix recognition remains only for rolling upgrades
  - `POST /command/{run_id}` `{command_id, command}` → validate and execute one typed authoring action; action routing is language-independent, idempotent per live run, and pinned to one operation/generation
  - `GET  /events/{run_id}` → SSE structured events: `session` / `log` / `summary` / `turn_done` / `syncArtifacts` / `plan_proposed` / `error` / `end`
  - `POST /test-session/{run_id}` → **start a test session**: pin the parent run's current draft (`candidate/`) into an immutable snapshot + start a read-only consumer session (reuses this pod, zero new infra); returns `test_session_id` + `snapshot_hash` + `pages`
  - `POST /test-message/{tid}` / `GET /test-events/{tid}` / `POST /test-session/{tid}/close` → the test session's inject / live-stream / teardown
  - `GET  /health` → `{status, runs, test_sessions, engine: "pi_agent"}`

  The moat relies on custom tools that let the agent **signal explicitly** (rather than guessing from output):
  `report_summary`→`summary`, `propose_plan`→`plan_proposed`,
  `resolve_ticket`→writes the `agent_report` in `authoring/CONTRADICTIONS.json` (contradiction-ticket fix-up registration),
  `report_domain`→writes `authoring/META.json` with one field sentence for multi-library routing (cap enforced in code; typed command `compile.refresh_domain` is the on-demand whole-catalog path), and
  `source_inventory` / `source_read` / `source_search`→engine-neutral, bounded, read-only inspection of the frozen Raw snapshot. Hidden unmanaged paths and symbolic links are unavailable; segmented globs, per-read output limits, and cumulative search budgets keep consultation predictable. Originals represented by planner slices remain discoverable but unreadable outside their assigned bounded view.
  **Contradictions never block**: the agent lands a best-guess page + marks it uncertain + files a ticket, and the owner adjudicates asynchronously afterward (contradiction-as-turn model).
  Compilation does not generate suggested test questions as a hidden completion side effect; question recommendation belongs to an explicit test workflow over a pinned draft.
  Behavior changes need a `siclaw-kbc-box` image rebuild and runtime env `SICLAW_COMPILE_BOX_IMAGE` (existing live sessions keep their old image).

## Protocol v3: linear-wizard enhancements (BOX_ROLE contract, never-block invariant unchanged)

The linear-wizard mode adds two pure-contract enhancements to the box (design: improve_siclaw/DESIGN-kb-linear-mode-2026-07-03 §3; neither introduces a wait-for-user pause):

- **Compile brief**: typed commands carry stable `knowledge_type=document|code`, audience/depth/redaction/content-locale parameters and deterministically write `authoring/BRIEF.json`; no localized text parsing is needed. `knowledge_type=code` selects architecture/component evidence coverage and incremental impact semantics rather than a page-per-file output. The old opening-message parser remains for pre-command clients. BOX_ROLE reads either schema, updates INTENT.md, and treats the brief as intent rather than source fact.
- **Unified question queue**: "tone-type follow-ups" that surface mid-compile (conventions / redaction / whether to compile process data / whether to keep old versions) are handled **the same** as source contradictions — best-guess into the page + mark `⚠️ 存疑` + append to the **same** `authoring/CONTRADICTIONS.json` (schema unchanged); no new file, no new protocol. On the owner's side it is the same "questions" queue.
- **`compile_agent.py` (one-shot, local debugging)** — a one-off `query()`: reads `workdir/drop/`+`constitution.md`→compiles→writes
  `workdir/bundle/`, no HTTP. Used to quickly verify "the brain can compile inside the container".

## Local and container execution

Build from the Siclaw repository root so the Node stage includes the shared core:

```bash
npm ci
npm run build
python3 -m venv /tmp/kbc-venv
/tmp/kbc-venv/bin/pip install -r kbc/platform/pod/requirements.txt
/tmp/kbc-venv/bin/python kbc/platform/pod/compile_agent.py --workdir /tmp/wd --config /private/path/execution.json

docker build -f kbc/platform/pod/Dockerfile -t siclaw-kbc-box:development .
docker run --rm -p 3000:3000 -v /tmp/wd:/work siclaw-kbc-box:development
```

`execution.json` contains the private execution object described below. It is an
explicit local input and must not be committed. The served form receives this
object in `/session/{run_id}` as `llm: {engine: "pi_agent", execution: ...}` along
with the resolved `settings`. Upload `/sources` and `/authoring` first, then create
the session and send `/message` or `/command`. Connecting alone never calls a model.

## Auth / mTLS

- **LLM**: the control plane resolves a complete version-1 execution object with five roles: `compile`, `blue`, `judge`, `transcribe`, `compare`. Each role supplies its model descriptor (`id`, `name`, `provider`, `api`, `baseUrl`, `input`, `reasoning`, `contextWindow`, `maxTokens`), API key, reasoning level and optional authentication/header policy. Ordinary Anthropic, OpenAI Chat Completions and Responses providers are supported. Role providers and credentials may differ. The SDK does not discover user settings, subscription sessions or environment credentials. The payload travels privately to the worker over stdin and is never placed in PodSpec or diagnostic records.
- **Configuration and recovery**: the control plane freezes the model descriptors, credential references and compiler settings per authoring attempt. Recovery rehydrates that snapshot and resolves only its credential references again, allowing credential rotation. Active sessions retain their original configuration. New/rebuilt sessions require Pi configuration; historical policy remains visible until its owner explicitly saves Pi models in knowledge settings.
- **Transport**: if `tls.crt/tls.key/ca.crt` exist under `SICLAW_CERT_PATH` (default `/etc/siclaw/certs`), the box serves HTTPS. `/health` remains certificate-optional for the in-container Kubernetes probe; every data/session/event route requires a verified client certificate whose OU is `Runtime` or `Gateway`. Partial TLS material fails startup. Without TLS material the server uses HTTP for explicit local development only.

## Layer-1 self-check: coverage ledger + lint (`selfcheck.py`)

The completion criterion moves from "the model certifies itself" to "code verifies it" (design: improve_siclaw/DESIGN-kb-compile-self-verification-2026-07-03.md §8.1):

- **Contract**: every candidate page uses OKF v0.2 structured provenance, `sources: [{resource: <raw-relative path>}]`, for the inputs it was compiled from (a pure synthesis page is marked `derived: true`); a source you decide not to compile goes into `authoring/EXCLUSIONS.json` (`[{pattern, reason}]`). Siclaw-authored pages also stamp `generated.by: process:siclaw-kbc` and `status: stable`; the compile agent never writes `verified`.
- **Standalone package citations**: a direct-import producer may add root `.okf-citations.json` (`schema_version: 1`) mapping those exact resources to clean Feishu `/wiki/{token}` or `/file/{token}` URLs. The import service treats it as untrusted input and freezes validated mappings on the package version. Runtime materialization drops the uploaded copy; the model receives only the server-owned citation manifest.
- **Check**: at each turn end, when the candidate state changed (idempotency key = candidate tree + EXCLUSIONS content) and `candidate/index.md` exists, mechanically verify "all raw text sources = union of `sources[].resource` + EXCLUSIONS matches" and run OKF v0.2 metadata/lint checks (missing provenance / broken links) plus high-confidence credential exposure. Credential findings carry only the credential kind and line number, never the matched value; normal internal names, addresses, URLs, and prose are not external-content-redacted. The result is written to `authoring/SELFCHECK.json` (synced to the consumer with the workspace, consumed by the publish card), with a one-line narration on the `summary` event.
- **Repair**: `turn_done` still fires as usual (the never-stuck invariant holds); when something is unaccounted, a bounded repair instruction is injected (`KBC_L1_REPAIR_ROUNDS`, default 1). The budget is **per gap-episode** — it resets each time coverage closes, so a long restructuring compile that reopens and re-closes gaps can trigger repeated rounds (each episode still terminates; the count is not bounded over the whole run). Once the budget for the current episode is spent the report is marked `unconverged` and the rest is left to the owner. Fail-open throughout.
- **Engine-neutral**: selfcheck.py is pure stdlib with zero SDK dependency; the driver only provides "when to trigger" plus one injection seam, `CompileRun.inject_user_message()` — the Pi transport supplies this seam without changing the quality-gate rules.

## Layer-2 self-check: red-blue PK (`redblue.py` + `engine.py`)

An asymmetric "one writer, many examiners" design: the **judge** (strong tier, reads raw + snapshot, the frozen `judge` role) surveys the question surface → writes questions (with variants, prioritizing conflict / WIP / boundary + flagged tickets) → grades with four-category attribution (coverage / routing / contract / medium; "correctly said not-covered" = pass); the **blue team** (gate tier = production consumer tier, the frozen `blue` role, persona = TEST_ROLE, single-sourced) reads only the pinned wiki snapshot, with raw mechanically blocked by multi-root path guards.

- **Orchestration is all in code** (redblue.py): question budget = clamp(8, pages×1.5, 40); the question surface is cached by raw fingerprint (`authoring/PK_SURVEY_CACHE.json`); chunked answering/grading (`KBC_PK_CHUNK=5`, concurrency `KBC_PK_CONCURRENCY=2`); a targeted-retest primitive (`questions_override`); a global wall clock `KBC_PK_WALL_SECS=1800`; any stage's bad JSON is retried once, then fails open (state=failed, never raises).
- **Engine-neutral** (engine.py): the `ReadonlyAgentEngine` Protocol is the only engine surface; structured output = text JSON + lenient parse (deliberately not SDK tool-forcing); both SDK implementations receive explicit role configuration and root-confined tools.
- **S0 calibration runner = this module**: `python redblue.py --config /private/path/execution.json --raw <dir> (--workdir <dir>|--wiki <dir>) [--questions N] [--retest last-result.json] [--out pk-result.json]` — offline calibration runs the exact production pipeline. Results are written to the `pk` section of SELFCHECK.json (single write point `selfcheck.update_pk_section`; an L1 re-check never wipes it).
- **Wiring pending S0 sign-off**: compile_box's automatic trigger (background run after L1 passes + repair injection + staleness detection) is wired in per design doc §9.4 once calibration passes.

## Execution boundaries

- Pi supplies no built-in tools. Compiler sessions register KBC-owned Read/Write/Edit/Glob/Grep and structured KB tools. Read-only helpers receive only their profile's tools and roots. Bash, subagents, external browsing and arbitrary process execution are absent.
- PDF Read renders at most 20 explicitly selected pages and applies the existing Raw slice guard. Text, image, search output, subprocess time and transport buffers are bounded. Office parsing and source provenance remain in the existing host pipeline.
- Retry, model-call budget, watchdog, cancellation and checkpoint ACK belong to the KBC harness. Worker EOF, abort, transport failure and provider failure never imply successful compilation. A replacement resumes from the durable workspace/checkpoint; it does not restore an in-memory reasoning transcript.
- The resolved model window bounds source batching, text slicing, PDF slicing and reduction. Planning reserves fixed instructions, output capacity and room for subsequent tool results. A model too small for the compiler is rejected during configuration.
- Execution observations include model-envelope identity, role/session/turn, latency, usage, tool activity and classified outcomes. They omit prompts, tool arguments/results, response bodies and credentials. Bounded asynchronous forwarding prevents diagnostics from delaying artifact ACK or turn completion; queue loss is reported explicitly.
- Historical `kb-compile-codex` profile IDs remain readable. New boxes for those IDs use the same Pi permissions. A live old-image session stays attached; an empty old-image box is replaced only after its Pi configuration and source revision resolve.
- Test-session cap `KBC_MAX_TEST_SESSIONS` defaults to 3. Snapshots live under `KBC_TEST_SNAPSHOT_ROOT` (default `/tmp/kbc-tests`) and are removed on close.
- `KBC_SMOKE=1` uses a fake driver for HTTP/SSE and artifact wiring without calling a model.
