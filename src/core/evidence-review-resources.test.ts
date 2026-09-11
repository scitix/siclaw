import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { evidenceReviewResourceOptions } from "./agent-context.js";

// Use Pi's actual filesystem discovery: a mocked loader cannot prove isolation.
describe("evidence review Pi resources", () => {
  it("excludes ambient and explicitly supplied context, skills and extensions", async () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), ".evidence-review-fixture-"));
    const cwd = path.join(root, "workspace");
    const agentDir = path.join(root, "agent");
    const marker = "AMBIENT_EVIDENCE_REVIEW_SENTINEL";
    try {
      for (const dir of [cwd, agentDir]) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "AGENTS.md"), marker);
      }
      fs.writeFileSync(path.join(agentDir, "APPEND_SYSTEM.md"), marker);
      fs.writeFileSync(path.join(agentDir, "SYSTEM.md"), marker);
      const skillDir = path.join(agentDir, "skills", "ambient-review");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---\nname: ambient-review\ndescription: ${marker}\n---\n${marker}\n`);
      const extensionDir = path.join(agentDir, "extensions");
      fs.mkdirSync(extensionDir, { recursive: true });
      const extensionPath = path.join(extensionDir, "ambient.js");
      fs.writeFileSync(extensionPath, "export default function () {}\n");

      const control = new DefaultResourceLoader({ cwd, agentDir });
      await control.reload();
      expect(JSON.stringify(control.getAgentsFiles())).toContain(marker);
      expect(control.getAppendSystemPrompt().join("\n")).toContain(marker);
      expect(control.getSkills().skills.some((skill) => skill.name === "ambient-review")).toBe(true);
      expect(control.getExtensions().extensions.length).toBeGreaterThan(0);

      const isolated = new DefaultResourceLoader({
        cwd, agentDir,
        additionalSkillPaths: [skillDir],
        additionalExtensionPaths: [extensionPath],
        extensionFactories: [() => { throw new Error("inline extension must never execute"); }],
        appendSystemPrompt: [marker],
        ...evidenceReviewResourceOptions,
      });
      await isolated.reload();
      expect(isolated.getAgentsFiles().agentsFiles).toEqual([]);
      expect(isolated.getSkills().skills).toEqual([]);
      expect(isolated.getExtensions().extensions).toEqual([]);
      expect(isolated.getExtensions().errors).toEqual([]);
      expect(isolated.getAppendSystemPrompt()).toEqual([]);
      expect(isolated.getSystemPrompt()).not.toContain(marker);
      expect(isolated.getSystemPrompt()).toContain("untrusted data");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
