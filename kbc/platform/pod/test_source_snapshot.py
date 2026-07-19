import gzip
import hashlib
import io
import json
import os
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import source_snapshot


def make_bundle(files: dict[str, bytes]) -> bytes:
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w:gz") as archive:
        for name, payload in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(payload)
            archive.addfile(info, io.BytesIO(payload))
    return stream.getvalue()


def make_snapshot(groups: list[dict[str, bytes]]) -> tuple[dict, list[bytes]]:
    parts = []
    bundles = []
    all_files = []
    for index, files in enumerate(groups, start=1):
        bundle = make_bundle(files)
        bundles.append(bundle)
        descriptors = [
            {
                "path": path,
                "size_bytes": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
            }
            for path, payload in files.items()
        ]
        all_files.extend(descriptors)
        parts.append({
            "part_id": f"part-{index:06d}",
            "sha256": hashlib.sha256(bundle).hexdigest(),
            "bundle_size_bytes": len(bundle),
            "unpacked_size_bytes": sum(item["size_bytes"] for item in descriptors),
            "file_count": len(descriptors),
            "files": descriptors,
        })
    return {
        "version": 2,
        "manifest_sha256": hashlib.sha256(source_snapshot.canonical_file_manifest(all_files)).hexdigest(),
        "total_bytes": sum(item["size_bytes"] for item in all_files),
        "file_count": len(all_files),
        "parts": parts,
    }, bundles


def deterministic_directory_bundle(root: Path, files: list[dict]) -> bytes:
    stream = io.BytesIO()
    with gzip.GzipFile(fileobj=stream, mode="wb", mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w") as archive:
            for file in files:
                info = tarfile.TarInfo(file["path"])
                info.size = file["size_bytes"]
                info.mode = 0o644
                info.mtime = 0
                with (root / file["path"]).open("rb") as body:
                    archive.addfile(info, body)
    return stream.getvalue()


class SourceSnapshotTest(unittest.TestCase):
    def test_canonical_manifest_matches_sicore_contract(self):
        files = [
            {"path": "b.md", "sha256": "2" * 64, "size_bytes": 4},
            {"path": "a.md", "sha256": "1" * 64, "size_bytes": 3},
        ]
        payload = source_snapshot.canonical_file_manifest(files)
        self.assertEqual(
            payload.decode(),
            '[{"path":"a.md","sha256":"' + "1" * 64 + '","size_bytes":3},'
            '{"path":"b.md","sha256":"' + "2" * 64 + '","size_bytes":4}]',
        )
        self.assertEqual(
            hashlib.sha256(payload).hexdigest(),
            "03893ac5d1c473dd02f41eb12245120037acfa71357ac1fbf20b9ac82bc388b0",
        )

    def test_canonical_manifest_matches_sicore_json_escaping(self):
        files = [{
            "path": "R&D<plan>\u2028.md",
            "sha256": "a" * 64,
            "size_bytes": 1,
        }]
        self.assertEqual(
            source_snapshot.canonical_file_manifest(files).decode(),
            '[{"path":"R\\u0026D\\u003cplan\\u003e\\u2028.md","sha256":"'
            + "a" * 64
            + '","size_bytes":1}]',
        )

    def test_resumes_missing_parts_and_commits_atomically(self):
        snapshot, bundles = make_snapshot([
            {"docs/a.md": b"alpha\n"},
            {"docs/b.md": b"beta\n"},
        ])
        with tempfile.TemporaryDirectory() as directory:
            workdir = Path(directory)
            (workdir / "raw").mkdir()
            (workdir / "raw" / "old.md").write_text("old\n", encoding="utf-8")

            state = source_snapshot.begin_snapshot(directory, "run-1", "revision-1", snapshot)
            self.assertEqual(state["missing_parts"], ["part-000001", "part-000002"])
            source_snapshot.install_part(
                directory,
                "run-1",
                "revision-1",
                "part-000001",
                bundles[0],
                snapshot["parts"][0]["sha256"],
            )

            # State is filesystem-backed; no in-memory session is needed to resume.
            state = source_snapshot.snapshot_state(directory, "run-1", "revision-1")
            self.assertEqual(state["received_parts"], ["part-000001"])
            self.assertEqual(state["missing_parts"], ["part-000002"])
            with self.assertRaises(source_snapshot.SnapshotIncomplete):
                source_snapshot.commit_snapshot(directory, "run-1", "revision-1")
            self.assertEqual((workdir / "raw" / "old.md").read_text(encoding="utf-8"), "old\n")

            source_snapshot.install_part(directory, "run-1", "revision-1", "part-000002", bundles[1])
            result = source_snapshot.commit_snapshot(
                directory,
                "run-1",
                "revision-1",
                convert_office=lambda _path: ([], []),
            )
            self.assertTrue(result["committed"])
            self.assertEqual((workdir / "raw" / "docs" / "a.md").read_bytes(), b"alpha\n")
            self.assertEqual((workdir / "drop" / "docs" / "b.md").read_bytes(), b"beta\n")
            self.assertFalse((workdir / "raw" / "old.md").exists())

            # Replays after a lost response are idempotent even after staged parts are reclaimed.
            replay = source_snapshot.install_part(directory, "run-1", "revision-1", "part-000001", bundles[0])
            self.assertTrue(replay["duplicate"])
            replay = source_snapshot.commit_snapshot(directory, "run-1", "revision-1")
            self.assertTrue(replay["duplicate"])

    def test_corrupt_part_never_changes_existing_raw(self):
        snapshot, bundles = make_snapshot([{"new.md": b"new\n"}])
        with tempfile.TemporaryDirectory() as directory:
            workdir = Path(directory)
            (workdir / "raw").mkdir()
            (workdir / "raw" / "old.md").write_text("old\n", encoding="utf-8")
            source_snapshot.begin_snapshot(directory, "run-1", "revision-1", snapshot)
            with self.assertRaisesRegex(ValueError, "compressed size mismatch|sha256 mismatch"):
                source_snapshot.install_part(directory, "run-1", "revision-1", "part-000001", bundles[0] + b"corrupt")
            self.assertEqual((workdir / "raw" / "old.md").read_text(encoding="utf-8"), "old\n")
            self.assertEqual(
                source_snapshot.snapshot_state(directory, "run-1", "revision-1")["missing_parts"],
                ["part-000001"],
            )

    def test_commit_marker_failure_rolls_visible_raw_back(self):
        snapshot, bundles = make_snapshot([{"new.md": b"new\n"}])
        with tempfile.TemporaryDirectory() as directory:
            workdir = Path(directory)
            (workdir / "raw").mkdir()
            (workdir / "raw" / "old.md").write_text("old\n", encoding="utf-8")
            source_snapshot.begin_snapshot(directory, "run-1", "revision-1", snapshot)
            source_snapshot.install_part(directory, "run-1", "revision-1", "part-000001", bundles[0])

            with mock.patch.object(source_snapshot, "_atomic_write", side_effect=OSError("disk full")):
                with self.assertRaisesRegex(OSError, "disk full"):
                    source_snapshot.commit_snapshot(directory, "run-1", "revision-1")

            self.assertEqual((workdir / "raw" / "old.md").read_text(encoding="utf-8"), "old\n")
            self.assertFalse((workdir / "raw" / "new.md").exists())
            self.assertEqual((workdir / "drop" / "old.md").read_text(encoding="utf-8"), "old\n")

    def test_part_cannot_smuggle_an_undeclared_file(self):
        declared = b"declared\n"
        malicious_bundle = make_bundle({"declared.md": declared, "extra.md": b"extra\n"})
        files = [{
            "path": "declared.md",
            "size_bytes": len(declared),
            "sha256": hashlib.sha256(declared).hexdigest(),
        }]
        snapshot = {
            "version": 2,
            "manifest_sha256": hashlib.sha256(source_snapshot.canonical_file_manifest(files)).hexdigest(),
            "total_bytes": len(declared),
            "file_count": 1,
            "parts": [{
                "part_id": "part-000001",
                "sha256": hashlib.sha256(malicious_bundle).hexdigest(),
                "bundle_size_bytes": len(malicious_bundle),
                "unpacked_size_bytes": len(declared),
                "file_count": 1,
                "files": files,
            }],
        }
        with tempfile.TemporaryDirectory() as directory:
            source_snapshot.begin_snapshot(directory, "run-1", "revision-1", snapshot)
            with self.assertRaisesRegex(ValueError, "undeclared file"):
                source_snapshot.install_part(directory, "run-1", "revision-1", "part-000001", malicious_bundle)

    def test_part_rejects_non_file_tar_members(self):
        payload = b"declared\n"
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode="w:gz") as archive:
            directory = tarfile.TarInfo("empty-dir")
            directory.type = tarfile.DIRTYPE
            archive.addfile(directory)
            file_info = tarfile.TarInfo("declared.md")
            file_info.size = len(payload)
            archive.addfile(file_info, io.BytesIO(payload))
        bundle = stream.getvalue()
        files = [{
            "path": "declared.md",
            "size_bytes": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
        }]
        snapshot = {
            "version": 2,
            "manifest_sha256": hashlib.sha256(source_snapshot.canonical_file_manifest(files)).hexdigest(),
            "total_bytes": len(payload),
            "file_count": 1,
            "parts": [{
                "part_id": "part-000001",
                "sha256": hashlib.sha256(bundle).hexdigest(),
                "bundle_size_bytes": len(bundle),
                "unpacked_size_bytes": len(payload),
                "file_count": 1,
                "files": files,
            }],
        }
        with tempfile.TemporaryDirectory() as workdir:
            source_snapshot.begin_snapshot(workdir, "run-1", "revision-1", snapshot)
            with self.assertRaisesRegex(ValueError, "only declared regular files"):
                source_snapshot.install_part(workdir, "run-1", "revision-1", "part-000001", bundle)

    def test_same_revision_rejects_a_changed_descriptor(self):
        snapshot, _ = make_snapshot([{"a.md": b"a"}])
        changed, _ = make_snapshot([{"b.md": b"b"}])
        with tempfile.TemporaryDirectory() as directory:
            source_snapshot.begin_snapshot(directory, "run-1", "revision-1", snapshot)
            with self.assertRaisesRegex(source_snapshot.SnapshotConflict, "descriptor changed"):
                source_snapshot.begin_snapshot(directory, "run-1", "revision-1", changed)

    def test_manifest_hash_and_path_are_validated_before_staging(self):
        snapshot, _ = make_snapshot([{"a.md": b"a"}])
        invalid_hash = json.loads(json.dumps(snapshot))
        invalid_hash["manifest_sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "manifest sha256 mismatch"):
            source_snapshot.validate_snapshot(invalid_hash)

        invalid_path = json.loads(json.dumps(snapshot))
        invalid_path["parts"][0]["files"][0]["path"] = "../a.md"
        with self.assertRaisesRegex(ValueError, "parent traversal"):
            source_snapshot.validate_snapshot(invalid_path)

    @unittest.skipUnless(os.environ.get("KBC_GPU_RAW_DIR"), "KBC_GPU_RAW_DIR is not set")
    def test_large_directory_installs_without_a_monolithic_request(self):
        root = Path(os.environ["KBC_GPU_RAW_DIR"])
        files = []
        for path in sorted(item for item in root.rglob("*") if item.is_file()):
            digest = hashlib.sha256()
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            files.append({
                "path": path.relative_to(root).as_posix(),
                "size_bytes": path.stat().st_size,
                "sha256": digest.hexdigest(),
            })

        target = 32 * 1024 * 1024
        groups = []
        current = []
        current_bytes = 0
        for file in files:
            if current and current_bytes + file["size_bytes"] > target:
                groups.append(current)
                current = []
                current_bytes = 0
            current.append(file)
            current_bytes += file["size_bytes"]
        if current:
            groups.append(current)

        parts = []
        for index, group in enumerate(groups, start=1):
            bundle = deterministic_directory_bundle(root, group)
            parts.append({
                "part_id": f"part-{index:06d}",
                "sha256": hashlib.sha256(bundle).hexdigest(),
                "bundle_size_bytes": len(bundle),
                "unpacked_size_bytes": sum(file["size_bytes"] for file in group),
                "file_count": len(group),
                "files": group,
            })
        snapshot = {
            "version": 2,
            "manifest_sha256": hashlib.sha256(source_snapshot.canonical_file_manifest(files)).hexdigest(),
            "total_bytes": sum(file["size_bytes"] for file in files),
            "file_count": len(files),
            "parts": parts,
        }

        with tempfile.TemporaryDirectory() as directory:
            source_snapshot.begin_snapshot(directory, "gpu-run", "gpu-revision", snapshot)
            for part, group in zip(parts, groups):
                source_snapshot.install_part(
                    directory,
                    "gpu-run",
                    "gpu-revision",
                    part["part_id"],
                    deterministic_directory_bundle(root, group),
                )
            result = source_snapshot.commit_snapshot(directory, "gpu-run", "gpu-revision")
            self.assertTrue(result["committed"])
            self.assertEqual(result["files"], len(files))
            self.assertEqual(result["bytes"], snapshot["total_bytes"])
            self.assertGreater(len(parts), 1)
            self.assertLessEqual(max(part["bundle_size_bytes"] for part in parts), 64 * 1024 * 1024)
            self.assertTrue((Path(directory) / "raw" / files[0]["path"]).is_file())


if __name__ == "__main__":
    unittest.main()
