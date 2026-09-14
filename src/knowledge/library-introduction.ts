import fs from "node:fs";
import path from "node:path";

export const LIBRARY_INTRODUCTION_FILE = ".library-introduction.json";
export const LIBRARY_INTRODUCTION_MAX_BYTES = 48 * 1024;
export interface LibraryIntroduction {
  schema_version: 1;
  summary: string;
  overview: string;
  knowledge_structure: string;
  typical_questions: string[];
  scope: string;
  reading_guide: Array<{ path: string; reason: string }>;
}
type IntroductionRead = { status: "ready"; introduction: LibraryIntroduction } | { status: "missing" | "invalid" };

/** Compact routing previews; the original fields remain available in the sidecar. */
export function libraryIntroductionPreview(introduction: LibraryIntroduction): string[] {
  const preview = (value: string, limit: number) => {
    const chars = [...value.trim().replace(/\s+/g, " ")];
    return chars.length > limit ? chars.slice(0, limit).join("") + "…" : chars.join("");
  };
  return [
    `Overview preview: ${preview(introduction.overview, 320)}`,
    `Example questions (sample): ${introduction.typical_questions.slice(0, 3).map(q => preview(q, 80)).join(" / ")}`,
  ];
}

/** Published navigation metadata. It does not establish answer or citation eligibility. */
export function readLibraryIntroduction(root: string): IntroductionRead {
  const file = path.join(root, LIBRARY_INTRODUCTION_FILE);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > LIBRARY_INTRODUCTION_MAX_BYTES) return { status: "invalid" };
    const body = fs.readFileSync(file, "utf8");
    if (Buffer.byteLength(body) > LIBRARY_INTRODUCTION_MAX_BYTES) return { status: "invalid" };
    const value = JSON.parse(body) as LibraryIntroduction;
    if (!value || value.schema_version !== 1 ||
        [value.summary, value.overview, value.knowledge_structure, value.scope].some(s => typeof s !== "string" || !s.trim()) ||
        [...value.summary].length > 100 || value.summary.trim().replace(/\s+/g, " ") !== value.summary ||
        !Array.isArray(value.typical_questions) || !value.typical_questions.length || value.typical_questions.length > 12 ||
        value.typical_questions.some(s => typeof s !== "string" || !s.trim()) ||
        !Array.isArray(value.reading_guide) || !value.reading_guide.length || value.reading_guide.length > 12) return { status: "invalid" };
    for (const entry of value.reading_guide) {
      if (!entry || typeof entry.path !== "string" || !entry.path.endsWith(".md") || /[\\?#]/.test(entry.path) ||
          entry.path.split("/").some(p => !p || p.startsWith(".")) || typeof entry.reason !== "string" || !entry.reason.trim()) return { status: "invalid" };
      let current = root;
      for (const part of entry.path.split("/")) {
        current = path.join(current, part);
        if (fs.lstatSync(current).isSymbolicLink()) return { status: "invalid" };
      }
      if (!fs.statSync(current).isFile()) return { status: "invalid" };
    }
    return { status: "ready", introduction: value };
  } catch (error) {
    // Only absence of the sidecar is a legacy library. Missing guide targets are invalid.
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !fs.existsSync(file)) return { status: "missing" };
    return { status: "invalid" };
  }
}
