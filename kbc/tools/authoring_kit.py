#!/usr/bin/env python3
"""Export compiler checker code and reading standards for local KB authoring.

The destination may already contain a platform workspace's baseline files. Every
kit file is created exclusively; existing checker/standards files are preserved.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
POD = REPO / "kbc/platform/pod"


def export_kit(destination: Path, locale="en") -> dict:
    if locale not in {"en", "zh"}:
        raise ValueError("locale must be en or zh")
    sources = {
        "checker/selfcheck.py": POD / "selfcheck.py",
        "checker/source_kinds.py": POD / "source_kinds.py",
        "checker/prompts/zh/test_role.md": POD / "prompts/zh/test_role.md",
        "standards/playbook.md": POD / f"prompts/{locale}/playbook.md",
        "standards/compiler-role.md": POD / f"prompts/{locale}/box_role.md",
        "standards/consumer-role.md": POD / f"prompts/{locale}/test_role.md",
        "standards/constitution.md": REPO / "kbc/constitution.md",
        "standards/okf-evidence-citations.md": REPO / "docs/design/okf-evidence-citations.md",
    }
    bodies = {rel: source.read_bytes() for rel, source in sources.items()}
    # Preserve the authoritative consumer role too. Only its workspace path
    # changes in the local adaptation, which is hashed independently.
    bodies["standards/local-consumer-role.md"] = bodies["standards/consumer-role.md"].replace(
        b".siclaw/knowledge/", b"candidate/")
    manifest = {"format": 1, "locale": locale, "okf_version": "0.2",
                "files": {rel: hashlib.sha256(body).hexdigest() for rel, body in bodies.items()}}
    bodies["kit-manifest.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
    # Preflight all destinations so an existing kit is not partially updated.
    for rel in bodies:
        target = destination
        if target.is_symlink():
            raise ValueError("Kit destination must not be a symlink")
        for part in Path(rel).parts:
            target /= part
            if target.is_symlink():
                raise ValueError(f"Kit path must not be a symlink: {rel}")
        if target.exists():
            raise FileExistsError(f"Kit file already exists: {rel}")
    for rel, body in bodies.items():
        target = destination / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as output:
            output.write(body)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--locale", choices=("en", "zh"), default="en")
    args = parser.parse_args()
    print(json.dumps(export_kit(args.destination, args.locale), indent=2))


if __name__ == "__main__":
    main()
