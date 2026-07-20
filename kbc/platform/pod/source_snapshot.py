"""Resumable, verified Source Snapshot v2 installation for the compile box.

Each part is independently staged and survives a container restart. Only a
complete snapshot is assembled and atomically swapped into ``workdir/raw``;
partial or corrupt uploads never become compiler-visible.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shutil
import tarfile
import tempfile
import uuid
from pathlib import Path, PurePosixPath
from typing import Callable


_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_PART_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class SnapshotConflict(ValueError):
    """The requested operation conflicts with persisted snapshot state."""


class SnapshotIncomplete(SnapshotConflict):
    """Commit was requested before every declared part arrived."""


def _positive_env(name: str, default: int) -> int:
    value = int(os.environ.get(name, str(default)))
    if value <= 0:
        raise ValueError(f"{name} must be positive")
    return value


def _safe_path(name: str) -> PurePosixPath:
    if not isinstance(name, str) or not name or "\\" in name:
        raise ValueError(f"unsafe source path {name!r}")
    path = PurePosixPath(name)
    if path.is_absolute():
        raise ValueError(f"unsafe source path {name!r}: path must be relative")
    parts = [part for part in path.parts if part not in ("", ".")]
    if not parts or any(part == ".." for part in parts):
        raise ValueError(f"unsafe source path {name!r}: parent traversal is not allowed")
    return PurePosixPath(*parts)


def _require_sha256(value: object, field: str) -> str:
    normalized = str(value or "").lower()
    if not _SHA256_RE.fullmatch(normalized):
        raise ValueError(f"{field} must be a lowercase SHA-256 hex digest")
    return normalized


def _require_nonnegative_int(value: object, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{field} must be a non-negative integer")
    return value


def canonical_file_manifest(files: list[dict]) -> bytes:
    normalized = sorted(
        ({"path": item["path"], "sha256": item["sha256"], "size_bytes": item["size_bytes"]} for item in files),
        key=lambda item: item["path"],
    )
    # Sicore computes this digest with Go's encoding/json.  Its otherwise
    # compact UTF-8 output escapes the HTML-sensitive code points and the two
    # JavaScript line separators even inside filenames.  Mirror that wire
    # contract explicitly; Python's json encoder leaves these characters raw
    # when ensure_ascii=False, which would make a valid path such as R&D.md
    # reject the whole snapshot with a manifest hash mismatch.
    payload = json.dumps(normalized, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    payload = (
        payload.replace("&", "\\u0026")
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    )
    return payload.encode("utf-8")


def validate_snapshot(snapshot: object) -> dict:
    if not isinstance(snapshot, dict) or snapshot.get("version") != 2:
        raise ValueError("source snapshot version must be 2")
    parts = snapshot.get("parts")
    if not isinstance(parts, list) or not parts:
        raise ValueError("source snapshot must contain at least one part")
    max_parts = _positive_env("KBC_MAX_SOURCE_PARTS", 10_000)
    max_files = _positive_env("KBC_MAX_SOURCE_FILES", 100_000)
    max_part_bytes = _positive_env("KBC_MAX_SOURCE_PART_BYTES", 64 * 1024 * 1024)
    max_part_unpacked = _positive_env("KBC_MAX_SOURCE_PART_UNPACKED_BYTES", 128 * 1024 * 1024)
    max_total_unpacked = _positive_env("KBC_MAX_SOURCE_UNPACKED_BYTES", 2 * 1024 * 1024 * 1024)
    if len(parts) > max_parts:
        raise ValueError(f"source snapshot has too many parts: {len(parts)} > {max_parts}")

    normalized_parts: list[dict] = []
    all_files: list[dict] = []
    seen_parts: set[str] = set()
    seen_paths: set[str] = set()
    for index, raw_part in enumerate(parts):
        if not isinstance(raw_part, dict):
            raise ValueError(f"source snapshot part {index} must be an object")
        part_id = str(raw_part.get("part_id") or "")
        if not _PART_ID_RE.fullmatch(part_id):
            raise ValueError(f"invalid source snapshot part_id {part_id!r}")
        if part_id in seen_parts:
            raise ValueError(f"duplicate source snapshot part_id {part_id}")
        seen_parts.add(part_id)
        bundle_size = _require_nonnegative_int(raw_part.get("bundle_size_bytes"), f"part {part_id} bundle_size_bytes")
        unpacked_size = _require_nonnegative_int(raw_part.get("unpacked_size_bytes"), f"part {part_id} unpacked_size_bytes")
        file_count = _require_nonnegative_int(raw_part.get("file_count"), f"part {part_id} file_count")
        if bundle_size == 0 or bundle_size > max_part_bytes:
            raise ValueError(f"source part {part_id} compressed size is outside 1..{max_part_bytes}")
        if unpacked_size > max_part_unpacked:
            raise ValueError(f"source part {part_id} unpacks too large: {unpacked_size} > {max_part_unpacked}")
        raw_files = raw_part.get("files")
        if not isinstance(raw_files, list) or not raw_files:
            raise ValueError(f"source part {part_id} must declare files")
        normalized_files: list[dict] = []
        for raw_file in raw_files:
            if not isinstance(raw_file, dict):
                raise ValueError(f"source part {part_id} contains an invalid file descriptor")
            rel = _safe_path(raw_file.get("path"))
            path = rel.as_posix()
            if path in seen_paths:
                raise ValueError(f"duplicate source snapshot path {path}")
            seen_paths.add(path)
            item = {
                "path": path,
                "size_bytes": _require_nonnegative_int(raw_file.get("size_bytes"), f"file {path} size_bytes"),
                "sha256": _require_sha256(raw_file.get("sha256"), f"file {path} sha256"),
            }
            normalized_files.append(item)
            all_files.append(item)
        if file_count != len(normalized_files):
            raise ValueError(f"source part {part_id} file_count does not match files")
        actual_unpacked = sum(item["size_bytes"] for item in normalized_files)
        if unpacked_size != actual_unpacked:
            raise ValueError(f"source part {part_id} unpacked_size_bytes does not match files")
        normalized_parts.append({
            "part_id": part_id,
            "sha256": _require_sha256(raw_part.get("sha256"), f"part {part_id} sha256"),
            "bundle_size_bytes": bundle_size,
            "unpacked_size_bytes": unpacked_size,
            "file_count": file_count,
            "files": normalized_files,
        })

    file_count = _require_nonnegative_int(snapshot.get("file_count"), "source snapshot file_count")
    total_bytes = _require_nonnegative_int(snapshot.get("total_bytes"), "source snapshot total_bytes")
    if file_count != len(all_files):
        raise ValueError("source snapshot file_count does not match parts")
    if file_count > max_files:
        raise ValueError(f"source snapshot has too many files: {file_count} > {max_files}")
    if total_bytes != sum(item["size_bytes"] for item in all_files):
        raise ValueError("source snapshot total_bytes does not match files")
    if total_bytes > max_total_unpacked:
        raise ValueError(f"source snapshot unpacks too large: {total_bytes} > {max_total_unpacked}")
    manifest_sha = _require_sha256(snapshot.get("manifest_sha256"), "source snapshot manifest_sha256")
    actual_manifest_sha = hashlib.sha256(canonical_file_manifest(all_files)).hexdigest()
    if manifest_sha != actual_manifest_sha:
        raise ValueError(f"source snapshot manifest sha256 mismatch: expected {manifest_sha}, got {actual_manifest_sha}")
    return {
        "version": 2,
        "manifest_sha256": manifest_sha,
        "total_bytes": total_bytes,
        "file_count": file_count,
        "parts": normalized_parts,
    }


def _canonical_json(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


def _identity(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:32]


def _snapshot_root(workdir: str, run_id: str, input_revision: str) -> Path:
    if not isinstance(run_id, str) or not run_id.strip():
        raise ValueError("run_id is required")
    if not isinstance(input_revision, str) or not input_revision.strip():
        raise ValueError("input_revision is required")
    return Path(workdir) / ".source-snapshots" / _identity(run_id) / _identity(input_revision)


def _atomic_write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temp.write_bytes(payload)
        os.replace(temp, path)
    finally:
        if temp.exists():
            temp.unlink()


def _load_descriptor(root: Path) -> dict:
    path = root / "descriptor.json"
    if not path.is_file():
        raise SnapshotConflict("source snapshot has not been initialized")
    try:
        return validate_snapshot(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError) as exc:
        raise SnapshotConflict(f"persisted source snapshot descriptor is invalid: {exc}") from exc


def _part_by_id(snapshot: dict, part_id: str) -> dict:
    for part in snapshot["parts"]:
        if part["part_id"] == part_id:
            return part
    raise ValueError(f"unknown source snapshot part {part_id}")


def _part_dir(root: Path, part_id: str) -> Path:
    if not _PART_ID_RE.fullmatch(part_id):
        raise ValueError(f"invalid source snapshot part_id {part_id!r}")
    return root / "parts" / part_id


def _part_complete(root: Path, part: dict) -> bool:
    marker = _part_dir(root, part["part_id"]) / ".complete.json"
    try:
        value = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return value == {"part_id": part["part_id"], "sha256": part["sha256"]}


def snapshot_state(workdir: str, run_id: str, input_revision: str) -> dict:
    root = _snapshot_root(workdir, run_id, input_revision)
    snapshot = _load_descriptor(root)
    committed = (root / "committed.json").is_file()
    received = [part["part_id"] for part in snapshot["parts"] if _part_complete(root, part)]
    received_set = set(received)
    missing = [] if committed else [part["part_id"] for part in snapshot["parts"] if part["part_id"] not in received_set]
    return {
        "input_revision": input_revision,
        "manifest_sha256": snapshot["manifest_sha256"],
        "committed": committed,
        "received_parts": received,
        "missing_parts": missing,
    }


def begin_snapshot(workdir: str, run_id: str, input_revision: str, raw_snapshot: object) -> dict:
    snapshot = validate_snapshot(raw_snapshot)
    root = _snapshot_root(workdir, run_id, input_revision)
    descriptor_path = root / "descriptor.json"
    canonical = _canonical_json(snapshot)
    if descriptor_path.exists():
        if descriptor_path.read_bytes() != canonical:
            raise SnapshotConflict("source snapshot descriptor changed for the same run and revision")
    else:
        root.mkdir(parents=True, exist_ok=True)
        _atomic_write(descriptor_path, canonical)
    return snapshot_state(workdir, run_id, input_revision)


def _extract_part(bundle: bytes, destination: Path, part: dict) -> None:
    expected = {item["path"]: item for item in part["files"]}
    seen: set[str] = set()
    try:
        archive = tarfile.open(fileobj=io.BytesIO(bundle), mode="r:gz")
    except tarfile.TarError as exc:
        raise ValueError(f"invalid source part {part['part_id']}: {exc}") from exc
    with archive:
        for member in archive.getmembers():
            rel = _safe_path(member.name)
            target = destination / Path(*rel.parts)
            try:
                target.resolve(strict=False).relative_to(destination.resolve())
            except ValueError as exc:
                raise ValueError(f"unsafe source path {member.name!r}: escapes part directory") from exc
            if not member.isfile():
                # The Sicore writer emits file entries only; parent directories
                # are created from each declared path. Reject every extra tar
                # member so a small descriptor cannot hide a directory-entry
                # amplification payload.
                raise ValueError(f"unsupported source entry {member.name!r}: only declared regular files are allowed")
            path = rel.as_posix()
            descriptor = expected.get(path)
            if descriptor is None:
                raise ValueError(f"source part {part['part_id']} contains undeclared file {path}")
            if path in seen:
                raise ValueError(f"source part {part['part_id']} contains duplicate file {path}")
            if member.size != descriptor["size_bytes"]:
                raise ValueError(f"source part {part['part_id']} size mismatch for {path}")
            target.parent.mkdir(parents=True, exist_ok=True)
            source = archive.extractfile(member)
            if source is None:
                raise ValueError(f"could not read source entry {path}")
            digest = hashlib.sha256()
            with source, target.open("wb") as output:
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
                    output.write(chunk)
            if digest.hexdigest() != descriptor["sha256"]:
                raise ValueError(f"source part {part['part_id']} sha256 mismatch for {path}")
            seen.add(path)
    missing = sorted(set(expected) - seen)
    if missing:
        raise ValueError(f"source part {part['part_id']} is missing declared files: {', '.join(missing[:3])}")


def install_part(
    workdir: str,
    run_id: str,
    input_revision: str,
    part_id: str,
    bundle: bytes,
    expected_sha256: str | None = None,
) -> dict:
    root = _snapshot_root(workdir, run_id, input_revision)
    snapshot = _load_descriptor(root)
    part = _part_by_id(snapshot, part_id)
    if (root / "committed.json").exists():
        return {**snapshot_state(workdir, run_id, input_revision), "duplicate": True}
    if _part_complete(root, part):
        return {**snapshot_state(workdir, run_id, input_revision), "duplicate": True}
    if len(bundle) != part["bundle_size_bytes"]:
        raise ValueError(f"source part {part_id} compressed size mismatch")
    actual_sha = hashlib.sha256(bundle).hexdigest()
    if expected_sha256 and expected_sha256.lower() != part["sha256"]:
        raise ValueError(f"source part {part_id} request hash does not match descriptor")
    if actual_sha != part["sha256"]:
        raise ValueError(f"source part {part_id} sha256 mismatch: expected {part['sha256']}, got {actual_sha}")

    parts_root = root / "parts"
    parts_root.mkdir(parents=True, exist_ok=True)
    temp = Path(tempfile.mkdtemp(prefix=f".{part_id}-", dir=parts_root))
    destination = _part_dir(root, part_id)
    try:
        _extract_part(bundle, temp, part)
        _atomic_write(temp / ".complete.json", _canonical_json({"part_id": part_id, "sha256": part["sha256"]}))
        if destination.exists():
            if _part_complete(root, part):
                return {**snapshot_state(workdir, run_id, input_revision), "duplicate": True}
            raise SnapshotConflict(f"source part {part_id} has conflicting persisted state")
        temp.rename(destination)
    finally:
        if temp.exists():
            shutil.rmtree(temp)
    return snapshot_state(workdir, run_id, input_revision)


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _remove_path(path: Path) -> None:
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    elif path.exists() or path.is_symlink():
        path.unlink()


def _swap_raw(workdir: Path, staging: Path, mark_committed: Callable[[], None]) -> None:
    # Concurrency contract: commit_snapshot and this rename sequence run
    # synchronously on the compile-box event loop, and the HTTP handler rejects
    # commits after a run becomes live. Do not offload or make this path async
    # without first adding a per-workdir lock around the complete swap/rollback.
    raw = workdir / "raw"
    drop = workdir / "drop"
    backup = workdir / f".raw-backup-{uuid.uuid4().hex}"
    had_raw = raw.exists() or raw.is_symlink()
    if had_raw:
        raw.rename(backup)
    try:
        staging.rename(raw)
        _remove_path(drop)
        try:
            drop.symlink_to(raw, target_is_directory=True)
        except OSError:
            shutil.copytree(raw, drop)
        # Keep the old raw tree recoverable until the durable commit marker is
        # installed. A marker-write failure therefore rolls the visible tree
        # back instead of leaving an unrecorded half-commit.
        mark_committed()
    except Exception:
        _remove_path(raw)
        if had_raw and backup.exists():
            backup.rename(raw)
        _remove_path(drop)
        if raw.exists():
            try:
                drop.symlink_to(raw, target_is_directory=True)
            except OSError:
                shutil.copytree(raw, drop)
        raise
    finally:
        _remove_path(backup)


def commit_snapshot(
    workdir: str,
    run_id: str,
    input_revision: str,
    convert_office: Callable[[str], tuple[list, list]] | None = None,
) -> dict:
    root = _snapshot_root(workdir, run_id, input_revision)
    snapshot = _load_descriptor(root)
    state = snapshot_state(workdir, run_id, input_revision)
    if state["committed"]:
        return {**state, "files": snapshot["file_count"], "bytes": snapshot["total_bytes"], "duplicate": True}
    if state["missing_parts"]:
        raise SnapshotIncomplete(f"source snapshot is incomplete; missing {len(state['missing_parts'])} part(s)")

    wd = Path(workdir)
    wd.mkdir(parents=True, exist_ok=True)
    staging = wd / f".drop-snapshot-{uuid.uuid4().hex}"
    office_converted: list = []
    try:
        staging.mkdir(mode=0o755)
        for part in snapshot["parts"]:
            source_root = _part_dir(root, part["part_id"])
            for item in part["files"]:
                rel = _safe_path(item["path"])
                source = source_root / Path(*rel.parts)
                if not source.is_file() or source.stat().st_size != item["size_bytes"]:
                    raise SnapshotConflict(f"persisted source part is incomplete for {item['path']}")
                if _hash_file(source) != item["sha256"]:
                    raise SnapshotConflict(f"persisted source part is corrupt for {item['path']}")
                target = staging / Path(*rel.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
        if convert_office:
            office_converted, office_errors = convert_office(str(staging))
            for rel, error in office_errors:
                print(f"[office] {rel}: conversion skipped ({error})")
        committed = {
            "input_revision": input_revision,
            "manifest_sha256": snapshot["manifest_sha256"],
            "file_count": snapshot["file_count"],
            "total_bytes": snapshot["total_bytes"],
        }
        _swap_raw(
            wd,
            staging,
            lambda: _atomic_write(root / "committed.json", _canonical_json(committed)),
        )
        shutil.rmtree(root / "parts", ignore_errors=True)
    except Exception:
        _remove_path(staging)
        raise
    return {
        **snapshot_state(workdir, run_id, input_revision),
        "files": snapshot["file_count"],
        "bytes": snapshot["total_bytes"],
        "parts": len(snapshot["parts"]),
        "office_converted": len(office_converted),
    }
