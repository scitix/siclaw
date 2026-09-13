import asyncio
import contextlib
import json
from types import SimpleNamespace

import pytest

from event_relay import EventRelay


class Socket:
    def __init__(self, fail=False, block=False):
        self.fail = fail
        self.block = block
        self.frames = []
        self.writing = asyncio.Event()

    async def prepare(self, request):
        pass

    async def write(self, data):
        if data.startswith(b":"):
            return
        event = json.loads(data.decode()[6:])
        self.frames.append(event)
        if "event_id" in event:
            self.writing.set()
            if self.fail:
                raise ConnectionResetError("reset during write")
            if self.block:
                await asyncio.Future()


async def until(predicate):
    async with asyncio.timeout(2):
        while not predicate():
            await asyncio.sleep(0)


async def stop(task):
    if not task.done():
        task.cancel()
    with contextlib.suppress(asyncio.CancelledError, ConnectionResetError):
        await task


def attach(monkeypatch, relay, socket, ack=True):
    monkeypatch.setattr("event_relay.web.StreamResponse", lambda **kwargs: socket)
    request = SimpleNamespace(query={"replay": "1", **({"ack": "1"} if ack else {})})
    return asyncio.create_task(relay.stream(request, lambda: []))


@pytest.mark.parametrize("kind", ["error", "turn_done", "done", "end", "syncArtifacts"])
async def test_write_loss_replays_same_durable_frame_until_ack(monkeypatch, kind):
    queue = asyncio.Queue()
    relay = EventRelay(queue)
    await queue.put({"type": kind, "text": "one durable result"})
    old = Socket(fail=True)
    first = attach(monkeypatch, relay, old)
    await until(first.done)
    assert isinstance(first.exception(), ConnectionResetError)
    lost = old.frames[-1]
    assert queue.qsize() == 0 and queue._unfinished_tasks == 1
    new = Socket()
    second = attach(monkeypatch, relay, new)
    try:
        await new.writing.wait()
        assert new.frames == [{"type": "relay_ready", "event_ack": 1}, lost]
        assert relay.acknowledge(lost["event_id"])
        await asyncio.wait_for(queue.join(), 1)
        assert relay.acknowledge(lost["event_id"]) is False
        assert relay._pending is None
    finally:
        await stop(second)


@pytest.mark.parametrize("during_write", [False, True])
async def test_new_attachment_fences_old_queue_consumer(monkeypatch, during_write):
    queue = asyncio.Queue()
    relay = EventRelay(queue)
    old = Socket(block=during_write)
    first = attach(monkeypatch, relay, old)
    await until(lambda: relay.active)
    if during_write:
        await queue.put({"type": "error", "code": "session_failed"})
        await old.writing.wait()
    else:
        await until(lambda: len(queue._getters) == 1)
    new = Socket()
    second = attach(monkeypatch, relay, new)
    try:
        await until(lambda: first.done() and relay._task is second)
        assert first.cancelled()
        if not during_write:
            await queue.put({"type": "error", "code": "session_failed"})
        await new.writing.wait()
        assert new.frames[-1]["type"] == "error"
        if during_write:
            assert new.frames[-1] == old.frames[-1]
        else:
            assert len(old.frames) == 1  # handshake only; no stolen failure
        relay.acknowledge(new.frames[-1]["event_id"])
        await asyncio.wait_for(queue.join(), 1)
        assert len(queue._getters) <= 1
    finally:
        await stop(second)


async def test_artifact_turn_and_terminal_stay_ordered_across_takeover(monkeypatch):
    queue = asyncio.Queue()
    relay = EventRelay(queue)
    for kind in ["syncArtifacts", "turn_done", "error", "end"]:
        await queue.put({"type": kind})
    old = Socket()
    first = attach(monkeypatch, relay, old)
    await old.writing.wait()
    artifact = old.frames[-1]
    assert len(old.frames) == 2 and queue.qsize() == 3
    new = Socket()
    second = attach(monkeypatch, relay, new)
    try:
        await new.writing.wait()
        assert first.cancelled() and new.frames[-1] == artifact
        for index, kind in enumerate(["syncArtifacts", "turn_done", "error", "end"], 1):
            await until(lambda: len(new.frames) == index + 1)
            event = new.frames[-1]
            assert event["type"] == kind
            # Exactly one retained frame; later events remain in the queue.
            assert relay._pending is event or relay._pending == event
            assert len(new.frames) == index + 1
            relay.acknowledge(event["event_id"])
        await asyncio.wait_for(second, 1)
        await asyncio.wait_for(queue.join(), 1)
        assert not relay.active
    finally:
        await stop(second)


async def test_legacy_stream_cannot_claim_reliable_replay_after_upgrade(monkeypatch):
    queue = asyncio.Queue()
    relay = EventRelay(queue)
    old = Socket()
    task = attach(monkeypatch, relay, old, ack=False)
    await until(lambda: len(queue._getters) == 1)
    try:
        response = await relay.stream(SimpleNamespace(query={"ack": "1"}), lambda: [])
        assert response.status == 409 and relay._task is task
        with pytest.raises(ValueError):
            relay.acknowledge("unknown")
    finally:
        await stop(task)


async def test_ack_route_rejects_wrong_id_and_accepts_duplicate(monkeypatch, tmp_path):
    import compile_box
    run = compile_box.CompileRun("relay-ack", str(tmp_path), 1)
    monkeypatch.setitem(compile_box.RUNS, run.run_id, run)
    await run.emit({"type": "end"})
    socket = Socket()
    task = attach(monkeypatch, run.event_relay, socket)
    await socket.writing.wait()

    async def response(value):
        async def body():
            return {"event_id": value}
        return await compile_box.handle_event_ack(SimpleNamespace(match_info={"run_id": run.run_id}, json=body))

    try:
        assert (await response(None)).status == 400
        assert (await response("wrong-id")).status == 409
        event_id = socket.frames[-1]["event_id"]
        assert (await response(event_id)).status == 200
        await asyncio.wait_for(task, 1)
        assert (await response(event_id)).status == 200
    finally:
        await stop(task)


async def test_http_reconnect_replays_failure_before_end(monkeypatch, tmp_path):
    from aiohttp.test_utils import TestClient, TestServer
    import compile_box

    run = compile_box.CompileRun("http-relay", str(tmp_path), 1)
    monkeypatch.setitem(compile_box.RUNS, run.run_id, run)
    await run.emit({"type": "error", "code": "session_failed"})
    await run.emit({"type": "end"})

    async def frame(response):
        async with asyncio.timeout(2):
            while True:
                line = await response.content.readline()
                assert line, "unexpected stream EOF"
                if line.startswith(b"data: "):
                    return json.loads(line[6:])

    async with TestClient(TestServer(compile_box.build_app())) as client:
        first = await client.get(f"/events/{run.run_id}?ack=1")
        assert (await frame(first))["type"] == "relay_ready"
        failure = await frame(first)
        second = await client.get(f"/events/{run.run_id}?ack=1&replay=1")
        assert (await frame(second))["type"] == "relay_ready"
        assert await frame(second) == failure
        first.close()
        ack = await client.post(f"/events/ack/{run.run_id}", json={"event_id": failure["event_id"]})
        assert ack.status == 200
        end = await frame(second)
        assert end["type"] == "end"
        ack = await client.post(f"/events/ack/{run.run_id}", json={"event_id": end["event_id"]})
        assert ack.status == 200
        await asyncio.wait_for(second.read(), 2)
        await asyncio.wait_for(run.events.join(), 2)
