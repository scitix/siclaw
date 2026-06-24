export interface RenderedReplyImage {
  kind: "image";
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  image: Buffer;
}

export interface StripVisualBlocksOptions {
  stripSourceBlocks?: boolean;
}

const DATA_IMAGE_URL_PATTERN =
  "data:image\\/(?:png|jpe?g|webp)(?:;charset=[^;,\\s)]+)?;base64,[^\\s)]+";
const MARKDOWN_DATA_IMAGE_RE = new RegExp(
  `!\\[[^\\]]*\\]\\(\\s*(${DATA_IMAGE_URL_PATTERN})\\s*(?:["'][^)]*["'])?\\)`,
  "gi",
);
const RAW_DATA_IMAGE_RE = new RegExp(`(^|\\s)(${DATA_IMAGE_URL_PATTERN})`, "gi");

export function collectImageAttachments(
  content: unknown,
  target: RenderedReplyImage[],
  seenImageKeys: Set<string>,
): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const image = imageAttachmentFromBlock(block as Record<string, unknown>);
    if (!image) continue;
    const key = `${image.mimeType}:${image.image.toString("base64")}`;
    if (seenImageKeys.has(key)) continue;
    seenImageKeys.add(key);
    target.push(image);
  }
}

export function stripVisualBlocks(markdown: string, options: StripVisualBlocksOptions = {}): string {
  let output = stripDataImages(markdown);
  if (options.stripSourceBlocks) {
    output = stripFences(output, "chart");
    output = stripFences(output, "mermaid");
    output = stripFences(output, "visual-card");
    output = stripFences(output, "siclaw-card");
    output = stripFences(output, "conclusion-card");
  }
  return cleanupMarkdown(output);
}

function imageAttachmentFromBlock(block: Record<string, unknown>): RenderedReplyImage | null {
  const type = typeof block.type === "string" ? block.type : "";
  if (type === "image") {
    const direct = imageFromBase64(block.data, block.mimeType ?? block.mime_type);
    if (direct) return direct;

    const source = block.source;
    if (source && typeof source === "object") {
      const raw = source as Record<string, unknown>;
      if (raw.type === "base64") {
        return imageFromBase64(raw.data, raw.media_type ?? raw.mimeType ?? raw.mime_type);
      }
    }
  }

  if (type === "image_url" || type === "input_image" || type === "output_image") {
    const imageUrl = block.image_url;
    const url = typeof imageUrl === "string"
      ? imageUrl
      : imageUrl && typeof imageUrl === "object"
        ? (imageUrl as Record<string, unknown>).url
        : block.url;
    if (typeof url === "string") return imageFromDataUrl(url);
  }

  return null;
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

function isSupportedDataImageUrl(dataUrl: string): boolean {
  return /^data:image\/(?:png|jpe?g|webp)(?:;charset=[^;,]+)?;base64,/i.test(dataUrl);
}

function imageFromDataUrl(dataUrl: string): RenderedReplyImage | null {
  const match = dataUrl.match(/^data:(image\/(?:png|jpe?g|webp))(?:;charset=[^;,]+)?;base64,([\s\S]*)$/i);
  if (!match) return null;
  return imageFromBase64(match[2], match[1]);
}

function imageFromBase64(data: unknown, mimeType: unknown): RenderedReplyImage | null {
  if (typeof data !== "string" || typeof mimeType !== "string") return null;
  const normalizedMime = normalizeMimeType(mimeType);
  if (!normalizedMime) return null;
  const image = Buffer.from(data.replace(/\s+/g, ""), "base64");
  return image.length > 0 ? { kind: "image", mimeType: normalizedMime, image } : null;
}

function normalizeMimeType(mimeType: string): RenderedReplyImage["mimeType"] | null {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/png" || normalized === "image/webp") return normalized;
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "image/jpeg";
  return null;
}

function stripFences(markdown: string, language: string): string {
  return markdown.replace(fenceRegex(language), (full, prefix: string) => prefix || "");
}

function fenceRegex(language: string): RegExp {
  return new RegExp(`(^|\\r?\\n)[ \\t]*\`\`\`${language}[ \\t]*\\r?\\n[\\s\\S]*?\`\`\`[ \\t]*(?=\\r?\\n|$)`, "gi");
}

function cleanupMarkdown(markdown: string): string {
  return markdown
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
