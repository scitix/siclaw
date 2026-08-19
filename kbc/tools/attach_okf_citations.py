#!/usr/bin/env python3
"""Migrate a standalone OKF v0.2 archive to server-validated citations.

The source map is explicit input from a trusted Feishu inventory. This tool
never discovers URLs from Markdown bodies and never invents a URL from a title.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath

import yaml

POD_DIR = Path(__file__).resolve().parents[1] / "platform" / "pod"
sys.path.insert(0, str(POD_DIR))

from okf_package import OKFPackageError, write_import_archive  # noqa: E402

CITATION_SIDECAR = ".okf-citations.json"


class CitationMigrationError(ValueError):
    """The package or source map cannot produce a safe cited OKF archive."""


def _safe_archive_path(name: str) -> PurePosixPath:
    path = PurePosixPath(name)
    if (
        not name
        or "\\" in name
        or path.is_absolute()
        or any(part in ("", ".", "..") for part in path.parts)
    ):
        raise CitationMigrationError(f"unsafe archive path: {name!r}")
    return path


def extract_package(archive_path: Path, destination: Path) -> None:
    with tarfile.open(archive_path, "r:gz") as archive:
        for member in archive.getmembers():
            rel = _safe_archive_path(member.name)
            if member.isdir():
                continue
            if not member.isfile():
                raise CitationMigrationError(f"unsupported archive entry: {member.name}")
            stream = archive.extractfile(member)
            if stream is None:
                raise CitationMigrationError(f"cannot read archive entry: {member.name}")
            target = destination.joinpath(*rel.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(stream.read())


def _frontmatter(body: str) -> tuple[dict, int, int] | None:
    lines = body.splitlines(keepends=True)
    if not lines or lines[0].strip() != "---":
        return None
    for index in range(1, len(lines)):
        if lines[index].strip() in ("---", "..."):
            raw = "".join(lines[1:index])
            parsed = yaml.safe_load(raw)
            if not isinstance(parsed, dict):
                raise CitationMigrationError("frontmatter must be a mapping")
            return parsed, index, len(lines)
    raise CitationMigrationError("frontmatter is not closed")


def _resource_rows(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    resources: list[str] = []
    for row in value:
        if isinstance(row, str) and row.strip():
            resources.append(row.strip())
        elif isinstance(row, dict) and isinstance(row.get("resource"), str) and row["resource"].strip():
            resources.append(row["resource"].strip())
    return resources


def migrate_page(path: Path) -> tuple[bool, list[str]]:
    body = path.read_text(encoding="utf-8")
    parsed = _frontmatter(body)
    if parsed is None:
        return False, []
    frontmatter, delimiter_index, _ = parsed
    existing = _resource_rows(frontmatter.get("sources"))
    if existing:
        return False, existing
    compiled = _resource_rows(frontmatter.get("compiled_from"))
    if not compiled:
        return False, []

    lines = body.splitlines(keepends=True)
    insertion = 1
    for index in range(1, delimiter_index):
        if lines[index].startswith("compiled_from:"):
            insertion = index
            break
    source_lines = ["sources:\n"] + [
        f"  - resource: {json.dumps(resource, ensure_ascii=False)}\n" for resource in compiled
    ]
    lines[insertion:insertion] = source_lines
    path.write_text("".join(lines), encoding="utf-8")
    return True, compiled


def load_source_map(path: Path) -> dict[str, dict]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise CitationMigrationError(f"source map is unreadable: {error}") from error
    if payload.get("schema_version") != 1 or not isinstance(payload.get("sources"), list):
        raise CitationMigrationError("source map must contain schema_version 1 and a sources array")
    out: dict[str, dict] = {}
    for index, row in enumerate(payload["sources"]):
        if not isinstance(row, dict):
            raise CitationMigrationError(f"source map row {index} must be an object")
        resource = row.get("resource")
        if not isinstance(resource, str) or not resource.strip():
            raise CitationMigrationError(f"source map row {index} has no resource")
        resource = resource.removeprefix("raw/").strip()
        canonical = {
            "resource": resource,
            "title": row.get("title") or resource,
            "origin_type": row.get("origin_type"),
            "origin_url": row.get("origin_url"),
        }
        previous = out.get(resource)
        if previous is not None and previous != canonical:
            raise CitationMigrationError(f"conflicting source map rows for {resource!r}")
        out[resource] = canonical
    return out


def migrate_package(
    package_path: Path,
    source_map_path: Path,
    output_path: Path,
    wiki_output: Path | None = None,
) -> dict:
    source_map = load_source_map(source_map_path)
    with tempfile.TemporaryDirectory(prefix="okf-citation-migrate-") as raw:
        wiki = Path(raw) / "wiki"
        wiki.mkdir()
        extract_package(package_path, wiki)
        (wiki / CITATION_SIDECAR).unlink(missing_ok=True)

        referenced: set[str] = set()
        migrated_pages = 0
        for page in sorted(wiki.rglob("*.md")):
            if page.name in ("index.md", "log.md"):
                continue
            changed, resources = migrate_page(page)
            migrated_pages += int(changed)
            referenced.update(resource.removeprefix("raw/") for resource in resources)

        cited = [source_map[resource] for resource in sorted(referenced) if resource in source_map]
        missing = sorted(referenced - source_map.keys())
        sidecar = {"schema_version": 1, "sources": cited}
        (wiki / CITATION_SIDECAR).write_text(
            json.dumps(sidecar, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        receipt = write_import_archive(wiki, output_path, overwrite=True)
        if wiki_output is not None:
            if wiki_output.exists():
                raise CitationMigrationError(f"wiki output already exists: {wiki_output}")
            shutil.copytree(wiki, wiki_output)
        return {
            **receipt,
            "migrated_pages": migrated_pages,
            "source_resources": len(referenced),
            "citation_sources": len(cited),
            "unmapped_resources": missing,
        }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", required=True, type=Path, help="Input OKF v0.2 .tar.gz")
    parser.add_argument("--source-map", required=True, type=Path, help="Trusted Feishu resource map JSON")
    parser.add_argument("--out", required=True, type=Path, help="Output cited .tar.gz")
    parser.add_argument("--wiki-out", type=Path, help="Optional directory for the migrated Wiki")
    args = parser.parse_args()
    try:
        receipt = migrate_package(args.package, args.source_map, args.out, args.wiki_out)
    except (CitationMigrationError, OKFPackageError, OSError, tarfile.TarError, yaml.YAMLError) as error:
        parser.exit(2, f"attach_okf_citations: {error}\n")
    print(json.dumps(receipt, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
