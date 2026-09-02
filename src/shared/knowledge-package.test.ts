import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  extractKnowledgePackageToDir,
  OKF_CITATION_SIDECAR,
  OKF_ROUTES_SIDECAR,
  SERVER_CITATION_MANIFEST,
  validateKnowledgePackage,
} from "./knowledge-package.js";

describe("validateKnowledgePackage", () => {
  it("accepts a minimal markdown wiki package", () => {
    const buf = makeTarGz([
      { name: "index.md", content: "# Index\n\n- [[runbook]]\n" },
      { name: "runbook.md", content: "# Runbook\n\nDo the thing.\n" },
      { name: "manifest.json", content: JSON.stringify({ sourceRepo: "git@example/repo" }) },
    ]);

    const info = validateKnowledgePackage(buf);

    expect(info.fileCount).toBe(3);
    expect(info.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(info.manifestJson).toEqual({ sourceRepo: "git@example/repo" });
  });

  it("rejects path traversal entries", () => {
    const buf = makeTarGz([
      { name: "index.md", content: "# Index\n" },
      { name: "../escape.md", content: "bad\n" },
    ]);

    expect(() => validateKnowledgePackage(buf)).toThrow("Path traversal");
  });

  it.each([
    ["symlink", "2"],
    ["hardlink", "1"],
  ])("rejects %s entries", (_label, type) => {
    const buf = makeTarGz([
      { name: "index.md", content: "# Index\n" },
      { name: "outside.md", type, content: "ignored\n" },
    ]);

    expect(() => validateKnowledgePackage(buf)).toThrow("Unsupported tar entry type");
  });

  it("rejects packages without a root index", () => {
    const buf = makeTarGz([{ name: "nested/index.md", content: "# Nested\n" }]);

    expect(() => validateKnowledgePackage(buf)).toThrow("index.md");
  });

  it("accepts per-file PAX path headers", () => {
    const buf = makeTarGz([
      { name: "PaxHeader/index.md", type: "x", content: makePaxPayload({ path: "index.md" }) },
      { name: "short-index", content: "# Index\n" },
      { name: "PaxHeader/manifest.json", type: "x", content: makePaxPayload({ path: "manifest.json" }) },
      { name: "short-manifest", content: JSON.stringify({ sourceRepo: "git@example/pax" }) },
    ]);

    const info = validateKnowledgePackage(buf);

    expect(info.fileCount).toBe(2);
    expect(info.manifestJson).toEqual({ sourceRepo: "git@example/pax" });
  });

  it("rejects unsafe PAX path headers", () => {
    const buf = makeTarGz([
      { name: "PaxHeader/escape.md", type: "x", content: makePaxPayload({ path: "../escape.md" }) },
      { name: "escape.md", content: "bad\n" },
      { name: "index.md", content: "# Index\n" },
    ]);

    expect(() => validateKnowledgePackage(buf)).toThrow("Path traversal");
  });

  it("does not materialize uploader-supplied citation metadata at any depth", async () => {
    const buf = makeTarGz([
      { name: "index.md", content: "# Index\n" },
      { name: OKF_CITATION_SIDECAR, content: JSON.stringify({ sources: [{ url: "https://docs.feishu.cn/wiki/input" }] }) },
      { name: `nested/${OKF_CITATION_SIDECAR}`, content: "{}" },
      { name: OKF_ROUTES_SIDECAR, content: JSON.stringify({ schema_version: 1, routes: [] }) },
      { name: `nested/${OKF_ROUTES_SIDECAR}`, content: "{}" },
      { name: SERVER_CITATION_MANIFEST, content: "{}" },
      { name: `nested/deeper/${SERVER_CITATION_MANIFEST}`, content: "{}" },
    ]);
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "siclaw-knowledge-test-"));
    const previousTarOptions = process.env.TAR_OPTIONS;
    try {
      process.env.TAR_OPTIONS = "--anchored";
      await extractKnowledgePackageToDir(buf, target);
      await expect(fs.readFile(path.join(target, "index.md"), "utf8")).resolves.toContain("# Index");
      await expect(fs.stat(path.join(target, OKF_CITATION_SIDECAR))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(path.join(target, "nested", OKF_CITATION_SIDECAR))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(path.join(target, OKF_ROUTES_SIDECAR))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(path.join(target, "nested", OKF_ROUTES_SIDECAR))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(path.join(target, SERVER_CITATION_MANIFEST))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(path.join(target, "nested", "deeper", SERVER_CITATION_MANIFEST))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (previousTarOptions === undefined) delete process.env.TAR_OPTIONS;
      else process.env.TAR_OPTIONS = previousTarOptions;
      await fs.rm(target, { recursive: true, force: true });
    }
  });
});

function makeTarGz(files: Array<{ name: string; content: Buffer | string; type?: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const file of files) {
    const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, "utf8");
    blocks.push(makeHeader(file.name, content.length, file.type ?? "0"));
    blocks.push(content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function makeHeader(name: string, size: number, type: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(" ", 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");

  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return header;
}

function makePaxPayload(records: Record<string, string>): Buffer {
  return Buffer.from(
    Object.entries(records)
      .map(([key, value]) => makePaxRecord(key, value))
      .join(""),
    "utf8",
  );
}

function makePaxRecord(key: string, value: string): string {
  const body = `${key}=${value}\n`;
  let length = Buffer.byteLength(body, "utf8") + 3;

  while (true) {
    const record = `${length} ${body}`;
    const nextLength = Buffer.byteLength(record, "utf8");
    if (nextLength === length) return record;
    length = nextLength;
  }
}
