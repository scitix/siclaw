import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import batching
import compile_box


@pytest.mark.parametrize("source", ["inline", "file"])
@pytest.mark.parametrize("produced", [
    ["candidate/topic/a.md"],
    ["./topic/a.md"],
    ["topic\\a.md"],
    ["topic/typo.md"],
    ["topic/a.md", "topic/typo.md"],
])
async def test_complete_rejects_missing_pages_before_dispatch(monkeypatch, tmp_path, source, produced):
    (tmp_path / "candidate/topic").mkdir(parents=True)
    (tmp_path / "candidate/topic/a.md").write_text("# Topic A\n")
    (tmp_path / "candidate/topic/b.md").write_text("# Topic B\n")
    provenance = tmp_path / compile_box.RECOVERY_PROVENANCE_PATH
    valid = ["topic/a.md", "topic/b.md"][:len(produced)]
    if source == "file":
        provenance.parent.mkdir()
        provenance.write_text(json.dumps({"produced_count": len(produced), "produced_pages": produced}))
    parameters = {
        "recovery_mode": "complete", "produced_count": len(produced),
        # A complete inline preview must not hide an invalid authoritative file.
        "produced_pages": valid if source == "file" else produced,
    }
    body = {"command_id": "resume-1", "command": {
        "version": 1, "action": "compile.resume", "operation_id": "op-1", "generation": 1,
        "parameters": parameters,
    }}
    run = compile_box.CompileRun("resume", str(tmp_path), 1)
    monkeypatch.setitem(compile_box.RUNS, "resume", run)
    monkeypatch.setattr(compile_box, "_await_session_live", AsyncMock(return_value=None))
    dispatch = AsyncMock(return_value={"ok": True})
    monkeypatch.setattr(compile_box, "_dispatch_authoring_turn", dispatch)
    request = SimpleNamespace(match_info={"run_id": "resume"}, json=AsyncMock(return_value=body))

    response = await compile_box.handle_command(request)
    assert response.status == 409
    error = json.loads(response.text)["error"]
    assert "recovery provenance" in error
    assert json.dumps(produced[-1]) in error
    assert "relative to candidate/" in error
    dispatch.assert_not_awaited()
    assert run._accepted_commands == {}
    assert run._command_context is None

    # Correcting the provenance can reuse the rejected command id; nested POSIX
    # paths are accepted, and an exact retry dispatches only once.
    parameters["produced_pages"] = valid
    if source == "file":
        provenance.write_text(json.dumps({"produced_count": len(valid), "produced_pages": valid}))
    response = await compile_box.handle_command(request)
    assert response.status == 200
    dispatch.assert_awaited_once()
    response = await compile_box.handle_command(request)
    assert response.status == 200
    assert json.loads(response.text)["duplicate"] is True
    dispatch.assert_awaited_once()


def test_missing_page_diagnostic_is_bounded(tmp_path):
    produced = [f"missing-{i}-{'x' * 480}.md" for i in range(20)]
    run = compile_box.CompileRun("complete", str(tmp_path), 1)
    command = {"action": "compile.resume", "parameters": {
        "recovery_mode": "complete", "produced_count": len(produced), "produced_pages": produced,
    }}
    compile_box._prepare_command(run, command)
    with pytest.raises(compile_box.CommandRejected) as exc:
        compile_box._render_command(run, command)
    assert exc.value.status == 409
    assert "20 page(s)" in str(exc.value)
    assert "missing-0-" in str(exc.value)
    assert len(str(exc.value)) < 1200


@pytest.mark.parametrize("large", [False, True])
async def test_planless_complete_delivers_preservation_directive(monkeypatch, tmp_path, large):
    for folder in ("raw", "candidate", "authoring"):
        (tmp_path / folder).mkdir()
    raw = "source fact\n" * (110000 if large else 1)
    (tmp_path / "raw/guide.md").write_text(raw)
    pages = [f"topic-{i}.md" for i in range(201)]
    for page in pages:
        (tmp_path / "candidate" / page).write_text("# Topic\n")
    (tmp_path / "authoring/RECOVERY_PROVENANCE.json").write_text(json.dumps({
        "produced_count": len(pages), "produced_pages": pages,
    }))
    monkeypatch.setenv("KBC_BATCH_MODE", "on")
    monkeypatch.setenv("KBC_BATCH_THRESHOLD_BYTES", str(batching.DEFAULT_BATCH_THRESHOLD_BYTES))
    run = compile_box.CompileRun("complete", str(tmp_path), 1)
    run.client = SimpleNamespace(query=AsyncMock())
    batch = AsyncMock()
    monkeypatch.setattr(compile_box, "_run_batch_compile", batch)
    command = {"action": "compile.resume", "parameters": {
        "recovery_mode": "complete", "produced_count": 201, "produced_pages": pages[:200],
    }}
    compile_box._prepare_command(run, command)
    directive = compile_box._render_command(run, command)
    assert "Do not restart from scratch" in directive
    assert compile_box._resume_workspace_state(run) == "complete"
    result = await compile_box._dispatch_authoring_turn(run, directive, "compile.resume")
    assert result == {"ok": True}
    run.client.query.assert_awaited_once_with(directive)
    batch.assert_not_called()


@pytest.mark.parametrize("marker", ["plan", "reset"])
def test_existing_batch_ownership_precedes_size_and_mode(monkeypatch, tmp_path, marker):
    (tmp_path / "authoring").mkdir()
    if marker == "plan":
        (tmp_path / batching.BATCH_PLAN_PATH).write_text(json.dumps({
            "version": 3, "phase": "map", "batches": [{"id": "b1", "status": "pending", "sources": ["a.md"]}],
        }))
    else:
        (tmp_path / compile_box.RECOVERY_RESET_PATH).write_text("{}")
    monkeypatch.setenv("KBC_BATCH_MODE", "off")
    run = compile_box.CompileRun("plan", str(tmp_path), 1)
    # A pending plan/reset owns recovery even when the completion classification
    # references pages that the batch train has not materialized yet.
    command = {"action": "compile.resume", "parameters": {
        "recovery_mode": "complete", "produced_count": 1, "produced_pages": ["pending.md"],
    }}
    compile_box._prepare_command(run, command)
    assert compile_box._render_command(run, command) == compile_box._command_strings(run.locale)["compile.resume"]
    assert compile_box._resume_workspace_state(run) == "plan"
    assert compile_box._should_route_to_batch(run, "", "compile.resume")
    run._batch_active = True
    assert not compile_box._should_route_to_batch(run, "", "compile.resume")


async def test_restart_uses_size_but_incremental_keeps_precedence(monkeypatch, tmp_path):
    (tmp_path / "raw").mkdir()
    (tmp_path / "authoring").mkdir()
    (tmp_path / "raw/a.md").write_text("source fact\n" * 110000)
    monkeypatch.setenv("KBC_BATCH_MODE", "on")
    monkeypatch.setenv("KBC_BATCH_THRESHOLD_BYTES", str(batching.DEFAULT_BATCH_THRESHOLD_BYTES))
    run = compile_box.CompileRun("restart", str(tmp_path), 1)
    compile_box._prepare_command(run, {"action": "compile.resume", "parameters": {"recovery_mode": "restart"}})
    assert compile_box._should_route_to_batch(run, "", "compile.resume")
    (tmp_path / "authoring/RAW_CHANGES.json").write_text(json.dumps({"added": ["a.md"], "modified": [], "deleted": []}))
    incremental = AsyncMock()
    batch = AsyncMock()
    monkeypatch.setattr(compile_box, "_start_incremental", incremental)
    monkeypatch.setattr(compile_box, "_run_batch_compile", batch)
    result = await compile_box._dispatch_authoring_turn(run, "continue", "compile.resume")
    assert result == {"ok": True, "incremental": True}
    incremental.assert_awaited_once()
    batch.assert_not_called()
