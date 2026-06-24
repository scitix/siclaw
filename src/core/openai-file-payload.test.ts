import { describe, expect, it } from "vitest";
import { convertOpenAIPdfPayload, rememberPromptFiles } from "./openai-file-payload.js";

const pdfData = "aGVsbG8=";
const pdfUrl = `data:application/pdf;base64,${pdfData}`;

describe("openai-file-payload", () => {
  it("converts Responses PDF image placeholders into input_file blocks", () => {
    rememberPromptFiles([{ mimeType: "application/pdf", filename: "runbook.pdf", data: pdfData }]);

    const payload = {
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: "read this" },
          { type: "input_image", image_url: pdfUrl },
        ],
      }],
    };

    expect(convertOpenAIPdfPayload(payload)).toEqual({
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: "read this" },
          { type: "input_file", filename: "runbook.pdf", file_data: pdfUrl },
        ],
      }],
    });
  });

  it("converts Chat Completions PDF image placeholders into file blocks", () => {
    rememberPromptFiles([{ mimeType: "application/pdf", filename: "manual.pdf", data: pdfData }]);

    const payload = {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "read this" },
          { type: "image_url", image_url: { url: pdfUrl } },
        ],
      }],
    };

    expect(convertOpenAIPdfPayload(payload)).toEqual({
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "read this" },
          { type: "file", file: { filename: "manual.pdf", file_data: pdfUrl } },
        ],
      }],
    });
  });

  it("leaves normal image payloads unchanged", () => {
    const payload = {
      input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" }] }],
    };

    expect(convertOpenAIPdfPayload(payload)).toBe(payload);
  });
});
