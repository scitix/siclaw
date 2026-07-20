"""Codex SDK adapter for the KBC compile box.

This module is the only persistent-session code in KBC that imports the
OpenAI Codex SDK.  ``compile_box`` keeps its existing Claude message-shaped
orchestration and asks this adapter for a duck-compatible client when the
consumer selects ``codex_sdk``.

Codex exposes application tools through MCP rather than in-process Python
callables.  The adapter therefore hosts a loopback-only callback endpoint and
starts ``mcp_tool_server.py`` as a stdio MCP server.  The subprocess only
speaks MCP; every tool body still executes in this process against the live
``CompileRun``.  That keeps plan/ticket/summary semantics identical across
engines and prevents a second implementation of KBC policy.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import shutil
import sys
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable, Iterable, Iterator, Mapping

from aiohttp import web


@dataclass(frozen=True)
class EngineTool:
    """One engine-neutral MCP tool owned by KBC."""

    name: str
    description: str
    input_schema: dict
    handler: Callable[[dict], Awaitable[str]]


# Claude-message-shaped compatibility values.  ``compile_box`` deliberately
# dispatches by class name so these need only carry the fields it reads.
class TextBlock:
    def __init__(self, text: str):
        self.text = text


class ToolUseBlock:
    def __init__(self, name: str, input_: dict | None = None):
        self.name = name
        self.input = input_ or {}


class AssistantMessage:
    def __init__(self, content: list):
        self.content = content


class StreamEvent:
    pass


class ResultMessage:
    def __init__(
        self,
        *,
        is_error: bool = False,
        api_error_status: int | None = None,
        subtype: str = "success",
    ):
        self.is_error = is_error
        self.api_error_status = api_error_status
        self.subtype = subtype


_CLOSED = object()


def _toml(value: object) -> str:
    """JSON literals are valid TOML literals for the scalar/list shapes here."""
    return json.dumps(value, ensure_ascii=False)


def _status_from_error(value: object) -> int | None:
    text = str(value or "")
    match = re.search(r"(?:status|HTTP)\D{0,8}(429|503|529)\b", text, re.I)
    return int(match.group(1)) if match else None


def _safe_error_message(value: object, secret_values: Iterable[str] = ()) -> str:
    text = str(getattr(value, "message", value) or "Codex turn failed")
    for secret_value in secret_values:
        if secret_value:
            text = text.replace(secret_value, "[REDACTED]")
    text = re.sub(r"\bsk-[A-Za-z0-9_+\-/=]{8,}", "[REDACTED]", text)
    return text[:1000]


_READ_MAX_LINES = 500
_READ_MAX_CHARS = 200_000
_GLOB_MAX_RESULTS = 500
_GREP_MAX_RESULTS = 200
_GREP_MAX_FILES = 5_000
_GREP_MAX_FILE_BYTES = 2 * 1024 * 1024
_READ_TOOL_NAME_MAP = {
    "Read": "kbc_read_file",
    "Glob": "kbc_glob_files",
    "Grep": "kbc_grep_files",
}


class _ReadOnlyFileAccess:
    """Root-confined text inspection tools for closed-book Codex sessions."""

    def __init__(self, cwd: str, roots: Iterable[str | Path]):
        self.cwd = Path(cwd).resolve()
        self.roots = tuple(dict.fromkeys(Path(value).resolve() for value in roots))
        if not self.cwd.is_dir():
            raise ValueError(f"read-only cwd is not a directory: {self.cwd}")
        if not self.roots:
            raise ValueError("read-only Codex sessions require at least one allowed root")
        for root in self.roots:
            if not root.is_dir():
                raise ValueError(f"allowed read root is not a directory: {root}")

    def tools(self) -> list[EngineTool]:
        return [
            EngineTool(
                "kbc_read_file",
                "Read a UTF-8 text file inside the declared KBC snapshot roots. "
                "Returns numbered lines with bounded output.",
                {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Absolute path or path relative to the session cwd."},
                        "offset": {"type": "integer", "minimum": 1, "description": "First line to return (1-based)."},
                        "limit": {"type": "integer", "minimum": 1, "maximum": _READ_MAX_LINES},
                    },
                    "required": ["path"],
                    "additionalProperties": False,
                },
                self.read_file,
            ),
            EngineTool(
                "kbc_glob_files",
                "List regular files inside the declared KBC snapshot roots using a relative glob pattern.",
                {
                    "type": "object",
                    "properties": {
                        "pattern": {"type": "string", "description": "Relative glob such as **/*.md."},
                        "path": {
                            "type": "string",
                            "description": "Optional allowed directory; defaults to the session cwd.",
                        },
                        "max_results": {"type": "integer", "minimum": 1, "maximum": _GLOB_MAX_RESULTS},
                    },
                    "required": ["pattern"],
                    "additionalProperties": False,
                },
                self.glob_files,
            ),
            EngineTool(
                "kbc_grep_files",
                "Search for a literal string in bounded UTF-8 text files inside the declared KBC snapshot roots.",
                {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Literal text to find."},
                        "path": {
                            "type": "string",
                            "description": "Optional allowed directory; defaults to the session cwd.",
                        },
                        "pattern": {"type": "string", "description": "Relative file glob; defaults to **/*."},
                        "case_sensitive": {"type": "boolean"},
                        "max_results": {"type": "integer", "minimum": 1, "maximum": _GREP_MAX_RESULTS},
                    },
                    "required": ["query"],
                    "additionalProperties": False,
                },
                self.grep_files,
            ),
        ]

    def selected_tools(self, allowed_tools: Iterable[str] | None) -> list[EngineTool]:
        tools = self.tools()
        if allowed_tools is None:
            return tools
        requested = list(dict.fromkeys(allowed_tools))
        unknown = sorted(set(requested).difference(_READ_TOOL_NAME_MAP))
        if unknown:
            raise ValueError(
                "unsupported read-only Codex tools: " + ", ".join(unknown)
            )
        selected = {_READ_TOOL_NAME_MAP[name] for name in requested}
        return [item for item in tools if item.name in selected]

    def _resolve(self, value: object, *, default: Path | None = None) -> Path:
        if value is None and default is not None:
            candidate = default
        elif isinstance(value, str) and value.strip() and "\x00" not in value:
            raw = Path(value.strip())
            candidate = raw if raw.is_absolute() else self.cwd / raw
        else:
            raise ValueError("path must be a non-empty string")
        resolved = candidate.resolve()
        for root in self.roots:
            try:
                resolved.relative_to(root)
                return resolved
            except ValueError:
                continue
        raise ValueError(f"path is outside the allowed KBC snapshot roots: {value!r}")

    @staticmethod
    def _validated_pattern(value: object, *, default: str | None = None) -> str:
        pattern = default if value is None else value
        if not isinstance(pattern, str) or not pattern.strip() or "\x00" in pattern:
            raise ValueError("pattern must be a non-empty relative glob")
        pattern = pattern.strip()
        path = Path(pattern)
        if path.is_absolute() or ".." in path.parts:
            raise ValueError("pattern must be relative and cannot contain parent traversal")
        return pattern

    @staticmethod
    def _bounded_int(value: object, *, default: int, maximum: int, name: str) -> int:
        if value is None:
            return default
        if isinstance(value, bool) or not isinstance(value, int) or value < 1 or value > maximum:
            raise ValueError(f"{name} must be an integer from 1 to {maximum}")
        return value

    def _display(self, path: Path) -> str:
        try:
            return str(path.relative_to(self.cwd)) or "."
        except ValueError:
            return str(path)

    async def read_file(self, args: dict) -> str:
        path = self._resolve(args.get("path"))
        offset = self._bounded_int(args.get("offset"), default=1, maximum=10_000_000, name="offset")
        limit = self._bounded_int(args.get("limit"), default=200, maximum=_READ_MAX_LINES, name="limit")

        def read() -> str:
            if not path.is_file():
                raise ValueError(f"path is not a regular file: {self._display(path)}")
            lines: list[str] = []
            chars = 0
            truncated = False
            with path.open("r", encoding="utf-8", errors="replace") as handle:
                for line_number, line in enumerate(handle, 1):
                    if line_number < offset:
                        continue
                    if "\x00" in line:
                        raise ValueError(f"binary files are not supported: {self._display(path)}")
                    rendered = f"{line_number}: {line.rstrip()}"
                    if len(lines) >= limit or chars + len(rendered) + 1 > _READ_MAX_CHARS:
                        truncated = True
                        break
                    lines.append(rendered)
                    chars += len(rendered) + 1
            if not lines:
                return f"{self._display(path)}: no text at or after line {offset}"
            header = f"{self._display(path)} (lines {offset}-{offset + len(lines) - 1})"
            suffix = "\n[output truncated; request another offset]" if truncated else ""
            return header + "\n" + "\n".join(lines) + suffix

        return await asyncio.to_thread(read)

    async def glob_files(self, args: dict) -> str:
        base = self._resolve(args.get("path"), default=self.cwd)
        pattern = self._validated_pattern(args.get("pattern"))
        max_results = self._bounded_int(
            args.get("max_results"), default=200, maximum=_GLOB_MAX_RESULTS, name="max_results"
        )

        def glob() -> str:
            if not base.is_dir():
                raise ValueError(f"glob path is not a directory: {self._display(base)}")
            matches: list[str] = []
            for candidate in base.glob(pattern):
                try:
                    resolved = self._resolve(str(candidate))
                except ValueError:
                    continue
                if resolved.is_file():
                    matches.append(self._display(resolved))
                    if len(matches) >= max_results:
                        break
            matches.sort()
            if not matches:
                return "no matching files"
            suffix = "\n[results limited]" if len(matches) >= max_results else ""
            return "\n".join(matches) + suffix

        return await asyncio.to_thread(glob)

    async def grep_files(self, args: dict) -> str:
        query = args.get("query")
        if not isinstance(query, str) or not query or "\x00" in query:
            raise ValueError("query must be a non-empty literal string")
        base = self._resolve(args.get("path"), default=self.cwd)
        pattern = self._validated_pattern(args.get("pattern"), default="**/*")
        case_sensitive = args.get("case_sensitive", False)
        if not isinstance(case_sensitive, bool):
            raise ValueError("case_sensitive must be a boolean")
        max_results = self._bounded_int(
            args.get("max_results"), default=100, maximum=_GREP_MAX_RESULTS, name="max_results"
        )

        def grep() -> str:
            if not base.is_dir():
                raise ValueError(f"grep path is not a directory: {self._display(base)}")
            needle = query if case_sensitive else query.casefold()
            matches: list[str] = []
            files_seen = 0
            for candidate in base.glob(pattern):
                try:
                    path = self._resolve(str(candidate))
                except ValueError:
                    continue
                if not path.is_file() or path.stat().st_size > _GREP_MAX_FILE_BYTES:
                    continue
                files_seen += 1
                if files_seen > _GREP_MAX_FILES:
                    break
                try:
                    with path.open("r", encoding="utf-8", errors="replace") as handle:
                        for line_number, line in enumerate(handle, 1):
                            if "\x00" in line:
                                break
                            haystack = line if case_sensitive else line.casefold()
                            if needle in haystack:
                                rendered = f"{self._display(path)}:{line_number}: {line.rstrip()}"
                                matches.append(rendered[:4_000])
                                if len(matches) >= max_results:
                                    return "\n".join(matches) + "\n[results limited]"
                except OSError:
                    continue
            if not matches:
                return "no matches"
            suffix = "\n[file scan limited]" if files_seen > _GREP_MAX_FILES else ""
            return "\n".join(matches) + suffix

        return await asyncio.to_thread(grep)


def _copy_readonly_tree(source: Path, destination: Path) -> None:
    """Make an isolated filesystem view without preserving source symlinks.

    Use independent file copies rather than hard links. Writer sessions keep
    Pod-level full access, while closed-book sessions use root-confined read
    tools; either way, staging must never share mutable raw/candidate inodes.
    """

    def copy_file(src: str, dst: str) -> str:
        return shutil.copy2(src, dst)

    def ignore_symlinks(directory: str, names: list[str]) -> list[str]:
        return [name for name in names if Path(directory, name).is_symlink()]

    if source.is_dir():
        shutil.copytree(
            source,
            destination,
            copy_function=copy_file,
            ignore=ignore_symlinks,
        )
    elif source.is_file() and not source.is_symlink():
        destination.parent.mkdir(parents=True, exist_ok=True)
        copy_file(str(source), str(destination))
    else:
        raise ValueError(f"read-only source is not a regular file or directory: {source}")


@contextmanager
def isolated_readonly_workspace(sources: Mapping[str, str | Path]) -> Iterator[Path]:
    """Expose exactly ``sources`` in a disposable Codex workspace.

    Read-only subflows receive disposable copies of exactly the declared KBC
    trees (for example raw/ plus candidate/). The single-run Pod remains the
    process boundary; writes to the staged view cannot alter source artifacts.
    """
    state_root = Path(os.environ.get("KBC_CODEX_STATE_ROOT", "/work"))
    state_root.mkdir(parents=True, exist_ok=True)
    workspace = Path(tempfile.mkdtemp(prefix=".kbc-codex-ro-", dir=str(state_root)))
    try:
        for name, raw_source in sources.items():
            rel = Path(name)
            if rel.is_absolute() or len(rel.parts) != 1 or rel.name in {"", ".", ".."}:
                raise ValueError(f"invalid isolated workspace entry: {name!r}")
            source = Path(raw_source).resolve()
            _copy_readonly_tree(source, workspace / rel.name)
        yield workspace
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


class CodexSDKClient:
    """Persistent KBC session backed by the official ``openai-codex`` SDK.

    Public methods intentionally mirror ``ClaudeSDKClient`` so the mature KBC
    lifecycle (turn retries, stall watchdog, batch orchestration, sync and
    post-turn checks) remains engine-neutral without a parallel control loop.
    """

    def __init__(
        self,
        *,
        cwd: str,
        system_prompt: str,
        model: str,
        session_id: str,
        read_only: bool = False,
        allowed_read_roots: list[str] | None = None,
        allowed_read_tools: list[str] | None = None,
        tools: list[EngineTool] | None = None,
        writer_filesystem_access: Mapping[str, str] | None = None,
        reasoning_effort: str | None = None,
        max_tool_calls: int | None = None,
    ):
        self.cwd = str(Path(cwd).resolve())
        self.system_prompt = system_prompt
        self.model = model
        self.session_id = session_id
        self.read_only = read_only
        declared_tools = list(tools or [])
        if read_only:
            if writer_filesystem_access:
                raise ValueError("writer_filesystem_access is only valid for writer Codex sessions")
            file_access = _ReadOnlyFileAccess(cwd, allowed_read_roots or [cwd])
            read_tools = file_access.selected_tools(allowed_read_tools)
            reserved = set(_READ_TOOL_NAME_MAP.values())
            duplicates = sorted(reserved.intersection(item.name for item in declared_tools))
            if duplicates:
                raise ValueError(f"read-only tool names are reserved: {', '.join(duplicates)}")
            self.allowed_read_roots = tuple(str(root) for root in file_access.roots)
            self.tools = read_tools + declared_tools
        else:
            if allowed_read_roots:
                raise ValueError("allowed_read_roots is only valid for read-only Codex sessions")
            if allowed_read_tools is not None:
                raise ValueError("allowed_read_tools is only valid for read-only Codex sessions")
            self.allowed_read_roots = ()
            self.tools = declared_tools
        self.writer_filesystem_access: dict[str, str] = {}
        workspace_root = Path(self.cwd)
        for raw_path, access in (writer_filesystem_access or {}).items():
            if access not in {"read", "write", "deny"}:
                raise ValueError(f"invalid writer filesystem access {access!r} for {raw_path!r}")
            target = Path(raw_path).resolve()
            try:
                target.relative_to(workspace_root)
            except ValueError as error:
                raise ValueError(
                    f"writer filesystem override is outside the session workspace: {raw_path!r}"
                ) from error
            if target == workspace_root:
                raise ValueError("writer filesystem override cannot replace the workspace root")
            self.writer_filesystem_access[str(target)] = access
        # Mass GPT-5.6 high/medium can spend longer than KBC's 90s model-idle
        # safety bound before its first actionable item. Low still retains the
        # model's agentic workflow and is the reliable unattended default; a
        # deployment may raise it together with an appropriate watchdog bound.
        self.reasoning_effort = reasoning_effort or os.environ.get("KBC_CODEX_REASONING_EFFORT", "low")
        self.max_tool_calls = max_tool_calls if max_tool_calls is not None else int(
            os.environ.get("KBC_CODEX_MAX_TOOL_CALLS", os.environ.get("KBC_MAX_TURNS", "150"))
        )
        self._codex = None
        self._thread = None
        self._turn = None
        self._events: asyncio.Queue = asyncio.Queue()
        self._prompts: asyncio.Queue = asyncio.Queue()
        self._worker: asyncio.Task | None = None
        self._callback_runner: web.AppRunner | None = None
        self._callback_token = secrets.token_urlsafe(24)
        self._tool_by_name = {item.name: item for item in self.tools}
        if len(self._tool_by_name) != len(self.tools):
            raise ValueError("Codex MCP tool names must be unique")
        self._tool_calls_this_turn = 0
        self._budget_exhausted = False
        self._result_emitted_this_turn = False
        self._api_key = ""
        state_root = Path(os.environ.get("KBC_CODEX_STATE_ROOT", "/work"))
        state_root.mkdir(parents=True, exist_ok=True)
        self._codex_home = tempfile.mkdtemp(prefix=".kbc-codex-", dir=str(state_root))
        self._shell_home = tempfile.mkdtemp(prefix=".kbc-shell-home-", dir=str(state_root))

    async def connect(self) -> None:
        # Lazy import keeps the Claude image/test environment importable even if
        # only the original SDK dependency is installed.
        from codex_cli_bin import bundled_package_dir
        from openai_codex import ApprovalMode, AsyncCodex, CodexConfig

        base_url = os.environ.get("OPENAI_BASE_URL", "").strip()
        api_key = os.environ.get("OPENAI_API_KEY", "").strip()
        if not base_url:
            raise RuntimeError("codex_sdk requires llm.base_url (OpenAI Responses endpoint)")
        if not api_key:
            raise RuntimeError("codex_sdk requires llm.api_key/auth_token")
        self._api_key = api_key

        overrides = [
            "model_provider=" + _toml("kbc_mass"),
            "model_providers.kbc_mass.name=" + _toml("KBC OpenAI Responses provider"),
            "model_providers.kbc_mass.base_url=" + _toml(base_url.rstrip("/")),
            "model_providers.kbc_mass.env_key=" + _toml("OPENAI_API_KEY"),
            "model_providers.kbc_mass.wire_api=" + _toml("responses"),
            "model_providers.kbc_mass.requires_openai_auth=false",
            "web_search=" + _toml("disabled"),
            # KBC supplies the complete system contract. Uploaded corpora must
            # never inject Codex configuration, AGENTS.md, hooks, plugins,
            # connectors, memories, goals or subagents into a multi-tenant box.
            "project_doc_max_bytes=0",
            "features.apps=false",
            "features.goals=false",
            "features.hooks=false",
            "features.memories=false",
            "features.multi_agent=false",
            "features.remote_plugin=false",
            "features.shell_snapshot=false",
            # Keep one mechanically sandboxed command path. The Python SDK host
            # does not implement unified exec and enabling a second executor
            # would create a parallel permission surface.
            "features.unified_exec=false",
            # The Python SDK does not provide Codex's host-side JavaScript
            # executor. Force native shell/file tools instead of code-mode
            # calls such as `exec -> tools.exec_command(...)` that cannot be
            # serviced by this compile-box host.
            "features.code_mode.enabled=false",
            # Model-proposed shell commands receive no API key/token.  PATH and
            # HOME is a separate empty directory from CODEX_HOME, so even a
            # writer shell cannot inspect Codex runtime/config state through ~.
            "allow_login_shell=false",
            "shell_environment_policy.inherit=" + _toml("none"),
            "shell_environment_policy.include_only=" + _toml(["PATH", "HOME"]),
            "shell_environment_policy.set.PATH=" + _toml(os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin")),
            "shell_environment_policy.set.HOME=" + _toml(self._shell_home),
        ]
        if self.read_only:
            readable_roots = ", ".join(
                f"{_toml(root)} = \"read\"" for root in self.allowed_read_roots
            )
            overrides.extend([
                # Closed-book consumers use only KBC's root-checking MCP read
                # tools. No model-proposed subprocess is available, avoiding
                # both host reads and restricted-host nested-sandbox failures.
                "features.shell_tool=false",
                "default_permissions=" + _toml("kbc_readonly"),
                "permissions.kbc_readonly={ filesystem = { " + readable_roots
                + " }, network = { enabled = false } }",
            ])
        else:
            filesystem_roots = {
                # Codex expands :minimal to platform binaries, libraries and
                # system config only; it deliberately excludes user data and
                # process metadata such as /proc.
                ":minimal": "read",
                # The pinned runtime may live outside the platform roots (for
                # example setup-python installs it under /opt on CI). Codex
                # re-execs this binary inside bubblewrap for each command.
                str(bundled_package_dir().resolve()): "read",
                self.cwd: "write",
                str(Path(self._shell_home).resolve()): "write",
            }
            filesystem_roots.update(self.writer_filesystem_access)
            filesystem = ", ".join(
                f"{_toml(root)} = {_toml(access)}"
                for root, access in filesystem_roots.items()
            )
            overrides.extend([
                "features.shell_tool=true",
                "default_permissions=" + _toml("kbc_writer"),
                "permissions.kbc_writer={ filesystem = { " + filesystem
                + " }, network = { enabled = false } }",
            ])
        if self.tools:
            callback_url = await self._start_callback_listener()
            server_path = Path(__file__).resolve().with_name("mcp_tool_server.py")
            tool_specs = [
                {"name": item.name, "description": item.description, "inputSchema": item.input_schema}
                for item in self.tools
            ]
            overrides.extend([
                "mcp_servers.kbc.command=" + _toml(sys.executable),
                "mcp_servers.kbc.args=" + _toml([str(server_path)]),
                "mcp_servers.kbc.required=true",
                "mcp_servers.kbc.startup_timeout_sec=15",
                "mcp_servers.kbc.tool_timeout_sec=120",
                "mcp_servers.kbc.default_tools_approval_mode=" + _toml("approve"),
                "mcp_servers.kbc.env.KBC_MCP_CALLBACK_URL=" + _toml(callback_url),
                "mcp_servers.kbc.env.KBC_MCP_CALLBACK_TOKEN=" + _toml(self._callback_token),
                "mcp_servers.kbc.env.KBC_MCP_TOOLS_JSON=" + _toml(json.dumps(tool_specs, ensure_ascii=False)),
            ])
            # Non-interactive app-server calls need an explicit per-tool approve
            # policy; the server default alone is currently insufficient.
            for item in self.tools:
                overrides.append(
                    f"mcp_servers.kbc.tools.{item.name}.approval_mode=" + _toml("approve")
                )

        config = CodexConfig(
            cwd=self.cwd,
            config_overrides=tuple(overrides),
            env={
                "CODEX_HOME": self._codex_home,
                "OPENAI_API_KEY": api_key,
            },
            client_name="siclaw_kbc",
            client_title="Siclaw KB Compiler",
        )
        self._codex = AsyncCodex(config=config)
        read_contract = ""
        if self.read_only:
            available_read_tools = [
                item.name for item in self.tools if item.name in _READ_TOOL_NAME_MAP.values()
            ]
            tool_contract = (
                "Use only these KBC filesystem tools: " + ", ".join(available_read_tools) + ". "
                if available_read_tools
                else "No filesystem inspection tools are available for this consumer profile. "
            )
            read_contract = (
                "\n\nClosed-book filesystem contract: native shell and file mutation are unavailable. "
                + tool_contract
                + "Read only these declared snapshot roots: " + ", ".join(self.allowed_read_roots)
            )
        else:
            scoped = (
                " Batch sessions may add denied Raw and temporary read-only source-view subtrees "
                "through this same profile."
                if self.writer_filesystem_access else ""
            )
            read_contract = (
                "\n\nWriter filesystem contract: shell and file tools are sandboxed to the current "
                "KBC workspace, with process metadata and network access denied." + scoped
            )
        self._thread = await self._codex.thread_start(
            # KBC is an unattended compiler. auto_review still routes workspace
            # commands through an approval reviewer, which can reject ordinary
            # raw/ reads and candidate/ writes. `deny_all` means "do not ask for
            # approval" in the SDK; the single-run KBC Pod is the same mechanical
            # boundary used by Claude's bypassPermissions mode.
            approval_mode=ApprovalMode.deny_all,
            cwd=self.cwd,
            developer_instructions=self.system_prompt + read_contract,
            ephemeral=True,
            model=self.model,
            model_provider="kbc_mass",
            # Named permission profiles above are the mechanical boundary for
            # both writer and closed-book sessions. Passing a legacy sandbox
            # mode here would override the selected profile.
            sandbox=None,
        )
        # Public session identity must be the resumable Codex thread id, not the
        # provisional box UUID passed to the constructor.
        self.session_id = self._thread.id
        self._worker = asyncio.create_task(self._turn_worker())

    async def query(self, text: str) -> None:
        if self._thread is None:
            raise RuntimeError("CodexSDKClient is not connected")
        await self._prompts.put(text)

    async def receive_messages(self):
        while True:
            value = await self._events.get()
            if value is _CLOSED:
                return
            yield value

    async def receive_response(self):
        async for value in self.receive_messages():
            yield value
            if type(value).__name__ == "ResultMessage":
                return

    async def interrupt(self) -> None:
        turn = self._turn
        if turn is not None:
            await turn.interrupt()

    async def disconnect(self) -> None:
        worker, self._worker = self._worker, None
        if worker is not None:
            worker.cancel()
            try:
                await worker
            except asyncio.CancelledError:
                pass
        if self._codex is not None:
            codex, self._codex = self._codex, None
            await codex.close()
        if self._callback_runner is not None:
            await self._callback_runner.cleanup()
            self._callback_runner = None
        self._api_key = ""
        shutil.rmtree(self._codex_home, ignore_errors=True)
        shutil.rmtree(self._shell_home, ignore_errors=True)
        await self._events.put(_CLOSED)

    async def _start_callback_listener(self) -> str:
        app = web.Application(client_max_size=1024 * 1024)
        app.add_routes([web.post("/tool-call", self._handle_tool_call)])
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        sockets = site._server.sockets if site._server else None
        if not sockets:
            await runner.cleanup()
            raise RuntimeError("failed to bind Codex MCP callback listener")
        self._callback_runner = runner
        port = sockets[0].getsockname()[1]
        return f"http://127.0.0.1:{port}/tool-call"

    async def _handle_tool_call(self, request: web.Request) -> web.Response:
        provided_token = request.headers.get("x-kbc-token", "")
        if not secrets.compare_digest(provided_token, self._callback_token):
            return web.json_response({"error": "forbidden"}, status=403)
        body = await request.json()
        name = str(body.get("name", ""))
        item = self._tool_by_name.get(name)
        if item is None:
            return web.json_response({"error": f"unknown tool {name!r}"}, status=400)
        args = body.get("arguments")
        if not isinstance(args, dict):
            return web.json_response({"error": "arguments must be an object"}, status=400)
        try:
            text = await item.handler(args)
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)
        return web.json_response({"text": str(text)})

    async def _turn_worker(self) -> None:
        from openai_codex.generated.v2_all import ReasoningEffort

        effort = None
        try:
            effort = ReasoningEffort(self.reasoning_effort)
        except ValueError:
            pass
        while True:
            prompt = await self._prompts.get()
            self._tool_calls_this_turn = 0
            self._budget_exhausted = False
            self._result_emitted_this_turn = False
            try:
                self._turn = await self._thread.turn(prompt, effort=effort)
                async for notification in self._turn.stream():
                    await self._relay_notification(notification)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if not self._result_emitted_this_turn:
                    await self._events.put(AssistantMessage([
                        TextBlock("Codex turn failed: " + _safe_error_message(exc, (self._api_key,)))
                    ]))
                    await self._emit_result(ResultMessage(
                        is_error=True,
                        api_error_status=_status_from_error(exc),
                        subtype="error_max_turns" if self._budget_exhausted else "error_during_execution",
                    ))
            finally:
                self._turn = None

    async def _relay_notification(self, notification) -> None:
        # Every SDK notification is transport liveness for the existing stall
        # watchdog, even when the event has no user-visible representation.
        await self._events.put(StreamEvent())
        payload = getattr(notification, "payload", None)
        name = type(payload).__name__
        if name == "ItemStartedNotification":
            item = getattr(payload, "item", None)
            item = getattr(item, "root", item)
            item_name = type(item).__name__
            if item_name in {
                "CommandExecutionThreadItem",
                "FileChangeThreadItem",
                "McpToolCallThreadItem",
                "DynamicToolCallThreadItem",
            }:
                self._tool_calls_this_turn += 1
                if (
                    not self._budget_exhausted
                    and self.max_tool_calls >= 0
                    and self._tool_calls_this_turn > self.max_tool_calls
                ):
                    self._budget_exhausted = True
                    await self._events.put(AssistantMessage([
                        TextBlock(
                            f"Codex turn budget exhausted after {self.max_tool_calls} tool calls."
                        )
                    ]))
                    if self._turn is not None:
                        await self._turn.interrupt()
            if item_name == "McpToolCallThreadItem":
                await self._events.put(AssistantMessage([
                    ToolUseBlock(str(getattr(item, "tool", "") or "mcp"), getattr(item, "arguments", None) or {})
                ]))
            elif item_name == "CommandExecutionThreadItem":
                await self._events.put(AssistantMessage([ToolUseBlock("Shell", {})]))
        elif name == "ItemCompletedNotification":
            item = getattr(payload, "item", None)
            item = getattr(item, "root", item)
            if type(item).__name__ == "AgentMessageThreadItem":
                text = str(getattr(item, "text", "") or "").strip()
                if text:
                    await self._events.put(AssistantMessage([TextBlock(text)]))
        elif name == "TurnCompletedNotification":
            if self._result_emitted_this_turn:
                return
            turn = getattr(payload, "turn", None)
            status = str(getattr(getattr(turn, "status", None), "value", getattr(turn, "status", "")))
            error = getattr(turn, "error", None)
            is_error = self._budget_exhausted or status not in {"completed", ""}
            if is_error and not self._budget_exhausted:
                await self._events.put(AssistantMessage([
                    TextBlock("Codex turn failed: " + _safe_error_message(error, (self._api_key,)))
                ]))
            await self._emit_result(ResultMessage(
                is_error=is_error,
                api_error_status=_status_from_error(getattr(error, "message", error)),
                subtype=(
                    "error_max_turns" if self._budget_exhausted
                    else "success" if not is_error
                    else f"error_{status or 'unknown'}"
                ),
            ))

    async def _emit_result(self, result: ResultMessage) -> None:
        """Keep terminal turn signaling one-shot even if an SDK stream repeats it."""
        if self._result_emitted_this_turn:
            return
        self._result_emitted_this_turn = True
        await self._events.put(result)
