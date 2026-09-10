"""KBC orchestration exercised through the real Pi worker and host tools."""

import asyncio
import json
from copy import deepcopy
import os

import pytest
from aiohttp import web

import compile_box
import pi_config
from agent_protocol import AgentEvent
from engine import selected_readonly_engine
from pi_engine import PiAgentClient
from test_pi_engine import completion, provider


def configure(monkeypatch, config, settings=None):
    monkeypatch.setattr(os, "environ", dict(os.environ))
    monkeypatch.setattr(pi_config, "_roles", {})
    for name in compile_box._CACHED_SESSION_SETTINGS.values():
        monkeypatch.setattr(compile_box, name, getattr(compile_box, name))
    compile_box._apply_session_config({"llm": {"engine": "pi_agent", "execution": {
        "version": 1, "roles": {role: deepcopy(config) for role in ("compile", "blue", "judge", "transcribe", "compare")},
    }}, "settings": settings or {}})


async def test_compiler_type_prompt_and_release_reach_real_worker(tmp_path, monkeypatch):
    from pi_engine import observe_sessions
    from test_pi_engine import collect

    async with provider(lambda *_: completion()) as (config, requests):
        monkeypatch.setattr(pi_config, "_roles", {})
        monkeypatch.setattr(pi_config, "_agent_type", None)
        execution = {"version": 2, "roles": {role: deepcopy(config) for role in
                     ("compile", "blue", "judge", "transcribe", "compare")},
                     "agent_type": {"slug": "knowledge_compiler", "release_id": "release-one",
                                    "revision_id": "revision-one", "release_version": 2,
                                    "harness": "kb-compile", "harness_version": 1,
                                    "system_prompt": "Keep source versions separate."}}
        pi_config.configure(execution)
        assert "system_prompt_append" not in pi_config.for_role("blue")
        observed = []

        async def observe(event):
            observed.append(event)

        with observe_sessions(observe):
            client = PiAgentClient(cwd=str(tmp_path), system_prompt="Compiler tool contract.",
                                   session_id="pinned-type-session", model_config=pi_config.for_role("compile"), tools=[])
            # A later configuration must not change the session already created.
            execution["agent_type"]["system_prompt"] = "New instructions."
            execution["agent_type"]["release_id"] = "release-two"
            pi_config.configure(execution)
            try:
                await client.connect()
                await client.query("Compile the sources.")
                assert (await collect(client))[-1].data["outcome"] == "completed"
            finally:
                await client.disconnect()
        system = json.dumps([message for message in requests[0]["messages"] if message["role"] in {"system", "developer"}])
        assert "Compiler tool contract." in system and "Keep source versions separate." in system
        assert "New instructions." not in system
        ready = next(event for event in observed if event["kind"] == "ready")
        assert ready["data"]["agent_type"]["release_id"] == "release-one"
        assert "Keep source versions separate." not in json.dumps(observed)
        assert "private-fixture-key" not in json.dumps(observed)


async def test_unknown_compiler_harness_rejected_before_configuration_changes(monkeypatch):
    async with provider(lambda *_: completion()) as (config, _):
        configure(monkeypatch, config)
        before = deepcopy(pi_config._roles)
        with pytest.raises(ValueError, match="Unsupported compiler"):
            pi_config.configure({"version": 2, "roles": before, "agent_type": {
                "slug": "knowledge_compiler", "harness": "kb-compile", "harness_version": 999}})
        assert pi_config._roles == before
        with pytest.raises(ValueError, match="requires its compiler Agent Type"):
            pi_config.configure({"version": 2, "roles": before})
        assert pi_config._roles == before


async def test_recovery_applies_frozen_switches_and_cached_watchdogs(tmp_path, monkeypatch):
    async with provider(lambda *_: completion()) as (config, _):
        monkeypatch.setattr(compile_box, "_PK_KILL_AT_BOOT", False)
        settings = {"KBC_MEDIA_VERIFY": "on", "KBC_PK_MODE": "auto", "KBC_MODEL_IDLE_TIMEOUT_S": "600",
                    "KBC_TEST_MODEL_IDLE_TIMEOUT_S": "600", "KBC_BATCH_BUDGET_BYTES": "1048576"}
        for boot_media, boot_idle in (("off", 90.0), ("on", 240.0)):
            monkeypatch.setenv("KBC_MEDIA_VERIFY", boot_media)
            monkeypatch.setattr(compile_box, "_MODEL_IDLE_TIMEOUT_S", boot_idle)
            configure(monkeypatch, config, settings)
            assert compile_box._media_verify_enabled()
            assert compile_box._MODEL_IDLE_TIMEOUT_S == 600
            assert compile_box._TEST_MODEL_IDLE_TIMEOUT_S == 600
            assert compile_box._pk_mode() == "auto"
        # The existing emergency stop remains an explicit operational exception.
        monkeypatch.setattr(compile_box, "_PK_KILL_AT_BOOT", True)
        monkeypatch.setenv("KBC_PK_MODE", "off")
        configure(monkeypatch, config, settings)
        assert compile_box._pk_mode() == "off"


async def test_batch_failure_keeps_draft_without_marking_completion(tmp_path, monkeypatch):
    (tmp_path / "raw").mkdir()
    (tmp_path / "raw/source.md").write_text("source")
    async with provider(lambda _, n: completion(tool=("Write", {"file_path": "candidate/page.md", "content": "partial draft"}))
                        if n == 1 else web.json_response({"error": {"message": "model unavailable"}}, status=400)) as (config, requests):
        configure(monkeypatch, config)
        run = compile_box.CompileRun("run-fixture", str(tmp_path), 1)
        with pytest.raises(compile_box.ModelResultError):
            await compile_box._drive_batch_session(run, "Write the draft", "fixture")
        assert (tmp_path / "candidate/page.md").read_text() == "partial draft"
        assert len(requests) == 2
        events = []
        while not run.events.empty():
            events.append(run.events.get_nowait())
        assert not any(event["type"] in {"turn_done", "done", "syncArtifacts"} for event in events)
        observations = [event["observation"] for event in events if event["type"] == "execution_observation"]
        assert any(event["kind"] == "assistant" and event["data"]["llm_call"]["round"] == 1 for event in observations)
        assert any(event["kind"] == "result" and event["data"]["outcome"] == "failed" for event in observations)
        assert all("content" not in event["data"] and "arguments" not in event["data"] for event in observations)
        assert run._last_turn_reply == ""


async def test_readonly_engine_uses_snapshot_tools_and_actual_sdk(tmp_path, monkeypatch):
    (tmp_path / "page.md").write_text("snapshot evidence")
    async with provider(lambda _, n: completion(tool=("Read", {"file_path": "page.md"}))
                        if n == 1 else completion("snapshot answer")) as (config, requests):
        configure(monkeypatch, config)
        answer = await selected_readonly_engine().run_readonly_agent(
            cwd=str(tmp_path), system_prompt="Read the snapshot", user_message="Answer from page.md",
            model="fixture-model", allowed_read_roots=[str(tmp_path)], timeout_secs=15)
        assert answer == "snapshot answer"
        names = {tool["function"]["name"] for tool in requests[0]["tools"]}
        assert names == {"Read", "Glob", "Grep"}
        assert compile_box._test_sdk_version() == "0.85.1"


async def test_readonly_engine_returns_final_json_after_tool_commentary(tmp_path, monkeypatch):
    (tmp_path / "page.md").write_text("The watchdog is 45 seconds.")
    expected = {"questions": [{"question": "What is the watchdog timeout?"}]}

    def respond(_, number):
        if number > 1:
            return completion(json.dumps(expected))
        response = completion(tool=("Read", {"file_path": "page.md"}))
        chunk = json.loads(response.text.split("\n")[0].removeprefix("data: "))
        chunk["choices"][0]["delta"]["content"] = (
            'Before reading, the draft is {"questions": []}. I will inspect the source.')
        return web.Response(text=f"data: {json.dumps(chunk)}\n\ndata: [DONE]\n\n",
                            content_type="text/event-stream")

    async with provider(respond) as (config, requests):
        configure(monkeypatch, config)
        answer = await selected_readonly_engine().run_readonly_agent(
            cwd=str(tmp_path), system_prompt="Return the final questions as JSON.",
            user_message="Read page.md and write a question.", model="fixture-model",
            allowed_read_roots=[str(tmp_path)], timeout_secs=15)
        assert json.loads(answer) == expected
        assert len(requests) == 2


async def test_test_session_model_failure_emits_error_and_remains_reusable(tmp_path, monkeypatch):
    async with provider(lambda _, n: web.json_response({"error": {"message": "invalid request"}}, status=400)
                        if n == 1 else completion("recovered")) as (config, _):
        configure(monkeypatch, config)
        run = compile_box.TestRun("test-fixture", str(tmp_path), "run-fixture", "snapshot-fixture")
        client = compile_box._build_test_client(run, "session-fixture")
        assert isinstance(client, PiAgentClient)
        await client.connect()
        consume = asyncio.create_task(compile_box._consume_test_turn_stream(run, client))
        try:
            for expected in ("The model request failed", "recovered"):
                compile_box._arm_test_turn(run)
                await client.query("Question")
                seen = []
                async with asyncio.timeout(15):
                    while True:
                        event = await run.events.get()
                        seen.append(event)
                        if event["type"] == "turn_done":
                            assert expected in event["text"]
                            break
                if expected.startswith("The"):
                    assert any(event["type"] == "error" and event["code"] == "test_model_failed" for event in seen)
                assert not run._turn_active
        finally:
            await client.disconnect()
            await consume


async def test_parallel_tools_keep_the_long_tool_watchdog_bound(tmp_path):
    run = compile_box.CompileRun("fixture", str(tmp_path), 1)
    for kind, call_id in (("tool_start", "a"), ("tool_start", "b"), ("tool_end", "a")):
        compile_box._note_model_activity(run, AgentEvent(kind, "s", "t", {"call_id": call_id}))
        assert run._tool_pending
    compile_box._note_model_activity(run, AgentEvent("tool_end", "s", "t", {"call_id": "b"}))
    assert not run._tool_pending


async def test_owner_compile_session_survives_provider_refusal(tmp_path, monkeypatch):
    async with provider(lambda _, n: web.json_response({"error": {"message": "account limit"}}, status=402)
                        if n == 1 else completion("Ready to continue")) as (config, requests):
        configure(monkeypatch, config)
        run = compile_box.CompileRun("owner-session", str(tmp_path), 1)
        client = compile_box._compile_session_client(run, str(tmp_path), "Help the owner", "owner-pi")
        await client.connect()
        consume = asyncio.create_task(compile_box._consume_turn_stream(run, client, stop_on_result=False))
        try:
            for expected in ("model request failed", "Ready to continue"):
                run._begin_turn("Continue")
                await client.query("Continue")
                seen = []
                async with asyncio.timeout(15):
                    while True:
                        event = await run.events.get()
                        seen.append(event)
                        if event["type"] == "turn_done":
                            assert expected in event["text"]
                            break
                assert not run._turn_active and not consume.done()
                assert not any(event["type"] == "end" for event in seen)
            assert len(requests) == 2  # Billing refusals never consume retry attempts.
        finally:
            await client.disconnect()
            await consume


async def test_configuration_is_copied_and_empty_authority_has_no_fallback(tmp_path, monkeypatch):
    async with provider(lambda *_: completion()) as (config, _):
        configure(monkeypatch, config)
        copy = pi_config.for_role("compile")
        copy["model"]["id"] = "different"
        assert pi_config.role_model("compile") == "fixture-model"
        with pytest.raises(ValueError, match="version 1"):
            compile_box._apply_session_config({"llm": {"engine": "pi_agent", "execution": {}}})
