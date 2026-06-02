import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type SkillFileEncoding = "utf8" | "base64";

export interface SkillPackageFile {
  path: string;
  content: string;
  encoding: SkillFileEncoding;
  size: number;
  sha256: string;
  executable?: boolean;
}

export interface SkillScriptEntry {
  name: string;
  content: string;
}

export interface ParsedSkillPackage {
  dirName: string;
  name: string;
  description: string;
  labels: string[];
  specs: string;
  scripts: SkillScriptEntry[];
  files: SkillPackageFile[];
}

export const SKILL_FILE_NAME = "SKILL.md";

const MAX_SKILL_FILES = 200;
const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SKILL_TOTAL_BYTES = 10 * 1024 * 1024;
const FORBIDDEN_SEGMENTS = new Set([".git", "node_modules"]);

export function parseFrontmatter(md: string): { name: string; description: string } {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { name: "", description: "" };

  const block = match[1];
  const nameMatch = block.match(/^name:\s*(.+)$/m);
  const name = nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, "") : "";

  let description = "";
  const lines = block.split("\n");
  const descIdx = lines.findIndex((line) => line.match(/^description:\s/));
  if (descIdx >= 0) {
    const firstLine = lines[descIdx].replace(/^description:\s*/, "").trim();
    if (firstLine === ">-" || firstLine === ">" || firstLine === "|" || firstLine === "|-") {
      const contLines: string[] = [];
      for (let i = descIdx + 1; i < lines.length; i++) {
        if (lines[i].match(/^\s+/)) contLines.push(lines[i].trim());
        else break;
      }
      description = contLines.join(" ");
    } else {
      description = firstLine.replace(/^["']|["']$/g, "");
    }
  }

  return { name, description };
}

export function decodeSkillFileContent(file: Pick<SkillPackageFile, "content" | "encoding">): string {
  if (file.encoding === "base64") return Buffer.from(file.content, "base64").toString("utf8");
  return file.content;
}

function encodeBuffer(buffer: Buffer): Pick<SkillPackageFile, "content" | "encoding" | "size" | "sha256"> {
  const utf8 = buffer.toString("utf8");
  const roundTrip = Buffer.from(utf8, "utf8");
  const encoding: SkillFileEncoding = roundTrip.equals(buffer) ? "utf8" : "base64";
  const content = encoding === "utf8" ? utf8.replace(/\r\n/g, "\n") : buffer.toString("base64");
  const contentBytes = encoding === "utf8" ? Buffer.from(content, "utf8") : buffer;
  return {
    content,
    encoding,
    size: contentBytes.length,
    sha256: createHash("sha256").update(contentBytes).digest("hex"),
  };
}

function normalizePath(rawPath: string): string {
  const normalized = String(rawPath || "").replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) {
    throw new Error(`Unsafe skill file path: ${rawPath}`);
  }
  const parts = normalized.split("/");
  if (parts.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Unsafe skill file path: ${rawPath}`);
  }
  for (const segment of parts) {
    if (FORBIDDEN_SEGMENTS.has(segment) || segment.startsWith(".")) {
      throw new Error(`Unsupported skill file path segment: ${segment}`);
    }
  }
  return parts.join("/");
}

function normalizeFileObject(raw: any): SkillPackageFile {
  const filePath = normalizePath(raw?.path ?? raw?.name);
  const encoding: SkillFileEncoding = raw?.encoding === "base64" ? "base64" : "utf8";
  if (typeof raw?.content !== "string") {
    throw new Error(`Skill file ${filePath} content must be a string`);
  }
  const bytes = encoding === "base64"
    ? Buffer.from(raw.content, "base64")
    : Buffer.from(raw.content.replace(/\r\n/g, "\n"), "utf8");
  if (bytes.length > MAX_SKILL_FILE_BYTES) {
    throw new Error(`Skill file ${filePath} exceeds ${MAX_SKILL_FILE_BYTES} bytes`);
  }
  return {
    path: filePath,
    content: encoding === "utf8" ? bytes.toString("utf8") : raw.content,
    encoding,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ...(raw?.executable ? { executable: true } : {}),
  };
}

export function normalizeSkillFiles(rawFiles: unknown): SkillPackageFile[] {
  if (!Array.isArray(rawFiles)) throw new Error("files must be an array");
  if (rawFiles.length > MAX_SKILL_FILES) {
    throw new Error(`Skill package exceeds ${MAX_SKILL_FILES} files`);
  }
  const seen = new Set<string>();
  let total = 0;
  const files = rawFiles.map(normalizeFileObject).sort((a, b) => a.path.localeCompare(b.path));
  for (const file of files) {
    if (seen.has(file.path)) throw new Error(`Duplicate skill file path: ${file.path}`);
    seen.add(file.path);
    total += file.size;
  }
  if (total > MAX_SKILL_TOTAL_BYTES) {
    throw new Error(`Skill package exceeds ${MAX_SKILL_TOTAL_BYTES} total bytes`);
  }
  return files;
}

function stripSingleWrapper(files: SkillPackageFile[]): SkillPackageFile[] {
  if (files.some((file) => file.path === SKILL_FILE_NAME)) return files;

  const skillMdRoots = files
    .filter((file) => file.path.endsWith(`/${SKILL_FILE_NAME}`))
    .map((file) => file.path.slice(0, -(`/${SKILL_FILE_NAME}`).length));
  const lowerCaseRoots = files
    .filter((file) => file.path.toLowerCase().endsWith("/skill.md") || file.path.toLowerCase() === "skill.md")
    .map((file) => file.path);

  if (skillMdRoots.length === 0 && lowerCaseRoots.length > 0) {
    throw new Error("Skill package must use uppercase SKILL.md");
  }
  const roots = [...new Set(skillMdRoots)];
  if (roots.length !== 1) return files;

  const root = `${roots[0]}/`;
  if (!files.every((file) => file.path.startsWith(root))) return files;
  return files.map((file) => ({ ...file, path: file.path.slice(root.length) }));
}

export function scriptsFromSkillFiles(files: SkillPackageFile[]): SkillScriptEntry[] {
  return files
    .filter((file) => /^scripts\/[^/]+\.(sh|py)$/.test(file.path))
    .map((file) => ({ name: file.path.slice("scripts/".length), content: decodeSkillFileContent(file) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function skillFilesFromLegacy(
  specs: string | null | undefined,
  scripts: SkillScriptEntry[] | null | undefined,
): SkillPackageFile[] {
  const rawFiles: Array<Pick<SkillPackageFile, "path" | "content" | "encoding" | "executable">> = [];
  if (specs) rawFiles.push({ path: SKILL_FILE_NAME, content: specs, encoding: "utf8" });
  for (const script of Array.isArray(scripts) ? scripts : []) {
    rawFiles.push({
      path: `scripts/${script.name}`,
      content: script.content,
      encoding: "utf8",
      executable: script.name.endsWith(".sh") || script.name.endsWith(".py"),
    });
  }
  return normalizeSkillFiles(rawFiles);
}

export function parseSingleSkillPackage(
  rawFiles: unknown,
  opts: { labels?: string[]; expectedDirName?: string } = {},
): ParsedSkillPackage {
  const normalized = normalizeSkillFiles(rawFiles);
  const wrapperRoot = (() => {
    if (normalized.some((file) => file.path === SKILL_FILE_NAME)) return undefined;
    const roots = [...new Set(normalized
      .filter((file) => file.path.endsWith(`/${SKILL_FILE_NAME}`))
      .map((file) => file.path.slice(0, -(`/${SKILL_FILE_NAME}`).length)))];
    return roots.length === 1 && normalized.every((file) => file.path.startsWith(`${roots[0]}/`))
      ? roots[0]
      : undefined;
  })();
  const files = stripSingleWrapper(normalized);
  const skillMd = files.find((file) => file.path === SKILL_FILE_NAME);
  if (!skillMd) {
    if (files.some((file) => file.path.toLowerCase() === "skill.md")) {
      throw new Error("Skill package must use uppercase SKILL.md");
    }
    throw new Error("Skill package must include SKILL.md");
  }

  const specs = decodeSkillFileContent(skillMd);
  const { name, description } = parseFrontmatter(specs);
  if (!name) throw new Error("SKILL.md frontmatter must include a name field");
  const expectedDirName = opts.expectedDirName ?? wrapperRoot;
  if (expectedDirName && expectedDirName !== name) {
    throw new Error(`Skill directory "${expectedDirName}" does not match SKILL.md name "${name}"`);
  }

  return {
    dirName: expectedDirName ?? name,
    name,
    description,
    labels: opts.labels ?? [],
    specs,
    scripts: scriptsFromSkillFiles(files),
    files,
  };
}

export function collectSkillDirectoryFiles(dirPath: string): SkillPackageFile[] {
  const files: SkillPackageFile[] = [];
  let fileCount = 0;
  let totalBytes = 0;

  function walk(currentDir: string, relDir: string): void {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || FORBIDDEN_SEGMENTS.has(entry.name)) {
        throw new Error(`Unsupported skill file path segment: ${entry.name}`);
      }
      const abs = path.join(currentDir, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(abs);
      if (stat.isSymbolicLink()) throw new Error(`Symlink is not allowed in skill package: ${rel}`);
      if (stat.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.size > MAX_SKILL_FILE_BYTES) {
        throw new Error(`Skill file ${rel} exceeds ${MAX_SKILL_FILE_BYTES} bytes`);
      }
      fileCount += 1;
      if (fileCount > MAX_SKILL_FILES) {
        throw new Error(`Skill package exceeds ${MAX_SKILL_FILES} files`);
      }
      const encoded = encodeBuffer(fs.readFileSync(abs));
      totalBytes += encoded.size;
      if (totalBytes > MAX_SKILL_TOTAL_BYTES) {
        throw new Error(`Skill package exceeds ${MAX_SKILL_TOTAL_BYTES} total bytes`);
      }
      files.push({
        path: normalizePath(rel),
        ...encoded,
        ...(stat.mode & 0o111 ? { executable: true } : {}),
      });
    }
  }

  walk(dirPath, "");
  return normalizeSkillFiles(files);
}

export function parseSkillDirectory(
  dirName: string,
  dirPath: string,
  labelsMap: Record<string, string[]> = {},
): ParsedSkillPackage | null {
  const skillMdPath = path.join(dirPath, SKILL_FILE_NAME);
  if (!fs.existsSync(skillMdPath)) {
    if (fs.existsSync(path.join(dirPath, "skill.md"))) {
      throw new Error(`Skill directory "${dirName}" must use uppercase SKILL.md`);
    }
    return null;
  }
  return parseSingleSkillPackage(collectSkillDirectoryFiles(dirPath), {
    expectedDirName: dirName,
    labels: labelsMap[dirName] ?? [],
  });
}

export function computeSkillFilesHash(files: SkillPackageFile[]): string {
  const h = createHash("sha256");
  for (const file of normalizeSkillFiles(files)) {
    h.update(file.path);
    h.update("\0");
    h.update(file.encoding);
    h.update("\0");
    h.update(file.content);
    h.update("\0");
    h.update(file.executable ? "1" : "0");
    h.update("\0");
  }
  return h.digest("hex");
}

export function safeParseSkillFiles(raw: unknown, specs?: string | null, scripts?: SkillScriptEntry[] | null): SkillPackageFile[] {
  if (Array.isArray(raw)) return normalizeSkillFiles(raw);
  if (typeof raw === "string" && raw.trim()) {
    try {
      return normalizeSkillFiles(JSON.parse(raw));
    } catch {
      return skillFilesFromLegacy(specs, scripts);
    }
  }
  return skillFilesFromLegacy(specs, scripts);
}
