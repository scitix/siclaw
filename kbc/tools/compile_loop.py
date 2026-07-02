#!/usr/bin/env python3
"""compile_loop.py — 编译环状态机(阶段③ 心脏)。

实现 design/compile-loop.md:INIT→SELECT→COMPILE_BATCH→TRIAGE→(AUTO_RESOLVE|PARK_ITEM)→PARK/CONVERGED。
状态全在账本(json),可中断/恢复。

智能已接真 Claude(经 llm.py 的 headless 后端):
  _compile_doc(...)  读 ingest 的 provenance-md → 抽 OKF 断言(带出处)+ 跨已编断言检矛盾 → 真 findings
  triage(finding, 宪法)  按装载的宪法判 auto/park,park 则框领域 MCQ(见 triage.py)
域无关:宪法是装载进来的文本(--constitution 指向的文件),代码不内置任何库的具体规则。
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

from llm import call_json
from triage import triage

DRY_K = 2

_COMPILE_PROMPT = """你是知识库编译器。读【本篇源文档】,做两件事,受【宪法】约束:
1. 抽取其中的原子事实断言(claims):每条尽量短、可独立判真伪,标注它来自文档里哪个 @prov 锚(出处)。
2. 跨【已编断言】检测矛盾:若本文档某断言与某条已编断言冲突(同一事实、不同说法),产出一条 finding,
   evidence 里把冲突双方的原文 + 出处都摆出来。**只报真冲突;措辞差异、或宪法判为可并列/可归并的差异,不算冲突**。

【宪法(编译纪律)】
{constitution}

【已编断言(跨文档累积)】
{existing}

【本篇源文档(含 <!-- @prov ... --> 出处锚)】
{doc}

只输出 JSON,不要任何其它文字:
{{"claims":[{{"text":"一句断言","anchor":"@prov 锚 id"}}],
  "findings":[{{"kind":"contradiction","summary":"一句话","evidence":[{{"source":"出处","quote":"原文片段"}}]}}]}}"""


# ───────────────────────── 账本 ─────────────────────────
class Ledger:
    def __init__(self, path):
        self.path = Path(path)
        self.d = {"state": "init", "sources": {}, "claims": [],
                  "findings": {}, "rounds": {"dry": 0}}
        if self.path.exists():
            self.d = json.loads(self.path.read_text(encoding="utf-8"))

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.d, ensure_ascii=False, indent=2), encoding="utf-8")

    def pending(self):
        return [s for s in self.d["sources"].values() if s["status"] == "pending"]

    def parked(self):
        return [f for f in self.d["findings"].values() if f["status"] == "parked"]

    def has_fp(self, fp):
        return any(f.get("fp") == fp for f in self.d["findings"].values())


# ──────────────── 智能:真 Claude(经 llm.py / triage.py)────────────────
def _compile_doc(source, existing_claims, constitution):
    """读 source 的 provenance-md → 抽断言 + 检矛盾。返回 (claims, findings)。"""
    doc = Path(source["md_path"]).read_text(encoding="utf-8")
    existing = "\n".join(
        f"- {c['text']}(源:{c['src']})" for c in existing_claims) or "(无,这是第一篇)"
    out = call_json(_COMPILE_PROMPT.format(
        constitution=constitution.strip(), existing=existing, doc=doc))
    return out.get("claims", []), out.get("findings", [])


def _fp(finding):
    key = f"{finding.get('kind')}|{finding.get('summary', '')}"
    return hashlib.md5(key.encode()).hexdigest()[:10]


def triage_finding(ledger, finding, constitution):
    fp = _fp(finding)
    if ledger.has_fp(fp):                  # 同一矛盾只裁一次(防永不收敛)
        return
    r = triage(finding, constitution)      # TRIAGE(真 Claude)
    if r.get("route") == "auto":           # AUTO_RESOLVE
        finding.update({"fp": fp, "status": "auto_resolved",
                        "resolution": r.get("auto_resolution", "")})
    else:                                  # PARK_ITEM(攒批),mcq 来自 triage
        finding.update({"fp": fp, "status": "parked", "reason": r.get("reason", ""),
                        "mcq": r.get("mcq")})
    ledger.d["findings"][f"f::{fp}"] = finding


# ───────────────────────── 状态机 ─────────────────────────
def run(ledger, constitution):
    ledger.d["state"] = "running"
    while True:
        batch = ledger.pending()[:1]       # SELECT(一批 = 一篇待编文档)
        if batch:
            for src in batch:
                claims, findings = _compile_doc(src, ledger.d["claims"], constitution)  # COMPILE_BATCH
                for c in claims:
                    c["src"] = Path(src["src_file"]).name
                    ledger.d["claims"].append(c)
                src["status"] = "compiled"
                for f in findings:                                                      # TRIAGE
                    triage_finding(ledger, f, constitution)
            ledger.d["rounds"]["dry"] = 0
            ledger.save()
            continue
        if ledger.parked():                # 无可推进、有 parked → PARK
            ledger.d["state"] = "wait_human"
            ledger.save()
            return "PARK"
        ledger.d["rounds"]["dry"] += 1     # 干涸守卫
        if ledger.d["rounds"]["dry"] >= DRY_K:
            ledger.d["state"] = "converged"
            ledger.save()
            return "CONVERGED"


def backfill(ledger, answers):
    for fid, ruling in answers.items():
        f = ledger.d["findings"].get(fid)
        if f and f["status"] == "parked":
            f["status"] = "ruled"
            f["resolution"] = f"human:{ruling}"
    ledger.d["rounds"]["dry"] = 0
    ledger.save()


# ───────────────────────── CLI / INIT / 报告 ─────────────────────────
def load_corpus(ingested_dir, ledger):
    for pj in sorted(Path(ingested_dir).glob("*.provenance.json")):
        prov = json.loads(pj.read_text(encoding="utf-8"))
        sid = pj.name.replace(".provenance.json", "")
        if sid in ledger.d["sources"]:
            continue
        src = Path(prov["source"])
        h = hashlib.md5(src.read_bytes()).hexdigest()[:12] if src.exists() else "?"
        ledger.d["sources"][sid] = {
            "id": sid, "src_file": prov["source"], "format": prov["format"],
            "md_path": str(pj.with_name(sid + ".md")), "hash": h, "status": "pending"}


def report(ledger, outcome):
    s = ledger.d
    n_compiled = sum(1 for x in s["sources"].values() if x["status"] == "compiled")
    auto = [f for f in s["findings"].values() if f["status"] == "auto_resolved"]
    ruled = [f for f in s["findings"].values() if f["status"] == "ruled"]
    parked = ledger.parked()
    print(f"\n── 编译环结果:{outcome}(state={s['state']})──")
    print(f"源 {n_compiled}/{len(s['sources'])} 已编 · 断言 {len(s['claims'])} · "
          f"自裁 {len(auto)} · parked {len(parked)} · 已人裁 {len(ruled)}")
    for f in auto:
        print(f"\n  ✅ 自裁 [{f['fp']}] {f.get('summary')}\n     → {f.get('resolution')}")
    for f in parked:
        m = f.get("mcq") or {}
        print(f"\n  ❓ 升级人裁 [{f['fp']}] {m.get('question', f.get('summary'))}")
        for e in m.get("evidence", []):
            print(f"     · {e}")
        for o in m.get("options", []):
            print(f"        {o}")


def main():
    ap = argparse.ArgumentParser(description="编译环状态机(阶段③)")
    ap.add_argument("--ledger", required=True)
    ap.add_argument("--ingested", help="ingest 产物目录(首次 INIT 登记源)")
    ap.add_argument("--constitution", help="宪法文件路径(装载,不内置)")
    ap.add_argument("--answers", help="人裁 json {finding_id: ruling} → BACKFILL 后续跑")
    a = ap.parse_args()

    constitution = Path(a.constitution).expanduser().read_text(encoding="utf-8") if a.constitution else ""
    ledger = Ledger(a.ledger)
    if a.ingested:
        load_corpus(a.ingested, ledger)
        ledger.save()
    if a.answers:
        backfill(ledger, json.loads(Path(a.answers).expanduser().read_text(encoding="utf-8")))
    report(ledger, run(ledger, constitution))
    sys.exit(0)


if __name__ == "__main__":
    main()
