export interface RenderedReplyImage {
  kind: "image";
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

export async function extractReplyImages(markdown: string): Promise<RenderedReplyImage[]> {
  const images: RenderedReplyImage[] = [];
  for (const dataUrl of extractDataImageUrls(markdown)) {
    const image = imageFromDataUrl(dataUrl);
    if (image) images.push({ kind: "image", image });
  }
  return images;
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

function imageFromDataUrl(dataUrl: string): Buffer | null {
  const match = dataUrl.match(/^data:image\/(?:png|jpe?g|webp)(?:;charset=[^;,]+)?;base64,([\s\S]*)$/i);
  if (!match) return null;
  const image = Buffer.from(match[1].replace(/\s+/g, ""), "base64");
  return image.length > 0 ? image : null;
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
