#!/usr/bin/env python3
"""compile_box —— 编译 box 的 served 形态:一个被 siclaw runtime 起、按 box 自有 HTTP+SSE
契约驱动的"云 Claude Code"(runtime 把事件翻成通用 capability.* 转给消费者,如 sicore)。

形态(2026-06-25 拍板):box 90% 是"封装入口的无头 Claude Code"(Agent SDK = Claude Code as library,
引擎/工具/compact 一行不重写);剩下 10% 是 kbc 护城河 —— 用自定义工具让 agent 显式发结构化信号:
  - report_summary  → SSE `summary`(编译进度,给 verify UI)
  - propose_plan    → SSE `plan_proposed`(Plan→Execute 对齐)
  - resolve_ticket  → 写 authoring/CONTRADICTIONS.json 的 agent_report(矛盾工单回修登记;矛盾永不阻塞)

对接面(被 runtime 调):
  POST /sources            {run_id?, workdir?, bundle_base64, bundle_sha256?} 上传冻结 raw bundle → workdir/raw
  POST /authoring          {run_id?, workdir?, bundle_base64, bundle_sha256?} 上传 authoring/candidate/eval/release 资产 → workdir/
  POST /session/{run_id}   {workdir?, instruction?, allowed_tools?} 起该 run 的持久对话会话(等首条 /message);幂等
  POST /message/{run_id}   {message} 向持久会话注入一轮用户消息(prepare/编译/回修都是普通 turn)
  GET  /events/{run_id}    SSE 结构化事件流(session/log/summary/turn_done/syncArtifacts/plan_proposed/error/end)
  POST /test-session/{run_id}  起测试会话:钉当前草稿为不可变快照 + 只读消费者 session(复用本 pod)
  POST /test-message/{tid} · GET /test-events/{tid} · POST /test-session/{tid}/close
  GET  /health

LLM 鉴权:本地复用订阅(SDK 自带 claude 二进制);生产 pod 设 ANTHROPIC_BASE_URL→massapi(key 容器外注入)。
mTLS:存在 SICLAW_CERT_PATH 证书则起 HTTPS 且要求客户端证书(runtime/gateway);否则 HTTP(本地)。
"""
import asyncio
import base64
import hashlib
import io
import json
import os
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


# 每个 box 通常只跑一个 run,但用 map 保持干净(也便于 health/调试)。
RUNS: dict[str, "CompileRun"] = {}
# Read-only "test session" runs — ephemeral consumer sessions over a pinned draft
# snapshot (起测试会话). Parallel to RUNS, torn down on close/idle. See TestRun.
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
# measures the wiki, not the agent's tools (mirrors siclaw_main prompt.ts).


def _max_test_sessions() -> int:
    return int(os.environ.get("KBC_MAX_TEST_SESSIONS", "3"))


def _test_snapshot_root() -> str:
    return os.environ.get("KBC_TEST_SNAPSHOT_ROOT", "/tmp/kbc-tests")


# 编译驱动可替换:生产 = run_session(真 Agent SDK);测试 = 注入假驱动,免烧 LLM 验协议管线。
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
        # turn_done event so sicore can persist the whole assistant reply.
        self._turn_text: list[str] = []

    async def emit(self, ev: dict):
        await self.events.put(ev)


class TestRun:
    """An ephemeral, read-only CONSUMER session over a pinned draft snapshot
    (起测试会话). Parallel to CompileRun but stripped: no workspace writes, no
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


def _pack_candidates_to_wiki(workdir: str, dest: Path) -> tuple[str, int]:
    """Pin the current draft: copy {workdir}/candidate/*.md|.json into
    {dest}/.siclaw/knowledge/ with the `candidate/` prefix stripped
    (candidate/index.md → index.md), mirroring sicore's
    buildPublishBundleFromCandidates so the test reads BYTE-IDENTICALLY to what a
    publish would serve. Returns (sha256 over sorted relpath+content, page_count).
    Raises FileNotFoundError if there are no candidate pages or no root index.md."""
    candidate = Path(workdir) / "candidate"
    kdir = dest / ".siclaw" / "knowledge"
    kdir.mkdir(parents=True, exist_ok=True)
    h = hashlib.sha256()
    count = 0
    has_index = False
    for f in sorted(candidate.rglob("*")) if candidate.is_dir() else []:
        if not f.is_file() or f.suffix not in (".md", ".json"):
            continue
        rel = f.relative_to(candidate)
        if ".." in rel.parts:
            continue
        rel_posix = rel.as_posix()
        data = f.read_bytes()
        out = kdir / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(data)
        h.update(rel_posix.encode()); h.update(b"\0"); h.update(data); h.update(b"\0")
        count += 1
        if rel_posix == "index.md":
            has_index = True
    if count == 0:
        raise FileNotFoundError("no candidate pages to test yet — ask the authoring agent to generate pages first")
    if not has_index:
        raise FileNotFoundError("draft is missing candidate/index.md — cannot test without a root index page")
    return h.hexdigest(), count


# ── B5: mid-compile workspace sync back to sicore ──
# The agent writes candidate/PLAN/eval into /work (an emptyDir). Without syncing
# them back, a box crash loses all in-progress work and a resume restarts from
# the frozen authoring snapshot. A periodic sync streams changed workspace files
# to sicore (compile.syncArtifacts) so the work is durable and a resumed box can
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
    (path → content sha). Updates `sent`; returns the number of changed files."""
    changed = []
    for art in _collect_workspace_artifacts(run.workdir):
        sha = hashlib.sha256(art["content"].encode("utf-8")).hexdigest()
        if sent.get(art["path"]) == sha:
            continue
        sent[art["path"]] = sha
        changed.append(art)
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
    """构造 box 的自定义工具(闭包持有 run),= 护城河信号面。"""

    @tool("report_summary", "汇报一段编译进度总结(产出/已并矛盾/待裁),一句到一段话。", {"summary": str})
    async def report_summary(args):
        await run.emit({"type": "summary", "summary": args.get("summary", "")})
        return {"content": [{"type": "text", "text": "summary recorded"}]}

    @tool(
        "propose_plan",
        "Plan 阶段对齐后调用:把一份简短、可读、可审核的编译计划抛给负责人请求批准,然后停下等批准。在收到批准前不要写 candidate/ 页面。",
        {"plan": str},
    )
    async def propose_plan(args):
        await run.emit({"type": "plan_proposed", "plan": args.get("plan", "")})
        return {"content": [{"type": "text", "text": "计划已抛给负责人,等待批准。在收到批准消息前不要写 candidate/ 页面。"}]}

    @tool(
        "resolve_ticket",
        "回修完一条矛盾工单后逐条调用(一条一次,别批量):登记你把哪条(ticket_id)按什么值(applied_value)"
        "回修了、实际改了哪几个 candidate 文件(pages_edited,必须覆盖该工单的 affected_pages)、一句话备注(note)。"
        "这会把该工单标为已回修并写下可审计的 agent_report —— 是「矛盾处理」显示「AI 已回修」、并让负责人核对的依据。",
        {"ticket_id": str, "applied_value": str, "pages_edited": list, "note": str},
    )
    async def resolve_ticket(args):
        tid = str(args.get("ticket_id", "")).strip()
        if not tid:
            return {"content": [{"type": "text", "text": "resolve_ticket 需要 ticket_id"}]}
        path = Path(run.workdir) / "authoring" / "CONTRADICTIONS.json"
        try:
            tickets = json.loads(path.read_text("utf-8")) if path.exists() else []
            if not isinstance(tickets, list):
                tickets = []
        except Exception as e:
            return {"content": [{"type": "text", "text": f"读 CONTRADICTIONS.json 失败: {e}"}]}
        target = next((tk for tk in tickets if isinstance(tk, dict) and str(tk.get("id")) == tid), None)
        if target is None:
            ids = [tk.get("id") for tk in tickets if isinstance(tk, dict)]
            return {"content": [{"type": "text", "text": f"没找到工单 {tid};现有 id: {ids}"}]}
        # The AI's structured CLAIM (evidence, not truth): the owner reviews it and
        # can reopen. status stays for back-compat; agent_report carries the detail.
        target["status"] = "applied"
        target["agent_report"] = {
            "applied_value": str(args.get("applied_value", "")),
            "pages_edited": [str(p) for p in (args.get("pages_edited") or []) if str(p).strip()],
            "note": str(args.get("note", "")),
            "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        try:
            path.write_text(json.dumps(tickets, ensure_ascii=False, indent=2), "utf-8")
        except Exception as e:
            return {"content": [{"type": "text", "text": f"写 CONTRADICTIONS.json 失败: {e}"}]}
        return {"content": [{"type": "text", "text": f"工单 {tid} 已登记回修(agent_report 已写入)"}]}

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
    """KBC_SMOKE=1: prove the sicore↔runtime↔box wiring (live events + artifact
    sync + turn persistence) in-cluster WITHOUT calling an LLM (the real compile
    is validated separately). Speaks only the capability-era event vocabulary."""
    await run.emit({"type": "summary", "summary": "[smoke] wiring check — no LLM"})
    cand = Path(run.workdir) / "candidate"
    cand.mkdir(parents=True, exist_ok=True)
    (cand / "index.md").write_text("# smoke index\n\nWiring e2e — no real content.\n")
    await run.emit({"type": "log", "text": "[smoke] wrote candidate/index.md"})
    await run.emit({"type": "turn_done", "text": "[smoke] wiring check complete"})


async def _emit_message(run: CompileRun, msg) -> None:
    """Relay one Agent SDK message to the SSE stream. Assistant text becomes the
    live chat (`log`) stream AND is accumulated for the turn; a ResultMessage
    marks the turn's end, flushing the accumulated text into `turn_done.text` so
    sicore can persist the whole assistant reply (and the UI knows it's idle)."""
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
        await run.emit({"type": "turn_done", "text": reply})


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
        permission_mode="bypassPermissions",  # pod 本身即 sandbox
        setting_sources=[],                    # 多租户隔离:不加载外部 settings/CLAUDE.md
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
    """统一生命周期:跑驱动 + 周期回写中途态 → 兜底 error → 永远收尾 end。"""
    sent: dict = {}
    syncer = asyncio.create_task(_sync_loop(run, sent))
    try:
        await _COMPILE_IMPL(run)
    except Exception as e:  # 顶层边界:把崩溃变成一条 error 事件,不吞
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
            await run.emit({"type": "error", "error": f"final workspace sync failed: {e!r}"})
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
        permission_mode="bypassPermissions",       # pod 本身即 sandbox
        # C4: path confinement — absolute/../ reads must not escape the snapshot
        # to the live /work draft. Hook, not can_use_tool: hooks fire under bypass.
        hooks={"PreToolUse": [HookMatcher(hooks=[_make_test_path_guard(Path(run.cwd), run.locale)])]},
        setting_sources=[],                        # 多租户隔离
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


async def handle_open_test(request: web.Request):
    """起测试会话: pin the parent run's CURRENT draft (candidate/*) into an
    immutable snapshot dir and start a fresh read-only consumer session over it.
    Returns the test session id + snapshot hash. The reply to later /test-message
    turns streams over GET /test-events. NOTE: reuses the parent authoring box
    (no new pod) — the parent run must already be live."""
    parent = RUNS.get(request.match_info["run_id"])
    if not parent:
        return web.json_response({"error": "unknown run"}, status=404)
    active = sum(1 for t in TEST_SESSIONS.values() if not t.done)
    if active >= _max_test_sessions():
        return web.json_response({"error": "too many concurrent test sessions"}, status=429)
    tid = str(uuid.uuid4())
    dest = Path(_test_snapshot_root()) / tid
    try:
        snapshot_hash, pages = _pack_candidates_to_wiki(parent.workdir, dest)
    except FileNotFoundError as e:
        shutil.rmtree(dest, ignore_errors=True)
        return web.json_response({"error": str(e)}, status=400)
    run = TestRun(tid, str(dest), parent_run_id=parent.run_id, snapshot_hash=snapshot_hash, locale=parent.locale)
    # Tool whitelist from the runtime BoxProfile (kb-test); None/absent → read-only default.
    body = await request.json() if request.body_exists else {}
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
        # 起测试会话: read-only consumer session over a pinned draft snapshot.
        web.post("/test-session/{run_id}", handle_open_test),
        web.post("/test-message/{tid}", handle_test_message),
        web.get("/test-events/{tid}", handle_test_events),
        web.post("/test-session/{tid}/close", handle_close_test),
        web.get("/health", handle_health),
    ])
    return app


def _ssl_context():
    """生产 mTLS:有证书则 HTTPS + 要求客户端证书(runtime/gateway 才能驱动)。本地无证书 → HTTP。"""
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
