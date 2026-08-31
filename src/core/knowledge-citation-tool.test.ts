import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildKnowledgeCitationSystemPrompt,
  createKnowledgeCitationSupport,
  EVIDENCE_MARKER,
  EVIDENCE_MARKER_START,
  KNOWLEDGE_CITATION_MANIFEST,
  maskMarkdownCode,
  normalizedResource,
} from "./knowledge-citation-tool.js";
import {
  MAX_EVIDENCE_SOURCES_PER_MARKER,
  MAX_KNOWLEDGE_CITATIONS,
} from "../shared/knowledge-citations.js";

describe("knowledge_cite", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

  function readPage(
    support: {
      captureMount: () => { readonly json: string };
      noteRead: (pagePath: string, content: string, start: { readonly json: string }) => void;
    },
    page: string,
    content = fs.readFileSync(page, "utf8"),
  ) {
    support.noteRead(page, content, support.captureMount());
  }

  function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-cite-"));
    dirs.push(dir);
    const page = path.join(dir, "guide.md");
    fs.writeFileSync(page, "---\nsources:\n  - resource: raw/feishu/runbook.md\n---\n# Guide\n");
    fs.writeFileSync(path.join(dir, KNOWLEDGE_CITATION_MANIFEST), JSON.stringify({
      version: 1,
      repos: [{ id: "repo", root: "", sources: [{
        resource: "feishu/runbook.md", title: "GPU Runbook", url: "https://docs.feishu.cn/wiki/abc",
      }] }],
    }));
    return { dir, page };
  }

  it("emits only sources from pages successfully read in the current turn", async () => {
    const { dir, page } = fixture();
    const events: Record<string, unknown>[] = [];
    const turnRef = { current: 1 };
    const support = createKnowledgeCitationSupport({ knowledgeDir: dir, turnRef, sessionEventEmitter: (e) => events.push(e) });
    readPage(support, page);
    const output = await support.tool.execute("call", { pages: [page] } as never);
    expect(output.details).toEqual({ cited: 1 });
    expect(events).toEqual([{ type: "knowledge_sources", sources: [{
      title: "GPU Runbook", url: "https://docs.feishu.cn/wiki/abc", resource: "feishu/runbook.md", page: "guide.md",
    }] }]);

    turnRef.current = 2;
    const unread = await support.tool.execute("call", { pages: [page] } as never);
    expect(unread.details).toEqual({ cited: 0 });
    expect(events).toHaveLength(1);
  });

  it.each([
    { rel: "index.md", body: "# Root index\n" },
    { rel: "运维/_index.md", body: "# Operations index\n" },
    { rel: "catalog.md", body: "---\ntype: index\n---\n# Catalog\n" },
  ])("rejects navigation page citations for $rel", async ({ rel, body }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-cite-navigation-"));
    dirs.push(dir);
    const page = path.join(dir, rel);
    fs.mkdirSync(path.dirname(page), { recursive: true });
    fs.writeFileSync(page, `---\nsources:\n  - resource: raw/runbook.md\n${body.startsWith("---") ? "" : "---\n"}${body}`);
    // catalog.md needs one valid frontmatter block, not nested frontmatter.
    if (rel === "catalog.md") {
      fs.writeFileSync(page, "---\ntype: index\nsources:\n  - resource: raw/runbook.md\n---\n# Catalog\n");
    }
    fs.writeFileSync(path.join(dir, KNOWLEDGE_CITATION_MANIFEST), JSON.stringify({
      version: 1,
      repos: [{ id: "repo", root: "", sources: [{
        resource: "runbook.md", title: "Runbook", url: "https://docs.feishu.cn/wiki/runbook",
      }] }],
    }));
    const events: Record<string, unknown>[] = [];
    const support = createKnowledgeCitationSupport({
      knowledgeDir: dir,
      turnRef: { current: 1 },
      sessionEventEmitter: (event) => events.push(event),
    });
    readPage(support, page);

    const output = await support.tool.execute("call", { pages: [rel] } as never);
    expect((output.content[0] as { text: string }).text).toContain("Cannot cite navigation page");
    expect(output.details).toMatchObject({ cited: 0 });
    expect(events).toEqual([]);
  });

  it("rejects evidence refs on navigation pages before emitting any source", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-cite-navigation-evidence-"));
    dirs.push(dir);
    const page = path.join(dir, "_index.md");
    fs.writeFileSync(page, `---
sources:
  - id: src-runbook
    resource: raw/runbook.md
---
<!-- okf:evidence {"id":"entry","sources":["src-runbook"]} -->
# Index
`);
    fs.writeFileSync(path.join(dir, KNOWLEDGE_CITATION_MANIFEST), JSON.stringify({
      version: 1,
      repos: [{ id: "repo", root: "", sources: [{
        sourceId: "src-runbook",
        resource: "runbook.md",
        title: "Runbook",
        url: "https://docs.feishu.cn/wiki/runbook",
      }] }],
    }));
    const events: Record<string, unknown>[] = [];
    const support = createKnowledgeCitationSupport({
      knowledgeDir: dir,
      turnRef: { current: 1 },
      sessionEventEmitter: (event) => events.push(event),
    });
    readPage(support, page);

    const output = await support.tool.execute("call", { evidence_refs: ["_index.md#entry"] } as never);
    expect((output.content[0] as { text: string }).text).toContain("Cannot cite navigation pages");
    expect(output.details).toMatchObject({ cited: 0, unresolved: ["_index.md#entry"] });
    expect(events).toEqual([]);
  });

  it("resolves evidence refs to the exact source used instead of the first page source", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-cite-evidence-"));
    dirs.push(dir);
    const page = path.join(dir, "entities", "GB-supernode.md");
    fs.mkdirSync(path.dirname(page), { recursive: true });
    fs.writeFileSync(page, `---
sources:
  - id: src-gb300-performance
    resource: raw/benchmarks/gb300-performance.md
  - id: src-asus-sales-kit
    resource: raw/specs/GB3XX-ASUS-sales-kit.md
---
# GB300

<!-- okf:evidence {"id":"ev.gb300.asus.rack-power-ports","sources":["src-asus-sales-kit"]} -->

## ASUS rack

The rack power budget and port inventory come from the ASUS sales kit.
`);
    fs.writeFileSync(path.join(dir, KNOWLEDGE_CITATION_MANIFEST), JSON.stringify({
      version: 1,
      repos: [{ id: "repo", root: "", sources: [
        {
          sourceId: "src-gb300-performance",
          resource: "benchmarks/gb300-performance.md",
          title: "GB300 performance report",
          url: "https://docs.feishu.cn/wiki/performance",
        },
        {
          sourceId: "src-asus-sales-kit",
          resource: "specs/GB3XX-ASUS-sales-kit.md",
          title: "GB3XX-ASUS product manual 2",
          url: "https://acnizrso7ikb.feishu.cn/wiki/NMWWw0WEOiyXcekQh3hcCQTVnff",
        },
      ] }],
    }));
    const events: Record<string, unknown>[] = [];
    const support = createKnowledgeCitationSupport({
      knowledgeDir: dir,
      turnRef: { current: 1 },
      sessionEventEmitter: (event) => events.push(event),
    });
    readPage(support, page);

    await expect(support.tool.execute("call", {
      evidence_refs: ["entities/GB-supernode.md#ev.gb300.asus.rack-power-ports"],
    } as never)).resolves.toMatchObject({
      details: { cited: 1, unresolved: [] },
    });
    expect(events).toEqual([{ type: "knowledge_sources", sources: [{
      title: "GB3XX-ASUS product manual 2",
      url: "https://acnizrso7ikb.feishu.cn/wiki/NMWWw0WEOiyXcekQh3hcCQTVnff",
      resource: "specs/GB3XX-ASUS-sales-kit.md",
      sourceId: "src-asus-sales-kit",
      page: "entities/GB-supernode.md",
      evidence: "ev.gb300.asus.rack-power-ports",
    }] }]);
  });

  it("fails closed when an evidence source has no frozen original mapping", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-cite-unresolved-"));
    dirs.push(dir);
    const page = path.join(dir, "guide.md");
    fs.writeFileSync(page, `---
sources:
  - id: src-missing
    resource: raw/missing.md
---
<!-- okf:evidence {"id":"ev.missing","sources":["src-missing"]} -->
# Guide
`);
    fs.writeFileSync(path.join(dir, KNOWLEDGE_CITATION_MANIFEST), JSON.stringify({
      version: 1,
      repos: [{ id: "repo", root: "", sources: [] }],
    }));
    const events: Record<string, unknown>[] = [];
    const support = createKnowledgeCitationSupport({
      knowledgeDir: dir,
      turnRef: { current: 1 },
      sessionEventEmitter: (event) => events.push(event),
    });
    readPage(support, page);

    await expect(support.tool.execute("call", {
      evidence_refs: ["guide.md#ev.missing"],
    } as never)).resolves.toMatchObject({
      details: { cited: 0, unresolved: ["guide.md#ev.missing"] },
    });
    expect(events).toEqual([]);
  });

  it("fails closed on malformed or over-specified evidence markers", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-cite-malformed-evidence-"));
    dirs.push(dir);
    const page = path.join(dir, "guide.md");
    fs.writeFileSync(page, `---
sources:
  - id: src-runbook
    resource: raw/runbook.md
---
<!-- okf:evidence {"id":"ev.runbook","sources":["src-runbook"],"unexpected":true} -->
# Guide
`);
    fs.writeFileSync(path.join(dir, KNOWLEDGE_CITATION_MANIFEST), JSON.stringify({
      version: 1,
      repos: [{ id: "repo", root: "", sources: [{
        sourceId: "src-runbook",
        resource: "runbook.md",
        title: "Runbook",
        url: "https://docs.feishu.cn/wiki/Runbook",
      }] }],
    }));
    const events: Record<string, unknown>[] = [];
    const support = createKnowledgeCitationSupport({
      knowledgeDir: dir,
      turnRef: { current: 1 },
      sessionEventEmitter: (event) => events.push(event),
    });
    readPage(support, page);

    await expect(support.tool.execute("call", {
      evidence_refs: ["guide.md#ev.runbook"],
    } as never)).resolves.toMatchObject({
      details: { cited: 0, unresolved: ["guide.md#ev.runbook"] },
    });
    expect(events).toEqual([]);
  });

  it("switches prompt guidance when a manifest appears on a warm session reload", () => {
    const { dir } = fixture();
    const manifestPath = path.join(dir, KNOWLEDGE_CITATION_MANIFEST);
    const manifest = fs.readFileSync(manifestPath, "utf8");
    fs.rmSync(manifestPath);

    expect(buildKnowledgeCitationSystemPrompt(dir)).toContain("Do not call `knowledge_cite`");

    fs.writeFileSync(manifestPath, manifest);
    expect(buildKnowledgeCitationSystemPrompt(dir)).toContain(
      "call `knowledge_cite` once after research",
    );
  });

  it("cites the Read snapshot after the page file is deleted", async () => {
    const { dir, page } = fixture();
    const events: Record<string, unknown>[] = [];
    const support = createKnowledgeCitationSupport({
      knowledgeDir: dir,
      turnRef: { current: 1 },
      sessionEventEmitter: (event) => events.push(event),
    });
    readPage(support, page);
    fs.rmSync(page);

    await expect(support.tool.execute("call", { pages: [page] } as never)).resolves.toMatchObject({
      details: { cited: 1 },
    });
    expect(events).toHaveLength(1);
  });

  it("ignores a later disk rewrite of a page that was already Read", async () => {
    const { dir, page } = fixture();
    const events: Record<string, unknown>[] = [];
    const support = createKnowledgeCitationSupport({
      knowledgeDir: dir,
      turnRef: { current: 1 },
      sessionEventEmitter: (event) => events.push(event),
    });
    readPage(support, page);
    fs.writeFileSync(page, "---\nsources: [\n---\n# Broken\n");

    await expect(support.tool.execute("call", { pages: [page] } as never)).resolves.toMatchObject({
      details: { cited: 1 },
    });
    expect(events).toHaveLength(1);
  });

  it("uses the most specific repository root when manifests overlap", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-cite-roots-"));
    dirs.push(dir);
    const page = path.join(dir, "repos", "specific", "guide.md");
    fs.mkdirSync(path.dirname(page), { recursive: true });
    fs.writeFileSync(page, "---\nsources:\n  - resource: raw/runbook.md\n---\n# Guide\n");
    fs.writeFileSync(path.join(dir, KNOWLEDGE_CITATION_MANIFEST), JSON.stringify({
      version: 1,
      repos: [
        { id: "fallback", root: "", sources: [
          { resource: "runbook.md", title: "Wrong fallback", url: "https://example.com/wrong" },
        ] },
        { id: "specific", root: "repos/specific", sources: [
          { resource: "runbook.md", title: "Specific", url: "https://example.com/specific" },
        ] },
      ],
    }));
    const events: Record<string, unknown>[] = [];
    const support = createKnowledgeCitationSupport({
      knowledgeDir: dir,
      turnRef: { current: 1 },
      sessionEventEmitter: (event) => events.push(event),
    });
    readPage(support, page);

    await expect(support.tool.execute("call", { pages: [page] } as never)).resolves.toMatchObject({
      details: { cited: 1 },
    });
    expect(events).toEqual([{ type: "knowledge_sources", sources: [{
      title: "Specific",
      url: "https://example.com/specific",
      resource: "runbook.md",
      page: "repos/specific/guide.md",
    }] }]);
  });

  it("keeps the compiler and runtime on one marker grammar", () => {
    const fixtures = JSON.parse(fs.readFileSync(
      path.join(import.meta.dirname, "../../docs/design/okf-evidence-marker-fixtures.json"),
      "utf8",
    )) as {
      pattern: string;
      start_pattern: string;
      max_sources: number;
      cases: Array<{ id: string; body: string; recognized: boolean }>;
    };
    expect(EVIDENCE_MARKER.source).toBe(fixtures.pattern);
    expect(EVIDENCE_MARKER_START.source).toBe(fixtures.start_pattern);
    expect(MAX_EVIDENCE_SOURCES_PER_MARKER).toBe(fixtures.max_sources);
    expect(fs.readFileSync(path.join(import.meta.dirname, "../../kbc/platform/pod/selfcheck.py"), "utf8"))
      .toContain(`_MAX_EVIDENCE_SOURCES = ${fixtures.max_sources}`);

    for (const fixture of fixtures.cases) {
      EVIDENCE_MARKER.lastIndex = 0;
      EVIDENCE_MARKER_START.lastIndex = 0;
      const scan = maskMarkdownCode(fixture.body);
      const start = scan.match(EVIDENCE_MARKER_START)?.length ?? 0;
      const full = [...scan.matchAll(EVIDENCE_MARKER)].length;
      expect({ id: fixture.id, start, full }, fixture.id).toEqual({
        id: fixture.id,
        start: fixture.recognized ? 1 : 0,
        full: fixture.recognized ? 1 : 0,
      });
    }
  });

  it("cites a good marker even when the same page has a newline-broken comment", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-cite-newline-junk-"));
    dirs.push(dir);
    const page = path.join(dir, "guide.md");
    fs.writeFileSync(page, `---
sources:
  - id: src-runbook
    resource: raw/runbook.md
---
<!-- okf:evidence {"id":"good","sources":["src-runbook"]} -->
<!--
okf:evidence NOT-JSON
-->
# Guide
`);
    fs.writeFileSync(path.join(dir, KNOWLEDGE_CITATION_MANIFEST), JSON.stringify({
      version: 1,
      repos: [{ id: "repo", root: "", sources: [{
        sourceId: "src-runbook",
        resource: "runbook.md",
        title: "Runbook",
        url: "https://docs.feishu.cn/wiki/Runbook",
      }] }],
    }));
    const events: Record<string, unknown>[] = [];
    const support = createKnowledgeCitationSupport({
      knowledgeDir: dir,
      turnRef: { current: 1 },
      sessionEventEmitter: (event) => events.push(event),
    });
    readPage(support, page);

    await expect(support.tool.execute("call", {
      evidence_refs: ["guide.md#good"],
    } as never)).resolves.toMatchObject({
      details: { cited: 1, unresolved: [] },
    });
    expect(events).toHaveLength(1);
  });

  it("merges evidence refs and unmarked pages in one call", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-cite-mixed-"));
    dirs.push(dir);
    const marked = path.join(dir, "guide.md");
    const legacy = path.join(dir, "legacy.md");
    fs.writeFileSync(marked, `---
sources:
  - id: src-runbook
    resource: raw/runbook.md
---
<!-- okf:evidence {"id":"good","sources":["src-runbook"]} -->
# Guide
`);
    fs.writeFileSync(legacy, "---\nsources:\n  - resource: raw/policy.md\n---\n# Policy\n");
    fs.writeFileSync(path.join(dir, KNOWLEDGE_CITATION_MANIFEST), JSON.stringify({
      version: 1,
      repos: [{ id: "repo", root: "", sources: [
        {
          sourceId: "src-runbook",
          resource: "runbook.md",
          title: "Runbook",
          url: "https://docs.feishu.cn/wiki/Runbook",
        },
        {
          resource: "policy.md",
          title: "Policy",
          url: "https://docs.feishu.cn/wiki/Policy",
        },
      ] }],
    }));
    const events: Record<string, unknown>[] = [];
    const support = createKnowledgeCitationSupport({
      knowledgeDir: dir,
      turnRef: { current: 1 },
      sessionEventEmitter: (event) => events.push(event),
    });
    readPage(support, marked);
    readPage(support, legacy);

    await expect(support.tool.execute("call", {
      evidence_refs: ["guide.md#good"],
      pages: ["legacy.md"],
    } as never)).resolves.toMatchObject({
      details: { cited: 2, unresolved: [] },
    });
    expect(events[0]).toMatchObject({
      type: "knowledge_sources",
      sources: [
        { title: "Runbook", evidence: "good" },
        { title: "Policy", page: "legacy.md" },
      ],
    });
    expect(buildKnowledgeCitationSystemPrompt(dir)).toContain("pass those as `pages` in the same call");
  });

  it("rejects citing a marked page through the legacy pages parameter", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-cite-marked-via-pages-"));
    dirs.push(dir);
    const page = path.join(dir, "guide.md");
    fs.writeFileSync(page, `---
sources:
  - id: src-runbook
    resource: raw/runbook.md
---
<!-- okf:evidence {"id":"good","sources":["src-runbook"]} -->
# Guide
`);
    fs.writeFileSync(path.join(dir, KNOWLEDGE_CITATION_MANIFEST), JSON.stringify({
      version: 1,
      repos: [{ id: "repo", root: "", sources: [{
        sourceId: "src-runbook",
        resource: "runbook.md",
        title: "Runbook",
        url: "https://docs.feishu.cn/wiki/Runbook",
      }] }],
    }));
    const events: Record<string, unknown>[] = [];
    const support = createKnowledgeCitationSupport({
      knowledgeDir: dir,
      turnRef: { current: 1 },
      sessionEventEmitter: (event) => events.push(event),
    });
    readPage(support, page);

    await expect(support.tool.execute("call", {
      pages: ["guide.md"],
    } as never)).resolves.toMatchObject({
      details: { cited: 0 },
    });
    expect(events).toEqual([]);
  });

  it("deduplicates two source ids inside one marker that share a URL", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-cite-dup-url-"));
    dirs.push(dir);
    const page = path.join(dir, "guide.md");
    fs.writeFileSync(page, `---
sources:
  - id: src-a
    resource: raw/a.md
  - id: src-b
    resource: raw/b.md
---
<!-- okf:evidence {"id":"both","sources":["src-a","src-b"]} -->
# Guide
`);
    fs.writeFileSync(path.join(dir, KNOWLEDGE_CITATION_MANIFEST), JSON.stringify({
      version: 1,
      repos: [{ id: "repo", root: "", sources: [
        { sourceId: "src-a", resource: "a.md", title: "A", url: "https://docs.feishu.cn/wiki/same" },
        { sourceId: "src-b", resource: "b.md", title: "B", url: "https://docs.feishu.cn/wiki/same" },
      ] }],
    }));
    const events: Record<string, unknown>[] = [];
    const support = createKnowledgeCitationSupport({
      knowledgeDir: dir,
      turnRef: { current: 1 },
      sessionEventEmitter: (event) => events.push(event),
    });
    readPage(support, page);

    await expect(support.tool.execute("call", {
      evidence_refs: ["guide.md#both"],
    } as never)).resolves.toMatchObject({
      details: { cited: 1, unresolved: [] },
    });
    expect((events[0] as { sources: unknown[] }).sources).toHaveLength(1);
  });

  it("keeps the transport ceiling separate from the per-marker source cap", () => {
    expect(MAX_KNOWLEDGE_CITATIONS).toBe(8);
    expect(MAX_EVIDENCE_SOURCES_PER_MARKER).toBe(8);
  });

  it("fails closed when mixed pages would add a ninth original source", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-cite-cap-"));
    dirs.push(dir);
    const sources = Array.from({ length: 8 }, (_, index) => ({
      id: `src-${index + 1}`,
      resource: `raw/s${index + 1}.md`,
    }));
    const sourceIds = sources.map((source) => source.id);
    const marked = path.join(dir, "guide.md");
    const legacy = path.join(dir, "legacy.md");
    fs.writeFileSync(marked, `---
sources:
${sources.map((source) => `  - id: ${source.id}\n    resource: ${source.resource}`).join("\n")}
---
<!-- okf:evidence {"id":"all","sources":${JSON.stringify(sourceIds)}} -->
# Guide
`);
    fs.writeFileSync(legacy, "---\nsources:\n  - resource: raw/extra.md\n---\n# Extra\n");
    fs.writeFileSync(path.join(dir, KNOWLEDGE_CITATION_MANIFEST), JSON.stringify({
      version: 1,
      repos: [{ id: "repo", root: "", sources: [
        ...sources.map((source, index) => ({
          sourceId: source.id,
          resource: `s${index + 1}.md`,
          title: `S${index + 1}`,
          url: `https://docs.feishu.cn/wiki/s${index + 1}`,
        })),
        { resource: "extra.md", title: "Extra", url: "https://docs.feishu.cn/wiki/extra" },
      ] }],
    }));
    const events: Record<string, unknown>[] = [];
    const support = createKnowledgeCitationSupport({
      knowledgeDir: dir,
      turnRef: { current: 1 },
      sessionEventEmitter: (event) => events.push(event),
    });
    readPage(support, marked);
    readPage(support, legacy);
    await expect(support.tool.execute("call", {
      evidence_refs: ["guide.md#all"],
      pages: ["legacy.md"],
    } as never)).resolves.toMatchObject({
      content: [{
        type: "text",
        text: "Evidence resolves to more than 8 original sources; split the answer instead of truncating citations.",
      }],
      details: { cited: 0, unresolved: ["guide.md#all"] },
    });
    expect(events).toEqual([]);
  });

  it("does not treat a fenced example marker as citable evidence", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-cite-fence-"));
    dirs.push(dir);
    const page = path.join(dir, "guide.md");
    fs.writeFileSync(page, [
      "---",
      "sources:",
      "  - id: src-runbook",
      "    resource: raw/runbook.md",
      "---",
      "```",
      "<!-- okf:evidence {\"id\":\"example\",\"sources\":[\"src-runbook\"]} -->",
      "```",
      "# Guide",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(dir, KNOWLEDGE_CITATION_MANIFEST), JSON.stringify({
      version: 1,
      repos: [{ id: "repo", root: "", sources: [{
        sourceId: "src-runbook",
        resource: "runbook.md",
        title: "Runbook",
        url: "https://docs.feishu.cn/wiki/Runbook",
      }] }],
    }));
    const events: Record<string, unknown>[] = [];
    const support = createKnowledgeCitationSupport({
      knowledgeDir: dir,
      turnRef: { current: 1 },
      sessionEventEmitter: (event) => events.push(event),
    });
    readPage(support, page);
    await expect(support.tool.execute("call", {
      evidence_refs: ["guide.md#example"],
    } as never)).resolves.toMatchObject({
      details: { cited: 0, unresolved: ["guide.md#example"] },
    });
    expect(events).toEqual([]);
  });

  it("cites the Read-time source after a mid-turn knowledge reload", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-cite-reload-"));
    dirs.push(dir);
    const page = path.join(dir, "guide.md");
    const writePage = (sourceId: string, resource: string) => {
      fs.writeFileSync(page, `---
sources:
  - id: ${sourceId}
    resource: ${resource}
---
<!-- okf:evidence {"id":"claim","sources":["${sourceId}"]} -->
# Guide
`);
    };
    const writeManifest = (sourceId: string, resource: string, title: string, url: string) => {
      fs.writeFileSync(path.join(dir, KNOWLEDGE_CITATION_MANIFEST), JSON.stringify({
        version: 1,
        repos: [{ id: "repo", root: "", sources: [{ sourceId, resource, title, url }] }],
      }));
    };
    writePage("src-a", "raw/a.md");
    writeManifest("src-a", "a.md", "Source A", "https://docs.feishu.cn/wiki/a");
    const events: Record<string, unknown>[] = [];
    const support = createKnowledgeCitationSupport({
      knowledgeDir: dir,
      turnRef: { current: 1 },
      sessionEventEmitter: (event) => events.push(event),
    });
    readPage(support, page);
    writePage("src-b", "raw/b.md");
    writeManifest("src-b", "b.md", "Source B", "https://docs.feishu.cn/wiki/b");
    await expect(support.tool.execute("call", {
      evidence_refs: ["guide.md#claim"],
    } as never)).resolves.toMatchObject({
      details: { cited: 1, unresolved: [] },
    });
    expect(events[0]).toMatchObject({
      sources: [{ title: "Source A", url: "https://docs.feishu.cn/wiki/a", sourceId: "src-a" }],
    });
  });

  it("cites the bytes passed to noteRead even when disk already shows another page", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-cite-passed-bytes-"));
    dirs.push(dir);
    const page = path.join(dir, "guide.md");
    const pageA = `---
sources:
  - id: src-a
    resource: raw/a.md
---
<!-- okf:evidence {"id":"claim","sources":["src-a"]} -->
# Guide
`;
    const pageB = `---
sources:
  - id: src-b
    resource: raw/b.md
---
<!-- okf:evidence {"id":"claim","sources":["src-b"]} -->
# Guide
`;
    fs.writeFileSync(page, pageB);
    fs.writeFileSync(path.join(dir, KNOWLEDGE_CITATION_MANIFEST), JSON.stringify({
      version: 1,
      repos: [{ id: "repo", root: "", sources: [{
        sourceId: "src-a", resource: "a.md", title: "Source A", url: "https://docs.feishu.cn/wiki/a",
      }] }],
    }));
    const events: Record<string, unknown>[] = [];
    const support = createKnowledgeCitationSupport({
      knowledgeDir: dir,
      turnRef: { current: 1 },
      sessionEventEmitter: (event) => events.push(event),
    });
    readPage(support, page, pageA);
    await expect(support.tool.execute("call", {
      evidence_refs: ["guide.md#claim"],
    } as never)).resolves.toMatchObject({
      details: { cited: 1, unresolved: [] },
    });
    expect(events[0]).toMatchObject({
      sources: [{ title: "Source A", url: "https://docs.feishu.cn/wiki/a", sourceId: "src-a" }],
    });
  });

  it("does not pair Read bytes with a remount that landed during the Read", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-cite-read-race-"));
    dirs.push(dir);
    const page = path.join(dir, "guide.md");
    const pageA = `---
sources:
  - id: src-1
    resource: raw/doc.md
---
<!-- okf:evidence {"id":"claim","sources":["src-1"]} -->
# Guide
`;
    fs.writeFileSync(page, pageA);
    fs.writeFileSync(path.join(dir, KNOWLEDGE_CITATION_MANIFEST), JSON.stringify({
      version: 1,
      repos: [{ id: "repo", root: "", sources: [{
        sourceId: "src-1", resource: "doc.md", title: "Source A", url: "https://docs.feishu.cn/wiki/a",
      }] }],
    }));
    const events: Record<string, unknown>[] = [];
    const support = createKnowledgeCitationSupport({
      knowledgeDir: dir,
      turnRef: { current: 1 },
      sessionEventEmitter: (event) => events.push(event),
    });
    const startA = support.captureMount();
    fs.writeFileSync(path.join(dir, KNOWLEDGE_CITATION_MANIFEST), JSON.stringify({
      version: 1,
      repos: [{ id: "repo", root: "", sources: [{
        sourceId: "src-1", resource: "doc.md", title: "Source B", url: "https://docs.feishu.cn/wiki/b",
      }] }],
    }));
    support.noteRead(page, pageA, startA);
    await expect(support.tool.execute("call", {
      evidence_refs: ["guide.md#claim"],
    } as never)).resolves.toMatchObject({
      details: { cited: 0, unresolved: ["guide.md#claim"] },
    });
    expect(events).toEqual([]);
  });

  it("drops a prior snapshot when a later Read of the same page races the remount", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-cite-stale-after-race-"));
    dirs.push(dir);
    const page = path.join(dir, "guide.md");
    const writePage = (sourceId: string, resource: string) => `---
sources:
  - id: ${sourceId}
    resource: ${resource}
---
<!-- okf:evidence {"id":"claim","sources":["${sourceId}"]} -->
# Guide
`;
    const writeManifest = (title: string, url: string) => {
      fs.writeFileSync(path.join(dir, KNOWLEDGE_CITATION_MANIFEST), JSON.stringify({
        version: 1,
        repos: [{ id: "repo", root: "", sources: [{
          sourceId: "src-1", resource: "doc.md", title, url,
        }] }],
      }));
    };
    const pageA = writePage("src-1", "raw/doc.md");
    const pageB = writePage("src-1", "raw/doc.md");
    fs.writeFileSync(page, pageA);
    writeManifest("Source A", "https://docs.feishu.cn/wiki/a");
    const events: Record<string, unknown>[] = [];
    const support = createKnowledgeCitationSupport({
      knowledgeDir: dir,
      turnRef: { current: 1 },
      sessionEventEmitter: (event) => events.push(event),
    });
    readPage(support, page, pageA);
    const startA = support.captureMount();
    writeManifest("Source B", "https://docs.feishu.cn/wiki/b");
    fs.writeFileSync(page, pageB);
    support.noteRead(page, pageB, startA);
    await expect(support.tool.execute("call", {
      evidence_refs: ["guide.md#claim"],
    } as never)).resolves.toMatchObject({
      details: { cited: 0, unresolved: ["guide.md#claim"] },
    });
    expect(events).toEqual([]);
    readPage(support, page, pageB);
    await expect(support.tool.execute("call", {
      evidence_refs: ["guide.md#claim"],
    } as never)).resolves.toMatchObject({
      details: { cited: 1, unresolved: [] },
    });
    expect(events[0]).toMatchObject({
      sources: [{ title: "Source B", url: "https://docs.feishu.cn/wiki/b", sourceId: "src-1" }],
    });
  });

  it("re-pins on a later consistent Read so the model can cite in the same turn", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-cite-repin-"));
    dirs.push(dir);
    const first = path.join(dir, "first.md");
    const second = path.join(dir, "second.md");
    fs.writeFileSync(first, `---
sources:
  - id: src-a
    resource: raw/a.md
---
<!-- okf:evidence {"id":"claim","sources":["src-a"]} -->
# First
`);
    fs.writeFileSync(path.join(dir, KNOWLEDGE_CITATION_MANIFEST), JSON.stringify({
      version: 1,
      repos: [{ id: "repo", root: "", sources: [{
        sourceId: "src-a", resource: "a.md", title: "Source A", url: "https://docs.feishu.cn/wiki/a",
      }] }],
    }));
    const events: Record<string, unknown>[] = [];
    const support = createKnowledgeCitationSupport({
      knowledgeDir: dir,
      turnRef: { current: 1 },
      sessionEventEmitter: (event) => events.push(event),
    });
    readPage(support, first);
    fs.writeFileSync(second, `---
sources:
  - id: src-b
    resource: raw/b.md
---
<!-- okf:evidence {"id":"claim","sources":["src-b"]} -->
# Second
`);
    fs.writeFileSync(path.join(dir, KNOWLEDGE_CITATION_MANIFEST), JSON.stringify({
      version: 1,
      repos: [{ id: "repo", root: "", sources: [{
        sourceId: "src-b", resource: "b.md", title: "Source B", url: "https://docs.feishu.cn/wiki/b",
      }] }],
    }));
    readPage(support, second);
    await expect(support.tool.execute("call", {
      evidence_refs: ["first.md#claim"],
    } as never)).resolves.toMatchObject({
      details: { cited: 0, unresolved: ["first.md#claim"] },
    });
    await expect(support.tool.execute("call", {
      evidence_refs: ["second.md#claim"],
    } as never)).resolves.toMatchObject({
      details: { cited: 1, unresolved: [] },
    });
    expect(events[0]).toMatchObject({
      sources: [{ title: "Source B", url: "https://docs.feishu.cn/wiki/b", sourceId: "src-b" }],
    });
  });

  it("normalizes drop/ and keeps a leading slash from matching a relative path", () => {
    expect(normalizedResource("drop/foo.md")).toBe("foo.md");
    expect(normalizedResource("raw/foo.md")).toBe("foo.md");
    expect(normalizedResource("/foo.md")).toBe("/foo.md");
  });
});
