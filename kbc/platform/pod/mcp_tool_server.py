#!/usr/bin/env python3
"""Small stdio MCP bridge used by ``codex_engine.CodexSDKClient``.

Tool definitions arrive through environment configuration and calls are sent
to a per-session loopback callback.  This process intentionally owns no KBC
business logic and uses only the Python standard library.
"""

import json
import os
import sys
import urllib.error
import urllib.request


def _reply(message_id, *, result=None, error=None) -> None:
    payload = {"jsonrpc": "2.0", "id": message_id}
    if error is None:
        payload["result"] = result
    else:
        payload["error"] = error
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _tools() -> list[dict]:
    value = json.loads(os.environ.get("KBC_MCP_TOOLS_JSON", "[]"))
    if not isinstance(value, list):
        raise ValueError("KBC_MCP_TOOLS_JSON must be a list")
    return value


def _call(name: str, arguments: dict) -> str:
    request = urllib.request.Request(
        os.environ["KBC_MCP_CALLBACK_URL"],
        data=json.dumps({"name": name, "arguments": arguments}).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "x-kbc-token": os.environ["KBC_MCP_CALLBACK_TOKEN"],
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return str(json.loads(response.read().decode("utf-8"))["text"])
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        raise RuntimeError(detail or str(exc)) from exc


def _handle(message: dict) -> None:
    message_id = message.get("id")
    if message_id is None:
        return
    method = str(message.get("method", ""))
    if method == "initialize":
        _reply(message_id, result={
            "protocolVersion": (message.get("params") or {}).get("protocolVersion", "2025-03-26"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "siclaw-kbc", "version": "1.0"},
        })
    elif method == "tools/list":
        _reply(message_id, result={"tools": _tools()})
    elif method == "tools/call":
        params = message.get("params") or {}
        try:
            text = _call(str(params.get("name", "")), params.get("arguments") or {})
            _reply(message_id, result={"content": [{"type": "text", "text": text}], "isError": False})
        except Exception as exc:
            _reply(message_id, result={
                "content": [{"type": "text", "text": f"tool call failed: {exc}"}],
                "isError": True,
            })
    elif method == "ping":
        _reply(message_id, result={})
    else:
        _reply(message_id, error={"code": -32601, "message": f"method not found: {method}"})


def main() -> None:
    for line in sys.stdin:
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(message, dict):
            _handle(message)


if __name__ == "__main__":
    main()
