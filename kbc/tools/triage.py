#!/usr/bin/env python3
"""triage.py — 矛盾裁决(护城河)。

按【装载的宪法】判定一条编译期矛盾是 自裁(auto)还是 升级给人(park);
若升级,把它框成一道【领域专家一眼能裁的选择题】(领域语言 + 证据内联 + 预分类选项 + 逃生口)。

域无关:宪法(什么算可自裁、怎么裁)是**传入参数**,本文件不内置任何库的具体规则。
一次 LLM 调用同时产出 route(+ 自裁结论)和(若升级)MCQ。
"""
import json

from llm import call_json

_PROMPT = """你是知识库编译流程里的【矛盾裁决器】。给你这个库的【宪法】(裁决规则)和一条编译期检出的矛盾/缺口。

判两件事:
1. route:
   - "auto" = 宪法给了确定性裁法,可自动处理、不打扰人;
   - "park" = 只有懂这个库内容的人才能裁,必须升级给人。
   **默认 park** —— 只有宪法明确覆盖才 auto(拿不准不许猜)。
2. 若 route="park",把它框成一道【领域专家一眼能裁的选择题】。专家很懂这个库的内容,
   但完全不懂编译/OKF/方法论。所以:
   - 纯领域语言,不出现任何方法论或工具黑话;
   - 证据内联(把冲突的两三处原文 + 出处摆出来);
   - 预分类 2~4 个候选裁法当选项,末尾必加一个"我也不确定→先标存疑"的逃生口;
   - 不诱导,允许"其他/补充"。

【宪法】
{constitution}

【矛盾】
{finding}

只输出 JSON,不要任何其它文字:
{{"route":"auto"|"park",
  "reason":"一句话依据(auto 要点名套了宪法哪条规则)",
  "auto_resolution":"若 auto:具体怎么处理;否则空串",
  "mcq": null 或 {{"question":"一句话问题","evidence":["〔出处〕原文片段", ...],"options":["①…","②…","… 我也不确定→先标存疑"]}}}}"""


def triage(finding, constitution):
    """finding: dict(含 evidence);constitution: str。返回 {route, reason, auto_resolution, mcq}。"""
    prompt = _PROMPT.format(
        constitution=constitution.strip(),
        finding=json.dumps(finding, ensure_ascii=False, indent=2),
    )
    return call_json(prompt)
