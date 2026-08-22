"""Shared persistent-engine contract for the KBC compile box.

The compile orchestrator intentionally consumes a tiny duck-typed client
surface.  Engine adapters translate their native SDK events into these stable
message values so the mature turn/watchdog/sync loop remains single-sourced.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import AsyncIterator, Awaitable, Callable, Protocol


@dataclass(frozen=True)
class EngineTool:
    """One engine-neutral tool body owned by the Python KBC controller."""

    name: str
    description: str
    input_schema: dict
    handler: Callable[[dict], Awaitable[str]]


class TextBlock:
    def __init__(self, text: str):
        self.text = text


class ToolUseBlock:
    def __init__(self, name: str, input_: dict | None = None):
        self.name = name
        self.input = input_ or {}


class AssistantMessage:
    def __init__(self, content: list):
        self.content = content


class StreamEvent:
    """A content-free liveness event consumed by the stall watchdog."""


class ResultMessage:
    def __init__(
        self,
        *,
        is_error: bool = False,
        api_error_status: int | None = None,
        subtype: str = "success",
        usage: dict | None = None,
        num_turns: int = 0,
    ):
        self.is_error = is_error
        self.api_error_status = api_error_status
        self.subtype = subtype
        self.usage = usage
        self.num_turns = num_turns


class PersistentEngineClient(Protocol):
    session_id: str

    async def connect(self) -> None: ...

    async def query(self, text: str) -> None: ...

    def receive_messages(self) -> AsyncIterator[object]: ...

    async def interrupt(self) -> None: ...

    async def disconnect(self) -> None: ...

    async def get_context_usage(self) -> dict: ...
