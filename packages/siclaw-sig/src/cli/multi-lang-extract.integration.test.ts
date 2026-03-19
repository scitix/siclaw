/**
 * Cross-language integration test — full pipeline validation for Phase 5.
 *
 * Runs extractLogs() + emitRecords() for each new language (Python, Java,
 * Rust, Bash) against test fixtures. Validates that the complete pipeline
 * produces valid SigRecords.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { SigRecordSchema } from "../schema/record.js";
import yaml from "js-yaml";
import { runExtract } from "./extract.js";

const __filename = fileURLToPath(import.meta.url);
const PKG_ROOT = path.resolve(path.dirname(__filename), "../..");

let hasSemgrep = false;
try {
  execFileSync("semgrep", ["--version"], { timeout: 5000 });
  hasSemgrep = true;
} catch {
  /* semgrep not available */
}

const LANGUAGES = [
  { lang: "python", fixture: "test-fixtures/python", minRecords: 5 },
  { lang: "java", fixture: "test-fixtures/java", minRecords: 5 },
  { lang: "rust", fixture: "test-fixtures/rust", minRecords: 5 },
  { lang: "bash", fixture: "test-fixtures/bash", minRecords: 3 },
] as const;

describe.skipIf(!hasSemgrep)("Multi-language extract integration", () => {
  for (const { lang, fixture, minRecords } of LANGUAGES) {
    describe(`${lang} extraction`, () => {
      let outputDir: string;
      let jsonlContent: string;
      let manifestContent: string;

      beforeAll(async () => {
        outputDir = await mkdtemp(
          path.join(tmpdir(), `siclaw-test-${lang}-`),
        );
        await runExtract({
          src: path.resolve(PKG_ROOT, fixture),
          lang,
          output: outputDir,
          version: "v1.0.0-test",
          component: `test-${lang}`,
          logPatterns: [],
        });
        jsonlContent = await readFile(
          path.join(outputDir, "templates.jsonl"),
          "utf-8",
        );
        manifestContent = await readFile(
          path.join(outputDir, "manifest.yaml"),
          "utf-8",
        );
      });

      afterAll(async () => {
        if (outputDir) {
          await rm(outputDir, { recursive: true, force: true });
        }
      });

      it(`produces templates.jsonl with >= ${minRecords} records`, () => {
        const lines = jsonlContent.trim().split("\n").filter(Boolean);
        expect(lines.length).toBeGreaterThanOrEqual(minRecords);
      });

      it("all JSONL records pass SigRecord schema validation", () => {
        const lines = jsonlContent.trim().split("\n").filter(Boolean);
        for (const line of lines) {
          const record = JSON.parse(line);
          expect(() => SigRecordSchema.parse(record)).not.toThrow();
        }
      });

      it("manifest.yaml contains correct language and component", () => {
        const manifest = yaml.load(manifestContent) as Record<
          string,
          unknown
        >;
        expect(manifest["language"]).toBe(lang);
        expect(manifest["component"]).toBe(`test-${lang}`);
        expect(manifest["source_version"]).toBe("v1.0.0-test");
      });

      it("all records have correct component and version", () => {
        const lines = jsonlContent.trim().split("\n").filter(Boolean);
        for (const line of lines) {
          const record = JSON.parse(line);
          expect(record.component).toBe(`test-${lang}`);
          expect(record.version).toBe("v1.0.0-test");
        }
      });

      it("records have non-empty templates", () => {
        const lines = jsonlContent.trim().split("\n").filter(Boolean);
        for (const line of lines) {
          const record = JSON.parse(line);
          expect(record.template.length).toBeGreaterThan(0);
        }
      });

      it("records have valid confidence levels", () => {
        const lines = jsonlContent.trim().split("\n").filter(Boolean);
        for (const line of lines) {
          const record = JSON.parse(line);
          expect(["exact", "high", "medium"]).toContain(record.confidence);
        }
      });

      it("records with regex=null have confidence=medium", () => {
        const lines = jsonlContent.trim().split("\n").filter(Boolean);
        for (const line of lines) {
          const record = JSON.parse(line);
          if (record.regex === null) {
            expect(record.confidence).toBe("medium");
          }
        }
      });
    });
  }
});
