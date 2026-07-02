#!/usr/bin/env python3
"""repo_sync —— 编侧后端的 I/O:forge 仓的 raw 拉下来 / 编译产物推回去。

  pull:  仓的 drop/ + constitution.md → 本地工作目录(编译要的输入)
  push:  本地工作目录的 bundle/ + out/ledger.json → 推回仓(main)

编译本身(ingest→compile→emit)是 L2 既有工具;这层只管 repo ↔ 本地 的搬运。
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from forge_client import ForgeClient  # noqa: E402


def pull(repo, workdir, ref="main"):
    """拉仓里编译需要的输入:drop/ 下所有文件 + constitution.md。"""
    fc = ForgeClient(repo)
    wd = Path(workdir)
    pulled = []
    for p in fc.list_tree(ref=ref):
        if p.startswith("drop/") or p == "constitution.md":
            dest = wd / p
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(fc.get_file(p, ref=ref))
            pulled.append(p)
    return pulled


def push_bundle(repo, workdir, branch="main", message="compile: 回写 bundle + ledger"):
    """把工作目录的 bundle/ + out/ledger.json 推回仓(一次提交)。"""
    fc = ForgeClient(repo)
    wd = Path(workdir)
    files = {f"bundle/{p.name}": p.read_text() for p in sorted((wd / "bundle").glob("*.md"))}
    ledger = wd / "out" / "ledger.json"
    if ledger.exists():
        files["out/ledger.json"] = ledger.read_text()
    if not files:
        raise SystemExit("workdir 里没有 bundle/ 或 ledger,无可推送")
    fc.commit_files(files, branch=branch, message=message)
    return list(files)


def main():
    ap = argparse.ArgumentParser(description="repo ↔ 本地 的 raw/产物 搬运")
    ap.add_argument("cmd", choices=["pull", "push"])
    ap.add_argument("--repo", default="kbc/aliyun-fc")
    ap.add_argument("--workdir", required=True)
    ap.add_argument("--ref", default="main")
    a = ap.parse_args()
    if a.cmd == "pull":
        got = pull(a.repo, a.workdir, a.ref)
        print(f"⬇️ 拉下 {len(got)} 个文件 → {a.workdir}:")
        for p in got:
            print(f"   {p}")
    else:
        pushed = push_bundle(a.repo, a.workdir)
        print(f"⬆️ 推回 {len(pushed)} 个文件:")
        for p in pushed:
            print(f"   {p}")


if __name__ == "__main__":
    main()
