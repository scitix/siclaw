import { afterEach, describe, expect, it } from "vitest";
import {
  resolveVisualExportTimeoutMs,
  resolveVisualExportUrl,
  visualExportConfigurationWarning,
} from "./visual-export-config.js";

const originalUrl = process.env.SICLAW_VISUAL_EXPORT_URL;
const originalTimeout = process.env.SICLAW_VISUAL_EXPORT_TIMEOUT_MS;

afterEach(() => {
  if (originalUrl === undefined) delete process.env.SICLAW_VISUAL_EXPORT_URL;
  else process.env.SICLAW_VISUAL_EXPORT_URL = originalUrl;
  if (originalTimeout === undefined) delete process.env.SICLAW_VISUAL_EXPORT_TIMEOUT_MS;
  else process.env.SICLAW_VISUAL_EXPORT_TIMEOUT_MS = originalTimeout;
});

describe("resolveVisualExportUrl", () => {
  it("requires an explicitly configured renderer instead of inventing service DNS", () => {
    delete process.env.SICLAW_VISUAL_EXPORT_URL;
    expect(() => resolveVisualExportUrl()).toThrow(/set SICLAW_VISUAL_EXPORT_URL/);
  });

  it("normalizes the configured endpoint", () => {
    expect(resolveVisualExportUrl(" https://console.example.com/export///?locale=zh-CN "))
      .toBe("https://console.example.com/export?locale=zh-CN");
  });

  it("rejects relative, non-HTTP, and fragment-bearing locations", () => {
    expect(() => resolveVisualExportUrl("console.example.com/export")).toThrow(/absolute HTTP\(S\)/);
    expect(() => resolveVisualExportUrl("file:///tmp/export.html")).toThrow(/http or https/);
    expect(() => resolveVisualExportUrl("https://console.example.com/#/export")).toThrow(/fragment/);
    expect(() => resolveVisualExportUrl("https://console.example.com/export#")).toThrow(/fragment/);
  });

  it("surfaces invalid startup configuration without aborting the MCP server", () => {
    delete process.env.SICLAW_VISUAL_EXPORT_URL;
    expect(visualExportConfigurationWarning()).toMatch(/set SICLAW_VISUAL_EXPORT_URL/);
    process.env.SICLAW_VISUAL_EXPORT_URL = "https://console.example.com/export";
    process.env.SICLAW_VISUAL_EXPORT_TIMEOUT_MS = "invalid";
    expect(visualExportConfigurationWarning()).toMatch(/positive number/);
    delete process.env.SICLAW_VISUAL_EXPORT_TIMEOUT_MS;
    expect(visualExportConfigurationWarning()).toBeNull();
  });

  it("validates and normalizes the renderer timeout", () => {
    process.env.SICLAW_VISUAL_EXPORT_TIMEOUT_MS = "";
    expect(resolveVisualExportTimeoutMs()).toBe(60_000);
    expect(resolveVisualExportTimeoutMs(12_345.2)).toBe(12_346);
    expect(() => resolveVisualExportTimeoutMs(0)).toThrow(/positive number/);
    expect(() => resolveVisualExportTimeoutMs(Number.NaN)).toThrow(/positive number/);
  });
});
