"""Build and validate the .okf-attestation.json compiler-receipt sidecar.

The sidecar makes compile-time verification receipts travel with the bundle:
producer identity, the frozen input revision, the coverage ledger's summary,
and named deterministic check results. The import side (sicore
internal/siclaw/knowledge/okf_attestation.go) classifies bundles into
"attested"/"unattested" from it and rejects receipts that contradict the
bundle — this module mirrors that validation so a lying sidecar fails at
packaging time, before an upload ever happens.

Attestation is written by deterministic code about deterministic checks.
The compile agent never authors it, for the same reason it may not write
`verified`: a self-signed receipt is not a receipt.

Pure stdlib on purpose, like selfcheck.
"""

from __future__ import annotations

import json
import re

ATTESTATION_SIDECAR = ".okf-attestation.json"
ATTESTATION_SCHEMA_VERSION = 1
MAX_ATTESTATION_CHECKS = 32

TIER_UNATTESTED = "unattested"
TIER_ATTESTED = "attested"

_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_REVISION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$")
_CHECK_STATUSES = ("pass", "warn", "fail")
_COVERAGE_FIELDS = ("cited", "excluded", "auto_attached", "derived", "unaccounted", "dangling")
_ALLOWED_KEYS = {
    "schema_version", "producer", "input_revision", "concept_pages",
    "coverage", "checks", "signature",
}


def _violation(kind: str, detail: str) -> dict:
    return {"kind": kind, "detail": detail}


def attestation_violations(doc: object, *, concept_pages: int) -> list[dict]:
    """Mirror the importer's checks; [] means the sidecar would be accepted."""
    if not isinstance(doc, dict):
        return [_violation("attestation_shape", "attestation must be a JSON object")]
    violations: list[dict] = []

    unknown = sorted(set(doc) - _ALLOWED_KEYS)
    if unknown:
        violations.append(_violation("attestation_unknown_field", f"unknown fields: {', '.join(unknown)}"))
    if doc.get("schema_version") != ATTESTATION_SCHEMA_VERSION:
        violations.append(_violation(
            "attestation_schema_version",
            f"must declare schema_version {ATTESTATION_SCHEMA_VERSION}"))
    if "signature" in doc and doc["signature"] is not None:
        violations.append(_violation(
            "attestation_signature",
            "signatures are not supported yet; omit signature or set it to null"))

    producer = doc.get("producer")
    if not isinstance(producer, dict) or set(producer) - {"name", "version"}:
        violations.append(_violation("attestation_producer", "producer must be {name[, version]}"))
    else:
        name = producer.get("name")
        if not isinstance(name, str) or not _NAME_RE.match(name.strip()):
            violations.append(_violation(
                "attestation_producer", f"producer.name must match {_NAME_RE.pattern}"))
        version = producer.get("version")
        if version is not None and (not isinstance(version, str) or len(version) > 64):
            violations.append(_violation(
                "attestation_producer", "producer.version must be a string of at most 64 characters"))

    revision = doc.get("input_revision")
    if revision is not None and (not isinstance(revision, str) or not _REVISION_RE.match(revision.strip())):
        violations.append(_violation(
            "attestation_input_revision", f"input_revision must match {_REVISION_RE.pattern}"))

    declared_pages = doc.get("concept_pages")
    if not isinstance(declared_pages, int) or isinstance(declared_pages, bool):
        violations.append(_violation("attestation_concept_pages", "concept_pages must be an integer"))
    elif declared_pages != concept_pages:
        violations.append(_violation(
            "attestation_concept_pages",
            f"concept_pages {declared_pages} does not match the bundle's {concept_pages} concept pages"))

    checks = doc.get("checks")
    if not isinstance(checks, list) or not 1 <= len(checks) <= MAX_ATTESTATION_CHECKS:
        violations.append(_violation(
            "attestation_checks", f"must declare 1-{MAX_ATTESTATION_CHECKS} checks"))
    else:
        seen: set[str] = set()
        for index, check in enumerate(checks):
            if not isinstance(check, dict) or set(check) - {"name", "status", "detail"}:
                violations.append(_violation(
                    "attestation_checks", f"checks[{index}] must be {{name, status[, detail]}}"))
                continue
            name = check.get("name")
            if not isinstance(name, str) or not _NAME_RE.match(name.strip()):
                violations.append(_violation(
                    "attestation_checks", f"checks[{index}].name must match {_NAME_RE.pattern}"))
            elif name.strip() in seen:
                violations.append(_violation(
                    "attestation_checks", f"checks[{index}] duplicates check {name.strip()!r}"))
            else:
                seen.add(name.strip())
            if check.get("status") not in _CHECK_STATUSES:
                violations.append(_violation(
                    "attestation_checks", f"checks[{index}].status must be pass, warn, or fail"))
            detail = check.get("detail")
            if detail is not None and (not isinstance(detail, str) or len(detail) > 500):
                violations.append(_violation(
                    "attestation_checks", f"checks[{index}].detail must be at most 500 characters"))

    coverage = doc.get("coverage")
    if coverage is not None:
        if not isinstance(coverage, dict) or set(coverage) - ({"closed"} | set(_COVERAGE_FIELDS)):
            violations.append(_violation(
                "attestation_coverage", "coverage must be {closed, cited, excluded, auto_attached, derived, unaccounted, dangling}"))
        else:
            counters_ok = True
            for field in _COVERAGE_FIELDS:
                count = coverage.get(field)
                if not isinstance(count, int) or isinstance(count, bool) or not 0 <= count <= 1_000_000:
                    violations.append(_violation(
                        "attestation_coverage", f"coverage.{field} must be between 0 and 1000000"))
                    counters_ok = False
            closed = coverage.get("closed")
            if not isinstance(closed, bool):
                violations.append(_violation("attestation_coverage", "coverage.closed must be a boolean"))
            elif counters_ok and closed != (
                coverage.get("unaccounted") == 0 and coverage.get("dangling") == 0
            ):
                # The headline claim and its own arithmetic must agree, or the
                # attestation is lying to one audience.
                violations.append(_violation(
                    "attestation_coverage", "coverage.closed contradicts its own counters"))

    return violations


def classify_tier(doc: dict) -> str:
    """Tier for a doc that already passed attestation_violations."""
    failing = any(check.get("status") == "fail" for check in doc.get("checks", []))
    coverage = doc.get("coverage")
    coverage_closed = coverage is None or bool(coverage.get("closed"))
    if not failing and coverage_closed:
        return TIER_ATTESTED
    return TIER_UNATTESTED


def build_attestation(
    *,
    producer_name: str,
    concept_pages: int,
    checks: list[dict],
    producer_version: str | None = None,
    coverage: dict | None = None,
    input_revision: str | None = None,
) -> dict:
    """Return a canonical attestation dict, refusing to build an invalid one."""
    producer: dict = {"name": producer_name}
    if producer_version is not None:
        producer["version"] = producer_version
    doc: dict = {
        "schema_version": ATTESTATION_SCHEMA_VERSION,
        "producer": producer,
        "concept_pages": concept_pages,
        "checks": checks,
        "signature": None,
    }
    if input_revision is not None:
        doc["input_revision"] = input_revision
    if coverage is not None:
        doc["coverage"] = coverage
    violations = attestation_violations(doc, concept_pages=concept_pages)
    if violations:
        raise ValueError(
            "refusing to build an invalid attestation: "
            + "; ".join(item["detail"] for item in violations)
        )
    return doc


def parse_attestation(body: bytes | str) -> object:
    """Parse sidecar bytes; a non-object result is reported by validation."""
    if isinstance(body, bytes):
        body = body.decode("utf-8")
    return json.loads(body)


def render_attestation(doc: dict) -> str:
    return json.dumps(doc, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
