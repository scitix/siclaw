const MAX_DELEGATE_CAPSULE_CHARS = 1800;
const TRUNCATED_SUFFIX = "\n\n[Full sub-agent report is available in the Agent Work card.]";

export interface DelegateSummaryBundle {
  capsule: string;
  fullSummary: string;
  truncated: boolean;
}

function normalizeReportText(text: string): string {
  return text
    .replace(/\s*\(Empty response:\s*\{[\s\S]*?\}\)\s*/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

function sectionHeading(line: string): { level: number; label: string } | null {
  const trimmed = line.trim();
  const markdown = trimmed.match(/^(#{1,6})\s+(.+)$/);
  if (markdown) {
    return { level: markdown[1].length, label: normalizeHeadingLabel(markdown[2]) };
  }
  if (/^\*\*[^*]+:\*\*$/.test(trimmed) || /^\*\*[^*]+\*\*$/.test(trimmed)) {
    return { level: 2, label: normalizeHeadingLabel(trimmed.replace(/^\*\*/, "").replace(/\*\*:?$/, "")) };
  }
  return null;
}

function normalizeHeadingLabel(value: string): string {
  return value.replace(/:$/, "").trim().toLowerCase();
}

function extractSection(text: string, labels: Set<string>): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => {
    const heading = sectionHeading(line);
    return heading ? labels.has(heading.label) : false;
  });
  if (start < 0) return null;

  const startHeading = sectionHeading(lines[start]);
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const nextHeading = sectionHeading(lines[i]);
    if (nextHeading && startHeading && nextHeading.level <= startHeading.level) break;
    body.push(lines[i]);
  }
  const section = body.join("\n").trim();
  return section.length > 0 ? section : null;
}

function extractCapsuleSection(text: string): string | null {
  return extractSection(text, new Set(["evidence capsule", "parent capsule", "capsule"]));
}

function extractFullReportSection(text: string): string | null {
  return extractSection(text, new Set(["full report", "details", "audit report"]));
}

function truncateAtBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const budget = Math.max(0, maxChars - TRUNCATED_SUFFIX.length);
  const slice = text.slice(0, budget);
  const boundary = Math.max(
    slice.lastIndexOf("\n"),
    slice.lastIndexOf(". "),
    slice.lastIndexOf("; "),
  );
  const clipped = (boundary > budget * 0.55 ? slice.slice(0, boundary + 1) : slice).trimEnd();
  return `${clipped}${TRUNCATED_SUFFIX}`;
}

export function buildDelegateSummaryBundle(rawSummary: string, fallback = "Completed. No concise summary was returned."): DelegateSummaryBundle {
  const normalized = normalizeReportText(rawSummary) || fallback;
  const requestedCapsule = extractCapsuleSection(normalized);
  const fullSummary = extractFullReportSection(normalized) ?? normalized;
  const candidate = requestedCapsule ?? normalized;
  const capsule = truncateAtBoundary(candidate, MAX_DELEGATE_CAPSULE_CHARS);
  return {
    capsule,
    fullSummary,
    truncated: capsule !== candidate,
  };
}
