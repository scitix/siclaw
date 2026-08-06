"""Engine-neutral, read-only inspection over one frozen KBC Raw snapshot."""

from __future__ import annotations

import fnmatch
import json
from pathlib import Path, PurePosixPath

from source_kinds import (
    MEDIA_SOURCE_EXTS,
    is_managed_source_path,
    is_text_source_path,
)


DEFAULT_MAX_RESULTS = 200
MAX_RESULTS = 500
MAX_READ_LINES = 500
MAX_READ_CHARS = 200_000
MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024


def _bounded_int(value: object, default: int, maximum: int) -> int:
    if value is None:
        return default
    if isinstance(value, bool):
        raise ValueError("limit must be an integer")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError("limit must be an integer") from error
    if parsed < 1 or parsed > maximum:
        raise ValueError(f"limit must be between 1 and {maximum}")
    return parsed


class SourceInspector:
    """Bounded Raw inventory/read/search tools shared by every model engine.

    ``denied_sources`` contains originals that a batch may reach only through a
    mechanically bounded slice.  The inspector honors that boundary while
    allowing every other Raw source to be consulted regardless of the batch's
    accountability list.
    """

    def __init__(self, workdir: str | Path, denied_sources: list[str] | None = None):
        self.raw_root = (Path(workdir) / "raw").resolve()
        if not self.raw_root.is_dir():
            raise ValueError("Raw snapshot is not installed")
        self.denied_sources = {
            self._normalize_relative(source) for source in (denied_sources or [])
        }

    @staticmethod
    def _normalize_relative(value: object) -> str:
        if not isinstance(value, str) or not value.strip() or "\x00" in value:
            raise ValueError("source path must be a non-empty string")
        normalized = value.strip().replace("\\", "/")
        if normalized.startswith("raw/"):
            normalized = normalized[4:]
        pure = PurePosixPath(normalized)
        if pure.is_absolute() or not pure.parts or ".." in pure.parts:
            raise ValueError("source path must be Raw-relative without parent traversal")
        return pure.as_posix()

    @staticmethod
    def _pattern(value: object) -> str:
        if value is None:
            return "**/*"
        if not isinstance(value, str) or not value.strip() or "\x00" in value:
            raise ValueError("pattern must be a non-empty relative glob")
        pattern = value.strip().replace("\\", "/")
        pure = PurePosixPath(pattern)
        if pure.is_absolute() or ".." in pure.parts:
            raise ValueError("pattern must be Raw-relative without parent traversal")
        return pattern

    @staticmethod
    def _matches(path: str, pattern: str) -> bool:
        if pattern in {"*", "**", "**/*"}:
            return True
        if fnmatch.fnmatchcase(path, pattern):
            return True
        # Users naturally expect **/*.ts to include root-level app.ts too.
        return pattern.startswith("**/") and fnmatch.fnmatchcase(path, pattern[3:])

    def _files(
        self, pattern: str = "**/*", *, include_denied: bool = False,
    ) -> list[tuple[str, Path]]:
        files: list[tuple[str, Path]] = []
        for path in self.raw_root.rglob("*"):
            if path.is_symlink() or not path.is_file():
                continue
            rel = path.relative_to(self.raw_root).as_posix()
            if not is_managed_source_path(rel):
                continue
            if (rel in self.denied_sources and not include_denied) or not self._matches(rel, pattern):
                continue
            try:
                path.resolve().relative_to(self.raw_root)
            except (OSError, ValueError):
                continue
            files.append((rel, path))
        files.sort(key=lambda item: item[0])
        return files

    def _resolve(self, value: object) -> tuple[str, Path]:
        rel = self._normalize_relative(value)
        if rel in self.denied_sources:
            raise ValueError(f"source is available only through its assigned bounded view: raw/{rel}")
        target = (self.raw_root / Path(*PurePosixPath(rel).parts)).resolve()
        try:
            target.relative_to(self.raw_root)
        except ValueError as error:
            raise ValueError("source path escapes the Raw snapshot") from error
        if target.is_symlink() or not target.is_file():
            raise ValueError(f"Raw source does not exist: raw/{rel}")
        return rel, target

    @staticmethod
    def _kind(rel: str) -> str:
        suffix = PurePosixPath(rel).suffix.casefold()
        if is_text_source_path(rel):
            return "text"
        if suffix in MEDIA_SOURCE_EXTS:
            return "media"
        return "binary"

    def inventory(self, *, pattern: object = None, max_results: object = None) -> str:
        glob = self._pattern(pattern)
        limit = _bounded_int(max_results, DEFAULT_MAX_RESULTS, MAX_RESULTS)
        # Inventory remains complete even for mechanically bounded originals:
        # the compiler must know the source exists, while read/search still
        # enforce that it can only be reached through the assigned slice.
        files = self._files(glob, include_denied=True)
        rows = [{
            "path": f"raw/{rel}",
            "bytes": path.stat().st_size,
            "kind": self._kind(rel),
            "availability": (
                "bounded_view_only" if rel in self.denied_sources else "readable"
            ),
        } for rel, path in files[:limit]]
        return json.dumps({
            "sources": rows,
            "returned": len(rows),
            "truncated": len(files) > limit,
        }, ensure_ascii=False)

    def read(self, *, path: object, offset: object = None, limit: object = None) -> str:
        rel, target = self._resolve(path)
        start = _bounded_int(offset, 1, 2_000_000_000)
        count = _bounded_int(limit, MAX_READ_LINES, MAX_READ_LINES)
        try:
            text = target.read_bytes().decode("utf-8")
        except UnicodeDecodeError as error:
            raise ValueError(f"Raw source is not UTF-8 text: raw/{rel}") from error
        lines = text.splitlines()
        selected = lines[start - 1:start - 1 + count]
        numbered = "\n".join(
            f"{line_no:>6}\t{line}"
            for line_no, line in enumerate(selected, start=start)
        )
        char_truncated = len(numbered) > MAX_READ_CHARS
        numbered = numbered[:MAX_READ_CHARS]
        return json.dumps({
            "path": f"raw/{rel}",
            "offset": start,
            "lines": len(selected),
            "content": numbered,
            "truncated": char_truncated or start - 1 + len(selected) < len(lines),
        }, ensure_ascii=False)

    def search(
        self,
        *,
        query: object,
        pattern: object = None,
        case_sensitive: object = None,
        max_results: object = None,
    ) -> str:
        if not isinstance(query, str) or not query or "\x00" in query:
            raise ValueError("query must be a non-empty literal string")
        if case_sensitive is not None and not isinstance(case_sensitive, bool):
            raise ValueError("case_sensitive must be a boolean")
        sensitive = bool(case_sensitive)
        needle = query if sensitive else query.casefold()
        glob = self._pattern(pattern)
        limit = _bounded_int(max_results, DEFAULT_MAX_RESULTS, MAX_RESULTS)
        matches: list[dict] = []
        skipped_large = 0
        skipped_non_utf8 = 0
        for rel, path in self._files(glob):
            if path.stat().st_size > MAX_SEARCH_FILE_BYTES:
                skipped_large += 1
                continue
            try:
                lines = path.read_bytes().decode("utf-8").splitlines()
            except UnicodeDecodeError:
                skipped_non_utf8 += 1
                continue
            for line_no, line in enumerate(lines, start=1):
                haystack = line if sensitive else line.casefold()
                if needle not in haystack:
                    continue
                matches.append({
                    "path": f"raw/{rel}",
                    "line": line_no,
                    "text": line[:1000],
                })
                if len(matches) >= limit:
                    return json.dumps({
                        "matches": matches,
                        "returned": len(matches),
                        "truncated": True,
                        "skipped_large": skipped_large,
                        "skipped_non_utf8": skipped_non_utf8,
                    }, ensure_ascii=False)
        return json.dumps({
            "matches": matches,
            "returned": len(matches),
            "truncated": False,
            "skipped_large": skipped_large,
            "skipped_non_utf8": skipped_non_utf8,
        }, ensure_ascii=False)
