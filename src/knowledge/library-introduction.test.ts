import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { libraryIntroductionPreview, readLibraryIntroduction } from "./library-introduction.js";
import { buildKnowledgeWikiCatalog } from "../memory/overview-generator.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "library-introduction-")); dirs.push(root);
  fs.writeFileSync(path.join(root, "index.md"), "# Wiki\n- [Recovery](recovery.md)\n");
  fs.writeFileSync(path.join(root, "recovery.md"), "# Recovery\nCheck preconditions first.");
  const intro = { schema_version: 1, summary: "Device X recovery", overview: "Explains recovery and its limits.",
    knowledge_structure: "Concepts lead to procedures.", typical_questions: ["How can Device X recover?"],
    scope: "Only the documented release.", reading_guide: [{ path: "recovery.md", reason: "Preconditions." }] };
  fs.writeFileSync(path.join(root, ".library-introduction.json"), JSON.stringify(intro));
  return { root, intro };
}
it("exposes the full introduction as navigation without injecting all prose", () => {
  const { root, intro } = fixture();
  expect(readLibraryIntroduction(root)).toEqual({ status: "ready", introduction: intro });
  const prompt = buildKnowledgeWikiCatalog(root);
  expect(prompt).toContain(path.join(root, ".library-introduction.json"));
  expect(prompt).toContain(intro.summary);
  expect(prompt).toContain("Example questions (sample)");
  expect(prompt).not.toContain(intro.knowledge_structure);
});
it("bounds routing previews while retaining the complete stored introduction", () => {
  const { root, intro } = fixture();
  intro.overview = "Long explanation. ".repeat(500);
  fs.writeFileSync(path.join(root, ".library-introduction.json"), JSON.stringify(intro));
  const read = readLibraryIntroduction(root);
  expect(read.status).toBe("ready");
  expect(libraryIntroductionPreview(intro)[0].length).toBeLessThan(350);
  if (read.status === "ready") expect(read.introduction.overview).toBe(intro.overview);
});
it("distinguishes legacy absence from invalid metadata and rejects escaped reading paths", () => {
  const { root, intro } = fixture();
  intro.reading_guide[0].path = "../private.md";
  fs.writeFileSync(path.join(root, ".library-introduction.json"), JSON.stringify(intro));
  expect(readLibraryIntroduction(root).status).toBe("invalid");
  fs.unlinkSync(path.join(root, ".library-introduction.json"));
  expect(readLibraryIntroduction(root).status).toBe("missing");
});
