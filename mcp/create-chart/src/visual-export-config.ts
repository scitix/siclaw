import { VisualToolConfigurationError } from "./tool-error.js";

export const DEFAULT_VISUAL_EXPORT_TIMEOUT_MS = 30_000;

export function resolveVisualExportUrl(override?: string): string {
  const configured = (override ?? process.env.SICLAW_VISUAL_EXPORT_URL)?.trim();
  if (!configured) {
    throw new VisualToolConfigurationError(
      "Visual export is not configured; set SICLAW_VISUAL_EXPORT_URL to a reachable /siclaw-visual-export page",
    );
  }
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new VisualToolConfigurationError(
      "Visual export URL must be an absolute HTTP(S) URL",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new VisualToolConfigurationError(
      "Visual export URL must use the http or https scheme",
    );
  }
  if (configured.includes("#")) {
    throw new VisualToolConfigurationError(
      "Visual export URL must not contain a fragment (#); configure the page URL before the hash payload",
    );
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname}${url.search}`;
}

export function resolveVisualExportTimeoutMs(override?: number): number {
  const raw = override ?? Number(
    process.env.SICLAW_VISUAL_EXPORT_TIMEOUT_MS ?? DEFAULT_VISUAL_EXPORT_TIMEOUT_MS,
  );
  if (!Number.isFinite(raw) || raw <= 0) {
    throw new VisualToolConfigurationError(
      "Visual export timeout must be a positive number of milliseconds",
    );
  }
  return Math.ceil(raw);
}

export function visualExportConfigurationWarning(): string | null {
  try {
    resolveVisualExportUrl();
    resolveVisualExportTimeoutMs();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
