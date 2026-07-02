#!/usr/bin/env python3
"""compile_repo —— 编侧后端整环:repo 的 drop/ → 编译 → bundle+ledger 回 repo。

闭合 raw → 编 → (发布) 的后端环。编译三步(ingest→compile_loop→emit)是 L2 既有工具,
本脚本只做**编排 + 用 repo_sync 搬运**。无人值守版的推理走 headless claude(compile_loop 经 llm.py)。

用法:
  python3 platform/compile_repo.py --repo kbc/aliyun-fc --workdir /tmp/kbc-run
"""
import argparse
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import repo_sync  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[1]
PY = str(REPO_ROOT / ".venv" / "bin" / "python")
TOOLS = REPO_ROOT / "tools"


def _run(cmd):
    print(f"$ {' '.join(str(c) for c in cmd)}", flush=True)
    subprocess.run([str(c) for c in cmd], check=True)


def compile_repo(repo, workdir):
    wd = Path(workdir)
    wd.mkdir(parents=True, exist_ok=True)
    drop, ingested, out, bundle = wd / "drop", wd / "ingested", wd / "out", wd / "bundle"
    const = wd / "constitution.md"

    print("=== ① pull:仓 drop/ + constitution → 工作目录 ===", flush=True)
    got = repo_sync.pull(repo, workdir)
    print(f"⬇️ {got}", flush=True)

    print("\n=== ② ingest:drop/ → 归一 md + 出处 ===", flush=True)
    _run([PY, TOOLS / "ingest.py", "--src", drop, "--out", ingested])

    print("\n=== ③ compile_loop:抽断言 + 检矛盾 + 按宪法裁(headless claude)===", flush=True)
    out.mkdir(exist_ok=True)
    _run([PY, TOOLS / "compile_loop.py", "--ingested", ingested,
          "--ledger", out / "ledger.json", "--constitution", const])

    print("\n=== ④ emit:账本 → OKF bundle ===", flush=True)
    _run([PY, TOOLS / "emit.py", "--ledger", out / "ledger.json", "--out", bundle])

    print("\n=== ⑤ push:bundle + ledger → 回仓 ===", flush=True)
    pushed = repo_sync.push_bundle(repo, workdir, message="compile: drop/ → bundle (headless 整环)")
    print(f"⬆️ {pushed}", flush=True)
    return got, pushed


def main():
    ap = argparse.ArgumentParser(description="编侧后端整环:repo drop → 编译 → bundle 回 repo")
    ap.add_argument("--repo", default="kbc/aliyun-fc")
    ap.add_argument("--workdir", required=True)
    a = ap.parse_args()
    compile_repo(a.repo, a.workdir)
    print("\n✅ 编侧后端整环跑通:repo drop/ → 编译 → bundle+ledger 回 repo", flush=True)


if __name__ == "__main__":
    main()
