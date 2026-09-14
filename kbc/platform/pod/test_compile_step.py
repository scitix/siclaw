"""Exercise worker ownership through the production batch and planner drivers."""

import asyncio
from types import SimpleNamespace

import pytest

import compile_box
from agent_protocol import AgentEvent, AgentTransportError


class Client:
    returncode = None

    def __init__(self, events=(), on_query=None):
        self.events = events
        self.on_query = on_query
        self.connected = False
        self.disconnected = False
        self.interrupts = 0

    async def connect(self):
        self.connected = True

    async def query(self, text):
        if self.on_query:
            await self.on_query()

    async def receive_messages(self):
        for event in self.events:
            if isinstance(event, Exception):
                raise event
            yield event

    async def disconnect(self):
        self.disconnected = True

    async def interrupt(self):
        self.interrupts += 1


def assistant(text):
    return AgentEvent("assistant", "worker", data={"content": [{"type": "text", "text": text}]})


def result(outcome="completed"):
    return AgentEvent("result", "worker", data={"outcome": outcome})


def drain(run):
    events = []
    while not run.events.empty():
        events.append(run.events.get_nowait())
    return events


@pytest.fixture
def run(tmp_path, monkeypatch):
    run = compile_box.CompileRun("fixture-run", str(tmp_path), 1)
    run.client = Client()
    run._turn_text = ["owner reply"]
    run._batch_active = True
    monkeypatch.setattr(compile_box, "_compile_system_prompt", lambda _: "fixture")
    return run


async def test_batch_keeps_conversation_client_and_returns_only_its_reply(run, monkeypatch):
    owner = run.client

    async def observe_owner():
        assert run.client is owner
        assert not owner.disconnected

    worker = Client([assistant("step output"), result()], observe_owner)
    monkeypatch.setattr(compile_box, "_compile_session_client", lambda *a, **kw: worker)
    reply = await compile_box._drive_batch_session(run, "compile scope", "fixture")
    assert reply == "step output"
    assert run._turn_text == ["owner reply"]
    assert run.client is owner and not owner.disconnected
    assert worker.disconnected and run._active_step is None
    assert not run._turn_active
    assert not any(e["type"] in {"turn_done", "syncArtifacts"} for e in drain(run))


async def test_batch_rebuild_discards_only_failed_worker_text(run, monkeypatch):
    failed = Client([assistant("incomplete"), AgentTransportError("fixture disconnect")])
    recovered = Client([assistant("recovered"), result()])
    workers = iter([failed, recovered])
    monkeypatch.setattr(compile_box, "_compile_session_client", lambda *a, **kw: next(workers))
    assert await compile_box._drive_batch_session(run, "compile scope", "fixture") == "recovered"
    assert failed.disconnected and recovered.disconnected
    assert run._turn_text == ["owner reply"]
    assert run._active_step is None
    assert not any(e["type"] == "turn_done" for e in drain(run))


async def test_failed_step_does_not_finalize_conversation_or_commit(run, monkeypatch):
    worker = Client([assistant("partial"), result("failed")])
    monkeypatch.setattr(compile_box, "_compile_session_client", lambda *a, **kw: worker)
    with pytest.raises(compile_box.ModelResultError):
        await compile_box._drive_batch_session(run, "compile scope", "fixture")
    assert run._turn_text == ["owner reply"]
    assert run._active_step is None and not run._turn_active
    assert worker.disconnected
    assert not any(e["type"] in {"turn_done", "syncArtifacts"} for e in drain(run))


async def test_step_cancellation_retains_ownership_until_teardown(run):
    entered, teardown, release = asyncio.Event(), asyncio.Event(), asyncio.Event()

    async def wait_for_cancel():
        entered.set()
        await asyncio.Future()

    class SlowClose(Client):
        async def disconnect(self):
            teardown.set()
            await release.wait()
            await super().disconnect()

    worker = SlowClose(on_query=wait_for_cancel)
    task = asyncio.create_task(compile_box._execute_compile_step(run, worker, "compile scope"))
    try:
        await asyncio.wait_for(entered.wait(), 1)
        task.cancel()
        await asyncio.wait_for(teardown.wait(), 1)
        assert run._active_step.client is worker
        competitor = Client()
        with pytest.raises(RuntimeError, match="already owns execution"):
            await compile_box._execute_compile_step(run, competitor, "other scope")
        assert not competitor.connected
        with pytest.raises(RuntimeError, match="owns execution"):
            await run.inject_user_message("unrelated repair")
    finally:
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert worker.disconnected and run._active_step is None
    assert not run._turn_active and not run._stall_retrying
    assert not run.client.disconnected


async def test_watchdog_targets_step_worker_without_interrupting_owner(run, monkeypatch):
    entered = asyncio.Event()
    owner = run.client
    monkeypatch.setattr(compile_box, "_MODEL_WATCHDOG_POLL_S", 0.001)

    class ExitedClient(Client):
        returncode = 1

        async def receive_messages(self):
            entered.set()
            while not self.disconnected:
                await asyncio.sleep(0.001)
            if False:
                yield

    worker = ExitedClient()
    watchdog = asyncio.create_task(compile_box._model_stall_watchdog(run))
    try:
        with pytest.raises(compile_box.ModelStallError):
            await asyncio.wait_for(compile_box._execute_compile_step(run, worker, "compile scope"), 1)
    finally:
        run.done = True
        watchdog.cancel()
        with pytest.raises(asyncio.CancelledError):
            await watchdog
    assert entered.is_set() and worker.disconnected
    assert not owner.disconnected and owner.interrupts == 0
    assert run._turn_text == ["owner reply"]
    assert not any(e["type"] == "turn_done" for e in drain(run))


async def test_planner_result_has_step_semantics(run, monkeypatch):
    monkeypatch.setenv("KBC_BATCH_PLANNER", "model")
    owner = run.client

    async def check_owner():
        assert run.client is owner

    worker = Client([assistant("planner output"), result()], check_owner)
    monkeypatch.setattr(compile_box, "create_agent_client", lambda **kw: worker)
    monkeypatch.setattr(compile_box.pi_config, "for_role", lambda *a, **kw: {})
    inventory = [{"path": "source.md", "bytes": 10, "effective": 10}]
    plan = await compile_box._plan_batches(run, inventory)
    assert plan["batches"]
    assert run.client is owner and worker.disconnected
    assert run._turn_text == ["owner reply"]
    assert run._active_step is None
    assert not any(e["type"] in {"turn_done", "syncArtifacts"} for e in drain(run))


async def test_connect_failure_releases_step_without_touching_owner(run):
    class FailedConnect(Client):
        async def connect(self):
            raise AgentTransportError("fixture connection failure")

    worker = FailedConnect()
    with pytest.raises(AgentTransportError):
        await compile_box._execute_compile_step(run, worker, "compile scope")
    assert worker.disconnected and run._active_step is None
    assert not run.client.disconnected and not run._turn_active


async def test_unconfirmed_teardown_blocks_rebuild_and_new_messages(run, monkeypatch):
    class BrokenClose(Client):
        async def disconnect(self):
            raise AgentTransportError("fixture teardown failure")

    worker = BrokenClose([result()])
    creations = []

    def create(*a, **kw):
        creations.append(worker)
        return worker

    monkeypatch.setattr(compile_box, "_compile_session_client", create)
    with pytest.raises(RuntimeError, match="teardown was not confirmed"):
        await compile_box._drive_batch_session(run, "compile scope", "fixture")
    assert len(creations) == 1
    assert run._active_step.client is worker and run._active_step.teardown_failed
    assert not run._turn_active
    run.connected.set()
    response = await compile_box._await_session_live(run)
    assert response.status == 409
    with pytest.raises(RuntimeError, match="already owns execution"):
        await compile_box._execute_compile_step(run, Client(), "new scope")
    assert not run.client.disconnected


async def test_each_step_returns_its_own_reply(run, monkeypatch):
    workers = iter([Client([assistant("first"), result()]), Client([assistant("second"), result()])])
    monkeypatch.setattr(compile_box, "_compile_session_client", lambda *a, **kw: next(workers))
    assert await compile_box._drive_batch_session(run, "scope one", "one") == "first"
    assert await compile_box._drive_batch_session(run, "scope two", "two") == "second"
    assert run._turn_text == ["owner reply"]
    assert run._active_step is None


async def test_step_cannot_take_over_an_active_persistent_turn(run):
    run._begin_turn("owner edit")
    worker = Client([result()])
    with pytest.raises(RuntimeError, match="already owns execution"):
        await compile_box._execute_compile_step(run, worker, "compile scope")
    assert run._turn_active
    assert run._last_directive == "owner edit"
    assert not worker.connected
    assert not run.client.disconnected


async def test_batch_with_unconfirmed_teardown_keeps_sync_and_finalization_closed(run, monkeypatch, tmp_path):
    slices = tmp_path / ".kbc-batch-slices"
    slices.mkdir()
    finalized = []

    async def fail_plan(*args):
        run._active_step = compile_box.CompileStep(Client(), teardown_failed=True)
        raise RuntimeError("fixture teardown was not confirmed")

    async def settle(*args):
        finalized.append("settled")

    monkeypatch.setattr(compile_box, "_plan_batches", fail_plan)
    monkeypatch.setattr(compile_box, "_maybe_start_pk", lambda _: finalized.append("pk"))
    monkeypatch.setattr(compile_box, "_set_converge_phase", settle)
    await compile_box._run_batch_compile(run, "compile scope")
    assert run._batch_active and run._active_step.teardown_failed
    assert slices.exists()
    assert finalized == []
    with pytest.raises(RuntimeError, match="teardown was not confirmed"):
        await compile_box._sync_workspace(run, {})
    # A legacy reconnect must not manufacture a fresh artifact/commit event
    # from an uncertain filesystem. Already captured checkpoint frames may replay.
    class Relay:
        async def stream(self, request, replay):
            return replay()

    run.event_relay = Relay()
    run._commit_input_replay = True
    monkeypatch.setattr(compile_box, "RUNS", {run.run_id: run})
    request = SimpleNamespace(match_info={"run_id": run.run_id})
    assert await compile_box.handle_events(request) == []
    checkpoint = {"type": "syncArtifacts", "artifacts": [], "sync_id": "checkpoint"}
    run._pending_sync_events["checkpoint"] = checkpoint
    assert await compile_box.handle_events(request) == [checkpoint]
