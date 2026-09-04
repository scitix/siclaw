import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ToolResultArtifactStore,
  createToolResultArtifactTools,
  formatToolResultArtifactReference,
  getToolResultArtifactReference,
  isToolResultArtifactPath,
  withToolResultArtifactCapture,
} from "./tool-result-artifact.js";

describe("ToolResultArtifactStore", () => {
  let rootDir: string;
  let now: number;
  let scope = { agentId: "agent-a", sessionId: "session-a" };

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "siclaw-tool-result-artifact-"));
    now = Date.parse("2026-09-03T00:00:00.000Z");
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  function store(options: { ttlMs?: number; maxArtifactBytes?: number; maxScopeBytes?: number; maxScopeArtifacts?: number } = {}) {
    return new ToolResultArtifactStore({
      rootDir,
      getScope: () => scope,
      now: () => now,
      ...options,
    });
  }

  it("persists complete text with digest and supports bounded continuation reads", async () => {
    const artifacts = store();
    const text = `prefix-${"x".repeat(40_000)}-ROOT_CAUSE-middle-${"y".repeat(40_000)}-tail`;
    const captured = await artifacts.capture({ text, toolCallId: "call-1", toolName: "mcp__logs__query" });
    expect(captured).toHaveProperty("reference");
    if (!("reference" in captured)) throw new Error("capture failed");

    expect(captured.reference.sizeChars).toBe(text.length);
    expect(captured.reference.sizeBytes).toBe(Buffer.byteLength(text));
    expect(captured.reference.sha256).toMatch(/^[0-9a-f]{64}$/);

    const first = await artifacts.read(captured.reference.id, 0, 32_000);
    expect(first.text).toBe(text.slice(0, 32_000));
    expect(first.nextOffset).toBe(32_000);
    expect(first.complete).toBe(false);

    let assembled = first.text;
    let cursor = first.nextOffset;
    while (cursor !== null) {
      const page = await artifacts.read(captured.reference.id, cursor, 32_000);
      assembled += page.text;
      cursor = page.nextOffset;
    }
    expect(assembled).toBe(text);
    expect((await fs.stat(rootDir)).mode & 0o777).toBe(0o700);
  });

  it("rejects a symlink as the private artifact root", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "siclaw-tool-result-symlink-"));
    try {
      const target = path.join(parent, "target");
      const symlink = path.join(parent, "artifact-root");
      await fs.mkdir(target);
      await fs.symlink(target, symlink, "dir");
      const artifacts = new ToolResultArtifactStore({
        rootDir: symlink,
        getScope: () => scope,
      });
      await expect(artifacts.initialize()).rejects.toThrow("real directory");
      await expect(artifacts.capture({ text: "evidence", toolCallId: "call", toolName: "mcp__x__y" }))
        .resolves.toEqual({
          failure: { version: 1, reason: "write_failed", sizeChars: 8, sizeBytes: 8 },
        });
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("finds decisive evidence from the omitted middle", async () => {
    const artifacts = store();
    const text = `${"x".repeat(300_000)}ROOT_CAUSE: exhausted connection pool${"y".repeat(300_000)}`;
    const captured = await artifacts.capture({ text, toolCallId: "call-2", toolName: "mcp__logs__query" });
    if (!("reference" in captured)) throw new Error("capture failed");

    const result = await artifacts.search(captured.reference.id, "root_cause", 80, 5);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].offset).toBe(300_000);
    expect(result.matches[0].snippet).toContain("exhausted connection pool");
  });

  it("denies an artifact after the session scope changes", async () => {
    const artifacts = store();
    const captured = await artifacts.capture({ text: "private evidence", toolCallId: "call-3", toolName: "mcp__x__y" });
    if (!("reference" in captured)) throw new Error("capture failed");

    scope = { agentId: "agent-a", sessionId: "session-b" };
    await expect(artifacts.read(captured.reference.id)).rejects.toThrow("not found in this session");
  });

  it("expires artifacts and removes their files", async () => {
    const artifacts = store({ ttlMs: 1_000 });
    const captured = await artifacts.capture({ text: "temporary", toolCallId: "call-4", toolName: "mcp__x__y" });
    if (!("reference" in captured)) throw new Error("capture failed");

    now += 1_001;
    await expect(artifacts.read(captured.reference.id)).rejects.toThrow("expired");
    await expect(artifacts.read(captured.reference.id)).rejects.toThrow("not found");
  });

  it("fails closed for a single artifact beyond the configured limit", async () => {
    const artifacts = store({ maxArtifactBytes: 8 });
    const captured = await artifacts.capture({ text: "123456789", toolCallId: "call-5", toolName: "mcp__x__y" });
    expect(captured).toEqual({
      failure: { version: 1, reason: "too_large", sizeChars: 9, sizeBytes: 9 },
    });
  });

  it("evicts oldest artifacts to keep the session quota bounded", async () => {
    const artifacts = store({ maxScopeBytes: 10 });
    const first = await artifacts.capture({ text: "123456", toolCallId: "call-6", toolName: "mcp__x__y" });
    if (!("reference" in first)) throw new Error("capture failed");
    now += 1;
    const second = await artifacts.capture({ text: "abcdef", toolCallId: "call-7", toolName: "mcp__x__y" });
    if (!("reference" in second)) throw new Error("capture failed");

    await expect(artifacts.read(first.reference.id)).rejects.toThrow("not found");
    await expect(artifacts.read(second.reference.id)).resolves.toMatchObject({ text: "abcdef" });
  });

  it("caps the number of artifacts retained in one session scope", async () => {
    const artifacts = store({ maxScopeBytes: 1_000, maxScopeArtifacts: 1 });
    const first = await artifacts.capture({ text: "first", toolCallId: "call-8", toolName: "mcp__x__y" });
    if (!("reference" in first)) throw new Error("capture failed");
    now += 1;
    const second = await artifacts.capture({ text: "second", toolCallId: "call-9", toolName: "mcp__x__y" });
    if (!("reference" in second)) throw new Error("capture failed");

    await expect(artifacts.read(first.reference.id)).rejects.toThrow("not found");
    await expect(artifacts.read(second.reference.id)).resolves.toMatchObject({ text: "second" });
  });
});

describe("tool-result artifact tools", () => {
  it("capture wrapper preserves live content and adds a recoverable reference", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "siclaw-tool-result-wrapper-"));
    try {
      const store = new ToolResultArtifactStore({
        rootDir,
        getScope: () => ({ agentId: "agent", sessionId: "session" }),
      });
      const wrapped = withToolResultArtifactCapture({
        name: "mcp__logs__query",
        label: "query",
        description: "query logs",
        parameters: Type.Object({}),
        execute: async () => ({
          content: [{ type: "text" as const, text: `complete live result ${"x".repeat(40_000)}` }],
          details: { upstream: true },
        }),
      }, store);

      const result = await wrapped.execute("call-1", {}, undefined, undefined, undefined);
      expect((result.content[0] as any).text).toMatch(/^complete live result x+$/);
      expect((result.details as any).upstream).toBe(true);
      const reference = getToolResultArtifactReference(result.details);
      expect(reference).not.toBeNull();
      const stored = await store.read(reference!.id);
      expect(stored.text).toBe((result.content[0] as any).text.slice(0, 16_000));
      expect(stored.complete).toBe(false);
      expect(reference!.sizeChars).toBe((result.content[0] as any).text.length);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("does not spill small MCP results", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "siclaw-tool-result-small-"));
    try {
      const store = new ToolResultArtifactStore({
        rootDir,
        getScope: () => ({ agentId: "agent", sessionId: "session" }),
      });
      const wrapped = withToolResultArtifactCapture({
        name: "mcp__status__get",
        label: "status",
        description: "get status",
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text" as const, text: "healthy" }] }),
      }, store);

      const result = await wrapped.execute("call-small", {}, undefined, undefined, undefined);
      expect(result).toEqual({ content: [{ type: "text", text: "healthy" }] });
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("read and search tools expose bounded data without accepting paths", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "siclaw-tool-result-tools-"));
    try {
      const store = new ToolResultArtifactStore({
        rootDir,
        getScope: () => ({ agentId: "agent", sessionId: "session" }),
      });
      const captured = await store.capture({ text: "alpha ROOT_CAUSE omega", toolCallId: "call", toolName: "mcp__x__y" });
      if (!("reference" in captured)) throw new Error("capture failed");
      const [readTool, searchTool] = createToolResultArtifactTools(store);

      const read = await readTool.execute("read", { artifact_id: captured.reference.id, offset: 6, limit: 10 }, undefined, undefined, undefined);
      expect(read.content[0]).toMatchObject({ type: "text" });
      expect((read.content[0] as any).text).toContain("ROOT_CAUS");

      const search = await searchTool.execute("search", { artifact_id: captured.reference.id, query: "root_cause" }, undefined, undefined, undefined);
      expect((search.content[0] as any).text).toContain("ROOT_CAUSE");
      expect((readTool.parameters as any).properties).not.toHaveProperty("path");
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("keeps the serialized search response within the tool output bound", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "siclaw-tool-result-search-bound-"));
    try {
      const store = new ToolResultArtifactStore({
        rootDir,
        getScope: () => ({ agentId: "agent", sessionId: "session" }),
      });
      const text = Array.from({ length: 60 }, (_, i) => `${"x".repeat(2_000)} NEEDLE-${i} ${"y".repeat(2_000)}`).join("\n");
      const captured = await store.capture({ text, toolCallId: "call", toolName: "mcp__x__y" });
      if (!("reference" in captured)) throw new Error("capture failed");
      const [, searchTool] = createToolResultArtifactTools(store);

      const result = await searchTool.execute("search", {
        artifact_id: captured.reference.id,
        query: "needle",
        context_chars: 2_000,
        max_matches: 50,
      }, undefined, undefined, undefined);
      const output = (result.content[0] as any).text;
      expect(output.length).toBeLessThanOrEqual(32_000);
      expect(JSON.parse(output).truncated).toBe(true);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});

describe("isToolResultArtifactPath", () => {
  it("blocks the current session tree and sibling session trees", () => {
    expect(isToolResultArtifactPath("/app/.siclaw/user-data/agent/sessions/s1/.tool-results")).toBe(true);
    expect(isToolResultArtifactPath("/app/.siclaw/user-data/agent/sessions/s1/.tool-results/abc/tra_1.txt")).toBe(true);
    expect(isToolResultArtifactPath("/app/.siclaw/user-data/agent/sessions/other/.tool-results/abc/tra_1.txt")).toBe(true);
    expect(isToolResultArtifactPath("/app/.siclaw/user-data/agent/sessions/s1/session.jsonl")).toBe(false);
    expect(isToolResultArtifactPath("/app/.siclaw/user-data/memory/notes.md")).toBe(false);
  });
});

describe("formatToolResultArtifactReference", () => {
  it("keeps the artifact id, digest, and bounded head/tail preview", () => {
    const text = `HEAD-${"m".repeat(2_000)}-TAIL`;
    const rendered = formatToolResultArtifactReference({
      version: 1,
      id: "tra_0123456789abcdef0123456789abcdef",
      sizeChars: text.length,
      sizeBytes: text.length,
      sha256: "a".repeat(64),
      createdAt: "2026-09-03T00:00:00.000Z",
      expiresAt: "2026-09-04T00:00:00.000Z",
    }, text, 1_000);
    expect(rendered.length).toBeLessThanOrEqual(1_000);
    expect(rendered).toContain("tra_0123456789abcdef0123456789abcdef");
    expect(rendered).toContain("HEAD-");
    expect(rendered).toContain("-TAIL");
  });
});
