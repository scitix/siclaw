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
});
