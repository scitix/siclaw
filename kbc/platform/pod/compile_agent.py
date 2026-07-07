#!/usr/bin/env python3
"""compile_agent —— 编译 pod 的入口:用 Claude Agent SDK 把 kbc 编译大脑跑成一个 query() 任务。

证明"kbc 大脑能当 Agent SDK 任务在容器里跑":
  读 workdir/drop + constitution → 按 playbook 编译 → 写 workdir/bundle。

LLM 鉴权走 SDK 默认:
  - 本地:复用订阅(SDK 自带的 claude 二进制读 ~/.claude 鉴权)。
  - 生产 pod:设 ANTHROPIC_BASE_URL → 公司 massapi(key 容器外注入)。

用法:python compile_agent.py --workdir /path/to/workdir
"""
import argparse
import asyncio
import os
import sys
from pathlib import Path

from claude_agent_sdk import query, ClaudeAgentOptions

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


async def run(workdir: str, max_turns: int) -> int:
    wd = str(Path(workdir).resolve())
    pb_path = _find_playbook()
    playbook = pb_path.read_text() if pb_path and pb_path.exists() else ""

    opts = ClaudeAgentOptions(
        cwd=wd,
        allowed_tools=["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
        permission_mode="bypassPermissions",    # pod 本身就是 sandbox
        max_turns=max_turns,
        setting_sources=[],                      # 多租户隔离:不加载外部 settings/CLAUDE.md
    )
    # kbc playbook(编译纪律)+ 任务 一起作为 prompt(生产可改 system_prompt 的 preset append 形式)
    full_prompt = (playbook + "\n\n---\n\n# 本次任务\n\n" + TASK) if playbook else TASK
    print(f"[compile_agent] workdir={wd}  playbook={'loaded' if playbook else 'MISSING'}  max_turns={max_turns}", flush=True)

    result_text = ""
    async for msg in query(prompt=full_prompt, options=opts):
        cls = type(msg).__name__
        if cls == "AssistantMessage":
            for block in getattr(msg, "content", []) or []:
                bt = type(block).__name__
                if bt == "TextBlock":
                    t = getattr(block, "text", "").strip()
                    if t:
                        print(f"  🤖 {t[:280]}", flush=True)
                elif bt == "ToolUseBlock":
                    print(f"  🔧 {getattr(block, 'name', '?')}  {str(getattr(block, 'input', ''))[:90]}", flush=True)
        elif cls == "ResultMessage":
            result_text = str(getattr(msg, "result", "") or "")
            cost = getattr(msg, "total_cost_usd", None)
            print(f"  ✅ {result_text[:500]}", flush=True)
            if cost is not None:
                print(f"     cost=${cost}", flush=True)

    bundle = Path(wd) / "bundle"
    pages = sorted(bundle.glob("*.md")) if bundle.exists() else []
    print(f"[compile_agent] done. bundle pages ({len(pages)}): {[p.name for p in pages]}", flush=True)
    return 0 if pages else 1


def main():
    ap = argparse.ArgumentParser(description="编译 pod 入口:Agent SDK 跑 kbc 编译大脑")
    ap.add_argument("--workdir", required=True, help="含 drop/ + constitution.md 的工作目录")
    ap.add_argument("--max-turns", type=int, default=80)
    a = ap.parse_args()
    sys.exit(asyncio.run(run(a.workdir, a.max_turns)))


if __name__ == "__main__":
    main()
