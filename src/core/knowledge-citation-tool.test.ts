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
    const output = await support.tool.execute("call", { pages: [{ path: page, claim: "The runbook documents the GPU reset procedure." }] } as never);
    expect(output.details).toEqual({ cited: 1 });
    expect(events).toEqual([{ type: "knowledge_sources", sources: [{
      title: "GPU Runbook", url: "https://docs.feishu.cn/wiki/abc", resource: "feishu/runbook.md", page: "guide.md",
    }] }]);

    turnRef.current = 2;
    const unread = await support.tool.execute("call", { pages: [{ path: page, claim: "The runbook documents the GPU reset procedure." }] } as never);
    expect(unread.details).toEqual({ cited: 0 });
    expect(events).toHaveLength(1);
  });

  it("tolerates a mount-prefixed relative path copied from the model's own read call", async () => {
    const { dir, page } = fixture();
    const events: Record<string, unknown>[] = [];
    const support = createKnowledgeCitationSupport({ knowledgeDir: dir, turnRef: { current: 1 }, sessionEventEmitter: (e) => events.push(e) });
    readPage(support, page);
    // The model echoes the mount prefix it saw in its read tool call.
    const prefixed = `.siclaw/knowledge/${path.basename(page)}`;
    const output = await support.tool.execute("call", { pages: [{ path: prefixed, claim: "The runbook documents the GPU reset procedure." }] } as never);
    expect(output.details).toEqual({ cited: 1 });
    expect(events).toHaveLength(1);
    // Stripping never invents a read: an unread page stays unread however it is spelled.
    const unread = await support.tool.execute("call", { pages: [{ path: ".siclaw/knowledge/other.md", claim: "The runbook documents the GPU reset procedure." }] } as never);
    expect(unread.details).toEqual({ cited: 0 });
    expect(JSON.stringify(unread)).toContain("Cannot cite unread knowledge page");
  });

  it("rejects pages items that are not bound to a concrete claim", async () => {
    const { dir, page } = fixture();
    const events: Record<string, unknown>[] = [];
    const support = createKnowledgeCitationSupport({
      knowledgeDir: dir,
      turnRef: { current: 1 },
      sessionEventEmitter: (event) => events.push(event),
    });
    readPage(support, page);

    // The legacy bare-string form and an empty claim are the same padding
    // shape: provenance validates identically for a read-but-unused page, so
    // the claim is the only cited-vs-read distinction the runtime can demand.
    // The rejection must SAY that nothing was registered and how to retry —
    // unlike overflow, a shape error is fixable, so fail-closed is honest
    // here as long as the guidance does not loop.
    for (const pages of [[page], [{ path: page, claim: "" }], [{ path: page, claim: "   " }]]) {
      const output = await support.tool.execute("call", { pages } as never);
      const text = (output.content[0] as { text: string }).text;
      expect(text).toContain("requires { path, claim }");
      expect(text).toContain("No citations were registered, including any evidence_refs");
      expect(text).toContain("Retry knowledge_cite once");
      expect(output.details).toEqual({ cited: 0 });
    }

    // A broken PATH must be diagnosed as such — "(missing claim)" on a
    // wrong-key item sends the retry at the wrong field and loops.
    for (const item of [
      { page: page, claim: "The runbook documents the GPU reset procedure." },
      { path: "   ", claim: "The runbook documents the GPU reset procedure." },
      { path: 42, claim: "The runbook documents the GPU reset procedure." },
    ]) {
      const output = await support.tool.execute("call", { pages: [item] } as never);
      const text = (output.content[0] as { text: string }).text;
      expect(text).toContain("missing path");
      expect(text).not.toContain("(missing claim)");
      expect(output.details).toEqual({ cited: 0 });
    }
    expect(events).toEqual([]);
  });

  it("enforces the claim bounds the schema only advertises", async () => {
    // pi does not validate tool params against the TypeBox schema, so the
    // 4-300 bounds must be enforced in execute — a 1-character claim would
    // let padding back in, and an unbounded claim lands in durable storage.
    const { dir, page } = fixture();
    const events: Record<string, unknown>[] = [];
    const support = createKnowledgeCitationSupport({
      knowledgeDir: dir,
      turnRef: { current: 1 },
      sessionEventEmitter: (event) => events.push(event),
    });
    readPage(support, page);

    const short = await support.tool.execute("call", {
      pages: [{ path: page, claim: "x" }],
    } as never);
    expect((short.content[0] as { text: string }).text).toContain("claim too short");
    expect(short.details).toEqual({ cited: 0 });

    const long = await support.tool.execute("call", {
      pages: [{ path: page, claim: "长".repeat(301) }],
    } as never);
    expect((long.content[0] as { text: string }).text).toContain("claim too long");
    expect(long.details).toEqual({ cited: 0 });
    expect(events).toEqual([]);
  });

  it("rejects non-array parameter shapes instead of silently dropping them", async () => {
    // Array.isArray coercion used to turn a bare {path, claim} object into
    // an empty list: the call reported success while the page's link never
    // reached the references — the model shipped believing it was cited.
    const { dir, page } = fixture();
    const events: Record<string, unknown>[] = [];
    const support = createKnowledgeCitationSupport({
      knowledgeDir: dir,
      turnRef: { current: 1 },
      sessionEventEmitter: (event) => events.push(event),
    });
    readPage(support, page);

    const objectPages = await support.tool.execute("call", {
      pages: { path: page, claim: "The runbook documents the reset procedure." },
    } as never);
    expect((objectPages.content[0] as { text: string }).text).toContain("pages must be an ARRAY");
    expect(objectPages.details).toEqual({ cited: 0 });

    const stringRefs = await support.tool.execute("call", {
      evidence_refs: "guide.md#entry",
      pages: [{ path: page, claim: "The runbook documents the reset procedure." }],
    } as never);
    expect((stringRefs.content[0] as { text: string }).text).toContain("evidence_refs must be an ARRAY");
    expect(stringRefs.details).toEqual({ cited: 0 });
    expect(events).toEqual([]);
  });

  it("treats a null optional list as absent, not as a malformed shape", async () => {
    // `null` for an optional field means "not provided". Rejecting the whole
    // call would discard a valid sibling list and block the answer (a failed
    // cite must not ship), so null must fall through to the empty-list path.
    const { dir, page } = fixture();
    const events: Record<string, unknown>[] = [];
    const support = createKnowledgeCitationSupport({
      knowledgeDir: dir,
      turnRef: { current: 1 },
      sessionEventEmitter: (event) => events.push(event),
    });
    readPage(support, page);

    const output = await support.tool.execute("call", {
      pages: [{ path: page, claim: "The runbook documents the reset procedure." }],
      evidence_refs: null,
    } as never);
    expect(output.details).toEqual({ cited: 1 });
    const text = (output.content[0] as { text: string }).text;
    expect(text).not.toContain("must be an ARRAY");
    expect(events).toHaveLength(1);
  });

  it("diagnoses a non-string evidence_refs element instead of citing [object Object]", async () => {
    // A {path, claim} object mistakenly placed in evidence_refs used to become
    // the ref "[object Object]" and be reported as unresolved, sending the
    // retry at the wrong problem.
    const { dir, page } = fixture();
    const events: Record<string, unknown>[] = [];
    const support = createKnowledgeCitationSupport({
      knowledgeDir: dir,
      turnRef: { current: 1 },
      sessionEventEmitter: (event) => events.push(event),
    });
    readPage(support, page);

    const output = await support.tool.execute("call", {
      evidence_refs: [{ path: page, claim: "misplaced object" }],
    } as never);
    const text = (output.content[0] as { text: string }).text;
    expect(text).toContain("evidence_refs must be page.md#evidence-id STRINGS");
    expect(text).not.toContain("[object Object]");
    expect(output.details).toEqual({ cited: 0 });
    expect(events).toEqual([]);
  });

  it("merges repeated successful calls into one capped union event", async () => {
    // Both gateway consumers ASSIGN the knowledge_sources event, so a second
    // call would overwrite the first call's references. The tool therefore
    // emits the deduped union of the turn — and the cap applies to the union,
    // so follow-up calls cannot raise the ceiling.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-cite-union-"));
    dirs.push(dir);
    const first = path.join(dir, "first.md");
    const second = path.join(dir, "second.md");
    fs.writeFileSync(first, "---\nsources:\n  - resource: raw/a.md\n---\n# First\n");
    fs.writeFileSync(second, "---\nsources:\n  - resource: raw/b.md\n---\n# Second\n");
    fs.writeFileSync(path.join(dir, KNOWLEDGE_CITATION_MANIFEST), JSON.stringify({
      version: 1,
      repos: [{ id: "repo", root: "", sources: [
        { resource: "a.md", title: "A", url: "https://docs.feishu.cn/wiki/a" },
        { resource: "b.md", title: "B", url: "https://docs.feishu.cn/wiki/b" },
      ] }],
    }));
    const events: Array<{ sources: Array<{ title: string }> }> = [];
    const support = createKnowledgeCitationSupport({
      knowledgeDir: dir,
      turnRef: { current: 1 },
      sessionEventEmitter: (event) => events.push(event as never),
    });
    readPage(support, first);
    readPage(support, second);

    const call1 = await support.tool.execute("call-1", {
      pages: [{ path: first, claim: "First page supports the opening claim." }],
    } as never);
    expect(call1.details).toEqual({ cited: 1 });
    const call2 = await support.tool.execute("call-2", {
      pages: [{ path: second, claim: "Second page supports the follow-up claim." }],
    } as never);
    expect(call2.details).toEqual({ cited: 1 });
    expect(events).toHaveLength(2);
    expect(events[1].sources.map((source) => source.title)).toEqual(["A", "B"]);

    // Re-citing an already-registered source adds nothing and says so.
    const recite = await support.tool.execute("call-3", {
      pages: [{ path: first, claim: "First page supports the opening claim." }],
    } as never);
    expect(recite.details).toEqual({ cited: 0 });
    expect((recite.content[0] as { text: string }).text).toContain("already registered this turn");
    expect(events).toHaveLength(2);

    // A page that resolves to NOTHING keeps its honest no-sources message
    // even after earlier successes — "already registered" would falsely
    // claim it was cited.
    const unmatched = path.join(dir, "unmatched.md");
    fs.writeFileSync(unmatched, "---\nsources:\n  - resource: raw/none.md\n---\n# Unmatched\n");
    readPage(support, unmatched);
    const unresolvable = await support.tool.execute("call-4", {
      pages: [{ path: unmatched, claim: "Unmatched page supports a side claim." }],
    } as never);
    expect(unresolvable.details).toEqual({ cited: 0 });
    const unresolvableText = (unresolvable.content[0] as { text: string }).text;
    expect(unresolvableText).toContain("no trusted clickable original sources");
    expect(unresolvableText).not.toContain("already registered this turn");
    expect(events).toHaveLength(2);
  });

  it("a mid-turn remount drops the registered union with the snapshots", async () => {
    // After a knowledge hot-swap the old manifest no longer vouches for the
    // union's originals — and a stale union would also hold the cap hostage
    // against everything the new mount cites.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-cite-remount-"));
    dirs.push(dir);
    const first = path.join(dir, "first.md");
    const second = path.join(dir, "second.md");
    fs.writeFileSync(first, "---\nsources:\n  - resource: raw/a.md\n---\n# First\n");
    fs.writeFileSync(second, "---\nsources:\n  - resource: raw/b.md\n---\n# Second\n");
    fs.writeFileSync(path.join(dir, KNOWLEDGE_CITATION_MANIFEST), JSON.stringify({
      version: 1,
      repos: [{ id: "repo", root: "", sources: [
        { resource: "a.md", title: "OLD-A", url: "https://docs.feishu.cn/wiki/old-a" },
      ] }],
    }));
    const events: Array<{ sources: Array<{ title: string }> }> = [];
    const support = createKnowledgeCitationSupport({
      knowledgeDir: dir,
      turnRef: { current: 1 },
      sessionEventEmitter: (event) => events.push(event as never),
    });
    readPage(support, first);
    await support.tool.execute("call-old-mount", {
      pages: [{ path: first, claim: "First page supports the opening claim." }],
    } as never);
    expect(events).toHaveLength(1);

    fs.writeFileSync(path.join(dir, KNOWLEDGE_CITATION_MANIFEST), JSON.stringify({
      version: 1,
      repos: [{ id: "repo", root: "", sources: [
        { resource: "b.md", title: "NEW-B", url: "https://docs.feishu.cn/wiki/new-b" },
      ] }],
    }));
    readPage(support, second);
    // The remount must RETRACT the stale union at the consumer, which assigns
    // rather than merges: dropping our own copy is not enough, so the reset
    // emits an empty-sources event. Without it, a turn that remounts and then
    // fails/adds-nothing would still render OLD-A's link.
    expect(events).toHaveLength(2);
    expect(events[1].sources).toEqual([]);
    const afterRemount = await support.tool.execute("call-new-mount", {
      pages: [{ path: second, claim: "Second page supports the follow-up claim." }],
    } as never);
    expect(afterRemount.details).toEqual({ cited: 1 });
    expect(events).toHaveLength(3);
    expect(events[2].sources.map((source) => source.title)).toEqual(["NEW-B"]);
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

    const output = await support.tool.execute("call", {
      pages: [{ path: rel, claim: "Navigation content referenced for routing." }],
    } as never);
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

    await expect(support.tool.execute("call", { pages: [{ path: page, claim: "The runbook documents the GPU reset procedure." }] } as never)).resolves.toMatchObject({
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

    await expect(support.tool.execute("call", { pages: [{ path: page, claim: "The runbook documents the GPU reset procedure." }] } as never)).resolves.toMatchObject({
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

    await expect(support.tool.execute("call", { pages: [{ path: page, claim: "The runbook documents the GPU reset procedure." }] } as never)).resolves.toMatchObject({
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
      pages: [{ path: "legacy.md", claim: "This page supports a statement in the answer." }],
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
    expect(buildKnowledgeCitationSystemPrompt(dir)).toContain("pass each as `{path, claim}` in `pages` in the same call");
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
      pages: [{ path: "guide.md", claim: "The guide documents the runbook step." }],
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

  it("caps mixed pages at the ceiling and names the overflow instead of failing closed", async () => {
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
    // The old contract failed the whole call ("split the answer") and reported
    // the RESOLVED refs as unresolved — agents answered uncited instead of
    // splitting, and the retry guidance looped on identical valid refs. The
    // cap now keeps the first 8 in input order and names what it dropped.
    const capped = await support.tool.execute("call", {
      evidence_refs: ["guide.md#all"],
      pages: [{ path: "legacy.md", claim: "This page supports a statement in the answer." }],
    } as never);
    expect(capped.details).toEqual({ cited: 8, unresolved: [] });
    const text = (capped.content[0] as { text: string }).text;
    expect(text).toContain("Registered 8 exact trusted original sources");
    expect(text).toContain("1 more source was NOT registered");
    expect(text).toContain("Extra");
    expect(events).toHaveLength(1);
    const emitted = (events[0] as { sources: Array<{ title: string }> }).sources;
    expect(emitted).toHaveLength(8);
    expect(emitted.map((source) => source.title)).not.toContain("Extra");

    // With the cap already filled by this turn's citations, a follow-up call
    // bringing a genuinely NEW source must say the cap is the reason — not
    // "already registered", which would tell the model the page is cited.
    const followUp = await support.tool.execute("call-cap-exhausted", {
      pages: [{ path: legacy, claim: "Extra policy sets the retention window." }],
    } as never);
    const followUpText = (followUp.content[0] as { text: string }).text;
    expect(followUpText).toContain("cap is already filled");
    expect(followUpText).toContain("Extra");
    expect(followUpText).not.toContain("already registered this turn");
    expect(followUp.details).toEqual({ cited: 0 });
    expect(events).toHaveLength(1);
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
