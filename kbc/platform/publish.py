#!/usr/bin/env python3
"""publish —— 把编译产物(bundle/)发布成一个不可变版本。

这是"发布闸":草稿区随便改,但"发布"是一个郑重动作 ——
把当前 bundle 提交进 forge 仓 + 打一个 release/tag(= 一个版本)。
消费者只读这个版本;每版一个 tag → 可回溯。

发布说明(release body)缺省 = 从账本自动生成的"编译总结"(对齐设计稿 §五:审核面=总结)。

用法:
  python3 platform/publish.py --version v1
  python3 platform/publish.py --version v2 --notes "手写发布说明"
"""
import argparse
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from forge_client import ForgeClient  # noqa: E402


def summary_from_ledger(ledger_path):
    """从账本生成"编译总结" = 发布说明。账本没有就给个占位。"""
    p = Path(ledger_path)
    if not p.exists():
        return "(无账本,略过编译总结)"
    d = json.loads(p.read_text())
    claims = len(d.get("claims", []))
    sources = d.get("sources", {})
    n_src = len(sources) if isinstance(sources, (dict, list)) else 0
    findings = d.get("findings", {})
    findings = list(findings.values()) if isinstance(findings, dict) else findings
    st = Counter(f.get("status") for f in findings)
    auto = st.get("ruled", 0) + st.get("auto_resolved", 0)
    parked = st.get("parked", 0)
    lines = [
        "## 编译总结",
        f"- 源 {n_src} 篇 → 断言 {claims} 条",
        f"- 矛盾 {len(findings)} 处:自动归并/已裁 {auto},待裁 {parked}",
    ]
    for f in findings:
        if f.get("status") == "parked":
            lines.append(f"  - ⚠️ 待裁:{f.get('summary', '')}")
    return "\n".join(lines)


def publish(repo, version, bundle_dir="bundle", ledger="out/ledger.json", notes=None, branch="main"):
    fc = ForgeClient(repo)
    files = {f"bundle/{p.name}": p.read_text()
             for p in sorted(Path(bundle_dir).glob("*.md"))}
    if not files:
        raise SystemExit(f"{bundle_dir} 下没有 .md,无可发布")
    fc.commit_files(files, branch=branch, message=f"publish {version}")
    body = notes or summary_from_ledger(ledger)
    rel = fc.create_release(version, target=branch, name=version, body=body)
    return files, rel


def main():
    ap = argparse.ArgumentParser(description="发布一版(提交 bundle + 打 tag/release)")
    ap.add_argument("--repo", default="kbc/aliyun-fc")
    ap.add_argument("--version", required=True, help="版本号,如 v1")
    ap.add_argument("--bundle", default="bundle")
    ap.add_argument("--ledger", default="out/ledger.json")
    ap.add_argument("--notes", default=None, help="发布说明;缺省=账本自动生成编译总结")
    a = ap.parse_args()
    files, rel = publish(a.repo, a.version, a.bundle, a.ledger, a.notes)
    print(f"✅ 已发布 {a.version}:{len(files)} 个文件 → {rel['html_url']}")
    print(f"   tag = {rel['tag_name']}")
    print("   发布说明(=编译总结):")
    print("   " + (rel.get("body", "") or "").replace("\n", "\n   "))


if __name__ == "__main__":
    main()
