import yaml from "js-yaml";

/**
 * Regression MD Parser — parses a markdown case-bank file into structured cases.
 *
 * SECURITY: parser output is split into PublicCase (agent-visible) and
 * PrivateCase (answer, never sent to agent). Callers must not leak the private
 * fields into the agent-facing prompt.
 */

export interface PublicCase {
  id: string;
  title: string;
  reproducible: boolean;
  faultType: string;
  namespace: string;
  tags: string[];
  /**
   * Short name used in generated pod name:
   *   deveval-regress-<shortName>-<runId>-<date>-<time>
   * Defaults to case id with trailing "-<digits>" stripped.
   */
  podShortName: string;
  /** Work orders — one will be picked as the agent prompt */
  workOrders: Array<{ difficulty: string; text: string }>;
}

export interface PrivateCase {
  id: string;
  /** YAML manifest to `kubectl apply` — reproducible=true only */
  injectYaml?: string;
  /** Pre-recorded kubectl outputs — reproducible=false only */
  fixtures?: Array<{ command: string; exitCode: number; output: string }>;
  /** Reference kubectl diagnostic commands (for scoring only) */
  solutionCommands: string[];
  /** Reference root cause & fix (for scoring only) */
  expectedAnswer: string;
  passThreshold: { commands: number; conclusion: number };
  stubReason?: string;
}

export interface ParsedCase {
  public: PublicCase;
  private: PrivateCase;
}

export interface ParseWarning {
  caseId: string;
  message: string;
}

export interface ParseResult {
  cases: ParsedCase[];
  warnings: ParseWarning[];
}

/**
 * Parse a markdown case-bank file.
 *
 * Format contract:
 *   - Cases separated by "## Case: <id>" headings
 *   - Each case contains a ```yaml frontmatter block
 *   - Standard sections: "### 工单描述", "### 注入 YAML" | "### Fixtures",
 *     "### 题解 kubectl", "### 期望结论"
 */
export function parseRegressionMarkdown(content: string): ParseResult {
  const warnings: ParseWarning[] = [];
  const cases: ParsedCase[] = [];

  // Split by "## Case: <id>" — each chunk starts with that heading
  const blocks = splitCaseBlocks(content);

  for (const block of blocks) {
    try {
      const parsed = parseCase(block);
      cases.push(parsed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const idGuess = extractCaseIdFromBlock(block) ?? "<unknown>";
      warnings.push({ caseId: idGuess, message: msg });
    }
  }

  return { cases, warnings };
}

function splitCaseBlocks(content: string): string[] {
  const blocks: string[] = [];
  const lines = content.split("\n");
  let current: string[] | null = null;
  for (const line of lines) {
    if (/^##\s+Case:\s+/.test(line)) {
      if (current) blocks.push(current.join("\n"));
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) blocks.push(current.join("\n"));
  return blocks;
}

function extractCaseIdFromBlock(block: string): string | null {
  const m = block.match(/^##\s+Case:\s+(\S+)/m);
  return m ? m[1].trim() : null;
}

function parseCase(block: string): ParsedCase {
  const caseId = extractCaseIdFromBlock(block);
  if (!caseId) throw new Error("Missing '## Case: <id>' heading");

  // 1) Frontmatter: first ```yaml block
  const fm = extractFirstCodeBlock(block, "yaml");
  if (!fm) throw new Error(`Case ${caseId}: missing YAML frontmatter block`);
  const meta = parseYaml(fm);

  const reproducible = meta.reproducible === true || meta.reproducible === "true";
  const title = String(meta.title ?? caseId);
  const faultType = String(meta.faultType ?? "unknown");
  const namespace = String(meta.namespace ?? "default");
  const tags = Array.isArray(meta.tags) ? meta.tags.map(String) : [];
  const passThreshold = {
    commands: Number(meta.passThreshold?.commands ?? 4),
    conclusion: Number(meta.passThreshold?.conclusion ?? 4),
  };
  const stubReason = typeof meta.stubReason === "string" ? meta.stubReason : undefined;
  const podShortName = sanitizeShortName(
    typeof meta.podShortName === "string" && meta.podShortName.trim()
      ? meta.podShortName.trim()
      : String(meta.id ?? caseId).replace(/-\d+$/, ""),
  );

  // 2) Sections
  const sections = extractSections(block);

  const workOrdersRaw = requireSection(sections, "工单描述", caseId);
  const workOrders = parseWorkOrders(workOrdersRaw, caseId);
  if (workOrders.length === 0) throw new Error(`Case ${caseId}: at least one work order required`);

  const solutionText = requireSection(sections, "题解 kubectl", caseId);
  const solutionCommands = extractBashCommands(solutionText);

  const expectedAnswer = requireSection(sections, "期望结论", caseId).trim();

  const pub: PublicCase = {
    id: String(meta.id ?? caseId),
    title,
    reproducible,
    faultType,
    namespace,
    tags,
    podShortName,
    workOrders,
  };

  const priv: PrivateCase = {
    id: pub.id,
    solutionCommands,
    expectedAnswer,
    passThreshold,
    stubReason,
  };

  if (reproducible) {
    const injectSection = sections.get("注入 YAML");
    if (!injectSection) {
      throw new Error(`Case ${caseId}: reproducible=true requires '### 注入 YAML' section`);
    }
    if (sections.has("Fixtures")) {
      throw new Error(`Case ${caseId}: reproducible=true must NOT have '### Fixtures' section`);
    }
    const yaml = extractFirstCodeBlock(injectSection, "yaml");
    if (!yaml) throw new Error(`Case ${caseId}: '### 注入 YAML' must contain a \`\`\`yaml code block`);
    priv.injectYaml = yaml;
  } else {
    const fixturesSection = sections.get("Fixtures");
    if (!fixturesSection) {
      throw new Error(`Case ${caseId}: reproducible=false requires '### Fixtures' section`);
    }
    if (sections.has("注入 YAML")) {
      throw new Error(`Case ${caseId}: reproducible=false must NOT have '### 注入 YAML' section`);
    }
    priv.fixtures = parseFixtures(fixturesSection, caseId);
    if (priv.fixtures.length === 0) {
      throw new Error(`Case ${caseId}: at least one fixture required`);
    }
  }

  return { public: pub, private: priv };
}

/** Extract ### sections as a map: heading (without ###) → body */
function extractSections(block: string): Map<string, string> {
  const result = new Map<string, string>();
  const lines = block.split("\n");
  let currentHeading: string | null = null;
  let currentBody: string[] = [];

  for (const line of lines) {
    const m = line.match(/^###\s+(.+?)\s*$/);
    if (m) {
      if (currentHeading !== null) {
        result.set(currentHeading, currentBody.join("\n"));
      }
      currentHeading = m[1].trim();
      currentBody = [];
    } else if (currentHeading !== null) {
      currentBody.push(line);
    }
  }
  if (currentHeading !== null) result.set(currentHeading, currentBody.join("\n"));
  return result;
}

function requireSection(sections: Map<string, string>, name: string, caseId: string): string {
  const s = sections.get(name);
  if (s === undefined) throw new Error(`Case ${caseId}: missing '### ${name}' section`);
  return s;
}

/** Extract first fenced code block of a given language, returning its inner content */
function extractFirstCodeBlock(text: string, lang: string): string | null {
  const re = new RegExp("```" + lang + "\\s*\\n([\\s\\S]*?)```", "m");
  const m = text.match(re);
  return m ? m[1].replace(/\n$/, "") : null;
}

/** Extract every command (non-empty, non-comment line) from a ```bash block */
function extractBashCommands(text: string): string[] {
  const re = /```(?:bash|sh)?\s*\n([\s\S]*?)```/g;
  const cmds: string[] = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    for (const line of m[1].split("\n")) {
      const t = line.trim();
      if (t && !t.startsWith("#")) cmds.push(t);
    }
  }
  return cmds;
}

function parseWorkOrders(
  text: string,
  caseId: string,
): Array<{ difficulty: string; text: string }> {
  // Each bullet: "- **green**: ..." or "- **yellow**: ..."
  const orders: Array<{ difficulty: string; text: string }> = [];
  const lines = text.split("\n");
  for (const line of lines) {
    const m = line.match(/^\s*-\s+\*\*(green|yellow|red)\*\*\s*[::]\s*(.+?)\s*$/);
    if (m) orders.push({ difficulty: m[1], text: m[2] });
  }
  if (orders.length === 0) {
    throw new Error(
      `Case ${caseId}: work orders must use format '- **green|yellow|red**: <text>'`,
    );
  }
  return orders;
}

function parseFixtures(
  text: string,
  caseId: string,
): Array<{ command: string; exitCode: number; output: string }> {
  // Pattern: "#### `kubectl ...`" heading, then a code block with first line "exit: N" then "---" then output.
  const fixtures: Array<{ command: string; exitCode: number; output: string }> = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const headingMatch = lines[i].match(/^####\s+`(.+?)`\s*$/);
    if (!headingMatch) { i++; continue; }
    const command = headingMatch[1].trim();

    // Find next ``` block
    let j = i + 1;
    while (j < lines.length && !/^```/.test(lines[j])) j++;
    if (j >= lines.length) throw new Error(`Case ${caseId}: fixture for '${command}' missing code block`);
    const blockStart = j + 1;
    let k = blockStart;
    while (k < lines.length && !/^```/.test(lines[k])) k++;
    const bodyLines = lines.slice(blockStart, k);

    // First non-empty line should be "exit: N", then a "---" separator, then output
    let exitCode = 0;
    let sepIdx = -1;
    for (let p = 0; p < bodyLines.length; p++) {
      const em = bodyLines[p].match(/^exit:\s*(\d+)\s*$/);
      if (em) exitCode = parseInt(em[1], 10);
      if (/^---\s*$/.test(bodyLines[p])) { sepIdx = p; break; }
    }
    const output = sepIdx >= 0 ? bodyLines.slice(sepIdx + 1).join("\n") : bodyLines.join("\n");
    fixtures.push({ command, exitCode, output });
    i = k + 1;
  }
  return fixtures;
}

/** K8s DNS-1123 subdomain: lowercase alphanumeric and '-', start/end alphanumeric. */
function sanitizeShortName(s: string): string {
  const cleaned = s
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 20);
  return cleaned || "case";
}

function parseYaml(text: string): Record<string, any> {
  const parsed = yaml.load(text);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, any>;
  }
  throw new Error("Frontmatter YAML must be a mapping");
}
