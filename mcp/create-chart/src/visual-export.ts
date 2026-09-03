import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright-core";
import { resolveVisualExportTimeoutMs, resolveVisualExportUrl } from "./visual-export-config.js";

export interface ExportedVisual {
  kind: "chart" | "mermaid" | "visual-card";
  image: Buffer;
}

interface VisualExportOptions {
  baseUrl?: string;
  theme?: "light" | "dark";
  timeoutMs?: number;
}

export async function exportMarkdownVisualsWithVisualExportWeb(
  markdown: string,
  options: VisualExportOptions = {},
): Promise<ExportedVisual[]> {
  const baseUrl = resolveVisualExportUrl(options.baseUrl);
  const timeoutMs = resolveVisualExportTimeoutMs(options.timeoutMs);
  const deadline = Date.now() + timeoutMs;
  const browser = await launchBrowser(remainingTimeout(deadline, timeoutMs));
  try {
    const page = await withDeadline(
      () => browser.newPage({
        viewport: { width: 1120, height: 900 },
        deviceScaleFactor: 1,
      }),
      deadline,
      timeoutMs,
    );
    const payload = base64UrlEncode(JSON.stringify({
      markdown,
      theme: options.theme ?? process.env.SICLAW_VISUAL_EXPORT_THEME ?? "light",
    }));
    await page.goto(`${baseUrl}#${payload}`, {
      waitUntil: "networkidle",
      timeout: remainingTimeout(deadline, timeoutMs),
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
      { timeout: remainingTimeout(deadline, timeoutMs) },
    );
    const exported = await withDeadline(
      () => page.evaluate(async () => {
        const w = globalThis as typeof globalThis & {
          __siclawExportVisuals?: () => Promise<unknown>;
        };
        return await w.__siclawExportVisuals?.();
      }),
      deadline,
      timeoutMs,
    );
    if (!Array.isArray(exported) || exported.length === 0) {
      throw new Error("ControlPlane visual export returned no images");
    }
    return exported.map((item, i) => {
      if (!item || typeof item !== "object") {
        throw new Error(`ControlPlane visual export item[${i}] is invalid`);
      }
      const rec = item as { kind?: unknown; dataUrl?: unknown };
      if (rec.kind !== "chart" && rec.kind !== "mermaid" && rec.kind !== "visual-card") {
        throw new Error(`ControlPlane visual export item[${i}] has invalid kind`);
      }
      if (typeof rec.dataUrl !== "string") {
        throw new Error(`ControlPlane visual export item[${i}] has no dataUrl`);
      }
      const image = pngFromDataUrl(rec.dataUrl);
      return { kind: rec.kind, image };
    });
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function launchBrowser(timeoutMs: number): Promise<Browser> {
  const executablePath =
    process.env.SICLAW_VISUAL_EXPORT_CHROMIUM ??
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
    timeout: timeoutMs,
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

function remainingTimeout(deadline: number, timeoutMs: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`Visual export timed out after ${timeoutMs}ms`);
  return remaining;
}

async function withDeadline<T>(start: () => Promise<T>, deadline: number, timeoutMs: number): Promise<T> {
  const remaining = remainingTimeout(deadline, timeoutMs);
  const operation = start();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Visual export timed out after ${timeoutMs}ms`)),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function pngFromDataUrl(dataUrl: string): Buffer {
  const match = dataUrl.match(/^data:image\/png;base64,([\s\S]+)$/i);
  if (!match) throw new Error("ControlPlane visual export returned a non-PNG data URL");
  const image = Buffer.from(match[1].replace(/\s+/g, ""), "base64");
  if (image.length === 0) throw new Error("ControlPlane visual export returned an empty PNG");
  return image;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
