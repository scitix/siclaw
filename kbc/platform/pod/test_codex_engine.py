"""Unit tests for the Codex SDK adapter (no external model calls)."""

import asyncio
import os
import sys
import tempfile
import types
from pathlib import Path

import compile_box
from codex_engine import (
    CodexSDKClient,
    EngineTool,
    _safe_error_message,
    isolated_readonly_workspace,
)
from engine import CodexEngine


def test_isolated_readonly_workspace():
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        raw = base / "source-raw"
        candidate = base / "source-candidate"
        forbidden = base / "private.txt"
        raw.mkdir()
        candidate.mkdir()
        (raw / "a.md").write_text("raw", encoding="utf-8")
        (candidate / "index.md").write_text("candidate", encoding="utf-8")
        forbidden.write_text("secret", encoding="utf-8")
        (raw / "escape").symlink_to(forbidden)
        os.environ["KBC_CODEX_STATE_ROOT"] = td
        staged_path = None
        with isolated_readonly_workspace({"raw": raw, "candidate": candidate}) as staged:
            staged_path = staged
            assert (staged / "raw" / "a.md").read_text(encoding="utf-8") == "raw"
            assert (staged / "candidate" / "index.md").is_file()
            assert not (staged / "raw" / "escape").exists()
            assert sorted(path.name for path in staged.iterdir()) == ["candidate", "raw"]
            (staged / "raw" / "a.md").write_text("staged-only", encoding="utf-8")
            assert (raw / "a.md").read_text(encoding="utf-8") == "raw"
        assert staged_path is not None and not staged_path.exists()
    print("OK  Codex isolated workspace exposes only declared regular trees")


async def test_codex_config_is_tenant_isolated():
    captured = {}

    class FakeConfig:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)
            captured["config"] = kwargs

    class FakeThread:
        id = "thread-mass"

    class FakeCodex:
        def __init__(self, *, config):
            captured["codex_config"] = config

        async def thread_start(self, **kwargs):
            captured["thread"] = kwargs
            return FakeThread()

        async def close(self):
            captured["closed"] = True

    fake_module = types.SimpleNamespace(
        ApprovalMode=types.SimpleNamespace(deny_all="deny_all"),
        AsyncCodex=FakeCodex,
        CodexConfig=FakeConfig,
        Sandbox=types.SimpleNamespace(
            read_only="read-only",
            workspace_write="workspace-write",
            full_access="full-access",
        ),
    )
    previous = sys.modules.get("openai_codex")
    sys.modules["openai_codex"] = fake_module
    try:
        with tempfile.TemporaryDirectory() as td:
            os.environ.update({
                "KBC_CODEX_STATE_ROOT": td,
                "OPENAI_BASE_URL": "https://mass.invalid/model-api",
                "OPENAI_API_KEY": "test-key-not-secret",
            })

            async def submit(args):
                return str(args)

            client = CodexSDKClient(
                cwd=td,
                system_prompt="KBC contract",
                model="gpt-5.6-luna",
                session_id="pending",
                read_only=True,
                allowed_read_roots=[td],
                tools=[EngineTool("submit", "Submit", {"type": "object"}, submit)],
            )
            async def fake_callback_listener():
                return "http://127.0.0.1:1/tool-call"

            client._start_callback_listener = fake_callback_listener
            home = Path(client._codex_home)
            shell_home = Path(client._shell_home)
            await client.connect()
            overrides = set(captured["config"]["config_overrides"])
            assert 'model_providers.kbc_mass.wire_api="responses"' in overrides
            assert "model_providers.kbc_mass.requires_openai_auth=false" in overrides
            assert "project_doc_max_bytes=0" in overrides
            for feature in ("apps", "goals", "hooks", "memories", "multi_agent", "remote_plugin"):
                assert f"features.{feature}=false" in overrides
            assert "features.code_mode.enabled=false" in overrides
            assert "features.shell_tool=false" in overrides
            assert "features.unified_exec=false" in overrides
            assert 'default_permissions="kbc_readonly"' in overrides
            resolved_root = str(Path(td).resolve())
            assert (
                f'permissions.kbc_readonly={{ filesystem = {{ "{resolved_root}" = "read" }}, '
                'network = { enabled = false } }'
            ) in overrides
            assert "allow_login_shell=false" in overrides
            assert f'shell_environment_policy.set.HOME="{shell_home}"' in overrides
            assert str(shell_home) != str(home)
            for tool_name in ("kbc_read_file", "kbc_glob_files", "kbc_grep_files", "submit"):
                assert f'mcp_servers.kbc.tools.{tool_name}.approval_mode="approve"' in overrides
            assert 'mcp_servers.kbc.tools.submit.approval_mode="approve"' in overrides
            assert captured["config"]["env"] == {
                "CODEX_HOME": str(home),
                "OPENAI_API_KEY": "test-key-not-secret",
            }
            assert captured["thread"]["model_provider"] == "kbc_mass"
            assert captured["thread"]["approval_mode"] == "deny_all"
            assert captured["thread"]["sandbox"] is None
            assert "native shell and file mutation are unavailable" in captured["thread"]["developer_instructions"]
            assert client.session_id == "thread-mass"
            await client.disconnect()
            assert captured["closed"] is True and not home.exists() and not shell_home.exists()

            writer = CodexSDKClient(
                cwd=td,
                system_prompt="writer",
                model="gpt-5.6-luna",
                session_id="pending-writer",
            )
            writer_home = Path(writer._codex_home)
            writer_shell_home = Path(writer._shell_home)
            await writer.connect()
            writer_overrides = set(captured["config"]["config_overrides"])
            assert "features.shell_tool=true" in writer_overrides
            assert "features.unified_exec=false" in writer_overrides
            assert 'default_permissions="kbc_writer"' in writer_overrides
            from codex_cli_bin import bundled_package_dir
            writer_profile = next(
                value for value in writer_overrides if value.startswith("permissions.kbc_writer=")
            )
            assert (
                f'permissions.kbc_writer={{ filesystem = {{ ":minimal" = "read", '
                f'"{bundled_package_dir().resolve()}" = "read", '
                f'"{resolved_root}" = "write", '
                f'"{writer_shell_home.resolve()}" = "write" }}, '
                'network = { enabled = false } }'
            ) == writer_profile, writer_profile
            assert captured["thread"]["sandbox"] is None
            assert "process metadata and network access denied" in captured["thread"]["developer_instructions"]
            await writer.disconnect()
            assert not writer_home.exists() and not writer_shell_home.exists()

            raw = Path(td) / "raw"
            raw.mkdir()
            view = Path(td) / ".kbc-batch-sources-test"
            view.mkdir()
            allowed = view / "allowed.md"
            allowed.write_text("allowed", encoding="utf-8")
            scoped = CodexSDKClient(
                cwd=td,
                system_prompt="scoped writer",
                model="gpt-5.6-luna",
                session_id="pending-scoped-writer",
                writer_filesystem_access={
                    str(raw): "deny",
                    str(view): "read",
                },
            )
            await scoped.connect()
            scoped_overrides = set(captured["config"]["config_overrides"])
            scoped_profile = next(
                value for value in scoped_overrides if value.startswith("permissions.kbc_writer=")
            )
            assert f'"{raw.resolve()}" = "deny"' in scoped_profile, scoped_profile
            assert f'"{view.resolve()}" = "read"' in scoped_profile, scoped_profile
            assert "temporary read-only source-view subtrees" in captured["thread"]["developer_instructions"]
            await scoped.disconnect()
    finally:
        if previous is None:
            sys.modules.pop("openai_codex", None)
        else:
            sys.modules["openai_codex"] = previous
    print("OK  Codex config uses Mass Responses and disables tenant-unsafe ambient features")


async def test_real_codex_writer_sandbox_confines_commands():
    if os.name != "posix":
        print("SKIP Codex writer sandbox command probe requires a POSIX host")
        return

    from openai_codex.generated.v2_all import CommandExecResponse

    previous = {
        name: os.environ.get(name)
        for name in ("KBC_CODEX_STATE_ROOT", "OPENAI_BASE_URL", "OPENAI_API_KEY")
    }
    try:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()
            workspace = root / "workspace"
            workspace.mkdir()
            raw = workspace / "raw"
            raw.mkdir()
            allowed_raw = raw / "allowed.md"
            denied_raw = raw / "denied.md"
            allowed_raw.write_text("allowed-raw-sentinel", encoding="utf-8")
            denied_raw.write_text("denied-raw-sentinel", encoding="utf-8")
            source_view = workspace / ".kbc-batch-sources-probe"
            source_view.mkdir()
            allowed_view = source_view / "allowed.md"
            allowed_view.write_text("allowed-raw-sentinel", encoding="utf-8")
            secret = root / "provider-secret.txt"
            secret_value = "writer-sandbox-secret-sentinel"
            secret.write_text(secret_value, encoding="utf-8")
            os.environ.update({
                "KBC_CODEX_STATE_ROOT": str(root),
                "OPENAI_BASE_URL": "https://mass.invalid/model-api",
                "OPENAI_API_KEY": secret_value,
            })
            client = CodexSDKClient(
                cwd=str(workspace),
                system_prompt="writer sandbox startup probe",
                model="gpt-5.6-luna",
                session_id="writer-sandbox-probe",
            )
            try:
                await client.connect()
                rpc = client._codex._client

                write = await rpc.request(
                    "command/exec",
                    {"command": ["/bin/sh", "-c", "printf ok > writer.txt"], "cwd": client.cwd},
                    response_model=CommandExecResponse,
                )
                assert write.exit_code == 0, write.stderr
                assert (workspace / "writer.txt").read_text(encoding="utf-8") == "ok"

                outside = await rpc.request(
                    "command/exec",
                    {"command": ["/bin/cat", str(secret)], "cwd": client.cwd},
                    response_model=CommandExecResponse,
                )
                assert outside.exit_code != 0
                assert secret_value not in outside.stdout + outside.stderr

                process_metadata = await rpc.request(
                    "command/exec",
                    {
                        "command": [
                            "/bin/sh",
                            "-c",
                            "cat /proc/*/environ 2>/dev/null || true",
                        ],
                        "cwd": client.cwd,
                    },
                    response_model=CommandExecResponse,
                )
                assert secret_value not in process_metadata.stdout + process_metadata.stderr
            finally:
                await client.disconnect()

            scoped = CodexSDKClient(
                cwd=str(workspace),
                system_prompt="writer Raw scope probe",
                model="gpt-5.6-luna",
                session_id="writer-raw-scope-probe",
                writer_filesystem_access={
                    str(raw): "deny",
                    str(source_view): "read",
                },
            )
            try:
                await scoped.connect()
                rpc = scoped._codex._client
                allowed_read = await rpc.request(
                    "command/exec",
                    {"command": ["/bin/cat", str(allowed_view)], "cwd": scoped.cwd},
                    response_model=CommandExecResponse,
                )
                assert allowed_read.exit_code == 0
                assert "allowed-raw-sentinel" in allowed_read.stdout
                allowed_write = await rpc.request(
                    "command/exec",
                    {
                        "command": ["/usr/bin/touch", str(allowed_view)],
                        "cwd": scoped.cwd,
                    },
                    response_model=CommandExecResponse,
                )
                assert allowed_write.exit_code != 0
                assert allowed_view.read_text(encoding="utf-8") == "allowed-raw-sentinel"
                denied_read = await rpc.request(
                    "command/exec",
                    {"command": ["/bin/cat", str(denied_raw)], "cwd": scoped.cwd},
                    response_model=CommandExecResponse,
                )
                assert denied_read.exit_code != 0
                assert "denied-raw-sentinel" not in denied_read.stdout + denied_read.stderr
            finally:
                await scoped.disconnect()
    finally:
        for name, value in previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
    print("OK  real Codex writer shell writes only in-workspace and cannot read provider credentials")


async def test_codex_engine_stages_and_rewrites_roots():
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        wiki = base / "wiki"
        raw = base / "raw"
        live = base / "live-draft"
        wiki.mkdir()
        raw.mkdir()
        live.mkdir()
        (wiki / "index.md").write_text("wiki", encoding="utf-8")
        (raw / "a.md").write_text("raw", encoding="utf-8")
        (live / "secret.md").write_text("forbidden", encoding="utf-8")
        os.environ["KBC_CODEX_STATE_ROOT"] = td
        engine = CodexEngine()
        staged, replacements = await engine._stage_allowed_roots([str(wiki), str(raw)])
        assert sorted(path.name for path in staged.iterdir()) == ["root-0-wiki", "root-1-raw"]
        assert not any(path.name == "live-draft" for path in staged.rglob("*"))
        prompt = f"wiki={wiki.resolve()}; raw={raw.resolve()}; do not read {live}"
        rewritten = engine._rewrite_paths(prompt, replacements)
        assert str(wiki.resolve()) not in rewritten and str(raw.resolve()) not in rewritten
        assert str(live) in rewritten  # undeclared roots are never mapped into the sandbox view
        staged_again, _ = await engine._stage_allowed_roots([str(wiki), str(raw)])
        assert staged_again == staged
        engine._stage_finalizer()
        assert not engine._stage_root.exists()
    print("OK  Codex reviewer caches an isolated multi-root snapshot and rewrites prompt paths")


def test_error_redaction():
    assert "sk-live" not in _safe_error_message("401 for sk-liveTOKEN123456789")
    assert "[REDACTED]" in _safe_error_message("401 for sk-liveTOKEN123456789")
    mass_key = "tenant-token-without-sk-prefix"
    assert mass_key not in _safe_error_message(f"401 for {mass_key}", (mass_key,))
    assert "[REDACTED]" in _safe_error_message(f"401 for {mass_key}", (mass_key,))
    print("OK  Codex error messages redact shaped and exact provider keys")


async def test_readonly_file_tools_confine_paths_and_bound_output():
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        allowed = base / "snapshot"
        forbidden = base / "provider-secret.txt"
        allowed.mkdir()
        forbidden.write_text("mass-secret", encoding="utf-8")
        (allowed / "docs").mkdir()
        (allowed / "docs" / "a.md").write_text("Alpha\nneedle here\nOmega\n", encoding="utf-8")
        (allowed / "docs" / "b.md").write_text("Needle again\n", encoding="utf-8")
        (allowed / "escape").symlink_to(forbidden)
        os.environ["KBC_CODEX_STATE_ROOT"] = td
        client = CodexSDKClient(
            cwd=str(allowed),
            system_prompt="closed book",
            model="gpt-5.6-luna",
            session_id="readonly-tools",
            read_only=True,
            allowed_read_roots=[str(allowed)],
        )
        tools = client._tool_by_name
        read = await tools["kbc_read_file"].handler({"path": "docs/a.md", "offset": 2, "limit": 1})
        assert "2: needle here" in read and "3: Omega" not in read
        globbed = await tools["kbc_glob_files"].handler({"pattern": "**/*.md"})
        assert "docs/a.md" in globbed and "docs/b.md" in globbed
        grepped = await tools["kbc_grep_files"].handler({"query": "needle", "pattern": "**/*.md"})
        assert "docs/a.md:2" in grepped and "docs/b.md:1" in grepped

        async def expect_denied(tool_name, args):
            try:
                await tools[tool_name].handler(args)
            except ValueError as exc:
                assert "outside" in str(exc) or "parent traversal" in str(exc)
            else:
                raise AssertionError(f"{tool_name} unexpectedly allowed {args}")

        await expect_denied("kbc_read_file", {"path": "../provider-secret.txt"})
        await expect_denied("kbc_read_file", {"path": str(forbidden)})
        await expect_denied("kbc_read_file", {"path": "escape"})
        await expect_denied("kbc_glob_files", {"pattern": "../*.txt"})
        await client.disconnect()
    print("OK  Codex read-only tools mechanically confine traversal, absolute paths and symlinks")


def test_readonly_file_tools_honor_exact_consumer_contract():
    with tempfile.TemporaryDirectory() as td:
        os.environ["KBC_CODEX_STATE_ROOT"] = td
        read_only = CodexSDKClient(
            cwd=td,
            system_prompt="closed book",
            model="gpt-5.6-luna",
            session_id="readonly-subset",
            read_only=True,
            allowed_read_roots=[td],
            allowed_read_tools=["Read"],
        )
        assert list(read_only._tool_by_name) == ["kbc_read_file"]

        no_tools = CodexSDKClient(
            cwd=td,
            system_prompt="closed book",
            model="gpt-5.6-luna",
            session_id="readonly-empty",
            read_only=True,
            allowed_read_roots=[td],
            allowed_read_tools=[],
        )
        assert not no_tools._tool_by_name

        try:
            CodexSDKClient(
                cwd=td,
                system_prompt="closed book",
                model="gpt-5.6-luna",
                session_id="readonly-unsupported",
                read_only=True,
                allowed_read_roots=[td],
                allowed_read_tools=["Read", "UnknownTool"],
            )
        except ValueError as exc:
            assert "unsupported read-only Codex tools: UnknownTool" in str(exc)
        else:
            raise AssertionError("unsupported consumer tool was silently accepted")
    print("OK  Codex read-only tools match the exact fingerprinted consumer contract")


async def test_codex_test_driver_passes_fingerprinted_tool_contract():
    captured = {}

    class FakeClient:
        def __init__(self, **kwargs):
            captured.update(kwargs)
            self.session_id = "codex-consumer-thread"

        async def connect(self):
            pass

        async def receive_messages(self):
            if False:
                yield None

        async def disconnect(self):
            pass

    original_client = compile_box.CodexSDKClient
    original_engine = os.environ.get("KBC_ENGINE")
    try:
        compile_box.CodexSDKClient = FakeClient
        os.environ["KBC_ENGINE"] = "codex_sdk"
        with tempfile.TemporaryDirectory() as td:
            run = compile_box.TestRun(
                "codex-consumer-contract",
                td,
                parent_run_id="parent",
                snapshot_hash="snapshot",
            )
            run.allowed_tools = ["Read", "Bash"]
            run.consumer_model = "consumer-model"
            run.consumer_max_turns = 7
            await compile_box.test_session_driver(run)
            assert captured["allowed_read_tools"] == ["Read"]
            assert captured["allowed_read_roots"] == [td]
            assert captured["model"] == "consumer-model"
            assert captured["max_tool_calls"] == 7
    finally:
        compile_box.CodexSDKClient = original_client
        if original_engine is None:
            os.environ.pop("KBC_ENGINE", None)
        else:
            os.environ["KBC_ENGINE"] = original_engine
    print("OK  Codex test driver passes the exact fingerprinted consumer tool contract")


async def test_codex_recommendation_uses_isolated_view_and_neutral_tool():
    captured = {}

    class ResultMessage:
        subtype = "success"

    class FakeClient:
        def __init__(self, **kwargs):
            captured.update(kwargs)

        async def connect(self):
            cwd = Path(captured["cwd"])
            assert captured["allowed_read_roots"] == [str(cwd)]
            assert (cwd / "raw" / "policy.md").is_file()
            assert (cwd / "candidate" / "index.md").is_file()
            assert not (cwd / "authoring").exists()

        async def query(self, _directive):
            await captured["tools"][0].handler({
                "question": "How many retries?",
                "reference_answer": "Three.",
                "evidence_paths": ["raw/policy.md"],
            })

        async def receive_messages(self):
            yield ResultMessage()

        async def disconnect(self):
            pass

    original_client = compile_box.CodexSDKClient
    original_engine = os.environ.get("KBC_ENGINE")
    try:
        compile_box.CodexSDKClient = FakeClient
        os.environ["KBC_ENGINE"] = "codex_sdk"
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "run"
            (root / "raw").mkdir(parents=True)
            (root / "candidate").mkdir()
            (root / "authoring").mkdir()
            (root / "raw" / "policy.md").write_text("retries = 3", encoding="utf-8")
            (root / "candidate" / "index.md").write_text("# Policy", encoding="utf-8")
            (root / "authoring" / "private.json").write_text("internal", encoding="utf-8")
            os.environ["KBC_CODEX_STATE_ROOT"] = td
            parent = compile_box.CompileRun("codex-recommend", str(root), 1)
            result = await compile_box.recommend_test_question(parent)
            assert result["reference_answer"] == "Three."
            staged = Path(captured["cwd"])
            assert not staged.exists()
    finally:
        compile_box.CodexSDKClient = original_client
        if original_engine is None:
            os.environ.pop("KBC_ENGINE", None)
        else:
            os.environ["KBC_ENGINE"] = original_engine
    print("OK  Codex recommendation branch reuses neutral KBC tools inside an isolated view")


async def test_codex_tool_budget_interrupts_and_preserves_contract():
    class FakeTurn:
        def __init__(self):
            self.interrupts = 0

        async def interrupt(self):
            self.interrupts += 1

    def notification(payload):
        return types.SimpleNamespace(payload=payload)

    with tempfile.TemporaryDirectory() as td:
        os.environ["KBC_CODEX_STATE_ROOT"] = td
        client = CodexSDKClient(
            cwd=td,
            system_prompt="test",
            model="gpt-5.6-luna",
            session_id="budget",
            max_tool_calls=1,
        )
        turn = FakeTurn()
        client._turn = turn
        command = type("CommandExecutionThreadItem", (), {})()
        started = type("ItemStartedNotification", (), {"item": command})()
        await client._relay_notification(notification(started))
        await client._relay_notification(notification(started))
        assert turn.interrupts == 1 and client._budget_exhausted
        completed_turn = types.SimpleNamespace(
            status=types.SimpleNamespace(value="completed"), error=None,
        )
        completed = type("TurnCompletedNotification", (), {"turn": completed_turn})()
        await client._relay_notification(notification(completed))
        await client._relay_notification(notification(completed))
        messages = []
        while not client._events.empty():
            messages.append(client._events.get_nowait())
        results = [item for item in messages if type(item).__name__ == "ResultMessage"]
        assert len(results) == 1
        assert results[0].is_error and results[0].subtype == "error_max_turns"
        await client.disconnect()
    print("OK  Codex tool-call budget interrupts active loops as error_max_turns")


async def main():
    test_isolated_readonly_workspace()
    await test_codex_config_is_tenant_isolated()
    await test_real_codex_writer_sandbox_confines_commands()
    await test_codex_engine_stages_and_rewrites_roots()
    test_error_redaction()
    await test_readonly_file_tools_confine_paths_and_bound_output()
    test_readonly_file_tools_honor_exact_consumer_contract()
    await test_codex_test_driver_passes_fingerprinted_tool_contract()
    await test_codex_recommendation_uses_isolated_view_and_neutral_tool()
    await test_codex_tool_budget_interrupts_and_preserves_contract()


if __name__ == "__main__":
    asyncio.run(main())
