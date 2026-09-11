"""Owner-visible regressions from the compiler review, through the real worker."""

import asyncio
import json

from aiohttp import web

import compile_box
from agent_protocol import EngineTool
from test_pi_engine import client, collect, completion, provider
from test_pi_harness import configure


async def test_failed_proposal_does_not_revert_next_owner_edit(tmp_path, monkeypatch):
    candidate = tmp_path / "candidate"
    candidate.mkdir()
    for page in ("index.md", "a.md", "b.md"):
        (candidate / page).write_text(f"# {page}\nOriginal content.\n")
    monkeypatch.setattr(compile_box, "_l1_repair_round_limit", lambda _: 0)

    def respond(_, number):
        if number == 1:
            return web.json_response({"error": {"message": "invalid request"}}, status=400)
        if number == 2:
            return completion(tool=("Write", {"file_path": "candidate/b.md", "content": "# B\nOwner changed B.\n"}))
        return completion("Updated B.")

    async with provider(respond) as (config, _):
        configure(monkeypatch, config)
        run = compile_box.CompileRun("review-scope", str(tmp_path), 1)
        run.client = compile_box._compile_session_client(run, str(tmp_path), "Help the owner.", "review-scope-session")
        await run.client.connect()
        consume = asyncio.create_task(compile_box._consume_turn_stream(run, run.client, stop_on_result=False))
        try:
            for action, text, pages in (("compile.apply_proposal", "Apply the approved change to A.", ["a.md"]),
                                        (None, "Update B.", None)):
                await compile_box._dispatch_authoring_turn(run, text, action, pages)
                async with asyncio.timeout(15):
                    while (await run.events.get())["type"] != "turn_done":
                        pass
            assert "Owner changed B." in (candidate / "b.md").read_text()
            assert run._incr_pending is None
        finally:
            await run.client.disconnect()
            await consume


async def test_supported_pdf_page_images_reach_the_next_model_request(tmp_path):
    # Twenty small PNGs model the supported maximum PDF page read. The guard's
    # visual-token estimate, not the PNG byte count, triggered the old loss.
    png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII="

    async def read(_):
        return {"content": [{"type": "text", "text": "Scanned PDF pages 1–20."},
                            *[{"type": "image", "mimeType": "image/png", "data": png} for _ in range(20)]]}

    tool = EngineTool("Read", "Read selected PDF pages", {"type": "object", "properties": {}}, read)
    async with provider(lambda _, n: completion(tool=("Read", {})) if n == 1 else completion()) as (config, requests):
        async with client(tmp_path, config, [tool]) as instance:
            await instance.query("Inspect the scanned pages.")
            events = await collect(instance)
        assert events[-1].data["outcome"] == "completed"
        content = json.dumps(requests[1]["messages"])
        assert content.count('"type": "image_url"') == 20
