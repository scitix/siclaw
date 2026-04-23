import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { materializePortalKnowledge, cleanupPortalKnowledge } from "./portal-knowledge-materializer.js";
import type { CliSnapshotKnowledgeRepo } from "../portal/cli-snapshot-api.js";

function makeTarRepo(name: string, pages: Array<{ filename: string; content: string }>): CliSnapshotKnowledgeRepo {
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-kn-src-"));
  try {
    for (const p of pages) {
      fs.writeFileSync(path.join(srcDir, p.filename), p.content);
    }
    const tarPath = path.join(os.tmpdir(), `siclaw-kn-${name}-${Date.now()}.tar.gz`);
    execFileSync("tar", ["czf", tarPath, "-C", srcDir, "."], { stdio: "pipe" });
    const data = fs.readFileSync(tarPath);
    fs.unlinkSync(tarPath);
    return {
      name,
      version: 1,
      fileCount: pages.length,
      sizeBytes: data.length,
      sha256: null,
      dataBase64: data.toString("base64"),
    };
  } finally {
    fs.rmSync(srcDir, { recursive: true, force: true });
  }
}

describe("materializePortalKnowledge", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-kn-test-"));
  });

  afterEach(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
  });

  it("unpacks a single-repo tar.gz blob into outDir", () => {
    const repo = makeTarRepo("siclaw-wiki", [
      { filename: "index.md", content: "# Index\n" },
      { filename: "roce-modes.md", content: "# RoCE Modes\n" },
    ]);
    const out = path.join(tmpRoot, "knowledge");
    const result = materializePortalKnowledge([repo], out);
    expect(result.reposUnpacked).toBe(1);
    expect(result.fileCount).toBe(2);
    expect(result.failures).toEqual([]);
    expect(fs.readFileSync(path.join(out, "index.md"), "utf-8")).toBe("# Index\n");
    expect(fs.readFileSync(path.join(out, "roce-modes.md"), "utf-8")).toBe("# RoCE Modes\n");
  });

  it("wipes outDir before extraction so stale pages don't persist", () => {
    const out = path.join(tmpRoot, "knowledge");
    const first = makeTarRepo("repo-a", [{ filename: "old.md", content: "stale" }]);
    materializePortalKnowledge([first], out);
    expect(fs.existsSync(path.join(out, "old.md"))).toBe(true);

    const second = makeTarRepo("repo-b", [{ filename: "fresh.md", content: "new" }]);
    materializePortalKnowledge([second], out);
    expect(fs.existsSync(path.join(out, "old.md"))).toBe(false);
    expect(fs.existsSync(path.join(out, "fresh.md"))).toBe(true);
  });

  it("reports failures without aborting other repos", () => {
    const good = makeTarRepo("good-one", [{ filename: "a.md", content: "a" }]);
    const bad: CliSnapshotKnowledgeRepo = {
      name: "bad-one",
      version: 1,
      fileCount: 0,
      sizeBytes: 10,
      sha256: null,
      dataBase64: Buffer.from("not-actually-a-tar").toString("base64"),
    };
    const out = path.join(tmpRoot, "knowledge");
    const result = materializePortalKnowledge([good, bad], out);
    expect(result.reposUnpacked).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].repo).toBe("bad-one");
    expect(fs.existsSync(path.join(out, "a.md"))).toBe(true);
  });

  it("cleanupPortalKnowledge removes the dir and is idempotent", () => {
    const repo = makeTarRepo("test", [{ filename: "x.md", content: "y" }]);
    const out = path.join(tmpRoot, "knowledge");
    materializePortalKnowledge([repo], out);
    cleanupPortalKnowledge(out);
    expect(fs.existsSync(out)).toBe(false);
    cleanupPortalKnowledge(out);  // second call shouldn't throw
  });

  describe("defensive: path-traversal in tar payloads is rejected", () => {
    /** Build a malicious .tar.gz whose entries escape the extraction dir. */
    function makeMaliciousTarRepo(name: string, entries: Array<{ tarPath: string; content: string }>): CliSnapshotKnowledgeRepo {
      const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-evil-src-"));
      try {
        // Stage files under `srcDir` using the basename, then rewrite the
        // archive with `tar -T --transform` so the archived path contains
        // the traversal segments. Simpler: stage inside a nested dir we can
        // walk out of.
        const stage = path.join(srcDir, "stage");
        fs.mkdirSync(stage, { recursive: true });
        for (const e of entries) {
          // The archived path is `e.tarPath` so we need tar to see that name.
          // Trick: create a file with the basename, then use `--transform` to
          // rename. Alternative: use `-P` + absolute paths. We go with a direct
          // approach — manually construct a tar via `tar -cPf` passing a
          // file-list-with-renames isn't portable, so we write the file to a
          // path that naturally encodes the segments.
          const tmpFile = path.join(stage, Buffer.from(e.tarPath).toString("hex"));
          fs.writeFileSync(tmpFile, e.content);
        }

        // Use `tar` with `--transform` (GNU) or `-s` (BSD) — but neither is
        // portable enough across macOS dev machines + linux CI. So we just
        // skip trying to craft a malicious GNU/BSD tar via shell and instead
        // directly generate one with Node's built-in `tar` header semantics.
        // Because we don't have the `tar` npm package here, exercise the code
        // by substituting a tar.gz whose *decompressed* bytes are hand-assembled.
        //
        // Simpler: pre-build a malicious archive once as a fixture. For the
        // test we just assemble a POSIX tar header by hand for a single entry.
        const tarBuf = buildTarArchive(entries);
        const gzipSync = require("node:zlib").gzipSync as (x: Buffer) => Buffer;
        const data = gzipSync(tarBuf);
        return {
          name,
          version: 1,
          fileCount: entries.length,
          sizeBytes: data.length,
          sha256: null,
          dataBase64: data.toString("base64"),
        };
      } finally {
        fs.rmSync(srcDir, { recursive: true, force: true });
      }
    }

    /** Hand-assemble a minimal POSIX USTAR archive for malicious path tests. */
    function buildTarArchive(entries: Array<{ tarPath: string; content: string }>): Buffer {
      const blocks: Buffer[] = [];
      for (const e of entries) {
        const header = Buffer.alloc(512);
        header.write(e.tarPath.slice(0, 100), 0, "utf-8");                    // name (100 bytes)
        header.write("0000644\0", 100, "utf-8");                              // mode
        header.write("0000000\0", 108, "utf-8");                              // uid
        header.write("0000000\0", 116, "utf-8");                              // gid
        header.write(e.content.length.toString(8).padStart(11, "0") + "\0", 124, "utf-8"); // size
        header.write("00000000000\0", 136, "utf-8");                          // mtime
        header.write("        ", 148, "utf-8");                               // checksum placeholder
        header.write("0", 156, "utf-8");                                      // typeflag (regular file)
        header.write("ustar\0", 257, "utf-8");                                // magic
        header.write("00", 263, "utf-8");                                     // version
        // Compute and write checksum
        let sum = 0;
        for (let i = 0; i < 512; i++) sum += header[i];
        header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "utf-8");
        blocks.push(header);
        // Data block(s), padded to 512-byte boundary.
        const data = Buffer.from(e.content, "utf-8");
        blocks.push(data);
        const pad = (512 - (data.length % 512)) % 512;
        if (pad > 0) blocks.push(Buffer.alloc(pad));
      }
      // Two 512-byte zero blocks terminate the archive.
      blocks.push(Buffer.alloc(1024));
      return Buffer.concat(blocks);
    }

    it("rejects a tarball whose entries escape outDir via `..`", () => {
      const evil = makeMaliciousTarRepo("evil", [
        { tarPath: "../escape.md", content: "should-not-land-here" },
      ]);
      const out = path.join(tmpRoot, "knowledge");
      const result = materializePortalKnowledge([evil], out);
      // The repo must be reported as a failure, not unpacked.
      expect(result.reposUnpacked).toBe(0);
      expect(result.failures).toHaveLength(1);
      // CRITICAL: the escape file must not exist anywhere outside outDir.
      expect(fs.existsSync(path.join(tmpRoot, "escape.md"))).toBe(false);
      expect(fs.existsSync(path.join(path.dirname(tmpRoot), "escape.md"))).toBe(false);
    });

    it("rejects a tarball with absolute paths like `/etc/hosts`", () => {
      const evil = makeMaliciousTarRepo("evil-abs", [
        { tarPath: "/tmp/siclaw-absolute-escape-test.md", content: "nope" },
      ]);
      const out = path.join(tmpRoot, "knowledge");
      const result = materializePortalKnowledge([evil], out);
      // BSD tar (macOS) strips leading `/` to a relative path — which is
      // actually SAFE (lands inside outDir). GNU tar (Linux) without
      // --no-absolute-names would write to /tmp/... — which the post-walk
      // MUST catch. Either behaviour is acceptable as long as nothing
      // lands outside outDir.
      expect(fs.existsSync("/tmp/siclaw-absolute-escape-test.md")).toBe(false);
      // Silent acceptance is fine on BSD; on GNU tar failure is preferred.
      expect(result.reposUnpacked + result.failures.length).toBe(1);
    });
  });
});
