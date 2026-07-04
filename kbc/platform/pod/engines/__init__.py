#!/usr/bin/env python3
"""engines — engine adapter registry for the compile box.

Engine selection is an IMAGE property (KBC_ENGINE baked into the per-engine
Dockerfile), mirroring the BoxProfile design: `kb-compile` → the claude image,
`kb-compile-codex` → the codex image. The wire contract (/session body, SSE
event vocabulary) carries no engine field — a consumer switches engines by
requesting a different profile, and the box it lands on already IS that engine.

Adapters import lazily so each image only needs its own engine's dependencies
(the codex image ships no claude-agent-sdk, and vice versa nothing codex).
"""
import os

from .base import EngineSession, SessionSpec  # noqa: F401 (re-export)


def engine_kind() -> str:
    return os.environ.get("KBC_ENGINE", "claude")


def create_session(spec: SessionSpec) -> EngineSession:
    kind = engine_kind()
    if kind == "claude":
        from . import claude
        return claude.ClaudeEngineSession(spec)
    if kind == "codex":
        from . import codex
        return codex.CodexEngineSession(spec)
    raise ValueError(f"unknown KBC_ENGINE {kind!r} (expected 'claude' or 'codex')")
