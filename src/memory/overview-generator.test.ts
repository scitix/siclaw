import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildKnowledgeOverview, buildKnowledgeWikiCatalog } from "./overview-generator.js";

describe("buildKnowledgeOverview", () => {
  let tmpDir: string;
  let reposDir: string;
  let docsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "overview-test-"));
    reposDir = path.join(tmpDir, "repos");
    docsDir = path.join(tmpDir, "docs");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Empty / no-content cases ---

  it("returns empty string when nothing is passed", () => {
    expect(buildKnowledgeOverview({})).toBe("");
  });

  it("returns empty string when repos/ and docs/ are both unset", () => {
    expect(buildKnowledgeOverview({})).toBe("");
  });

  // --- Code Repositories ---

  it("returns empty when repos/ doesn't exist", () => {
    const result = buildKnowledgeOverview({ reposDir });
    expect(result).toBe("");
  });

  it("returns empty when repos/ exists but is empty", () => {
    fs.mkdirSync(reposDir);
    const result = buildKnowledgeOverview({ reposDir });
    expect(result).toBe("");
  });

  it("shows repos section for a single repo", () => {
    fs.mkdirSync(reposDir);
    const repo = path.join(reposDir, "my-service");
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, "main.ts"), "console.log()");
    fs.writeFileSync(path.join(repo, "util.ts"), "export {}");
    fs.writeFileSync(path.join(repo, "go.mod"), "module x");

    const result = buildKnowledgeOverview({ reposDir });
    expect(result).toContain("# Knowledge Overview");
    expect(result).toContain("## Code Repositories");
    expect(result).toContain("my-service");
    expect(result).toContain("3"); // file count
    expect(result).toContain(".ts"); // top extension
  });

  it("shows multiple repos sorted by file count", () => {
    fs.mkdirSync(reposDir);

    // Small repo
    const small = path.join(reposDir, "small-repo");
    fs.mkdirSync(small);
    fs.writeFileSync(path.join(small, "a.py"), "");

    // Large repo
    const large = path.join(reposDir, "large-repo");
    fs.mkdirSync(large);
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(large, `file${i}.go`), "");
    }

    const result = buildKnowledgeOverview({ reposDir });
    const largeIdx = result.indexOf("large-repo");
    const smallIdx = result.indexOf("small-repo");
    expect(largeIdx).toBeLessThan(smallIdx);
  });

  it("counts files recursively and detects top languages", () => {
    fs.mkdirSync(reposDir);
    const repo = path.join(reposDir, "nested-service");
    fs.mkdirSync(path.join(repo, "src", "utils"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "main.ts"), "");
    fs.writeFileSync(path.join(repo, "src", "app.ts"), "");
    fs.writeFileSync(path.join(repo, "src", "utils", "helper.ts"), "");
    fs.writeFileSync(path.join(repo, "README.md"), "");
    fs.writeFileSync(path.join(repo, "package.json"), "{}");

    const result = buildKnowledgeOverview({ reposDir });
    expect(result).toContain("nested-service");
    expect(result).toContain("5"); // total files
    expect(result).toContain(".ts"); // top extension
  });

  it("skips hidden dirs and node_modules in repos", () => {
    fs.mkdirSync(reposDir);
    const repo = path.join(reposDir, "with-hidden");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repo, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "config"), "");
    fs.writeFileSync(path.join(repo, "node_modules", "pkg", "index.js"), "");
    fs.writeFileSync(path.join(repo, "src.ts"), "");

    const result = buildKnowledgeOverview({ reposDir });
    expect(result).toContain("| 1 |"); // only src.ts counted
  });

  it("follows symlinked repo directories", () => {
    fs.mkdirSync(reposDir);
    // Create actual repo outside repos/
    const realRepo = path.join(tmpDir, "real-repo");
    fs.mkdirSync(realRepo);
    fs.writeFileSync(path.join(realRepo, "index.ts"), "");
    fs.writeFileSync(path.join(realRepo, "lib.ts"), "");
    // Symlink into repos/
    fs.symlinkSync(realRepo, path.join(reposDir, "linked-repo"));

    const result = buildKnowledgeOverview({ reposDir });
    expect(result).toContain("linked-repo");
    expect(result).toContain("2"); // file count
  });

  it("follows symlinked doc directories", () => {
    fs.mkdirSync(docsDir);
    const realDocs = path.join(tmpDir, "real-runbooks");
    fs.mkdirSync(realDocs);
    fs.writeFileSync(path.join(realDocs, "deploy.md"), "");
    fs.symlinkSync(realDocs, path.join(docsDir, "runbooks"));

    const result = buildKnowledgeOverview({ docsDir });
    expect(result).toContain("runbooks");
  });

  // --- Documentation ---

  it("returns empty when docs/ doesn't exist", () => {
    const result = buildKnowledgeOverview({ docsDir });
    expect(result).toBe("");
  });

  it("returns empty when docs/ exists but is empty", () => {
    fs.mkdirSync(docsDir);
    const result = buildKnowledgeOverview({ docsDir });
    expect(result).toBe("");
  });

  it("shows docs section with subdirectories", () => {
    fs.mkdirSync(docsDir);
    const runbooks = path.join(docsDir, "runbooks");
    fs.mkdirSync(runbooks);
    fs.writeFileSync(path.join(runbooks, "restart.md"), "# Restart");
    fs.writeFileSync(path.join(runbooks, "scale.md"), "# Scale");

    const arch = path.join(docsDir, "architecture");
    fs.mkdirSync(arch);
    fs.writeFileSync(path.join(arch, "overview.md"), "# Overview");

    const result = buildKnowledgeOverview({ docsDir });
    expect(result).toContain("## Documentation");
    expect(result).toContain("runbooks");
    expect(result).toContain("architecture");
  });

  it("lists top-level files as (root)", () => {
    fs.mkdirSync(docsDir);
    fs.writeFileSync(path.join(docsDir, "getting-started.md"), "# Hello");
    fs.writeFileSync(path.join(docsDir, "faq.md"), "# FAQ");

    const result = buildKnowledgeOverview({ docsDir });
    expect(result).toContain("## Documentation");
    expect(result).toContain("(root)");
    expect(result).toContain("| 2 |");
  });

  // --- Mixed scenarios ---

  it("shows repos + docs together", () => {
    // repos
    fs.mkdirSync(reposDir);
    const repo = path.join(reposDir, "api-svc");
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, "main.go"), "package main");

    // docs
    fs.mkdirSync(docsDir);
    const runbooks = path.join(docsDir, "runbooks");
    fs.mkdirSync(runbooks);
    fs.writeFileSync(path.join(runbooks, "deploy.md"), "# Deploy");

    const result = buildKnowledgeOverview({ reposDir, docsDir });
    expect(result).toContain("## Code Repositories");
    expect(result).toContain("api-svc");
    expect(result).toContain("## Documentation");
    expect(result).toContain("runbooks");
    expect(result).not.toContain("### Recent Investigations");
    expect(result).not.toContain("### Accumulated Knowledge");
  });

  it("uses content-aware footer when repos or docs present", () => {
    fs.mkdirSync(reposDir);
    const repo = path.join(reposDir, "svc");
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, "x.ts"), "");

    const result = buildKnowledgeOverview({ reposDir });
    expect(result).toContain("repos/");
    expect(result).toContain("docs/");
  });

  // --- Intentional non-injection of investigations ---

  it("never injects past investigations, even when memory/investigations/ exists", () => {
    // Simulate a past DP investigation file on disk — it must NOT appear in the overview.
    const memoryDir = path.join(tmpDir, "memory");
    fs.mkdirSync(memoryDir);
    const invDir = path.join(memoryDir, "investigations");
    fs.mkdirSync(invDir);
    fs.writeFileSync(
      path.join(invDir, "2026-03-16-14-30-00.md"),
      `# Investigation: Pod CrashLoopBackOff in prod-us-west\n`,
    );

    // Also give the overview something to render so we're checking selective omission,
    // not a trivial empty-result path.
    fs.mkdirSync(reposDir);
    const repo = path.join(reposDir, "svc");
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, "main.ts"), "");

    const result = buildKnowledgeOverview({ reposDir });
    expect(result).toContain("## Code Repositories");
    expect(result).not.toContain("### Recent Investigations");
    expect(result).not.toContain("Pod CrashLoopBackOff");
    expect(result).not.toContain("Patterns:");
  });

  // --- Budget ---

  it("stays within budget with large repos + many docs", () => {
    // Large repos
    fs.mkdirSync(reposDir);
    for (let r = 0; r < 10; r++) {
      const repo = path.join(reposDir, `service-with-long-name-${r}`);
      fs.mkdirSync(repo);
      for (let f = 0; f < 20; f++) {
        fs.writeFileSync(path.join(repo, `file${f}.ts`), "");
      }
    }

    // Many docs
    fs.mkdirSync(docsDir);
    for (let d = 0; d < 10; d++) {
      const dir = path.join(docsDir, `category-with-long-name-${d}`);
      fs.mkdirSync(dir);
      for (let f = 0; f < 5; f++) {
        fs.writeFileSync(path.join(dir, `doc${f}.md`), "");
      }
    }

    const result = buildKnowledgeOverview({ reposDir, docsDir });
    expect(result.length).toBeLessThanOrEqual(1200 + 150);
  });
});

describe("buildKnowledgeWikiCatalog", () => {
  let tmpDir: string;
  let knowledgeDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-test-"));
    knowledgeDir = path.join(tmpDir, "knowledge");
    fs.mkdirSync(knowledgeDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty when no dir or no index.md", () => {
    expect(buildKnowledgeWikiCatalog(undefined)).toBe("");
    expect(buildKnowledgeWikiCatalog(knowledgeDir)).toBe(""); // dir exists but no index.md
  });

  it("returns empty for a blank index.md", () => {
    fs.writeFileSync(path.join(knowledgeDir, "index.md"), "   \n  \n");
    expect(buildKnowledgeWikiCatalog(knowledgeDir)).toBe("");
  });

  it("injects the index catalog verbatim under a Knowledge Wiki heading", () => {
    const index = "- [[roce-modes]] — RoCE modes and failures\n- [[gpu-xid]] — XID error codes";
    fs.writeFileSync(path.join(knowledgeDir, "index.md"), index);
    const out = buildKnowledgeWikiCatalog(knowledgeDir);
    expect(out).toContain("# Knowledge Wiki");
    expect(out).toContain("there is no search tool");
    expect(out).toContain("[[roce-modes]]");
    expect(out).toContain("[[gpu-xid]]");
    expect(out).not.toContain("truncated");
  });

  it("truncates an oversized index and points to the full file", () => {
    const big = Array.from({ length: 500 }, (_, i) => `- [[page-${i}]] — description number ${i} with some padding text`).join("\n");
    fs.writeFileSync(path.join(knowledgeDir, "index.md"), big);
    const out = buildKnowledgeWikiCatalog(knowledgeDir);
    expect(out).toContain("# Knowledge Wiki");
    expect(out).toContain("Catalog truncated");
    expect(out).toContain(".siclaw/knowledge/index.md");
    // Budgeted: well under the full size.
    expect(out.length).toBeLessThan(big.length);
  });

  // --- Consumer meta (_consumer_meta.json, DESIGN-kb-consumer-meta) ---

  const writeMeta = (dir: string, meta: unknown) =>
    fs.writeFileSync(path.join(dir, "_consumer_meta.json"), JSON.stringify(meta));

  it("keeps EXACTLY the pre-meta output when no bundle carries a meta file", () => {
    const index = "- [[roce-modes]] — RoCE modes";
    fs.writeFileSync(path.join(knowledgeDir, "index.md"), index);
    const before = buildKnowledgeWikiCatalog(knowledgeDir);
    expect(before).not.toContain("## Knowledge Bases");
    expect(before).toContain("[[roce-modes]]");
  });

  it("tolerates an invalid or summary-less meta file: exactly current behavior, no error", () => {
    fs.writeFileSync(path.join(knowledgeDir, "index.md"), "- [[a]] — x");
    fs.writeFileSync(path.join(knowledgeDir, "_consumer_meta.json"), "{not json");
    const broken = buildKnowledgeWikiCatalog(knowledgeDir);
    expect(broken).not.toContain("## Knowledge Bases");
    writeMeta(knowledgeDir, { version: 1, summary: "   " });
    expect(buildKnowledgeWikiCatalog(knowledgeDir)).not.toContain("## Knowledge Bases");
    writeMeta(knowledgeDir, { version: 1, summary: 42, when_to_use: "nope" });
    expect(buildKnowledgeWikiCatalog(knowledgeDir)).not.toContain("## Knowledge Bases");
  });

  it("renders a single bundle's meta: name + published version + summary + use-when/not-for, index kept", () => {
    fs.writeFileSync(path.join(knowledgeDir, "index.md"), "- [[roce-modes]] — RoCE modes");
    fs.writeFileSync(path.join(knowledgeDir, ".sync-manifest.json"), JSON.stringify({
      syncedAt: "t", version: "1", repos: [{ id: "1", name: "GPU 集群运维", version: 7 }],
    }));
    writeMeta(knowledgeDir, {
      version: 1, summary: "覆盖 GPU 集群排障口径", when_to_use: ["XID 报错", "RoCE 掉速"],
      not_for: ["计费问题"], topics: ["gpu"], entry_pages: [], locale: "zh",
      generated_by: "m", published_version: 9,
    });
    const out = buildKnowledgeWikiCatalog(knowledgeDir);
    expect(out).toContain("## Knowledge Bases");
    expect(out).toContain("### GPU 集群运维 (v9)"); // published_version wins over manifest v7
    expect(out).toContain("覆盖 GPU 集群排障口径");
    expect(out).toContain("Use when: XID 报错; RoCE 掉速");
    expect(out).toContain("Not for: 计费问题");
    expect(out).toContain("[[roce-modes]]"); // second disclosure layer (index) still routed
    // never inlines the JSON file itself as a page
    expect(out).not.toContain("generated_by");
  });

  it("does not double the v prefix when published_version is already prefixed (sicore wire format)", () => {
    fs.writeFileSync(path.join(knowledgeDir, "index.md"), "- [[a]] — x");
    fs.writeFileSync(path.join(knowledgeDir, ".sync-manifest.json"), JSON.stringify({
      repos: [{ id: "1", name: "wiki-a", version: 3 }],
    }));
    writeMeta(knowledgeDir, { version: 1, summary: "口径", published_version: "v9" });
    const out = buildKnowledgeWikiCatalog(knowledgeDir);
    expect(out).toContain("### wiki-a (v9)");
    expect(out).not.toContain("(vv9)");
  });

  it("falls back to the sync-manifest version when the meta has no published_version", () => {
    fs.writeFileSync(path.join(knowledgeDir, "index.md"), "- [[a]] — x");
    fs.writeFileSync(path.join(knowledgeDir, ".sync-manifest.json"), JSON.stringify({
      repos: [{ id: "1", name: "wiki-a", version: 3 }],
    }));
    writeMeta(knowledgeDir, { version: 1, summary: "s" });
    expect(buildKnowledgeWikiCatalog(knowledgeDir)).toContain("### wiki-a (v3)");
  });

  it("reads each bundle root in the multi-repo layout; metaless bundles keep only their index line", () => {
    // Mirrors sync-handlers' multi-repo layout: synthetic root index + repos/<dir>/
    fs.writeFileSync(path.join(knowledgeDir, "index.md"),
      "- [[repos/wiki-a/index]] - wiki-a v3\n- [[repos/wiki-b/index]] - wiki-b v1");
    fs.writeFileSync(path.join(knowledgeDir, ".sync-manifest.json"), JSON.stringify({
      repos: [{ id: "1", name: "Wiki-A", version: 3 }, { id: "2", name: "wiki-b", version: 1 }],
    }));
    const dirA = path.join(knowledgeDir, "repos", "wiki-a"); // sanitize("Wiki-A") → wiki-a
    const dirB = path.join(knowledgeDir, "repos", "wiki-b");
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    writeMeta(dirA, { version: 1, summary: "A 的口径", when_to_use: ["问A"], published_version: 4 });
    const out = buildKnowledgeWikiCatalog(knowledgeDir);
    expect(out).toContain("### Wiki-A (v4)"); // manifest display name, meta's published version
    expect(out).toContain("A 的口径");
    expect(out).toContain("Use when: 问A");
    expect(out).not.toContain("### wiki-b"); // no meta → fallback: only its synthetic index line
    expect(out).toContain("[[repos/wiki-b/index]]");
  });

  it("degrades within the 200-char entry budget: not_for dropped first, then when_to_use, summary truncated last (rune-safe)", () => {
    fs.writeFileSync(path.join(knowledgeDir, "index.md"), "- [[a]] — x");
    // Sized so: summary+when+not_for > 200 AND summary+when > 200 AND summary ≤ 200
    // → exercises both drop steps while the summary itself survives untruncated.
    const summary = "夏".repeat(150);
    writeMeta(knowledgeDir, {
      version: 1, summary,
      when_to_use: Array.from({ length: 2 }, (_, i) => `use-case-${i}-${"w".repeat(100)}`),
      not_for: Array.from({ length: 2 }, (_, i) => `not-${i}-${"n".repeat(50)}`),
    });
    const out = buildKnowledgeWikiCatalog(knowledgeDir);
    expect(out).not.toContain("Not for:");   // dropped first (entry would blow the per-KB budget)
    expect(out).not.toContain("Use when:");  // then when_to_use
    expect(out).toContain("夏".repeat(100)); // summary head survives
    expect(out.length).toBeLessThan(4000 + 700); // instructions overhead only
    // extreme: a ballooned summary (hand-made/legacy meta) → the HARD 200-char
    // per-entry cap holds even though the whole 4000 budget is free (one KB
    // bound); rune-safe truncation, no lone surrogate
    writeMeta(knowledgeDir, { version: 1, summary: "🀄".repeat(5000) });
    const out2 = buildKnowledgeWikiCatalog(knowledgeDir);
    expect(out2).toContain("…");
    expect(out2).not.toMatch(/[\uD800-\uDBFF]$/m); // no split surrogate pair at any line end
    const entry = out2.split("## Knowledge Bases\n\n")[1].split("\n\n")[0];
    expect(entry.length).toBeLessThanOrEqual(200); // per-entry cap, NOT the even 4000-split
  });

  it("caps every bound KB's entry at 200 and still fits the total", () => {
    fs.writeFileSync(path.join(knowledgeDir, "index.md"), "- [[repos/a/index]] - a\n- [[repos/b/index]] - b");
    for (const name of ["a", "b"]) {
      const dir = path.join(knowledgeDir, "repos", name);
      fs.mkdirSync(dir, { recursive: true });
      writeMeta(dir, {
        version: 1, summary: `${name}-${"s".repeat(3000)}`,
        when_to_use: [`${name}-when`], not_for: [`${name}-not`],
      });
    }
    const out = buildKnowledgeWikiCatalog(knowledgeDir);
    expect(out).toContain("### a");
    expect(out).toContain("### b");
    expect(out).toContain("a-ss");
    expect(out).toContain("b-ss");
    const metaSection = out.split("## Knowledge Bases\n\n")[1].split("\n\n- [[")[0];
    expect(metaSection.length).toBeLessThanOrEqual(2 * 200 + 2); // two capped entries + blank-line join
    expect(out.length).toBeLessThan(2000); // capped entries + tiny index + fixed instructions
  });
});
