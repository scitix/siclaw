"""API-key Responses wire contract through the real Pi worker and host tools."""

import json

from aiohttp import web

from test_pi_engine import client, collect, provider, allow
from pi_file_tools import FileTools


def response(*, tool=None, text="done", status="completed"):
    reasoning = {"id": "rs_fixture", "type": "reasoning", "summary": [],
                 "encrypted_content": "opaque-reasoning-fixture"}
    item = ({"type": "function_call", "id": "fc_fixture", "call_id": "call_fixture",
             "name": tool[0], "arguments": json.dumps(tool[1], ensure_ascii=False), "status": "completed"}
            if tool else {"type": "message", "id": "msg_fixture", "role": "assistant",
                          "status": "completed", "phase": "final_answer",
                          "content": [{"type": "output_text", "text": text, "annotations": []}]})
    output = [reasoning, item]
    events = [{"type": "response.created", "response": {"id": "resp_fixture"}}]
    for index, value in enumerate(output):
        events.append({"type": "response.output_item.done", "output_index": index, "item": value})
    events.append({"type": "response." + status, "response": {
        "id": "resp_fixture", "status": status, "output": output,
        "usage": {"input_tokens": 42, "output_tokens": 8, "total_tokens": 50,
                  "input_tokens_details": {"cached_tokens": 12}},
        **({"incomplete_details": {"reason": "max_output_tokens"}} if status == "incomplete" else {}),
    }})
    return web.Response(text="".join(f"event: {event['type']}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n" for event in events),
                        content_type="text/event-stream")


async def test_responses_replays_reasoning_and_host_tool_results(tmp_path):
    content = "尾部事实：恢复阈值 291。🚀\n"
    async with provider(lambda _, n: response(tool=("Write", {"file_path": "page.md", "content": content}))
                        if n == 1 else response(text="Written"), api="openai-responses") as (config, requests):
        config["model"]["reasoning"] = True
        config["model"]["compat"] = {"sessionAffinityFormat": "openai-nosession"}
        config["thinking_level"] = "low"
        async with client(tmp_path, config, FileTools(str(tmp_path), ["Write"], allow).tools()) as instance:
            await instance.query("Write a knowledge page")
            events = await collect(instance)
        assert (tmp_path / "page.md").read_text() == content
        assert len(requests) == 2
        assert all(request["store"] is False and request["stream"] for request in requests)
        first = requests[0]
        assert first["tools"][0]["type"] == "function"
        assert first["reasoning"]["effort"] == "low"
        replay = requests[1]["input"]
        assert next(item for item in replay if item.get("type") == "reasoning")["encrypted_content"] == "opaque-reasoning-fixture"
        call = next(item for item in replay if item.get("type") == "function_call")
        result = next(item for item in replay if item.get("type") == "function_call_output")
        assert result["call_id"] == call["call_id"]
        assert "page.md" in result["output"]
        assert events[-1].data["outcome"] == "completed"
        assert events[-1].data["model_calls"] == 2


async def test_responses_read_failure_returns_to_model(tmp_path):
    async with provider(lambda _, n: response(tool=("Read", {"file_path": "missing.md"}))
                        if n == 1 else response(text="Source is missing"), api="openai-responses") as (config, requests):
        async with client(tmp_path, config, FileTools(str(tmp_path), ["Read"], allow).tools()) as instance:
            await instance.query("Read source")
            events = await collect(instance)
        result = next(item for item in requests[1]["input"] if item.get("type") == "function_call_output")
        assert "missing.md" in result["output"]
        assert events[-1].data["outcome"] == "completed"
