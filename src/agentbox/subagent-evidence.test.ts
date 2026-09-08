import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ToolResultArtifactStore } from "../core/tool-result-artifact.js";
import { prepareReduceEvidence } from "./subagent-evidence.js";
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true }); });
async function store(scope = "child") {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-evidence-")); dirs.push(rootDir);
  return new ToolResultArtifactStore({ rootDir, getScope: () => ({ agentId: "agent", sessionId: scope }) });
}
describe("complete reduce evidence", () => {
  it("passes evidence beyond the former 1800-character capsule directly", async () => {
    const report = "API passed\n".repeat(300) + "RDMA netns: exclusive";
    const prompt = await prepareReduceEvidence("summarize", [{ item: "node", status: "done", summary: report }], await store());
    expect(prompt).toContain(report);
  });
  it("retains head, middle and tail of oversized reports through scoped paginated artifacts", async () => {
    const s = await store();
    const report = "HEAD " + "中文 evidence\n".repeat(10000) + " TAIL exclusive";
    const prompt = await prepareReduceEvidence("summarize", [{ item: "node", status: "done", summary: report }], s, 2000);
    expect(prompt.length).toBeLessThan(2000);
    const id = prompt.match(/tra_[a-f0-9]{32}/)![0];
    let offset: number | null = 0, recovered = "";
    while (offset !== null) { const page = await s.read(id, offset, 1000); recovered += page.text; offset = page.nextOffset; }
    expect(recovered).toBe(report);
    expect((await s.search(id, "exclusive")).matches).toHaveLength(1);
  });
  it("fails explicitly when complete evidence cannot be stored", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-evidence-")); dirs.push(rootDir);
    const s = new ToolResultArtifactStore({ rootDir, getScope: () => null });
    await expect(prepareReduceEvidence("summarize", [{ item: "node", status: "done", summary: "x".repeat(5000) }], s, 2000)).rejects.toThrow("could not be stored");
  });
});
