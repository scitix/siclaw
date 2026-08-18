/**
 * Sensitive data detection and sanitization for kubectl output.
 *
 * Prevents Secret data, ConfigMap credentials, and Pod env vars
 * from leaking into the AI model context.
 */

// ── Types ────────────────────────────────────────────────────────────

export type SensitiveResourceType = "secret" | "configmap" | "pod";

// ── Sensitive pattern constants ──────────────────────────────────────

/**
 * Key-name patterns. This is the layer that does most of the actual work: real
 * secrets almost always sit behind a telling key name, whereas the value
 * patterns below only fire on a few recognisable shapes.
 */
export const SENSITIVE_ENV_NAME_PATTERNS: RegExp[] = [
  /password/i,
  /secret/i,
  /token/i,
  /credential/i,
  /api[_-]?key/i,
  /private[_-]?key/i,
  /[-_]key$/i,           // SSH_KEY, ENCRYPTION_KEY (not KEY_COUNT)
  // Anchored at the end so an HTTP header (Authorization, HTTP_AUTHORIZATION)
  // matches while kube-apiserver's diagnostic flags (authorization-mode,
  // authorization-webhook-config-file) stay readable.
  /(^|[_-])authorization$/i,
];

/** ConfigMap key name patterns */
export const SENSITIVE_KEY_PATTERNS: RegExp[] = [
  /password/i,
  /secret/i,
  /token/i,
  /credential/i,
  /private/i,
  /(^|[_-])authorization$/i,
];

/**
 * Value patterns — match regardless of key name.
 *
 * The `^`-anchored ones only fire when the token is the entire value (an env var,
 * a Secret entry). They deliberately do NOT catch `credentials: eyJ…` inside a
 * config file, because the indent and the `key: ` prefix push the token off the
 * line start — that case is covered by redacting such values line by line, where
 * the inner key name is what matches. Adding the `m` flag does not change this.
 */
export const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  /:\/\/[^:]+:[^@]+@/,            // connection string: ://user:pass@host
  /^eyJ[A-Za-z0-9_-]{10,}/,       // JWT token (bare value)
  /-----BEGIN .* KEY-----/,        // PEM private key
  /^(sk-|ghp_|gho_|glpat-)/,      // known API token prefixes (bare value)
  // Positional backstop for the header form, independent of the key name: a
  // bearer credential is worth more than the log line it costs us.
  /\bBearer\s+[\w\-._~+/]{16,}/i,
];

/**
 * The one value pattern above whose secret spans MULTIPLE lines. Callers holding
 * a complete value must drop it whole rather than redact line by line, since only
 * the BEGIN line matches and the base64 body under it would survive.
 *
 * Not applicable to the streaming (line-safe) redactor, which never sees more
 * than one line at a time.
 */
const PEM_BLOCK_RE = /-----BEGIN .* KEY-----/;

const REDACTED = "**REDACTED**";

/**
 * Advisory footer for the line-level redactor. Only ever appended when something
 * was actually redacted — a claim of redaction on untouched output is worse than
 * no claim at all, because it invites the reader to treat the text as safe.
 *
 * Exported so streaming sanitization (background bash) can strip the per-batch
 * duplicates; the inline REDACTED markers carry the security property.
 */
export const REDACTION_NOTICE = "\n\n⚠️ Sensitive values have been redacted for security.";

// ── Line-level redaction ─────────────────────────────────────────────

/**
 * Redact sensitive content line by line.
 *
 * Lives here rather than in output-sanitizer.ts because the structural
 * (JSON) sanitizers need it too: a ConfigMap entry is typically a whole config
 * FILE, whose secrets are identified by the key names INSIDE it, which only a
 * per-line pass can see. output-sanitizer.ts re-exports the public wrapper.
 *
 * Returns whether anything changed so callers can decide about the footer.
 */
export function redactLines(text: string): { text: string; redacted: boolean } {
  let redacted = false;

  const result = text.split("\n").map((line) => {
    // Value patterns first (JWT, PEM, connection string, bearer header) — a value
    // that LOOKS like a credential is redacted whatever its key is called.
    for (const pattern of SENSITIVE_VALUE_PATTERNS) {
      if (pattern.test(line)) {
        redacted = true;
        // Keep the indent and key name when the line has that shape: the reader
        // still learns WHICH setting was redacted, and a flush-left REDACTED
        // would break the indentation of the surrounding YAML block.
        const shaped = line.match(/^(\s*[A-Za-z_][A-Za-z0-9_.-]*(?::\s+|=))/);
        return shaped ? `${shaped[1]}${REDACTED}` : REDACTED;
      }
    }

    // KEY=VALUE
    const eqMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)/);
    if (eqMatch) {
      const key = eqMatch[1];
      if (SENSITIVE_ENV_NAME_PATTERNS.some((p) => p.test(key))) {
        redacted = true;
        return `${key}=${REDACTED}`;
      }
    }

    // KEY: VALUE (YAML-like) — the indent is preserved so a redacted line does
    // not break the surrounding structure for the reader.
    const colonMatch = line.match(/^(\s*[A-Za-z_][A-Za-z0-9_.-]*):\s+(.*)/);
    if (colonMatch) {
      const key = colonMatch[1].trim();
      if (SENSITIVE_ENV_NAME_PATTERNS.some((p) => p.test(key))) {
        redacted = true;
        return `${colonMatch[1]}: ${REDACTED}`;
      }
    }

    return line;
  });

  return { text: result.join("\n"), redacted };
}

/**
 * Line-level redaction with the advisory footer. The sanitizer used for every
 * non-JSON kubectl format, for file-reading commands, and as the pipeline
 * fallback in restricted-bash.
 */
export function redactSensitiveContent(output: string): string {
  const { text, redacted } = redactLines(output);
  return redacted ? text + REDACTION_NOTICE : text;
}

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

  let redacted = false;
  for (const item of getItems(obj)) {
    // Not `redacted ||=` — that short-circuits and skips the remaining items.
    if (sanitizeObject(item, resourceType)) redacted = true;
  }

  const sanitized = JSON.stringify(obj, null, 2);
  return redacted ? sanitized + REDACTION_NOTICE : sanitized;
}

/** Get items array from a single object or a List response */
function getItems(obj: any): any[] {
  if (obj.items && Array.isArray(obj.items)) {
    return obj.items;
  }
  return [obj];
}

/** Sanitize a single Kubernetes object in place; returns whether anything was redacted. */
function sanitizeObject(obj: any, resourceType: SensitiveResourceType): boolean {
  switch (resourceType) {
    case "secret": {
      // Both calls must run — `||` would short-circuit and leave stringData raw.
      const data = redactAllValues(obj, "data");
      const stringData = redactAllValues(obj, "stringData");
      return data || stringData;
    }

    case "configmap": {
      const data = redactByPattern(obj, "data");
      const binaryData = redactByPattern(obj, "binaryData");
      return data || binaryData;
    }

    case "pod":
      return sanitizePodEnv(obj);
  }
}

/** Unconditionally replace all values in obj[field] with REDACTED */
function redactAllValues(obj: any, field: string): boolean {
  if (!obj[field] || typeof obj[field] !== "object") return false;
  let redacted = false;
  for (const key of Object.keys(obj[field])) {
    obj[field][key] = REDACTED;
    redacted = true;
  }
  return redacted;
}

/**
 * Redact ConfigMap entries.
 *
 * A sensitive data KEY drops the whole entry. Otherwise the value is redacted
 * line by line, because a ConfigMap entry is usually an entire config file
 * (`prometheus.yml` → hundreds of lines) whose secrets are named by the keys
 * INSIDE it. Testing the file as one blob — the previous behaviour — checks
 * neither those inner key names nor the `^`-anchored value patterns against
 * individual lines, so every secret in it survived.
 *
 * Per-line also beats dropping the whole entry: only the offending line becomes
 * REDACTED, so the rest of the config stays diagnosable.
 */
function redactByPattern(obj: any, field: string): boolean {
  if (!obj[field] || typeof obj[field] !== "object") return false;

  let redacted = false;
  for (const key of Object.keys(obj[field])) {
    const value = obj[field][key];
    if (typeof value !== "string") continue;

    if (SENSITIVE_KEY_PATTERNS.some((p) => p.test(key))) {
      obj[field][key] = REDACTED;
      redacted = true;
      continue;
    }

    // A PEM block is ONE secret spanning many lines, and only its BEGIN line
    // carries a marker — so redacting line by line would drop that line and leak
    // the base64 body beneath it. Such an entry is a key/cert file with no
    // diagnostic value to preserve, so the whole entry goes.
    if (PEM_BLOCK_RE.test(value)) {
      obj[field][key] = REDACTED;
      redacted = true;
      continue;
    }

    // Everything else is treated as a config file: the remaining value patterns
    // all match within a single line, so a per-line pass loses nothing.
    const lines = redactLines(value);
    if (lines.redacted) {
      obj[field][key] = lines.text;
      redacted = true;
    }
  }
  return redacted;
}

/** Redact Pod env vars matching sensitive name patterns */
function sanitizePodEnv(obj: any): boolean {
  const spec = obj.spec;
  if (!spec) return false;

  const containerArrays = [
    spec.containers,
    spec.initContainers,
    spec.ephemeralContainers,
  ];

  let redacted = false;
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
          redacted = true;
        }
      }
    }
  }
  return redacted;
}
