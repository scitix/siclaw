import { describe, expect, it } from "vitest";
import { collectImageAttachments, stripVisualBlocks, type RenderedReplyImage } from "./visual-image.js";

const onePixelBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const onePixelPng = `data:image/png;base64,${onePixelBase64}`;

describe("collectImageAttachments", () => {
  it("collects structured PNG image content blocks as attachments", () => {
    const images: RenderedReplyImage[] = [];
    collectImageAttachments([{ type: "image", data: onePixelBase64, mimeType: "image/png" }], images, new Set());

    expect(images).toHaveLength(1);
    expect(images[0].kind).toBe("image");
    expect(images[0].mimeType).toBe("image/png");
    expect([...images[0].image.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("does not collect images from source-only chart or Mermaid text blocks", () => {
    const images: RenderedReplyImage[] = [];
    collectImageAttachments([
      { type: "text", text: "```chart\n{\"type\":\"bar\"}\n```" },
      { type: "text", text: "```mermaid\nflowchart TD\nA --> B\n```" },
    ], images, new Set());

    expect(images).toEqual([]);
  });

  it("deduplicates repeated image artifacts", () => {
    const images: RenderedReplyImage[] = [];
    const seen = new Set<string>();
    collectImageAttachments([
      { type: "image", data: onePixelBase64, mimeType: "image/png" },
      { type: "image", data: onePixelBase64, mime_type: "image/png" },
    ], images, seen);

    expect(images).toHaveLength(1);
  });
});

describe("stripVisualBlocks", () => {
  it("removes only data images from display markdown by default", () => {
    const markdown = [
      "Summary",
      "",
      "```chart",
      "{\"type\":\"bar\"}",
      "```",
      "",
      `![chart](${onePixelPng})`,
      "",
      "Keep this.",
    ].join("\n");

    const display = stripVisualBlocks(markdown);

    expect(display).toContain("```chart");
    expect(display).not.toContain("data:image/png");
    expect(display).toContain("Keep this.");
  });

  it("removes paired visual source blocks when a real image artifact is present", () => {
    const markdown = [
      "Summary",
      "",
      "```chart",
      "{\"type\":\"bar\"}",
      "```",
      "",
      "```mermaid",
      "flowchart LR",
      "A --> B",
      "```",
      "",
      "```visual-card",
      "{\"type\":\"report\",\"title\":\"x\",\"conclusion\":\"y\"}",
      "```",
      "",
      "```siclaw-card",
      "{\"title\":\"x\"}",
      "```",
      "",
      `![chart](${onePixelPng})`,
      "",
      "Keep this.",
    ].join("\n");

    const display = stripVisualBlocks(markdown, { stripSourceBlocks: true });

    expect(display).toBe([
      "Summary",
      "",
      "Keep this.",
    ].join("\n"));
  });
});
