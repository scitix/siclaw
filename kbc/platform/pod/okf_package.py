"""Validate and deterministically package a standalone OKF Wiki for Siclaw.

This module is filesystem-only. It does not create Raw sources, a Candidate
workspace, or an Agent SDK session; the supplied Wiki directory is already the
compiled artifact.
"""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
import stat
import tarfile
import tempfile
from pathlib import Path
from posixpath import basename

import okf_attestation
import selfcheck

MAX_ARCHIVE_BYTES = 25 * 1024 * 1024
MAX_TOTAL_UNPACKED_BYTES = 100 * 1024 * 1024
MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_FILES = 1000
ALLOWED_SUFFIXES = {".md", ".json"}
MAX_CANDIDATE_PATH_CHARS = 255
ALLOWED_AUTHORING_PATHS = {
    "authoring/EXCLUSIONS.json",
    "authoring/CONTRADICTIONS.json",
}


class OKFPackageError(ValueError):
    """The directory cannot be represented by Siclaw's import contract."""


def _format_violations(violations: list[dict]) -> str:
    details = [
        f"{item.get('page', '?')}: {item.get('detail', item.get('kind', 'invalid OKF'))}"
        for item in violations[:40]
    ]
    if len(violations) > 40:
        details.append(f"... and {len(violations) - 40} more")
    return "; ".join(details)


def _validate_archive_name(rel: str) -> None:
    if "\\" in rel or any(ord(char) < 32 or ord(char) == 127 for char in rel):
        raise OKFPackageError(f"Unsafe knowledge file name: {rel!r}")
    if any(part in ("", ".", "..") for part in rel.split("/")):
        raise OKFPackageError(f"Unsafe knowledge file name: {rel!r}")


def _read_package_file(entry: Path, rel: str, expected: os.stat_result) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(entry, flags)
    except OSError as error:
        raise OKFPackageError(f"Cannot read knowledge file: {rel}") from error
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode):
            raise OKFPackageError(f"Unsupported filesystem entry: {rel}")
        if opened.st_nlink != 1:
            raise OKFPackageError(f"Hard links are not allowed: {rel}")
        if (opened.st_dev, opened.st_ino) != (expected.st_dev, expected.st_ino):
            raise OKFPackageError(f"Knowledge file changed while packaging: {rel}")
        if opened.st_size > MAX_FILE_BYTES:
            raise OKFPackageError(f"Knowledge file is too large: {rel}")
        with os.fdopen(fd, "rb") as stream:
            fd = -1
            data = stream.read(MAX_FILE_BYTES + 1)
        if len(data) > MAX_FILE_BYTES:
            raise OKFPackageError(f"Knowledge file is too large: {rel}")
        if len(data) != opened.st_size:
            raise OKFPackageError(f"Knowledge file changed while packaging: {rel}")
        return data
    finally:
        if fd >= 0:
            os.close(fd)


def collect_import_files(wiki_dir: str | Path) -> list[tuple[str, bytes]]:
    """Return sorted package files after import-contract and safety checks."""
    root = Path(wiki_dir).expanduser()
    try:
        root = root.resolve(strict=True)
    except OSError as error:
        raise OKFPackageError(f"Wiki directory does not exist: {root}") from error
    if not root.is_dir():
        raise OKFPackageError(f"Wiki path is not a directory: {root}")

    files: list[tuple[str, bytes]] = []
    markdown_pages: dict[str, dict] = {}
    total_bytes = 0
    for entry in sorted(root.rglob("*"), key=lambda item: item.relative_to(root).as_posix()):
        rel = entry.relative_to(root).as_posix()
        try:
            metadata = entry.lstat()
        except OSError as error:
            raise OKFPackageError(f"Cannot inspect knowledge file: {rel}") from error
        if stat.S_ISLNK(metadata.st_mode):
            raise OKFPackageError(f"Symbolic links are not allowed: {rel}")
        if stat.S_ISDIR(metadata.st_mode):
            continue
        if not stat.S_ISREG(metadata.st_mode):
            raise OKFPackageError(f"Unsupported filesystem entry: {rel}")
        _validate_archive_name(rel)
        if entry.suffix.lower() not in ALLOWED_SUFFIXES:
            raise OKFPackageError(f"Unsupported knowledge file type: {rel}")
        if len(files) >= MAX_FILES:
            raise OKFPackageError("Knowledge package has too many files")
        if metadata.st_nlink != 1:
            raise OKFPackageError(f"Hard links are not allowed: {rel}")
        if metadata.st_size > MAX_FILE_BYTES:
            raise OKFPackageError(f"Knowledge file is too large: {rel}")
        if total_bytes + metadata.st_size > MAX_TOTAL_UNPACKED_BYTES:
            raise OKFPackageError("Knowledge package unpacked size is too large")
        data = _read_package_file(entry, rel, metadata)
        total_bytes += len(data)
        if total_bytes > MAX_TOTAL_UNPACKED_BYTES:
            raise OKFPackageError("Knowledge package unpacked size is too large")
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError as error:
            raise OKFPackageError(f"Knowledge file is not UTF-8 text: {rel}") from error
        if rel.startswith("authoring/"):
            if rel not in ALLOWED_AUTHORING_PATHS:
                raise OKFPackageError(
                    "Knowledge package accepts only authoring/EXCLUSIONS.json and "
                    f"authoring/CONTRADICTIONS.json under authoring/, not: {rel}"
                )
        elif len("candidate/" + rel) > MAX_CANDIDATE_PATH_CHARS:
            raise OKFPackageError(f"Knowledge package path is too long for Candidate: {rel}")
        files.append((rel, data))
        if entry.suffix.lower() == ".md":
            markdown_pages[rel] = {"text": text, "bytes": len(data)}

    if not files:
        raise OKFPackageError("Knowledge package has no files")
    if "index.md" not in markdown_pages:
        raise OKFPackageError("Knowledge package must contain index.md at the Wiki root")
    violations = selfcheck.okf_import_violations(markdown_pages)
    if violations:
        raise OKFPackageError("Wiki is not importable OKF v0.2: " + _format_violations(violations))
    _validate_attestation_sidecar(files, markdown_pages)
    return files


def _validate_attestation_sidecar(files: list[tuple[str, bytes]], markdown_pages: dict[str, dict]) -> None:
    """A lying compiler receipt must fail at packaging, not at the importer."""
    sidecar = next(
        (data for rel, data in files if rel == okf_attestation.ATTESTATION_SIDECAR), None,
    )
    if sidecar is None:
        return
    # Mirrors the importer's concept-page definition: every .md except the
    # reserved index/log pages (sicore isOKFReservedPath).
    concept_pages = sum(
        1 for rel in markdown_pages if basename(rel) not in ("index.md", "log.md")
    )
    try:
        doc = okf_attestation.parse_attestation(sidecar)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise OKFPackageError(f"{okf_attestation.ATTESTATION_SIDECAR} is invalid JSON: {error}") from error
    violations = okf_attestation.attestation_violations(
        doc,
        concept_pages=concept_pages,
        payload_sha256=okf_attestation.payload_manifest_sha256(files),
    )
    if violations:
        raise OKFPackageError(
            f"{okf_attestation.ATTESTATION_SIDECAR} would be rejected by the importer: "
            + "; ".join(item["detail"] for item in violations[:10])
        )


def write_import_archive(
    wiki_dir: str | Path,
    output: str | Path,
    *,
    overwrite: bool = False,
) -> dict:
    """Write a deterministic tar.gz and return its immutable receipt."""
    root = Path(wiki_dir).expanduser().resolve(strict=True)
    destination = Path(output).expanduser().absolute()
    try:
        destination.resolve(strict=False).relative_to(root)
    except ValueError:
        pass
    else:
        raise OKFPackageError("Output archive must be outside the Wiki directory")
    if destination.exists() and not overwrite:
        raise OKFPackageError(f"Output already exists: {destination}")

    files = collect_import_files(root)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent, delete=False,
        ) as raw:
            temp_path = Path(raw.name)
            with gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=9, mtime=0) as gz:
                with tarfile.open(fileobj=gz, mode="w", format=tarfile.PAX_FORMAT) as archive:
                    for rel, data in files:
                        info = tarfile.TarInfo(rel)
                        info.size = len(data)
                        info.mode = 0o644
                        info.mtime = 0
                        info.uid = 0
                        info.gid = 0
                        info.uname = ""
                        info.gname = ""
                        archive.addfile(info, io.BytesIO(data))
        archive_bytes = temp_path.read_bytes()
        if len(archive_bytes) > MAX_ARCHIVE_BYTES:
            raise OKFPackageError("Compressed knowledge package is too large")
        os.replace(temp_path, destination)
        temp_path = None
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)

    return {
        "path": str(destination),
        "sha256": hashlib.sha256(archive_bytes).hexdigest(),
        "size_bytes": len(archive_bytes),
        "file_count": len(files),
        "okf_version": "0.2",
    }
