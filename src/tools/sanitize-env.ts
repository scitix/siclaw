/**
 * Sanitize environment variables for child processes.
 *
 * Filters out sensitive env vars (API keys, tokens, secrets) before spawning
 * subprocess shells, preventing the model from using `printenv` to leak them.
 *
 * Strategy: block known-dangerous suffixes/names, pass through everything else
 * (PATH, HOME, LANG, etc.) to keep tools functional.
 */

/** Env var names that are always blocked (exact match, case-insensitive). */
const BLOCKED_EXACT = new Set([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_API_BASE",
  "AZURE_OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "SLACK_TOKEN",
  "SLACK_BOT_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITLAB_TOKEN",
  "NPM_TOKEN",
  "DOCKER_PASSWORD",
  "DATABASE_URL",
  "REDIS_URL",
]);

/** Suffixes that indicate a sensitive env var. */
const BLOCKED_SUFFIXES = [
  "_API_KEY",
  "_APIKEY",
  "_SECRET",
  "_SECRET_KEY",
  "_TOKEN",
  "_PASSWORD",
  "_PRIVATE_KEY",
  "_CREDENTIALS",
];

/** Prefixes to always allow even if they match a suffix pattern. */
const ALLOW_PREFIXES = [
  "SICLAW_",       // our own non-secret config vars
  "KUBECONFIG",    // handled separately
  "PATH",
  "HOME",
  "LANG",
  "LC_",
  "TERM",
  "SHELL",
  "USER",
  "LOGNAME",
  "HOSTNAME",
  "NODE_",
  "NPM_CONFIG_",
  "EDITOR",
  "TZ",
  "TMPDIR",
  "XDG_",
];

function isSensitive(name: string): boolean {
  const upper = name.toUpperCase();

  // Explicit allow-list takes precedence
  if (ALLOW_PREFIXES.some((p) => upper.startsWith(p))) return false;

  // Exact match blocklist
  if (BLOCKED_EXACT.has(upper)) return true;

  // Suffix match
  if (BLOCKED_SUFFIXES.some((s) => upper.endsWith(s))) return true;

  return false;
}

/**
 * Return a sanitized copy of the given env vars object.
 * Sensitive keys are removed entirely (not masked).
 */
export function sanitizeEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!isSensitive(key)) {
      result[key] = value;
    }
  }
  return result;
}
