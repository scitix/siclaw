import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("node:os", async importOriginal => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => fixture.root,
    default: { ...actual.default, homedir: () => fixture.root } };
});
vi.mock("./config.js", async importOriginal => ({
  ...await importOriginal<typeof import("./config.js")>(),
  loadConfig: () => ({ providers: {}, allowedTools: null, paths: {
    skillsDir: ".siclaw/skills", userDataDir: ".siclaw/user-data",
    knowledgeDir: ".siclaw/knowledge", reposDir: "repos", docsDir: "docs",
  } }),
  getConfigPath: () => path.join(fixture.root, "settings.json"),
  getDefaultLlm: () => undefined,
  isMemoryEnabled: () => false,
}));
vi.mock("@earendil-works/pi-coding-agent", async importOriginal => ({
  ...await importOriginal<typeof import("@earendil-works/pi-coding-agent")>(),
  getAgentDir: () => path.join(fixture.root, "agent-config"),
}));
// Keep the real factory, resource loader and SDK file tools. No provider or
// model session is needed to exercise discovery and filesystem operations.
vi.mock("./pi-execution.js", () => ({
  createPiExecutionSession: async () => ({ session: { agent: {} }, extensionsResult: {},
    modelEnvelopeManifestRef: {}, modelEnvelopeInspectionRef: {},
  }),
}));
import { createSiclawSession } from "./agent-factory.js";

const sessions: Awaited<ReturnType<typeof createSiclawSession>>[] = [];
beforeEach(async () => {
  fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-boundary-"));
  vi.spyOn(process, "cwd").mockReturnValue(fixture.root);
});
afterEach(async () => {
  for (const session of sessions.splice(0)) session.knowledgeIndexer?.close();
  vi.restoreAllMocks();
  await fs.rm(fixture.root, { recursive: true, force: true });
});
async function skill(relative: string, name: string) {
  const file = path.join(fixture.root, relative, name, "SKILL.md");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `---\nname: ${name}\ndescription: Synthetic boundary fixture\n---\nUse synthetic evidence.\n`);
}
async function create(agentType: "sre" | "custom" | "knowledge_qa", scoped = true, extra: Parameters<typeof createSiclawSession>[0] = {}) {
  const result = await createSiclawSession({ agentType, mode: scoped ? "web" : "cli", ...(scoped ? { agentId: "agent-a" } : {}),
    sessionManager: SessionManager.create(fixture.root, path.join(fixture.root, "sessions")), ...extra,
  });
  sessions.push(result);
  return result;
}
describe("factory resource boundaries", () => {
  it.each(["sre", "custom", "knowledge_qa"] as const)("filters ambient Skills before the first %s sync", async type => {
    await skill("agent-config/skills", "ambient-helper");
    await skill("skills/core", "bundled-helper");
    const result = await create(type);
    expect(result.skillNames).toContain("bundled-helper");
    expect(result.skillNames).not.toContain("ambient-helper");
  });
  it("filters ambient Skills with an older Runtime's read-only QA whitelist", async () => {
    await skill("agent-config/skills", "ambient-helper");
    const result = await create("knowledge_qa", true, { allowedTools: ["read", "grep", "find", "ls"] });
    expect(result.skillNames).not.toContain("ambient-helper");
  });
  it("does not treat an unidentified web session as standalone CLI", async () => {
    await skill("agent-config/skills", "ambient-helper");
    expect((await create("sre", false, { mode: "web" })).skillNames).not.toContain("ambient-helper");
  });
  it("keeps an explicit missing Portal directory authoritative", async () => {
    await skill("agent-config/skills", "ambient-helper");
    const result = await create("custom", false, { portalSkillsDir: path.join(fixture.root, "portal/resolved") });
    expect(result.skillNames).not.toContain("ambient-helper");
  });
  it.each(["sre", "custom"] as const)("preserves unscoped %s CLI discovery", async type => {
    await skill("agent-config/skills", "ambient-helper");
    expect((await create(type, false)).skillNames).toContain("ambient-helper");
  });
  it("keeps QA working files inside user-data through the factory's real Write tool", async () => {
    const result = await create("knowledge_qa");
    const write = result.customTools.find(tool => tool.name === "write")!;
    const inside = path.join(fixture.root, ".siclaw/user-data/report.md");
    await write.execute("inside", { path: inside, content: "Research result" });
    expect(await fs.readFile(inside, "utf8")).toBe("Research result");
    const outsideDir = path.join(fixture.root, "outside");
    await fs.mkdir(outsideDir);
    await fs.symlink(outsideDir, path.join(fixture.root, ".siclaw/user-data/link"));
    await expect(write.execute("link", { path: path.join(fixture.root, ".siclaw/user-data/link/escaped.md"), content: "Denied" })).rejects.toThrow(/blocked/);
    await expect(fs.access(path.join(outsideDir, "escaped.md"))).rejects.toThrow();
    const edit = result.customTools.find(tool => tool.name === "edit")!;
    await edit.execute("edit-inside", { path: inside, edits: [{ oldText: "Research result", newText: "Updated result" }] });
    expect(await fs.readFile(inside, "utf8")).toBe("Updated result");
    const external = path.join(outsideDir, "existing.md");
    await fs.writeFile(external, "Original");
    const linked = path.join(fixture.root, ".siclaw/user-data/linked.md");
    await fs.symlink(external, linked);
    await expect(edit.execute("edit-link", { path: linked, edits: [{ oldText: "Original", newText: "Changed" }] })).rejects.toThrow(/blocked/);
    await expect(write.execute("write-link", { path: linked, content: "Changed" })).rejects.toThrow(/blocked/);
    expect(await fs.readFile(external, "utf8")).toBe("Original");
    const outside = path.join(fixture.root, "outside.md");
    await expect(write.execute("outside", { path: outside, content: "Denied" })).rejects.toThrow(/blocked/);
    await expect(fs.access(outside)).rejects.toThrow();
  });
});
