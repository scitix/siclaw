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

  it("uses the configured endpoint and removes trailing slashes", () => {
    process.env.SICLAW_VISUAL_EXPORT_URL = "  https://console.example.com/siclaw-visual-export///  ";
    expect(resolveVisualExportUrl()).toBe("https://console.example.com/siclaw-visual-export");
  });

  it("prefers a call-site override over the process environment", () => {
    process.env.SICLAW_VISUAL_EXPORT_URL = "https://env.example.com/export";
    expect(resolveVisualExportUrl("https://override.example.com/export/"))
      .toBe("https://override.example.com/export");
  });

  it("rejects a configured fragment before the renderer burns its navigation timeout", () => {
    expect(() => resolveVisualExportUrl("https://console.example.com/#/siclaw-visual-export"))
      .toThrow(/must not contain a fragment/);
    expect(() => resolveVisualExportUrl("https://console.example.com/siclaw-visual-export#"))
      .toThrow(/must not contain a fragment/);
  });

  it("returns a normalized parsed URL while preserving query parameters", () => {
    expect(resolveVisualExportUrl("https://console.example.com/export///?locale=zh-CN"))
      .toBe("https://console.example.com/export?locale=zh-CN");
  });

  it("rejects relative and non-HTTP renderer locations as configuration errors", () => {
    expect(() => resolveVisualExportUrl("console.example.com/export")).toThrow(/absolute HTTP\(S\)/);
    expect(() => resolveVisualExportUrl("file:///tmp/export.html")).toThrow(/http or https/);
  });

  it("provides a startup warning for every invalid renderer endpoint", () => {
    delete process.env.SICLAW_VISUAL_EXPORT_URL;
    expect(visualExportConfigurationWarning()).toMatch(/set SICLAW_VISUAL_EXPORT_URL/);
    process.env.SICLAW_VISUAL_EXPORT_URL = "https://console.example.com/#/export";
    expect(visualExportConfigurationWarning()).toMatch(/must not contain a fragment/);
    process.env.SICLAW_VISUAL_EXPORT_URL = "https://console.example.com/export";
    process.env.SICLAW_VISUAL_EXPORT_TIMEOUT_MS = "invalid";
    expect(visualExportConfigurationWarning()).toMatch(/positive number/);
    delete process.env.SICLAW_VISUAL_EXPORT_TIMEOUT_MS;
    expect(visualExportConfigurationWarning()).toBeNull();
  });

  it("validates and normalizes the end-to-end timeout budget", () => {
    expect(resolveVisualExportTimeoutMs(12_345.2)).toBe(12_346);
    expect(() => resolveVisualExportTimeoutMs(0)).toThrow(/positive number/);
    expect(() => resolveVisualExportTimeoutMs(Number.NaN)).toThrow(/positive number/);
  });
});
