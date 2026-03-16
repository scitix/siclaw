import fs from "node:fs";
import path from "node:path";

/**
 * Build a concise knowledge overview from topics/ and investigations/ directories.
 * Pure sync filesystem scan — no DB dependency.
 * Returns empty string if no knowledge files exist.
 */
export function buildKnowledgeOverview(memoryDir: string): string {
  const TOTAL_BUDGET = 1800;

  const topicsDir = path.join(memoryDir, "topics");
  const investigationsDir = path.join(memoryDir, "investigations");

  const topicEntries = scanTopics(topicsDir);
  const investigationEntries = scanInvestigations(investigationsDir);

  if (topicEntries.length === 0 && investigationEntries.length === 0) {
    return "";
  }

  const parts: string[] = ["## Knowledge Overview"];
  let currentLen = parts[0].length;

  // Build topics section
  if (topicEntries.length > 0) {
    const header = "\n\n### Accumulated Knowledge\n| Topic | Facts | Last updated |\n|-------|-------|-------------|";
    currentLen += header.length;

    const rows: string[] = [];
    for (const entry of topicEntries) {
      const row = `\n| ${entry.topic} | ${entry.factCount} | ${entry.lastUpdated} |`;
      if (currentLen + row.length > TOTAL_BUDGET - 300) break; // reserve space for investigations + footer
      rows.push(row);
      currentLen += row.length;
    }

    if (rows.length > 0) {
      parts.push(header + rows.join(""));
    }
  }

  // Build investigations section
  if (investigationEntries.length > 0) {
    const maxInvestigations = currentLen > TOTAL_BUDGET - 600 ? 3 : 5;
    const entries = investigationEntries.slice(0, maxInvestigations);

    const header = "\n\n### Recent Investigations";
    const lines = entries.map(e => `\n- ${e.date}: ${e.question}`);
    const section = header + lines.join("");

    if (currentLen + section.length <= TOTAL_BUDGET - 100) {
      parts.push(section);
      currentLen += section.length;
    }
  }

  const footer = '\n\nUse `memory_get` with path like "topics/<name>.md" to read details, or `memory_search` to find specific facts.';
  parts.push(footer);

  return parts.join("");
}

interface TopicInfo {
  topic: string;
  factCount: number;
  lastUpdated: string;
}

interface InvestigationInfo {
  date: string;
  question: string;
}

function scanTopics(topicsDir: string): TopicInfo[] {
  if (!fs.existsSync(topicsDir)) return [];

  let files: string[];
  try {
    files = fs.readdirSync(topicsDir).filter(f => f.endsWith(".md"));
  } catch {
    return [];
  }

  const entries: TopicInfo[] = [];
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(topicsDir, file), "utf-8");
      const factCount = content.split("\n").filter(line => line.startsWith("- ")).length;
      const lastUpdated = findLatestDateSection(content);
      entries.push({
        topic: file.replace(/\.md$/, ""),
        factCount,
        lastUpdated,
      });
    } catch {
      // Skip malformed files
    }
  }

  // Sort by lastUpdated descending
  entries.sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated));
  return entries;
}

/**
 * Find the most recent `## YYYY-MM-DD` section header in a topic file.
 */
function findLatestDateSection(content: string): string {
  const dateRegex = /^## (\d{4}-\d{2}-\d{2})/gm;
  let latest = "";
  let match;
  while ((match = dateRegex.exec(content)) !== null) {
    if (match[1] > latest) {
      latest = match[1];
    }
  }
  return latest || "unknown";
}

function scanInvestigations(investigationsDir: string): InvestigationInfo[] {
  if (!fs.existsSync(investigationsDir)) return [];

  let files: string[];
  try {
    files = fs.readdirSync(investigationsDir).filter(f => f.endsWith(".md"));
  } catch {
    return [];
  }

  // Sort by filename descending (filenames are date-based: YYYY-MM-DD-HH-MM-SS.md)
  files.sort((a, b) => b.localeCompare(a));

  const entries: InvestigationInfo[] = [];
  for (const file of files.slice(0, 5)) {
    try {
      // Read only first 300 bytes to extract the title
      const fd = fs.openSync(path.join(investigationsDir, file), "r");
      const buf = Buffer.alloc(300);
      const bytesRead = fs.readSync(fd, buf, 0, 300, 0);
      fs.closeSync(fd);

      const head = buf.toString("utf-8", 0, bytesRead);
      const titleMatch = head.match(/^# Investigation:\s*(.+)/m);
      const question = titleMatch ? titleMatch[1].trim() : file.replace(/\.md$/, "");

      // Parse date from filename (YYYY-MM-DD-HH-MM-SS.md → YYYY-MM-DD)
      const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
      const date = dateMatch ? dateMatch[1] : "unknown";

      entries.push({ date, question });
    } catch {
      // Skip unreadable files
    }
  }

  return entries;
}
