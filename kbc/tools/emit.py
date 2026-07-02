#!/usr/bin/env python3
"""emit.py — 把编译账本落盘成标准 OKF bundle(phase:compile 产物 → 可消费的 OKF 文档)。

账本的【断言】(带出处)+【已裁矛盾】→ 按主题聚成 OKF 页(frontmatter + 必填 type + 正文,每条带源):
  - 同主题断言合并、跨源去重;
  - 矛盾按裁决落地:已裁的写成结论(保留涉及源),未裁/存疑的标"⚠️ 存疑"不下定论;
  - 写 index.md(OKF 保留名,root 仅 okf_version)。
域无关:聚什么主题、怎么写由 LLM 按内容定,代码不内置任何分类法。
"""
import argparse
import json
import re
import sys
from pathlib import Path

from llm import call_json

_PROMPT = """把下面【已编断言】(带出处)和【已裁矛盾】整理成标准 OKF 知识页。
- 按主题把断言聚成若干页:同一主题的断言合并、跨源去重,**每条陈述后用(源:文件名)标出处**。
- 每页给:filename(简短、.md 结尾)、type(一两个词,你按内容定,如 清单/实体/主题)、title、body(markdown 正文)。
- 矛盾按裁决落地:status=ruled 的按其『裁决』写成结论(保留涉及的源);status=parked/存疑 的明确标"⚠️ 存疑:…"、不下定论。
- 只写事实陈述,别加套话/导语。

【已编断言】
{claims}

【已裁矛盾】
{findings}

只输出 JSON,不要其它文字:{{"pages":[{{"filename":"x.md","type":"…","title":"…","body":"…"}}]}}"""


def _safe(name):
    name = re.sub(r"[^\w一-鿿.-]", "_", name.strip())
    return name if name.endswith(".md") else name + ".md"


def emit(ledger, out_dir):
    claims = "\n".join(f"- {c['text']}(源:{c.get('src')})" for c in ledger["claims"]) or "(无)"
    findings = "\n".join(
        f"- [{f['status']}] {f.get('summary', '')}"
        + (f" 『裁决』{f['resolution']}" if f.get("resolution") else "")
        for f in ledger["findings"].values()) or "(无)"
    out = call_json(_PROMPT.format(claims=claims, findings=findings))

    out_dir = Path(out_dir).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)
    links = []
    for pg in out["pages"]:
        fn = _safe(pg["filename"])
        fm = f"---\ntype: {pg['type']}\ntitle: {pg['title']}\n---\n\n"
        (out_dir / fn).write_text(fm + pg["body"].strip() + "\n", encoding="utf-8")
        links.append(f"- [{pg['title']}]({fn})")
    idx = '---\nokf_version: "0.1"\n---\n\n# 知识目录\n\n' + "\n".join(links) + "\n"
    (out_dir / "index.md").write_text(idx, encoding="utf-8")
    return [_safe(p["filename"]) for p in out["pages"]]


def main():
    ap = argparse.ArgumentParser(description="账本 → 标准 OKF bundle(emit phase)")
    ap.add_argument("--ledger", required=True)
    ap.add_argument("--out", required=True, help="OKF bundle 输出目录")
    a = ap.parse_args()
    ledger = json.loads(Path(a.ledger).expanduser().read_text(encoding="utf-8"))
    pages = emit(ledger, a.out)
    print(f"已写 OKF bundle → {a.out}")
    for p in pages:
        print(f"  · {p}")
    print("  · index.md")
    sys.exit(0)


if __name__ == "__main__":
    main()
