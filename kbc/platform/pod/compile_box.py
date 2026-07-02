#!/usr/bin/env python3
"""compile_box —— 编译 box 的 served 形态:一个被 siclaw runtime 起、按 compile 专属协议驱动的
"云 Claude Code"。

形态(2026-06-25 拍板):box 90% 是"封装入口的无头 Claude Code"(Agent SDK = Claude Code as library,
引擎/工具/compact 一行不重写);剩下 10% 是 kbc 护城河 —— 用自定义工具让 agent 显式发结构化信号:
  - report_summary  → SSE `summary`(编译进度,给 verify UI)
  - park_contradictions → SSE `parked`(矛盾攒批);工具 **阻塞 await 负责人裁决**,= 实时 steer、上下文不丢
  - submit_bundle   → SSE `done`(把 workdir/bundle 打成 tar.gz 交付)

对接面(被 runtime 调,runtime 再转成 sicore 的 compile.parked/done/summary RPC):
  POST /sources            {run_id?, workdir?, bundle_base64, bundle_sha256?} 上传冻结 raw bundle → workdir/raw
  POST /authoring          {run_id?, workdir?, bundle_base64, bundle_sha256?} 上传 authoring/candidate/eval/release 资产 → workdir/
  POST /compile            {run_id, workdir?, round?, instruction?} 起一次编译(seed 编译 kickoff)
  POST /session/{run_id}   {workdir?, round?, instruction?} 起一个对话式会话(无 kickoff,等首条 /message);幂等
  POST /rulings            {run_id, rulings:[{contradiction_id,option_index,note?}]}  解阻塞、续编
  POST /message/{run_id}   {message} 向持久会话注入一轮用户消息(prepare/修订),续同一 session
  POST /compile-turn/{run_id} {instruction?} 在同一会话里跑一轮编译(box 自带 BOX_COMPILE_TASK),= 统一会话内编译
  GET  /events/{run_id}    SSE 结构化事件流(session/summary/parked/done/log/turn_done/error/end)
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
    query,
    ClaudeSDKClient,
    ClaudeAgentOptions,
    tool,
    create_sdk_mcp_server,
    InMemorySessionStore,
)

from compile_agent import _find_playbook

# 每个 box 通常只跑一个 run,但用 map 保持干净(也便于 health/调试)。
RUNS: dict[str, "CompileRun"] = {}
# Read-only "test session" runs — ephemeral consumer sessions over a pinned draft
# snapshot (起测试会话). Parallel to RUNS, torn down on close/idle. See TestRun.
TEST_SESSIONS: dict[str, "TestRun"] = {}
DEFAULT_HTTP_MAX_REQUEST_BYTES = 768 * 1024 * 1024

# BOX_ROLE = the agent's STANDING identity (→ system prompt, always present). The
# box is a long-lived conversational + compiling Claude Code session per KB: it
# converses to prepare (clarify intent/scope) AND compiles when asked. It does NOT
# auto-start compiling — a conversational session connects and waits for the first
# /message; only the /compile path seeds the compile kickoff below.
BOX_ROLE = """你是某个知识库(KB)的 authoring 助手兼编译器,跑在一个持久的 Claude Code 会话里。
工作目录是这个 KB 的 authoring workspace:
- `raw/` 是冻结的原始输入快照,只读;`drop/` 可能存在,只是兼容别名。
- `authoring/` 存准备阶段资产:CLAUDE.md、manifest.yaml、INTENT.md、PLAN.md、QUESTIONS.md、LEDGER.md。
- `candidate/` 存候选知识库页面 —— **这是你唯一的产出**,含一个 `candidate/index.md` 列出各页。没有 bundle/,不打包、不"提交":负责人审阅后会自行一键发布成版本。
- `eval/` 存发布前测试。

你按两个阶段工作,**先 Plan、负责人批准后才 Execute**:

1. **准备 / Plan(对话 + 提计划)**:跟负责人聊清楚这个 KB 要收什么、口径、边界、脱敏要求、待解问题,并维护 `authoring/INTENT.md` / `PLAN.md`。**此阶段绝不写 `candidate/` 页面、不大批产出。** 当你已读懂 `raw/`、且和负责人对齐后,调 `propose_plan` 抛出一份**简短、可读、可审核**的编译计划(打算产出哪些候选页、各页一句话、关键口径如脱敏、仍待定的点),**然后停下等批准**——不要擅自开编。

2. **执行 / Execute(产出)**:只有收到负责人的**批准消息**后,才把 `raw/` 编成 `candidate/` 页面:逐篇读 raw 抽原子断言(记清 source id/文件/locator);跨断言按 `authoring/CLAUDE.md` + `constitution.md` 裁矛盾(能并列就并列各挂条件、明显笔误标修正)。**遇到拿不准的矛盾:绝不中途停、绝不阻塞 —— 自己做一个最合理的 best-guess 写进页面、在该处标 `⚠️ 存疑`(并列两边来源),同时把这条作为一条"工单"追加进 `authoring/CONTRADICTIONS.json`(格式见下),然后继续编完。负责人事后会在「矛盾处理」里逐条裁决,届时你按裁决回修对应页。** **一页一个文件 Write 进 `candidate/`**(frontmatter 至少含 `compiled_from`/`snapshot`/`last_updated`/`confidence|status`,每条结论标 source id + locator);最后写 `candidate/index.md` 列出各页。写完这一轮就结束 —— 不提交、不打包。

可用的结构化信号工具:
- `propose_plan` 抛出编译计划请负责人批准(Plan 阶段对齐后调用,然后等批准)。
- `report_summary` 汇报一段进度。
- `resolve_ticket` 回修完一条矛盾工单后**逐条**登记(见下"应用裁决")。

**矛盾工单 `authoring/CONTRADICTIONS.json`(Execute 期间你用 Write 自己维护)** —— 一个 JSON 数组,每条 = 一个你搞不定的矛盾:
`{"id": 稳定指纹(如 kind+涉及来源), "title": 短标题, "question": 一句话大白话问题, "sources": [{"doc": 来源文件, "quote": 原文摘录}], "options": [候选值本身的干净写法(如 1.30.2-cks、52台),别加"为准/以…为准"之类话术,UI 会自己加], "current_value": 你写进页面的 best-guess 取值, "affected_pages": [受影响的 candidate 文件名], "status": "open", "answer": null}`
**你永远不阻塞、不等裁决 —— 一律 best-guess 落页 + 标 `⚠️ 存疑` + 落一条工单,编到底。** 工单初次落盘时 `status:"open"`、`answer:null`;`answer` 一直不用你管(负责人的答案在系统侧),`status` 平时保持 `open`。

**应用裁决**:负责人事后会在「矛盾处理」里逐条给出正确答案,你会收到一条「应用以下裁决」指令,里面给你若干 `{ticket_id, affected_pages, 正确值}`。对每条:打开对应 `affected_pages`,把该矛盾处改成正确值、并去掉那处的 `⚠️ 存疑` 标注;若答案是"接受存疑/保留双源",就保持并列、不强行定论。**只动被点名的页,别的页不碰。** **每处理完一条(包括"接受存疑"那种不改值的),都必须立刻调一次 `resolve_ticket(ticket_id, applied_value, pages_edited, note)`** —— 这是唯一能让工单"解单"的动作(负责人侧没有手动关单按钮、全靠它):`applied_value` = 你实际写进页里的值(接受存疑就写"保留双源");`pages_edited` = 你这条实际改动的 candidate 文件名,**必须覆盖该工单的 `affected_pages`**(漏页负责人侧会被自动标"待核");`note` = 一句话说你改了什么。**一条一个、别批量、别漏页**;**别再手工去改 `CONTRADICTIONS.json` 的 `status`**,该工具会替你写。全部回修完再简短回一句总体动了哪几页。

边界诚实:`raw/` 里查不到的不编、不脑补。"""

# BOX_COMPILE_TASK = the compile KICKOFF (→ first user turn on /compile only). In
# the unified session model "compile" is just an action within the conversation;
# the legacy one-shot /compile path seeds it so the box starts producing at once.
BOX_COMPILE_TASK = """现在把 `raw/` 编译成候选知识页,逐页 Write 进 `candidate/`:
- 先读 `authoring/CLAUDE.md`、`authoring/manifest.yaml`、`authoring/INTENT.md`、`authoring/PLAN.md`、`authoring/QUESTIONS.md`、`authoring/LEDGER.md`;如这些资产缺失,立刻汇报错误,不要靠聊天记忆重建;
- 逐篇读 `raw/`,抽原子断言(每条短、可独立判真伪,记清 source id/文件/locator);
- 跨断言检矛盾,照 `authoring/CLAUDE.md` 和 `constitution.md` 裁:能并列的(版本/口径/配置/时点差异)→ 并列保留各取值、各挂条件;明显笔误 → 标记修正;
- 不可约的真冲突用 `park_contradictions` 抛给负责人裁决,按裁决继续编;
- 期间可多次用 `report_summary` 汇报进度(产出哪些页、自动并了哪些矛盾);
- 按主题把断言聚成 candidate 页,**一页一个文件 Write 进 `candidate/`**,每页 frontmatter 至少含 `compiled_from`、`snapshot`、`last_updated`、`confidence/status`,每条结论后标 source id + locator;最后写一个 `candidate/index.md` 列出各页;
- 视情况更新 `eval/TESTS.md`(红蓝测试/覆盖检查结果,或标记跳过原因)。

**执行纪律:必须真的用 Write 工具把每一篇页面写成 `candidate/` 下的文件,不能只在回复里"描述"或"计划"。把所有页面(含 `candidate/index.md`)逐一落盘后,这一轮就完成了 —— 你不需要"提交"或"打包"任何东西,负责人会另行审阅并一键发布。除非用 `park_contradictions` 抛裁决,否则不要中途停下等我确认。**"""

# Nudge an incomplete compile turn that ended (ResultMessage) without submit_bundle.
MAX_COMPILE_NUDGES = 8
COMPILE_CONTINUE_NUDGE = (
    "你还没有调用 submit_bundle,编译没完成。不要只描述——现在继续用 Write 工具把剩余的候选页"
    "真正写进 `candidate/` 和 `bundle/`(每页一个文件),写好 `bundle/index.md`,全部落盘后调用 "
    "`submit_bundle` 提交。如遇不可约矛盾,用 `park_contradictions` 抛给负责人裁决。"
)

# TEST_ROLE = the standing identity of a read-only TEST SESSION (起测试会话). It is
# NOT the authoring/SRE persona — deliberately just a knowledge CONSUMER over the
# pinned wiki snapshot, so the test measures the wiki, not the agent's tools. The
# wiki-read instructions mirror the real siclaw consumer (siclaw_main
# src/core/prompt.ts "Domain Knowledge — LLM Wiki"): Read tool only, no search,
# start at index.md, whole pages, follow [[links]]. Max fidelity: do NOT tell it
# it's being tested.
TEST_ROLE = """你是一个只读的知识消费者。你掌握的全部知识,就是当前工作目录下的这个 LLM-Wiki —— 一组扁平的 markdown 页面,位于 `.siclaw/knowledge/`。

- 用 Read 工具读它,**没有检索工具**。先读 `.siclaw/knowledge/index.md`(列出各组件/概念及一句话说明),挑与问题相关的页。
- **整页读**。每页自成一体,片段式阅读会破坏它支撑的推理。
- 页面里出现 `[[xxx]]` 双括号时,去读 `.siclaw/knowledge/xxx.md`;对每个双括号名字都一样处理。

只依据这个 wiki 里的内容回答用户的问题;wiki 里查不到的,直说"这个 wiki 里没有",**绝不编造、绝不脑补**。你是只读的:**绝不写文件、绝不改动任何东西**。自然作答,就当一个真实用户在问你问题。"""


def _max_test_sessions() -> int:
    return int(os.environ.get("KBC_MAX_TEST_SESSIONS", "3"))


def _test_snapshot_root() -> str:
    return os.environ.get("KBC_TEST_SNAPSHOT_ROOT", "/tmp/kbc-tests")


# 编译驱动可替换:生产 = run_compile(真 Agent SDK);测试 = 注入假驱动,免烧 LLM 验协议管线。
_COMPILE_IMPL = None  # set at bottom to run_compile
# Same injection seam for the read-only test-session driver (set at bottom).
_TEST_SESSION_IMPL = None


class CompileRun:
    def __init__(self, run_id: str, workdir: str, round_: int, instruction: str = ""):
        self.run_id = run_id
        self.workdir = workdir
        self.round = round_
        self.instruction = instruction
        self.ledger_ref = f"run://{run_id}"
        self.events: asyncio.Queue = asyncio.Queue()
        self.pending_park: asyncio.Future | None = None  # 非 None = 正 park 等裁决
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
        # Set once connect() has returned (success OR failure). A /message that
        # races ahead of the async connect waits on this so client.query() never
        # hits the SDK's "Not connected. Call connect() first." error.
        self.connected: asyncio.Event = asyncio.Event()
        # kickoff: the first user turn sent on connect. None = conversational
        # session (connect and wait for the first /message, i.e. prepare chat);
        # set by /compile to BOX_COMPILE_TASK so the box starts producing at once.
        self.kickoff: str | None = None
        # A compile turn is in flight (set by /compile-turn). Models sometimes end
        # the turn after narrating intent without actually writing the bundle; the
        # session loop auto-continues such an incomplete compile (nudge until
        # submit_bundle) up to compile_nudges, then fails cleanly.
        self.compiling: bool = False
        self.compile_nudges: int = 0
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

    def __init__(self, tid: str, cwd: str, parent_run_id: str, snapshot_hash: str):
        self.tid = tid
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


def _tar_gz(dir_path: Path) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for f in sorted(dir_path.rglob("*")):
            if f.is_file():
                tf.add(str(f), arcname=str(f.relative_to(dir_path)))
    return buf.getvalue()


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


def _ensure_workdir_constitution(workdir: str):
    """Make the prompt's file contract true for source-bundle driven runs."""
    wd = Path(workdir)
    wd.mkdir(parents=True, exist_ok=True)
    dest = wd / "constitution.md"
    if dest.exists():
        return
    pb = _find_playbook()
    text = pb.read_text() if pb and pb.exists() else "# Compile constitution\n\nUse the system prompt as the compilation constitution.\n"
    dest.write_text(text)


def _install_source_bundle(bundle: bytes, workdir: str, expected_sha256: str | None = None) -> dict:
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
        _ensure_workdir_constitution(workdir)
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


def _install_authoring_bundle(bundle: bytes, workdir: str, expected_sha256: str | None = None) -> dict:
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
        _ensure_workdir_constitution(workdir)
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


async def _emit_done_from_bundle(run: CompileRun) -> tuple[list[Path], int, str | None]:
    bundle_dir = Path(run.workdir) / "bundle"
    # Guard against the agent declaring success without actually persisting
    # pages. The same validation is used for explicit submit and the wrapper
    # fallback after a live Claude session exits.
    files = [f for f in bundle_dir.rglob("*") if f.is_file()] if bundle_dir.exists() else []
    if not files:
        return files, 0, "ERROR: bundle/ 是空的 —— 请先用 Write 把各主题页和 bundle/index.md 真正写进 bundle/,再调 submit_bundle。"
    if not any(f.name == "index.md" for f in files):
        return files, 0, "ERROR: bundle/ 缺 index.md —— 写一个 bundle/index.md(列各页)再提交。"

    data = _tar_gz(bundle_dir)
    run.done = True
    run.compiling = False  # bundle submitted → compile complete, stop auto-continue
    await run.emit({"type": "done", "bundle_b64": base64.b64encode(data).decode(), "bytes": len(data)})
    return files, len(data), None


def _make_compile_tools(run: CompileRun):
    """构造 box 的自定义工具(闭包持有 run),= 护城河信号面。"""

    @tool("report_summary", "汇报一段编译进度总结(产出/已并矛盾/待裁),一句到一段话。", {"summary": str})
    async def report_summary(args):
        await run.emit({"type": "summary", "summary": args.get("summary", "")})
        return {"content": [{"type": "text", "text": "summary recorded"}]}

    @tool(
        "park_contradictions",
        "把一批不可约的真冲突抛给负责人裁决,然后阻塞等待。返回负责人的 rulings,据此继续编。",
        {"contradictions": list},
    )
    async def park_contradictions(args):
        checkpoint = {
            "round": run.round,
            "contradictions": args.get("contradictions", []),
            "ledger_ref": run.ledger_ref,
        }
        run.pending_park = asyncio.get_event_loop().create_future()
        await run.emit({"type": "parked", "checkpoint": checkpoint})
        rulings = await run.pending_park  # 阻塞到 POST /rulings
        run.pending_park = None
        run.round += 1
        return {"content": [{"type": "text", "text": json.dumps({"rulings": rulings}, ensure_ascii=False)}]}

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
    """KBC_SMOKE=1: prove the sicore↔runtime↔box wiring + park/rule/publish loop
    in-cluster WITHOUT calling an LLM (the real compile is validated separately)."""
    await run.emit({"type": "summary", "summary": "[smoke] wiring check — no LLM"})
    fut = asyncio.get_event_loop().create_future()
    run.pending_park = fut
    await run.emit({"type": "parked", "checkpoint": {
        "round": run.round,
        "contradictions": [{"id": "smoke-c1", "summary": "[smoke] pick a value", "evidence": [], "options": ["A", "B", "unsure"]}],
        "ledger_ref": run.ledger_ref,
    }})
    await fut  # blocks until POST /rulings
    run.pending_park = None
    bdir = Path(run.workdir) / "bundle"
    bdir.mkdir(parents=True, exist_ok=True)
    (bdir / "index.md").write_text("# smoke bundle\n\nWiring e2e — no real content.\n")
    data = _tar_gz(bdir)
    run.done = True
    await run.emit({"type": "done", "bundle_b64": base64.b64encode(data).decode(), "bytes": len(data)})


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
    for this KB. BOX_ROLE (+ the playbook + the attempt instruction) is the standing
    system prompt; the session then takes turns via POST /message — continuous
    prepare + compile in one session, on massapi, with the compile tools.

    Two start modes: a conversational session (`run.kickoff` is None) connects and
    waits for the first /message (prepare chat); the legacy compile path sets
    `run.kickoff` = BOX_COMPILE_TASK so the agent starts producing immediately,
    then stays alive for follow-up turns. (Durable cross-restart resume + a
    file-backed session store land in P4; v1 uses an in-process store.)"""
    wd = str(Path(run.workdir).resolve())
    pb = _find_playbook()
    playbook = pb.read_text() if pb and pb.exists() else ""
    instruction = (run.instruction or "").strip()
    role_parts = []
    if playbook:
        role_parts.append(playbook)
    role_parts.append(BOX_ROLE)
    if instruction:
        role_parts.append("# 本次 authoring attempt 的负责人说明\n\n" + instruction)
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
        # kickoff set → start producing now (compile); None → connect and block for
        # the first /message (prepare chat). An empty AsyncIterable keeps the session
        # open server-side until a turn is injected. Set run.client + signal
        # run.connected only AFTER connect() returns, so a /message that races ahead
        # of connect waits (handle_message) instead of hitting the SDK's
        # "Not connected. Call connect() first." error.
        if run.kickoff:
            await client.connect(prompt=run.kickoff)
        else:
            await client.connect()
        run.client = client
        run.connected.set()
        await run.emit({"type": "session", "session_id": sid})
        # receive_messages() is the persistent stream: it yields this turn's
        # output, then blocks for the next turn (injected via POST /message),
        # keeping the session alive until the box is stopped/cancelled.
        async for msg in client.receive_messages():
            await _emit_message(run, msg)
            # A compile turn ends like any other turn: one query → one ResultMessage.
            # The candidate pages it wrote to candidate/ are synced and become the
            # current draft; the owner reviews and publishes separately (deterministic
            # publish, no submit_bundle gate). A finished turn is simply finished — no
            # nudging — so a live session can never get stuck "compiling".
            if type(msg).__name__ == "ResultMessage":
                run.compiling = False
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
        # Only the compile path (kickoff set) is expected to produce a bundle: if
        # it ended without one, try the bundle dir as a fallback else surface the
        # failure. A conversational session (no kickoff) legitimately ends with no
        # bundle on shutdown, so it must NOT emit a spurious compile failure.
        if not run.done and run.kickoff:
            _, _, error = await _emit_done_from_bundle(run)
            if error:
                await run.emit({"type": "error", "error": "compile ended without submitting a bundle"})
        await run.emit({"type": "end"})


# Default tool whitelist for a read-only kb-test session, used when the runtime
# profile declares none. Read-only by construction: cannot mutate the snapshot.
DEFAULT_TEST_ALLOWED_TOOLS = ["Read", "Glob", "Grep"]


async def test_session_driver(run: "TestRun"):
    """Read-only consumer driver: host a ClaudeSDKClient over the pinned snapshot
    dir, tools limited to the kb-test profile's whitelist (default Read/Glob/Grep),
    persona = TEST_ROLE, no MCP, no kickoff. A conversational session — connects and
    waits for the first /test-message; each turn streams log + turn_done over GET
    /test-events. Mirrors run_session minus writes/compile-tools/sync/bundle."""
    sid = run.session_id or str(uuid.uuid4())
    run.session_id = sid
    opts = ClaudeAgentOptions(
        cwd=run.cwd,
        system_prompt={"type": "preset", "preset": "claude_code", "append": TEST_ROLE},
        allowed_tools=run.allowed_tools or DEFAULT_TEST_ALLOWED_TOOLS,
        mcp_servers={},                            # no compile signal tools
        permission_mode="bypassPermissions",       # pod 本身即 sandbox
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

async def handle_compile(request: web.Request):
    body = await request.json()
    run_id = body.get("run_id")
    if not run_id:
        return web.json_response({"error": "run_id is required"}, status=400)
    if run_id in RUNS:
        return web.json_response({"error": "run already exists", "run_id": run_id}, status=409)
    run = CompileRun(run_id, body.get("workdir", "/work"), int(body.get("round", 1)), body.get("instruction", ""))
    run.kickoff = BOX_COMPILE_TASK  # /compile starts producing immediately
    _seed_workdir(run.workdir)
    _ensure_workdir_constitution(run.workdir)
    RUNS[run_id] = run
    run.task = asyncio.create_task(_run_wrapper(run))
    return web.json_response({"ok": True, "run_id": run_id})


async def handle_session(request: web.Request):
    """Start (or no-op attach to) the run's persistent CONVERSATIONAL session.
    Unlike /compile this seeds NO kickoff — the session connects and waits for the
    first /message (prepare chat). Idempotent: a second call for a live run is a
    no-op, so the runtime can safely ensure-then-message."""
    run_id = request.match_info["run_id"]
    if run_id in RUNS:
        return web.json_response({"ok": True, "run_id": run_id, "already_live": True})
    body = await request.json() if request.body_exists else {}
    run = CompileRun(run_id, body.get("workdir", "/work"), int(body.get("round", 1)), body.get("instruction", ""))
    # Tool whitelist from the runtime BoxProfile (None/absent → driver default).
    run.allowed_tools = body.get("allowed_tools")
    # kickoff stays None → conversational; the agent waits for POST /message.
    _seed_workdir(run.workdir)
    _ensure_workdir_constitution(run.workdir)
    RUNS[run_id] = run
    run.task = asyncio.create_task(_run_wrapper(run))
    return web.json_response({"ok": True, "run_id": run_id})


async def handle_sources(request: web.Request):
    body = await request.json()
    run_id = body.get("run_id")
    if run_id and run_id in RUNS:
        return web.json_response({"error": "run already exists; upload sources before /compile", "run_id": run_id}, status=409)

    encoded = body.get("bundle_base64") or body.get("bundle_b64")
    if not encoded:
        return web.json_response({"error": "bundle_base64 is required"}, status=400)

    try:
        bundle = base64.b64decode(encoded, validate=True)
        result = _install_source_bundle(bundle, body.get("workdir", "/work"), body.get("bundle_sha256"))
    except (ValueError, TypeError) as e:
        return web.json_response({"error": str(e)}, status=400)

    if run_id:
        result["run_id"] = run_id
    return web.json_response({"ok": True, **result})


async def handle_authoring(request: web.Request):
    # NOTE: authoring assets are just installed into the workspace (/work/authoring),
    # independent of run state — so this is allowed on a LIVE session run too. The
    # unified compile-in-session path (compile.runInSession) uploads the authoring
    # bundle to the already-running session right before triggering /compile-turn;
    # rejecting a live run here would leave /work/authoring empty and the compile
    # would abort ("authoring assets missing").
    body = await request.json()
    run_id = body.get("run_id")
    encoded = body.get("bundle_base64") or body.get("bundle_b64")
    if not encoded:
        return web.json_response({"error": "bundle_base64 is required"}, status=400)

    try:
        bundle = base64.b64decode(encoded, validate=True)
        result = _install_authoring_bundle(bundle, body.get("workdir", "/work"), body.get("bundle_sha256"))
    except (ValueError, TypeError) as e:
        return web.json_response({"error": str(e)}, status=400)

    if run_id:
        result["run_id"] = run_id
    return web.json_response({"ok": True, **result})


async def handle_rulings(request: web.Request):
    body = await request.json()
    run_id = body.get("run_id")
    run = RUNS.get(run_id)
    if not run:
        return web.json_response({"error": "unknown run"}, status=404)
    if not run.pending_park or run.pending_park.done():
        return web.json_response({"error": "run is not parked"}, status=409)
    run.pending_park.set_result(body.get("rulings", []))
    return web.json_response({"ok": True})


async def _await_session_live(run: CompileRun):
    """Wait for the run's async connect() to finish, then validate the session.
    Returns an error Response if the session is unusable, else None. Shared by
    /message and /compile-turn: the session connects in the background after
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


async def handle_compile_turn(request: web.Request):
    """Run a compile as a turn in the LIVE conversational session (the unified
    'compile in the same session' path). The box owns the compile instruction
    (BOX_COMPILE_TASK); sicore just triggers it, so the agent — which already read
    the docs in this session — produces the bundle on the SAME box. submit_bundle /
    park_contradictions ride this same session; the result streams over GET /events."""
    run = RUNS.get(request.match_info["run_id"])
    if not run:
        return web.json_response({"error": "unknown run"}, status=404)
    err = await _await_session_live(run)
    if err is not None:
        return err
    body = await request.json() if request.body_exists else {}
    instruction = (body.get("instruction") or "").strip()
    task = BOX_COMPILE_TASK
    if instruction:
        task = BOX_COMPILE_TASK + "\n\n# 本轮额外要求\n\n" + instruction
    run.compiling = True
    run.compile_nudges = 0
    await run.client.query(task)
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
    run = TestRun(tid, str(dest), parent_run_id=parent.run_id, snapshot_hash=snapshot_hash)
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
        web.post("/compile", handle_compile),
        web.post("/session/{run_id}", handle_session),
        web.post("/rulings", handle_rulings),
        web.post("/message/{run_id}", handle_message),
        web.post("/compile-turn/{run_id}", handle_compile_turn),
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
