"""Contract tests for the compiler attestation sidecar (build + packaging gate)."""

import hashlib
import json
import tempfile
from pathlib import Path

import okf_attestation
from okf_package import OKFPackageError, collect_import_files, write_import_archive


# Pinned digest of the shared conformance fixture. The same value is pinned in
# sicore internal/siclaw/knowledge/okf_attestation_test.go — editing either
# copy fails that side's test until both copies (and both pins) are updated
# together.
CONFORMANCE_SHA256 = "0d30e08f0e13acc74e2325edcc895d8ea04c70e6fac1ea32cc5b51e8fc4511bf"
CONFORMANCE_PATH = Path(__file__).parent / "fixtures" / "okf-attestation" / "conformance.json"

INDEX = '---\nokf_version: "0.2"\n---\n\n# Contents\n'
PAGE = "---\ntype: Topic\n---\n\nA compiled page.\n"

_WIKI_FILES = [
    ("index.md", INDEX.encode("utf-8")),
    ("topics/a.md", PAGE.encode("utf-8")),
    ("topics/b.md", PAGE.encode("utf-8")),
]


def _write(root: Path, rel: str, body: str) -> None:
    target = root / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(body, encoding="utf-8")


def _payload_sha256() -> str:
    return okf_attestation.payload_manifest_sha256(_WIKI_FILES)


def _valid_doc(concept_pages: int = 2) -> dict:
    return {
        "schema_version": 1,
        "producer": {"name": "siclaw-kbc", "version": "0.9.0"},
        "input_revision": "sha256:a1b2c3",
        "concept_pages": concept_pages,
        "payload_manifest_sha256": _payload_sha256(),
        "coverage": {"closed": True, "cited": 4, "excluded": 1, "auto_attached": 0,
                     "derived": 0, "unaccounted": 0, "dangling": 0},
        "checks": [
            {"name": "selfcheck", "status": "pass"},
            {"name": "redblue", "status": "pass", "detail": "16/16 questions"},
        ],
        "signature": None,
    }


def _wiki_with_sidecar(base: Path, doc: dict | str) -> Path:
    wiki = base / "wiki"
    for rel, data in _WIKI_FILES:
        _write(wiki, rel, data.decode("utf-8"))
    body = doc if isinstance(doc, str) else okf_attestation.render_attestation(doc)
    _write(wiki, okf_attestation.ATTESTATION_SIDECAR, body)
    return wiki


def _violations(doc: object) -> list[dict]:
    return okf_attestation.attestation_violations(
        doc, concept_pages=2, payload_sha256=_payload_sha256())


def test_valid_attestation_passes_and_classifies_self_attested() -> None:
    doc = _valid_doc()
    assert _violations(doc) == []
    assert okf_attestation.classify_tier(doc) == okf_attestation.TIER_SELF_ATTESTED


def test_honest_failure_classifies_unattested() -> None:
    doc = _valid_doc()
    doc["checks"][0]["status"] = "fail"
    assert _violations(doc) == []
    assert okf_attestation.classify_tier(doc) == okf_attestation.TIER_UNATTESTED


def test_open_coverage_classifies_unattested() -> None:
    doc = _valid_doc()
    doc["coverage"].update({"closed": False, "unaccounted": 3})
    assert _violations(doc) == []
    assert okf_attestation.classify_tier(doc) == okf_attestation.TIER_UNATTESTED


def test_lying_receipts_are_violations() -> None:
    cases = [
        ("concept_pages", lambda d: d.update(concept_pages=37)),
        ("payload digest mismatch", lambda d: d.update(payload_manifest_sha256="cd" * 32)),
        ("payload digest missing", lambda d: d.pop("payload_manifest_sha256")),
        ("closed contradicts", lambda d: d["coverage"].update(unaccounted=5)),
        ("unknown field", lambda d: d.update(extra=True)),
        ("schema version", lambda d: d.update(schema_version=9)),
        ("signature", lambda d: d.update(signature="sig-bytes")),
        ("duplicate checks", lambda d: d["checks"].append({"name": "selfcheck", "status": "pass"})),
        ("bad status", lambda d: d["checks"][0].update(status="maybe")),
        ("empty checks", lambda d: d.update(checks=[])),
        ("bad producer", lambda d: d["producer"].update(name=" ")),
        ("bad revision", lambda d: d.update(input_revision="!!!")),
    ]
    for label, mutate in cases:
        doc = _valid_doc()
        mutate(doc)
        assert _violations(doc), label


def test_build_attestation_refuses_invalid_input() -> None:
    try:
        okf_attestation.build_attestation(
            producer_name="siclaw-kbc", concept_pages=2,
            payload_sha256=_payload_sha256(),
            checks=[{"name": "selfcheck", "status": "maybe"}],
        )
    except ValueError as error:
        assert "status" in str(error)
    else:
        raise AssertionError("build_attestation accepted an invalid check status")


def test_packager_ships_valid_sidecar_and_keeps_determinism() -> None:
    with tempfile.TemporaryDirectory() as raw:
        base = Path(raw)
        wiki = _wiki_with_sidecar(base, _valid_doc())
        assert [rel for rel, _ in collect_import_files(wiki)] == [
            okf_attestation.ATTESTATION_SIDECAR, "index.md", "topics/a.md", "topics/b.md",
        ]
        first = write_import_archive(wiki, base / "first.tar.gz")
        second = write_import_archive(wiki, base / "second.tar.gz")
        assert first["sha256"] == second["sha256"]


def test_packager_rejects_replayed_receipts_after_content_edit() -> None:
    # Same page count, different bytes: the exact hole the payload manifest
    # digest exists to close.
    with tempfile.TemporaryDirectory() as raw:
        base = Path(raw)
        wiki = _wiki_with_sidecar(base, _valid_doc())
        (wiki / "topics" / "a.md").write_text(
            PAGE + "\nEdited after the receipts were issued.\n", encoding="utf-8")
        try:
            collect_import_files(wiki)
        except OKFPackageError as error:
            assert "payload_manifest_sha256 does not match" in str(error)
        else:
            raise AssertionError("packager accepted receipts replayed onto edited content")


def test_packager_rejects_lying_page_count_before_upload() -> None:
    with tempfile.TemporaryDirectory() as raw:
        base = Path(raw)
        wiki = _wiki_with_sidecar(base, _valid_doc(concept_pages=37))
        try:
            collect_import_files(wiki)
        except OKFPackageError as error:
            assert "concept_pages 37 does not match" in str(error)
        else:
            raise AssertionError("packager accepted a sidecar that lies about page count")


def test_packager_rejects_malformed_sidecar_json() -> None:
    with tempfile.TemporaryDirectory() as raw:
        base = Path(raw)
        wiki = _wiki_with_sidecar(base, "{not json")
        try:
            collect_import_files(wiki)
        except OKFPackageError as error:
            assert "invalid JSON" in str(error)
        else:
            raise AssertionError("packager accepted malformed attestation JSON")


def test_packager_without_sidecar_is_unchanged() -> None:
    with tempfile.TemporaryDirectory() as raw:
        wiki = Path(raw) / "wiki"
        _write(wiki, "index.md", INDEX)
        _write(wiki, "topics/a.md", PAGE)
        assert [rel for rel, _ in collect_import_files(wiki)] == ["index.md", "topics/a.md"]


def test_conformance_fixture_matches_go_importer() -> None:
    raw = CONFORMANCE_PATH.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == CONFORMANCE_SHA256, (
        "conformance fixture drifted — update BOTH repo copies and BOTH sha pins together")
    fixture = json.loads(raw)
    bundle = fixture["bundle"]
    assert fixture["cases"], "conformance fixture has no cases"
    for case in fixture["cases"]:
        violations = okf_attestation.attestation_violations(
            case["attestation"],
            concept_pages=bundle["concept_pages"],
            payload_sha256=bundle["payload_manifest_sha256"],
        )
        if case["expect"] == "reject":
            assert violations, case["name"]
        else:
            assert violations == [], (case["name"], violations)
            assert okf_attestation.classify_tier(case["attestation"]) == case["expect"], case["name"]


if __name__ == "__main__":
    test_valid_attestation_passes_and_classifies_self_attested()
    test_honest_failure_classifies_unattested()
    test_open_coverage_classifies_unattested()
    test_lying_receipts_are_violations()
    test_build_attestation_refuses_invalid_input()
    test_packager_ships_valid_sidecar_and_keeps_determinism()
    test_packager_rejects_replayed_receipts_after_content_edit()
    test_packager_rejects_lying_page_count_before_upload()
    test_packager_rejects_malformed_sidecar_json()
    test_packager_without_sidecar_is_unchanged()
    test_conformance_fixture_matches_go_importer()
    print("OK  compiler attestation sidecar validation + packaging gate + conformance")
