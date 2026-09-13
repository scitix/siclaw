"""Provider-native Claude stream usage; SDK aggregate defaults are not evidence."""

import uuid
from datetime import datetime, timezone

_FIELDS = ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")


def _now():
    return datetime.now(timezone.utc).isoformat()


class ClaudeUsageRecorder:
    def __init__(self, session_id, config, observer):
        self.session_id, self.config, self.observer = session_id, config, observer
        self.call = None
        self.seen = set()
        self.raw = {}
        self.terminal = False
        self.response_id = None
        self.response_model = None

    async def observe(self, event, turn_id):
        kind = event.get("type")
        if kind == "message_start":
            await self.finish("incomplete", turn_id)
            model = self.config["model"]
            self.call = {
                "schemaVersion": 1, "callId": str(uuid.uuid4()), "phase": "started",
                "sessionId": self.session_id, "requestId": turn_id, "requestAt": _now(),
                "kind": "agent", "executionRole": "root", "routingAttempt": 1,
                "executorRole": self.config.get("role", "compile"),
                "model": {"configId": "", "name": model.get("name", model["id"]),
                          "sourceKind": "unknown", "sourceId": "", "sourceName": "",
                          "requestedId": model["id"], "runtimeProvider": model["provider"]},
            }
            message = event.get("message") or {}
            self.response_id, self.response_model = message.get("id"), message.get("model")
            self.raw, self.terminal = {}, False
            self._merge(message.get("usage"))
            await self._emit(self.call, turn_id)
        elif kind == "message_delta" and self.call:
            self._merge(event.get("usage"))
        elif kind == "message_stop" and self.call:
            self.terminal = True
            await self.finish("success", turn_id)

    def _merge(self, usage):
        if isinstance(usage, dict):
            for key in _FIELDS:
                if key in usage:
                    # Preserve invalid numeric types as invalid markers, never
                    # coerce them to zero or retain arbitrary provider content.
                    self.raw[key] = usage[key] if type(usage[key]) in (int, float) else "invalid"

    async def _emit(self, observation, turn_id):
        await self.observer.emit("model_usage", {"observation": observation}, turn_id)

    async def finish(self, outcome, turn_id):
        if self.call is None:
            return
        call, self.call = self.call, None
        call = {**call, "phase": "finished", "finishedAt": _now(), "outcome": outcome,
                "usageEvidence": {"protocol": "anthropic", "providerUsagePresent": bool(self.raw),
                                  "finality": "terminal" if self.terminal else "intermediate", "rawUsage": dict(self.raw)}}
        if isinstance(self.response_id, str):
            call["responseId"] = self.response_id[:256]
        if isinstance(self.response_model, str):
            call["responseModel"] = self.response_model[:200]
        if isinstance(self.response_id, str):
            self.seen.add(self.response_id)
        await self._emit(call, turn_id)

    async def record_unobserved(self, message_id, turn_id):
        # A legacy SDK message can establish that a call happened, but its
        # normalized usage is not raw provider evidence.
        if message_id in self.seen or (self.call is not None and message_id == self.response_id):
            return
        model = self.config["model"]
        at = _now()
        observation = {"schemaVersion": 1, "callId": str(uuid.uuid4()), "phase": "finished",
                       "sessionId": self.session_id, "requestId": turn_id, "requestAt": at, "finishedAt": at,
                       "kind": "agent", "executionRole": "root", "routingAttempt": 1, "outcome": "incomplete",
                       "executorRole": self.config.get("role", "compile"),
                       "model": {"configId": "", "name": model.get("name", model["id"]),
                                 "sourceKind": "unknown", "sourceId": "", "sourceName": "",
                                 "requestedId": model["id"], "runtimeProvider": model["provider"]}}
        if message_id:
            self.seen.add(message_id)
        await self._emit(observation, turn_id)
