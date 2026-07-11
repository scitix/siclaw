#!/usr/bin/env python3
"""compile_box — the served form of the compile box: a "cloud Claude Code"
spawned by the siclaw runtime and driven over the box's own HTTP+SSE contract
(the runtime translates events into generic capability.* for consumers, e.g. a downstream platform).

Shape: the box is 90% "headless Claude Code behind a wrapped entrypoint" (Agent
SDK = Claude Code as a library; engine/tools/compaction reused verbatim); the
remaining 10% is the kbc moat — custom tools that make the agent emit explicit
structured signals:
  - report_summary  → SSE `summary` (compile progress, for the verify UI)
  - propose_plan    → SSE `plan_proposed` (Plan→Execute alignment)
  - resolve_ticket  → writes agent_report into authoring/CONTRADICTIONS.json
                      (contradiction-ticket patch registration; never blocks)

Surface (driven by the runtime):
  POST /sources            {run_id?, workdir?, bundle_base64, bundle_sha256?, locale?} install the frozen raw bundle → workdir/raw
  POST /authoring          {run_id?, workdir?, bundle_base64, bundle_sha256?, locale?} install authoring/candidate/eval/release assets → workdir/
  POST /session/{run_id}   {workdir?, instruction?, allowed_tools?, locale?, llm?, settings?} start the run's persistent conversational session (waits for the first /message); idempotent
  POST /message/{run_id}   {message} inject one user turn into the persistent session (prepare/compile/patch are all ordinary turns)
  POST /command/{run_id}   {command_id, command} execute one typed authoring action; idempotent per live run
  GET  /events/{run_id}    structured SSE stream (session/log/summary/turn_done/syncArtifacts/plan_proposed/error/end)
  POST /test-session/{run_id}  start a test session: pin the current draft as an immutable snapshot + a read-only consumer session (reuses this pod)
  POST /test-message/{tid} · GET /test-events/{tid} · POST /test-session/{tid}/close
  GET  /health

LLM auth: local runs reuse the subscription (the SDK ships the claude binary);
production config arrives as one authoritative /session llm block (consumer, or
Runtime Helm fallback when absent), keeping credentials out of the KB PodSpec.
mTLS: with SICLAW_CERT_PATH certs present the box serves HTTPS and requires a
client cert (runtime/gateway); otherwise plain HTTP (local).
"""
import asyncio
import base64
import hashlib
import io
import json
import os
import re
import shutil
import tarfile
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from aiohttp import web
from claude_agent_sdk import (
    ClaudeSDKClient,
    ClaudeAgentOptions,
    HookMatcher,
    tool,
    create_sdk_mcp_server,
    InMemorySessionStore,
)

import batching
import incremental
import mediaverify
import office_ingest
from mtls_auth import (
    client_certificate_error as _client_certificate_error,
    server_ssl_context,
)
import redblue
import selfcheck
from engine import ClaudeEngine

# massapi/Bedrock rejects the `context_management` field Claude Code attaches
# (HTTP 400 "context_management: Extra inputs are not permitted").
# ROOT CAUSE (settled 2026-07-06 by reading bundled CLI 2.1.191): the field is
# NOT autocompact — it is the thinking-clear context edit, attached whenever a
# turn has thinking enabled AND the context-management beta is in the betas
# list. massapi masquerades as a first-party endpoint, so the CLI auto-enables
# that beta for modern models; adaptive thinking then decides per-turn → the
# 400 is intermittent (respawn-rehydrate first turns, image-heavy turns).
# The gate: `if (o1(provider) && !E2e() && enabled) push(contextManagementBeta)`
# where E2e() = CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS || hipaa. So THIS is the
# kill switch. Correct posture on a Bedrock-proxied gateway anyway: any
# experimental beta that changes the request shape is a 400 hazard here.
os.environ.setdefault("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "1")
# Autocompact stays off too (kept from the earlier mitigation): a compile is a
# long multi-turn session and massapi has no compaction affordances. BOTH
# spellings: CLI 0.2.110 read DISABLE_AUTO_COMPACT (underscored).
# setdefault → an explicit deployment override still wins.
os.environ.setdefault("DISABLE_AUTOCOMPACT", "1")
os.environ.setdefault("DISABLE_AUTO_COMPACT", "1")

# A box usually hosts a single run; a map keeps it clean (and helps health/debugging).
RUNS: dict[str, "CompileRun"] = {}
# Read-only "test session" runs — ephemeral consumer sessions over a pinned draft
# snapshot (test sessions). Parallel to RUNS, torn down on close/idle. See TestRun.
TEST_SESSIONS: dict[str, "TestRun"] = {}
DEFAULT_HTTP_MAX_REQUEST_BYTES = 768 * 1024 * 1024

# ── Prompt packs — locale-parameterized model-facing text ────────────────────
# ALL text that reaches the model (standing roles, playbook, guard steering)
# lives in prompts/<locale>/*.md. The locale is DECLARED BY THE CONSUMER per
# run (capability.fetchInput → runtime → /session body); the platform default
# is English and the box never guesses a language from content. zh is the
# byte-faithful move of the original prompts, so zh runs behave identically.
_PROMPTS_DIR = Path(__file__).resolve().parent / "prompts"
DEFAULT_LOCALE = "en"


def _prompt(name: str, locale: str | None) -> str:
    """Load a prompt-pack asset, falling back to the English default pack."""
    tried = []
    for cand in ((locale or "").strip().lower(), DEFAULT_LOCALE):
        if not cand or cand in tried:
            continue
        tried.append(cand)
        fp = _PROMPTS_DIR / cand / f"{name}.md"
        if fp.exists():
            return fp.read_text(encoding="utf-8")
    raise FileNotFoundError(f"prompt pack missing: {name} (locale={locale!r})")

def _tool_strings(locale: str | None) -> dict:
    """Model-facing tool descriptions/result texts from the locale pack (JSON)."""
    tried = []
    for cand in ((locale or "").strip().lower(), DEFAULT_LOCALE):
        if not cand or cand in tried:
            continue
        tried.append(cand)
        fp = _PROMPTS_DIR / cand / "tools.json"
        if fp.exists():
            return json.loads(fp.read_text(encoding="utf-8"))
    raise FileNotFoundError(f"prompt pack missing: tools.json (locale={locale!r})")


def _command_strings(locale: str | None) -> dict:
    """Model-facing typed-command render strings from the locale pack.

    Action selection has already happened before this is called. A translation
    can change only the directive prose, never the execution branch.
    """
    tried = []
    for cand in ((locale or "").strip().lower(), DEFAULT_LOCALE):
        if not cand or cand in tried:
            continue
        tried.append(cand)
        fp = _PROMPTS_DIR / cand / "commands.json"
        if fp.exists():
            return json.loads(fp.read_text(encoding="utf-8"))
    raise FileNotFoundError(f"prompt pack missing: commands.json (locale={locale!r})")


def _playbook_text(locale: str | None) -> str:
    """Compile playbook: KBC_PLAYBOOK env overrides (local dev), else the pack."""
    env = os.environ.get("KBC_PLAYBOOK")
    if env and Path(env).exists():
        return Path(env).read_text(encoding="utf-8")
    return _prompt("playbook", locale)


def _loc(run, en: str, zh: str) -> str:
    """User/model-facing text in the run's locale (platform default en, zh only
    when the consumer declares it — same gate as selfcheck narration). Wire
    tokens and stored data stay locale-independent; never route them through
    this."""
    return en if selfcheck._is_en(getattr(run, "locale", None)) else zh


# The one-line labels that frame owner instructions inside the system prompt.
_INSTRUCTION_HEADER = {
    "zh": "# 本次 authoring attempt 的负责人说明",
    "en": "# Owner's brief for this authoring attempt",
}

# The read-only test-session persona lives in prompts/<locale>/test_role.md —
# deliberately a knowledge CONSUMER over the pinned wiki snapshot, so the test
# measures the wiki, not the agent's tools (mirrors siclaw prompt.ts). The
# red-blue blue team reads the SAME pack text via selfcheck.TEST_ROLE, so the
# consumer persona is single-sourced in the locale packs (no drift).


def _max_test_sessions() -> int:
    return int(os.environ.get("KBC_MAX_TEST_SESSIONS", "3"))


def _test_snapshot_root() -> str:
    return os.environ.get("KBC_TEST_SNAPSHOT_ROOT", "/tmp/kbc-tests")


# The compile driver is injectable: production = run_session (real Agent SDK);
# tests inject a fake driver to exercise the protocol pipeline without an LLM.
_COMPILE_IMPL = None  # set at bottom to run_session
# Same injection seam for the read-only test-session driver (set at bottom).
_TEST_SESSION_IMPL = None


# ── Model-stall watchdog (L1) ────────────────────────────────────────────────
# A compile turn can wedge on a black-holed model request (massapi/upstream
# accepts the connection but never responds). The bundled `claude` CLI's own
# request timeout is ~60min and not tunable from here, so a routine upstream
# hiccup froze a run for an hour. We own the recovery: a turn-scoped watchdog
# reaps a wedged model request in seconds and re-issues the turn.
#
# Idle is measured as MODEL-response latency — a pending tool (Read/Bash run in
# the CLI, not the model) relaxes the bound so a long tool never looks like a
# stall (invariant I4: never false-kill a live turn).
_MODEL_IDLE_TIMEOUT_S = float(os.environ.get("KBC_MODEL_IDLE_TIMEOUT_S", "90"))
_MODEL_TOOL_IDLE_TIMEOUT_S = float(os.environ.get("KBC_MODEL_TOOL_IDLE_TIMEOUT_S", "660"))
_MODEL_MAX_RETRIES = int(os.environ.get("KBC_MODEL_MAX_RETRIES", "3"))
_MODEL_WATCHDOG_POLL_S = float(os.environ.get("KBC_MODEL_WATCHDOG_POLL_S", "10"))

# ── Rate-limit resilience (C2) ───────────────────────────────────────────────
# massapi under concurrency (5-10 boxes × the red-blue PK) can return 429/503/529.
# The bundled CLI retries internally a few times; past that the turn ends with
# is_error=True and api_error_status set (CLI >= 2.1.110). We back off and re-issue
# rather than failing the run — massapi's limits are not ours to fix (out of
# scope), so this is graceful handling, not a fix. Exhaustion ends the turn with a
# clear owner-facing note instead of a crash.
_MODEL_RATE_STATUSES = frozenset({429, 503, 529})
_MODEL_RATE_MAX_RETRIES = int(os.environ.get("KBC_MODEL_RATE_MAX_RETRIES", "5"))
_MODEL_RATE_BACKOFF_BASE_S = float(os.environ.get("KBC_MODEL_RATE_BACKOFF_BASE_S", "2"))
_MODEL_RATE_BACKOFF_CAP_S = float(os.environ.get("KBC_MODEL_RATE_BACKOFF_CAP_S", "30"))

# ── Graceful-shutdown flush (F3) ─────────────────────────────────────────────
# SIGTERM stops the box (pod delete / eviction / OOM after the runtime reap).
# /work is an emptyDir destroyed with the pod, and work reaches the store only via
# the periodic sync — so without a shutdown flush the last ≤SYNC_INTERVAL_SECS is
# lost. on_shutdown final-syncs each active run and gives the relay a bounded
# window to drain. Best-effort within the grace period (F1 is the durable fix).
_SHUTDOWN_DRAIN_S = float(os.environ.get("KBC_SHUTDOWN_DRAIN_S", "0.5"))
_SHUTDOWN_DRAIN_MAX_S = float(os.environ.get("KBC_SHUTDOWN_DRAIN_MAX_S", "8"))


def _rate_backoff_delay(attempt: int) -> float:
    """Exponential backoff (attempt is 1-based), capped."""
    return min(_MODEL_RATE_BACKOFF_BASE_S * (2 ** (attempt - 1)), _MODEL_RATE_BACKOFF_CAP_S)


class ModelStallError(Exception):
    """A turn's model request stalled past the idle bound and exhausted retries.
    Raised out of the consume loop so _run_wrapper fails the run with a clear
    reason instead of the box sitting silently."""


class CompileRun:
    def __init__(self, run_id: str, workdir: str, round_: int, instruction: str = ""):
        self.run_id = run_id
        self.workdir = workdir
        self.round = round_
        self.instruction = instruction
        self.events: asyncio.Queue = asyncio.Queue()
        self.task: asyncio.Task | None = None
        self.done = False
        # Persistent Claude Code session (set by run_session). The box is a
        # long-lived conversational + compiling session, not a one-shot query();
        # POST /message injects follow-up user turns into this same session.
        self.client: ClaudeSDKClient | None = None
        self.session_id: str | None = None
        # Tool whitelist declared by the runtime BoxProfile (via POST /session).
        # None → use the driver default (DEFAULT_COMPILE_ALLOWED_TOOLS). A restrictive
        # profile (e.g. kb-test) makes "which tools" enforced by construction here,
        # not by prompt.
        self.allowed_tools: list[str] | None = None
        # Consumer-declared prompt/output locale (capability.fetchInput → /session).
        self.locale: str | None = None
        # Set once connect() has returned (success OR failure). A /message that
        # races ahead of the async connect waits on this so client.query() never
        # hits the SDK's "Not connected. Call connect() first." error.
        self.connected: asyncio.Event = asyncio.Event()
        # Assistant text accumulated for the in-flight turn; flushed into the
        # turn_done event so the consumer can persist the whole assistant reply.
        self._turn_text: list[str] = []
        # Layer-1 self-check bookkeeping (selfcheck.py): idempotency key of the
        # last checked state (skip re-check when nothing changed) and repair
        # injections used since the ledger last closed (bounds the auto-repair
        # loop; reset to 0 whenever the check passes).
        self._selfcheck_key: str | None = None
        self._l1_repairs_used = 0
        # Batch mode (DESIGN-kb-batch-compile-2026-07-05): when the orchestrator
        # drives per-batch sessions, ResultMessage must NOT emit turn_done (the
        # whole batch run is ONE turn to the consumer); the flushed reply is parked
        # here for the orchestrator instead. _batch_notes queues owner chat that
        # arrives mid-batch (relayed into the next batch directive).
        self._suppress_turn_done = False
        self._last_turn_reply: str = ""
        # Media blind-verify bookkeeping: pages handed to the in-flight verify
        # task (subtracted from the due-check) — verified marks land only AFTER
        # a completed verification (failed pages retry, bounded by attempts).
        self._media_inflight: set[str] = set()
        # When the stall watchdog fired interrupt(): bounds the wait for the
        # interrupted result (a true black-hole can swallow interrupt() too).
        self._stall_interrupted_at = 0.0
        self._batch_active = False
        self._batch_notes: list[str] = []
        # Full compile provenance is an explicit commit, never inferred from a
        # replayed or rehydrated candidate/index.md.
        self._full_compile_pending = False
        # Keep the last full-compile commit replayable across relay restarts.
        # The consumer dedupes it by immutable input revision.
        self._commit_input_replay = False
        # Consumer-minted turn ids accepted by this live box. The runtime also
        # checkpoints them; this local set closes the crash window where the box
        # accepted a turn but the runtime died before persisting its ack.
        self._message_ids: set[str] = set()
        # Scoped incremental (真增量): armed at kickoff with {before: page_hashes,
        # changeset}; the post-turn seam runs the byte-integrity guard against it,
        # then clears it. None = this turn is not a scoped incremental.
        self._incr_pending: dict | None = None
        # Layer-2 red-blue PK (S2): the in-flight background task, if any.
        # Single-flight per run; durable state lives in SELFCHECK.json `pk`.
        self._pk_task: asyncio.Task | None = None
        # Blind image verify (图像复核 v2): the in-flight background task.
        self._media_task: asyncio.Task | None = None
        # Model-stall watchdog (L1) — turn-scoped state, updated by the receive
        # loop (_consume_turn_stream) and the watchdog task. A turn is "active"
        # from query() until its real ResultMessage; the watchdog only judges an
        # active turn, and only against model latency (see _MODEL_* above).
        self._turn_active = False
        self._tool_pending = False          # last assistant msg asked for a tool
        self._last_model_activity = 0.0     # monotonic ts of the last inbound SDK msg / query
        self._last_directive = ""           # the in-flight turn's text, for retry
        self._last_sdk_message_type = "query"  # controlled class name only; never message content
        self._last_stall_diagnostic: dict | None = None
        self._model_retries = 0             # stall retries used on the in-flight turn
        self._stall_retrying = False        # watchdog interrupted; awaiting the interrupted result
        self._stall_fatal = False           # stall retries exhausted → fail this turn
        self._rate_retries = 0              # rate-limit (429/503/529) retries on the in-flight turn
        # Typed machine-control receipts. A command id is accepted at most once
        # for this live run, and the first command pins the run to the consumer's
        # operation/generation context. This is intentionally NOT another status
        # machine; Sicore's operation and the runtime run remain authoritative.
        self._accepted_commands: dict[str, str] = {}
        self._command_context: tuple[str, int] | None = None

    async def emit(self, ev: dict):
        await self.events.put(ev)

    def _begin_turn(self, directive: str):
        """Arm the stall watchdog for a new model turn. Called for every turn —
        the owner's /message AND internal self-check/verify/batch injections."""
        self._last_directive = directive
        self._turn_active = True
        self._tool_pending = False
        self._model_retries = 0
        self._stall_retrying = False
        self._stall_fatal = False
        self._rate_retries = 0
        self._last_model_activity = time.monotonic()
        self._last_sdk_message_type = "query"
        self._last_stall_diagnostic = None

    async def inject_user_message(self, text: str):
        """Engine seam: push a user turn into the live session. The Claude SDK
        driver is one line; a future engine driver (e.g. Codex) reimplements
        just this method — self-check orchestration stays engine-neutral."""
        if self.client:
            self._begin_turn(text)
            await self.client.query(text)


class TestRun:
    """An ephemeral, read-only CONSUMER session over a pinned draft snapshot
    (start-a-test-session). Parallel to CompileRun but stripped: no workspace writes, no
    compile MCP tools, no park/ruling, no durable persistence. It connects to a
    snapshot dir (`.siclaw/knowledge/`) with read-only tools and answers turns,
    exactly like a real consumer would — then is torn down. Reuses _emit_message
    (`emit`/`_turn_text`) and _await_session_live (`connected`/`client`)."""

    def __init__(self, tid: str, cwd: str, parent_run_id: str, snapshot_hash: str, locale: str | None = None):
        self.tid = tid
        # Inherited from the parent authoring run (consumer-declared).
        self.locale = locale
        self.cwd = cwd                     # the pinned snapshot dir (holds .siclaw/knowledge/)
        self.parent_run_id = parent_run_id
        self.snapshot_hash = snapshot_hash
        self.events: asyncio.Queue = asyncio.Queue()
        self.task: asyncio.Task | None = None
        self.done = False
        self.client: ClaudeSDKClient | None = None
        self.session_id: str | None = None
        self.connected: asyncio.Event = asyncio.Event()
        self._turn_text: list[str] = []
        # Tool whitelist from the runtime BoxProfile (kb-test). None → the read-only
        # default (DEFAULT_TEST_ALLOWED_TOOLS). Zero-infra is enforced by construction.
        self.allowed_tools: list[str] | None = None

    async def emit(self, ev: dict):
        await self.events.put(ev)


# Snapshot pinning is single-sourced in selfcheck.py (shared with redblue.py).
_pack_candidates_to_wiki = selfcheck.pack_candidates_to_wiki


# ── B5: mid-compile workspace sync back to the consumer ──
# The agent writes candidate/PLAN/eval into /work (an emptyDir). Without syncing
# them back, a box crash loses all in-progress work and a resume restarts from
# the frozen authoring snapshot. A periodic sync streams changed workspace files
# to the consumer (compile.syncArtifacts) so the work is durable and a resumed box can
# bootstrap from the latest state instead of restarting.
WORKSPACE_SYNC_DIRS = ("authoring", "candidate", "eval", "release")
SYNC_INTERVAL_SECS = int(os.environ.get("KBC_SYNC_INTERVAL_SECS", "20"))
MAX_SYNC_FILE_BYTES = int(os.environ.get("KBC_MAX_SYNC_FILE_BYTES", str(1024 * 1024)))
# SDK stdio JSON reader buffer. The SDK default is 1MB, and one oversized tool
# result (a Read of a big source file) kills the whole session with a fatal
# "exceeded maximum buffer size" — seen live on a 139-source compile (2026-07-06).
SDK_MAX_BUFFER_BYTES = int(os.environ.get("KBC_SDK_MAX_BUFFER_BYTES", str(16 * 1024 * 1024)))
_SYNC_TOMBSTONE = "__deleted__"


def _collect_workspace_artifacts(workdir: str) -> list[dict]:
    """Collect text files under the writable workspace dirs as {path, content}.
    Paths are relative to workdir (e.g. "candidate/01.md"). raw/ is never
    included; binary, unreadable, or oversized files are skipped."""
    wd = Path(workdir)
    out: list[dict] = []
    for top in WORKSPACE_SYNC_DIRS:
        base = wd / top
        if not base.is_dir():
            continue
        for f in sorted(base.rglob("*")):
            if not f.is_file():
                continue
            try:
                if f.stat().st_size > MAX_SYNC_FILE_BYTES:
                    continue
                content = f.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            out.append({"path": f.relative_to(wd).as_posix(), "content": content})
    return out


def _workspace_sync_cursor(workdir: str) -> dict[str, str]:
    """Hash the workspace state already installed by the consumer."""
    return {
        art["path"]: hashlib.sha256(art["content"].encode("utf-8")).hexdigest()
        for art in _collect_workspace_artifacts(workdir)
    }


async def _sync_workspace(run: CompileRun, sent: dict, *, commit_input: bool = False) -> int:
    """Emit a syncArtifacts event for workspace files changed since `sent`
    (path → content sha), plus TOMBSTONES ({path, deleted: true}) for
    previously-synced files that no longer exist on disk. Updates `sent` after
    enqueue and retains tombstone markers for reconnect replay;
    returns the number of changed entries."""
    if commit_input and not (Path(run.workdir) / "candidate" / "index.md").is_file():
        raise FileNotFoundError("cannot commit compile input without candidate/index.md")
    changed = []
    next_sent = dict(sent)
    collected = set()
    for art in _collect_workspace_artifacts(run.workdir):
        collected.add(art["path"])
        sha = hashlib.sha256(art["content"].encode("utf-8")).hexdigest()
        if sent.get(art["path"]) == sha:
            continue
        next_sent[art["path"]] = sha
        changed.append(art)
    # Tombstones: a previously-synced file the agent deleted (page merge, rename,
    # restructure) must be deleted from the consumer's store too — otherwise the
    # orphan row gets published and the next respawn's workspace rehydration puts
    # the file back on disk, silently undoing the deletion. Judged by is_file(),
    # NOT by absence from the collection: a file that merely became oversized or
    # binary is skipped by the collector but still exists, and must keep its
    # last-synced row. `sent` scopes the sweep to paths this box life actually
    # synced, so a store row that never materialized here can't be tombstoned.
    wd = Path(run.workdir)
    for path in [p for p in sent if p not in collected]:
        if (wd / path).is_file():
            continue  # still on disk, just not collectable — keep the row
        if sent.get(path) != _SYNC_TOMBSTONE:
            next_sent[path] = _SYNC_TOMBSTONE
            changed.append({"path": path, "deleted": True})
    if changed or commit_input:
        event = {"type": "syncArtifacts", "artifacts": changed}
        if commit_input:
            event["commit_input"] = True
        await run.emit(event)
        # Advance the dedup cursor only after the event is queued. Tombstone
        # markers are retained so an SSE re-attach can replay deletions too.
        if changed:
            sent.clear()
            sent.update(next_sent)
        if commit_input:
            run._commit_input_replay = True
    return len(changed)


def _workspace_replay_artifacts(run: CompileRun, sent: dict) -> list[dict]:
    """Authoritative workspace replay for a newly attached SSE relay.

    A runtime can crash after dequeuing syncArtifacts but before the consumer
    acknowledges it. Re-send every current file and every remembered tombstone
    on attach; consumer upserts/deletes are idempotent.
    """
    artifacts = _collect_workspace_artifacts(run.workdir)
    current = {item["path"] for item in artifacts}
    for path, value in sorted(sent.items()):
        if value == _SYNC_TOMBSTONE and path not in current:
            artifacts.append({"path": path, "deleted": True})
    return artifacts


async def _sync_loop(run: CompileRun, sent: dict):
    """Periodically sync the in-progress workspace until cancelled at run end."""
    try:
        while True:
            await asyncio.sleep(SYNC_INTERVAL_SECS)
            await _sync_workspace(run, sent)
    except asyncio.CancelledError:
        pass


def _http_max_request_bytes() -> int:
    value = int(os.environ.get("KBC_HTTP_MAX_REQUEST_BYTES", str(DEFAULT_HTTP_MAX_REQUEST_BYTES)))
    if value <= 0:
        raise ValueError("KBC_HTTP_MAX_REQUEST_BYTES must be positive")
    return value


def _safe_tar_path(name: str) -> PurePosixPath:
    if "\\" in name:
        raise ValueError(f"unsafe source path {name!r}: backslashes are not allowed")
    path = PurePosixPath(name)
    if not name or path.is_absolute():
        raise ValueError(f"unsafe source path {name!r}: path must be relative")
    parts = [part for part in path.parts if part not in ("", ".")]
    if not parts or any(part == ".." for part in parts):
        raise ValueError(f"unsafe source path {name!r}: parent traversal is not allowed")
    return PurePosixPath(*parts)


def _remove_path(path: Path):
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    elif path.exists() or path.is_symlink():
        path.unlink()


def _ensure_workdir_constitution(workdir: str, locale: str | None = None):
    """Make the prompt's file contract true for source-bundle driven runs. The
    seeded constitution comes from the locale's prompt pack (first writer wins —
    all writers in one run flow carry the same consumer-declared locale)."""
    wd = Path(workdir)
    wd.mkdir(parents=True, exist_ok=True)
    dest = wd / "constitution.md"
    if dest.exists():
        return
    dest.write_text(_playbook_text(locale), encoding="utf-8")


def _install_source_bundle(bundle: bytes, workdir: str, expected_sha256: str | None = None, locale: str | None = None) -> dict:
    max_bundle_bytes = int(os.environ.get("KBC_MAX_SOURCE_BUNDLE_BYTES", str(512 * 1024 * 1024)))
    max_unpacked_bytes = int(os.environ.get("KBC_MAX_SOURCE_UNPACKED_BYTES", str(2 * 1024 * 1024 * 1024)))
    if len(bundle) > max_bundle_bytes:
        raise ValueError(f"source bundle is too large: {len(bundle)} > {max_bundle_bytes}")

    actual_sha = hashlib.sha256(bundle).hexdigest()
    if expected_sha256 and expected_sha256.lower() != actual_sha:
        raise ValueError(f"source bundle sha256 mismatch: expected {expected_sha256}, got {actual_sha}")

    wd = Path(workdir)
    wd.mkdir(parents=True, exist_ok=True)
    staging = wd / f".drop-upload-{uuid.uuid4().hex}"
    raw_dir = wd / "raw"
    drop_dir = wd / "drop"
    file_count = 0
    total_bytes = 0
    office_converted: list = []

    try:
        staging.mkdir(mode=0o755)
        try:
            tf = tarfile.open(fileobj=io.BytesIO(bundle), mode="r:gz")
        except tarfile.TarError as e:
            raise ValueError(f"invalid source bundle: {e}") from e
        with tf:
            for member in tf.getmembers():
                rel = _safe_tar_path(member.name)
                target = staging / Path(*rel.parts)
                resolved = target.resolve(strict=False)
                try:
                    resolved.relative_to(staging.resolve())
                except ValueError as e:
                    raise ValueError(f"unsafe source path {member.name!r}: escapes raw directory") from e

                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                if not member.isfile():
                    raise ValueError(f"unsupported source entry {member.name!r}: only files and directories are allowed")

                total_bytes += member.size
                if total_bytes > max_unpacked_bytes:
                    raise ValueError(f"source bundle unpacks too large: {total_bytes} > {max_unpacked_bytes}")

                target.parent.mkdir(parents=True, exist_ok=True)
                src = tf.extractfile(member)
                if src is None:
                    raise ValueError(f"could not read source entry {member.name!r}")
                with src, target.open("wb") as out:
                    shutil.copyfileobj(src, out)
                file_count += 1

        if file_count == 0:
            raise ValueError("source bundle contains no files")

        _remove_path(raw_dir)
        _remove_path(drop_dir)
        staging.rename(raw_dir)
        # Pre-render binary office sources (.pptx/.xlsx/.docx) to a sibling
        # `<name>.md` so the agent's Read — native for pdf/text/images — can
        # consume them too. Per-file fail-open: a corrupt file is skipped, the
        # original stays, and the install never aborts on one bad deck.
        office_converted, office_errors = office_ingest.convert_tree(str(raw_dir))
        for rel, err in office_errors:
            print(f"[office] {rel}: conversion skipped ({err})")
        if office_converted:
            print(f"[office] pre-rendered {len(office_converted)} office file(s) to sibling markdown")
        try:
            drop_dir.symlink_to(raw_dir, target_is_directory=True)
        except OSError:
            shutil.copytree(raw_dir, drop_dir)
        _ensure_workdir_constitution(workdir, locale)
    except Exception:
        _remove_path(staging)
        raise

    return {
        "workdir": str(wd),
        "raw": str(raw_dir),
        "drop": str(drop_dir),
        "files": file_count,
        "bytes": total_bytes,
        "bundle_sha256": actual_sha,
        "bundle_size_bytes": len(bundle),
        "office_converted": len(office_converted),
    }


def _safe_authoring_path(name: str) -> Path:
    rel = _safe_tar_path(name)
    if len(rel.parts) < 2:
        raise ValueError(f"unsafe authoring path {name!r}: must include a file path under a workspace directory")
    if rel.parts[0] not in {"authoring", "candidate", "eval", "release"}:
        raise ValueError(f"unsafe authoring path {name!r}: must be under authoring/, candidate/, eval/, or release/")
    return rel


def _install_authoring_bundle(bundle: bytes, workdir: str, expected_sha256: str | None = None, locale: str | None = None) -> dict:
    max_bundle_bytes = int(os.environ.get("KBC_MAX_AUTHORING_BUNDLE_BYTES", str(64 * 1024 * 1024)))
    max_unpacked_bytes = int(os.environ.get("KBC_MAX_AUTHORING_UNPACKED_BYTES", str(256 * 1024 * 1024)))
    if len(bundle) > max_bundle_bytes:
        raise ValueError(f"authoring bundle is too large: {len(bundle)} > {max_bundle_bytes}")

    actual_sha = hashlib.sha256(bundle).hexdigest()
    if expected_sha256 and expected_sha256.lower() != actual_sha:
        raise ValueError(f"authoring bundle sha256 mismatch: expected {expected_sha256}, got {actual_sha}")

    wd = Path(workdir)
    wd.mkdir(parents=True, exist_ok=True)
    staging = wd / f".authoring-upload-{uuid.uuid4().hex}"
    file_count = 0
    total_bytes = 0

    try:
        staging.mkdir(mode=0o755)
        try:
            tf = tarfile.open(fileobj=io.BytesIO(bundle), mode="r:gz")
        except tarfile.TarError as e:
            raise ValueError(f"invalid authoring bundle: {e}") from e
        with tf:
            for member in tf.getmembers():
                rel = _safe_authoring_path(member.name)
                target = staging / Path(*rel.parts)
                resolved = target.resolve(strict=False)
                try:
                    resolved.relative_to(staging.resolve())
                except ValueError as e:
                    raise ValueError(f"unsafe authoring path {member.name!r}: escapes workspace") from e

                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                if not member.isfile():
                    raise ValueError(f"unsupported authoring entry {member.name!r}: only files and directories are allowed")

                total_bytes += member.size
                if total_bytes > max_unpacked_bytes:
                    raise ValueError(f"authoring bundle unpacks too large: {total_bytes} > {max_unpacked_bytes}")

                target.parent.mkdir(parents=True, exist_ok=True)
                src = tf.extractfile(member)
                if src is None:
                    raise ValueError(f"could not read authoring entry {member.name!r}")
                with src, target.open("wb") as out:
                    shutil.copyfileobj(src, out)
                file_count += 1

        if file_count == 0:
            raise ValueError("authoring bundle contains no files")

        for top in ("authoring", "candidate", "eval", "release"):
            incoming = staging / top
            if incoming.exists():
                _remove_path(wd / top)
                shutil.move(str(incoming), str(wd / top))
        _ensure_workdir_constitution(workdir, locale)
    except Exception:
        _remove_path(staging)
        raise
    finally:
        _remove_path(staging)

    return {
        "workdir": str(wd),
        "files": file_count,
        "bytes": total_bytes,
        "bundle_sha256": actual_sha,
        "bundle_size_bytes": len(bundle),
    }


# ── Protocol v3 helpers: quickstart brief + proposed-question merge ──
# Both are deterministic (code, not model formatting) so a durable record can't
# be lost to how the agent paraphrases — the same principle behind PROPOSED_PLAN.json.

_BRIEF_MARKER = "我的定调标签"
_BRIEF_PATH = "authoring/BRIEF.json"
QUESTIONS_PROPOSED_PATH = "authoring/QUESTIONS_PROPOSED.json"
_BRIEF_RAW_MAX = 4000  # cap the durable brief's raw slice — the agent is told to follow it


def _write_text_atomic(path: Path, text: str) -> None:
    """Write `text` atomically: a temp file in the same dir + os.replace. A torn
    write (SIGTERM / OOM / full disk mid-write) must never leave a half-file that
    the next read falls back to empty on — that would silently drop prior rounds
    (e.g. every earlier proposed question). os.replace is atomic within one
    filesystem on POSIX."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        tmp.write_text(text, "utf-8")
        os.replace(tmp, path)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise


def _split_brief_tags(s: str) -> list[str]:
    """Split a multi-tag value on Chinese/Latin list separators, dropping blanks."""
    return [t.strip() for t in re.split(r"[、,，;；]", s) if t.strip()]


def parse_brief_block(message: str) -> dict | None:
    """Extract the quickstart 定调 brief block from an opening compile message
    into the structured BRIEF.json record, or None when no brief block is present.
    The wizard's 「开始生成知识库」appends a block shaped like:

        我的定调标签(请作为本次编译的 brief):
        - 给谁看:内部工程师
        - 内容倾向:详尽百科、保留内部信息、只留最新版本
        - 自定义:偏排障场景
        请按这些标签作为编译 brief 执行。

    Parsing it in code (rather than trusting the model to transcribe it) keeps the
    durable brief verbatim regardless of how the agent paraphrases downstream."""
    if not message or _BRIEF_MARKER not in message:
        return None
    # Take the LAST marker occurrence (the wizard appends the brief block at the
    # end) and cap the slice — an unbounded first-occurrence slice would lock onto
    # a marker mentioned earlier in prose and pull the whole unrelated tail into
    # the durable brief, bloating the agent's context.
    raw = message[message.rfind(_BRIEF_MARKER):].strip()[:_BRIEF_RAW_MAX]
    audience = ""
    styles: list[str] = []
    custom: list[str] = []
    for line in raw.splitlines():
        s = line.strip()
        m = re.match(r"^[-*]\s*给谁看\s*[:：]\s*(.+)$", s)
        if m:
            audience = m.group(1).strip()
            continue
        m = re.match(r"^[-*]\s*内容倾向\s*[:：]\s*(.+)$", s)
        if m:
            styles = _split_brief_tags(m.group(1))
            continue
        m = re.match(r"^[-*]\s*自定义\s*[:：]\s*(.+)$", s)
        if m:
            custom = _split_brief_tags(m.group(1))
            continue
    if not (audience or styles or custom):
        return None  # marker present but no tag field parsed → not a real brief
    return {"source": "quickstart_message", "audience": audience,
            "styles": styles, "custom": custom, "raw": raw}


def _write_brief(workdir: str, brief: dict) -> None:
    _write_text_atomic(Path(workdir) / _BRIEF_PATH,
                       json.dumps(brief, ensure_ascii=False, indent=2) + "\n")


def _capture_brief(run: "CompileRun", text: str) -> bool:
    """Parse + persist the OPENING brief block, first-capture-wins. Fail-open: a
    brief capture hiccup must never block the compile turn. Returns whether it
    wrote. Runs on every /message, so it only writes when BRIEF.json does not yet
    exist — otherwise a later message that merely mentions the marker phrase (a
    quote, an aside) would clobber the real brief, often with a near-empty record
    the agent is then told to follow."""
    try:
        if (Path(run.workdir) / _BRIEF_PATH).exists():
            return False
        brief = parse_brief_block(text)
        if brief is None:
            return False
        _write_brief(run.workdir, brief)
        return True
    except Exception:
        return False


# ── Typed authoring commands (v1) ───────────────────────────────────────────

_COMMAND_ACTIONS = {
    "compile.scout",
    "compile.generate",
    "compile.regenerate",
    "compile.approve_plan",
    "compile.incremental",
    "compile.resume",
    "compile.submit_decisions",
    "compile.apply_rulings",
    "compile.repair_test",
}
_FULL_COMPILE_ACTIONS = {
    "compile.generate", "compile.regenerate", "compile.approve_plan", "compile.resume",
}
_BRIEF_AUDIENCES = {"", "internal-eng", "frontline", "external", "newcomer"}
_BRIEF_INTENTS = {"", "understand", "execute", "troubleshoot"}
_CONTENT_LOCALE_RE = re.compile(r"^(?:auto|[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*)$")


class CommandRejected(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _bounded_string(value, field: str, *, required: bool = False, limit: int = 4000) -> str:
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise CommandRejected(f"{field} must be a string")
    value = value.strip()
    if required and not value:
        raise CommandRejected(f"{field} is required")
    if len(value) > limit:
        raise CommandRejected(f"{field} exceeds {limit} characters")
    return value


def _normalize_command(body: dict) -> tuple[str, dict]:
    if not isinstance(body, dict):
        raise CommandRejected("request body must be an object")
    command_id = _bounded_string(body.get("command_id"), "command_id", required=True, limit=128)
    command = body.get("command")
    if not isinstance(command, dict):
        raise CommandRejected("command must be an object")
    if command.get("version") != 1:
        raise CommandRejected("unsupported command version")
    action = _bounded_string(command.get("action"), "command.action", required=True, limit=80)
    if action not in _COMMAND_ACTIONS:
        raise CommandRejected(f"unsupported command action: {action}")
    operation_id = _bounded_string(command.get("operation_id"), "command.operation_id", required=True, limit=128)
    generation = command.get("generation")
    if isinstance(generation, bool) or not isinstance(generation, int) or generation < 1:
        raise CommandRejected("command.generation must be a positive integer")
    parameters = command.get("parameters") or {}
    if not isinstance(parameters, dict):
        raise CommandRejected("command.parameters must be an object")

    brief = parameters.get("brief")
    if brief is not None:
        if not isinstance(brief, dict):
            raise CommandRejected("command.parameters.brief must be an object")
        normalized_brief = {
            "schema_version": 1,
            "source": "authoring_command",
            "intent": _bounded_string(brief.get("intent"), "brief.intent", limit=32),
            "audience": _bounded_string(brief.get("audience"), "brief.audience", limit=64),
            "depth": _bounded_string(brief.get("depth"), "brief.depth", limit=32),
            "redaction": _bounded_string(brief.get("redaction"), "brief.redaction", limit=32) or "none",
            "content_locale": _bounded_string(brief.get("content_locale"), "brief.content_locale", limit=64) or "auto",
            "note": _bounded_string(brief.get("note"), "brief.note", limit=2000),
        }
        if normalized_brief["depth"] not in {"", "full", "concise"}:
            raise CommandRejected("brief.depth must be full or concise")
        if normalized_brief["intent"] not in _BRIEF_INTENTS:
            raise CommandRejected("brief.intent is unsupported")
        if normalized_brief["audience"] not in _BRIEF_AUDIENCES:
            raise CommandRejected("brief.audience is unsupported")
        if normalized_brief["redaction"] not in {"none", "external"}:
            raise CommandRejected("brief.redaction must be none or external")
        if not _CONTENT_LOCALE_RE.fullmatch(normalized_brief["content_locale"]):
            raise CommandRejected("brief.content_locale must be auto or a BCP-47-like locale")
        parameters = {**parameters, "brief": normalized_brief}

    if action == "compile.approve_plan":
        plan_id = _bounded_string(parameters.get("plan_id"), "parameters.plan_id", required=True, limit=64).lower()
        if not re.fullmatch(r"[0-9a-f]{64}", plan_id):
            raise CommandRejected("parameters.plan_id must be a sha256")
        parameters = {**parameters, "plan_id": plan_id}
    elif action == "compile.submit_decisions":
        decisions = parameters.get("decisions")
        if not isinstance(decisions, list) or not decisions:
            raise CommandRejected("parameters.decisions must be a non-empty array")
        clean = []
        for i, item in enumerate(decisions):
            if not isinstance(item, dict):
                raise CommandRejected(f"parameters.decisions[{i}] must be an object")
            clean.append({
                "question_id": _bounded_string(item.get("question_id"), f"decisions[{i}].question_id", required=True, limit=128),
                "value": _bounded_string(item.get("value"), f"decisions[{i}].value", required=True, limit=2000),
            })
        parameters = {**parameters, "decisions": clean}
    elif action == "compile.apply_rulings":
        nonce = _bounded_string(parameters.get("dispatch_nonce"), "parameters.dispatch_nonce", required=True, limit=128)
        rulings = parameters.get("rulings")
        if not isinstance(rulings, list) or not rulings:
            raise CommandRejected("parameters.rulings must be a non-empty array")
        clean = []
        for i, item in enumerate(rulings):
            if not isinstance(item, dict):
                raise CommandRejected(f"parameters.rulings[{i}] must be an object")
            kind = _bounded_string(item.get("kind"), f"rulings[{i}].kind", required=True, limit=32)
            if kind not in {"value", "accept_suspect"}:
                raise CommandRejected(f"rulings[{i}].kind must be value or accept_suspect")
            pages = item.get("affected_pages") or []
            if not isinstance(pages, list) or not all(isinstance(p, str) and p.strip() for p in pages):
                raise CommandRejected(f"rulings[{i}].affected_pages must be a string array")
            clean.append({
                "ticket_id": _bounded_string(item.get("ticket_id"), f"rulings[{i}].ticket_id", required=True, limit=128),
                "affected_pages": [p.strip() for p in pages],
                "kind": kind,
                "value": _bounded_string(item.get("value"), f"rulings[{i}].value", required=kind == "value", limit=4000),
            })
        parameters = {**parameters, "dispatch_nonce": nonce, "rulings": clean}
    elif action == "compile.repair_test":
        parameters = {**parameters,
            "question": _bounded_string(parameters.get("question"), "parameters.question", required=True, limit=4000),
            "reference_answer": _bounded_string(parameters.get("reference_answer"), "parameters.reference_answer", limit=8000),
            "verdict": _bounded_string(parameters.get("verdict"), "parameters.verdict", required=True, limit=128),
            "judge_note": _bounded_string(parameters.get("judge_note"), "parameters.judge_note", limit=4000),
        }

    return command_id, {
        "version": 1,
        "action": action,
        "operation_id": operation_id,
        "generation": generation,
        "parameters": parameters,
    }


def _command_digest(command: dict) -> str:
    encoded = json.dumps(command, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _render_command(run: "CompileRun", command: dict) -> str:
    action = command["action"]
    params = command["parameters"]
    strings = _command_strings(run.locale)
    if action == "compile.submit_decisions":
        lines = [strings["compile.submit_decisions_header"]]
        lines.extend(strings["compile.submit_decisions_line"].format(**item) for item in params["decisions"])
        return "\n".join(lines)
    if action == "compile.apply_rulings":
        lines = [strings["compile.apply_rulings_header"]]
        for item in params["rulings"]:
            template = strings["compile.apply_rulings_suspect"] if item["kind"] == "accept_suspect" else strings["compile.apply_rulings_value"]
            lines.append(template.format(
                ticket_id=item["ticket_id"],
                pages=", ".join(item["affected_pages"]) or "?",
                value=item["value"],
                nonce=params["dispatch_nonce"],
            ))
        return "\n".join(lines)
    if action == "compile.repair_test":
        return strings[action].format(
            question=params["question"],
            reference_answer=params["reference_answer"] or "(not set)",
            verdict=params["verdict"],
            judge_note=params["judge_note"] or "(none)",
        )
    return strings[action]


def _prepare_command(run: "CompileRun", command: dict) -> None:
    """Validate workspace-bound references and materialize structured intent."""
    action = command["action"]
    params = command["parameters"]
    if action == "compile.approve_plan":
        plan_path = Path(run.workdir) / "authoring" / "PROPOSED_PLAN.json"
        if not plan_path.is_file():
            raise CommandRejected("the proposed plan no longer exists", 409)
        if hashlib.sha256(plan_path.read_bytes()).hexdigest() != params["plan_id"]:
            raise CommandRejected("the proposed plan changed; refresh before approving", 409)
    if action == "compile.incremental" and not incremental.has_changes(incremental.load_raw_changes(run.workdir)):
        raise CommandRejected("no structured source changes are available for incremental compile", 409)
    if action == "compile.resume":
        plan = _load_batch_plan(run)
        if plan is None or not batching.pending_batches(plan):
            raise CommandRejected("no interrupted batch plan is available to resume", 409)
    brief = params.get("brief")
    if brief is not None:
        # Structured command data replaces the old localized-text parser. The
        # file remains model-facing intent, not a control-plane fact.
        _write_brief(run.workdir, brief)


# The exact whitespace set to strip, enumerated so it is byte-identical with the
# frontend's mirror (ECMAScript `\s`). Python `re` `\s` and JS `\s` are DIFFERENT
# fixed sets (Python `\s` strips U+0085 / U+001C–U+001F, JS `\s` strips U+FEFF),
# so relying on `\s` on either side makes the derived id diverge for a question
# containing one of those chars — and the frontend re-derives this id for legacy
# id-less rows, so a divergence resurfaces the adopt/dismiss failure. This
# explicit class removes the ambiguity; keep it in lockstep with the frontend.
_WS_RE = re.compile("[\t\n\x0b\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+")
_QUESTION_PUNCT = "?？。.!！,，、"


def _normalize_question(q: str) -> str:
    """Dedup key + stable-id basis for a proposed question: strip the fixed
    whitespace set (`_WS_RE`, enumerated to match the frontend — NOT `\\s`), strip
    a fixed leading/trailing punctuation set, then lowercase. Trailing punctuation
    and case are collapsed BY DESIGN — `删除?` and `删除。` map to one key (a
    question differing only by trailing punctuation is treated as the same); an
    all-punctuation question normalizes to `""` and the caller drops it."""
    return _WS_RE.sub("", str(q or "")).strip(_QUESTION_PUNCT).lower()


def _fnv1a32(s: str) -> int:
    """32-bit FNV-1a over the UTF-8 bytes of s. Shared, fixed formula with the
    frontend so both sides derive the SAME proposal id from a question."""
    h = 2166136261
    for b in s.encode("utf-8"):
        h ^= b
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def _question_id(normalized: str) -> str:
    """Stable proposal id agreed with the frontend: 'q-' + fnv1a32(normalized
    question) as zero-padded 8-hex-digit lowercase. The frontend POSTs this as
    proposal_id on adopt/dismiss — a missing id → empty proposal_id → the consumer 500s."""
    return "q-" + format(_fnv1a32(normalized), "08x")


def merge_proposed_questions(existing: list, incoming: list) -> tuple[list, int, int]:
    """Append-merge newly proposed questions onto the existing list, skipping
    duplicates by normalized question text. Every merged entry carries a stable
    `id` (see _question_id) — the frontend needs it as proposal_id on adopt/dismiss.
    A prior explicit id is preserved; legacy/id-less entries are backfilled from
    the same formula (identical for the same question). Returns (merged, added,
    skipped). Append-only across rounds so a re-proposal never wipes prior picks."""
    merged: list = []
    seen: set = set()
    for q in existing:
        if not isinstance(q, dict):
            continue
        text = str(q.get("question", "")).strip()
        if not text:
            continue
        key = _normalize_question(text)
        seen.add(key)
        qid = str(q.get("id", "")).strip() or _question_id(key)
        merged.append({**q, "id": qid, "question": text})
    added = skipped = 0
    for item in incoming:
        if not isinstance(item, dict):
            skipped += 1
            continue
        text = str(item.get("question", "")).strip()
        key = _normalize_question(text)
        if not key or key in seen:
            skipped += 1
            continue
        seen.add(key)
        merged.append({
            "id": _question_id(key),
            "question": text,
            "reference": str(item.get("reference", "")).strip(),
            "source": str(item.get("source", "")).strip(),
        })
        added += 1
    return merged, added, skipped


def _make_compile_tools(run: CompileRun):
    """Build the box's custom tools (closures over run) — the structured-signal
    moat. All model-facing text (descriptions + result strings) comes from the
    run's locale pack."""
    ts = _tool_strings(run.locale)

    @tool("report_summary", ts["report_summary"]["desc"], {"summary": str})
    async def report_summary(args):
        await run.emit({"type": "summary", "summary": args.get("summary", "")})
        return {"content": [{"type": "text", "text": "summary recorded"}]}

    @tool("propose_plan", ts["propose_plan"]["desc"], {"plan": str})
    async def propose_plan(args):
        # The owner's approve UI is driven by THIS artifact — written here by
        # code, deterministically, from the tool argument. The signal must never
        # depend on how the model formatted its working notes (a proposal that
        # bounces on file formatting is a UI held hostage by prose). PLAN.md
        # remains the box's own working state; syncing happens at turn end.
        plan_text = str(args.get("plan", ""))
        proposal_path = Path(run.workdir) / "authoring" / "PROPOSED_PLAN.json"
        _write_text_atomic(proposal_path, json.dumps({
            "text": plan_text,
            "proposed_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }, ensure_ascii=False, indent=2))
        await run.emit({"type": "plan_proposed", "plan": plan_text})
        # Advisory nudge only — working-state hygiene, never a gate.
        reminder = ""
        plan_path = Path(run.workdir) / "authoring" / "PLAN.md"
        section = ""
        if plan_path.exists():
            m = re.search(r"## Next Pages\n(.*?)(?=\n## |\Z)", plan_path.read_text("utf-8"), re.S)
            section = m.group(1) if m else ""
        if "- [ ]" not in section and "- [x]" not in section:
            reminder = ts["propose_plan"]["reminder"]
        return {"content": [{"type": "text", "text": ts["propose_plan"]["ack"] + reminder}]}

    @tool(
        "resolve_ticket",
        ts["resolve_ticket"]["desc"],
        # dispatch_nonce IS part of the schema: the prompt orders the echo and
        # the consumer matches receipts to dispatch rounds by it — but a model
        # follows the declared parameter list, so leaving it out guaranteed the
        # echo was omitted (review finding). Empty string when the directive
        # carried no nonce.
        {"ticket_id": str, "applied_value": str, "pages_edited": list, "note": str, "dispatch_nonce": str},
    )
    async def resolve_ticket(args):
        rt = ts["resolve_ticket"]
        tid = str(args.get("ticket_id", "")).strip()
        if not tid:
            return {"content": [{"type": "text", "text": rt["need_id"]}]}
        path = Path(run.workdir) / "authoring" / "CONTRADICTIONS.json"
        try:
            tickets = json.loads(path.read_text("utf-8")) if path.exists() else []
            if not isinstance(tickets, list):
                tickets = []
        except Exception as e:
            return {"content": [{"type": "text", "text": rt["read_failed"].format(e=e)}]}
        target = next((tk for tk in tickets if isinstance(tk, dict) and str(tk.get("id")) == tid), None)
        if target is None:
            ids = [tk.get("id") for tk in tickets if isinstance(tk, dict)]
            return {"content": [{"type": "text", "text": rt["not_found"].format(tid=tid, ids=ids)}]}
        # The AI's structured CLAIM (evidence, not truth): the owner reviews it and
        # can reopen. status stays for back-compat; agent_report carries the detail.
        target["status"] = "applied"
        target["agent_report"] = {
            "applied_value": str(args.get("applied_value", "")),
            "pages_edited": [str(p) for p in (args.get("pages_edited") or []) if str(p).strip()],
            "note": str(args.get("note", "")),
            # Echo of the dispatch nonce from the apply directive: lets the
            # consumer match this receipt to the EXACT dispatch round it answers
            # (timestamps alone cannot distinguish two overlapping rounds).
            "dispatch_nonce": str(args.get("dispatch_nonce", "")),
            "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        try:
            _write_text_atomic(path, json.dumps(tickets, ensure_ascii=False, indent=2))
        except Exception as e:
            return {"content": [{"type": "text", "text": rt["write_failed"].format(e=e)}]}
        return {"content": [{"type": "text", "text": rt["registered"].format(tid=tid)}]}

    @tool("propose_questions", ts["propose_questions"]["desc"], {"questions": list})
    async def propose_questions(args):
        pq = ts["propose_questions"]
        incoming = args.get("questions")
        if not isinstance(incoming, list):
            return {"content": [{"type": "text", "text": pq["need_list"]}]}
        path = Path(run.workdir) / QUESTIONS_PROPOSED_PATH
        try:
            existing = json.loads(path.read_text("utf-8")) if path.exists() else []
            if not isinstance(existing, list):
                existing = []
        except Exception:
            existing = []  # a corrupt/half-written prior file must not lose this round
        merged, added, skipped = merge_proposed_questions(existing, incoming)
        try:
            _write_text_atomic(path, json.dumps(merged, ensure_ascii=False, indent=2) + "\n")
        except Exception as e:
            return {"content": [{"type": "text", "text": pq["write_failed"].format(e=e)}]}
        await run.emit({"type": "summary", "summary": pq["summary"].format(added=added, skipped=skipped, total=len(merged))})
        return {"content": [{"type": "text", "text": pq["registered"].format(added=added, skipped=skipped, total=len(merged))}]}

    return create_sdk_mcp_server("compile", tools=[report_summary, propose_plan, resolve_ticket, propose_questions])


def _seed_workdir(workdir: str):
    """Populate an empty workdir from $KBC_SEED_DIR (test images bake a corpus at
    /seed; the pod's /work is an empty emptyDir that shadows any image /work)."""
    seed = os.environ.get("KBC_SEED_DIR")
    if not seed:
        return
    wd = Path(workdir)
    if (wd / "drop").exists():
        return
    src = Path(seed)
    if not src.exists():
        return
    wd.mkdir(parents=True, exist_ok=True)
    for item in src.iterdir():
        dest = wd / item.name
        if item.is_dir():
            shutil.copytree(item, dest, dirs_exist_ok=True)
        else:
            shutil.copy(item, dest)
    _ensure_workdir_constitution(workdir)


async def _smoke_compile(run: CompileRun):
    """KBC_SMOKE=1: prove the consumer↔runtime↔box wiring (live events + artifact
    sync + turn persistence) in-cluster WITHOUT calling an LLM (the real compile
    is validated separately). Speaks only the capability-era event vocabulary."""
    await run.emit({"type": "summary", "summary": "[smoke] wiring check — no LLM"})
    cand = Path(run.workdir) / "candidate"
    cand.mkdir(parents=True, exist_ok=True)
    (cand / "index.md").write_text("# smoke index\n\nWiring e2e — no real content.\n")
    await run.emit({"type": "log", "text": "[smoke] wrote candidate/index.md"})
    await run.emit({"type": "turn_done", "text": "[smoke] wiring check complete"})


def _l1_repair_rounds() -> int:
    # Default 2 (was 1): with the gateway's per-chunk SSE decoding bug, a long
    # Chinese repair turn's OWN output can pick up fresh U+FFFD corruption —
    # one round was structurally a coin-flip on large zh KBs (review finding).
    # Still bounded; drop back to 1 once the gateway does cross-chunk decoding.
    return int(os.environ.get("KBC_L1_REPAIR_ROUNDS", "2"))


def _media_verify_enabled() -> bool:
    return os.environ.get("KBC_MEDIA_VERIFY", "on") != "off"


def _media_verify_max_images() -> int:
    return int(os.environ.get("KBC_MEDIA_VERIFY_MAX_IMAGES", "8"))


def _media_verify_attempts() -> int:
    """Failed-verification retries per page before it ships with a VISIBLE
    exhausted flag in SELFCHECK.json (fail-open must never equal false-pass)."""
    return max(1, int(os.environ.get("KBC_MEDIA_VERIFY_ATTEMPTS", "2")))


def _media_verify_rounds() -> int:
    """Bound on the batch-tail verify/repair loop: repair turns can add new
    image citations that re-enter pending, so the loop needs a hard cap."""
    return max(1, int(os.environ.get("KBC_MEDIA_VERIFY_ROUNDS", "3")))


def _settle_media_outcome(run, chunk: dict, result: dict | None) -> list[str]:
    """Post-verify bookkeeping (review fix: pages used to be marked verified
    BEFORE verification ran, so a total transcription failure shipped image
    claims unchecked, permanently). Completed pages are marked verified; failed
    pages get an attempt bump and retry on a later trigger until the budget is
    spent — then they are marked with a visible `exhausted` flag. result=None
    means the whole flow failed → every page in the chunk is a failed attempt.
    Returns the pages exhausted this round."""
    completed = list((result or {}).get("completed_pages") or [])
    failed = list((result or {}).get("failed_pages") or [])
    if result is None:
        failed = list(chunk)
    if completed:
        selfcheck.mark_media_verified(run.workdir, completed)
    exhausted: list[str] = []
    if failed:
        counts = selfcheck.bump_media_attempts(run.workdir, failed)
        exhausted = [p for p in failed if counts.get(p, 0) >= _media_verify_attempts()]
        if exhausted:
            selfcheck.mark_media_verified(run.workdir, exhausted, exhausted=True)
    return exhausted


async def _emit_media_exhausted(run, exhausted: list[str]) -> None:
    if not exhausted:
        return
    await run.emit({"type": "summary", "text": _loc(run,
        f"Self-check (images): {len(exhausted)} page(s) could not be verified after "
        f"{_media_verify_attempts()} attempt(s) — shipped with a visible flag in SELFCHECK.json.",
        f"自检(图像):{len(exhausted)} 页在 {_media_verify_attempts()} 次尝试后仍无法完成复核——已放行并在 SELFCHECK.json 显式标记。")})


def _media_verify_due(run) -> dict[str, list[str]] | None:
    """A ≤max-images chunk of image-citing pages owed a blind verify on the
    settled draft, else None. Idempotent via media_verify.verified_pages —
    pages verify once per content lifecycle; the remainder rolls into the next
    settled turn automatically (only the chunk gets marked)."""
    workdir = getattr(run, "workdir", None)
    if not workdir or not _media_verify_enabled():
        return None
    task = getattr(run, "_media_task", None)
    if task is not None and not task.done():
        return None  # single-flight
    if not (Path(workdir) / "candidate" / "index.md").is_file():
        return None
    sc = selfcheck.read_selfcheck(workdir)
    if not sc or sc.get("state") != "passed":
        return None  # ledger repairs first; verify once settled
    inflight = getattr(run, "_media_inflight", set())  # test doubles may lack it
    deferred = getattr(run, "_media_deferred", set())  # failed-this-drain pages (see _maybe_start_media_verify)
    pending = {p: imgs for p, imgs in selfcheck.pending_media_verification(workdir).items()
               if p not in inflight and p not in deferred}
    if not pending:
        return None
    return selfcheck.cap_media_pending(pending, _media_verify_max_images())


async def _set_converge_phase(run, phase: str) -> None:
    """Set the DURABLE verify converge phase (SELFCHECK.json) + sync it, so the
    frontend reads an authoritative 校对中/修订中/settled signal instead of
    run_status (the phantom's root). Additive + fail-open — no control-flow
    change, so it cannot affect the never-stuck turn/repair logic."""
    wd = getattr(run, "workdir", None)
    if not wd:
        return
    selfcheck.set_converge_phase(wd, phase)
    sent = getattr(run, "_sync_sent", None)
    if sent is not None:
        try:
            await _sync_workspace(run, sent)
        except Exception:
            pass


def _maybe_start_media_verify(run, drain: bool = False) -> bool:
    """Kick the blind transcribe+compare flow as a background task (图像复核 v2).
    Verified marks land only AFTER a completed verification (review fix — the
    old up-front mark turned a total transcription failure into a silent,
    permanent false-pass); the in-flight set + attempt budget keep it loop-free.
    drain=True is the flow's own next-chunk chaining: pages that failed THIS
    drain stay deferred (excluded from the due-check) so a failed chunk moves
    the drain on to the not-yet-attempted chunks instead of hot-looping the
    failed pages through the attempt budget. A fresh (default) trigger — the
    turn seam, i.e. a genuinely later turn — clears the deferral, which is
    exactly the designed per-page retry cadence."""
    if not drain:
        run._media_deferred = set()
    try:
        chunk = _media_verify_due(run)
    except Exception:
        return False  # a broken due-check must never break the turn seam
    if not chunk:
        return False
    run._media_inflight = getattr(run, "_media_inflight", set()) | set(chunk)
    run._media_task = asyncio.get_running_loop().create_task(
        _run_media_verify_flow(run, chunk))
    return True


async def _run_media_verify_flow(run, chunk: dict[str, list[str]]) -> None:
    """Blind transcription + text-only comparison over one chunk, then ONE
    repair turn for confirmed findings. De-anchored by construction: the
    transcriber never sees the page, the comparer never sees the image —
    the 07-06/07 live failures (MEM 条→GPU-Util, 跨图 H20) were both
    confirmation-bias artifacts of claim-in-context re-reading. Fail-open."""
    injected_repair = False
    settled = False        # the primary settle ran — the except must never settle AGAIN
    failed_pages: list[str] = []
    exhausted: list[str] = []
    try:
        n_imgs = sum(len(v) for v in chunk.values())
        await run.emit({"type": "summary",
                        "text": _loc(run,
                                     f"Self-check (images): blind-verifying {len(chunk)} page(s) / {n_imgs} image(s) (background)…",
                                     f"自检(图像):盲转写复核 {len(chunk)} 页 / {n_imgs} 张图(后台)…")})
        await _set_converge_phase(run, "verifying")
        loop = asyncio.get_running_loop()
        result = await mediaverify.run_blind_verify(
            ClaudeEngine(), run.workdir, chunk,
            progress=lambda s: loop.create_task(run.emit({"type": "summary", "text": s})),
            locale=getattr(run, "locale", None))
        failed_pages = list(result.get("failed_pages") or [])
        exhausted = _settle_media_outcome(run, chunk, result)
        settled = True
        await _emit_media_exhausted(run, exhausted)
        sent = getattr(run, "_sync_sent", None)
        if sent is not None:
            try:
                await _sync_workspace(run, sent)  # MEDIA_TRANSCRIPTS.json rides along
            except Exception:
                pass
        findings, errors = result["findings"], result["errors"]
        tail = _loc(run, f"; {len(errors)} transcription/comparison failure(s)",
                    f";{len(errors)} 项转写/比对失败") if errors else ""
        if findings:
            await run.emit({"type": "summary", "text": _loc(run,
                f"Self-check (images): {result['images']} image(s) checked, {len(findings)} claim(s) contradict the image / exceed the source — repair injected{tail}",
                f"自检(图像):{result['images']} 张图已核,{len(findings)} 条断言与图不符/超源,注入回修{tail}")})
            await _set_converge_phase(run, "revising")
            await run.inject_user_message(mediaverify.build_repair_prompt(findings, locale=getattr(run, "locale", None)))
            injected_repair = True  # only after a SUCCESSFUL inject — a failed one must fall through to the chain below (review)
        else:
            await run.emit({"type": "summary", "text": _loc(run,
                f"Self-check (images): {result['images']} image(s) checked, claims match the images ✓{tail}",
                f"自检(图像):{result['images']} 张图已核,断言与图一致 ✓{tail}")})
    except Exception as e:
        try:
            await run.emit({"type": "summary", "text": _loc(run,
                f"Self-check (images) failed, skipping this round: {e!r}",
                f"自检(图像)执行失败,本轮跳过: {e!r}")})
            # Settle ONLY if the primary settle never ran (review): a throw
            # AFTER it — e.g. the findings inject failing — used to re-settle
            # the chunk with result=None, double-bumping just-verified pages
            # toward a spurious `exhausted` and mis-charging failed pages two
            # attempts for one real failure.
            if not settled:
                failed_pages = list(chunk)
                exhausted = _settle_media_outcome(run, chunk, None)
                await _emit_media_exhausted(run, exhausted)
        except Exception:
            pass
    finally:
        # Pages that FAILED this pass sit out the rest of the drain (exhausted
        # ones are marked verified and leave pending on their own): the chain
        # below then moves on to the not-yet-attempted chunks instead of
        # hot-looping the failed pages through the attempt budget.
        run._media_deferred = getattr(run, "_media_deferred", set()) | (
            set(failed_pages) - set(exhausted))
        run._media_inflight = getattr(run, "_media_inflight", set()) - set(chunk)
        # We ARE run._media_task and are completing: release the single-flight
        # reference first, or _media_verify_due's not-done() guard blocks the
        # very chain below from starting the next chunk (self-drain).
        run._media_task = None
        # Hand back to the seam (review HIGH): the findings path re-enters it via
        # its repair turn, but the CLEAN and failed paths used to just stop —
        # converge_phase parked at "verifying" forever in the single-session
        # case (test step never unlocked, PK never ran). Mirror the FULL seam:
        # first the NEXT media chunk (a >cap image set self-drains chunk by
        # chunk — settling after chunk 1 silently skipped the rest AND PK,
        # review finding), then PK, else settle. The drain chains even after a
        # FAILED pass (review round 2): a chunk-1 blip must not skip chunks
        # 2..N's first attempt — the deferral above keeps this loop-free, and
        # the failed pages retry on a later turn's fresh trigger while their
        # attempt budget lasts (never-stuck).
        if not injected_repair:
            try:
                if not (_maybe_start_media_verify(run, drain=True) or _maybe_start_pk(run)):
                    await _set_converge_phase(run, "settled")
            except Exception:
                pass


# ── Layer-2 red-blue PK wiring (S2, DESIGN-kb-compile-self-verification §9) ──
# Async post-check shape (option c): turn_done fires normally, the PK runs as a
# background task over a PINNED snapshot, findings come back as an ordinary
# injected repair turn, and ONE targeted retest of the failed questions closes
# the round. Bounded and idempotent by construction: tested_tree_hash in the
# SELFCHECK `pk` section keys "this draft was already examined"; rounds are
# capped; every failure path writes an honest terminal pk state (fail-open).

PK_RESULT_PATH = "authoring/PK_RESULT.json"
_PK_ANSWER_PERSIST_CAP = 4000  # chars per answer in the persisted detail


def _pk_mode() -> str:
    return os.environ.get("KBC_PK_MODE", "auto")


def _pk_repair_rounds() -> int:
    return int(os.environ.get("KBC_PK_REPAIR_ROUNDS", "1"))


def _read_pk_result(workdir: str) -> dict | None:
    p = Path(workdir) / PK_RESULT_PATH
    if not p.is_file():
        return None
    try:
        v = json.loads(p.read_text(encoding="utf-8"))
        return v if isinstance(v, dict) else None
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None


def _write_pk_result(workdir: str, detail: dict) -> None:
    """Persist the full question/answer/verdict detail (rides syncArtifacts, so
    a respawned box can still run the targeted retest). Answers are truncated —
    the retest only needs the questions; long answers are debugging color."""
    slim = {
        "questions": detail.get("questions", []),
        "verdicts": detail.get("verdicts", {}),
        "answers": {
            qid: {**a, "answer": (a.get("answer") or "")[:_PK_ANSWER_PERSIST_CAP]}
            for qid, a in (detail.get("answers") or {}).items()
        },
    }
    p = Path(workdir) / PK_RESULT_PATH
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(slim, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def _pk_due(run) -> str | None:
    """'full' | 'retest' when the settled draft owes a PK pass, else None.
    Ordering contract: ledger repairs and the image re-verify own the seam
    first — PK only examines a draft the cheaper layers are done with."""
    workdir = getattr(run, "workdir", None)
    if not workdir or _pk_mode() != "auto":
        return None
    if getattr(run, "_batch_active", False):
        return None  # the train's own end triggers PK
    task = getattr(run, "_pk_task", None)
    if task is not None and not task.done():
        return None  # single-flight
    if not (Path(workdir) / "candidate" / "index.md").is_file():
        return None
    sc = selfcheck.read_selfcheck(workdir) or {}
    if sc.get("state") != "passed":
        return None
    media_task = getattr(run, "_media_task", None)
    if media_task is not None and not media_task.done():
        return None  # blind image verify owns the seam first
    if _media_verify_enabled() and selfcheck.pending_media_verification(workdir):
        return None
    pk = sc.get("pk") or {}
    if pk.get("state") == "repairing":
        return "retest"
    if pk.get("tested_tree_hash") == selfcheck.candidate_tree_hash(workdir):
        return None  # this exact draft was already examined (any terminal state)
    return "full"


def _maybe_start_pk(run) -> bool:
    """Returns whether a PK round was started (so the turn seam can tell 'a verify
    is now pending' from 'nothing left to do → settled')."""
    try:
        kind = _pk_due(run)
    except Exception:
        return False  # a broken due-check must never break the turn seam
    if kind:
        run._pk_task = asyncio.get_running_loop().create_task(_run_pk_flow(run, kind))
        return True
    return False


def _pk_narration(summary: dict, locale: str | None = None) -> str:
    state = summary.get("state")
    n, ok = summary.get("questions", 0), summary.get("gate_pass", 0)
    fails = len(summary.get("failures") or [])
    wall = summary.get("wall_secs", 0)
    ung = len(summary.get("ungraded") or [])
    if selfcheck._is_en(locale):
        tail = f" (plus {ung} left ungraded by the judge, excluded from scoring)" if ung else ""
        if state == "passed":
            return f"Self-check (red-blue PK): {ok}/{n - ung} all passed ✓ ({wall}s){tail}"
        if state == "partial":
            return (f"Self-check (red-blue PK): cut off at the wall clock — {summary.get('graded', 0)}/{n} graded, "
                    f"{fails} failed; results recorded{tail}")
        if state == "repairing":
            return f"Self-check (red-blue PK): {ok}/{n - ung} passed, {fails} failed — repair round injected{tail}"
        if state == "unconverged":
            return f"Self-check (red-blue PK): {ok}/{n - ung} passed, {fails} failed — the rest on the publish card{tail}"
        return f"Self-check (red-blue PK) failed: {summary.get('error', '?')}"
    tail = f"(另 {ung} 题裁判未判,不计分)" if ung else ""
    if state == "passed":
        return f"自检(红蓝队):{ok}/{n - ung} 全过 ✓({wall}s){tail}"
    if state == "partial":
        return f"自检(红蓝队):超时截断,已判 {summary.get('graded', 0)}/{n},{fails} 项未过——结果已入账{tail}"
    if state == "repairing":
        return f"自检(红蓝队):{ok}/{n - ung} 过,{fails} 项未过,已注入回修轮{tail}"
    if state == "unconverged":
        return f"自检(红蓝队):{ok}/{n - ung} 过,{fails} 项未过——余项见发布确认卡{tail}"
    return f"自检(红蓝队)失败:{summary.get('error', '?')}"


async def _run_pk_flow(run, kind: str) -> None:
    """One PK round over a pinned snapshot of the current draft. Fail-open at
    every boundary — a PK crash costs the PK, never the compile session."""
    workdir = run.workdir
    tmp = tempfile.mkdtemp(prefix="kbc-pk-")
    try:
        tree = selfcheck.candidate_tree_hash(workdir)
        _, pages = selfcheck.pack_candidates_to_wiki(workdir, Path(tmp))
        raw_dir = str(Path(workdir) / "raw")
        authoring_dir = str(Path(workdir) / "authoring")
        constitution = Path(workdir) / "constitution.md"
        sc = selfcheck.read_selfcheck(workdir) or {}
        prev_pk = sc.get("pk") or {}
        prev_rounds = int(prev_pk.get("rounds_used") or 0)

        override = None
        if kind == "retest":
            prev_detail = _read_pk_result(workdir)
            failed_ids = {f.get("id") for f in prev_pk.get("failures") or []}
            override = [q for q in (prev_detail or {}).get("questions", [])
                        if q.get("id") in failed_ids] or None
            if override is None:
                # Detail lost (e.g. pre-sync crash) → full pass, but count the
                # burned round so this can never oscillate full↔repairing.
                kind = "full"
                prev_rounds = max(prev_rounds, _pk_repair_rounds())

        await run.emit({"type": "summary", "text": _loc(run,
            f"Self-check (red-blue PK): {'targeted re-test of ' + str(len(override)) + ' question(s)' if override else 'full checkup'}"
            " started (background, does not block the session)…",
            f"自检(红蓝队):{'定向复测 ' + str(len(override)) + ' 题' if override else '全量体检'}"
            "开始(后台运行,不影响会话)…")})
        await _set_converge_phase(run, "verifying")
        loop = asyncio.get_running_loop()
        summary, detail = await redblue.run_pk(
            ClaudeEngine(), wiki_dir=tmp, raw_dir=raw_dir, page_count=pages,
            authoring_dir=authoring_dir,
            constitution_path=str(constitution) if constitution.is_file() else None,
            questions_override=override,
            media_pages=None if override else selfcheck.media_citing_pages(workdir),
            progress=lambda s: loop.create_task(
                run.emit({"type": "summary", "text": s})),
            locale=getattr(run, "locale", None))
        summary["tested_tree_hash"] = tree
        summary["kind"] = kind

        if kind == "retest":
            # Merge into the standing scoreboard. gate_pass sums (retested
            # passes were failures before, so no double count); a retest
            # question the judge again failed to grade KEEPS its previous
            # failed standing (never counts as resolved); ungraded questions
            # stay out of the pass-rate denominator.
            prev_ungraded = sorted(prev_pk.get("ungraded") or [])
            total_q = int(prev_pk.get("questions") or summary.get("questions") or 0)
            retest_ungraded = set(summary.get("ungraded") or [])
            carried = [f for f in (prev_pk.get("failures") or [])
                       if f.get("id") in retest_ungraded]
            summary["failures"] = (summary.get("failures") or []) + carried
            summary["gate_pass"] = int(prev_pk.get("gate_pass") or 0) + int(summary.get("gate_pass") or 0)
            summary["questions"] = total_q
            graded_total = max(1, total_q - len(prev_ungraded))
            summary["pass_rate"] = round(summary["gate_pass"] / graded_total, 3)
            summary["ungraded"] = prev_ungraded
            summary["rounds_used"] = prev_rounds + 1
            if summary.get("state") not in ("failed",):
                summary["state"] = "passed" if not summary["failures"] else "unconverged"
        elif (summary.get("state") == "unconverged"
              and summary.get("failures") and prev_rounds < _pk_repair_rounds()):
            summary["state"] = "repairing"
            summary["rounds_used"] = prev_rounds
        else:
            summary["rounds_used"] = prev_rounds

        selfcheck.update_pk_section(workdir, summary)
        if detail.get("questions"):
            _write_pk_result(workdir, detail)
        sent = getattr(run, "_sync_sent", None)
        if sent is not None:
            try:
                await _sync_workspace(run, sent)
            except Exception:
                pass
        await run.emit({"type": "summary", "text": _pk_narration(summary, getattr(run, "locale", None))})
        if summary.get("state") == "repairing":
            await _set_converge_phase(run, "revising")
            await run.inject_user_message(redblue.build_pk_repair_prompt(summary, locale=getattr(run, "locale", None)))
        elif summary.get("state") in ("passed", "partial", "unconverged", "failed"):
            # `failed` included (review fix): run_pk is fail-open and RETURNS
            # failed rather than raising — without a terminal here the phase
            # wedged at "verifying" and the frontend test-step gate never opened.
            # Converged: red-blue (the final layer) reached a terminal state and
            # no repair was injected → the draft is stable and testable.
            await _set_converge_phase(run, "settled")
    except Exception as e:
        try:
            selfcheck.update_pk_section(workdir, {
                "state": "failed", "error": repr(e),
                "tested_tree_hash": selfcheck.candidate_tree_hash(workdir)})
        except Exception:
            pass
        try:
            await run.emit({"type": "summary", "text": _loc(run,
                f"Self-check (red-blue PK) failed, skipping this round: {e!r}",
                f"自检(红蓝队)执行失败,本轮跳过: {e!r}")})
        except Exception:
            pass
        try:
            # Fail-open PK must still terminalize the converge gate.
            await _set_converge_phase(run, "settled")
        except Exception:
            pass
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


async def _post_turn_selfcheck(run) -> str | None:
    """Layer-1 deterministic self-check at turn end (coverage ledger + lint;
    design: DESIGN-kb-compile-self-verification-2026-07-03 §8.1). All analysis
    lives in selfcheck.py (engine-neutral); this driver only decides WHEN
    (candidate state changed + index.md exists) and relays the bounded repair
    prompt through the run's message seam. turn_done still fires normally —
    the never-stuck invariant stays intact; a repair is just the next turn.
    Returns the repair prompt to inject after turn_done, or None."""
    workdir = getattr(run, "workdir", None)
    if not workdir:  # test sessions reuse _emit_message but have no workspace
        return None
    # Consume the scoped-incremental guard state once, whatever this turn's outcome
    # (a tree that didn't change → no violations possible → nothing to guard).
    # getattr: test doubles / non-incremental runs may not carry the attribute.
    incr = getattr(run, "_incr_pending", None)
    run._incr_pending = None
    key = selfcheck.state_key(workdir)
    unchanged = key is not None and key == run._selfcheck_key
    if unchanged:
        # A NO-OP repair turn must still reach the gate: the dedup early-return
        # used to let a repair turn that changed nothing ledger-relevant keep
        # state="repairing" forever with NO residual ticket while the seam
        # settled (review finding). Falling through re-runs the gate on the
        # same tree — spends the budget honestly and files the ticket. A
        # byte-unchanged tree still cannot have out-of-scope edits, so the
        # incremental guard stays trivially clean either way.
        # None (SELFCHECK.json missing/corrupt — e.g. the model's own Bash
        # damaged it on a tree-unchanged turn) must fall through too: an early
        # return here would leave whatever state the file last carried (or no
        # state at all) with the gate never re-run — recomputing heals the file
        # and spends the budget honestly (review).
        last_state = (selfcheck.read_selfcheck(workdir) or {}).get("state")
        if last_state is not None and last_state != "repairing":
            return None
    elif incr is None:
        if key is None:
            return None
        # mid-Execute exemption: pages exist but the index isn't written yet.
        # NOT for the batch-final ledger pass (_ledger_forced): all batches are
        # done there, so a missing index is real damage — fall through and let
        # the index_missing lint order the rebuild (review finding: the train
        # used to settle an unroutable draft).
        if not (Path(workdir) / "candidate" / "index.md").is_file() and not getattr(run, "_ledger_forced", False):
            return None
    # An INCREMENTAL turn falls through even with index.md (or the whole tree)
    # missing: on an incremental turn the index always pre-existed, so its
    # absence IS out-of-scope damage — the guard below restores what the
    # snapshot covers and the ledger/lint flags the rest. The early-returns
    # used to fire after the guard state was already consumed, letting an
    # index-deleting turn escape the byte freeze entirely (review finding).
    run._selfcheck_key = key
    # Scoped-incremental byte-integrity guard: on an incremental turn, pages OUTSIDE
    # the authorized set (affected ∪ declared added-targets ∪ index) must be byte-
    # identical to their pre-turn state. Violations are RESTORED BY CODE first —
    # byte-exact from the pre-turn snapshot, BEFORE the ledger runs so it judges
    # the restored tree. The model cannot un-edit toward a hash, so routing these
    # through the repair prompt burned the whole budget and always landed
    # unconverged (3/3 live rounds, 07-09). Only what code could not restore
    # (a snapshot miss) is left for a repair turn.
    incr_violations: list[str] = []
    restored_pages: list[str] = []
    editable: set[str] = set()
    if incr:
        after = incremental.page_hashes(workdir)
        # repair_pages (set on re-arm): a ledger/lint repair turn legitimately
        # edits pages OUTSIDE the round's authorized set — dangling-citing pages,
        # charset/orphan pages. Without widening, the mechanical restore reverts
        # the repair itself and the round can never converge.
        editable = set(incremental.authorized_pages(workdir, incr["changeset"])) | set(
            incr.get("repair_pages") or [])
        incr_violations = incremental.integrity_violations(incr["before"], after, editable)
        if incr_violations:
            restored_pages = incremental.restore_pages(
                workdir, incr.get("before_bytes") or {}, incr_violations)
            if restored_pages:
                after = incremental.page_hashes(workdir)
                incr_violations = incremental.integrity_violations(incr["before"], after, editable)
    report = selfcheck.run_layer1(workdir)
    grandfathered_format: list[dict] = []
    if incr:
        blocking, grandfathered_format = selfcheck.filter_incremental_format_violations(
            report["lint"]["violations"],
            incr.get("baseline_format_violations") or [],
            editable,
        )
        report["lint"] = {"ok": not blocking, "violations": blocking}
    if incr:
        # Keep inherited debt visible without allowing it to widen repair_pages
        # and silently turn a scoped edit into a whole-library migration. The
        # full set can be recomputed from the unchanged baseline; cap the report
        # payload so a legacy corpus cannot exceed the workspace sync budget.
        report["incremental"] = {
            "out_of_scope_pages": incr_violations,
            "restored_pages": restored_pages,
            "grandfathered_format_violation_count": len(grandfathered_format),
            "grandfathered_format_violations": grandfathered_format[:40],
        }
    ledger_clean = report["coverage"]["closed"] and report["lint"]["ok"]
    if ledger_clean and not incr_violations:
        run._l1_repairs_used = 0
        report["state"] = "passed"
    elif run._l1_repairs_used < _l1_repair_rounds():
        report["state"] = "repairing"
        # The report carries the PREVIOUS converge_phase (possibly "settled");
        # the pre-turn_done sync would ship repairing+settled for one window
        # before the seam re-sets revising — momentarily unlocking the test
        # step on a draft about to be revised (review). Stamp revising now;
        # the seam's later set is idempotent.
        report["converge_phase"] = "revising"
    else:
        report["state"] = "unconverged"  # budget spent: publish card shows the rest
    report["repair_rounds_used"] = run._l1_repairs_used
    selfcheck.write_selfcheck(workdir, report)
    locale = getattr(run, "locale", None)
    if restored_pages:
        shown = ", ".join(restored_pages[:5]) + ("…" if len(restored_pages) > 5 else "")
        await run.emit({"type": "summary", "text": _loc(run,
            f"[Incremental guard] {len(restored_pages)} out-of-scope page(s) auto-restored byte-exact: {shown}",
            f"【增量护栏】{len(restored_pages)} 页越界改动已自动按字节还原:{shown}")})
    await run.emit({"type": "summary", "text": selfcheck.narration(report, locale)})
    if report["state"] == "unconverged":
        # Budget spent with residuals → land a ticket in the owner's question
        # queue by CODE (same schema the model uses). The publish page only
        # DISPLAYS residuals; it must never be where the owner discovers work.
        try:
            if selfcheck.file_residual_ticket(workdir, report, locale):
                await run.emit({"type": "summary", "text": _loc(run,
                    "Self-check residuals filed as a ticket in the question queue.",
                    "自检残留已落为疑问工单,待负责人裁决。")})
        except Exception:
            pass  # ticket filing must never break the turn seam (fail-open, §4.5)
    if report["state"] == "repairing":
        run._l1_repairs_used += 1
        if incr:
            # Re-arm the byte-integrity guard for the repair turn itself —
            # for ANY incremental turn entering repair, not only one that
            # already violated: an in-scope turn with an unclean ledger gets a
            # coverage/lint repair turn too, and THAT turn could drift out of
            # scope just as easily. Judged against the ORIGINAL baseline (the
            # repair restores toward it).
            #
            # …but widened by exactly the pages the LEDGER repair targets:
            # the repair prompt orders edits on dangling-citing / lint-violation
            # pages that the round's changeset never authorized, and without
            # this the closing restore reverts the repair itself (live 07-09:
            # 4 charset fixes + 1 orphan deletion, all undone → unconverged).
            incr = dict(incr)
            try:
                incr["repair_pages"] = selfcheck.ledger_repair_pages(workdir, report)
            except Exception:
                incr["repair_pages"] = []  # fail-open: worst case = old strictness
            run._incr_pending = incr
        parts = []
        if not ledger_clean:
            parts.append(selfcheck.build_repair_prompt(report, locale))
        if incr_violations:
            parts.append(incremental.build_integrity_repair(incr_violations, locale=locale))
        return "\n\n".join(parts)
    return None


async def _emit_message(run: CompileRun, msg) -> None:
    """Relay one Agent SDK message to the SSE stream. Assistant text becomes the
    live chat (`log`) stream AND is accumulated for the turn; a ResultMessage
    marks the turn's end, flushing the accumulated text into `turn_done.text` so
    the consumer can persist the whole assistant reply (and the UI knows it's idle)."""
    name = type(msg).__name__
    if name == "AssistantMessage":
        for block in getattr(msg, "content", []) or []:
            if type(block).__name__ == "TextBlock":
                t = (getattr(block, "text", "") or "").strip()
                if t:
                    run._turn_text.append(t)
                    await run.emit({"type": "log", "text": t})
    elif name == "ResultMessage":
        reply = "\n\n".join(run._turn_text).strip()
        run._turn_text = []
        if getattr(run, "_suppress_turn_done", False):
            # Batch mode: this session's turn is an INTERNAL step of one logical
            # turn. Park the reply, keep the durability sync, skip selfcheck
            # (the final full-corpus pass owns it) and skip turn_done.
            run._last_turn_reply = reply
            sent = getattr(run, "_sync_sent", None)
            if sent is not None:
                try:
                    await _sync_workspace(run, sent)
                except Exception:
                    pass
            return
        # Layer-1 self-check BEFORE the sync so SELFCHECK.json rides the same
        # pre-turn_done sync. Fail-open: a self-check crash must not kill the
        # turn (§4.5) — surface it as a summary line instead of dying silently.
        repair_msg = None
        try:
            repair_msg = await _post_turn_selfcheck(run)
        except Exception as e:
            msg = (f"Self-check (ledger) failed, skipped this round: {e!r}"
                   if selfcheck._is_en(getattr(run, "locale", None))
                   else f"自检(账本)执行失败,本轮跳过: {e!r}")
            await run.emit({"type": "summary", "text": msg})
        # Sync BEFORE announcing the turn: consumers refetch the workspace on
        # turn_done, so files this turn produced (PROPOSED_PLAN.json, ticket
        # receipts, candidate pages) must already be durable. The periodic tick
        # alone can land seconds later and lose that race.
        sent = getattr(run, "_sync_sent", None)
        if sent is not None:
            if getattr(run, "_full_compile_pending", False) and repair_msg is None:
                # Provenance commit is ordered in the same atomic consumer batch
                # as the final content. Unlike ordinary sync, it fails closed:
                # announcing turn_done before this is durable would lie about the
                # input the draft was compiled from.
                await _sync_workspace(run, sent, commit_input=True)
                run._full_compile_pending = False
            else:
                try:
                    await _sync_workspace(run, sent)
                except Exception:
                    pass  # periodic loop retries; a sync hiccup must not kill the turn
        await run.emit({"type": "turn_done", "text": reply})
        # Bounded auto-repair AFTER turn_done (async-post-check design, §4.3-c):
        # the turn ends normally; the repair is an ordinary next turn. When no
        # repair is due, a settled draft may instead owe its one-shot image
        # numeric re-verification (same seam, same never-stuck shape).
        if repair_msg:
            # A ledger repair is a revision-in-progress: mark it so the frontend
            # keeps "生成与完善进行中" (converge not done) through the repair turn.
            await _set_converge_phase(run, "revising")
            try:
                await run.inject_user_message(repair_msg)
            except Exception as e:
                # The repair turn never started — a re-armed guard left behind
                # would judge the next unrelated turn against this round's
                # snapshot and restore over the owner's edits (review finding).
                run._incr_pending = None
                run._full_compile_pending = False
                msg = (f"Self-check repair injection failed: {e!r}"
                       if selfcheck._is_en(getattr(run, "locale", None))
                       else f"自检回修注入失败: {e!r}")
                await run.emit({"type": "summary", "text": msg})
        else:
            # Seam order: ledger repairs → blind image verify → red-blue PK.
            # Only a draft the cheaper layers are done with gets examined. When
            # NOTHING is pending (verify disabled, or all layers already clean on
            # this exact draft), the draft is stable → settled. This makes
            # converge_phase authoritative for BOTH verify-on and verify-off, so the
            # frontend gates the test step on `settled` with no config lookup.
            started = _maybe_start_media_verify(run) or _maybe_start_pk(run)
            if not started:
                await _set_converge_phase(run, "settled")


# Default tool whitelist for a kb-compile session, used when the runtime profile
# declares no allowed_tools (profile.allowedTools = null → box default). A profile
# that DOES declare a list (e.g. kb-test) overrides this.
DEFAULT_COMPILE_ALLOWED_TOOLS = [
    "Read", "Write", "Edit", "Glob", "Grep",
    "mcp__compile__report_summary",
    "mcp__compile__propose_plan",
    "mcp__compile__resolve_ticket",
    "mcp__compile__propose_questions",
]


def _compile_model() -> str:
    """Resolve the model shared by every compiler-owned SDK session."""
    return (os.environ.get("KBC_COMPILE_MODEL")
            or os.environ.get("ANTHROPIC_MODEL")
            or "claude-opus-4-6")


def _compile_session_opts(run: "CompileRun", wd: str, system_prompt: str, session_id: str) -> "ClaudeAgentOptions":
    """One options builder for the persistent session AND every batch session —
    identical role/tools/model so a batch page is written under exactly the same
    conventions as a single-session page."""
    return ClaudeAgentOptions(
        cwd=wd,
        # Keep the Claude Code preset (agentic tool conventions) and append the
        # KB authoring role on top, rather than replacing it.
        system_prompt={"type": "preset", "preset": "claude_code", "append": system_prompt},
        allowed_tools=run.allowed_tools or DEFAULT_COMPILE_ALLOWED_TOOLS,
        mcp_servers={"compile": _make_compile_tools(run)},
        permission_mode="bypassPermissions",  # the pod itself is the sandbox
        setting_sources=[],                    # tenant isolation: load no external settings/CLAUDE.md
        # Pin the compile model explicitly: the box talks to massapi (Bedrock),
        # which serves specific ids — the SDK default may not be one, and the KB
        # compile default is opus by product decision. Overridable per-deploy.
        model=_compile_model(),
        max_turns=int(os.environ.get("KBC_MAX_TURNS", "150")),
        max_buffer_size=SDK_MAX_BUFFER_BYTES,
        session_id=session_id,
        session_store=InMemorySessionStore(),
        hooks={"PreToolUse": [HookMatcher(hooks=[_make_compile_path_guard(Path(wd), run.locale)])]},
        # Stream partial deltas so the stall watchdog sees fine-grained model
        # liveness: a live-but-slow generation keeps emitting StreamEvents (idle
        # clock stays fresh), while a black-holed request emits nothing at all.
        # _emit_message ignores StreamEvent by name, so the log/turn stream and
        # the batch driver's ResultMessage detection are unchanged.
        include_partial_messages=True,
    )


def _compile_system_prompt(run: "CompileRun") -> str:
    playbook = _playbook_text(run.locale)
    instruction = (run.instruction or "").strip()
    role_parts = []
    if playbook:
        role_parts.append(playbook)
    role_parts.append(_prompt("box_role", run.locale))
    if instruction:
        header = _INSTRUCTION_HEADER.get((run.locale or DEFAULT_LOCALE).lower(), _INSTRUCTION_HEADER[DEFAULT_LOCALE])
        role_parts.append(header + "\n\n" + instruction)
    return "\n\n---\n\n".join(role_parts)


# ── batch mode (DESIGN-kb-batch-compile-2026-07-05) ──────────────────────────
# Large corpora never fit one session (autocompact is off — massapi rejects the
# context_management field), so the box splits the compile into code-budgeted
# batches, each a FRESH session over the same workspace. State handoff is the
# workspace itself (exact files, code-verifiable), never a prose summary. Small
# KBs stay on the untouched single-session path (threshold gate).

# Machine-canonical only: these exact strings are what UI buttons send (quick
# start / plan approve / the 07-06 resume button, whose directive prefix-matches
# "直接开始编译"). Natural-language phrasings deliberately do NOT trigger — a human
# saying "继续编译前我想先改个要求" must not launch the train.
_BATCH_TRIGGER_PREFIXES = ("直接开始编译", "批准,按此计划执行")
_INCREMENTAL_TRIGGER_PREFIXES = ("原料已更新,请增量重编", "请增量重编")


def _is_compile_trigger(text: str) -> bool:
    """Rolling-upgrade adapter for legacy message-based controls only."""
    return text.startswith(_BATCH_TRIGGER_PREFIXES + _INCREMENTAL_TRIGGER_PREFIXES)


def _batch_mode_enabled() -> bool:
    return os.environ.get("KBC_BATCH_MODE", "on") != "off"


def _should_route_to_incremental(run: "CompileRun", text: str, action: str | None = None) -> bool:
    """A compile trigger + a machine-computed changeset from the consumer
    (authoring/RAW_CHANGES.json with real changes) → the SCOPED incremental path,
    which re-touches only the affected pages instead of re-planning the whole
    corpus. No changeset (or empty) → fall through to the normal full compile /
    batch route (backward compatible: the consumer not yet wired = old behavior)."""
    if run._batch_active:
        return False
    if action is not None and action != "compile.incremental":
        return False
    if action is None and not _is_compile_trigger(text):
        return False
    return incremental.has_changes(incremental.load_raw_changes(run.workdir))


def _should_route_to_batch(run: "CompileRun", text: str, action: str | None = None) -> bool:
    full_compile = action in _FULL_COMPILE_ACTIONS if action is not None else _is_compile_trigger(text)
    if not _batch_mode_enabled() or run._batch_active or not full_compile:
        return False
    raw_dir = Path(run.workdir) / "raw"
    inventory = batching.scan_sources(raw_dir)
    if batching.should_batch(inventory):
        return True
    # An interrupted batch run must finish as a batch run even if raw shrank.
    plan = _load_batch_plan(run)
    return plan is not None and len(batching.pending_batches(plan)) > 0


async def _start_incremental(run: "CompileRun", text: str, *, strict: bool = False) -> None:
    """Scoped incremental kickoff: materialize the model-facing CHANGESET from
    the consumer's RAW_CHANGES, snapshot page hashes for the post-turn integrity guard,
    then inject the scoped directive. It is ONE ordinary model turn (not the batch
    orchestrator), so turn_done + the normal post-turn seam (coverage/charset +,
    once wired, the byte-integrity guard) apply unchanged."""
    cs = incremental.materialize_changeset(run.workdir)
    if cs is None:
        if strict:
            raise CommandRejected("structured source changes disappeared before dispatch; retry", 409)
        # Race / empty after the route check → fall back to a normal turn.
        # This fallback bypasses the full-kickoff unlink in the message handler,
        # so clear any stale CHANGESET here too (review): the turn is NOT
        # incremental and the model must not self-restrict to an old scope.
        (Path(run.workdir) / incremental.CHANGESET_PATH).unlink(missing_ok=True)
        run._full_compile_pending = True
        run._begin_turn(text)
        try:
            await run.client.query(text)
        except BaseException:
            run._full_compile_pending = False
            raise
        return
    # ADDED_TARGETS is a PER-ROUND declaration (pages the model merges added
    # sources into). Nothing box-side cleared it, so declarations from earlier
    # rounds stayed authorized forever and eroded the byte-freeze guarantee
    # round over round (review finding). A new round starts blank.
    (Path(run.workdir) / incremental.ADDED_TARGETS_PATH).unlink(missing_ok=True)
    run._incr_pending = {
        "before": incremental.page_hashes(run.workdir),
        # bytes ride along for the closing guard's MECHANICAL restore — the model
        # cannot rebuild a byte-exact page from a hash, so asking it to burned
        # the whole repair budget and always landed unconverged (3/3 live 07-09).
        "before_bytes": incremental.page_bytes(run.workdir),
        # Existing format debt on untouched pages is migration work, not a
        # license for an ordinary incremental repair turn to edit the whole KB.
        # New/editable pages remain strictly enforced at the closing gate.
        "baseline_format_violations": selfcheck.format_violation_keys(
            selfcheck.candidate_pages(run.workdir)),
        "changeset": cs,
    }
    await run.emit({"type": "summary",
                    "text": _loc(run,
                     f"Incremental recompile: {len(cs['affected_pages'])} page(s) affected — touching only those, everything else stays untouched.",
                     f"增量重编:{len(cs['affected_pages'])} 页受影响,只改这些,其余不动。")})
    directive = incremental.build_scoped_directive(cs, locale=getattr(run, "locale", None))
    run._begin_turn(directive)  # arm the stall watchdog — same as every other kickoff
    try:
        await run.client.query(directive)
    except BaseException:
        # A turn that never started must not leave a stale arm: the next
        # UNRELATED turn would be judged against this round's snapshot and the
        # mechanical restore would silently revert the owner's edits (review
        # finding). The snapshot must precede query (edits begin right after
        # send), so clear-on-failure is the correct half of arm/dispatch.
        run._incr_pending = None
        raise


def _batch_plan_path(run: "CompileRun") -> Path:
    return Path(run.workdir) / batching.BATCH_PLAN_PATH


def _load_batch_plan(run: "CompileRun") -> dict | None:
    p = _batch_plan_path(run)
    if not p.is_file():
        return None
    try:
        plan = json.loads(p.read_text())
        return plan if isinstance(plan, dict) and isinstance(plan.get("batches"), list) else None
    except Exception:
        return None


def _write_batch_file(run: "CompileRun", rel: str, value) -> None:
    p = Path(run.workdir) / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(batching.dump_json(value))


async def _drive_batch_session(run: "CompileRun", directive: str, label: str) -> str:
    """One bounded internal session: fresh session_id, same role/tools/workspace.
    Streams its output through _emit_message with turn_done suppressed; returns
    the session's final reply text. run.client points at the live session so the
    park/ruling MCP tools and the inject seam keep working."""
    wd = str(Path(run.workdir).resolve())
    opts = _compile_session_opts(run, wd, _compile_system_prompt(run), str(uuid.uuid4()))
    client = ClaudeSDKClient(options=opts)
    prev_client = run.client
    run._suppress_turn_done = True
    run._last_turn_reply = ""
    try:
        await client.connect()
        run.client = client
        await run.emit({"type": "log", "text": _loc(run, f"—— {label} started ——", f"—— {label} 开始 ——")})
        run._begin_turn(directive)
        await client.query(directive)
        await _consume_turn_stream(run, client, stop_on_result=True)
        return run._last_turn_reply
    finally:
        run._suppress_turn_done = False
        run.client = prev_client
        try:
            await client.disconnect()
        except Exception:
            pass


def _drain_batch_notes(run: "CompileRun") -> str:
    if not run._batch_notes:
        return ""
    notes = "\n".join(f"- {n}" for n in run._batch_notes)
    run._batch_notes = []
    return _loc(run,
                f"\n\nThe owner added during the compile (take it into account; it affects the remaining batches):\n{notes}",
                f"\n\n负责人在编译过程中补充说(一并考虑,影响后续各批):\n{notes}")


def _compose_batch_directive(batch: dict, k: int, n: int, notes: str,
                             locale: str | None = None) -> str:
    listing = "\n".join(f"- raw/{p}" for p in batch["sources"])
    if selfcheck._is_en(locale):
        return (
            f"[Batch compile · batch {k}/{n} · {batch['id']}] Compile ONLY the sources below "
            f"(see the batching discipline in the system prompt):\n{listing}\n"
            "First read authoring/BRIEF.json, authoring/INTENT.md and candidate/index.md to stay consistent "
            "in voice and structure; then read every source in this batch closely and fold its content fully "
            "into candidate/ pages (create new pages or merge into existing ones; each page's frontmatter "
            "compiled_from must list the sources it was actually compiled from); update the matching "
            "candidate/index.md entries; contradictions as usual — best-guess + ⚠️ uncertain + file a ticket, "
            "never stop. Do not read ANY raw source outside this batch. When done, report briefly which pages "
            "this batch produced." + notes
        )
    return (
        f"【分批编译 · 批 {k}/{n} · {batch['id']}】只编译下列源(见系统提示的分批纪律):\n{listing}\n"
        "先读 authoring/BRIEF.json、authoring/INTENT.md 和 candidate/index.md 保持口径与结构一致;"
        "然后精读本批每个源,按定调把内容完整编入 candidate/ 页(可新建页或并入既有页,页 frontmatter 的 "
        "compiled_from 必须列出实际编自的源);更新 candidate/index.md 的相应条目;矛盾照常 best-guess+⚠️存疑+落工单,绝不停。"
        "本批之外的 raw 源一个都不要读。完成后简短汇报本批编了哪些页。" + notes
    )


def _dup_reason_en(reason: str) -> str:
    """Render selfcheck's stored dup reason (zh data token) for an English
    directive. The stored value stays zh — it is data, not display."""
    if reason == "标题相同":
        return "same title"
    m = re.match(r"共享 (\d+) 个来源", reason or "")
    return f"{m.group(1)} shared sources" if m else reason


def _compose_final_directive(workdir: str, n: int, notes: str,
                             locale: str | None = None) -> str:
    """Final-pass directive fed with DETERMINISTIC worklists (dup candidates,
    orphans, ⚠️ count) computed by code — the A/B showed a prose-only '合并明显
    重复的主题页' leaves double-height duplicates and orphans standing. Concrete
    pairs + a merge-or-exempt discipline make silence impossible."""
    pages = selfcheck.candidate_pages(workdir)
    dups = selfcheck.dup_candidates(pages)
    exclusions_, excl_errors = selfcheck.load_exclusions(workdir)
    orphans = [v["page"] for v in selfcheck.lint_candidate(pages, excl_errors)["violations"]
               if v["kind"] == "orphan"]
    suspect = sum((p.get("text") or "").count("⚠️") for p in pages.values())
    if selfcheck._is_en(locale):
        lines = [f"[Batch compile · final review] All {n} batches are compiled. Now do the cross-batch "
                 "close-out (the checklists below are machine-computed — handle every item, silent skipping "
                 "is not allowed):"]
        step = 1
        if dups:
            lines.append(f"{step}) Duplicate-page candidates ({len(dups)} pairs) — for each pair pick one: "
                         "merge into a single page (merge compiled_from, fix index links), or give a one-line "
                         "written exemption in your report (genuinely different topics):")
            lines += [f"   - {d['pages'][0]} ↔ {d['pages'][1]} ({_dup_reason_en(d['reason'])})" for d in dups]
            step += 1
        if orphans:
            lines.append(f"{step}) Orphan pages ({len(orphans)}, unreachable from index.md) — link them into "
                         "the index or their parent page; delete only if genuinely dead:")
            lines += [f"   - {p}" for p in orphans]
            step += 1
        lines.append(f"{step}) Read through candidate/index.md and the page titles; unify terminology and "
                     "structure; repair the index grouping and links;")
        step += 1
        lines.append(f"{step}) Cross-batch contradictions (the corpus currently carries {suspect} ⚠️ uncertain "
                     "marks): where the same fact is stated differently, first converge whatever the "
                     "constitution/voice can settle (e.g. prefer the newest in a time sequence and keep the "
                     "history), and only best-guess + ⚠️ + ticket what cannot be settled; also check whether "
                     "any EXISTING ⚠️ can now be converged;")
        step += 1
        lines.append(f"{step}) Check authoring/EXCLUSIONS.json: sources you decided not to compile (including "
                     "images/PDF and other media) must be explicitly accounted for.")
        lines.append("Close out only — do not recompile pages that are already fine. When done, report "
                     "briefly: total pages, which pages this close-out touched, which pairs were "
                     "merged/exempted and why, and anything worth the owner's attention.")
        return "\n".join(lines) + notes
    lines = [f"【分批编译 · 终审】全部 {n} 批已编完。现在做跨批收口(以下清单是系统机械算出的,逐项处理、不许沉默跳过):"]
    step = 1
    if dups:
        lines.append(f"{step}) 重复页候选({len(dups)} 对)——每对二选一:合并成一页(合并 compiled_from、修 index 链接),"
                     "或在汇报里给一句书面豁免理由(确属不同主题):")
        lines += [f"   - {d['pages'][0]} ↔ {d['pages'][1]}({d['reason']})" for d in dups]
        step += 1
    if orphans:
        lines.append(f"{step}) 孤儿页({len(orphans)} 个,从 index.md 无链可达)——挂进 index 或相应父页;确属废页则删除:")
        lines += [f"   - {p}" for p in orphans]
        step += 1
    lines.append(f"{step}) 通读 candidate/index.md 与各页标题,统一术语与结构,修补 index 的分组与链接;")
    step += 1
    lines.append(f"{step}) 跨批矛盾(全库现有 ⚠️ 存疑 {suspect} 处):同一事实说法不一的,先按宪法/口径能定的直接收敛改齐"
                 "(如时间序取最新并保留沿革),定不了的才 best-guess+⚠️存疑+落工单;顺带检查既有 ⚠️ 里有没有其实能收敛的;")
    step += 1
    lines.append(f"{step}) 核对 authoring/EXCLUSIONS.json:决定不编的源(含图片/PDF 等媒体)必须显式入账。")
    lines.append("只做收口,不重编已经完好的页。完成后简短汇报:总页数、本次收口动了哪些页、合并/豁免了哪几对及理由、还有什么值得负责人注意。")
    return "\n".join(lines) + notes


def _planner_role(locale: str | None) -> str:
    if selfcheck._is_en(locale):
        return (
            "You are the planner for a batched knowledge-base compile. authoring/SOURCES_INVENTORY.json in the "
            "workspace lists every raw source; each entry has path, bytes (raw size) and effective (a context-cost "
            "estimate: text = raw bytes; images/PDF are discounted to their real consumption, far below raw bytes). "
            "Group them into batches: same topic / same directory together where possible, and **each batch's total "
            "effective** must stay within the given budget — the budget constraint looks at effective ONLY, never "
            "pack by bytes (only a single file whose effective alone exceeds the budget gets its own batch). Use as "
            "few batches as possible: one image has a tiny effective, and a few images plus the documents citing "
            "them in the SAME batch gives better quality. Write the plan to authoring/BATCH_PLAN.json as "
            "{\"batches\":[{\"id\":\"b01\",\"sources\":[\"path relative to raw\"]}]}. Every source must appear in "
            "exactly one batch. Read only the inventory file, never the source contents. Finish as soon as it is "
            "written."
        )
    return (
        "你是知识库分批编译的规划员。工作区里 authoring/SOURCES_INVENTORY.json 列出了全部 raw 源,"
        "每项有 path、bytes(原始字节)和 effective(上下文成本估算:文本=原始字节,图片/PDF 已按真实消耗折算,远小于原始字节)。"
        "把它们分成若干批:同主题/同目录尽量同批,**每批的 effective 总量**不超过给定预算——预算约束只看 effective,绝不要用 bytes 装箱"
        "(单个 effective 超预算的文件才独占一批)。批数应尽量少:一张图片 effective 很小,几张图和引用它们的文档放同一批反而质量更好。"
        "把方案写入 authoring/BATCH_PLAN.json,格式 {\"batches\":[{\"id\":\"b01\",\"sources\":[\"相对raw的路径\"]}]}。"
        "每个源必须恰好出现在一个批里。只读清单文件,不要读源文件内容。写完即结束。"
    )


async def _plan_batches(run: "CompileRun", inventory: list) -> dict:
    """Code baseline always exists; the model may regroup topically but ONLY a
    plan that passes deterministic validation replaces the baseline."""
    budget = batching.batch_budget_bytes()
    baseline = batching.build_plan(inventory, batching.pack_batches(inventory), planner="code")
    if os.environ.get("KBC_BATCH_PLANNER", "model") == "code":
        return baseline
    try:
        wd = str(Path(run.workdir).resolve())
        opts = ClaudeAgentOptions(
            cwd=wd,
            system_prompt={"type": "preset", "preset": "claude_code", "append": _planner_role(getattr(run, "locale", None))},
            allowed_tools=["Read", "Write", "Glob"],
            permission_mode="bypassPermissions",
            hooks={"PreToolUse": [HookMatcher(hooks=[_make_compile_path_guard(Path(wd), run.locale)])]},
            setting_sources=[],
            model=_compile_model(),
            max_turns=8,
            max_buffer_size=SDK_MAX_BUFFER_BYTES,
            session_id=str(uuid.uuid4()),
            session_store=InMemorySessionStore(),
        )
        client = ClaudeSDKClient(options=opts)
        prev = run.client
        run._suppress_turn_done = True
        try:
            await client.connect()
            run.client = client
            directive = _loc(
                run,
                f"Budget: each batch's total effective must not exceed {budget} (pack by the effective field only, ignore bytes). "
                "Read authoring/SOURCES_INVENTORY.json, write authoring/BATCH_PLAN.json.",
                f"预算:每批 effective 总量不超过 {budget}(只按 effective 字段装箱,不看 bytes)。"
                "读 authoring/SOURCES_INVENTORY.json,写 authoring/BATCH_PLAN.json。")
            run._begin_turn(directive)  # planner is a model call too — arm the stall watchdog
            await client.query(directive)
            await _consume_turn_stream(run, client, stop_on_result=True)
        finally:
            run._suppress_turn_done = False
            run.client = prev
            try:
                await client.disconnect()
            except Exception:
                pass
        proposed = batching.normalize_model_plan(_load_batch_plan(run))
        if proposed:
            errors = batching.validate_plan(proposed, inventory)
            if not errors and batching.plan_too_fragmented(proposed["batches"], baseline["batches"]):
                await run.emit({
                    "type": "log",
                    "text": _loc(run,
                                 f"Planner proposal too fragmented ({len(proposed['batches'])} batches vs baseline {len(baseline['batches'])}), falling back to the code baseline.",
                                 f"规划方案过碎({len(proposed['batches'])} 批 vs 基线 {len(baseline['batches'])} 批),改用代码基线分批。"),
                })
            elif not errors:
                return batching.build_plan(inventory, proposed["batches"], planner="model")
            else:
                await run.emit({"type": "log", "text": _loc(run,
                    "Planner proposal failed validation, falling back to the code baseline: ",
                    "规划方案未过校验,改用代码基线分批:") + "; ".join(errors[:3])})
    except Exception as e:
        await run.emit({"type": "log", "text": _loc(run,
            f"Planner session failed, falling back to the code baseline: {e!r}",
            f"规划会话失败,改用代码基线分批: {e!r}")})
    return baseline


async def _run_ledger_repairs(run: "CompileRun", replies: list[str]) -> None:
    """Force a fresh full-corpus selfcheck and drive bounded repair sessions
    until it stops asking (budget lives in _post_turn_selfcheck)."""
    run._selfcheck_key = None
    # Fresh episode, fresh budget (review): the counter only resets on a CLEAN
    # check, so a batch ledger phase entered after earlier turns spent the
    # persistent budget would file a residual ticket with ZERO repair attempts
    # for this phase's own findings. Each _run_ledger_repairs call is bounded
    # by its own budget; the batch tail calls it a bounded number of times.
    run._l1_repairs_used = 0
    run._ledger_forced = True  # batch-final: the mid-Execute index exemption is off
    try:
        repair = await _post_turn_selfcheck(run)
        while repair:
            fix_reply = await _drive_batch_session(run, repair, _loc(run, "ledger repair", "账本回修"))
            if fix_reply:
                replies.append(_loc(run, f"[Repair] {fix_reply}", f"【回修】{fix_reply}"))
            repair = await _post_turn_selfcheck(run)
    finally:
        run._ledger_forced = False


async def _run_batch_compile(run: "CompileRun", trigger_text: str):
    """The batch orchestrator: ONE logical turn to the consumer (single turn_done at
    the end), many bounded sessions inside. Crash-resumable at batch granularity:
    BATCH_PLAN.json carries per-batch done stamps, and any later compile trigger
    re-enters here and continues from the first pending batch."""
    run._batch_active = True
    replies: list[str] = []
    try:
        raw_dir = Path(run.workdir) / "raw"
        inventory = batching.scan_sources(raw_dir)
        total_kb = batching.corpus_bytes(inventory) // 1024
        plan = _load_batch_plan(run)
        resuming = plan is not None and len(batching.pending_batches(plan)) > 0
        if not resuming:
            _write_batch_file(run, batching.SOURCES_INVENTORY_PATH, inventory)
            await run.emit({"type": "summary", "text": _loc(run,
                f"Corpus {total_kb}KB exceeds the single-session threshold — batch compile engaged.",
                f"语料 {total_kb}KB 超过单会话阈值,启用分批编译。")})
            plan = await _plan_batches(run, inventory)
            _write_batch_file(run, batching.BATCH_PLAN_PATH, plan)
        else:
            # The pinned plan predates this run; a source deleted from raw/ in
            # between would leave a batch directive pointing at a missing file.
            # (Added sources are caught later by the coverage ledger.)
            dropped = batching.prune_missing_sources(plan, {i["path"] for i in inventory})
            if dropped:
                _write_batch_file(run, batching.BATCH_PLAN_PATH, plan)
                await run.emit({"type": "summary",
                                "text": _loc(run,
                                             f"Batch resume: {len(dropped)} source(s) no longer in raw/ — removed from pending batches: ",
                                             f"断点续批:{len(dropped)} 个源已不在 raw/ 中,已从待编批次剔除:")
                                        + ", ".join(sorted(dropped)[:5])
                                        + ("…" if len(dropped) > 5 else "")})
        n = len(plan["batches"])
        pending = batching.pending_batches(plan)
        await run.emit({
            "type": "summary",
            "text": (_loc(run, f"Resuming batch compile: {len(pending)}/{n} batch(es) remaining.",
                          f"继续分批编译:剩余 {len(pending)}/{n} 批。") if resuming
                     else _loc(run,
                               f"Batch plan ({plan.get('planner')}): {n} batch(es), budget {plan.get('budget', 0) // 1024}KB/batch.",
                               f"分批计划({plan.get('planner')}):共 {n} 批,预算 {plan.get('budget', 0) // 1024}KB/批。")),
        })
        for batch in list(pending):
            k = next(i + 1 for i, b in enumerate(plan["batches"]) if b["id"] == batch["id"])
            directive = _compose_batch_directive(batch, k, n, _drain_batch_notes(run), locale=getattr(run, "locale", None))
            reply = await _drive_batch_session(run, directive, _loc(run, f"batch {k}/{n}", f"批 {k}/{n}"))
            if reply:
                replies.append(_loc(run, f"[Batch {k}/{n}] {reply}", f"【批 {k}/{n}】{reply}"))
            batching.stamp_done(plan, batch["id"])
            _write_batch_file(run, batching.BATCH_PLAN_PATH, plan)
            # Push the done-stamp (and the batch's pages) to the durable store
            # NOW: if it only rode the next periodic sync, a crash in that window
            # would re-run an already-done batch on resume.
            sent = getattr(run, "_sync_sent", None)
            if sent is not None:
                try:
                    await _sync_workspace(run, sent)
                except Exception:
                    pass  # periodic sync will retry; the local stamp is already on disk
            await run.emit({"type": "summary", "text": _loc(run,
                f"Batch {k}/{n} done — landed in the store.", f"批 {k}/{n} 完成,已落库。")})
        final_reply = await _drive_batch_session(
            run, _compose_final_directive(run.workdir, n, _drain_batch_notes(run), locale=getattr(run, "locale", None)),
            _loc(run, "final review", "终审"))
        if final_reply:
            replies.append(_loc(run, f"[Final review] {final_reply}", f"【终审】{final_reply}"))
        # Full-corpus selfcheck + bounded repair rounds, each a fresh bounded
        # session (the batch analogue of the ordinary post-turn repair loop).
        await _run_ledger_repairs(run, replies)
        # Image numeric re-verification AFTER the ledger settles (repairs may
        # add image-digesting pages), then one more ledger refresh so
        # SELFCHECK.json reflects the verified final state.
        if _media_verify_enabled():
            repaired_any = False
            rounds = 0
            while True:
                pending = selfcheck.pending_media_verification(run.workdir)
                if not pending:
                    break
                rounds += 1
                if rounds > _media_verify_rounds():
                    # Repair turns can add new image citations that re-enter
                    # pending — cap the loop; the remainder rides a later turn.
                    await run.emit({"type": "summary", "text": _loc(run,
                        f"Self-check (images): verify/repair round cap ({_media_verify_rounds()}) reached — remaining pages will be picked up on the next trigger.",
                        f"自检(图像):验修轮达到上限({_media_verify_rounds()} 轮)——剩余页将在下一轮触发时继续复核。")})
                    break
                # Blind transcribe+compare per ≤max-images chunk (v2): engine
                # sessions read one image each — no in-session image pileup.
                chunk = selfcheck.cap_media_pending(pending, _media_verify_max_images())
                try:
                    result = await mediaverify.run_blind_verify(
                        ClaudeEngine(), run.workdir, chunk,
                        progress=lambda s: asyncio.get_running_loop().create_task(
                            run.emit({"type": "summary", "text": s})),
                        locale=getattr(run, "locale", None))
                except Exception as e:
                    await run.emit({"type": "summary", "text": _loc(run,
                        f"Self-check (images) failed, skipping this chunk: {e!r}",
                        f"自检(图像)执行失败,跳过本组: {e!r}")})
                    await _emit_media_exhausted(run, _settle_media_outcome(run, chunk, None))
                    continue
                await _emit_media_exhausted(run, _settle_media_outcome(run, chunk, result))
                if result["errors"]:
                    await run.emit({"type": "summary",
                                    "text": _loc(run,
                                 f"Self-check (images): {len(result['errors'])} transcription/comparison failure(s) (see logs); the rest proceed as usual.",
                                 f"自检(图像):{len(result['errors'])} 项转写/比对失败(见日志),其余照常。")})
                if result["findings"]:
                    verify_reply = await _drive_batch_session(
                        run, mediaverify.build_repair_prompt(result["findings"], locale=getattr(run, "locale", None)),
                        _loc(run, "image verification", "图像复核"))
                    if verify_reply:
                        replies.append(_loc(run, f"[Image verification] {verify_reply}", f"【图像复核】{verify_reply}"))
                    repaired_any = True
                else:
                    await run.emit({"type": "summary",
                                    "text": f"自检(图像):{result['images']} 张图已核,断言与图一致 ✓"})
            if repaired_any:
                await _run_ledger_repairs(run, replies)
        # Owner notes that arrived during the tail phases (ledger repair / image
        # verify) were acked as "will be considered" but have no later batch to
        # ride — honor the contract with a bounded digest session before the
        # turn closes. Two passes: a note can land while the first one runs.
        for _ in range(2):
            tail_notes = _drain_batch_notes(run)
            if not tail_notes:
                break
            notes_reply = await _drive_batch_session(
                run,
                _loc(run,
                     "The owner left the following notes during the compile's tail phase. Assess whether the "
                     "draft needs adjusting (make the edits and summarize briefly if so; otherwise explain why "
                     "not):\n",
                     "负责人在编译收尾期间的补充留言如下,请评估是否需要据此调整草稿"
                     "(需要就改并简述,不需要就说明理由):\n") + tail_notes,
                _loc(run, "note digest", "留言消化"))
            if notes_reply:
                replies.append(_loc(run, f"[Note digest] {notes_reply}", f"【留言消化】{notes_reply}"))
            await _run_ledger_repairs(run, replies)  # the digest may have touched pages
        sent = getattr(run, "_sync_sent", None)
        if sent is not None:
            # Successful batch completion is one full-compile provenance commit.
            # Content and input revision must land atomically before turn_done.
            await _sync_workspace(run, sent, commit_input=True)
        await run.emit({"type": "turn_done", "text": "\n\n".join(replies).strip()
                        or _loc(run, "Batch compile complete.", "分批编译完成。")})
    except Exception as e:
        await run.emit({"type": "error", "error": f"batch compile failed: {e!r}"})
        # never-block: the single logical turn must still CLOSE — a consumer
        # gating on turn_done would otherwise hang on an orchestrator error.
        # Done batches are stamped in BATCH_PLAN.json, so the honest story is
        # "interrupted, resumable from the first pending batch".
        try:
            await run.emit({"type": "turn_done",
                            "text": _loc(run,
                                         "Batch compile interrupted: finished batches are stored; trigger a compile again to resume from the first pending batch.",
                                         "分批编译中断:已完成的批已落库,再次发起编译将从断点继续。")})
        except Exception:
            pass
    finally:
        run._batch_active = False
    # Red-blue PK examines the train's FINAL state, in the background, after the
    # single logical turn has closed (never inside it — turn_done latency is
    # user-visible; the PK verdict is not urgent). _pk_due re-checks the settled
    # gates itself, so a failed train simply doesn't qualify. Nothing pending →
    # the draft is stable (settled), same authoritative signal as the seam.
    if not _maybe_start_pk(run):
        await _set_converge_phase(run, "settled")


def _note_model_activity(run: CompileRun, msg) -> None:
    """Every inbound SDK message (StreamEvent delta, assistant/user turn, result)
    proves the model link is alive → reset the idle clock. An assistant message
    that asks for a tool flips tool_pending so the watchdog uses the longer bound
    while the CLI runs Read/Bash (that gap is not a model stall).

    Partial StreamEvents are transport liveness only.  The Agent SDK emits
    assistant-tail events (content_block_stop/message_delta/message_stop) after
    a ToolUseBlock and before the UserMessage containing the tool result; those
    events must not clear tool_pending or a legitimate long-running tool is
    measured against the much shorter model-idle bound.
    """
    run._last_model_activity = time.monotonic()
    message_type = type(msg).__name__
    run._last_sdk_message_type = message_type
    if message_type == "AssistantMessage":
        blocks = getattr(msg, "content", None) or []
        run._tool_pending = any(type(b).__name__ == "ToolUseBlock" for b in blocks)
    elif message_type in ("UserMessage", "ResultMessage"):
        run._tool_pending = False


async def _consume_turn_stream(run: CompileRun, client, *, stop_on_result: bool) -> None:
    """Relay a session's message stream through _emit_message, owning the
    stall-retry seam. A ResultMessage that the watchdog provoked (via interrupt())
    is NOT a real turn end: discard it and re-issue the directive (bounded), or
    raise ModelStallError when retries are spent. A REAL ResultMessage ends the
    turn — cleared BEFORE _emit_message, which may inject a follow-up turn that
    re-arms the watchdog. stop_on_result mirrors the batch driver's break."""
    async for msg in client.receive_messages():
        _note_model_activity(run, msg)
        if type(msg).__name__ == "ResultMessage":
            if run._stall_retrying:
                run._turn_text = []           # the wedged attempt produced nothing usable
                run._stall_retrying = False
                if run._stall_fatal:
                    run._turn_active = False
                    raise ModelStallError(
                        f"model request stalled; exhausted {run._model_retries} attempt(s)"
                    )
                run._last_model_activity = time.monotonic()
                run._last_sdk_message_type = "query"
                await client.query(run._last_directive)   # retry on a fresh request
                continue
            # C2: a rate-limited / overloaded model call ends the turn with
            # is_error + api_error_status. Back off and re-issue rather than
            # surfacing it as a finished turn.
            status = getattr(msg, "api_error_status", None)
            if getattr(msg, "is_error", False) and status in _MODEL_RATE_STATUSES:
                if run._rate_retries < _MODEL_RATE_MAX_RETRIES:
                    run._rate_retries += 1
                    delay = _rate_backoff_delay(run._rate_retries)
                    run._turn_text = []
                    await run.emit({
                        "type": "rate_limited",
                        "status": status,
                        "attempt": run._rate_retries,
                        "backoff_s": round(delay, 1),
                    })
                    run._last_model_activity = time.monotonic()  # backoff isn't a stall
                    await asyncio.sleep(delay)
                    run._last_model_activity = time.monotonic()
                    run._last_sdk_message_type = "query"
                    await client.query(run._last_directive)
                    continue
                await run.emit({
                    "type": "summary",
                    "text": _loc(run,
                                 f"Model rate-limited (HTTP {status}); {run._rate_retries} backoff retries did not clear it — stopping this turn, please retry later.",
                                 f"模型限流(HTTP {status}),退避重试 {run._rate_retries} 次仍未通过,本轮先停,请稍后再开编。"),
                })
                # fall through: end the turn (run goes idle), do not crash
            run._turn_active = False
            await _emit_message(run, msg)
            if stop_on_result:
                return
            continue
        await _emit_message(run, msg)


_STALL_INTERRUPT_DEADLINE_S = int(os.environ.get("KBC_STALL_INTERRUPT_DEADLINE_S", "120"))


async def _model_stall_watchdog(run: CompileRun) -> None:
    """Reap a turn wedged on a black-holed model request. Interrupt the attempt;
    _consume_turn_stream then re-issues it (or fails). Only judges an ACTIVE turn,
    and relaxes to the tool bound while a tool is pending — never false-kills a
    live turn or a long tool (I4)."""
    while not run.done:
        await asyncio.sleep(_MODEL_WATCHDOG_POLL_S)
        if not run._turn_active:
            continue
        if run._stall_retrying:
            # Interrupted, waiting for the interrupted result. A true black-hole
            # can swallow interrupt() too — then the latch stays set and the
            # receive loop blocks forever. Bound the wait; past the deadline,
            # close the turn honestly and disconnect to unblock the loop.
            if time.monotonic() - run._stall_interrupted_at > _STALL_INTERRUPT_DEADLINE_S:
                run._stall_retrying = False
                run._turn_active = False
                await run.emit({"type": "error",
                                "error": f"model stall: interrupt produced nothing within {_STALL_INTERRUPT_DEADLINE_S}s"})
                # Disconnecting ENDS this box's session (run_session has no
                # reconnect loop — deliberately: this fires only on a double
                # black-hole, and recovery is owned by the platform: the run
                # terminalizes via `end`, and the consumer's next message
                # find-or-starts a fresh run/box with workspace rehydration).
                # The turn_done text must promise exactly that — not an
                # in-place retry this box can no longer serve (/message would
                # 409 on run.client=None).
                await run.emit({"type": "turn_done", "text": _loc(run,
                    "The turn stalled and could not be recovered — nothing was applied. "
                    "The compile session will be recreated automatically on your next message.",
                    "本轮模型停滞且中断无响应——未产生结果;编译会话将在你下一条消息时自动重建,届时重发即可。")})
                try:
                    await client.disconnect()
                except Exception:
                    pass
            continue
        client = run.client
        if client is None:
            continue
        bound = _MODEL_TOOL_IDLE_TIMEOUT_S if run._tool_pending else _MODEL_IDLE_TIMEOUT_S
        idle = time.monotonic() - run._last_model_activity
        if idle <= bound:
            continue
        run._stall_fatal = run._model_retries >= _MODEL_MAX_RETRIES
        run._model_retries += 1
        run._stall_retrying = True
        run._stall_interrupted_at = time.monotonic()
        run._last_model_activity = time.monotonic()   # bridge the interrupt→result gap
        diagnostic = {
            "code": "model_turn_stalled",
            "stage": "model_turn",
            "attempts": run._model_retries,
            "fatal": run._stall_fatal,
            "idle_s": round(idle, 1),
            "bound_s": round(bound, 1),
            "tool_pending": run._tool_pending,
            # Controlled SDK class/query marker only. Never include message or
            # tool content in diagnostic events or the persisted checkpoint.
            "last_sdk_message": run._last_sdk_message_type,
        }
        run._last_stall_diagnostic = diagnostic
        await run.emit({"type": "turn_stalled", "attempt": run._model_retries, **diagnostic})
        try:
            await client.interrupt()
        except Exception as e:
            # No interrupted-result will come → don't leave the loop waiting on it.
            run._stall_retrying = False
            await run.emit({"type": "summary", "text": _loc(run,
                f"Model stall: interrupt failed, will retry next round {e!r}",
                f"模型停滞:中断失败,下一轮重试 {e!r}")})


async def run_session(run: CompileRun):
    """Persistent driver: host ONE long-lived Claude Code session (ClaudeSDKClient)
    for this KB. BOX_ROLE (+ the playbook + the attempt instruction) is the standing
    system prompt; the session then takes turns via POST /message — continuous
    prepare + compile in one session, on massapi, with the compile tools.
    Conversational by construction: connect, then wait for the first /message.
    (Durable cross-restart resume + a file-backed session store land in P4; v1
    uses an in-process store.)"""
    wd = str(Path(run.workdir).resolve())
    system_prompt = _compile_system_prompt(run)

    sid = run.session_id or str(uuid.uuid4())
    run.session_id = sid
    opts = _compile_session_opts(run, wd, system_prompt, sid)
    client = ClaudeSDKClient(options=opts)
    try:
        # Connect and block for the first /message. Set run.client + signal
        # run.connected only AFTER connect() returns, so a /message that races ahead
        # of connect waits (handle_message) instead of hitting the SDK's
        # "Not connected. Call connect() first." error.
        await client.connect()
        run.client = client
        run.connected.set()
        await run.emit({"type": "session", "session_id": sid})
        # receive_messages() is the persistent stream: it yields this turn's
        # output, then blocks for the next turn (injected via POST /message),
        # keeping the session alive until the box is stopped/cancelled.
        # A compile turn ends like any other turn: one query → one ResultMessage.
        # The candidate pages it wrote to candidate/ are synced and become the
        # current draft; the owner reviews and publishes separately (deterministic
        # publish, no submit gate). A finished turn is simply finished — no
        # nudging — so a live session can never get stuck "compiling".
        await _consume_turn_stream(run, client, stop_on_result=False)
    finally:
        run.connected.set()  # unblock any /message waiters even if connect failed
        run.client = None
        await client.disconnect()


async def _run_wrapper(run: CompileRun):
    """Unified lifecycle: run the driver + periodically sync mid-flight state →
    catch-all error → always finish with end. A CLEAN driver exit (max_turns
    exhaustion, subprocess EOF) additionally emits an explicit `done` before
    `end`: the session can never take another turn, and a bare `end` left the
    runtime guessing — the run lingered idle, 409'd every /message, and was
    eventually mislabeled by the idle watchdog. Cancellation (CancelledError)
    bypasses both the except and the `clean` flag, so a cancelled run still
    closes with just `end`."""
    # The consumer just rehydrated these files into a fresh box. Prime the diff
    # cursor from that installed state so the first periodic tick cannot echo an
    # unchanged candidate/index.md and impersonate a completed compile.
    sent: dict = _workspace_sync_cursor(run.workdir)
    clean = False
    run._sync_sent = sent  # shared with _emit_message's pre-turn_done sync
    syncer = asyncio.create_task(_sync_loop(run, sent))
    watchdog = asyncio.create_task(_model_stall_watchdog(run))
    try:
        await _COMPILE_IMPL(run)
        clean = True
    except Exception as e:  # top-level boundary: surface crashes as an error event, never swallow
        error_event = {"type": "error", "error": repr(e)}
        if isinstance(e, ModelStallError) and run._last_stall_diagnostic:
            # Structured, content-free diagnostics survive the Runtime→consumer
            # opaque checkpoint.  Keep the human error for rolling consumers,
            # but make automation independent of parsing it.
            error_event.update({
                key: value
                for key, value in run._last_stall_diagnostic.items()
                if key != "fatal"
            })
        await run.emit(error_event)
        if getattr(run, "_turn_active", False):
            # never-block symmetry (review fix): a consumer gating on turn_done
            # must not hang because the driver died mid-turn (stall-fatal etc.).
            run._turn_active = False
            try:
                await run.emit({"type": "turn_done", "text": _loc(run,
                    "The turn failed before completing — send the message again to retry.",
                    "本轮在完成前失败——重新发送消息即可重试。")})
            except Exception:
                pass
    finally:
        syncer.cancel()
        watchdog.cancel()
        for _t in (syncer, watchdog):
            try:
                await _t
            except asyncio.CancelledError:
                pass
        # Detached verify tasks die with the run (audit finding): a media/PK
        # pass mid-flight on a run that just ended kept burning model calls
        # for minutes, then no-op'd its repair injection into a dead session.
        for _name in ("_media_task", "_pk_task"):
            _bg = getattr(run, _name, None)
            if _bg is not None and not _bg.done():
                _bg.cancel()
                try:
                    await _bg
                except BaseException:
                    pass  # cancellation/teardown errors must not mask the run's outcome
        # Final sync so the last writes are durable even if no tick caught them —
        # especially on the crash path where no bundle was submitted.
        try:
            await _sync_workspace(run, sent)
        except Exception as e:
            clean = False
            await run.emit({"type": "error", "error": f"final workspace sync failed: {e!r}"})
        if clean:
            await run.emit({"type": "done"})
        await run.emit({"type": "end"})
        run._ended = True  # shutdown drain skips finished runs


# Default tool whitelist for a read-only kb-test session, used when the runtime
# profile declares none. Read-only by construction: cannot mutate the snapshot.
DEFAULT_TEST_ALLOWED_TOOLS = ["Read", "Glob", "Grep"]

# Tool-input keys that name a filesystem path (Read.file_path, Glob/Grep.path).
_TEST_PATH_KEYS = ("file_path", "path", "notebook_path")


def _test_path_escape(root: Path, tool_name: str, tool_input: dict) -> str | None:
    """C4 fidelity guard predicate: return a human-readable offender when a tool
    input reaches OUTSIDE the pinned snapshot dir, else None. The allowed_tools
    whitelist already makes a test session read-only, but an ABSOLUTE path (or a
    ../ traversal) in Read/Glob/Grep would still reach the LIVE /work draft —
    breaking "the test measures the pinned snapshot". Pure function → unit-tested."""
    root = root.resolve()
    for key in _TEST_PATH_KEYS:
        v = tool_input.get(key)
        if not isinstance(v, str) or not v.strip():
            continue
        p = Path(v)
        target = p if p.is_absolute() else root / p
        try:
            target.resolve().relative_to(root)
        except ValueError:
            return f"{key}={v}"
    # Glob's pattern is itself a path expression even with `path` unset. Reject
    # lexical parent traversal for relative patterns and resolve absolute bases.
    # (Grep's pattern is regex CONTENT — not a path; skip it.)
    if tool_name == "Glob":
        pattern = tool_input.get("pattern")
        if isinstance(pattern, str) and pattern.strip():
            if ".." in PurePosixPath(pattern).parts:
                return f"pattern={pattern}"
            wildcard_positions = [pattern.find(ch) for ch in ("*", "?", "[") if ch in pattern]
            base = pattern[:min(wildcard_positions)] if wildcard_positions else pattern
            target = Path(base) if pattern.startswith("/") else root / base
            try:
                target.resolve().relative_to(root)
            except ValueError:
                return f"pattern={pattern}"
    return None


def _make_path_guard(root: Path, locale: str | None = None, *, deny_bash: bool = False):
    """PreToolUse hook confining one SDK session to its workspace. Hooks fire
    under bypassPermissions; compiler sessions also deny Bash as defense in
    depth if a future profile accidentally adds it back."""
    deny_template = _prompt("guard_deny", locale).strip()

    async def guard(input_data, tool_use_id, context):
        tool_name = str(input_data.get("tool_name", ""))
        offender = "tool=Bash" if deny_bash and tool_name == "Bash" else _test_path_escape(
            root, tool_name, input_data.get("tool_input") or {}
        )
        if offender:
            return {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": deny_template.format(root=root, offender=offender),
                }
            }
        return {}

    return guard


def _make_test_path_guard(root: Path, locale: str | None = None):
    """Constrain a read-only test consumer to its pinned snapshot."""
    return _make_path_guard(root, locale)


def _make_compile_path_guard(root: Path, locale: str | None = None):
    """Constrain compiler and planner sessions to their /work workspace."""
    return _make_path_guard(root, locale, deny_bash=True)


async def test_session_driver(run: "TestRun"):
    """Read-only consumer driver: host a ClaudeSDKClient over the pinned snapshot
    dir, tools limited to the kb-test profile's whitelist (default Read/Glob/Grep),
    persona = test_role pack, no MCP, no kickoff. A conversational session — connects and
    waits for the first /test-message; each turn streams log + turn_done over GET
    /test-events. Mirrors run_session minus writes/compile-tools/sync/bundle."""
    sid = run.session_id or str(uuid.uuid4())
    run.session_id = sid
    opts = ClaudeAgentOptions(
        cwd=run.cwd,
        system_prompt={"type": "preset", "preset": "claude_code", "append": _prompt("test_role", run.locale)},
        allowed_tools=run.allowed_tools or DEFAULT_TEST_ALLOWED_TOOLS,
        mcp_servers={},                            # no compile signal tools
        permission_mode="bypassPermissions",       # the pod itself is the sandbox
        # C4: path confinement — absolute/../ reads must not escape the snapshot
        # to the live /work draft. Hook, not can_use_tool: hooks fire under bypass.
        hooks={"PreToolUse": [HookMatcher(hooks=[_make_test_path_guard(Path(run.cwd), run.locale)])]},
        setting_sources=[],                        # tenant isolation
        # The test session mimics the REAL consumer → the gate/consumer tier
        # (sonnet), not the compile tier. Massapi-served id; overridable per-deploy.
        model=os.environ.get("KBC_TEST_MODEL", "claude-sonnet-4-6"),
        max_turns=int(os.environ.get("KBC_TEST_MAX_TURNS", "60")),
        session_id=sid,
        session_store=InMemorySessionStore(),
    )
    client = ClaudeSDKClient(options=opts)
    try:
        await client.connect()  # conversational: wait for the first /test-message
        run.client = client
        run.connected.set()
        await run.emit({"type": "session", "session_id": sid})
        async for msg in client.receive_messages():
            await _emit_message(run, msg)
    finally:
        run.connected.set()  # unblock any /test-message waiters even if connect failed
        run.client = None
        await client.disconnect()


async def _test_session_wrapper(run: "TestRun"):
    """Lifecycle for a read-only test session: run the driver, turn a crash into an
    `error` event, always close with `end`. No syncer / bundle fallback (read-only,
    nothing to persist). Cancellation (teardown) skips `error`, still emits `end`."""
    try:
        await _TEST_SESSION_IMPL(run)
    except Exception as e:  # top-level boundary; CancelledError (teardown) passes through
        await run.emit({"type": "error", "error": repr(e)})
    finally:
        run.done = True
        await run.emit({"type": "end"})


async def _teardown_test_session(run: "TestRun"):
    """Cancel the session task (→ driver finally disconnects the client), drop the
    snapshot dir, and forget the run. The original RUNS machinery has no GC; test
    sessions are frequent + ephemeral, so they get explicit teardown."""
    if run.task and not run.task.done():
        run.task.cancel()
        try:
            await run.task
        except asyncio.CancelledError:
            pass
    shutil.rmtree(run.cwd, ignore_errors=True)
    TEST_SESSIONS.pop(run.tid, None)


# ── HTTP ──

# ── consumer-managed box config (DESIGN-kb-llm-binding-v2-2026-07-07) ────────
# The consumer owns the credential store and the KB capability policy; both arrive on
# the /session body and apply IN-PROCESS (the box spawns before fetchInput runs,
# so pod env is too early — and this keeps the token out of the pod spec).
# LLM authority is whole-block: consumer object, else Runtime's Helm fallback;
# omitted fields in a present object never inherit another authority's token.
# ONE settings exception: KBC_PK_MODE=off set at the runtime level is the ops
# KILL SWITCH and must win over consumer settings.
_PK_KILL_AT_BOOT = os.environ.get("KBC_PK_MODE") == "off"


def _apply_session_config(body: dict) -> None:
    """Apply consumer-managed llm/settings from the /session body to os.environ.
    Never log the token; whitelist settings keys to the box's own vocabulary.
    INVARIANT: os.environ is process-global, so this leans on the platform's
    one-pod-per-run spawn (the gateway creates a dedicated box per runId) — a
    second concurrent /session on the same pod would clobber the first run's
    credential/tiers. If multi-run pods ever become real, carry llm/settings
    per-run (SDK client env) instead of mutating the process environment."""
    llm = body.get("llm")
    if isinstance(llm, dict):
        # The LLM object is one authority block, not field-level overrides. If
        # the consumer supplied it, omitted fields must not inherit a Runtime or
        # image credential that belongs to another endpoint.
        for field, env_name in (
            ("base_url", "ANTHROPIC_BASE_URL"),
            ("model", "ANTHROPIC_MODEL"),
        ):
            value = llm.get(field)
            if value:
                os.environ[env_name] = str(value)
            else:
                os.environ.pop(env_name, None)

        auth_token = llm.get("auth_token")
        api_key = llm.get("api_key")
        if auth_token:
            os.environ["ANTHROPIC_AUTH_TOKEN"] = str(auth_token)
            os.environ.pop("ANTHROPIC_API_KEY", None)
        elif api_key:
            os.environ["ANTHROPIC_API_KEY"] = str(api_key)
            os.environ.pop("ANTHROPIC_AUTH_TOKEN", None)
        else:
            os.environ.pop("ANTHROPIC_AUTH_TOKEN", None)
            os.environ.pop("ANTHROPIC_API_KEY", None)
    settings = body.get("settings")
    if isinstance(settings, dict):
        for key, value in settings.items():
            k = str(key)
            if not k.startswith("KBC_") or value is None:
                continue  # whitelist: only the box's own knob vocabulary
            if k == "KBC_PK_MODE" and _PK_KILL_AT_BOOT:
                continue  # ops kill switch outranks consumer config
            os.environ[k] = str(value)


async def handle_session(request: web.Request):
    """Start (or no-op attach to) the run's persistent CONVERSATIONAL session —
    it connects and waits for the first /message (prepare chat; a compile is just
    a later turn). Idempotent: a second call for a live run is a no-op, so the
    runtime can safely ensure-then-message. A live attach deliberately does not
    hot-apply a new LLM block: its already-connected SDK child captured the
    original environment. Rotate with the documented grace window + box respawn
    until an idle-boundary client reconnect protocol exists."""
    run_id = request.match_info["run_id"]
    if run_id in RUNS:
        return web.json_response({"ok": True, "run_id": run_id, "already_live": True})
    body = await request.json() if request.body_exists else {}
    # Consumer-managed LLM endpoint + KBC_* knobs (DESIGN-kb-llm-binding-v2):
    # applied to os.environ BEFORE any SDK/engine session exists, so the
    # persistent session, batch sessions, PK and media-verify all inherit them.
    _apply_session_config(body)
    run = CompileRun(run_id, body.get("workdir", "/work"), int(body.get("round", 1)), body.get("instruction", ""))
    # Tool whitelist from the runtime BoxProfile (None/absent → driver default).
    run.allowed_tools = body.get("allowed_tools")
    run.locale = body.get("locale")
    _seed_workdir(run.workdir)
    _ensure_workdir_constitution(run.workdir, run.locale)
    RUNS[run_id] = run
    run.task = asyncio.create_task(_run_wrapper(run))
    return web.json_response({"ok": True, "run_id": run_id})


async def handle_sources(request: web.Request):
    body = await request.json()
    run_id = body.get("run_id")
    if run_id and run_id in RUNS:
        return web.json_response({"error": "run already exists; upload sources before /session", "run_id": run_id}, status=409)

    encoded = body.get("bundle_base64") or body.get("bundle_b64")
    if not encoded:
        return web.json_response({"error": "bundle_base64 is required"}, status=400)

    try:
        bundle = base64.b64decode(encoded, validate=True)
        result = _install_source_bundle(bundle, body.get("workdir", "/work"), body.get("bundle_sha256"), locale=body.get("locale"))
    except (ValueError, TypeError) as e:
        return web.json_response({"error": str(e)}, status=400)

    if run_id:
        result["run_id"] = run_id
    return web.json_response({"ok": True, **result})


async def handle_authoring(request: web.Request):
    # NOTE: authoring assets are just installed into the workspace (/work/authoring
    # etc.), independent of run state — so this is allowed on a LIVE session run
    # too (the runtime rehydrates a fresh box's durable workspace through here,
    # and may push assets to an already-running session).
    body = await request.json()
    run_id = body.get("run_id")
    encoded = body.get("bundle_base64") or body.get("bundle_b64")
    if not encoded:
        return web.json_response({"error": "bundle_base64 is required"}, status=400)

    try:
        bundle = base64.b64decode(encoded, validate=True)
        result = _install_authoring_bundle(bundle, body.get("workdir", "/work"), body.get("bundle_sha256"), locale=body.get("locale"))
    except (ValueError, TypeError) as e:
        return web.json_response({"error": str(e)}, status=400)

    if run_id:
        result["run_id"] = run_id
    return web.json_response({"ok": True, **result})


async def _await_session_live(run: CompileRun):
    """Wait for the run's async connect() to finish, then validate the session.
    Returns an error Response if the session is unusable, else None. Shared by
    /message and /test-message: the session connects in the background after
    /session returns, so a turn that races ahead must wait — otherwise the SDK
    raises "Not connected. Call connect() first." A failed connect sets the event
    too (run.client stays None → 409)."""
    try:
        await asyncio.wait_for(run.connected.wait(), timeout=float(os.environ.get("KBC_CONNECT_TIMEOUT_SECS", "25")))
    except asyncio.TimeoutError:
        return web.json_response({"error": "session is still starting"}, status=503)
    if not run.client:
        return web.json_response({"error": "session is not live"}, status=409)
    return None


async def _dispatch_authoring_turn(run: CompileRun, text: str, action: str | None = None) -> dict:
    """One execution seam for legacy chat turns and typed commands.

    `action` is authoritative when present. Text inspection exists only for the
    rolling-upgrade message adapter and must never be consulted for a typed
    command.
    """
    # v3 brief: if the wizard's 「开始生成知识库」message carries a 定调标签 block,
    # persist it deterministically to authoring/BRIEF.json BEFORE the turn so the
    # agent reads it this turn. Fail-open — a parse hiccup never blocks the turn.
    if action is None:
        _capture_brief(run, text)
    # Scoped incremental (真增量): a compile trigger + a machine-computed changeset
    # from the consumer → re-touch only affected pages, NOT a whole-corpus re-plan. Takes
    # precedence over the batch/full route (which is the "recompile everything"
    # fallback when no changeset is present).
    if _should_route_to_incremental(run, text, action):
        await _start_incremental(run, text, strict=action == "compile.incremental")
        return {"ok": True, "incremental": True}
    if action == "compile.incremental":
        # Unlike the legacy string adapter, an explicit incremental command must
        # never silently degrade into a whole-corpus compile.
        raise CommandRejected("no structured source changes are available for incremental compile", 409)
    full_compile = action in _FULL_COMPILE_ACTIONS if action is not None else _is_compile_trigger(text)
    compile_control = full_compile or action == "compile.incremental" or (action is None and _is_compile_trigger(text))
    if full_compile:
        # A FULL recompile kickoff (compile trigger, no RAW_CHANGES) voids any
        # stale scoped changeset: only the incremental route READS it, but the
        # model reads authoring/ proactively and the prompt's "no CHANGESET =
        # not an incremental round" biconditional could make it self-restrict
        # a full round to a stale scope (review finding). Clearing here also
        # keeps the consumer's round-summary counts honest after a full round.
        try:
            (Path(run.workdir) / incremental.CHANGESET_PATH).unlink(missing_ok=True)
        except OSError:
            pass
    # Batch mode (大库): a compile trigger over an above-threshold corpus (or a
    # plan with pending batches) runs the orchestrator instead of one giant turn.
    if _should_route_to_batch(run, text, action):
        # Claim batch mode SYNCHRONOUSLY, before spawning the orchestrator task:
        # _run_batch_compile only sets the flag once it starts running, so a
        # second /message racing in before the task is scheduled would pass
        # _should_route_to_batch again and spawn a second orchestrator over the
        # same workspace. Setting it here closes that window (the task keeps its
        # own idempotent set, and the task's finally clears it).
        run._batch_active = True
        asyncio.create_task(_run_batch_compile(run, text))
        return {"ok": True, "batch": True}
    if run._batch_active:
        if compile_control:
            # A second trigger mid-batch changes nothing the plan doesn't know.
            await run.emit({"type": "summary", "text": _loc(run,
                "Batch compile in progress; start another one after this run finishes.",
                "分批编译进行中,本轮结束后再发起。")})
        else:
            # Owner chat mid-batch: queue it — the next batch/终审 directive
            # relays it, so nothing lands inside a half-read internal session.
            run._batch_notes.append(text)
            await run.emit({"type": "summary", "text": _loc(run,
                "Noted — it will be passed along to the remaining batches.",
                "已收到,会带给后续批次一并考虑。")})
        return {"ok": True, "queued": True}
    if full_compile:
        run._full_compile_pending = True
    run._begin_turn(text)  # arm the stall watchdog — every model turn, incl. the owner's
    try:
        await run.client.query(text)
    except BaseException:
        if full_compile:
            run._full_compile_pending = False
        raise
    return {"ok": True}


async def handle_message(request: web.Request):
    """Inject a genuine conversational turn into the persistent session.

    Legacy control strings remain temporarily recognized by
    `_dispatch_authoring_turn` for rolling upgrades; migrated product buttons
    use `/command` instead.
    """
    run = RUNS.get(request.match_info["run_id"])
    if not run:
        return web.json_response({"error": "unknown run"}, status=404)
    err = await _await_session_live(run)
    if err is not None:
        return err
    body = await request.json()
    text = (body.get("message") or "").strip()
    if not text:
        return web.json_response({"error": "message is required"}, status=400)
    message_id = (body.get("message_id") or "").strip()
    if len(message_id) > 128:
        return web.json_response({"error": "message_id must be at most 128 characters"}, status=400)
    if message_id and message_id in run._message_ids:
        return web.json_response({"ok": True, "duplicate": True})
    if message_id:
        run._message_ids.add(message_id)
    try:
        result = await _dispatch_authoring_turn(run, text)
    except CommandRejected as exc:
        if message_id:
            run._message_ids.discard(message_id)
        return web.json_response({"error": str(exc)}, status=exc.status)
    except BaseException:
        if message_id:
            run._message_ids.discard(message_id)
        raise
    return web.json_response(result)


async def handle_command(request: web.Request):
    """Validate and execute one typed authoring command.

    The command id is claimed synchronously before the first await so concurrent
    duplicate POSTs cannot launch two turns. A dispatch that fails before the
    SDK accepts it releases the id for retry.
    """
    run = RUNS.get(request.match_info["run_id"])
    if not run:
        return web.json_response({"error": "unknown run"}, status=404)
    err = await _await_session_live(run)
    if err is not None:
        return err
    try:
        try:
            body = await request.json()
        except (json.JSONDecodeError, UnicodeDecodeError, TypeError):
            raise CommandRejected("request body must be valid JSON", 400)
        command_id, command = _normalize_command(body)
        digest = _command_digest(command)
        context = (command["operation_id"], command["generation"])
        accepted_digest = run._accepted_commands.get(command_id)
        if accepted_digest is not None:
            if accepted_digest != digest:
                raise CommandRejected("command_id was already used with a different payload", 409)
            return web.json_response({"ok": True, "duplicate": True, "command_id": command_id})
        # Product controls are never an in-memory "note for later". Accepting a
        # second command while a turn/batch is active would acknowledge an
        # action that has not actually been scheduled. Exact replays are handled
        # above; every distinct concurrent command fails closed and can be
        # retried as a new product action after the run returns idle.
        if run._turn_active or run._batch_active:
            raise CommandRejected("another authoring command is already running", 409)
        if run._command_context is not None and run._command_context != context:
            raise CommandRejected("run is pinned to another operation generation", 409)
        _prepare_command(run, command)
        text = _render_command(run, command)
        run._command_context = context
        run._accepted_commands[command_id] = digest
        try:
            result = await _dispatch_authoring_turn(run, text, command["action"])
        except BaseException:
            run._accepted_commands.pop(command_id, None)
            raise
        return web.json_response({**result, "command_id": command_id, "action": command["action"]})
    except CommandRejected as exc:
        return web.json_response({"error": str(exc)}, status=exc.status)


async def handle_events(request: web.Request):
    run = RUNS.get(request.match_info["run_id"])
    if not run:
        return web.Response(status=404, text="unknown run")
    resp = web.StreamResponse(headers={
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
    })
    await resp.prepare(request)
    run._relays = getattr(run, "_relays", 0) + 1
    try:
        # Replay BEFORE consuming the queue. This closes the crash window where
        # a previous runtime dequeued a sync event but died before persisting it;
        # it also works when the run already queued its terminal `end` frame.
        wants_replay = request.query.get("replay") == "1"
        replay = (_workspace_replay_artifacts(run, getattr(run, "_sync_sent", {}))
                  if wants_replay else [])
        replay_commit = wants_replay and getattr(run, "_commit_input_replay", False)
        if replay or replay_commit:
            ev = {"type": "syncArtifacts", "artifacts": replay}
            if replay_commit:
                ev["commit_input"] = True
            await resp.write(("data: " + json.dumps(ev, ensure_ascii=False) + "\n\n").encode())
        while True:
            try:
                ev = await asyncio.wait_for(run.events.get(), timeout=25)
            except asyncio.TimeoutError:
                await resp.write(b": heartbeat\n\n")  # keep-alive
                continue
            await resp.write(("data: " + json.dumps(ev, ensure_ascii=False) + "\n\n").encode())
            # Delivery mark AFTER the socket write: the shutdown drain gates on
            # queue.join(), so "drained" means written out, not merely dequeued.
            run.events.task_done()
            if ev.get("type") == "end":
                break
    finally:
        run._relays = getattr(run, "_relays", 1) - 1
    return resp


async def handle_health(request: web.Request):
    return web.json_response({"status": "ok", "runs": len(RUNS), "test_sessions": len(TEST_SESSIONS)})


def _install_wiki_snapshot(bundle: bytes, dest: Path, expected_sha256: str | None = None) -> tuple[str, int]:
    """Install a consumer-PROVIDED wiki snapshot (a tar.gz of root-level pages —
    e.g. a PUBLISHED version bundle, the exact bytes a publish serves) into
    {dest}/.siclaw/knowledge/. Lets a test session probe a snapshot that does not
    live on this box's disk. Returns (content hash — via selfcheck.content_hash,
    the same formula as pack_candidates_to_wiki so draft and version snapshots are
    comparable — and the page count)."""
    # DoS hardening, mirroring _install_source_bundle / _install_authoring_bundle:
    # cap the compressed input AND accumulate the declared uncompressed size, so a
    # gzip-bomb bundle_base64 that slips under the HTTP request cap can't OOM the
    # box (which shares the pod with the live parent authoring run).
    max_bundle_bytes = int(os.environ.get("KBC_MAX_SNAPSHOT_BUNDLE_BYTES", str(64 * 1024 * 1024)))
    max_unpacked_bytes = int(os.environ.get("KBC_MAX_SNAPSHOT_UNPACKED_BYTES", str(256 * 1024 * 1024)))
    if len(bundle) > max_bundle_bytes:
        raise ValueError(f"snapshot bundle is too large: {len(bundle)} > {max_bundle_bytes}")
    actual = hashlib.sha256(bundle).hexdigest()
    if expected_sha256 and expected_sha256.lower() != actual:
        raise ValueError(f"snapshot bundle sha256 mismatch: expected {expected_sha256}, got {actual}")
    kdir = dest / ".siclaw" / "knowledge"
    kdir.mkdir(parents=True, exist_ok=True)
    pages: list[tuple[str, bytes]] = []
    total_bytes = 0
    try:
        tf = tarfile.open(fileobj=io.BytesIO(bundle), mode="r:gz")
    except tarfile.TarError as e:
        raise ValueError(f"invalid snapshot bundle: {e}") from e
    with tf:
        for member in tf.getmembers():
            if not member.isfile():
                continue
            total_bytes += member.size
            if total_bytes > max_unpacked_bytes:
                raise ValueError(f"snapshot bundle unpacks too large: {total_bytes} > {max_unpacked_bytes}")
            rel = _safe_tar_path(member.name)
            rel_posix = rel.as_posix()
            if not (rel_posix.endswith(".md") or rel_posix.endswith(".json")):
                continue
            src = tf.extractfile(member)
            if src is None:
                raise ValueError(f"could not read snapshot entry {member.name!r}")
            with src:
                data = src.read()
            out = kdir / Path(*rel.parts)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(data)
            pages.append((rel_posix, data))
    if not any(rp == "index.md" for rp, _ in pages):
        raise FileNotFoundError("snapshot bundle is missing index.md — cannot test without a root index page")
    return selfcheck.content_hash(pages), len(pages)


async def handle_open_test(request: web.Request):
    """Start a test session: pin an immutable snapshot and start a fresh read-only
    consumer session over it. Default snapshot source = the parent run's CURRENT
    draft (candidate/*); a request carrying `bundle_base64` pins THAT tar.gz
    instead (e.g. a published version the consumer serves). Returns the test
    session id + snapshot hash. The reply to later /test-message turns streams
    over GET /test-events. NOTE: reuses the parent authoring box (no new pod) —
    the parent run must already be live."""
    parent = RUNS.get(request.match_info["run_id"])
    if not parent:
        return web.json_response({"error": "unknown run"}, status=404)
    active = sum(1 for t in TEST_SESSIONS.values() if not t.done)
    if active >= _max_test_sessions():
        return web.json_response({"error": "too many concurrent test sessions"}, status=429)
    body = await request.json() if request.body_exists else {}
    tid = str(uuid.uuid4())
    dest = Path(_test_snapshot_root()) / tid
    try:
        encoded = body.get("bundle_base64")
        if encoded:
            bundle = base64.b64decode(encoded, validate=True)
            snapshot_hash, pages = _install_wiki_snapshot(bundle, dest, body.get("bundle_sha256"))
        else:
            snapshot_hash, pages = _pack_candidates_to_wiki(parent.workdir, dest)
    except (FileNotFoundError, ValueError, TypeError) as e:
        shutil.rmtree(dest, ignore_errors=True)
        return web.json_response({"error": str(e)}, status=400)
    run = TestRun(tid, str(dest), parent_run_id=parent.run_id, snapshot_hash=snapshot_hash, locale=parent.locale)
    # Tool whitelist from the runtime BoxProfile (kb-test); None/absent → read-only default.
    run.allowed_tools = body.get("allowed_tools")
    TEST_SESSIONS[tid] = run
    run.task = asyncio.create_task(_test_session_wrapper(run))
    return web.json_response({"ok": True, "test_session_id": tid, "snapshot_hash": snapshot_hash, "pages": pages})


async def handle_test_message(request: web.Request):
    """Inject a user turn into a live read-only test session. Reply streams over
    GET /test-events/{tid}."""
    run = TEST_SESSIONS.get(request.match_info["tid"])
    if not run:
        return web.json_response({"error": "unknown test session"}, status=404)
    err = await _await_session_live(run)  # duck-typed on .connected/.client
    if err is not None:
        return err
    body = await request.json()
    text = (body.get("message") or "").strip()
    if not text:
        return web.json_response({"error": "message is required"}, status=400)
    await run.client.query(text)
    return web.json_response({"ok": True})


async def handle_test_events(request: web.Request):
    """SSE stream for a test session (clone of handle_events over TEST_SESSIONS)."""
    run = TEST_SESSIONS.get(request.match_info["tid"])
    if not run:
        return web.Response(status=404, text="unknown test session")
    resp = web.StreamResponse(headers={
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
    })
    await resp.prepare(request)
    while True:
        try:
            ev = await asyncio.wait_for(run.events.get(), timeout=25)
        except asyncio.TimeoutError:
            await resp.write(b": heartbeat\n\n")
            continue
        await resp.write(("data: " + json.dumps(ev, ensure_ascii=False) + "\n\n").encode())
        if ev.get("type") == "end":
            break
    return resp


async def handle_close_test(request: web.Request):
    """Tear down a test session (cancel, disconnect, drop snapshot). Idempotent."""
    run = TEST_SESSIONS.get(request.match_info["tid"])
    if not run:
        return web.json_response({"ok": True, "already_closed": True})
    await _teardown_test_session(run)
    return web.json_response({"ok": True})


async def _flush_on_shutdown(_app) -> None:
    """aiohttp on_shutdown (F3): SIGTERM is stopping the box. Emit a final
    workspace sync for every active run so the last unsynced work reaches the
    store instead of dying with the emptyDir /work, then give the SSE relay a
    bounded window to drain the queued events before connections close.
    Best-effort — a store that never acks still loses it; F1 is the durable fix."""
    runs = [r for r in RUNS.values() if getattr(r, "_sync_sent", None) is not None]
    for run in runs:
        try:
            n = await _sync_workspace(run, run._sync_sent)
            if n:
                await run.emit({"type": "summary", "text": _loc(run,
                    f"[shutdown] flushed {n} changed file(s)", f"[shutdown] 落盘 {n} 个改动文件")})
        except Exception:
            pass
    deadline = time.monotonic() + _SHUTDOWN_DRAIN_MAX_S
    # Drain means DELIVERY (the relay task_done()s after the socket write), not
    # dequeue — and only runs someone is listening to: an ended run or one with
    # no live relay would never drain and would burn the whole deadline,
    # starving the active runs' grace window.
    to_drain = [r for r in runs
                if not getattr(r, "_ended", False) and getattr(r, "_relays", 0) > 0]
    if to_drain:
        try:
            await asyncio.wait_for(
                asyncio.gather(*(r.events.join() for r in to_drain)),
                timeout=max(0.0, deadline - time.monotonic()))
        except asyncio.TimeoutError:
            pass


@web.middleware
async def _client_certificate_middleware(request: web.Request, handler):
    error = _client_certificate_error(request)
    if error is not None:
        return web.json_response({"error": error}, status=403)
    return await handler(request)


def build_app() -> web.Application:
    app = web.Application(
        client_max_size=_http_max_request_bytes(),
        middlewares=[_client_certificate_middleware],
    )
    app.on_shutdown.append(_flush_on_shutdown)
    app.add_routes([
        web.post("/sources", handle_sources),
        web.post("/authoring", handle_authoring),
        web.post("/session/{run_id}", handle_session),
        web.post("/message/{run_id}", handle_message),
        web.post("/command/{run_id}", handle_command),
        web.get("/events/{run_id}", handle_events),
        # Test session: read-only consumer session over a pinned draft snapshot.
        web.post("/test-session/{run_id}", handle_open_test),
        web.post("/test-message/{tid}", handle_test_message),
        web.get("/test-events/{tid}", handle_test_events),
        web.post("/test-session/{tid}/close", handle_close_test),
        web.get("/health", handle_health),
    ])
    return app


def _ssl_context():
    """Production mTLS, or intentional plain HTTP when no certs exist locally."""
    cert_dir = Path(os.environ.get("SICLAW_CERT_PATH", "/etc/siclaw/certs"))
    return server_ssl_context(cert_dir)


def main():
    port = int(os.environ.get("SICLAW_AGENTBOX_PORT", "3000"))
    print(f"[compile_box] listening on :{port}", flush=True)
    web.run_app(build_app(), port=port, ssl_context=_ssl_context(), print=None)


# KBC_SMOKE=1 → free in-cluster wiring e2e (no LLM); default = persistent session.
_COMPILE_IMPL = _smoke_compile if os.environ.get("KBC_SMOKE") == "1" else run_session
_TEST_SESSION_IMPL = test_session_driver

if __name__ == "__main__":
    main()
