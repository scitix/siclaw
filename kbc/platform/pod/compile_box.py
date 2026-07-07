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
  POST /session/{run_id}   {workdir?, instruction?, allowed_tools?, locale?} start the run's persistent conversational session (waits for the first /message); idempotent
  POST /message/{run_id}   {message} inject one user turn into the persistent session (prepare/compile/patch are all ordinary turns)
  GET  /events/{run_id}    structured SSE stream (session/log/summary/turn_done/syncArtifacts/plan_proposed/error/end)
  POST /test-session/{run_id}  start a test session: pin the current draft as an immutable snapshot + a read-only consumer session (reuses this pod)
  POST /test-message/{tid} · GET /test-events/{tid} · POST /test-session/{tid}/close
  GET  /health

LLM auth: local runs reuse the subscription (the SDK ships the claude binary);
production pods set ANTHROPIC_BASE_URL → massapi (keys injected outside the container).
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

import office_ingest
import selfcheck

# massapi/Bedrock rejects the `context_management` field Claude Code attaches
# once a session's context passes the autocompact buffer (HTTP 400
# "context_management: Extra inputs are not permitted"). A compile is a long
# multi-turn session, so it hits this readily. Disable autocompact so the field
# is never sent. setdefault → an explicit deployment override still wins.
os.environ.setdefault("DISABLE_AUTOCOMPACT", "1")

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


def _playbook_text(locale: str | None) -> str:
    """Compile playbook: KBC_PLAYBOOK env overrides (local dev), else the pack."""
    env = os.environ.get("KBC_PLAYBOOK")
    if env and Path(env).exists():
        return Path(env).read_text(encoding="utf-8")
    return _prompt("playbook", locale)


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

    async def emit(self, ev: dict):
        await self.events.put(ev)

    async def inject_user_message(self, text: str):
        """Engine seam: push a user turn into the live session. The Claude SDK
        driver is one line; a future engine driver (e.g. Codex) reimplements
        just this method — self-check orchestration stays engine-neutral."""
        if self.client:
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


async def _sync_workspace(run: CompileRun, sent: dict) -> int:
    """Emit a syncArtifacts event for workspace files changed since `sent`
    (path → content sha), plus TOMBSTONES ({path, deleted: true}) for
    previously-synced files that no longer exist on disk. Updates `sent`;
    returns the number of changed entries."""
    changed = []
    collected = set()
    for art in _collect_workspace_artifacts(run.workdir):
        collected.add(art["path"])
        sha = hashlib.sha256(art["content"].encode("utf-8")).hexdigest()
        if sent.get(art["path"]) == sha:
            continue
        sent[art["path"]] = sha
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
        del sent[path]
        changed.append({"path": path, "deleted": True})
    if changed:
        await run.emit({"type": "syncArtifacts", "artifacts": changed})
    return len(changed)


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
        proposal_path.parent.mkdir(parents=True, exist_ok=True)
        proposal_path.write_text(json.dumps({
            "text": plan_text,
            "proposed_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }, ensure_ascii=False, indent=2), "utf-8")
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
        {"ticket_id": str, "applied_value": str, "pages_edited": list, "note": str},
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
            path.write_text(json.dumps(tickets, ensure_ascii=False, indent=2), "utf-8")
        except Exception as e:
            return {"content": [{"type": "text", "text": rt["write_failed"].format(e=e)}]}
        return {"content": [{"type": "text", "text": rt["registered"].format(tid=tid)}]}

    return create_sdk_mcp_server("compile", tools=[report_summary, propose_plan, resolve_ticket])


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
    return int(os.environ.get("KBC_L1_REPAIR_ROUNDS", "1"))


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
    key = selfcheck.state_key(workdir)
    if key is None or key == run._selfcheck_key:
        return None
    if not (Path(workdir) / "candidate" / "index.md").is_file():
        return None  # mid-Execute: pages exist but the index isn't written yet
    run._selfcheck_key = key
    report = selfcheck.run_layer1(workdir)
    if report["coverage"]["closed"] and report["lint"]["ok"]:
        run._l1_repairs_used = 0
        report["state"] = "passed"
    elif run._l1_repairs_used < _l1_repair_rounds():
        report["state"] = "repairing"
    else:
        report["state"] = "unconverged"  # budget spent: publish card shows the rest
    report["repair_rounds_used"] = run._l1_repairs_used
    selfcheck.write_selfcheck(workdir, report)
    locale = getattr(run, "locale", None)
    await run.emit({"type": "summary", "text": selfcheck.narration(report, locale)})
    if report["state"] == "repairing":
        run._l1_repairs_used += 1
        return selfcheck.build_repair_prompt(report, locale)
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
            try:
                await _sync_workspace(run, sent)
            except Exception:
                pass  # periodic loop retries; a sync hiccup must not kill the turn
        await run.emit({"type": "turn_done", "text": reply})
        # Bounded auto-repair AFTER turn_done (async-post-check design, §4.3-c):
        # the turn ends normally; the repair is an ordinary next turn.
        if repair_msg:
            try:
                await run.inject_user_message(repair_msg)
            except Exception as e:
                msg = (f"Self-check repair injection failed: {e!r}"
                       if selfcheck._is_en(getattr(run, "locale", None))
                       else f"自检回修注入失败: {e!r}")
                await run.emit({"type": "summary", "text": msg})


# Default tool whitelist for a kb-compile session, used when the runtime profile
# declares no allowed_tools (profile.allowedTools = null → box default). A profile
# that DOES declare a list (e.g. kb-test) overrides this.
DEFAULT_COMPILE_ALLOWED_TOOLS = [
    "Read", "Write", "Edit", "Glob", "Grep", "Bash",
    "mcp__compile__report_summary",
    "mcp__compile__propose_plan",
    "mcp__compile__resolve_ticket",
]


async def run_session(run: CompileRun):
    """Persistent driver: host ONE long-lived Claude Code session (ClaudeSDKClient)
    for this KB. box_role (+ the playbook + the attempt instruction) is the standing
    system prompt; the session then takes turns via POST /message — continuous
    prepare + compile in one session, on massapi, with the compile tools.
    Conversational by construction: connect, then wait for the first /message.
    (Durable cross-restart resume + a file-backed session store land in P4; v1
    uses an in-process store.)"""
    wd = str(Path(run.workdir).resolve())
    playbook = _playbook_text(run.locale)
    instruction = (run.instruction or "").strip()
    role_parts = []
    if playbook:
        role_parts.append(playbook)
    role_parts.append(_prompt("box_role", run.locale))
    if instruction:
        header = _INSTRUCTION_HEADER.get((run.locale or DEFAULT_LOCALE).lower(), _INSTRUCTION_HEADER[DEFAULT_LOCALE])
        role_parts.append(header + "\n\n" + instruction)
    system_prompt = "\n\n---\n\n".join(role_parts)

    sid = run.session_id or str(uuid.uuid4())
    run.session_id = sid
    opts = ClaudeAgentOptions(
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
        model=os.environ.get("KBC_COMPILE_MODEL", "claude-opus-4-6"),
        max_turns=int(os.environ.get("KBC_MAX_TURNS", "150")),
        session_id=sid,
        session_store=InMemorySessionStore(),
    )
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
        async for msg in client.receive_messages():
            await _emit_message(run, msg)
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
    sent: dict = {}
    clean = False
    run._sync_sent = sent  # shared with _emit_message's pre-turn_done sync
    syncer = asyncio.create_task(_sync_loop(run, sent))
    try:
        await _COMPILE_IMPL(run)
        clean = True
    except Exception as e:  # top-level boundary: surface crashes as an error event, never swallow
        await run.emit({"type": "error", "error": repr(e)})
    finally:
        syncer.cancel()
        try:
            await syncer
        except asyncio.CancelledError:
            pass
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
    # Glob's pattern is itself a path expression; an absolute pattern escapes even
    # with `path` unset. (Grep's pattern is regex CONTENT — not a path; skip it.)
    if tool_name == "Glob":
        pattern = tool_input.get("pattern")
        if isinstance(pattern, str) and pattern.startswith("/"):
            base = pattern.split("*", 1)[0]
            try:
                Path(base).resolve().relative_to(root)
            except ValueError:
                return f"pattern={pattern}"
    return None


def _make_test_path_guard(root: Path, locale: str | None = None):
    """PreToolUse hook confining a test session to its snapshot. A hook (not a
    can_use_tool callback) because hooks fire under bypassPermissions too. The
    steering message comes from the locale's prompt pack — it is model-facing."""
    deny_template = _prompt("guard_deny", locale).strip()

    async def guard(input_data, tool_use_id, context):
        offender = _test_path_escape(root, str(input_data.get("tool_name", "")), input_data.get("tool_input") or {})
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

async def handle_session(request: web.Request):
    """Start (or no-op attach to) the run's persistent CONVERSATIONAL session —
    it connects and waits for the first /message (prepare chat; a compile is just
    a later turn). Idempotent: a second call for a live run is a no-op, so the
    runtime can safely ensure-then-message."""
    run_id = request.match_info["run_id"]
    if run_id in RUNS:
        return web.json_response({"ok": True, "run_id": run_id, "already_live": True})
    body = await request.json() if request.body_exists else {}
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


async def handle_message(request: web.Request):
    """Inject a user turn into the run's live persistent session (prepare or a
    mid-session revision). The reply streams back over GET /events."""
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
    await run.client.query(text)
    return web.json_response({"ok": True})


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
    while True:
        try:
            ev = await asyncio.wait_for(run.events.get(), timeout=25)
        except asyncio.TimeoutError:
            await resp.write(b": heartbeat\n\n")  # keep-alive
            continue
        await resp.write(("data: " + json.dumps(ev, ensure_ascii=False) + "\n\n").encode())
        if ev.get("type") == "end":
            break
    return resp


async def handle_health(request: web.Request):
    return web.json_response({"status": "ok", "runs": len(RUNS), "test_sessions": len(TEST_SESSIONS)})


def _install_wiki_snapshot(bundle: bytes, dest: Path, expected_sha256: str | None = None) -> tuple[str, int]:
    """Install a consumer-PROVIDED wiki snapshot (a tar.gz of root-level pages —
    e.g. a PUBLISHED version bundle, the exact bytes a publish serves) into
    {dest}/.siclaw/knowledge/. Lets a test session probe a snapshot that does not
    live on this box's disk. Returns (content hash — same formula as
    _pack_candidates_to_wiki so draft and version snapshots are comparable —
    and the page count)."""
    actual = hashlib.sha256(bundle).hexdigest()
    if expected_sha256 and expected_sha256.lower() != actual:
        raise ValueError(f"snapshot bundle sha256 mismatch: expected {expected_sha256}, got {actual}")
    kdir = dest / ".siclaw" / "knowledge"
    kdir.mkdir(parents=True, exist_ok=True)
    pages: list[tuple[str, bytes]] = []
    try:
        tf = tarfile.open(fileobj=io.BytesIO(bundle), mode="r:gz")
    except tarfile.TarError as e:
        raise ValueError(f"invalid snapshot bundle: {e}") from e
    with tf:
        for member in tf.getmembers():
            if not member.isfile():
                continue
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
    h = hashlib.sha256()
    for rp, data in sorted(pages):
        h.update(rp.encode()); h.update(b"\0"); h.update(data); h.update(b"\0")
    return h.hexdigest(), len(pages)


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


def build_app() -> web.Application:
    app = web.Application(client_max_size=_http_max_request_bytes())
    app.add_routes([
        web.post("/sources", handle_sources),
        web.post("/authoring", handle_authoring),
        web.post("/session/{run_id}", handle_session),
        web.post("/message/{run_id}", handle_message),
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
    """Production mTLS: with certs, HTTPS + required client cert (only the
    runtime/gateway can drive the box). No certs locally → plain HTTP."""
    cert_dir = Path(os.environ.get("SICLAW_CERT_PATH", "/etc/siclaw/certs"))
    crt, key, ca = cert_dir / "tls.crt", cert_dir / "tls.key", cert_dir / "ca.crt"
    if not (crt.exists() and key.exists()):
        return None
    import ssl
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(str(crt), str(key))
    if ca.exists():
        ctx.load_verify_locations(str(ca))
        # CERT_OPTIONAL, not CERT_REQUIRED: the k8s readiness/liveness probes hit
        # /health over HTTPS WITHOUT a client cert; requiring one fails the TLS
        # handshake so the probes never pass and kubelet kills the box. The box is
        # only addressed by the runtime in-cluster, so requesting-but-not-requiring
        # the client cert is acceptable for v1. (Production: exempt /health + check
        # the cert per-route, like agentbox does.)
        ctx.verify_mode = ssl.CERT_OPTIONAL
    return ctx


def main():
    port = int(os.environ.get("SICLAW_AGENTBOX_PORT", "3000"))
    print(f"[compile_box] listening on :{port}", flush=True)
    web.run_app(build_app(), port=port, ssl_context=_ssl_context(), print=None)


# KBC_SMOKE=1 → free in-cluster wiring e2e (no LLM); default = persistent session.
_COMPILE_IMPL = _smoke_compile if os.environ.get("KBC_SMOKE") == "1" else run_session
_TEST_SESSION_IMPL = test_session_driver

if __name__ == "__main__":
    main()
