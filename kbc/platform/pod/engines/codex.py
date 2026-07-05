#!/usr/bin/env python3
"""engines.codex — OpenAI Codex CLI adapter (subscription-backed second engine).

Shape (DESIGN-kb-box-codex-engine-2026-07-02):
  - v1 drives `codex exec --json` / `codex exec resume <thread> - --json` — one
    subprocess per turn, prompt over stdin. This is the surface the desktop
    spike validated against the PINNED CLI (0.139.0); the beta Python SDK wraps
    the same event vocabulary, so swapping to it later is contained here.
  - The standing role (playbook + BOX_ROLE + attempt instruction) is written to
    <cwd>/AGENTS.md — codex reads it natively; no prompt-injection mechanism to
    maintain.
  - The four compile-signal tools reach codex through a stdio MCP server
    (mcp_compile_server.py, declared in $CODEX_HOME/config.toml) whose
    tools/call POSTs back to a loopback-only listener owned by this session;
    the callback executes the same engine-neutral bodies (compile_tools.py).
  - Turns are SERIALIZED: codex has no mid-turn steering, so a query() landing
    during a live turn queues as the next turn (the owner-facing semantics stay
    "never blocks"; the reply just rides the following turn).

Auth invariant (§3): the box holds ONLY a short-TTL access token
(CODEX_ACCESS_TOKEN, forwarded at spawn by the kb-compile-codex BoxProfile).
auth.json is written with refresh_token EMPTY and last_refresh=now so the CLI
never attempts a refresh — sicore is the SINGLE refresher; a box that rotated
the refresh token would kill every other consumer of the same subscription.
An expired/rejected token surfaces as an explicit `error` event (no silent
retry — subscription quota must not be burned by loops); v1 recovery is a box
respawn with a fresh token. CODEX_API_KEY, when present, wins over the
subscription token (the official automation path, zero-architecture-change).

kind="test" is refused: codex's sandbox limits writes but NOT reads, so the C4
snapshot-read confinement has no hook equivalent — read-only test sessions on
codex require the dedicated snapshot-only box (P4, structural isolation).
"""
import asyncio
import json
import os
import secrets
import shlex
import uuid
from datetime import datetime, timezone
from pathlib import Path

from aiohttp import web

import compile_tools
from .base import SessionSpec

_CLOSED = object()  # events() sentinel


def _env_int(name: str, default: int) -> int:
    return int(os.environ.get(name, str(default)))


class CodexEngineSession:
    """EngineSession on the codex CLI: one subprocess per turn, resumed on the
    same thread id; events stream through an internal queue."""

    def __init__(self, spec: SessionSpec):
        if spec.kind != "test" and spec.kind != "compile":
            raise ValueError(f"unknown session kind {spec.kind!r}")
        if spec.kind == "test":
            # C4 has no codex hook equivalent (sandbox limits writes, not reads).
            # Structural isolation (a dedicated snapshot-only box) is the P4 plan.
            raise NotImplementedError(
                "read-only test sessions are not supported on the codex engine; "
                "use the claude box, or the dedicated kb-test snapshot box (P4)"
            )
        self.spec = spec
        self.session_id = spec.session_id or str(uuid.uuid4())
        self._bin = os.environ.get("KBC_CODEX_BIN", "codex")
        self._home = Path(os.environ.get("KBC_CODEX_HOME") or (Path(spec.cwd) / ".codex"))
        self._sandbox = os.environ.get("KBC_CODEX_SANDBOX", "workspace-write")
        self._thread_id: str | None = None
        self._events: asyncio.Queue = asyncio.Queue()
        self._prompts: asyncio.Queue = asyncio.Queue()
        self._worker: asyncio.Task | None = None
        self._proc: asyncio.subprocess.Process | None = None
        self._callback_runner: web.AppRunner | None = None
        self._callback_token = secrets.token_hex(16)
        self.callback_url: str | None = None  # set by start(); exposed for tests

    # ── lifecycle ──

    async def start(self) -> None:
        self._home.mkdir(parents=True, exist_ok=True)
        self._write_auth()
        await self._start_callback_listener()
        self._write_config()
        self._write_agents_md()
        self._worker = asyncio.create_task(self._turn_worker())

    async def query(self, text: str, session_id: str = "default") -> None:
        await self._prompts.put(text)

    async def events(self):
        while True:
            ev = await self._events.get()
            if ev is _CLOSED:
                return
            yield ev

    async def close(self) -> None:
        if self._worker is not None:
            self._worker.cancel()
            try:
                await self._worker
            except asyncio.CancelledError:
                pass
            self._worker = None
        if self._proc is not None and self._proc.returncode is None:
            self._proc.kill()
        self._proc = None
        if self._callback_runner is not None:
            await self._callback_runner.cleanup()
            self._callback_runner = None
        await self._events.put(_CLOSED)

    # ── start() pieces ──

    def _write_auth(self) -> None:
        """Materialize codex credentials. Boundary validation: no credentials is
        a deployment error — fail loudly before the first turn, not mid-compile."""
        api_key = os.environ.get("CODEX_API_KEY", "").strip()
        access = os.environ.get("CODEX_ACCESS_TOKEN", "").strip()
        path = self._home / "auth.json"
        if api_key:
            auth = {"auth_mode": "apikey", "OPENAI_API_KEY": api_key, "tokens": None}
        elif access:
            # Subscription mode. id_token = access token placeholder (the access
            # token itself carries the email/plan claims codex parses); EMPTY
            # refresh_token + last_refresh=now → the CLI can never rotate the
            # subscription's refresh token out from under sicore.
            auth = {
                "auth_mode": "chatgpt",
                "OPENAI_API_KEY": None,
                "tokens": {
                    "id_token": access,
                    "access_token": access,
                    "refresh_token": "",
                    "account_id": os.environ.get("CODEX_ACCOUNT_ID", ""),
                },
                "last_refresh": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z",
            }
        else:
            raise RuntimeError(
                "codex engine has no credentials: set CODEX_ACCESS_TOKEN (subscription, "
                "short-TTL, forwarded by the kb-compile-codex profile) or CODEX_API_KEY"
            )
        path.write_text(json.dumps(auth), "utf-8")
        path.chmod(0o600)

    async def _start_callback_listener(self) -> None:
        """Loopback-only HTTP listener the stdio MCP server calls back into.
        Ephemeral port + per-session bearer token; runs the engine-neutral tool
        bodies with THIS run's emit, so a signal behaves exactly as on claude."""
        app = web.Application()
        app.add_routes([web.post("/tool-call", self._handle_tool_call)])
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        self._callback_runner = runner
        self.callback_url = f"http://127.0.0.1:{port}/tool-call"

    async def _handle_tool_call(self, request: web.Request):
        if request.headers.get("x-kbc-token") != self._callback_token:
            return web.json_response({"error": "bad token"}, status=403)
        body = await request.json()
        name = str(body.get("name", ""))
        args = body.get("arguments") or {}
        try:
            text = await compile_tools.execute_compile_tool(
                name, args, workdir=self.spec.workdir or self.spec.cwd, emit=self.spec.emit)
        except KeyError:
            return web.json_response({"error": f"unknown tool {name!r}"}, status=400)
        return web.json_response({"text": text})

    def _write_config(self) -> None:
        """$CODEX_HOME/config.toml: model pin + the compile MCP server. Written
        whole (the home dir is session-owned) — no merge semantics to maintain."""
        server_py = Path(__file__).resolve().parent.parent / "mcp_compile_server.py"
        lines = []
        model = os.environ.get("KBC_CODEX_MODEL", "").strip()
        if model:
            lines.append(f"model = {json.dumps(model)}")
        lines += [
            "[mcp_servers.compile]",
            f"command = {json.dumps(os.environ.get('KBC_PYTHON_BIN', 'python3'))}",
            f"args = [{json.dumps(str(server_py))}]",
            "",
            "[mcp_servers.compile.env]",
            f"KBC_COMPILE_CALLBACK_URL = {json.dumps(self.callback_url)}",
            f"KBC_COMPILE_CALLBACK_TOKEN = {json.dumps(self._callback_token)}",
        ]
        (self._home / "config.toml").write_text("\n".join(lines) + "\n", "utf-8")

    def _write_agents_md(self) -> None:
        """The standing role rides <cwd>/AGENTS.md (codex reads it natively).
        The workdir root is box-owned (sources live under raw/), so overwriting
        is safe and keeps the role current across respawns."""
        text = self.spec.system_prompt + (
            "\n\n---\n\n# 引擎注记(codex)\n\n"
            "- 本镜像已预装机械工具依赖(pdfplumber/python-pptx/openpyxl/pyyaml/pypdfium2):"
            "直接 `python3` 跑 tools/ 即可,**不要建 venv、不要 pip install**(沙箱内没有外网)。\n"
        )
        raw = Path(self.spec.cwd) / "raw"
        if raw.is_dir() and any(raw.rglob("*.pages")):
            text += (
                "- PDF 这类二进制原料你无法直接读。系统已把 PDF 逐页渲染成图片,放在原文件旁的 "
                "`<文件名>.pages/page-NNN.png`;优先读同名 markdown/文本抽取(若有),表格、图示或存疑处"
                "再看对应页图确认。\n"
            )
        (Path(self.spec.cwd) / "AGENTS.md").write_text(text, "utf-8")

    # ── turn execution ──

    async def _turn_worker(self) -> None:
        while True:
            prompt = await self._prompts.get()
            try:
                await self._run_turn(prompt)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # engine boundary: a broken turn must not kill the session
                await self._events.put({"type": "error", "error": f"codex turn crashed: {e!r}"})
                await self._events.put({"type": "turn_end"})

    def _turn_argv(self, first: bool) -> list[str]:
        argv = [self._bin, "exec"]
        if not first and self._thread_id:
            argv += ["resume", self._thread_id]
        # `-` = read the prompt from stdin: immune to argv length limits (apply-
        # rulings messages can be long) and to prompts that start with "-".
        argv += ["--json", "--skip-git-repo-check", "-s", self._sandbox, "-"]
        return argv

    async def _run_turn(self, prompt: str) -> None:
        """One user turn = one codex subprocess. Always closes with turn_end
        (exactly once) so the box's sync/selfcheck/turn_done pipeline runs and
        the never-stuck invariant holds on every path (ok / fail / timeout)."""
        first = self._thread_id is None
        argv = self._turn_argv(first)
        env = dict(os.environ)
        env["CODEX_HOME"] = str(self._home)
        proc = await asyncio.create_subprocess_exec(
            *argv,
            cwd=self.spec.cwd,
            env=env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        self._proc = proc
        timeout = float(os.environ.get("KBC_CODEX_TURN_TIMEOUT_SECS", "3600"))
        try:
            await asyncio.wait_for(self._pump_turn(proc, prompt), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            await self._events.put({
                "type": "error",
                "error": f"codex turn exceeded {timeout:.0f}s wall-clock guardrail "
                         f"(KBC_CODEX_TURN_TIMEOUT_SECS) and was killed: {shlex.join(argv)}",
            })
        finally:
            # Cancel path: close() cancels the worker mid-turn, so a CancelledError
            # lands here with the subprocess possibly still alive. Terminate it BEFORE
            # nulling _proc — otherwise close()'s own kill check sees _proc=None and a
            # torn-down turn leaks a live `codex exec` process burning subscription
            # quota. Bounded wait so a stuck process still can't hang teardown.
            if proc.returncode is None:
                proc.terminate()
                try:
                    await asyncio.wait_for(proc.wait(), timeout=5)
                except (asyncio.TimeoutError, asyncio.CancelledError):
                    proc.kill()
            self._proc = None
            await self._events.put({"type": "turn_end"})

    async def _pump_turn(self, proc, prompt: str) -> None:
        proc.stdin.write(prompt.encode("utf-8"))
        await proc.stdin.drain()
        proc.stdin.write_eof()
        max_events = _env_int("KBC_CODEX_MAX_TURN_EVENTS", 10000)
        seen = 0
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            seen += 1
            if seen > max_events:
                proc.kill()
                await self._events.put({
                    "type": "error",
                    "error": f"codex turn exceeded {max_events} events (KBC_CODEX_MAX_TURN_EVENTS); killed",
                })
                break
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue  # codex may interleave non-JSON diagnostics; events are JSONL
            await self._relay_codex_event(ev)
        stderr = (await proc.stderr.read()).decode("utf-8", "replace")
        rc = await proc.wait()
        if rc != 0:
            tail = stderr.strip().splitlines()[-8:]
            await self._events.put({
                "type": "error",
                "error": f"codex exec exited {rc}: " + (" | ".join(tail) or "(no stderr)"),
            })

    async def _relay_codex_event(self, ev: dict) -> None:
        """codex --json JSONL → the neutral engine vocabulary. Tolerant reader:
        only the fields the box contract needs are interpreted; everything else
        (command executions, file changes, token usage) is ignored by design."""
        etype = str(ev.get("type", ""))
        if etype == "thread.started":
            tid = ev.get("thread_id") or ev.get("thread", {}).get("id")
            if tid:
                self._thread_id = str(tid)
        elif etype == "item.completed":
            item = ev.get("item") or {}
            itype = item.get("item_type") or item.get("type")
            if itype == "agent_message":
                text = (item.get("text") or item.get("message") or "").strip()
                if text:
                    await self._events.put({"type": "text", "text": text})
        elif etype in ("turn.failed", "error"):
            detail = ev.get("error") or ev.get("message") or ev
            await self._events.put({"type": "error", "error": f"codex: {detail}"})
        # turn.completed carries usage; the subprocess exit closes the turn.
