"""Engine-neutral, read-only inspection over one frozen KBC Raw snapshot."""

from __future__ import annotations

import fnmatch
import json
from functools import lru_cache
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
MAX_SEARCH_FILES = 2_000
MAX_SEARCH_BYTES = 32 * 1024 * 1024


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
        path_parts = path.split("/")
        pattern_parts = pattern.split("/")

        @lru_cache(maxsize=None)
        def segment_match(pattern_index: int, path_index: int) -> bool:
            if pattern_index == len(pattern_parts):
                return path_index == len(path_parts)
            segment = pattern_parts[pattern_index]
            if segment == "**":
                return any(
                    segment_match(pattern_index + 1, next_path_index)
                    for next_path_index in range(path_index, len(path_parts) + 1)
                )
            return (
                path_index < len(path_parts)
                and fnmatch.fnmatchcase(path_parts[path_index], segment)
                and segment_match(pattern_index + 1, path_index + 1)
            )

        return segment_match(0, 0)

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
        if not is_managed_source_path(rel):
            raise ValueError(f"Raw source is not managed: raw/{rel}")
        if rel in self.denied_sources:
            raise ValueError(f"source is available only through its assigned bounded view: raw/{rel}")
        unresolved = self.raw_root / Path(*PurePosixPath(rel).parts)
        current = self.raw_root
        for part in PurePosixPath(rel).parts:
            current = current / part
            if current.is_symlink():
                raise ValueError(f"Raw source path contains a symbolic link: raw/{rel}")
        try:
            target = unresolved.resolve()
        except (OSError, RuntimeError) as error:
            raise ValueError(f"Raw source cannot be resolved: raw/{rel}") from error
        try:
            canonical_rel = target.relative_to(self.raw_root).as_posix()
        except ValueError as error:
            raise ValueError("source path escapes the Raw snapshot") from error
        if canonical_rel in self.denied_sources:
            raise ValueError(
                f"source is available only through its assigned bounded view: raw/{canonical_rel}")
        if not target.is_file():
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
        selected: list[str] = []
        selected_lines = 0
        selected_chars = 0
        has_more = False
        char_truncated = False
        try:
            with target.open("r", encoding="utf-8", errors="strict", newline=None) as source:
                for line_no, raw_line in enumerate(source, start=1):
                    if line_no < start:
                        continue
                    if selected_lines >= count:
                        has_more = True
                        break
                    line = raw_line.rstrip("\r\n")
                    rendered = f"{line_no:>6}\t{line}"
                    separator = 1 if selected else 0
                    remaining = MAX_READ_CHARS - selected_chars - separator
                    if remaining <= 0:
                        char_truncated = True
                        break
                    if separator:
                        selected.append("\n")
                        selected_chars += 1
                    selected.append(rendered[:remaining])
                    selected_chars += min(len(rendered), remaining)
                    selected_lines += 1
                    if len(rendered) > remaining:
                        char_truncated = True
                        break
        except UnicodeDecodeError as error:
            raise ValueError(f"Raw source is not UTF-8 text: raw/{rel}") from error
        numbered = "".join(selected)
        return json.dumps({
            "path": f"raw/{rel}",
            "offset": start,
            "lines": selected_lines,
            "content": numbered,
            "truncated": char_truncated or has_more,
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
        skipped_non_text = 0
        scanned_files = 0
        scanned_bytes = 0
        budget_exhausted = False
        for rel, path in self._files(glob):
            if not is_text_source_path(rel):
                skipped_non_text += 1
                continue
            size = path.stat().st_size
            if size > MAX_SEARCH_FILE_BYTES:
                skipped_large += 1
                continue
            if scanned_files >= MAX_SEARCH_FILES or scanned_bytes + size > MAX_SEARCH_BYTES:
                budget_exhausted = True
                break
            scanned_files += 1
            scanned_bytes += size
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
                        "skipped_non_text": skipped_non_text,
                        "scanned_files": scanned_files,
                        "scanned_bytes": scanned_bytes,
                        "budget_exhausted": budget_exhausted,
                    }, ensure_ascii=False)
        return json.dumps({
            "matches": matches,
            "returned": len(matches),
            "truncated": budget_exhausted,
            "skipped_large": skipped_large,
            "skipped_non_utf8": skipped_non_utf8,
            "skipped_non_text": skipped_non_text,
            "scanned_files": scanned_files,
            "scanned_bytes": scanned_bytes,
            "budget_exhausted": budget_exhausted,
        }, ensure_ascii=False)
