#!/usr/bin/env python3
"""Attach a compiler attestation sidecar to a standalone OKF v0.2 Wiki.

Check results are explicit input from the deterministic tools that ran them
(publish gate, lint, selfcheck) — this tool records receipts, it never invents
them. The compile agent must not author the attestation for the same reason it
may not write `verified`: a self-signed receipt is not a receipt.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from posixpath import basename

POD_DIR = Path(__file__).resolve().parents[1] / "platform" / "pod"
sys.path.insert(0, str(POD_DIR))

import okf_attestation  # noqa: E402
from okf_package import OKFPackageError, write_import_archive  # noqa: E402


class AttestationError(ValueError):
    """The wiki or check input cannot produce a valid attested archive."""


def load_checks(path: Path) -> list[dict]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise AttestationError(f"checks file is unreadable: {error}") from error
    if not isinstance(payload, list):
        raise AttestationError("checks file must contain a JSON array of {name, status[, detail]}")
    return payload


def load_coverage(path: Path) -> dict:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise AttestationError(f"coverage file is unreadable: {error}") from error
    if not isinstance(payload, dict):
        raise AttestationError("coverage file must contain a JSON object")
    return payload


def count_concept_pages(wiki: Path) -> int:
    return sum(
        1
        for page in wiki.rglob("*.md")
        if basename(page.relative_to(wiki).as_posix()) not in ("index.md", "log.md")
    )


def attach_attestation(
    wiki: Path,
    output_path: Path,
    *,
    producer: str,
    producer_version: str | None,
    checks_path: Path,
    coverage_path: Path | None,
    input_revision: str | None,
) -> dict:
    if not wiki.is_dir():
        raise AttestationError(f"wiki directory does not exist: {wiki}")
    coverage = load_coverage(coverage_path) if coverage_path is not None else None
    try:
        doc = okf_attestation.build_attestation(
            producer_name=producer,
            producer_version=producer_version,
            concept_pages=count_concept_pages(wiki),
            checks=load_checks(checks_path),
            coverage=coverage,
            input_revision=input_revision,
        )
    except ValueError as error:
        raise AttestationError(str(error)) from error
    sidecar = wiki / okf_attestation.ATTESTATION_SIDECAR
    sidecar.write_text(okf_attestation.render_attestation(doc), encoding="utf-8")
    receipt = write_import_archive(wiki, output_path, overwrite=True)
    return {**receipt, "attestation_tier": okf_attestation.classify_tier(doc)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wiki", required=True, type=Path, help="Compiled OKF v0.2 Wiki directory")
    parser.add_argument("--out", required=True, type=Path, help="Output attested .tar.gz")
    parser.add_argument("--producer", required=True, help="Compiler identity, e.g. siclaw-kbc")
    parser.add_argument("--producer-version", help="Compiler version string")
    parser.add_argument(
        "--checks", required=True, type=Path,
        help="JSON array of deterministic check results: [{name, status[, detail]}]",
    )
    parser.add_argument(
        "--coverage", type=Path,
        help="Optional JSON object with the coverage ledger summary "
             "({closed, cited, excluded, auto_attached, derived, unaccounted, dangling})",
    )
    parser.add_argument("--input-revision", help="Frozen source manifest revision the compile ran from")
    args = parser.parse_args()
    try:
        receipt = attach_attestation(
            args.wiki,
            args.out,
            producer=args.producer,
            producer_version=args.producer_version,
            checks_path=args.checks,
            coverage_path=args.coverage,
            input_revision=args.input_revision,
        )
    except (AttestationError, OKFPackageError, OSError) as error:
        parser.exit(2, f"attach_okf_attestation: {error}\n")
    print(json.dumps(receipt, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
