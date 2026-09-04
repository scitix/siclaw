export const DEFAULT_VISUAL_EXPORT_TIMEOUT_MS = 60_000;

export function resolveVisualExportUrl(override?: string): string {
  const configured = (override ?? process.env.SICLAW_VISUAL_EXPORT_URL)?.trim();
  if (!configured) {
    throw new Error(
      "Visual export is not configured; set SICLAW_VISUAL_EXPORT_URL to a reachable /siclaw-visual-export page",
    );
  }

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("Visual export URL must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Visual export URL must use the http or https scheme");
  }
  if (configured.includes("#")) {
    throw new Error(
      "Visual export URL must not contain a fragment (#); configure the page URL before the hash payload",
    );
  }

  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname}${url.search}`;
}

export function resolveVisualExportTimeoutMs(override?: number): number {
  const configured = process.env.SICLAW_VISUAL_EXPORT_TIMEOUT_MS?.trim();
  const raw = override ?? (configured ? Number(configured) : DEFAULT_VISUAL_EXPORT_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) {
    throw new Error("Visual export timeout must be a positive number of milliseconds");
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
