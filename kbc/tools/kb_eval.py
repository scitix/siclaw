#!/usr/bin/env python3
"""kb_eval.py — 发布闸(可选 phase)。

拿题集压测一个 OKF bundle:蓝队**只读 bundle**答题 → 裁判判分 → 按阈值过闸。
轻量可复用:题集(含陷阱题)是【装载的 per-KB 内容】(--questions 文件),runner 域无关。
**可选 + 可独立触发**:对任意已有 bundle 都能单跑,不依赖编译流程;编译收敛后想压测就接,不想就不接。

题集文件(yaml):
  threshold: 1.0            # 过闸所需通过率
  questions:
    - q: "..."             # 题面
      expect: "..."        # 期望行为(如:应答'未覆盖' / 应平铺矛盾不下定论 / 应答 X)

陷阱题是关键:专挑"看着能答、其实该说未覆盖 / 该平铺矛盾"的题,探出脑补失真。
更重的版本(蓝队跨档 + 多裁判)见 redblue-pk;本工具是其轻量可独立跑的内核。
"""
import argparse
import sys
from pathlib import Path

import yaml

from llm import call_json, call_text

_BLUE = """你在用一个知识库回答问题。**铁律**:
- 只用下面这份知识库的内容;知识库里查不到 → 答"本知识库未覆盖",不许用库外常识脑补。
- 若库里多处说法相互矛盾 → 把它们平铺列出、各标出处,**不要自己挑一个当结论**。

【知识库】
{bundle}

【问题】{q}

简短回答(严格只依据上面知识库):"""

_JUDGE = """判一个答案是否合格。
【问题】{q}
【期望行为】{expect}
【待判答案】{answer}

答案是否满足期望行为?只输出 JSON,不要其它文字:{{"pass": true|false, "why": "一句话依据"}}"""


def load_bundle(bundle_dir):
    parts = []
    for p in sorted(Path(bundle_dir).expanduser().rglob("*.md")):
        parts.append(f"<<< 文件: {p.name} >>>\n{p.read_text(encoding='utf-8')}")
    return "\n\n".join(parts)


def gate(bundle_text, questions):
    results = []
    for item in questions:
        answer = call_text(_BLUE.format(bundle=bundle_text, q=item["q"]))      # 蓝队
        verdict = call_json(_JUDGE.format(q=item["q"], expect=item["expect"],  # 裁判
                                          answer=answer))
        results.append({"q": item["q"], "answer": answer.strip(),
                        "pass": bool(verdict.get("pass")), "why": verdict.get("why", "")})
    return results


def main():
    ap = argparse.ArgumentParser(description="发布闸:题集压测一个 OKF bundle(可选 phase)")
    ap.add_argument("--bundle", required=True, help="OKF bundle 目录")
    ap.add_argument("--questions", required=True, help="题集 yaml(装载,不内置)")
    a = ap.parse_args()

    spec = yaml.safe_load(Path(a.questions).expanduser().read_text(encoding="utf-8"))
    threshold = float(spec.get("threshold", 1.0))
    bundle_text = load_bundle(a.bundle)

    print(f"── 发布闸 · bundle={a.bundle} · 阈值={threshold:.0%} ──")
    results = gate(bundle_text, spec["questions"])
    passed = sum(r["pass"] for r in results)
    rate = passed / len(results) if results else 0.0
    for r in results:
        mark = "✅" if r["pass"] else "❌"
        print(f"\n{mark} Q: {r['q']}")
        print(f"   蓝队答:{r['answer'][:160]}")
        print(f"   判:{r['why']}")
    verdict = "PASS 可消费" if rate >= threshold else "FAIL 不可发布(上面 ❌ 项必修)"
    print(f"\n通过率 {passed}/{len(results)} = {rate:.0%} · 阈值 {threshold:.0%} → {verdict}")
    sys.exit(0 if rate >= threshold else 1)


if __name__ == "__main__":
    main()
