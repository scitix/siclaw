"""Consumer-facing meta generation (S1, DESIGN-kb-consumer-meta-2026-07-10).

One BLIND one-shot LLM pass at the settle seam produces the content of
`authoring/CONSUMER_META.json` — the skill-style first disclosure layer a
consuming agent keeps resident in context to decide WHEN to enter this KB at
all (the second layer stays the existing on-demand page reads). Raw isolation
is STRUCTURAL, not prompt-constrained: the read-only engine session's only
allowed root is candidate/ (the compiled pages); raw/ is mechanically
invisible, so the summary can never leak raw-only information (design §0
脱敏是结构保证).

Deterministic code owns when to run (the compile_box settle seam, keyed by
candidate_tree_hash), the schema envelope, and every cap
(selfcheck.normalize_consumer_meta); the model only writes the prose.
Fail-open by contract: a generation failure costs the meta, never the settle —
a missing meta is a lint WARNING and consumers fall back to the owner
description (design D2).

Engine-neutral like redblue/mediaverify: depends on engine.ReadonlyAgentEngine
only; the calibration path is the same adapter the PK stack uses.
"""

from __future__ import annotations

import os
from pathlib import Path

import selfcheck
from selfcheck import _is_en
from engine import ReadonlyAgentEngine, parse_json_lenient


def _meta_model() -> str:
    """Lightweight tier by design (§1 S1 档位用轻量档): the summary is
    consumer-routing prose over already-compiled pages, not authoring — the
    gate/consumer tier (same default as the PK blue team) is plenty."""
    return os.environ.get("KBC_META_MODEL", "claude-sonnet-4-6")


def _meta_timeout() -> float:
    return float(os.environ.get("KBC_META_TIMEOUT_SECS", "240"))


def _read_all_cap() -> int:
    """Input scaling by KB size (§1 S1 按体量伸缩): up to this many pages the
    model is told to read every page; above it, index + entry pages + page
    heads (sampling) — bounded further by the engine's max_turns/timeout."""
    return int(os.environ.get("KBC_META_READ_ALL_PAGES", "20"))


# A pathological page census must not blow up the prompt.
_PAGE_LIST_CAP = 200

ROLE_EN = """You write the consumer-facing routing summary for one compiled knowledge base (an LLM wiki of markdown pages).
Your reader is another AI agent that keeps your summary permanently in its context and uses it to decide WHEN to open this knowledge base at all.
You can read ONLY the compiled wiki pages in the working directory. Describe strictly what the pages actually contain — never advertise coverage they do not have, and never guess at material you cannot see."""

ROLE_ZH = """你为一个已编译的知识库(由 markdown 页面组成的 LLM wiki)撰写【消费侧口径摘要】。
读者是另一个 AI agent:它会把你的摘要常驻在上下文里,用它来判断"什么时候才需要打开这个知识库"。
你只能读工作目录里已编译的 wiki 页面。严格按页面实际内容描述——页面没有的覆盖面绝不夸大,看不到的材料绝不脑补。"""

USER_EN = """The compiled knowledge base has {n} page(s):
{page_list}

{read_directive}

Then output ONE JSON object (no other text), with all prose in English:
{{"summary": "≤{summary_max} characters: what this KB actually covers, written for a consuming agent deciding whether to look here",
 "when_to_use": ["question types this KB answers well (3-6 items)"],
 "not_for": ["adjacent question types it deliberately does NOT cover (0-4 items — only what the pages themselves make clear)"],
 "topics": ["main topic keywords (3-8)"],
 "entry_pages": ["key entry page paths besides index.md (0-5; must be existing page paths relative to the wiki root)"]}}"""

USER_ZH = """这个已编译知识库共 {n} 页:
{page_list}

{read_directive}

然后只输出一个 JSON 对象(不要任何其他文字),所有文案用中文:
{{"summary": "≤{summary_max} 字:这个库实际覆盖什么,写给正在判断'要不要进这个库查'的消费 agent",
 "when_to_use": ["这个库擅长回答的问题类型(3-6 条)"],
 "not_for": ["相邻但刻意不覆盖的问题类型(0-4 条——只写页面本身能看出来的)"],
 "topics": ["主题关键词(3-8 个)"],
 "entry_pages": ["index.md 之外的关键入口页路径(0-5 个;必须是相对 wiki 根的真实页面路径)"]}}"""

READ_ALL_EN = "Read index.md first, then read every page."
READ_ALL_ZH = "先读 index.md,然后逐页读完全部页面。"
READ_SAMPLE_EN = ("Read index.md in full first, then the entry/overview pages it highlights, "
                  "and skim the opening section of enough other pages to summarize honestly — "
                  "you do not need to read every page.")
READ_SAMPLE_ZH = ("先完整读 index.md,再读它标出的入口/总览页,其余页面浏览开头部分、"
                  "读到足以诚实概括为止——不必逐页读完。")
RETRY_EN = "\n\n(Your previous output could not be used: {err}. Answer again and output **valid JSON only**, matching the schema above, with no other text.)"
RETRY_ZH = "\n\n(你上一次的输出无法使用:{err}。请重新作答,**只输出符合上述 schema 的合法 JSON**,不带任何其他文字。)"


async def generate_consumer_meta(engine: ReadonlyAgentEngine, *, workdir: str,
                                 locale: str | None = None) -> dict:
    """One blind read-only pass over {workdir}/candidate → the normalized meta
    dict (pinned schema, ready for selfcheck.write_consumer_meta). Raises on
    failure — the caller (compile_box settle seam) is fail-open. Retries the
    model ONCE when the output doesn't parse/normalize (same shape as
    redblue._agent_json), including the U+FFFD charset guard in normalize."""
    cand = Path(workdir) / "candidate"
    page_names = sorted(f.relative_to(cand).as_posix()
                        for f in cand.rglob("*.md") if f.is_file()) if cand.is_dir() else []
    if not page_names:
        raise ValueError("no candidate pages to summarize")
    en = _is_en(locale)
    shown = page_names[:_PAGE_LIST_CAP]
    page_list = "\n".join(f"- {p}" for p in shown)
    if len(page_names) > len(shown):
        page_list += ("\n- …(" + str(len(page_names)) + " total)") if en else (
            "\n- …(共 " + str(len(page_names)) + " 页)")
    read_all = len(page_names) <= _read_all_cap()
    read_directive = ((READ_ALL_EN if read_all else READ_SAMPLE_EN) if en
                      else (READ_ALL_ZH if read_all else READ_SAMPLE_ZH))
    role = ROLE_EN if en else ROLE_ZH
    user = (USER_EN if en else USER_ZH).format(
        n=len(page_names), page_list=page_list, read_directive=read_directive,
        summary_max=selfcheck.CONSUMER_META_SUMMARY_MAX)
    model = _meta_model()
    last_err = "?"
    for _attempt in range(2):
        text = await engine.run_readonly_agent(
            cwd=str(cand), system_prompt=role, user_message=user, model=model,
            allowed_read_roots=[str(cand)], timeout_secs=_meta_timeout())
        try:
            data = parse_json_lenient(text)
            return selfcheck.normalize_consumer_meta(
                data, locale=locale, generated_by=model, page_names=page_names)
        except ValueError as e:
            last_err = str(e)
            user = user + (RETRY_EN if en else RETRY_ZH).format(err=last_err)
    raise ValueError(f"consumer meta generation failed after retry: {last_err}")
