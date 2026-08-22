"""Unit/contract tests for the Pi SDK adapter (no external model calls)."""

import asyncio
import json
import os
import tempfile
from pathlib import Path
from unittest.mock import patch

from engine_protocol import EngineTool
from pi_engine import PI_SDK_VERSION, PiSDKClient, resolve_pi_binding


def test_resolve_pi_binding():
    assert resolve_pi_binding(
        base_url="https://api.moonshot.cn/v1", provider=None, model=None,
    ) == ("moonshotai-cn", "kimi-k3")
    assert resolve_pi_binding(
        base_url="https://api.kimi.com/coding", provider=None, model=None,
    ) == ("kimi-coding", "k3")
    assert resolve_pi_binding(
        base_url="https://proxy.example/v1", provider="moonshotai", model="kimi-k3",
    ) == ("moonshotai", "kimi-k3")


def test_pi_versions_match_siclaw_baseline():
    pod_dir = Path(__file__).resolve().parent
    repo_root = pod_dir.parents[2]
    root_package = json.loads((repo_root / "package.json").read_text("utf-8"))
    runner_package = json.loads((pod_dir / "pi-runner" / "package.json").read_text("utf-8"))
    for package in (
        "@earendil-works/pi-agent-core",
        "@earendil-works/pi-coding-agent",
        "@earendil-works/pi-tui",
    ):
        assert root_package["dependencies"][package] == PI_SDK_VERSION
        assert runner_package["dependencies"][package] == PI_SDK_VERSION
    assert runner_package["dependencies"]["@earendil-works/pi-ai"] == PI_SDK_VERSION


def test_pi_writer_rejects_external_roots_and_reserved_tools():
    async def _noop(_args):
        return "ok"

    with tempfile.TemporaryDirectory() as workdir, tempfile.TemporaryDirectory() as outside:
        try:
            PiSDKClient(
                cwd=workdir,
                system_prompt="Test only.",
                model="kimi-k3",
                session_id="bad-root",
                writer_filesystem_access={outside: "write"},
            )
            raise AssertionError("external writer root must be rejected")
        except ValueError as error:
            assert "outside the session workspace" in str(error)

        try:
            PiSDKClient(
                cwd=workdir,
                system_prompt="Test only.",
                model="kimi-k3",
                session_id="reserved-tool",
                tools=[EngineTool("Read", "collision", {}, _noop)],
            )
            raise AssertionError("reserved file-tool collision must be rejected")
        except ValueError as error:
            assert "reserved" in str(error)


async def _connect_without_model_call():
    pod_dir = Path(__file__).resolve().parent
    runner = pod_dir / "pi-runner" / "dist" / "main.js"
    with tempfile.TemporaryDirectory() as workdir, patch.dict(os.environ, {
        "KBC_PI_RUNNER": str(runner),
        "KBC_PI_BASE_URL": "https://api.moonshot.cn/v1",
        "KBC_PI_PROVIDER": "moonshotai",
        "KBC_PI_MODEL": "kimi-k3",
        "KBC_PI_API_KEY": "unit-test-secret",
        "KBC_PI_STATE_ROOT": workdir,
    }, clear=False):
        client = PiSDKClient(
            cwd=workdir,
            system_prompt="Test only.",
            model="kimi-k3",
            session_id="pi-contract-test",
            read_only=True,
            allowed_read_roots=[workdir],
            max_tool_calls=5,
        )
        await client.connect()
        assert client.session_id == "pi-contract-test"
        assert await client.get_context_usage() == {"totalTokens": 0, "maxTokens": 0}
        await client.disconnect()


def test_pi_client_initializes_without_network():
    asyncio.run(_connect_without_model_call())


if __name__ == "__main__":
    test_resolve_pi_binding()
    test_pi_versions_match_siclaw_baseline()
    test_pi_writer_rejects_external_roots_and_reserved_tools()
    test_pi_client_initializes_without_network()
    print("OK  Pi SDK adapter contract")
