#!/usr/bin/env python3
"""Command-mode entrypoint for the Siclaw PaddleOCR backend.

It reads one JSON request from stdin and prints one JSON response to stdout.
"""

from __future__ import annotations

import json
import sys
import traceback

from server import parse_request


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read())
        result = parse_request(payload)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001 - command mode returns JSON errors.
        print(
            json.dumps(
                {
                    "error": str(exc),
                    "warnings": ["Siclaw OCR command backend failed."],
                    "trace": traceback.format_exc().splitlines()[-8:],
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
