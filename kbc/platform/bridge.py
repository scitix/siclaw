#!/usr/bin/env python3
"""bridge —— 账本里"待人裁的矛盾(parked)" ↔ forge issue 的翻译官。

这是护城河在 Web 上的落点。两个方向:
  push:  读 out/ledger.json 里 status=parked 的 finding → 渲染成 issue 开到 forge。
         已开过的不重开(issue 号记回 finding['issue'],对应"一个矛盾只 park 一次")。
  pull:  读这些 issue 的人类回复 → 解析选了哪个选项 → 回填账本
         (finding -> status=ruled, resolution=人裁结论),并在 issue 上回执 + 关闭。

它不直接调 forge HTTP(那是 forge_client 的活),也不做编译/推理。只翻译 + 搬运。
"""
import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from forge_client import ForgeClient  # noqa: E402  同目录的哑工具

PARKED = "parked"
OPTION_MARKS = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨"]


def _title(f):
    return f"❓[待裁决] {f['summary'][:50]}"


def _render_issue(f):
    """把一个 parked finding 渲染成领域专家一眼能裁的 issue 正文(证据内联 + 预分类选项)。"""
    lines = [f["summary"], "", "**证据(原文)**:"]
    for e in f.get("evidence", []):
        lines.append(f"- 〔{e['source']}〕{e['quote']}")
    lines += ["", "**请选一个理解**(回复对应编号即可,如 `②`):", ""]
    for opt in f.get("mcq", {}).get("options", []):
        lines.append(f"- {opt}")
    lines += ["",
              "> 本条由 kbc 编译器在发现矛盾、且裁决纪律(constitution)无法自动归并时自动开出。",
              "> 你裁完,结论会回填进知识库。"]
    return "\n".join(lines)


def _parse_choice(text):
    """从一条回复里解析选了第几个选项(0-based);解析不出返回 None。"""
    for i, mark in enumerate(OPTION_MARKS):
        if mark in text:
            return i
    m = re.search(r"\b([1-9])\b", text.strip())
    return int(m.group(1)) - 1 if m else None


def _load(ledger_path):
    return json.loads(Path(ledger_path).read_text())


def _save(ledger_path, led):
    Path(ledger_path).write_text(json.dumps(led, ensure_ascii=False, indent=2))


def push(ledger_path, repo):
    led = _load(ledger_path)
    fc = ForgeClient(repo)
    opened = []
    for fid, f in led["findings"].items():
        if f.get("status") != PARKED or f.get("issue"):
            continue
        issue = fc.open_issue(_title(f), _render_issue(f), labels=["待裁决"])
        f["issue"] = issue["number"]
        opened.append((fid, issue["number"], issue["html_url"]))
    _save(ledger_path, led)
    return opened


def pull(ledger_path, repo):
    led = _load(ledger_path)
    fc = ForgeClient(repo)
    backfilled = []
    for fid, f in led["findings"].items():
        if f.get("status") != PARKED or not f.get("issue"):
            continue
        n = f["issue"]
        choice = None
        for c in reversed(fc.get_comments(n)):  # 取最新一条能解析的回复
            choice = _parse_choice(c["body"])
            if choice is not None:
                break
        if choice is None:
            continue  # 还没人裁,跳过
        options = f.get("mcq", {}).get("options", [])
        picked = options[choice] if 0 <= choice < len(options) else f"option#{choice + 1}"
        f["status"] = "ruled"
        f["resolution"] = f"human:{picked}"
        f["ruled_by"] = f"forge issue #{n}"
        fc.add_comment(n, f"✅ 已回填知识库:{picked}")
        fc.close_issue(n)
        backfilled.append((fid, picked, n))
    _save(ledger_path, led)
    return backfilled


def status(ledger_path, repo):
    led = _load(ledger_path)
    rows = []
    for fid, f in led["findings"].items():
        if f.get("status") == PARKED or f.get("ruled_by"):
            rows.append((fid, f.get("status"), f.get("issue"), f.get("resolution", "")))
    return rows


def main(argv=None):
    p = argparse.ArgumentParser(description="bridge —— parked 矛盾 ↔ forge issue 翻译官")
    p.add_argument("--ledger", default="out/ledger.json")
    p.add_argument("--repo", default="kbc/aliyun-fc")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("push", help="parked 矛盾 → 开成 issue")
    sub.add_parser("pull", help="读人类回复 → 回填账本")
    sub.add_parser("status", help="看 parked / 已裁 一览")
    args = p.parse_args(argv)

    if args.cmd == "push":
        opened = push(args.ledger, args.repo)
        if not opened:
            print("没有待裁决(parked)的矛盾要开 issue —— 要么没有,要么都已开过。")
        for fid, n, url in opened:
            print(f"开 issue #{n}  <- {fid}\n   {url}")
    elif args.cmd == "pull":
        done = pull(args.ledger, args.repo)
        if not done:
            print("没有可回填的(还没人在 issue 上裁)。")
        for fid, picked, n in done:
            print(f"回填 {fid}  <- issue #{n}  裁决: {picked}")
    elif args.cmd == "status":
        for fid, st, issue, res in status(args.ledger, args.repo):
            print(f"{fid:28} status={st:8} issue={issue}  {res}")


if __name__ == "__main__":
    main()
