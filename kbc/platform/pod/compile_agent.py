#!/usr/bin/env python3
"""Run the standalone drop-to-bundle compiler through the pinned Pi worker.

Pass --config with a private JSON file containing the resolved execution v1
roles. This entry point never loads user SDK settings or subscription secrets.
The served authoring workflow remains compile_box.py.
"""
import argparse
import asyncio
import os
import sys
from pathlib import Path

import json
import uuid

from engine import _make_multiroot_guard
from pi_engine import PiAgentClient
from pi_file_tools import FileTools
import pi_config

def _find_playbook():
    """找 kbc playbook(编译纪律):优先 KBC_PLAYBOOK 环境变量,否则向上找 CLAUDE.md。"""
    env = os.environ.get("KBC_PLAYBOOK")
    if env:
        return Path(env)
    for parent in Path(__file__).resolve().parents:
        cand = parent / "CLAUDE.md"
        if cand.exists():
            return cand
    return None

TASK = """你是这个知识库的编译器。工作目录里有 `drop/`(原始文档)和 `constitution.md`(裁决纪律)。
把 `drop/` 编译成一个 OKF bundle 写到 `bundle/`:
- 逐篇读 `drop/`,抽原子断言(每条短、可独立判真伪,记清来自哪个文件);
- 跨断言检矛盾;遇矛盾照 `constitution.md` 裁:能并列的(版本/口径/配置/时点差异)→ 并列保留各取值、各挂条件,不升级;
  明显笔误→标记修正;不可约的真冲突→在页里标 "⚠️ 存疑:…"(本次无人可问);
- 按主题把断言聚成页写进 `bundle/<主题>.md`,每条结论后标 `(源:文件名)`;写一个 `bundle/index.md` 列出各页;
- 边界诚实:`drop/` 里查不到的不编、不脑补。
完成后用三五句话总结:产出哪些页、自动并了哪些矛盾、标了哪些存疑。"""


async def run(workdir: str, max_turns: int, config_path: str) -> int:
    wd = Path(workdir).resolve()
    pi_config.configure(json.loads(Path(config_path).read_text(encoding="utf-8")))
    pb_path = _find_playbook()
    playbook = pb_path.read_text() if pb_path and pb_path.exists() else ""
    client = PiAgentClient(
        cwd=str(wd), system_prompt=playbook, session_id=str(uuid.uuid4()),
        model_config=pi_config.for_role("compile", session_kind="authoring"),
        tools=FileTools(str(wd), ["Read", "Write", "Edit", "Glob", "Grep"], _make_multiroot_guard([wd])).tools(),
        max_model_calls=max_turns,
    )
    try:
        await client.connect()
        await client.query(TASK)
        async for event in client.receive_response():
            if event.kind == "assistant":
                for block in event.data.get("content", []):
                    if block.get("type") == "text":
                        print(block["text"], flush=True)
            elif event.kind == "result" and event.data["outcome"] != "completed":
                raise RuntimeError(event.data.get("error") or "Compilation did not complete")
    finally:
        await client.disconnect()
    return 0 if any((wd / "bundle").glob("*.md")) else 1


def main():
    ap = argparse.ArgumentParser(description="Compile drop/ into bundle/ using Pi Agent")
    ap.add_argument("--workdir", required=True, help="含 drop/ + constitution.md 的工作目录")
    ap.add_argument("--max-turns", type=int, default=80)
    ap.add_argument("--config", required=True, help="private JSON file with resolved Pi execution roles")
    a = ap.parse_args()
    sys.exit(asyncio.run(run(a.workdir, a.max_turns, a.config)))


if __name__ == "__main__":
    main()
