/**
 * Sensitive data detection and sanitization for kubectl output.
 *
 * Prevents Secret data, ConfigMap credentials, and Pod env vars
 * from leaking into the AI model context.
 */

// ── Types ────────────────────────────────────────────────────────────

export type SensitiveResourceType = "secret" | "configmap" | "pod";

// ── Sensitive pattern constants ──────────────────────────────────────

/** Pod env name patterns — word-boundary matching to avoid false positives */
export const SENSITIVE_ENV_NAME_PATTERNS: RegExp[] = [
  /password/i,
  /secret/i,
  /token/i,
  /credential/i,
  /api[_-]?key/i,
  /private[_-]?key/i,
  /[-_]key$/i,           // SSH_KEY, ENCRYPTION_KEY (not KEY_COUNT)
];

/** ConfigMap key name patterns */
export const SENSITIVE_KEY_PATTERNS: RegExp[] = [
  /password/i,
  /secret/i,
  /token/i,
  /credential/i,
  /private/i,
];

/** ConfigMap value patterns — match regardless of key name */
export const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  /:\/\/[^:]+:[^@]+@/,            // connection string: ://user:pass@host
  /^eyJ[A-Za-z0-9_-]{10,}/,       // JWT token
  /-----BEGIN .* KEY-----/,        // PEM private key
  /^(sk-|ghp_|gho_|glpat-)/,      // known API token prefixes
];

const REDACTED = "**REDACTED**";

// ── Resource alias mapping ───────────────────────────────────────────

const RESOURCE_ALIAS_MAP: Record<string, SensitiveResourceType> = {
  secret: "secret",
  secrets: "secret",
  configmap: "configmap",
  configmaps: "configmap",
  cm: "configmap",
  pod: "pod",
  pods: "pod",
  po: "pod",
};

// Flags that consume the next argument as a value (not a resource type)
const FLAGS_WITH_VALUE = new Set([
  "-n", "--namespace",
  "-l", "--selector",
  "--field-selector",
  "-o", "--output",
  "--sort-by",
  "--template",
  "-c", "--container",
  "--kubeconfig",
  "--context",
  "--cluster",
  "--as",
  "--as-group",
  "--timeout",
]);

// ── Detection functions ──────────────────────────────────────────────

/**
 * Detect if kubectl args target a sensitive resource type.
 *
 * Handles: secret, secrets, secret/<name>, configmap, configmaps, cm,
 *          cm/<name>, pod, pods, po, po/<name>, comma-separated (pod,secret)
 * Skips flag values (-n, -l, --namespace, etc.)
 */
export function detectSensitiveResource(
  args: string[],
): SensitiveResourceType | null {
  let skipNext = false;

  for (const arg of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }

    // Flag with separate value: skip the next arg
    if (FLAGS_WITH_VALUE.has(arg)) {
      skipNext = true;
      continue;
    }

    // Flag with = value (--namespace=kube-system) or short flags (-A, --all-namespaces)
    if (arg.startsWith("-")) continue;

    // Check comma-separated resource types: pod,secret
    const parts = arg.split(",");
    for (const part of parts) {
      // Handle type/name form: secret/my-secret
      const resourceType = part.split("/")[0].toLowerCase();
      if (resourceType in RESOURCE_ALIAS_MAP) {
        return RESOURCE_ALIAS_MAP[resourceType];
      }
    }
  }

  return null;
}

/**
 * Parse -o / --output flag from kubectl args.
 *
 * Handles: -o json, -o=json, --output json, --output=json,
 *          -o jsonpath='{...}', -o=jsonpath='{...}'
 * Returns format name or null for default table output.
 */
export function getOutputFormat(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // --output=json or --output json
    if (arg === "--output" || arg === "-o") {
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        return extractFormatName(next);
      }
      continue;
    }
    if (arg.startsWith("--output=")) {
      return extractFormatName(arg.slice("--output=".length));
    }
    if (arg.startsWith("-o=")) {
      return extractFormatName(arg.slice("-o=".length));
    }
    // kubectl shorthand: -ojson, -oyaml (no space, no equals)
    if (arg.startsWith("-o") && arg.length > 2 && !arg.startsWith("--")) {
      return extractFormatName(arg.slice(2));
    }
  }

  return null;
}

/** Extract base format name: "jsonpath='{...}'" → "jsonpath" */
function extractFormatName(value: string): string {
  // Handle jsonpath=..., go-template=..., custom-columns=...
  const eqIndex = value.indexOf("=");
  if (eqIndex > 0) {
    return value.slice(0, eqIndex);
  }
  return value;
}

// ── Sanitization functions ───────────────────────────────────────────

/**
 * Sanitize kubectl JSON output by redacting sensitive fields.
 *
 * - Secret: unconditionally redact all .data and .stringData values
 * - ConfigMap: redact .data/.binaryData entries matching key/value patterns
 * - Pod: redact .spec.containers[].env[].value matching name patterns
 *
 * Handles both single objects and List responses (.items[]).
 * Returns sanitized JSON string with appended warning.
 */
export function sanitizeJSON(
  output: string,
  resourceType: SensitiveResourceType,
): string {
  let obj: any;
  try {
    obj = JSON.parse(output);
  } catch {
    // JSON parse failed — don't leak raw output, return error
    return JSON.stringify({
      error: "Failed to parse kubectl JSON output for sanitization. Raw output suppressed to prevent potential data leak.",
    }, null, 2);
  }

  const items = getItems(obj);
  for (const item of items) {
    sanitizeObject(item, resourceType);
  }

  const sanitized = JSON.stringify(obj, null, 2);
  return sanitized + "\n\n⚠️ Sensitive values have been redacted for security.";
}

/** Get items array from a single object or a List response */
function getItems(obj: any): any[] {
  if (obj.items && Array.isArray(obj.items)) {
    return obj.items;
  }
  return [obj];
}

/** Sanitize a single Kubernetes object in place */
function sanitizeObject(obj: any, resourceType: SensitiveResourceType): void {
  switch (resourceType) {
    case "secret":
      redactAllValues(obj, "data");
      redactAllValues(obj, "stringData");
      break;

    case "configmap":
      redactByPattern(obj, "data");
      redactByPattern(obj, "binaryData");
      break;

    case "pod":
      sanitizePodEnv(obj);
      break;
  }
}

/** Unconditionally replace all values in obj[field] with REDACTED */
function redactAllValues(obj: any, field: string): void {
  if (obj[field] && typeof obj[field] === "object") {
    for (const key of Object.keys(obj[field])) {
      obj[field][key] = REDACTED;
    }
  }
}

/** Redact ConfigMap entries matching sensitive key or value patterns */
function redactByPattern(obj: any, field: string): void {
  if (!obj[field] || typeof obj[field] !== "object") return;

  for (const key of Object.keys(obj[field])) {
    const value = obj[field][key];
    if (typeof value !== "string") continue;

    const keyMatches = SENSITIVE_KEY_PATTERNS.some((p) => p.test(key));
    const valueMatches = SENSITIVE_VALUE_PATTERNS.some((p) => p.test(value));

    if (keyMatches || valueMatches) {
      obj[field][key] = REDACTED;
    }
  }
}

/** Redact Pod env vars matching sensitive name patterns */
function sanitizePodEnv(obj: any): void {
  const spec = obj.spec;
  if (!spec) return;

  const containerArrays = [
    spec.containers,
    spec.initContainers,
    spec.ephemeralContainers,
  ];

  for (const containers of containerArrays) {
    if (!Array.isArray(containers)) continue;
    for (const container of containers) {
      if (!Array.isArray(container.env)) continue;
      for (const envVar of container.env) {
        // Only redact .value (hardcoded), not .valueFrom (reference)
        if (envVar.value === undefined) continue;
        const nameMatches = SENSITIVE_ENV_NAME_PATTERNS.some((p) =>
          p.test(envVar.name ?? ""),
        );
        if (nameMatches) {
          envVar.value = REDACTED;
        }
      }
    }
  }
}
