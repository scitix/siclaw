import { describe, expect, it } from "vitest";
import { extractReplyImages, stripVisualBlocks } from "./visual-image.js";

const onePixelPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

describe("extractReplyImages", () => {
  it("forwards final-answer PNG data URI images as image attachments", async () => {
    const images = await extractReplyImages(`Chart:\n\n![chart](${onePixelPng})`);

    expect(images).toHaveLength(1);
    expect(images[0].kind).toBe("image");
    expect([...images[0].image.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("does not render source-only chart or Mermaid blocks", async () => {
    const images = await extractReplyImages([
      "```chart",
      "{\"type\":\"bar\",\"data\":{\"categories\":[\"a\"],\"series\":[{\"name\":\"s\",\"values\":[1]}]}}",
      "```",
      "",
      "```mermaid",
      "flowchart TD",
      "A --> B",
      "```",
    ].join("\n"));

    expect(images).toEqual([]);
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
