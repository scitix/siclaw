#!/usr/bin/env python3
"""compile_tools — the box's structured-signal tools, engine-neutral.

The four compile tools (report_summary / propose_plan / resolve_ticket /
propose_questions) are the kbc moat: they let the agent emit deterministic,
code-written signals instead of prose. Their BODIES live here as plain async
functions (args + workdir + emit → result text) so a signal behaves identically
no matter which engine invoked it.

Engine adapters own the ASSEMBLY only:
  - Claude engine (engines/claude.py): wraps each body as an in-process SDK MCP
    tool.
  - Codex engine (engines/codex.py): serves the specs to the CLI through a
    stdio MCP server (mcp_compile_server.py) whose tools/call POSTs back into
    the box; the callback handler executes the same bodies.

TODO(locale) — DEBT, resolve before #383 merges: the tool descriptions
(TOOL_SPECS) and result strings below are Chinese-only and are NOT wired to the
locale prompt packs (prompts/<locale>/tools.json) the way compile_box.py's
system prompts are — an English KB served by this engine gets Chinese tool docs,
regressing the locale-pack work on the base branch. This mechanical rebase keeps
them zh-only on purpose (the Codex engine is experimental and not end-to-end
verifiable without a CLI/subscription). To finish the alignment: (1) move a
shared pack loader (compile_box._tool_strings) into a module BOTH compile_box.py
and compile_tools.py import, so there is no compile_box→engines→compile_tools
import cycle; (2) thread the run's locale into TOOL_SPECS + the tool bodies,
including via an env var (e.g. KBC_COMPILE_LOCALE) set at spawn time so it
reaches the SEPARATE mcp_compile_server process the Codex CLI runs.
"""
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

QUESTIONS_PROPOSED_PATH = "authoring/QUESTIONS_PROPOSED.json"

# Tool specs shared by every assembly: name, description (the text the model
# sees), and a flat param map (name → "string" | "array"). The Claude adapter
# maps these to SDK @tool schemas; the stdio MCP server maps them to JSON Schema.
TOOL_SPECS = [
    {
        "name": "report_summary",
        "description": "汇报一段编译进度总结(产出/已并矛盾/待裁),一句到一段话。",
        "params": {"summary": "string"},
    },
    {
        "name": "propose_plan",
        "description": (
            "Plan 阶段对齐后调用:把一份简短、可读、可审核的编译计划(plan 参数,markdown)抛给负责人请求批准,"
            "然后停下等批准。在收到批准前不要写 candidate/ 页面。"
        ),
        "params": {"plan": "string"},
    },
    {
        "name": "resolve_ticket",
        "description": (
            "回修完一条矛盾工单后逐条调用(一条一次,别批量):登记你把哪条(ticket_id)按什么值(applied_value)"
            "回修了、实际改了哪几个 candidate 文件(pages_edited,必须覆盖该工单的 affected_pages)、一句话备注(note)。"
            "这会把该工单标为已回修并写下可审计的 agent_report —— 是「矛盾处理」显示「AI 已回修」、并让负责人核对的依据。"
        ),
        "params": {"ticket_id": "string", "applied_value": "string", "pages_edited": "array", "note": "string"},
    },
    {
        "name": "propose_questions",
        "description": (
            "编完(写完 candidate/index.md、审计过)后顺手调:提交 3-5 道供负责人测试知识库的备题。"
            "questions 是数组,每条 {question: 单一事实问句, reference: 参考答案(≤150字), source: 原料出处}。"
            "追加式:重复调用会按题面去重合并进 authoring/QUESTIONS_PROPOSED.json,绝不覆盖前一轮已备的题。"
        ),
        "params": {"questions": "array"},
    },
]


def find_playbook():
    """找 kbc playbook(编译纪律):优先 KBC_PLAYBOOK 环境变量,否则向上找 CLAUDE.md。
    (Engine-neutral: prompt-pack discovery must not require the Claude SDK.)"""
    env = os.environ.get("KBC_PLAYBOOK")
    if env:
        return Path(env)
    for parent in Path(__file__).resolve().parents:
        cand = parent / "CLAUDE.md"
        if cand.exists():
            return cand
    return None


def _normalize_question(q: str) -> str:
    """Dedup key for a proposed question: whitespace-stripped, trailing
    punctuation removed, case-folded — so trivially-reworded repeats collapse."""
    return re.sub(r"\s+", "", str(q or "")).strip("?？。.!！,，、").lower()


def _fnv1a32(s: str) -> int:
    """32-bit FNV-1a over the UTF-8 bytes of s. Shared, fixed formula with the
    frontend so both sides derive the SAME proposal id from a question."""
    h = 2166136261
    for b in s.encode("utf-8"):
        h ^= b
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def _question_id(normalized: str) -> str:
    """Stable proposal id agreed with the frontend: 'q-' + fnv1a32(normalized
    question) as zero-padded 8-hex-digit lowercase. The frontend POSTs this as
    proposal_id on adopt/dismiss — a missing id → empty proposal_id → sicore 500."""
    return "q-" + format(_fnv1a32(normalized), "08x")


def merge_proposed_questions(existing: list, incoming: list) -> tuple[list, int, int]:
    """Append-merge newly proposed questions onto the existing list, skipping
    duplicates by normalized question text. Every merged entry carries a stable
    `id` (see _question_id) — the frontend needs it as proposal_id on adopt/dismiss.
    A prior explicit id is preserved; legacy/id-less entries are backfilled from
    the same formula (identical for the same question). Returns (merged, added,
    skipped). Append-only across rounds so a re-proposal never wipes prior picks."""
    merged: list = []
    seen: set = set()
    for q in existing:
        if not isinstance(q, dict):
            continue
        text = str(q.get("question", "")).strip()
        if not text:
            continue
        key = _normalize_question(text)
        seen.add(key)
        qid = str(q.get("id", "")).strip() or _question_id(key)
        merged.append({**q, "id": qid, "question": text})
    added = skipped = 0
    for item in incoming:
        if not isinstance(item, dict):
            skipped += 1
            continue
        text = str(item.get("question", "")).strip()
        key = _normalize_question(text)
        if not key or key in seen:
            skipped += 1
            continue
        seen.add(key)
        merged.append({
            "id": _question_id(key),
            "question": text,
            "reference": str(item.get("reference", "")).strip(),
            "source": str(item.get("source", "")).strip(),
        })
        added += 1
    return merged, added, skipped


async def _report_summary(args, workdir: str, emit) -> str:
    await emit({"type": "summary", "summary": args.get("summary", "")})
    return "summary recorded"


async def _propose_plan(args, workdir: str, emit) -> str:
    # The owner's approve UI is driven by THIS artifact — written here by
    # code, deterministically, from the tool argument. The signal must never
    # depend on how the model formatted its working notes (a proposal that
    # bounces on file formatting is a UI held hostage by prose). PLAN.md
    # remains the box's own working state; syncing happens at turn end.
    plan_text = str(args.get("plan", ""))
    proposal_path = Path(workdir) / "authoring" / "PROPOSED_PLAN.json"
    proposal_path.parent.mkdir(parents=True, exist_ok=True)
    proposal_path.write_text(json.dumps({
        "text": plan_text,
        "proposed_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }, ensure_ascii=False, indent=2), "utf-8")
    await emit({"type": "plan_proposed", "plan": plan_text})
    # Advisory nudge only — working-state hygiene, never a gate.
    reminder = ""
    plan_path = Path(workdir) / "authoring" / "PLAN.md"
    section = ""
    if plan_path.exists():
        m = re.search(r"## Next Pages\n(.*?)(?=\n## |\Z)", plan_path.read_text("utf-8"), re.S)
        section = m.group(1) if m else ""
    if "- [ ]" not in section and "- [x]" not in section:
        reminder = "(提醒:顺手把候选页清单以 `- [ ] 页名 — 一句话` 维护进 authoring/PLAN.md 的 ## Next Pages 作为你的工作状态,便于追踪进度;这不影响本次计划已抛出。)"
    return "计划已抛给负责人(UI 已显示计划与批准控件),等待批准。在收到批准消息前不要写 candidate/ 页面。" + reminder


async def _resolve_ticket(args, workdir: str, emit) -> str:
    tid = str(args.get("ticket_id", "")).strip()
    if not tid:
        return "resolve_ticket 需要 ticket_id"
    path = Path(workdir) / "authoring" / "CONTRADICTIONS.json"
    try:
        tickets = json.loads(path.read_text("utf-8")) if path.exists() else []
        if not isinstance(tickets, list):
            tickets = []
    except Exception as e:
        return f"读 CONTRADICTIONS.json 失败: {e}"
    target = next((tk for tk in tickets if isinstance(tk, dict) and str(tk.get("id")) == tid), None)
    if target is None:
        ids = [tk.get("id") for tk in tickets if isinstance(tk, dict)]
        return f"没找到工单 {tid};现有 id: {ids}"
    # The AI's structured CLAIM (evidence, not truth): the owner reviews it and
    # can reopen. status stays for back-compat; agent_report carries the detail.
    target["status"] = "applied"
    target["agent_report"] = {
        "applied_value": str(args.get("applied_value", "")),
        "pages_edited": [str(p) for p in (args.get("pages_edited") or []) if str(p).strip()],
        "note": str(args.get("note", "")),
        # Echo of the dispatch nonce from the apply directive: lets the
        # consumer match this receipt to the EXACT dispatch round it answers
        # (timestamps alone cannot distinguish two overlapping rounds).
        "dispatch_nonce": str(args.get("dispatch_nonce", "")),
        "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    try:
        path.write_text(json.dumps(tickets, ensure_ascii=False, indent=2), "utf-8")
    except Exception as e:
        return f"写 CONTRADICTIONS.json 失败: {e}"
    return f"工单 {tid} 已登记回修(agent_report 已写入)"


async def _propose_questions(args, workdir: str, emit) -> str:
    incoming = args.get("questions")
    if not isinstance(incoming, list):
        return "propose_questions 需要 questions 数组"
    path = Path(workdir) / QUESTIONS_PROPOSED_PATH
    try:
        existing = json.loads(path.read_text("utf-8")) if path.exists() else []
        if not isinstance(existing, list):
            existing = []
    except Exception:
        existing = []  # a corrupt/half-written prior file must not lose this round
    merged, added, skipped = merge_proposed_questions(existing, incoming)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        path.write_text(json.dumps(merged, ensure_ascii=False, indent=2) + "\n", "utf-8")
    except Exception as e:
        return f"写 QUESTIONS_PROPOSED.json 失败: {e}"
    await emit({"type": "summary", "summary": f"已备 {added} 道测试题(去重跳过 {skipped}),共 {len(merged)} 道待负责人挑选。"})
    return f"备题已登记:新增 {added}、去重跳过 {skipped}、当前共 {len(merged)} 道(authoring/QUESTIONS_PROPOSED.json)。"


_HANDLERS = {
    "report_summary": _report_summary,
    "propose_plan": _propose_plan,
    "resolve_ticket": _resolve_ticket,
    "propose_questions": _propose_questions,
}


async def execute_compile_tool(name: str, args: dict, *, workdir: str, emit) -> str:
    """Run one compile tool body; returns the result text shown to the model.
    Raises KeyError for an unknown tool name (assembly bug — fail loudly)."""
    handler = _HANDLERS[name]
    return await handler(args or {}, workdir, emit)
