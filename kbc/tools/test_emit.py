"""Focused provenance tests for the legacy ledger-to-OKF emitter."""

import emit


def test_page_sources_use_explicit_raw_namespace() -> None:
    assert emit._page_sources(
        "One claim (source: docs/a.md). Another (源: drop/data/b.csv)."
    ) == [
        {"resource": "raw/docs/a.md"},
        {"resource": "raw/data/b.csv"},
    ]


if __name__ == "__main__":
    test_page_sources_use_explicit_raw_namespace()
    print("OK  emitter uses explicit managed Raw provenance")
