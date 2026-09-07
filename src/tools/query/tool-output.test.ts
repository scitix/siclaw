import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolOutputStore, withToolOutputStore } from "../infra/tool-output-store.js";
import { createToolOutputTool, registration } from "./tool-output.js";
import { postExecSecurity } from "../infra/security-pipeline.js";
import { ToolRegistry, type ToolRefs } from "../../core/tool-registry.js";
import { Type } from "@sinclair/typebox";

let directory: string;
let store: ToolOutputStore;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-output-test-"));
  store = new ToolOutputStore(path.join(directory, "task-a"));
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

describe("saved tool output", () => {
  it("expands the block advertised by the preview into its inclusive original line range", async () => {
    const text = Array.from({ length: 360 }, (_, i) => `${String(i + 1).padStart(3, "0")}${"x".repeat(96)}\n`).join("");
    const preview = withToolOutputStore(store, () => postExecSecurity(text, null));
    // The first omitted gap is characters 2001–8800: complete original lines 21–88.
    expect(preview).toContain("omitted chars 2001-8800; lines 21-88; block 1;");
    const call = /block 1; expand with tool_output\((\{[^\n]+?\})\)/.exec(preview);
    expect(call).not.toBeNull();
    const result = await createToolOutputTool(new ToolOutputStore(store.directory)).execute("expand", JSON.parse(call![1]));
    expect(result.details).toMatchObject({
      block: { block_id: 1, start_line: 21, end_line: 88 },
      offset: 21, end_line: 88, block_complete: true,
    });
    expect(result.details).not.toHaveProperty("next");
    expect((result.content[0] as { text: string }).text.endsWith(text.slice(2000, 8800))).toBe(true);
  });

  it("continues a large block at 8k per page and stops before later lines", () => {
    // The sampled gap is under 8k, but expanding its complete boundary lines
    // crosses two 9k lines, so the block needs multiple bounded reads.
    const text = Array.from({ length: 12 }, (_, i) => `${String(i + 1).padStart(4, "0")}${"x".repeat(8995)}\n`).join("");
    const id = store.save(text);
    let page = store.read(id, undefined, undefined, undefined, 1);
    const block = page.block!;
    expect(page.next?.block_id).toBe(1);
    let collected = "";
    for (;;) {
      expect(page.output.length).toBeLessThanOrEqual(8000);
      collected += page.output;
      if (!page.next) break;
      const next = page.next;
      page = store.read(id, next.offset, undefined, next.column, next.block_id);
    }
    expect(page.block_complete).toBe(true);
    expect(collected).toBe(text.slice((block.start_line - 1) * 9000, block.end_line * 9000));
    expect(page.end_line).toBe(block.end_line);
    expect(page.end_line).toBeLessThan(12);
    expect(() => store.read(id, block.end_line + 1, undefined, undefined, 1)).toThrow("within block");
    expect(() => store.read(id, undefined, undefined, undefined, 99)).toThrow("No omitted block");
    expect(() => store.read(id, undefined, undefined, undefined, 0)).toThrow("positive integer");
  });

  it("includes full boundary lines and continues a block that occupies one very long line", () => {
    const line = "🙂".repeat(18000);
    const id = store.save(line + "\nAFTER");
    let page = store.read(id, undefined, undefined, undefined, 1);
    expect(page.block).toEqual({ block_id: 1, start_line: 1, end_line: 1 });
    let collected = "";
    for (;;) {
      expect(page.output.isWellFormed()).toBe(true);
      collected += page.output;
      if (!page.next) break;
      page = store.read(id, page.next.offset, undefined, page.next.column, page.next.block_id);
    }
    expect(collected).toBe(line + "\n");
    expect(page.block_complete).toBe(true);
  });

  it("reads omitted lines from the same stored output after store reconstruction", async () => {
    const text = Array.from({ length: 360 }, (_, i) => `${String(i + 1).padStart(3, "0")}${"x".repeat(96)}\n`).join("");
    const id = store.save(text);
    const restored = new ToolOutputStore(store.directory);
    const tool = createToolOutputTool(restored);
    const result = await tool.execute("read-1", { output_id: id, offset: 60, limit: 2 });
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining(text.slice(5900, 6100)) });
    expect(result.details).toMatchObject({ total_chars: 36000, total_lines: 361, offset: 60, end_line: 61, next: { offset: 62, column: 1 } });
    store.clear();
    const missing = await tool.execute("read-2", { output_id: id });
    expect(missing.details).toEqual({ error: true });
    expect(missing.content[0]).toMatchObject({ text: expect.stringContaining("unavailable") });
    expect(() => store.save("late output after task close")).toThrow();
    expect(fs.existsSync(store.directory)).toBe(false);
  });

  it("continues a long line within the 8k budget, without dropping characters", () => {
    const text = "🙂".repeat(10_001) + "\nlast";
    const id = store.save(text);
    let cursor = { offset: 1, column: 1 };
    let collected = "";
    for (;;) {
      const page = store.read(id, cursor.offset, 100, cursor.column);
      expect(page.output.length).toBeLessThanOrEqual(8000);
      expect(page.output.isWellFormed()).toBe(true);
      collected += page.output;
      if (!page.next) break;
      cursor = page.next;
    }
    expect(collected).toBe(text);
  });

  it("isolates output ids between tasks and validates read ranges", () => {
    const id = store.save("first\nsecond");
    expect(() => new ToolOutputStore(path.join(directory, "other-task")).read(id)).toThrow("unavailable");
    expect(() => store.read("../other")).toThrow("Invalid output_id");
    expect(() => store.read(id, 0)).toThrow("positive integer");
    expect(() => store.read(id, 1, 1.5)).toThrow("positive integer");
    expect(() => store.read(id, 3)).toThrow("total_lines");
    expect(() => store.read(id, 1, 1, 20)).toThrow("column");
  });

  it.skipIf(process.platform === "win32")("does not follow a replaced output file into another task", () => {
    const id = store.save("allowed output");
    const other = new ToolOutputStore(path.join(directory, "other-task"));
    const otherId = other.save("other task output");
    fs.unlinkSync(store.file(id));
    fs.symlinkSync(other.file(otherId), store.file(id));
    expect(() => store.read(id)).toThrow();
  });

  it("routes concurrent registry tools to their own sanitized output stores", async () => {
    const registry = new ToolRegistry();
    registry.register({ category: "cmd-exec", create: () => ({
      name: "test_exec", label: "Test", description: "test", parameters: Type.Object({}),
      async execute(id) {
        await new Promise((resolve) => setTimeout(resolve, id === "a" ? 10 : 1));
        return { content: [{ type: "text", text: postExecSecurity(id.repeat(36000), null, { stderr: "password: hunter2" }) }], details: {} };
      },
    }) }, registration);
    const other = new ToolOutputStore(path.join(directory, "task-b"));
    const resolve = (outputStore: ToolOutputStore) => registry.resolve({
      mode: "web", refs: { toolOutputStore: outputStore } as ToolRefs,
      allowedTools: ["test_exec", "tool_output"],
    });
    const [a, b] = await Promise.all([resolve(store)[0].execute("a", {}), resolve(other)[0].execute("b", {})]);
    for (const [result, outputStore, letter] of [[a, store, "a"], [b, other, "b"]] as const) {
      const text = (result.content[0] as { text: string }).text;
      const id = /"output_id":"([^"]+)"/.exec(text)![1];
      expect(outputStore.read(id).output).toBe(letter.repeat(8000));
      const saved = fs.readFileSync(outputStore.file(id), "utf8");
      expect(saved).not.toContain("hunter2");
      expect(text).toContain("omitted chars");
      expect(text).toContain("lines total");
    }
    expect(fs.readdirSync(store.directory)).toHaveLength(1);
    expect(fs.readdirSync(other.directory)).toHaveLength(1);
  });
});
