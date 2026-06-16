import { Resvg } from "@resvg/resvg-js";

export interface ChartSpec {
  title?: string;
  labels: string[];
  values: number[];
}

export interface RenderedReplyImage {
  kind: "card" | "chart" | "mermaid" | "image";
  image: Buffer;
}

export interface StripVisualBlocksOptions {
  /**
   * Strip raw visual source fences only when a real image artifact accompanies
   * the reply. By default we keep source blocks visible instead of pretending a
   * PNG was produced.
   */
  stripSourceBlocks?: boolean;
}

export interface RenderVisualImagesOptions {
  /**
   * Legacy fallback for source-only replies. Lark keeps this disabled by
   * default so it only forwards real image artifacts/data URLs.
   */
  renderSourceBlocks?: boolean;
  renderTableCharts?: boolean;
}

interface RenderableChartSpec {
  title?: string;
  labels: string[];
  series: Array<{
    name?: string;
    values: number[];
  }>;
}

interface MermaidNode {
  id: string;
  label: string;
  shape: "rect" | "diamond" | "oval";
}

interface MermaidEdge {
  from: string;
  to: string;
  label?: string;
}

interface MermaidGraph {
  direction: "LR" | "TD";
  nodes: MermaidNode[];
  edges: MermaidEdge[];
}

interface ConclusionCardSpec {
  title: string;
  status: "ok" | "warning" | "critical" | "info";
  summary?: string;
  metrics: Array<{ label: string; value: string; detail?: string }>;
  findings: string[];
  actions: string[];
}

const MAX_CHART_ROWS = 12;
const MAX_CHART_SERIES = 4;
const MAX_LABEL_LENGTH = 28;
const MAX_REPLY_IMAGES = 3;
const MAX_MERMAID_NODES = 20;
const MAX_MERMAID_EDGES = 32;
const FEISHU_IMAGE_LIMIT_BYTES = 10 * 1024 * 1024;

const DATA_IMAGE_URL_PATTERN =
  "data:image\\/(?:png|jpe?g|webp|svg\\+xml)(?:;charset=[^;,\\s)]+)?(?:;base64)?,[^\\s)]+";
const MARKDOWN_DATA_IMAGE_RE = new RegExp(
  `!\\[[^\\]]*\\]\\(\\s*(${DATA_IMAGE_URL_PATTERN})\\s*(?:["'][^)]*["'])?\\)`,
  "gi",
);
const RAW_DATA_IMAGE_RE = new RegExp(`(^|\\s)(${DATA_IMAGE_URL_PATTERN})`, "gi");

export function extractChartSpec(markdown: string): ChartSpec | null {
  const fenced = extractFencedChartSpecs(markdown)[0];
  if (fenced) return toSimpleChartSpec(fenced);
  return extractTableChart(markdown);
}

export async function renderChartPng(spec: ChartSpec): Promise<Buffer> {
  const normalized = normalizeSimpleChartSpec(spec);
  if (!normalized) throw new Error("invalid chart spec");
  return renderSvgPng(renderChartSvg(normalized));
}

export async function maybeRenderChartPng(markdown: string): Promise<Buffer | null> {
  const spec = extractChartSpec(markdown);
  if (!spec) return null;
  const png = await renderChartPng(spec);
  return withinFeishuLimit(png) ? png : null;
}

export function stripFencedChartBlocks(markdown: string): string {
  return stripFences(markdown, "chart", isRenderableChartSource);
}

export function stripVisualBlocks(markdown: string, options: StripVisualBlocksOptions = {}): string {
  let output = markdown;
  if (options.stripSourceBlocks) {
    output = stripFences(stripFences(output, "siclaw-card"), "conclusion-card");
    output = stripFences(output, "chart");
    output = stripFences(output, "mermaid");
  }
  const withoutDataImages = stripDataImages(output);
  return cleanupMarkdown(withoutDataImages);
}

export async function maybeRenderVisualImages(
  markdown: string,
  options: RenderVisualImagesOptions = {},
): Promise<RenderedReplyImage[]> {
  const images: RenderedReplyImage[] = [];

  for (const dataUrl of extractDataImageUrls(markdown)) {
    const image = await imageFromDataUrl(dataUrl);
    if (image && withinFeishuLimit(image)) images.push({ kind: "image", image });
    if (images.length >= MAX_REPLY_IMAGES) return images;
  }

  if (!options.renderSourceBlocks) return images;

  for (const spec of extractConclusionCardSpecs(markdown)) {
    const png = await renderSvgPng(renderConclusionCardSvg(spec));
    if (withinFeishuLimit(png)) images.push({ kind: "card", image: png });
    if (images.length >= MAX_REPLY_IMAGES) return images;
  }

  for (const spec of extractFencedChartSpecs(markdown)) {
    const png = await renderSvgPng(renderChartSvg(spec));
    if (withinFeishuLimit(png)) images.push({ kind: "chart", image: png });
    if (images.length >= MAX_REPLY_IMAGES) return images;
  }

  for (const graph of extractMermaidGraphs(markdown)) {
    const png = await renderSvgPng(renderMermaidSvg(graph));
    if (withinFeishuLimit(png)) images.push({ kind: "mermaid", image: png });
    if (images.length >= MAX_REPLY_IMAGES) return images;
  }

  if (images.length === 0 && options.renderTableCharts) {
    const tableChart = extractTableChart(markdown);
    if (tableChart) {
      const png = await renderChartPng(tableChart);
      if (withinFeishuLimit(png)) images.push({ kind: "chart", image: png });
    }
  }

  return images;
}

function extractConclusionCardSpecs(markdown: string): ConclusionCardSpec[] {
  const specs: ConclusionCardSpec[] = [];
  for (const language of ["siclaw-card", "conclusion-card"]) {
    for (const source of extractFenceBodies(markdown, language)) {
      try {
        const parsed = JSON.parse(source);
        const spec = normalizeConclusionCardSpec(parsed);
        if (spec) specs.push(spec);
      } catch {
        // Invalid card JSON should not break the primary markdown reply.
      }
    }
  }
  return specs;
}

function extractFencedChartSpecs(markdown: string): RenderableChartSpec[] {
  const specs: RenderableChartSpec[] = [];
  for (const source of extractFenceBodies(markdown, "chart")) {
    try {
      const parsed = JSON.parse(source);
      const spec = normalizeRenderableChartSpec(parsed);
      if (spec) specs.push(spec);
    } catch {
      // Invalid chart JSON should not break the primary markdown reply.
    }
  }
  return specs;
}

function isRenderableConclusionCardSource(source: string): boolean {
  try {
    return normalizeConclusionCardSpec(JSON.parse(source)) !== null;
  } catch {
    return false;
  }
}

function isRenderableChartSource(source: string): boolean {
  try {
    return normalizeRenderableChartSpec(JSON.parse(source)) !== null;
  } catch {
    return false;
  }
}

function extractMermaidGraphs(markdown: string): MermaidGraph[] {
  const graphs: MermaidGraph[] = [];
  for (const source of extractFenceBodies(markdown, "mermaid")) {
    const graph = parseMermaidFlowchart(source);
    if (graph) graphs.push(graph);
  }
  return graphs;
}

function extractFenceBodies(markdown: string, language: string): string[] {
  const bodies: string[] = [];
  const re = fenceRegex(language);
  markdown.replace(re, (_full, _prefix: string, body: string) => {
    bodies.push(body.trim());
    return _full;
  });
  return bodies;
}

function stripFences(
  markdown: string,
  language: string,
  shouldStrip: (source: string) => boolean = () => true,
): string {
  let removed = false;
  const stripped = markdown.replace(fenceRegex(language), (full, prefix: string, body: string) => {
    if (!shouldStrip(body.trim())) return full;
    removed = true;
    return prefix ? prefix : "";
  });
  return removed ? cleanupMarkdown(stripped) : markdown;
}

function fenceRegex(language: string): RegExp {
  return new RegExp(`(^|\\r?\\n)[ \\t]*\`\`\`${language}[ \\t]*\\r?\\n([\\s\\S]*?)\`\`\`[ \\t]*(?=\\r?\\n|$)`, "gi");
}

function stripDataImages(markdown: string): string {
  let removed = false;
  let output = markdown.replace(MARKDOWN_DATA_IMAGE_RE, (_full, dataUrl: string) => {
    if (!isSupportedDataImageUrl(dataUrl)) return _full;
    removed = true;
    return "";
  });
  output = output.replace(RAW_DATA_IMAGE_RE, (full, prefix: string, dataUrl: string) => {
    if (!isSupportedDataImageUrl(dataUrl)) return full;
    removed = true;
    return prefix || "";
  });
  return removed ? cleanupMarkdown(output) : markdown;
}

function extractDataImageUrls(markdown: string): string[] {
  const urls = new Set<string>();
  markdown.replace(MARKDOWN_DATA_IMAGE_RE, (_full, dataUrl: string) => {
    if (isSupportedDataImageUrl(dataUrl)) urls.add(dataUrl);
    return _full;
  });
  markdown.replace(RAW_DATA_IMAGE_RE, (_full, _prefix: string, dataUrl: string) => {
    if (isSupportedDataImageUrl(dataUrl)) urls.add(dataUrl);
    return _full;
  });
  return [...urls];
}

function isSupportedDataImageUrl(dataUrl: string): boolean {
  return /^data:image\/(?:png|jpe?g|webp|svg\+xml)(?:;charset=[^;,]+)?(?:;base64)?,/i.test(dataUrl);
}

async function imageFromDataUrl(dataUrl: string): Promise<Buffer | null> {
  const match = dataUrl.match(/^data:(image\/(?:png|jpe?g|webp|svg\+xml))(?:;charset=[^;,]+)?(;base64)?,([\s\S]*)$/i);
  if (!match) return null;

  const mime = match[1].toLowerCase();
  const isBase64 = Boolean(match[2]);
  const payload = match[3];
  if (mime === "image/svg+xml") {
    const svg = isBase64
      ? Buffer.from(payload.replace(/\s+/g, ""), "base64").toString("utf8")
      : decodeURIComponent(payload);
    return renderSvgPng(svg);
  }

  if (!isBase64) return null;
  const image = Buffer.from(payload.replace(/\s+/g, ""), "base64");
  return image.length > 0 ? image : null;
}

function normalizeRenderableChartSpec(value: unknown): RenderableChartSpec | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as {
    title?: unknown;
    labels?: unknown;
    values?: unknown;
    type?: unknown;
    data?: unknown;
    options?: unknown;
  };

  const simple = normalizeSimpleChartSpec(raw);
  if (simple) return simple;

  const chartJs = normalizeChartJsBarSpec(raw);
  if (chartJs) return chartJs;

  if (raw.type !== "bar" || !raw.data || typeof raw.data !== "object") return null;
  const data = raw.data as { categories?: unknown; series?: unknown };
  if (!Array.isArray(data.categories) || !Array.isArray(data.series)) return null;

  const labels = data.categories
    .slice(0, MAX_CHART_ROWS)
    .map((label) => normalizeLabel(label))
    .filter(Boolean);
  if (labels.length === 0) return null;

  const series = data.series.slice(0, MAX_CHART_SERIES).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as { name?: unknown; values?: unknown };
    if (!Array.isArray(row.values)) return [];
    const rowValues = row.values;
    const parsedValues = labels.map((_, i) => parseNumber(rowValues[i]));
    if (!parsedValues.some((n) => n !== null)) return [];
    const values = parsedValues.map((n) => n ?? 0);
    return [{
      name: typeof row.name === "string" ? normalizeLabel(row.name) : undefined,
      values,
    }];
  });
  if (series.length === 0) return null;

  return {
    title: normalizeTitle(raw.title),
    labels,
    series,
  };
}

function normalizeChartJsBarSpec(raw: { title?: unknown; type?: unknown; data?: unknown; options?: unknown }): RenderableChartSpec | null {
  const type = typeof raw.type === "string" ? raw.type.trim().toLowerCase() : undefined;
  if (type && type !== "bar") return null;
  if (!raw.data || typeof raw.data !== "object") return null;

  const data = raw.data as { labels?: unknown; datasets?: unknown };
  if (!Array.isArray(data.labels) || !Array.isArray(data.datasets)) return null;

  const labels = data.labels
    .slice(0, MAX_CHART_ROWS)
    .map((label) => normalizeLabel(label))
    .filter(Boolean);
  if (labels.length === 0) return null;

  const series = data.datasets.slice(0, MAX_CHART_SERIES).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const dataset = entry as { label?: unknown; data?: unknown };
    const dataPoints = dataset.data;
    if (!Array.isArray(dataPoints)) return [];
    const parsedValues = labels.map((_, i) => parseChartJsNumber(dataPoints[i]));
    if (!parsedValues.some((n) => n !== null)) return [];
    const values = parsedValues.map((n) => n ?? 0);
    return [{
      name: typeof dataset.label === "string" ? normalizeLabel(dataset.label) : undefined,
      values,
    }];
  });
  if (series.length === 0) return null;

  return {
    title: normalizeTitle(raw.title) ?? normalizeTitle(extractChartJsTitle(raw.options)),
    labels,
    series,
  };
}

function normalizeSimpleChartSpec(value: unknown): RenderableChartSpec | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { title?: unknown; labels?: unknown; values?: unknown };
  if (!Array.isArray(raw.labels) || !Array.isArray(raw.values)) return null;

  const rows: Array<{ label: string; value: number }> = [];
  const count = Math.min(raw.labels.length, raw.values.length, MAX_CHART_ROWS);
  for (let i = 0; i < count; i++) {
    const label = normalizeLabel(raw.labels[i]);
    const parsed = parseNumber(raw.values[i]);
    if (label && parsed !== null) rows.push({ label, value: parsed });
  }
  if (rows.length === 0) return null;

  return {
    title: normalizeTitle(raw.title),
    labels: rows.map((row) => row.label),
    series: [{ values: rows.map((row) => row.value) }],
  };
}

function toSimpleChartSpec(spec: RenderableChartSpec): ChartSpec {
  if (spec.series.length === 1) {
    return {
      title: spec.title,
      labels: spec.labels,
      values: spec.series[0].values,
    };
  }

  const values = spec.labels.map((_, index) =>
    spec.series.reduce((sum, series) => sum + (series.values[index] ?? 0), 0),
  );
  return {
    title: spec.title,
    labels: spec.labels,
    values,
  };
}

function extractTableChart(markdown: string): ChartSpec | null {
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    if (!looksLikeTableRow(lines[i]) || !looksLikeSeparator(lines[i + 1])) continue;

    const headers = splitTableRow(lines[i]);
    const rows: string[][] = [];
    for (let j = i + 2; j < lines.length; j++) {
      if (!looksLikeTableRow(lines[j])) break;
      const row = splitTableRow(lines[j]);
      if (row.length >= headers.length) rows.push(row);
    }
    const spec = tableToChartSpec(headers, rows);
    if (spec) return spec;
  }
  return null;
}

function tableToChartSpec(headers: string[], rows: string[][]): ChartSpec | null {
  if (headers.length < 2 || rows.length === 0) return null;

  let valueIndex = -1;
  let bestNumericCount = 0;
  for (let col = 0; col < headers.length; col++) {
    const numericCount = rows.reduce((count, row) => count + (parseNumber(row[col]) === null ? 0 : 1), 0);
    if (numericCount > bestNumericCount) {
      bestNumericCount = numericCount;
      valueIndex = col;
    }
  }
  if (valueIndex < 0 || bestNumericCount < 2) return null;

  const labelIndex = headers.findIndex((_, col) => col !== valueIndex);
  if (labelIndex < 0) return null;

  const chartRows: Array<{ label: string; value: number }> = [];
  for (const row of rows) {
    const label = normalizeLabel(row[labelIndex]);
    const value = parseNumber(row[valueIndex]);
    if (label && value !== null) chartRows.push({ label, value });
    if (chartRows.length >= MAX_CHART_ROWS) break;
  }
  if (chartRows.length < 2) return null;

  const labelHeader = normalizeLabel(headers[labelIndex]);
  const valueHeader = normalizeLabel(headers[valueIndex]);
  return {
    title: valueHeader && labelHeader ? `${valueHeader} by ${labelHeader}` : valueHeader || undefined,
    labels: chartRows.map((row) => row.label),
    values: chartRows.map((row) => row.value),
  };
}

function looksLikeTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && splitTableRow(trimmed).length >= 2;
}

function looksLikeSeparator(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/,/g, "").replace(/%$/, "");
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseChartJsNumber(value: unknown): number | null {
  const direct = parseNumber(value);
  if (direct !== null) return direct;
  if (!value || typeof value !== "object") return null;
  const point = value as { y?: unknown };
  return parseNumber(point.y);
}

function extractChartJsTitle(options: unknown): unknown {
  if (!options || typeof options !== "object") return undefined;
  const plugins = (options as { plugins?: unknown }).plugins;
  if (!plugins || typeof plugins !== "object") return undefined;
  const title = (plugins as { title?: unknown }).title;
  if (!title || typeof title !== "object") return undefined;
  return (title as { text?: unknown }).text;
}

function normalizeTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const title = value.replace(/\s+/g, " ").trim().slice(0, 80);
  return title || undefined;
}

function normalizeConclusionCardSpec(value: unknown): ConclusionCardSpec | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as {
    title?: unknown;
    status?: unknown;
    summary?: unknown;
    metrics?: unknown;
    findings?: unknown;
    actions?: unknown;
  };

  const title = normalizeCardText(raw.title, 90) || "Siclaw conclusion";
  const status = normalizeCardStatus(raw.status);
  const summary = normalizeCardText(raw.summary, 180);
  const metrics = normalizeCardMetrics(raw.metrics);
  const findings = normalizeCardList(raw.findings, 4, 130);
  const actions = normalizeCardList(raw.actions, 4, 130);

  if (!summary && metrics.length === 0 && findings.length === 0 && actions.length === 0) return null;
  return { title, status, summary, metrics, findings, actions };
}

function normalizeCardStatus(value: unknown): ConclusionCardSpec["status"] {
  if (typeof value !== "string") return "info";
  const status = value.trim().toLowerCase();
  if (status === "ok" || status === "warning" || status === "critical" || status === "info") return status;
  return "info";
}

function normalizeCardMetrics(value: unknown): ConclusionCardSpec["metrics"] {
  if (!Array.isArray(value)) return [];
  const metrics: ConclusionCardSpec["metrics"] = [];
  for (const entry of value.slice(0, 4)) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as { label?: unknown; value?: unknown; detail?: unknown };
    const label = normalizeCardText(row.label, 36);
    const metricValue = normalizeCardText(row.value, 32);
    if (!label || !metricValue) continue;
    const detail = normalizeCardText(row.detail, 60);
    metrics.push({ label, value: metricValue, detail });
  }
  return metrics;
}

function normalizeCardList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, maxItems)
    .map((item) => normalizeCardText(item, maxLength))
    .filter((item): item is string => Boolean(item));
}

function normalizeCardText(value: unknown, maxLength: number): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function normalizeLabel(value: unknown): string {
  if (value === null || value === undefined) return "";
  const label = String(value).replace(/\s+/g, " ").trim();
  return label.length > MAX_LABEL_LENGTH ? `${label.slice(0, MAX_LABEL_LENGTH - 3)}...` : label;
}

function renderConclusionCardSvg(spec: ConclusionCardSpec): string {
  const width = 960;
  const marginX = 54;
  const accent = cardAccent(spec.status);
  let y = 58;
  const body: string[] = [];

  body.push(`<text x="${marginX}" y="${y}" class="title">${escapeXml(spec.title)}</text>`);
  body.push(`
    <rect x="${width - 190}" y="${y - 28}" width="136" height="34" rx="17" fill="${accent.bg}" stroke="${accent.stroke}"/>
    <text x="${width - 122}" y="${y - 6}" text-anchor="middle" class="status" fill="${accent.text}">${escapeXml(statusLabel(spec.status))}</text>
  `);
  y += 36;

  if (spec.summary) {
    const lines = wrapText(spec.summary, 72, 3);
    body.push(renderTextLines(lines, marginX, y, "summary", 24));
    y += lines.length * 24 + 22;
  }

  if (spec.metrics.length > 0) {
    const gap = 16;
    const cardWidth = Math.floor((width - marginX * 2 - gap * (spec.metrics.length - 1)) / spec.metrics.length);
    const metricY = y;
    for (const [index, metric] of spec.metrics.entries()) {
      const x = marginX + index * (cardWidth + gap);
      body.push(`
        <rect x="${x}" y="${metricY}" width="${cardWidth}" height="96" rx="16" fill="#f8fafc" stroke="#e2e8f0"/>
        <text x="${x + 18}" y="${metricY + 30}" class="metricLabel">${escapeXml(metric.label)}</text>
        <text x="${x + 18}" y="${metricY + 62}" class="metricValue">${escapeXml(metric.value)}</text>
        ${metric.detail ? `<text x="${x + 18}" y="${metricY + 84}" class="metricDetail">${escapeXml(metric.detail)}</text>` : ""}
      `);
    }
    y += 120;
  }

  if (spec.findings.length > 0) {
    const section = renderCardSection("Key evidence", spec.findings, marginX, y, accent.stroke);
    body.push(section.svg);
    y = section.nextY + 18;
  }

  if (spec.actions.length > 0) {
    const section = renderCardSection("Next actions", spec.actions, marginX, y, "#16a34a");
    body.push(section.svg);
    y = section.nextY + 12;
  }

  const height = Math.max(360, y + 34);
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <style>
    text { font-family: Arial, sans-serif; }
    .title { font-size: 31px; font-weight: 800; fill: #0f172a; }
    .status { font-size: 14px; font-weight: 800; letter-spacing: 0.5px; }
    .summary { font-size: 18px; font-weight: 500; fill: #334155; }
    .sectionTitle { font-size: 16px; font-weight: 800; fill: #0f172a; }
    .item { font-size: 16px; font-weight: 500; fill: #334155; }
    .metricLabel { font-size: 13px; font-weight: 700; fill: #64748b; }
    .metricValue { font-size: 25px; font-weight: 800; fill: #0f172a; }
    .metricDetail { font-size: 12px; font-weight: 600; fill: #64748b; }
  </style>
  <rect width="100%" height="100%" fill="#ffffff"/>
  <rect x="0" y="0" width="14" height="${height}" fill="${accent.stroke}"/>
  <rect x="30" y="28" width="${width - 60}" height="${height - 56}" rx="22" fill="#ffffff" stroke="#e2e8f0"/>
  ${body.join("")}
</svg>`;
}

function renderCardSection(title: string, items: string[], x: number, y: number, color: string): { svg: string; nextY: number } {
  const parts: string[] = [];
  let cursor = y;
  parts.push(`<text x="${x}" y="${cursor}" class="sectionTitle">${escapeXml(title)}</text>`);
  cursor += 28;
  for (const item of items) {
    const lines = wrapText(item, 78, 2);
    parts.push(`<circle cx="${x + 7}" cy="${cursor - 6}" r="5" fill="${color}"/>`);
    parts.push(renderTextLines(lines, x + 22, cursor, "item", 22));
    cursor += lines.length * 22 + 8;
  }
  return { svg: parts.join(""), nextY: cursor };
}

function renderTextLines(lines: string[], x: number, y: number, className: string, lineHeight: number): string {
  return lines
    .map((line, i) => `<text x="${x}" y="${y + i * lineHeight}" class="${className}">${escapeXml(line)}</text>`)
    .join("");
}

function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.includes(" ") ? text.split(/\s+/) : text.split("");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const separator = text.includes(" ") && current ? " " : "";
    const candidate = current ? `${current}${separator}${word}` : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
    if (lines.length >= maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines && (words.join(text.includes(" ") ? " " : "").length > lines.join("").length)) {
    const last = lines[maxLines - 1];
    lines[maxLines - 1] = last.length > 3 ? `${last.slice(0, Math.max(0, maxChars - 3))}...` : last;
  }
  return lines;
}

function cardAccent(status: ConclusionCardSpec["status"]): { bg: string; stroke: string; text: string } {
  switch (status) {
    case "critical":
      return { bg: "#fef2f2", stroke: "#dc2626", text: "#991b1b" };
    case "warning":
      return { bg: "#fffbeb", stroke: "#f59e0b", text: "#92400e" };
    case "ok":
      return { bg: "#f0fdf4", stroke: "#16a34a", text: "#166534" };
    default:
      return { bg: "#eff6ff", stroke: "#2563eb", text: "#1d4ed8" };
  }
}

function statusLabel(status: ConclusionCardSpec["status"]): string {
  switch (status) {
    case "critical":
      return "CRITICAL";
    case "warning":
      return "WARNING";
    case "ok":
      return "OK";
    default:
      return "INFO";
  }
}

function renderChartSvg(spec: RenderableChartSpec): string {
  const width = 960;
  const height = 560;
  const margin = { top: spec.series.length > 1 ? 102 : 78, right: 44, bottom: 106, left: 82 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const allValues = spec.series.flatMap((series) => series.values);
  const minValue = Math.min(0, ...allValues);
  const maxValue = Math.max(0, ...allValues);
  const range = maxValue === minValue ? 1 : maxValue - minValue;
  const niceMax = maxValue + range * 0.08;
  const niceMin = minValue - range * 0.08;
  const niceRange = niceMax - niceMin || 1;
  const zeroY = valueToY(0, niceMin, niceRange, margin.top, plotHeight);
  const band = plotWidth / spec.labels.length;
  const groupWidth = Math.max(28, Math.min(90, band * 0.7));
  const barGap = spec.series.length > 1 ? 4 : 0;
  const barWidth = Math.max(8, Math.min(72, (groupWidth - barGap * (spec.series.length - 1)) / spec.series.length));
  const gridLines = 5;
  const showValueLabels = spec.labels.length * spec.series.length <= 18;

  const bars = spec.labels.map((label, labelIndex) => {
    const groupX = margin.left + labelIndex * band + (band - groupWidth) / 2;
    const labelX = margin.left + labelIndex * band + band / 2;
    const seriesBars = spec.series.map((series, seriesIndex) => {
      const value = series.values[labelIndex] ?? 0;
      const x = groupX + seriesIndex * (barWidth + barGap);
      const y = valueToY(Math.max(value, 0), niceMin, niceRange, margin.top, plotHeight);
      const y0 = valueToY(Math.min(value, 0), niceMin, niceRange, margin.top, plotHeight);
      const h = Math.max(2, Math.abs(y0 - y));
      const valueY = value >= 0 ? y - 10 : y0 + h + 18;
      const valueLabel = showValueLabels
        ? `<text x="${(x + barWidth / 2).toFixed(1)}" y="${valueY.toFixed(1)}" text-anchor="middle" class="value">${escapeXml(formatValue(value))}</text>`
        : "";
      return `
        <rect x="${x.toFixed(1)}" y="${Math.min(y, y0).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${h.toFixed(1)}" rx="7" fill="${chartColor(seriesIndex)}"/>
        ${valueLabel}
      `;
    }).join("");
    return `
      ${seriesBars}
      <text x="${labelX.toFixed(1)}" y="${height - 54}" text-anchor="end" transform="rotate(-28 ${labelX.toFixed(1)} ${height - 54})" class="label">${escapeXml(label)}</text>
    `;
  }).join("");

  const grids = Array.from({ length: gridLines + 1 }, (_, i) => {
    const value = niceMin + (niceRange * i) / gridLines;
    const y = valueToY(value, niceMin, niceRange, margin.top, plotHeight);
    return `
      <line x1="${margin.left}" x2="${width - margin.right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" class="grid"/>
      <text x="${margin.left - 14}" y="${(y + 4).toFixed(1)}" text-anchor="end" class="axis">${escapeXml(formatValue(value))}</text>
    `;
  }).join("");

  const legend = spec.series.length > 1
    ? `<g transform="translate(44 72)">${spec.series.map((series, i) => `
        <rect x="${i * 170}" y="0" width="14" height="14" rx="4" fill="${chartColor(i)}"/>
        <text x="${i * 170 + 22}" y="12" class="legend">${escapeXml(series.name || `Series ${i + 1}`)}</text>
      `).join("")}</g>`
    : "";

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <style>
    text { font-family: Arial, sans-serif; }
    .title { font-size: 30px; font-weight: 700; fill: #0f172a; }
    .subtitle { font-size: 14px; font-weight: 400; fill: #64748b; }
    .axis { font-size: 13px; font-weight: 400; fill: #64748b; }
    .label { font-size: 14px; font-weight: 500; fill: #334155; }
    .value { font-size: 13px; font-weight: 700; fill: #0f172a; }
    .legend { font-size: 14px; font-weight: 600; fill: #334155; }
    .grid { stroke: #e2e8f0; stroke-width: 1; }
    .baseline { stroke: #94a3b8; stroke-width: 2; }
  </style>
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="44" y="45" class="title">${escapeXml(spec.title || "Chart")}</text>
  <text x="44" y="68" class="subtitle">Generated from Siclaw response data</text>
  ${legend}
  ${grids}
  <line x1="${margin.left}" x2="${width - margin.right}" y1="${zeroY.toFixed(1)}" y2="${zeroY.toFixed(1)}" class="baseline"/>
  ${bars}
</svg>`;
}

function parseMermaidFlowchart(source: string): MermaidGraph | null {
  const rawLines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("%%"));
  const headerIndex = rawLines.findIndex((line) => /^(flowchart|graph)\b/i.test(line));
  if (headerIndex < 0) return null;

  const header = rawLines[headerIndex];
  const directionMatch = header.match(/^(?:flowchart|graph)\s+([A-Z]{2})/i);
  const direction = normalizeMermaidDirection(directionMatch?.[1]);
  const nodes = new Map<string, MermaidNode>();
  const edges: MermaidEdge[] = [];

  for (const line of rawLines.slice(headerIndex + 1)) {
    if (shouldSkipMermaidLine(line)) continue;
    const edge = parseMermaidEdge(line);
    if (edge) {
      nodes.set(edge.from.id, edge.from);
      nodes.set(edge.to.id, edge.to);
      edges.push({ from: edge.from.id, to: edge.to.id, label: edge.label });
    } else {
      const node = parseMermaidNode(line);
      if (node) nodes.set(node.id, node);
    }
    if (nodes.size >= MAX_MERMAID_NODES || edges.length >= MAX_MERMAID_EDGES) break;
  }

  if (nodes.size === 0 || edges.length === 0) return null;
  return {
    direction,
    nodes: [...nodes.values()],
    edges,
  };
}

function normalizeMermaidDirection(direction?: string): "LR" | "TD" {
  const normalized = direction?.toUpperCase();
  return normalized === "LR" || normalized === "RL" ? "LR" : "TD";
}

function shouldSkipMermaidLine(line: string): boolean {
  return /^(subgraph|end\b|classDef\b|class\b|style\b|linkStyle\b|click\b)/i.test(line);
}

function parseMermaidEdge(line: string): { from: MermaidNode; to: MermaidNode; label?: string } | null {
  const clean = line.replace(/;$/, "").trim();
  const patterns: RegExp[] = [
    /^(.+?)\s*-->\s*\|([^|]+)\|\s*(.+)$/,
    /^(.+?)\s*--\s*([^>-|]+?)\s*-->\s*(.+)$/,
    /^(.+?)\s*(?:-->|---|==>|-.->)\s*(.+)$/,
  ];

  for (const pattern of patterns) {
    const match = clean.match(pattern);
    if (!match) continue;
    const from = parseMermaidNode(match[1]);
    const to = parseMermaidNode(match[3] ?? match[2]);
    if (!from || !to) return null;
    const label = match.length >= 4 ? normalizeLabel(match[2]) : undefined;
    return { from, to, label };
  }
  return null;
}

function parseMermaidNode(token: string): MermaidNode | null {
  const clean = token.replace(/;$/, "").trim();
  const match = clean.match(/^([A-Za-z0-9_:.~-]+)(.*)$/);
  if (!match) return null;

  const id = match[1];
  const rest = match[2].trim();
  if (!rest) return { id, label: id, shape: "rect" };

  const shapeText = extractMermaidShape(rest);
  if (!shapeText) return { id, label: id, shape: "rect" };
  return {
    id,
    label: normalizeMermaidLabel(shapeText.label),
    shape: shapeText.shape,
  };
}

function extractMermaidShape(rest: string): { label: string; shape: MermaidNode["shape"] } | null {
  if (rest.startsWith("{") && rest.endsWith("}")) return { label: rest.slice(1, -1), shape: "diamond" };
  if (rest.startsWith("((") && rest.endsWith("))")) return { label: rest.slice(2, -2), shape: "oval" };
  if (rest.startsWith("(") && rest.endsWith(")")) return { label: rest.slice(1, -1), shape: "oval" };
  if (rest.startsWith("[") && rest.endsWith("]")) return { label: rest.slice(1, -1), shape: "rect" };
  return null;
}

function normalizeMermaidLabel(label: string): string {
  const trimmed = label.trim().replace(/^["']|["']$/g, "");
  return normalizeLabel(trimmed || "Node");
}

function renderMermaidSvg(graph: MermaidGraph): string {
  const nodeW = 176;
  const nodeH = 58;
  const padding = 56;
  const colGap = graph.direction === "LR" ? 240 : 218;
  const rowGap = graph.direction === "LR" ? 94 : 118;
  const levels = computeMermaidLevels(graph);
  const grouped = groupNodesByLevel(graph.nodes, levels);
  const levelEntries = [...grouped.entries()].sort(([a], [b]) => a - b);
  const levelCount = Math.max(1, levelEntries.length);
  const maxRows = Math.max(1, ...levelEntries.map(([, nodes]) => nodes.length));
  const width = graph.direction === "LR"
    ? Math.max(700, padding * 2 + nodeW + (levelCount - 1) * colGap)
    : Math.max(700, padding * 2 + nodeW * maxRows + rowGap * (maxRows - 1));
  const height = graph.direction === "LR"
    ? Math.max(420, padding * 2 + nodeH * maxRows + rowGap * (maxRows - 1))
    : Math.max(420, padding * 2 + nodeH + (levelCount - 1) * rowGap);

  const positions = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const [level, nodes] of levelEntries) {
    nodes.forEach((node, index) => {
      const x = graph.direction === "LR"
        ? padding + level * colGap
        : (width - (nodes.length * nodeW + (nodes.length - 1) * 38)) / 2 + index * (nodeW + 38);
      const y = graph.direction === "LR"
        ? (height - (nodes.length * nodeH + (nodes.length - 1) * rowGap)) / 2 + index * (nodeH + rowGap)
        : padding + level * rowGap;
      positions.set(node.id, { x, y, w: nodeW, h: nodeH });
    });
  }

  const edges = graph.edges.map((edge) => renderMermaidEdge(edge, positions, graph.direction)).join("");
  const nodes = graph.nodes.map((node) => renderMermaidNode(node, positions.get(node.id))).join("");

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <style>
    text { font-family: Arial, sans-serif; }
    .node { fill: #f8fafc; stroke: #2563eb; stroke-width: 2; }
    .decision { fill: #fef9c3; stroke: #ca8a04; stroke-width: 2; }
    .edge { fill: none; stroke: #64748b; stroke-width: 2.2; }
    .nodeText { font-size: 14px; font-weight: 700; fill: #0f172a; }
    .edgeText { font-size: 12px; font-weight: 600; fill: #475569; }
  </style>
  <defs>
    <marker id="arrow" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="strokeWidth">
      <path d="M2,2 L10,6 L2,10 z" fill="#64748b"/>
    </marker>
  </defs>
  <rect width="100%" height="100%" fill="#ffffff"/>
  ${edges}
  ${nodes}
</svg>`;
}

function computeMermaidLevels(graph: MermaidGraph): Map<string, number> {
  const levels = new Map(graph.nodes.map((node): [string, number] => [node.id, 0]));
  for (let pass = 0; pass < graph.nodes.length; pass++) {
    let changed = false;
    for (const edge of graph.edges) {
      const fromLevel = levels.get(edge.from) ?? 0;
      const toLevel = levels.get(edge.to) ?? 0;
      if (toLevel <= fromLevel) {
        levels.set(edge.to, fromLevel + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return levels;
}

function groupNodesByLevel(nodes: MermaidNode[], levels: Map<string, number>): Map<number, MermaidNode[]> {
  const grouped = new Map<number, MermaidNode[]>();
  for (const node of nodes) {
    const level = levels.get(node.id) ?? 0;
    grouped.set(level, [...(grouped.get(level) ?? []), node]);
  }
  return grouped;
}

function renderMermaidEdge(
  edge: MermaidEdge,
  positions: Map<string, { x: number; y: number; w: number; h: number }>,
  direction: "LR" | "TD",
): string {
  const from = positions.get(edge.from);
  const to = positions.get(edge.to);
  if (!from || !to) return "";

  const start = direction === "LR"
    ? { x: from.x + from.w, y: from.y + from.h / 2 }
    : { x: from.x + from.w / 2, y: from.y + from.h };
  const end = direction === "LR"
    ? { x: to.x, y: to.y + to.h / 2 }
    : { x: to.x + to.w / 2, y: to.y };
  const mid = direction === "LR"
    ? { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
    : { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const path = direction === "LR"
    ? `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} C ${mid.x.toFixed(1)} ${start.y.toFixed(1)}, ${mid.x.toFixed(1)} ${end.y.toFixed(1)}, ${end.x.toFixed(1)} ${end.y.toFixed(1)}`
    : `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} C ${start.x.toFixed(1)} ${mid.y.toFixed(1)}, ${end.x.toFixed(1)} ${mid.y.toFixed(1)}, ${end.x.toFixed(1)} ${end.y.toFixed(1)}`;
  const label = edge.label
    ? `<text x="${mid.x.toFixed(1)}" y="${(mid.y - 8).toFixed(1)}" text-anchor="middle" class="edgeText">${escapeXml(edge.label)}</text>`
    : "";
  return `<path d="${path}" class="edge" marker-end="url(#arrow)"/>${label}`;
}

function renderMermaidNode(node: MermaidNode, position?: { x: number; y: number; w: number; h: number }): string {
  if (!position) return "";
  const { x, y, w, h } = position;
  const centerX = x + w / 2;
  const centerY = y + h / 2;
  const label = renderCenteredText(node.label, centerX, centerY);
  if (node.shape === "diamond") {
    const points = `${centerX},${y} ${x + w},${centerY} ${centerX},${y + h} ${x},${centerY}`;
    return `<polygon points="${points}" class="decision"/>${label}`;
  }
  const rx = node.shape === "oval" ? h / 2 : 12;
  return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w}" height="${h}" rx="${rx}" class="node"/>${label}`;
}

function renderCenteredText(label: string, x: number, y: number): string {
  const words = label.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > 18 && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  const visibleLines = lines.slice(0, 2);
  if (lines.length > 2) visibleLines[1] = `${visibleLines[1].slice(0, 15)}...`;
  const startY = y - ((visibleLines.length - 1) * 17) / 2 + 5;
  return visibleLines
    .map((line, i) => `<text x="${x.toFixed(1)}" y="${(startY + i * 17).toFixed(1)}" text-anchor="middle" class="nodeText">${escapeXml(line)}</text>`)
    .join("");
}

function valueToY(value: number, min: number, range: number, top: number, height: number): number {
  return top + height - ((value - min) / range) * height;
}

function formatValue(value: number): string {
  if (Math.abs(value) >= 1000) return Math.round(value).toLocaleString("en-US");
  if (Math.abs(value) >= 10) return Number(value.toFixed(1)).toString();
  return Number(value.toFixed(2)).toString();
}

function chartColor(index: number): string {
  return ["#2563eb", "#16a34a", "#f59e0b", "#dc2626"][index % 4];
}

function renderSvgPng(svg: string): Buffer {
  return new Resvg(svg, {
    background: "#ffffff",
    fitTo: { mode: "original" },
    font: {
      loadSystemFonts: true,
      sansSerifFamily: "Arial",
    },
  }).render().asPng();
}

function withinFeishuLimit(image: Buffer): boolean {
  return image.length > 0 && image.length <= FEISHU_IMAGE_LIMIT_BYTES;
}

function cleanupMarkdown(markdown: string): string {
  return markdown.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
