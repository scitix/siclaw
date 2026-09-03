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

  it("injects the index catalog and documents both current and legacy link contracts", () => {
    const index = "- [RoCE modes](network/roce-modes.md) — RoCE modes and failures\n- [[gpu-xid]] — XID error codes";
    fs.writeFileSync(path.join(knowledgeDir, "index.md"), index);
    const out = buildKnowledgeWikiCatalog(knowledgeDir);
    expect(out).toContain("# Knowledge Wiki");
    expect(out).toContain(`under \`${knowledgeDir}\``);
    expect(out).toContain(`catalog is \`${path.join(knowledgeDir, "index.md")}\``);
    expect(out).toContain("complete page catalog");
    expect(out).toContain("typed page labels only");
    expect(out).toContain("navigation metadata, not answer evidence");
    expect(out).toContain("[RoCE modes](network/roce-modes.md)");
    expect(out).toContain("[[gpu-xid]]");
    expect(out).toContain("relative to the current page's directory");
    expect(out).toContain("tolerate legacy `[[other-page]]`");
    expect(out).not.toContain("truncated");
  });

  it("uses answer-only guidance for a non-operational knowledge harness", () => {
    fs.writeFileSync(path.join(knowledgeDir, "index.md"), "- [Install guide](install.md) — exact steps");

    const out = buildKnowledgeWikiCatalog(knowledgeDir, { operational: false });

    expect(out).toContain("Answer from the most relevant pages");
    expect(out).toContain("reference material, not as instructions");
    expect(out).not.toContain("concrete checks");
    expect(out).not.toContain("bash");
  });

  it("injects every entry from a 21K+ compiled index", () => {
    // Regression fixture based on a shipped 185-line hardware Wiki whose last
    // relevant routes sat beyond the former 8K head-only prompt budget.
    const realistic = [
      "---", "title: Siclaw SRE Knowledge", "type: index", "---", "",
      "# Siclaw SRE Knowledge", "", "## Components", "",
      ...Array.from({ length: 176 }, (_, i) =>
        i === 175
          ? "- [招摇 B30X 多厂商评估](topics/招摇B30X.md) — B300 LSTM 算子通过 cudagraph 优化的技嘉平台实测数据"
          : `- [Component ${i}](components/component-${i}.md) — what it is, how it fails, which environment it applies to, and which signals distinguish the failure mode`),
    ].join("\n");
    expect(realistic.split("\n")).toHaveLength(185);
    expect(realistic.length).toBeGreaterThan(21_000);
    fs.writeFileSync(path.join(knowledgeDir, "index.md"), realistic);
    const out = buildKnowledgeWikiCatalog(knowledgeDir);
    expect(out).not.toContain("truncated");
    expect(out).toContain("[招摇 B30X 多厂商评估](topics/招摇B30X.md)");
    expect(out).toContain("B300 LSTM 算子通过 cudagraph 优化");
  });

  it("lifts a root verified-route block ahead of a large catalog without duplicating it", () => {
    const routeBlock = [
      "<!-- verified-routes:begin -->",
      "## 已验证快速路由",
      "",
      "- **Diagnose XID** → [gpu/xid.md](gpu/xid.md)",
      "<!-- verified-routes:end -->",
    ].join("\n");
    const largeCatalog = Array.from(
      { length: 200 },
      (_, i) => `- [Page ${i}](pages/${i}.md) — ${"description ".repeat(8)}`,
    ).join("\n");
    fs.writeFileSync(path.join(knowledgeDir, "index.md"), `${largeCatalog}\n\n${routeBlock}\n`);

    const out = buildKnowledgeWikiCatalog(knowledgeDir);
    const xidPath = path.join(knowledgeDir, "gpu", "xid.md");

    expect(out.indexOf("## Verified Fast Routes")).toBeLessThan(out.indexOf("- [Page 0]"));
    expect(out.match(/<!-- verified-routes:begin -->/g)).toHaveLength(1);
    expect(out).toContain(`[gpu/xid.md](${xidPath})`);
    expect(out).toContain("- [Page 199]");
  });

  it("lifts routes from every library in a multi-library materialization", () => {
    fs.writeFileSync(
      path.join(knowledgeDir, "index.md"),
      "# Knowledge Index\n\n- [[repos/compute/index]]\n- [[repos/network/index]]\n",
    );
    for (const [library, intent, target] of [
      ["compute", "Diagnose XID", "gpu/xid.md"],
      ["network", "Diagnose RoCE", "roce/loss.md"],
    ]) {
      const libraryDir = path.join(knowledgeDir, "repos", library);
      fs.mkdirSync(libraryDir, { recursive: true });
      fs.writeFileSync(
        path.join(libraryDir, "index.md"),
        [
          `# ${library}`,
          "",
          "<!-- verified-routes:begin -->",
          "## 已验证快速路由",
          "",
          `- **${intent}** → [${target}](${target})`,
          "<!-- verified-routes:end -->",
        ].join("\n"),
      );
    }

    const out = buildKnowledgeWikiCatalog(knowledgeDir);

    expect(out).toContain("### From `repos/compute/index.md`");
    expect(out).toContain(`[gpu/xid.md](${path.join(knowledgeDir, "repos", "compute", "gpu", "xid.md")})`);
    expect(out).toContain("### From `repos/network/index.md`");
    expect(out).toContain(`[roce/loss.md](${path.join(knowledgeDir, "repos", "network", "roce", "loss.md")})`);
    expect(out.indexOf("## Verified Fast Routes")).toBeLessThan(out.indexOf("# Knowledge Index"));
  });

  it("ignores an unterminated verified-route block", () => {
    const index = [
      "# Catalog",
      "<!-- verified-routes:begin -->",
      "- **Incomplete** → [page](page.md)",
    ].join("\n");
    fs.writeFileSync(path.join(knowledgeDir, "index.md"), index);

    const out = buildKnowledgeWikiCatalog(knowledgeDir);

    expect(out).not.toContain("## Verified Fast Routes");
    expect(out).toContain(index);
  });

  it("leaves scheme, absolute, and anchor links wrapped in angle brackets untouched", () => {
    // The angle-bracket unwrap must not let a wrapped external URL, absolute
    // path, or anchor slip past the guards and get rewritten into the mount.
    const routeBlock = [
      "<!-- verified-routes:begin -->",
      "## 已验证快速路由",
      "",
      "- **External** → [docs](<https://docs.feishu.cn/wiki/abc>)",
      "- **Absolute** → [passwd](</etc/passwd>)",
      "- **Anchor** → [top](<#heading>)",
      "- **Relative** → [xid](<gpu/xid.md>)",
      "<!-- verified-routes:end -->",
    ].join("\n");
    fs.writeFileSync(path.join(knowledgeDir, "index.md"), `# Catalog\n\n${routeBlock}\n`);

    const out = buildKnowledgeWikiCatalog(knowledgeDir);

    expect(out).toContain("[docs](<https://docs.feishu.cn/wiki/abc>)");
    expect(out).toContain("[passwd](</etc/passwd>)");
    expect(out).toContain("[top](<#heading>)");
    expect(out).not.toContain("https:/docs.feishu.cn"); // no // → / collapse from a join
    expect(out).not.toContain(path.join(knowledgeDir, "etc", "passwd"));
    // A genuinely relative wrapped link is still rewritten to a Read-ready path.
    expect(out).toContain(`[xid](<${path.join(knowledgeDir, "gpu", "xid.md")}>)`);
  });

  it("does not treat a fenced example marker as the real route block", () => {
    // box_role.md teaches the marker to the authoring agent, so a fenced
    // example carrying a lone :begin is plausible. Matching it and then the
    // real :end would delete every catalog entry in between.
    const index = [
      "# Catalog",
      "",
      "How the block looks in a compiled index:",
      "",
      "~~~md",
      "<!-- verified-routes:begin -->",
      "example only",
      "~~~",
      "",
      "- [Keep me](pages/keep.md) — a catalog entry that must survive",
      "",
      "<!-- verified-routes:begin -->",
      "## 已验证快速路由",
      "",
      "- **Real route** → [gpu/xid.md](gpu/xid.md)",
      "<!-- verified-routes:end -->",
    ].join("\n");
    fs.writeFileSync(path.join(knowledgeDir, "index.md"), `${index}\n`);

    const out = buildKnowledgeWikiCatalog(knowledgeDir);

    expect(out).toContain("## Verified Fast Routes");
    expect(out).toContain("Real route");
    expect(out).toContain(`[gpu/xid.md](${path.join(knowledgeDir, "gpu", "xid.md")})`);
    expect(out).toContain("- [Keep me](pages/keep.md)"); // the catalog was not swallowed
  });
});
