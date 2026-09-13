"""Metadata-only observations shared by compiler execution adapters."""

import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone

_OBSERVER: ContextVar = ContextVar("compiler_execution_observer", default=None)


def _observation_metadata(value):
    # Providers may echo the entire request in an error, including prompt/tool
    # contents. Keep it in the private owner channel, never diagnostic records.
    if isinstance(value, dict):
        return {key: _observation_metadata(item) for key, item in value.items()
                if key != "error_message"}
    if isinstance(value, list):
        return [_observation_metadata(item) for item in value]
    return value


@contextmanager
def observe_sessions(observer):
    """Scope all child sessions, including concurrent verification agents, to
    the caller's observation sink without process-global run routing."""
    token = _OBSERVER.set(observer)
    try:
        yield
    finally:
        _OBSERVER.reset(token)


class ExecutionObserver:
    def __init__(self, session_id: str, config: dict):
        self.session_id = session_id
        self.config = config
        self._observer = _OBSERVER.get()

    async def emit(self, kind: str, data: dict, turn_id: str = "") -> None:
        if self._observer is None:
            return
        fields = {
            "ready": ("sdk_version",),
            "model_request": ("call", "model", "provider"),
            "model_envelope": ("manifest",),
            "model_usage": ("observation",),
            "assistant": ("llm_call", "stop_reason"),
            "tool_start": ("call_id", "name"),
            "tool_end": ("call_id", "name", "is_error"),
            "result": ("outcome", "api_error_status", "model_calls", "tool_calls", "usage"),
            "transport_error": (),
        }.get(kind)
        if fields is None:
            return
        metadata = _observation_metadata({key: data[key] for key in fields if key in data})
        if kind == "ready" and self.config.get("agent_type"):
            metadata["agent_type"] = self.config["agent_type"]
        if kind == "result" and data.get("outcome") != "completed":
            metadata["failure_code"] = "interrupted" if data.get("outcome") == "aborted" else "model_request_failed"
        elif kind == "transport_error":
            metadata["failure_code"] = "worker_transport_failed"
        await self._observer({
            "version": 1, "id": str(uuid.uuid4()), "session_id": self.session_id,
            "turn_id": turn_id, "kind": kind,
            "observed_at": datetime.now(timezone.utc).isoformat(),
            "role": self.config.get("role", "compile"),
            "model_id": self.config["model"]["id"],
            "provider": self.config["model"]["provider"],
            "data": metadata,
        })

