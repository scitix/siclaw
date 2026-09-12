import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ToolResultArtifactStore } from "../core/tool-result-artifact.js";
import { captureSubagentContext, materializeSubagentContext, validateSubagentContextSelection } from "./subagent-context.js";

const text = (role: string, value: string) => ({ role, content: [{ type: "text", text: value }] });
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function stores() {
  const rootDir = await mkdtemp(path.join(tmpdir(), "subagent-context-"));
  directories.push(rootDir);
  const store = (sessionId: string, agentId = "agent") => new ToolResultArtifactStore({ rootDir, getScope: () => ({ agentId, sessionId }) });
  return { parent: store("parent"), child: store("child"), stranger: store("parent", "other-agent") };
}
const identity = (value: string) => value;

describe("subagent context selection", () => {
  it("accepts only explicit modes or positive safe integers", () => {
    for (const value of [undefined, "none", "all", 1, 30]) expect(() => validateSubagentContextSelection(value)).not.toThrow();
    for (const value of [null, 0, -1, 1.5, "2", Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => validateSubagentContextSelection(value)).toThrow(/fork_turns/);
  });
  it("counts user-message turns and captures an immutable dispatch snapshot", () => {
    const messages = [text("user", "old question"), text("assistant", "old answer"), text("user", "current question"), text("assistant", "current findings")];
    const snapshot = captureSubagentContext(messages, 1, "spawn");
    messages[3].content[0].text = "later change";
    expect(snapshot.text).toContain("current findings");
    expect(snapshot.text).not.toMatch(/old question|old answer|later change/);
    expect(captureSubagentContext(messages, 2, "spawn").text).toContain("old question");
  });
  it("preserves compaction summaries, evidence and images without reasoning or controls", () => {
    const snapshot = captureSubagentContext([
      { role: "system", content: "parent system secret" },
      { role: "compactionSummary", summary: "earlier evidence", tokensBefore: 80000 },
      { role: "custom", customType: "task-notification", content: "parent live control" },
      { role: "assistant", content: [
        { type: "thinking", thinking: "private reasoning" },
        { type: "text", text: "narration", textSignature: "private signature" },
        { type: "toolCall", id: "read1", name: "read", arguments: { path: "SKILL.md" } },
        { type: "toolCall", id: "pending", name: "bash", arguments: { command: "not yet run" } },
        { type: "toolCall", id: "spawn", name: "spawn_subagent", arguments: { items: ["recursive"] } },
      ] },
      { role: "toolResult", toolCallId: "read1", toolName: "read", content: [{ type: "text", text: "checked evidence" }], details: { hidden: "private details" } },
      { role: "toolResult", toolCallId: "task", toolName: "task_list", content: "parent task IDs" },
      { role: "user", content: [{ type: "image", mimeType: "image/png", data: "base64-image" }] },
    ], "all", "spawn");
    expect(snapshot.text).toContain("earlier evidence");
    expect(snapshot.text).toContain("checked evidence");
    expect(snapshot.text).toContain("historical_tool_call");
    expect(snapshot.text).not.toMatch(/private|parent system|parent live|parent task|not yet run|recursive|base64-image/);
    expect(snapshot.images).toEqual([{ type: "image", mimeType: "image/png", data: "base64-image" }]);
  });
});

describe("child-scoped inherited evidence", () => {
  it("copies full nested artifacts, deduplicates references and redacts their content", async () => {
    const { parent, child, stranger } = await stores();
    const capture = await parent.capture({ text: "secret " + "evidence ".repeat(2000), toolName: "mcp_query", toolCallId: "query" });
    if (!("reference" in capture)) throw new Error("fixture");
    const nested = await parent.capture({ text: `More: ${capture.reference.id}`, toolName: "mcp_query", toolCallId: "query2" });
    if (!("reference" in nested)) throw new Error("fixture");
    const snapshot = captureSubagentContext([text("user", `${nested.reference.id} ${nested.reference.id}`)], "all", "spawn");
    const content = await materializeSubagentContext(snapshot, parent, child, value => value.replaceAll("secret", "[redacted]"));
    const rendered = (content[0] as { text: string }).text;
    expect(rendered).not.toContain(nested.reference.id);
    const ids = rendered.match(/tra_[a-f0-9]{32}/g)!;
    expect(new Set(ids).size).toBe(1);
    const first = await child.readFull(ids[0]);
    const secondId = first.text.match(/tra_[a-f0-9]{32}/)![0];
    expect((await child.readFull(secondId)).text).toBe("[redacted] " + "evidence ".repeat(2000));
    await expect(child.readFull(capture.reference.id)).rejects.toThrow();
    await expect(parent.readFull(ids[0])).rejects.toThrow();
    await expect(stranger.readFull(capture.reference.id)).rejects.toThrow();
  });
  it("omits parent capabilities instead of cloning resume tickets", async () => {
    const { parent, child } = await stores();
    const ticket = await parent.capture({ text: "private child identity", toolName: "internal:subagent-session", toolCallId: "ticket" });
    if (!("reference" in ticket)) throw new Error("fixture");
    const snapshot = captureSubagentContext([text("assistant", `${ticket.reference.id}:0 ${ticket.reference.id}`)], "all", "spawn");
    const content = await materializeSubagentContext(snapshot, parent, child, identity);
    expect(JSON.stringify(content)).not.toMatch(/tra_|private child identity/);
    expect(JSON.stringify(content)).toContain("capability omitted");
  });
  it("fails explicitly on missing evidence or quota failure without a clipped fallback", async () => {
    const { parent, child } = await stores();
    const id = "tra_" + "a".repeat(32);
    const snapshot = captureSubagentContext([text("user", id)], "all", "spawn");
    await expect(materializeSubagentContext(snapshot, parent, child, identity)).rejects.toThrow(/unavailable or expired/);
    const source = { readFull: async () => ({ text: "complete result", toolName: "query" }) };
    const destination = { capture: async () => ({ failure: { version: 1 as const, reason: "too_large" as const, sizeChars: 15, sizeBytes: 15 } }) };
    await expect(materializeSubagentContext(snapshot, source, destination, identity)).rejects.toThrow(/Cannot preserve/);
  });
  it("rejects cycles without unbounded copying", async () => {
    const { child } = await stores();
    const id = "tra_" + "a".repeat(32);
    const source = { readFull: async () => ({ text: id, toolName: "query" }) };
    const snapshot = captureSubagentContext([text("user", id)], "all", "spawn");
    await expect(materializeSubagentContext(snapshot, source, child, identity)).rejects.toThrow(/cyclic/);
  });
  it("bounds total inherited artifact bytes before copying the overflowing artifact", async () => {
    const first = "tra_" + "a".repeat(32);
    const second = "tra_" + "b".repeat(32);
    const snapshot = captureSubagentContext([text("user", `${first} ${second}`)], "all", "spawn");
    const source = { readFull: async (id: string) => ({ text: id === first ? "123456" : "abcdef", toolName: "query" }) };
    const captured: string[] = [];
    const destination = { capture: async ({ text: value }: { text: string }) => {
      captured.push(value);
      return { reference: { id: "tra_" + "c".repeat(32) } };
    } };

    await expect(materializeSubagentContext(snapshot, source, destination, identity, undefined, {
      maxInheritedArtifactBytes: 10,
    })).rejects.toThrow(/byte budget/);
    expect(captured).toEqual(["123456"]);
  });
  it("persists inherited context as reference data in the native transcript for follow-ups", async () => {
    const { parent, child } = await stores();
    const content = await materializeSubagentContext(captureSubagentContext([text("user", "prior evidence")], "all", "spawn"), parent, child, identity);
    const manager = SessionManager.inMemory();
    manager.appendCustomMessageEntry("subagent-parent-context", content, false);
    const restored = manager.buildSessionContext().messages;
    expect(restored).toHaveLength(1);
    expect(restored[0].role).toBe("custom");
    expect(JSON.stringify(restored)).toContain("prior evidence");
  });
});
