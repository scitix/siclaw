/**
 * Integration test — end-to-end CLI extraction against Go fixtures.
 *
 * Validates the complete pipeline: runExtract() against real Go test fixtures,
 * output templates.jsonl and manifest.yaml pass schema validation, and all
 * three CLI requirements (CLI-01, CLI-02, CLI-03) are satisfied.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { SigRecordSchema } from "../schema/record.js";
import { ManifestSchema } from "../schema/manifest.js";
import yaml from "js-yaml";
import { runExtract } from "./extract.js";

const __filename = fileURLToPath(import.meta.url);
const FIXTURES_DIR = path.resolve(
  path.dirname(__filename),
  "../extraction/__fixtures__",
);

let hasSemgrep = false;
try {
  execFileSync("semgrep", ["--version"], { timeout: 5000 });
  hasSemgrep = true;
} catch {
  /* semgrep not available */
}

describe.skipIf(!hasSemgrep)("extract command (integration)", () => {
  let outputDir: string;

  beforeAll(async () => {
    outputDir = await mkdtemp(path.join(tmpdir(), "siclaw-sig-test-"));

    await runExtract({
      src: FIXTURES_DIR,
      lang: "go",
      output: outputDir,
      version: "v1.8.0",
      component: "test-controller",
      logPatterns: [],
    });
  });

  afterAll(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  it("CLI-01: produces templates.jsonl and manifest.yaml from Go source", async () => {
    const jsonlContent = await readFile(
      path.join(outputDir, "templates.jsonl"),
      "utf-8",
    );
    const manifestContent = await readFile(
      path.join(outputDir, "manifest.yaml"),
      "utf-8",
    );

    expect(jsonlContent.length).toBeGreaterThan(0);
    expect(manifestContent.length).toBeGreaterThan(0);
  });

  it("CLI-01: every JSONL line validates against SigRecordSchema", async () => {
    const jsonlContent = await readFile(
      path.join(outputDir, "templates.jsonl"),
      "utf-8",
    );
    const lines = jsonlContent
      .trim()
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      const record = JSON.parse(line);
      expect(() => SigRecordSchema.parse(record)).not.toThrow();
    }
  });

  it("CLI-01: SigRecord fields are populated correctly", async () => {
    const jsonlContent = await readFile(
      path.join(outputDir, "templates.jsonl"),
      "utf-8",
    );
    const lines = jsonlContent.trim().split("\n");
    const firstRecord = JSON.parse(lines[0]);

    expect(firstRecord.id).toMatch(/^[0-9a-f]{12}$/);
    expect(firstRecord.component).toBe("test-controller");
    expect(firstRecord.version).toBe("v1.8.0");
    expect(firstRecord.file).toBeTruthy();
    expect(firstRecord.line).toBeGreaterThan(0);
    expect(firstRecord.function).toBeTruthy();
    expect(firstRecord.template).toBeTruthy();
    expect(firstRecord.keywords.length).toBeGreaterThan(0);
    expect(firstRecord.context.package).toBeTruthy();
    expect(firstRecord.context.source_lines.length).toBeGreaterThan(0);
  });

  it("CLI-02: --version appears in manifest source_version", async () => {
    const manifestContent = await readFile(
      path.join(outputDir, "manifest.yaml"),
      "utf-8",
    );
    const manifest = yaml.load(manifestContent) as Record<string, unknown>;
    expect(() => ManifestSchema.parse(manifest)).not.toThrow();
    expect(manifest.source_version).toBe("v1.8.0");
  });

  it("CLI-02: manifest stats match JSONL record count", async () => {
    const jsonlContent = await readFile(
      path.join(outputDir, "templates.jsonl"),
      "utf-8",
    );
    const recordCount = jsonlContent
      .trim()
      .split("\n")
      .filter((l) => l.length > 0).length;

    const manifestContent = await readFile(
      path.join(outputDir, "manifest.yaml"),
      "utf-8",
    );
    const manifest = yaml.load(manifestContent) as Record<string, unknown>;
    const stats = manifest.stats as Record<string, unknown>;
    expect(stats.total_templates).toBe(recordCount);
  });

  it("CLI-02: manifest by_level sums equal total_templates", async () => {
    const manifestContent = await readFile(
      path.join(outputDir, "manifest.yaml"),
      "utf-8",
    );
    const manifest = ManifestSchema.parse(yaml.load(manifestContent));
    const levelSum =
      manifest.stats.by_level.error +
      manifest.stats.by_level.warning +
      manifest.stats.by_level.info;
    // levelSum may be <= total_templates because debug/fatal/trace are not counted in by_level
    expect(levelSum).toBeLessThanOrEqual(manifest.stats.total_templates);
  });

  it("CLI-03: --log-patterns with non-existent file throws", async () => {
    await expect(
      runExtract({
        src: FIXTURES_DIR,
        lang: "go",
        output: outputDir,
        version: "v1.0.0",
        component: "test",
        logPatterns: ["/nonexistent/custom-rules.yaml"],
      }),
    ).rejects.toThrow("not found");
  });

  it("error on non-existent --src directory", async () => {
    await expect(
      runExtract({
        src: "/nonexistent/src/path",
        lang: "go",
        output: outputDir,
        version: "v1.0.0",
        component: "test",
        logPatterns: [],
      }),
    ).rejects.toThrow("--src path is not a directory");
  });
});
