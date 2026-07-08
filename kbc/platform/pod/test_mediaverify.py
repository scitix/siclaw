"""Tests for the blind transcription + comparison pass (mediaverify.py).

A FakeEngine routes by role marker — the full flow runs with zero LLM calls. Run:
    python test_mediaverify.py
"""

import asyncio
import json
import tempfile
from pathlib import Path

import mediaverify


def _mk(base: Path, rel: str, text: str = "x"):
    p = base / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


class FakeEngine:
    """Routes by system-prompt marker; records every call's roots for the
    isolation assertions (transcriber sees raw only; comparer sees nothing)."""

    def __init__(self):
        self.calls = {"transcribe": 0, "compare": 0}
        self.roots = {"transcribe": [], "compare": []}
        self.users = {"transcribe": [], "compare": []}

    async def run_readonly_agent(self, *, cwd, system_prompt, user_message,
                                 model, effort=None, allowed_read_roots, timeout_secs):
        if "You are an image transcriber" in system_prompt or "图像转写员" in system_prompt:
            stage = "transcribe"
        elif "You are the comparer" in system_prompt or "比对员" in system_prompt:
            stage = "compare"
        else:
            raise AssertionError(f"unroutable: {system_prompt[:60]}")
        self.calls[stage] += 1
        self.roots[stage].append(list(allowed_read_roots))
        self.users[stage].append(user_message)
        if stage == "transcribe":
            return json.dumps({"chart_type": "表格", "title_or_header": "NVITOP 1.4.2",
                               "legend": None, "axes": None,
                               "facts": [{"label": "GPU0/GPU-Util", "value": "0%"},
                                         {"label": "GPU0/MEM条", "value": "94%"}],
                               "illegible": [], "notes": "型号名称不可见"})
        # comparer: flag the util misread iff the page claims 94% util
        if "GPU-Util 94%" in user_message:
            return json.dumps({"findings": [{"image": "s/i1.png", "claim": "GPU-Util 94%",
                                             "kind": "不一致", "expected": "GPU-Util 0%(94% 是 MEM 条)",
                                             "fix": "改为 0%"}]})
        return json.dumps({"findings": []})


async def test_blind_flow_and_isolation():
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/s/i1.png", "PNGBYTES-1")
        _mk(base, "raw/s/i2.png", "PNGBYTES-2")
        _mk(base, "candidate/p.md", "---\n---\n利用率 GPU-Util 94%。(source: s/i1.png)")
        _mk(base, "candidate/q.md", "---\n---\n正常描述。(source: s/i2.png)")
        fake = FakeEngine()
        pending = {"p.md": ["s/i1.png"], "q.md": ["s/i2.png"]}
        result = await mediaverify.run_blind_verify(fake, td, pending)
        assert fake.calls == {"transcribe": 2, "compare": 2}, fake.calls
        assert result["images"] == 2 and not result["errors"], result
        assert len(result["findings"]) == 1
        f = result["findings"][0]
        assert f["page"] == "p.md" and f["kind"] == "不一致" and "MEM 条" in f["expected"]

        # isolation: transcriber roots = raw only; comparer roots exclude raw AND candidate
        raw_dir = str(base / "raw")
        for r in fake.roots["transcribe"]:
            assert r == [raw_dir], r
        for r in fake.roots["compare"]:
            assert raw_dir not in r and str(base / "candidate") not in r, r
        # comparer sees the page text + transcript inline, never an image path to open
        assert "GPU-Util 94%" in fake.users["compare"][0] or "GPU-Util 94%" in fake.users["compare"][1]

        # default locale (None) renders the ENGLISH prompts, and the en comparison
        # prompt still demands the exact stored kind tokens
        assert all("Open this image with Read" in u for u in fake.users["transcribe"])
        assert all('"不一致" (inconsistent)' in u and '"超出转写范围" (beyond the transcript)' in u
                   for u in fake.users["compare"])

        # transcript cache: second run re-transcribes nothing
        result2 = await mediaverify.run_blind_verify(fake, td, pending)
        assert fake.calls["transcribe"] == 2, fake.calls  # cache hits
        assert result2["cache_hits"] == 2, result2
        # content change rotates the hash → re-transcribe just that image
        _mk(base, "raw/s/i1.png", "PNGBYTES-1-CHANGED")
        await mediaverify.run_blind_verify(fake, td, pending)
        assert fake.calls["transcribe"] == 3, fake.calls

        cache = json.loads((base / "authoring/MEDIA_TRANSCRIPTS.json").read_text())
        assert set(cache) == {"s/i1.png", "s/i2.png"}

        # completion accounting (review fix): both pages verified whole
        assert result["completed_pages"] == ["p.md", "q.md"] and result["failed_pages"] == [], result
    print("OK  blind flow (transcribe/compare counts, isolation, findings, cache+invalidate)")


class _PartialEngine(FakeEngine):
    """Transcription fails for one of the two images on the page."""

    async def run_readonly_agent(self, *, cwd, system_prompt, user_message,
                                 model, effort=None, allowed_read_roots, timeout_secs):
        if ("You are an image transcriber" in system_prompt or "图像转写员" in system_prompt) \
                and "s/bad.png" in user_message:
            raise RuntimeError("vision API choked")
        return await super().run_readonly_agent(
            cwd=cwd, system_prompt=system_prompt, user_message=user_message, model=model,
            effort=effort, allowed_read_roots=allowed_read_roots, timeout_secs=timeout_secs)


async def test_partial_transcription_skips_comparison():
    """Review fix: a page with ANY untranscribed image is never compared against
    the partial set (false-pass/false-fail both ways) — it fails whole and the
    caller retries it; a fully-transcribed sibling page still completes."""
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        _mk(base, "raw/s/i1.png", "PNGBYTES-1")
        _mk(base, "raw/s/bad.png", "PNGBYTES-BAD")
        _mk(base, "candidate/p.md", "---\n---\n利用率 GPU-Util 94%。(source: s/i1.png)(source: s/bad.png)")
        _mk(base, "candidate/q.md", "---\n---\n正常描述。(source: s/i1.png)")
        fake = _PartialEngine()
        pending = {"p.md": ["s/i1.png", "s/bad.png"], "q.md": ["s/i1.png"]}
        result = await mediaverify.run_blind_verify(fake, td, pending)
        assert result["failed_pages"] == ["p.md"], result
        assert result["completed_pages"] == ["q.md"], result
        # the partially-transcribed page was NEVER compared (only q.md was)
        assert fake.calls["compare"] == 1 and "正常描述" in fake.users["compare"][0]
        assert any("not transcribed — comparison skipped" in e or "未转写" in e
                   for e in result["errors"]), result["errors"]
    print("OK  partial transcription skips comparison (page retries whole)")


def test_repair_prompt():
    findings = [{"page": "p.md", "image": "s/i1.png", "kind": "超出转写范围",
                 "claim": "GPU 型号 NVIDIA H20", "expected": "转写中无此信息",
                 "fix": "降级⚠️存疑+落工单"}]
    # default locale (None) = English; the stored kind token renders as its label
    prompt = mediaverify.build_repair_prompt(findings)
    assert prompt.startswith("[System self-check · image verification]"), prompt[:80]
    assert "beyond what the transcript supports" in prompt and "H20" in prompt
    assert "file a ticket" in prompt and "Claim:" in prompt
    # zh branch keeps the original wording
    zh = mediaverify.build_repair_prompt(findings, locale="zh")
    assert "【系统自检 · 图像复核】" in zh and "落一条工单" in zh
    print("OK  repair prompt (en default + zh branch, kinds + claims + fix lines)")


def main():
    asyncio.run(test_blind_flow_and_isolation())
    asyncio.run(test_partial_transcription_skips_comparison())
    test_repair_prompt()
    print("ALL OK  test_mediaverify")


if __name__ == "__main__":
    main()
