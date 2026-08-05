"""Contract tests for standalone OKF import packaging."""

import hashlib
import json
import os
import tarfile
import tempfile
from pathlib import Path

from okf_package import OKFPackageError, collect_import_files, write_import_archive


INDEX = '---\nokf_version: "0.2"\n---\n\n# Contents\n'
PAGE = """---
type: Topic
verified:
  - by: human:reviewer
    at: 2026-08-05T10:00:00Z
---

An imported page may retain an external human verification record.
"""


def _write(root: Path, rel: str, body: str) -> None:
    target = root / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(body, encoding="utf-8")


def test_deterministic_archive() -> None:
    with tempfile.TemporaryDirectory() as raw:
        base = Path(raw)
        wiki = base / "wiki"
        _write(wiki, "index.md", INDEX)
        _write(wiki, "topics/network.md", PAGE)
        _write(wiki, "metadata.json", json.dumps({"vendor": "kept"}))
        first = write_import_archive(wiki, base / "first.tar.gz")
        second = write_import_archive(wiki, base / "second.tar.gz")
        assert first["sha256"] == second["sha256"]
        assert hashlib.sha256((base / "first.tar.gz").read_bytes()).hexdigest() == first["sha256"]
        with tarfile.open(base / "first.tar.gz", "r:gz") as archive:
            members = archive.getmembers()
            assert [member.name for member in members] == [
                "index.md", "metadata.json", "topics/network.md",
            ]
            assert all(member.mtime == member.uid == member.gid == 0 for member in members)
            assert archive.extractfile("metadata.json").read() == b'{"vendor": "kept"}'


def test_import_profile_preserves_external_okf_semantics() -> None:
    with tempfile.TemporaryDirectory() as raw:
        wiki = Path(raw)
        _write(wiki, "index.md", INDEX + "- [[Topic]]\n")
        _write(wiki, "topic.md", PAGE + "\n[Bundle root](/index.md)\n")
        assert [rel for rel, _ in collect_import_files(wiki)] == ["index.md", "topic.md"]


def test_invalid_okf_never_writes_output() -> None:
    with tempfile.TemporaryDirectory() as raw:
        base = Path(raw)
        wiki = base / "wiki"
        _write(wiki, "index.md", "# Missing explicit version")
        _write(wiki, "topic.md", "---\ntype: []\n---\nBad")
        output = base / "bad.tar.gz"
        try:
            write_import_archive(wiki, output)
        except OKFPackageError as error:
            assert "not importable OKF v0.2" in str(error)
        else:
            raise AssertionError("invalid OKF package was accepted")
        assert not output.exists()


def test_symlinks_are_rejected() -> None:
    if not hasattr(os, "symlink"):
        return
    with tempfile.TemporaryDirectory() as raw:
        base = Path(raw)
        wiki = base / "wiki"
        _write(wiki, "index.md", INDEX)
        outside = base / "outside.md"
        outside.write_text(PAGE, encoding="utf-8")
        os.symlink(outside, wiki / "leak.md")
        try:
            collect_import_files(wiki)
        except OKFPackageError as error:
            assert "Symbolic links" in str(error)
        else:
            raise AssertionError("symlinked content was accepted")


def test_hardlinks_are_rejected() -> None:
    if not hasattr(os, "link"):
        return
    with tempfile.TemporaryDirectory() as raw:
        base = Path(raw)
        wiki = base / "wiki"
        _write(wiki, "index.md", INDEX)
        outside = base / "outside.json"
        outside.write_bytes(b'{"secret":"outside"}')
        os.link(outside, wiki / "leak.json")
        try:
            collect_import_files(wiki)
        except OKFPackageError as error:
            assert "Hard links" in str(error)
        else:
            raise AssertionError("hard-linked content outside the Wiki was accepted")


def test_unsafe_archive_names_are_rejected() -> None:
    with tempfile.TemporaryDirectory() as raw:
        wiki = Path(raw)
        _write(wiki, "index.md", INDEX)
        _write(wiki, "unsafe\\name.json", "{}")
        try:
            collect_import_files(wiki)
        except OKFPackageError as error:
            assert "Unsafe knowledge file name" in str(error)
        else:
            raise AssertionError("cross-platform unsafe archive name was accepted")


def test_import_rejects_non_rfc3339_verification_times() -> None:
    for value in ('"2026-08-04"', '"2026-08-04T10:00:00"'):
        with tempfile.TemporaryDirectory() as raw:
            wiki = Path(raw)
            _write(wiki, "index.md", INDEX)
            _write(
                wiki,
                "topic.md",
                "---\ntype: Topic\nverified:\n  by: human:reviewer\n"
                f"  at: {value}\n---\nBody\n",
            )
            try:
                collect_import_files(wiki)
            except OKFPackageError as error:
                assert "verified" in str(error), error
            else:
                raise AssertionError(f"non-RFC3339 verified.at was accepted: {value}")


if __name__ == "__main__":
    test_deterministic_archive()
    test_import_profile_preserves_external_okf_semantics()
    test_invalid_okf_never_writes_output()
    test_symlinks_are_rejected()
    test_hardlinks_are_rejected()
    test_unsafe_archive_names_are_rejected()
    test_import_rejects_non_rfc3339_verification_times()
    print("OK  standalone OKF package validation + deterministic archive")
