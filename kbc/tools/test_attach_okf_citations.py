"""Focused tests for the standalone OKF citation migration utility."""

import importlib.util
import json
import tarfile
import tempfile
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("attach_okf_citations.py")
SPEC = importlib.util.spec_from_file_location("attach_okf_citations", MODULE_PATH)
assert SPEC and SPEC.loader
tool = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(tool)


INDEX = '---\nokf_version: "0.2"\n---\n\n# Index\n'
PAGE = """---
type: Concept
compiled_from:
  - 1-Roadmap & Spec/source.md
---

# Page
"""


def _write(root: Path, rel: str, body: str) -> None:
    target = root / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(body, encoding="utf-8")


def test_migrates_compiled_from_and_embeds_only_referenced_mappings() -> None:
    with tempfile.TemporaryDirectory() as raw:
        base = Path(raw)
        wiki = base / "wiki"
        _write(wiki, "index.md", INDEX)
        _write(wiki, "page.md", PAGE)
        source_package = base / "source.tar.gz"
        tool.write_import_archive(wiki, source_package)
        source_map = base / "map.json"
        source_map.write_text(json.dumps({
            "schema_version": 1,
            "sources": [
                {
                    "resource": "1-Roadmap & Spec/source.md",
                    "title": "Source",
                    "origin_type": "feishu",
                    "origin_url": "https://docs.feishu.cn/wiki/source",
                },
                {
                    "resource": "unused.md",
                    "title": "Unused",
                    "origin_type": "feishu",
                    "origin_url": "https://docs.feishu.cn/wiki/unused",
                },
            ],
        }), encoding="utf-8")

        output = base / "cited.tar.gz"
        migrated = base / "migrated"
        receipt = tool.migrate_package(source_package, source_map, output, migrated)

        assert receipt["migrated_pages"] == 1
        assert receipt["source_resources"] == receipt["citation_sources"] == 1
        assert receipt["unmapped_resources"] == []
        page = (migrated / "page.md").read_text(encoding="utf-8")
        assert 'sources:\n  - resource: "1-Roadmap & Spec/source.md"\ncompiled_from:' in page
        sidecar = json.loads((migrated / tool.CITATION_SIDECAR).read_text(encoding="utf-8"))
        assert [row["resource"] for row in sidecar["sources"]] == ["1-Roadmap & Spec/source.md"]
        with tarfile.open(output, "r:gz") as archive:
            assert tool.CITATION_SIDECAR in archive.getnames()


if __name__ == "__main__":
    test_migrates_compiled_from_and_embeds_only_referenced_mappings()
    print("OK  OKF package citation migration")
