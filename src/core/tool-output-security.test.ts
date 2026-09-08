import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { ToolResultArtifactStore, withToolResultArtifactCapture, getToolResultArtifactReference } from "./tool-result-artifact.js";
import { postExecSecurity } from "../tools/infra/security-pipeline.js";
import { analyzeOutput } from "../tools/infra/output-sanitizer.js";
import { DiskTaskOutput, getTaskOutputPath, readTaskOutputPage } from "../tools/cmd-exec/disk-output.js";
import { withToolOutputContext } from "./tool-output-context.js";
import { sweepSessionToolOutputs } from "./tool-output-cleanup.js";
const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true }); });
async function setup(session: string, root?: string) {
  const base = root ?? await fs.mkdtemp(path.join(os.tmpdir(), "siclaw-output-security-"));
  if (!root) roots.push(base);
  const store = new ToolResultArtifactStore({ rootDir: path.join(base, session, ".tool-results"), getScope: () => ({ agentId: "agent", sessionId: session }) });
  const directory = await store.scopedDirectory();
  return { base, store, directory };
}
it("stores complete sanitized output, including the middle, without preserving secret fields", async () => {
  const { store } = await setup("a");
  const body = JSON.stringify({ kind: "Secret", metadata: { name: "test", annotations: { note: "x".repeat(18000) } }, data: { password: "PRIVATE_VALUE" } });
  const tool = withToolResultArtifactCapture({ name: "bash", label: "bash", description: "test", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: postExecSecurity(body, analyzeOutput("kubectl", ["get", "secret", "-o", "json"]), { stderr: "password: STDERR_SECRET" }) }] }) }, store, 0);
  const result = await tool.execute("call", {});
  const reference = getToolResultArtifactReference(result.details)!;
  expect(reference).toBeTruthy();
  const full = await store.read(reference.id, 0, 32000);
  expect(full.text).not.toContain("PRIVATE_VALUE");
  expect(full.text).not.toContain("STDERR_SECRET");
  expect(full.text).toContain("x".repeat(18000));
  expect(JSON.stringify(result.content)).not.toContain("/tmp/");
});
it("keeps overlapping tool executions in separate session files and rejects cross-session artifact IDs", async () => {
  const a = await setup("a"), b = await setup("b", a.base);
  let release!: () => void;
  const barrier = new Promise<void>(r => { release = r; });
  const run = (store: ToolResultArtifactStore, value: string, wait: boolean) => withToolResultArtifactCapture({ name: "bash", label: "bash", description: "test", parameters: Type.Object({}), execute: async () => {
    if (wait) await barrier; else release();
    return { content: [{ type: "text", text: postExecSecurity(value.repeat(9000), null) }] };
  } }, store, 0).execute("same-call-id", {});
  const [ar, br] = await Promise.all([run(a.store, "A", true), run(b.store, "B", false)]);
  const ai = getToolResultArtifactReference(ar.details)!.id, bi = getToolResultArtifactReference(br.details)!.id;
  expect((await a.store.read(ai)).text).toBe("A".repeat(9000));
  expect((await b.store.read(bi)).text).toBe("B".repeat(9000));
  await expect(a.store.read(bi)).rejects.toThrow("not found in this session");
  await expect(b.store.search(ai, "A")).rejects.toThrow("not found in this session");
});
it("isolates background output with the same job ID and paginates UTF-8 without losing bytes", async () => {
  const a = await setup("a"), b = await setup("b", a.base);
  const text = "头部\n" + "中文🚀 evidence\n".repeat(3000) + "尾部";
  const write = (directory: string, body: string) => withToolOutputContext({ directory, outputs: [] }, async () => {
    const disk = new DiskTaskOutput("same-id"); disk.append(body); await disk.flush(); disk.markFinal();
    return getTaskOutputPath("same-id");
  });
  const [ap, bp] = await Promise.all([write(a.directory, text), write(b.directory, "OTHER")]);
  expect(ap).not.toBe(bp);
  await withToolOutputContext({ directory: a.directory, outputs: [] }, async () => {
    let offset: number | null = 0, full = "";
    while (offset !== null) { const page = await readTaskOutputPage("same-id", offset, 31); full += page.output; offset = page.next_offset; }
    expect(full).toBe(text);
  });
});
it("sweeps expired artifacts after restart but retains fresh data and active output", async () => {
  const a = await setup("a"), b = await setup("b", a.base);
  const old = new ToolResultArtifactStore({ rootDir: path.join(a.base, "a", ".tool-results"), getScope: () => ({ agentId: "agent", sessionId: "a" }), now: () => Date.now() - 25 * 3600000 });
  const expired = await old.capture({ text: "old", toolCallId: "old", toolName: "test" });
  const fresh = await b.store.capture({ text: "fresh", toolCallId: "new", toolName: "test" });
  const disk = await withToolOutputContext({ directory: a.directory, outputs: [] }, async () => {
    const disk = new DiskTaskOutput("active"); disk.append("running"); await disk.flush();
    const file = getTaskOutputPath("active"); await fs.utimes(file, 1, 1); return { disk, file };
  });
  await sweepSessionToolOutputs(a.base);
  expect(await fs.readFile(disk.file, "utf8")).toBe("running");
  if (!("reference" in expired) || !("reference" in fresh)) throw new Error("capture failed");
  await expect(a.store.read(expired.reference.id)).rejects.toThrow("not found");
  expect((await b.store.read(fresh.reference.id)).text).toBe("fresh");
  disk.disk.markFinal(); await sweepSessionToolOutputs(a.base);
  await expect(fs.stat(disk.file)).rejects.toThrow();
});
it("rejects symlinked artifact contents even if the external text matches the digest", async () => {
  const a = await setup("a");
  const captured = await a.store.capture({ text: "private", toolCallId: "call", toolName: "test" });
  if (!("reference" in captured)) throw new Error("capture failed");
  const file = path.join(a.directory, `${captured.reference.id}.txt`), external = path.join(a.base, "external");
  await fs.writeFile(external, "private"); await fs.rm(file); await fs.symlink(external, file);
  await expect(a.store.read(captured.reference.id)).rejects.toThrow("unavailable");
  expect((await fs.stat(a.directory)).mode & 0o777).toBe(0o700);
});
it("enforces a shared quota across concurrent store instances without evicting live evidence", async () => {
  const a = await setup("a");
  const make = () => new ToolResultArtifactStore({ rootDir: path.join(a.base, "a", ".tool-results"), getScope: () => ({ agentId: "agent", sessionId: "a" }), maxScopeBytes: 10 });
  const results = await Promise.all([make().capture({ text: "123456", toolCallId: "1", toolName: "test" }), make().capture({ text: "abcdef", toolCallId: "2", toolName: "test" })]);
  expect(results.filter(r => "reference" in r)).toHaveLength(1);
  expect(results.filter(r => "failure" in r)).toHaveLength(1);
});
