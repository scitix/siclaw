#!/usr/bin/env python3
"""Generate a deterministic, fictional corpus for compiler load acceptance.

Usage: python generate_compiler_corpus.py OUTPUT_DIRECTORY
Upload only raw/. Keep expected.json outside the compiler's source workspace.
"""

import argparse
import hashlib
import json
from pathlib import Path


def generate(root: Path) -> dict:
    raw = root / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    questions = []

    def expect(question: str, answer: str, sources: list[str]) -> None:
        questions.append({"question": question, "reference_answer": answer, "sources": sources})

    for index in range(1, 13):
        name = f"regions/region-{index:02d}.md"
        threshold = 700 + index * 13
        window = 4 + index
        body = (
            f"# Example Queue: region {index:02d}\n\n"
            "This is a fictional staging service. Production settings are unknown.\n"
            f"Region {index:02d} raises an alert above {threshold} queued jobs for {window} minutes.\n"
            f"Its recovery procedure is R{index:02d}, documented in the central manual.\n"
            "These historical samples illustrate normal operation, not additional policy.\n\n"
        )
        body += "".join(f"- sample {row:04d}: queued jobs {row % 200}, state healthy, no alert.\n" for row in range(180))
        body += f"\nRegion {index:02d} owner: Operations-{index:02d}; escalation code E{index * 37:03d}.\n"
        path = raw / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")
        expect(f"What are the alert threshold, duration and escalation code for region {index:02d}?",
               f"Above {threshold} queued jobs for {window} minutes; E{index * 37:03d}.", [name])

    manual = "# Example Queue central recovery manual\n\nAll procedures apply only to fictional staging.\n"
    for index in range(1, 7):
        fact = f"Recovery band {index}: wait {index * 17 + 11} seconds and require {index + 2} healthy observations."
        manual += f"\n## Recovery band {index}\n\n{fact}\n"
        manual += "".join(
            f"Observation {index}-{row:05d}: completed sample; queue healthy; no incident; diagnostic only.\n"
            for row in range(2100)
        )
        expect(f"How long must recovery band {index} wait, and how many healthy observations are required?",
               fact, ["manual.md"])
    manual += "\n## Procedure mapping\n\n"
    for index in range(1, 13):
        manual += f"R{index:02d} uses recovery band {(index - 1) % 6 + 1}.\n"
    manual += "\n## Final recovery gate\n\nThe final manual gate is 291 queued jobs or fewer for 13 minutes, followed by operator acknowledgement. Automated write replay is forbidden.\n"
    (raw / "manual.md").write_text(manual, encoding="utf-8")
    expect("What is the final recovery gate at the end of the central manual?",
           "291 queued jobs or fewer for 13 minutes, then operator acknowledgement. Automated write replay is forbidden.", ["manual.md"])

    single = "Example Queue single-line policy supplement. Initial policy: audit retention is 37 days. "
    single += "Healthy samples are historical observations; they do not change the recovery policy. " * 2700
    single += "Final supplement policy: maintenance freeze lasts 83 minutes and release requires two operators."
    (raw / "supplement.txt").write_text(single, encoding="utf-8")
    expect("What are the retention period and final maintenance-freeze requirements in the single-line supplement?",
           "Retention is 37 days. Maintenance freeze lasts 83 minutes; release requires two operators.", ["supplement.txt"])
    expect("Which recovery band applies to region 08, and what wait and observation requirements follow?",
           "Region 08 uses R08, which maps to band 2: wait 45 seconds and require 4 healthy observations.",
           ["regions/region-08.md", "manual.md"])
    expect("Are these staging thresholds established for production?",
           "No. Production settings are unknown; these documents only define fictional staging.",
           ["regions/region-01.md", "manual.md"])

    sources = [{"path": path.relative_to(raw).as_posix(), "bytes": path.stat().st_size,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
               for path in sorted(raw.rglob("*")) if path.is_file()]
    result = {"schema": "compiler-load-acceptance/v1", "sources": sources,
              "total_bytes": sum(item["bytes"] for item in sources), "questions": questions}
    (root / "expected.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    result = generate(parser.parse_args().output)
    print(json.dumps({"sources": len(result["sources"]), "bytes": result["total_bytes"],
                      "questions": len(result["questions"])}))
