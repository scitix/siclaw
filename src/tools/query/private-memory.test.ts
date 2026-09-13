import { afterEach, expect, it, vi } from "vitest";
import { createPrivateMemoryGetTool, createPrivateMemorySearchTool } from "./private-memory.js";
import { registration as searchRegistration } from "./memory-search.js";
import { registration as getRegistration } from "./memory-get.js";
import type { PrivateMemorySource } from "../../shared/private-workspace.js";

const path = `memory/${"a".repeat(64)}.md`;
const match = { path, kind: "preference", content: "Prefer tables for Harbor reports.", content_start_line_number: 1, truncated: false, matched_queries: ["Harbor"], source_session_id: "s", source_entry_id: "e", created_at: 1, expires_at: 9999999999999 };
const parse = (result: any) => JSON.parse(result.content[0].text);
const source = () => ({
  search: vi.fn(async () => ({ matches: [match], enabled: true, truncated: false })),
  read: vi.fn(async () => ({ path, found: true, content: match.content, start_line_number: 1, truncated: false })),
});
afterEach(() => vi.unstubAllEnvs());

it("rejects unknown fields, empty queries, oversized UTF-8, invalid windows and file paths", async () => {
  const backend = source();
  const search = createPrivateMemorySearchTool(backend), read = createPrivateMemoryGetTool(backend);
  for (const args of [{ query: "Harbor" }, { queries: [" "] }, { queries: ["界".repeat(400)] }, { queries: ["Harbor"], max_results: 0 }, { queries: ["Harbor"], script: "run" }]) {
    expect(parse(await search.execute("s", args)).error).toBeTruthy();
  }
  for (const args of [{ path: "../../etc/passwd" }, { path, line_offset: 0 }, { path, max_lines: -1 }, { path, char_offset: 2, line_offset: 2 }, { path, script: "run" }]) {
    expect(parse(await read.execute("s", args)).error).toBeTruthy();
  }
  expect(backend.search).not.toHaveBeenCalled(); expect(backend.read).not.toHaveBeenCalled();
});

it("uses distinct search/read contracts, forwards pagination, reauthorizes duplicates and resets per turn", async () => {
  const backend = source(); const turn = { current: 1 };
  const search = createPrivateMemorySearchTool(backend, turn), read = createPrivateMemoryGetTool(backend, turn);
  const args = { queries: ["Harbor"], max_results: 1, scope: "harbor", cursor: "cursor", context_lines: 2, match_mode: "all" };
  expect(parse(await search.execute("a", args)).matches).toHaveLength(1);
  expect(backend.search).toHaveBeenLastCalledWith(args);
  backend.search.mockResolvedValueOnce({ matches: [{ ...match, matched_queries: ["Harbor reports"] }], enabled: true, truncated: false });
  expect(parse(await search.execute("b", { queries: ["Harbor reports"] })).already_seen_paths).toEqual([path]);
  expect(parse(await read.execute("c", { path, char_offset: 0, max_lines: 3 })).content).toBe(match.content);
  expect(backend.read).toHaveBeenLastCalledWith({ path, char_offset: 0, max_lines: 3 });
  expect(parse(await read.execute("d", { path })).already_seen).toBe(true);
  backend.read.mockResolvedValueOnce({ path, found: false, content: "", start_line_number: 0, truncated: false });
  expect(parse(await read.execute("e", { path })).found).toBe(false);
  turn.current++;
  expect(parse(await read.execute("f", { path })).content).toBe(match.content);
  expect(backend.search).toHaveBeenCalledTimes(2); expect(backend.read).toHaveBeenCalledTimes(4);
});

it("shares search/read budgets without silently advancing a clipped cursor", async () => {
  const backend: PrivateMemorySource = source(); let serial = 0;
  backend.read = async () => ({ path, found: true, content: `${serial++}${"界".repeat(2300)}`, start_line_number: 1, truncated: true, next_char_offset: serial * 2300 });
  const turn = { current: 1 }, read = createPrivateMemoryGetTool(backend, turn), search = createPrivateMemorySearchTool(backend, turn);
  let bytes = 0;
  for (let i = 0; i < 4; i++) {
    const result = await read.execute("a", { path }); const text = (result.content[0] as any).text;
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8192); expect(text).not.toContain("�");
    if (!parse(result).budget_reached) bytes += Buffer.byteLength(text);
  }
  const result = await search.execute("b", { queries: ["Harbor"] });
  if (!parse(result).budget_reached) bytes += Buffer.byteLength((result.content[0] as any).text);
  expect(bytes).toBeLessThanOrEqual(16384);
});

it("does not interpret transport or old-schema responses as no matching history", async () => {
  const backend = source(); backend.search.mockRejectedValueOnce(new Error("unavailable"));
  const search = createPrivateMemorySearchTool(backend);
  await expect(search.execute("a", { queries: ["Harbor"] })).rejects.toThrow("unavailable");
  backend.search.mockResolvedValueOnce({ records: [] } as any);
  await expect(search.execute("b", { queries: ["Harbor"] })).rejects.toThrow("Incompatible");
  backend.read.mockResolvedValueOnce({ path, found: true, content: "x".repeat(9000), start_line_number: 1, truncated: false });
  await expect(createPrivateMemoryGetTool(backend).execute("c", { path })).rejects.toThrow("output budget");
});

it("never falls back to local memory tools in remote mode", () => {
  vi.stubEnv("SICLAW_WORKSPACE_MODE", "remote"); vi.stubEnv("SICLAW_MEMORY_ENABLED", "true");
  const refs = { memoryIndexer: {}, memoryDir: "/tmp" } as any;
  for (const entry of [searchRegistration, getRegistration]) {
    expect(entry.available!(refs)).toBe(false);
    expect(() => entry.create(refs)).toThrow("Private memory backend is unavailable");
  }
});

it.each([{ line_offset: 1, char_offset: 0 }, { line_offset: 3, char_offset: 0 }, { line_offset: 1, char_offset: 30 }])("accepts model-populated default positions without rejecting a valid read: %j", async offsets => {
  const backend = source();
  const result = await createPrivateMemoryGetTool(backend).execute("read", { path, ...offsets, max_lines: 1 });
  expect(parse(result).found).toBe(true);
  expect(backend.read).toHaveBeenCalledWith({ path, ...offsets, max_lines: 1 });
});
