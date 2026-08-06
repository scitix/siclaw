#!/usr/bin/env python3
"""Package an already-compiled OKF Wiki for Siclaw's direct import flow."""

import argparse
import json
import sys
from pathlib import Path

POD_DIR = Path(__file__).resolve().parents[1] / "platform" / "pod"
sys.path.insert(0, str(POD_DIR))

from okf_package import OKFPackageError, write_import_archive  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate and package a clean OKF v0.2 Wiki without running an authoring agent",
    )
    parser.add_argument("--wiki", required=True, help="Root directory containing index.md")
    parser.add_argument("--out", required=True, help="Destination .tar.gz path")
    parser.add_argument("--force", action="store_true", help="Replace an existing destination")
    args = parser.parse_args()
    try:
        receipt = write_import_archive(args.wiki, args.out, overwrite=args.force)
    except (OKFPackageError, OSError) as error:
        parser.exit(2, f"package_okf: {error}\n")
    print(json.dumps(receipt, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
