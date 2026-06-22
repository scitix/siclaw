import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright-core";

export interface SicoreExportedVisual {
  kind: "chart" | "mermaid" | "visual-card";
  image: Buffer;
}

interface SicoreExportOptions {
  baseUrl?: string;
  theme?: "light" | "dark";
  timeoutMs?: number;
}

const DEFAULT_EXPORT_URL = "http://sicore-web:3000/siclaw-visual-export";

export async function exportMarkdownVisualsWithSicoreWeb(
  markdown: string,
  options: SicoreExportOptions = {},
): Promise<SicoreExportedVisual[]> {
  const baseUrl =
    options.baseUrl ??
    process.env.SICORE_VISUAL_EXPORT_URL ??
    DEFAULT_EXPORT_URL;
  const timeoutMs = options.timeoutMs ?? Number(process.env.SICORE_VISUAL_EXPORT_TIMEOUT_MS ?? 30_000);
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({
      viewport: { width: 1120, height: 900 },
      deviceScaleFactor: 1,
    });
    const payload = base64UrlEncode(JSON.stringify({
      markdown,
      theme: options.theme ?? process.env.SICORE_VISUAL_EXPORT_THEME ?? "light",
    }));
    await page.goto(`${baseUrl}#${payload}`, {
      waitUntil: "networkidle",
      timeout: timeoutMs,
    });
    await page.waitForFunction(
      () => {
        const w = globalThis as typeof globalThis & {
          __siclawVisualExportReady?: boolean;
          __siclawExportVisuals?: unknown;
        };
        return Boolean(w.__siclawVisualExportReady && w.__siclawExportVisuals);
      },
      undefined,
      { timeout: timeoutMs },
    );
    const exported = await page.evaluate(async () => {
      const w = globalThis as typeof globalThis & {
        __siclawExportVisuals?: () => Promise<unknown>;
      };
      return await w.__siclawExportVisuals?.();
    });
    if (!Array.isArray(exported) || exported.length === 0) {
      throw new Error("Sicore visual export returned no images");
    }
    return exported.map((item, i) => {
      if (!item || typeof item !== "object") {
        throw new Error(`Sicore visual export item[${i}] is invalid`);
      }
      const rec = item as { kind?: unknown; dataUrl?: unknown };
      if (rec.kind !== "chart" && rec.kind !== "mermaid" && rec.kind !== "visual-card") {
        throw new Error(`Sicore visual export item[${i}] has invalid kind`);
      }
      if (typeof rec.dataUrl !== "string") {
        throw new Error(`Sicore visual export item[${i}] has no dataUrl`);
      }
      const image = pngFromDataUrl(rec.dataUrl);
      return { kind: rec.kind, image };
    });
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function launchBrowser(): Promise<Browser> {
  const executablePath =
    process.env.SICORE_VISUAL_EXPORT_CHROMIUM ??
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
    "/usr/bin/chromium";
  const runtimeDir = path.join(os.tmpdir(), "siclaw-chromium");
  const homeDir = path.join(runtimeDir, "home");
  const configDir = path.join(runtimeDir, "config");
  const cacheDir = path.join(runtimeDir, "cache");
  const crashDir = path.join(runtimeDir, "crash");
  await Promise.all([
    mkdir(homeDir, { recursive: true }),
    mkdir(configDir, { recursive: true }),
    mkdir(cacheDir, { recursive: true }),
    mkdir(crashDir, { recursive: true }),
  ]);
  return await chromium.launch({
    executablePath,
    headless: true,
    env: {
      ...process.env,
      HOME: homeDir,
      XDG_CONFIG_HOME: configDir,
      XDG_CACHE_HOME: cacheDir,
    },
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      `--crash-dumps-dir=${crashDir}`,
      "--font-render-hinting=none",
    ],
  });
}

function pngFromDataUrl(dataUrl: string): Buffer {
  const match = dataUrl.match(/^data:image\/png;base64,([\s\S]+)$/i);
  if (!match) throw new Error("Sicore visual export returned a non-PNG data URL");
  const image = Buffer.from(match[1].replace(/\s+/g, ""), "base64");
  if (image.length === 0) throw new Error("Sicore visual export returned an empty PNG");
  return image;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
