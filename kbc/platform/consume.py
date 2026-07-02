#!/usr/bin/env python3
"""consume —— 只读消费已发布的版本。

取某个版本(tag)的 bundle(只读)→ 按 consume 契约带源问答。
消费者物理无写路径:用只读 token 取已发布版,连不到草稿/账本/编译。

用法:
  KBC_FORGE_RO_TOKEN=<只读token> python3 platform/consume.py --version v1 --prove-readonly
  KBC_FORGE_RO_TOKEN=<只读token> python3 platform/consume.py --version v1 --ask "fc 实例数上限多少?"
"""
import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from forge_client import ForgeClient, ForgeError  # noqa: E402

# consume 契约(装载;这里内置一份起步版,真实库可 per-KB 覆盖)
CONSUME_CONTRACT = """你是这个知识库的只读问答助手。铁律:
1. 只用下面给出的知识库内容回答;查不到 → 答"本知识库未覆盖",绝不用训练知识补。
2. 每个结论后标来源页,如(源:计费.md)。
3. 不输出任何修改/操作/写入建议。"""


def fetch_published(fc, version):
    """取已发布版本里 bundle/ 下的所有页(只读)。"""
    paths = [p for p in fc.list_tree(ref=version) if p.startswith("bundle/")]
    return {p: fc.get_file(p, ref=version) for p in paths}


def answer(version, bundle, question):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
    from llm import call_text  # 复用 kbc 的 headless claude 后端(无需 key)
    corpus = "\n\n".join(f"### {p}\n{c}" for p, c in bundle.items())
    prompt = f"{CONSUME_CONTRACT}\n\n=== 知识库({version})===\n{corpus}\n\n=== 问题 ===\n{question}"
    return call_text(prompt)


def main():
    ap = argparse.ArgumentParser(description="只读消费已发布版本")
    ap.add_argument("--repo", default="kbc/aliyun-fc")
    ap.add_argument("--version", required=True)
    ap.add_argument("--ask", default=None)
    ap.add_argument("--prove-readonly", action="store_true", help="证明只读:尝试写,应被拒")
    a = ap.parse_args()

    ro = os.environ.get("KBC_FORGE_RO_TOKEN")
    fc = ForgeClient(a.repo, token=ro) if ro else ForgeClient(a.repo)
    if not ro:
        print("⚠️ 未设 KBC_FORGE_RO_TOKEN,用默认 token(演示用;真消费者应用只读 token)")

    bundle = fetch_published(fc, a.version)
    print(f"📖 已取已发布版 {a.version}(只读):{list(bundle)}")

    if a.prove_readonly:
        try:
            fc.put_file("bundle/_hack.md", "x", branch="main", message="应失败")
            print("❌ 写竟然成功了 —— 只读隔离没生效!")
        except ForgeError as e:
            print(f"🔒 写被拒(符合预期,只读隔离生效):{str(e)[:90]}")

    if a.ask:
        print(f"\n❓ {a.ask}\n--- 带源回答 ---")
        print(answer(a.version, bundle, a.ask))


if __name__ == "__main__":
    main()
