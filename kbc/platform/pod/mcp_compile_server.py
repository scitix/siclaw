#!/usr/bin/env python3
"""mcp_compile_server — stdio MCP server exposing the compile-signal tools to codex.

Spawned BY the codex CLI (declared in $CODEX_HOME/config.toml, written by
engines/codex.py). Tool execution does NOT happen here: tools/call POSTs back
to the box's loopback-only callback listener (KBC_COMPILE_CALLBACK_URL +
per-session bearer token), which runs the engine-neutral bodies
(compile_tools.py) with the live run's emit — so a codex-invoked signal is
byte-identical to a claude-invoked one. This process only speaks the protocol.

Stdlib-only, newline-delimited JSON-RPC 2.0 (the MCP stdio transport). Handles:
initialize, notifications/* (ignored), tools/list, tools/call, ping.
"""
import json
import os
import sys
import urllib.error
import urllib.request

# codex spawns this with cwd = the session workdir, not /app — make the specs
# importable from the file's own directory.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import compile_tools  # noqa: E402


def _json_schema(params: dict) -> dict:
    props = {
        name: {"type": "array" if kind == "array" else "string", "items": {}} if kind == "array"
        else {"type": "string"}
        for name, kind in params.items()
    }
    return {"type": "object", "properties": props, "required": sorted(params)}


def _tools_payload() -> list[dict]:
    return [
        {"name": t["name"], "description": t["description"], "inputSchema": _json_schema(t["params"])}
        for t in compile_tools.TOOL_SPECS
    ]


def _call_box(name: str, arguments: dict) -> str:
    url = os.environ["KBC_COMPILE_CALLBACK_URL"]
    token = os.environ["KBC_COMPILE_CALLBACK_TOKEN"]
    req = urllib.request.Request(
        url,
        data=json.dumps({"name": name, "arguments": arguments}).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-kbc-token": token},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))["text"]


def _reply(msg_id, result=None, error=None) -> None:
    out = {"jsonrpc": "2.0", "id": msg_id}
    if error is not None:
        out["error"] = error
    else:
        out["result"] = result
    sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def handle(msg: dict) -> None:
    method = msg.get("method", "")
    msg_id = msg.get("id")
    if msg_id is None:
        return  # notification (e.g. notifications/initialized) — nothing to answer
    if method == "initialize":
        _reply(msg_id, {
            "protocolVersion": (msg.get("params") or {}).get("protocolVersion", "2025-03-26"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "kbc-compile", "version": "1.0"},
        })
    elif method == "tools/list":
        _reply(msg_id, {"tools": _tools_payload()})
    elif method == "tools/call":
        params = msg.get("params") or {}
        name = str(params.get("name", ""))
        arguments = params.get("arguments") or {}
        try:
            text = _call_box(name, arguments)
            _reply(msg_id, {"content": [{"type": "text", "text": text}], "isError": False})
        except (urllib.error.URLError, urllib.error.HTTPError, KeyError, ValueError, OSError) as e:
            # Surface the failure TO THE MODEL (isError result, not a protocol
            # error): the agent should see "signal did not land" and retry/report,
            # not have its harness torn down by a transient callback hiccup.
            _reply(msg_id, {"content": [{"type": "text", "text": f"tool {name} failed: {e}"}], "isError": True})
    elif method == "ping":
        _reply(msg_id, {})
    else:
        _reply(msg_id, error={"code": -32601, "message": f"method not found: {method}"})


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        handle(msg)


if __name__ == "__main__":
    main()
