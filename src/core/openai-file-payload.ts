import type { PromptFile } from "./brain-session.js";

const PDF_DATA_URL_PREFIX = "data:application/pdf;base64,";
const DEFAULT_PDF_FILENAME = "attachment.pdf";
const MAX_REMEMBERED_FILES = 256;
const rememberedPdfFilenames = new Map<string, string>();

export function pdfDataUrl(file: Pick<PromptFile, "mimeType" | "data">): string | undefined {
  if (file.mimeType.toLowerCase() !== "application/pdf" || !file.data) return undefined;
  return `${PDF_DATA_URL_PREFIX}${file.data}`;
}

export function rememberPromptFiles(files?: PromptFile[]): void {
  if (!files || files.length === 0) return;
  for (const file of files) {
    const url = pdfDataUrl(file);
    if (!url) continue;
    rememberedPdfFilenames.set(url, sanitizePdfFilename(file.filename));
    while (rememberedPdfFilenames.size > MAX_REMEMBERED_FILES) {
      const oldest = rememberedPdfFilenames.keys().next().value;
      if (!oldest) break;
      rememberedPdfFilenames.delete(oldest);
    }
  }
}

export function convertOpenAIPdfPayload(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  let changed = false;
  const clone = { ...payload };

  if (Array.isArray(clone.input)) {
    const { value, didChange } = convertResponsesInput(clone.input);
    if (didChange) {
      clone.input = value;
      changed = true;
    }
  }

  if (Array.isArray(clone.messages)) {
    const { value, didChange } = convertChatMessages(clone.messages);
    if (didChange) {
      clone.messages = value;
      changed = true;
    }
  }

  return changed ? clone : payload;
}

function convertResponsesInput(input: unknown[]): { value: unknown[]; didChange: boolean } {
  let didChange = false;
  const value = input.map((message) => {
    if (!isRecord(message) || !Array.isArray(message.content)) return message;
    const { value: content, didChange: contentChanged } = convertResponsesContent(message.content);
    if (!contentChanged) return message;
    didChange = true;
    return { ...message, content };
  });
  return { value, didChange };
}

function convertResponsesContent(content: unknown[]): { value: unknown[]; didChange: boolean } {
  let didChange = false;
  const value = content.map((part) => {
    if (!isRecord(part) || part.type !== "input_image") return part;
    const imageUrl = typeof part.image_url === "string" ? part.image_url : undefined;
    if (!isPdfDataUrl(imageUrl)) return part;
    didChange = true;
    return {
      type: "input_file",
      filename: filenameForPdfDataUrl(imageUrl),
      file_data: imageUrl,
    };
  });
  return { value, didChange };
}

function convertChatMessages(messages: unknown[]): { value: unknown[]; didChange: boolean } {
  let didChange = false;
  const value = messages.map((message) => {
    if (!isRecord(message) || !Array.isArray(message.content)) return message;
    const { value: content, didChange: contentChanged } = convertChatContent(message.content);
    if (!contentChanged) return message;
    didChange = true;
    return { ...message, content };
  });
  return { value, didChange };
}

function convertChatContent(content: unknown[]): { value: unknown[]; didChange: boolean } {
  let didChange = false;
  const value = content.map((part) => {
    if (!isRecord(part) || part.type !== "image_url" || !isRecord(part.image_url)) return part;
    const imageUrl = typeof part.image_url.url === "string" ? part.image_url.url : undefined;
    if (!isPdfDataUrl(imageUrl)) return part;
    didChange = true;
    return {
      type: "file",
      file: {
        filename: filenameForPdfDataUrl(imageUrl),
        file_data: imageUrl,
      },
    };
  });
  return { value, didChange };
}

function filenameForPdfDataUrl(dataUrl: string): string {
  return rememberedPdfFilenames.get(dataUrl) ?? DEFAULT_PDF_FILENAME;
}

function isPdfDataUrl(value: unknown): value is string {
  return typeof value === "string" && value.toLowerCase().startsWith(PDF_DATA_URL_PREFIX);
}

function sanitizePdfFilename(value: string): string {
  const basename = value.split(/[\\/]/).filter(Boolean).pop()?.trim() || DEFAULT_PDF_FILENAME;
  const cleaned = basename.replace(/[\r\n\t]/g, "_");
  if (!cleaned.toLowerCase().endsWith(".pdf")) return `${cleaned}.pdf`;
  return cleaned;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}
