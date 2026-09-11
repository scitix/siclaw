"""One consumer and one unacknowledged durable frame per live compile run."""
import asyncio
import contextlib
import json
import uuid

from aiohttp import web


class EventRelay:
    DURABLE_TYPES = frozenset({"syncArtifacts", "turn_done", "error", "done", "end"})

    def __init__(self, events: asyncio.Queue):
        self.events = events
        self._lock = asyncio.Lock()
        self._task: asyncio.Task | None = None
        self._ack_mode: bool | None = None
        self._epoch = uuid.uuid4().hex
        self._sequence = 0
        self._pending: dict | None = None
        self._ack: asyncio.Future | None = None
        self._last_ack: str | None = None

    @property
    def active(self) -> bool:
        return self._task is not None and not self._task.done()

    def acknowledge(self, event_id: str) -> bool:
        if event_id == self._last_ack:
            return False
        if self._pending is None or event_id != self._pending["event_id"]:
            raise ValueError("event_id is not the pending relay event")
        if not self._ack.done():
            self._ack.set_result(True)
        return True

    async def stream(self, request: web.Request, legacy_replay):
        acknowledged = request.query.get("ack") == "1"
        task = asyncio.current_task()
        async with self._lock:
            # A legacy stream may already have discarded an unconfirmed frame.
            # Switching it to replay would incorrectly claim a complete history.
            if self._ack_mode is not None and self._ack_mode != acknowledged:
                return web.Response(status=409, text="live relay protocol cannot change")
            previous = self._task
            if previous is not None and not previous.done():
                previous.cancel()
                with contextlib.suppress(asyncio.CancelledError, ConnectionError):
                    await previous
            self._task = task
            self._ack_mode = acknowledged

        response = web.StreamResponse(headers={
            "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        })
        try:
            await response.prepare(request)
            if acknowledged:
                await self._write(response, {"type": "relay_ready", "event_ack": 1})
            elif request.query.get("replay") == "1":
                for event in legacy_replay():
                    await self._write(response, event)

            while True:
                if self._pending is not None:
                    event = self._pending
                else:
                    try:
                        # No child get-task: takeover cannot cancel between a
                        # child dequeuing a frame and this task retaining it.
                        async with asyncio.timeout(25):
                            event = await self.events.get()
                            if acknowledged and event.get("type") in self.DURABLE_TYPES:
                                self._sequence += 1
                                event = {**event, "event_id": f"{self._epoch}:{self._sequence}"}
                                self._pending = event
                                self._ack = asyncio.get_running_loop().create_future()
                    except TimeoutError:
                        await response.write(b": heartbeat\n\n")
                        continue
                if self._pending is not None:
                    # Keep this frame even if write succeeds locally but the
                    # peer never receives it. Only its persistence ACK releases it.
                    await self._write(response, event)
                    while not self._ack.done():
                        try:
                            # Takeover cancels this handler, not the persistence
                            # receipt the next handler must continue waiting for.
                            await asyncio.wait_for(asyncio.shield(self._ack), 25)
                        except TimeoutError:
                            await response.write(b": heartbeat\n\n")
                    self._last_ack = event["event_id"]
                    self._pending = None
                    self._ack = None
                    self.events.task_done()
                else:
                    try:
                        await self._write(response, event)
                    finally:
                        self.events.task_done()
                if event.get("type") == "end":
                    return response
        finally:
            if self._task is task:
                self._task = None

    @staticmethod
    async def _write(response, event):
        await response.write(("data: " + json.dumps(event, ensure_ascii=False) + "\n\n").encode())
