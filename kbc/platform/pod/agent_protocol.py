"""KBC-owned execution protocol; no provider SDK objects cross this boundary."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import AsyncIterator, Awaitable, Callable, Protocol


@dataclass(frozen=True)
class EngineTool:
    name: str
    description: str
    input_schema: dict
    handler: Callable[[dict], Awaitable[str | dict]]


@dataclass(frozen=True)
class AgentEvent:
    kind: str
    session_id: str
    turn_id: str = ""
    data: dict = field(default_factory=dict)


class AgentTransportError(RuntimeError):
    """The execution worker is unavailable; the host owns reconstruction."""


def is_result(message: AgentEvent) -> bool:
    return message.kind == "result"


def message_field(message: AgentEvent, key: str, default=None):
    """Project the execution result into the compiler's existing turn contract."""
    if key == "is_error":
        return message.data.get("outcome") != "completed"
    if key == "subtype":
        if message.data.get("outcome") == "completed":
            return "success"
        return "error_max_turns" if "KBC_MODEL_CALL_BUDGET_EXCEEDED" in message.data.get("error", "") else message.data.get("outcome", default)
    return message.data.get(key, default)


class AgentClient(Protocol):
    @property
    def returncode(self) -> int | None: ...
    async def connect(self) -> None: ...
    async def query(self, message: str) -> None: ...
    def receive_messages(self) -> AsyncIterator[AgentEvent]: ...
    async def interrupt(self) -> None: ...
    async def disconnect(self) -> None: ...
