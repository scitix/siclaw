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
  // SSH_KEY, ENCRYPTION_KEY, tls.key (not KEY_COUNT). The `.` form is how
  // Kubernetes names key material in Secret/ConfigMap data.
  /[-_.]key$/i,
  // Anchored at the end so an HTTP header (Authorization, HTTP_AUTHORIZATION)
  // matches while kube-apiserver's diagnostic flags (authorization-mode,
  // authorization-webhook-config-file) stay readable.
  /(^|[_-])authorization$/i,
  /(^|[_-])jwt([_-]|$)/i,          // jwt, JWT_SECRET, id_jwt
  /key[_-]?data$/i,                // client-key-data (kubeconfig-shaped values)
  /dockercfg|dockerconfigjson/i,   // registry pull credentials
];

/**
 * ConfigMap data-key patterns — a data key matching these means the ENTIRE entry
 * is a secret (a `password` file), not a config file with a secret in it.
 *
 * Deliberately a superset relationship with the key-name patterns above: those
 * are also applied to keys INSIDE an entry, so anything recognised there is
 * recognised here too.
 */
export const SENSITIVE_KEY_PATTERNS: RegExp[] = [
  ...SENSITIVE_ENV_NAME_PATTERNS,
  /private/i,            // broader than private_key: private.pem, privateCert
];

/**
 * Value patterns — match regardless of key name.
 *
 * The `^`-anchored ones assume the token is the WHOLE value, so they are tested
 * against the value segment of a parsed line (see splitKeyValue), never against
 * the raw line: indentation and a `key: ` prefix would push the token off the
 * line start and silently defeat them.
 */
export const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  /:\/\/[^:]+:[^@]+@/,            // connection string: ://user:pass@host
  /^eyJ[A-Za-z0-9_-]{10,}/,       // JWT token
  /-----BEGIN [^-]*-----/,         // PEM header (block handled separately)
  /^(sk-|ghp_|gho_|glpat-)/,      // known API token prefixes
  // Positional backstop for the header form, independent of the key name: a
  // bearer credential is worth more than the log line it costs us.
  /\bBearer\s+[\w\-._~+/]{16,}/i,
];

const REDACTED = "**REDACTED**";

// ── Line shapes ──────────────────────────────────────────────────────

/**
 * One `key <sep> value` line, in any of the shapes a ConfigMap payload uses:
 * YAML (`key: v`, `  - key: v`), JSON (`"key": "v"`), properties/INI
 * (`key=v`, `key = v`), and the no-space `key:v` that YAML forbids but
 * .properties and .env files produce anyway.
 *
 * Group 1 indent + optional list marker, 2 quote, 3 key, 4 separator, 5 value.
 * The backreference makes the closing quote match the opening one.
 */
const KV_LINE_RE = /^(\s*(?:-\s+)?)(["']?)([A-Za-z_][\w.\-]*)\2(\s*[:=]\s*)(.*)$/;

/** A YAML block scalar header: `|`, `>`, `|-`, `>+`, `|2`, with optional comment. */
const BLOCK_SCALAR_RE = /^[|>][-+]?\d*\s*(?:#.*)?$/;

const PEM_BEGIN_RE = /-----BEGIN [^-]*-----/;
const PEM_END_RE = /-----END [^-]*-----/;

interface SplitLine {
  /** Indent, list marker, quoted key and separator — reusable verbatim. */
  prefix: string;
  /** Bare key name, quotes stripped. */
  key: string;
  /** Value segment, quotes stripped. */
  value: string;
  /** Leading whitespace width, for deciding what a block scalar owns. */
  indent: number;
}

function splitKeyValue(line: string): SplitLine | null {
  const m = KV_LINE_RE.exec(line);
  if (!m) return null;
  const [, lead, quote, key, sep, rawValue] = m;
  return {
    prefix: `${lead}${quote}${key}${quote}${sep}`,
    key,
    value: unquote(rawValue.trim()),
    indent: lead.length,
  };
}

/** Strip one layer of matching quotes, and a trailing JSON comma. */
function unquote(value: string): string {
  const noComma = value.replace(/,$/, "");
  const m = /^(["'])(.*)\1$/.exec(noComma);
  return m ? m[2] : noComma;
}

function isSensitiveKeyName(key: string): boolean {
  return SENSITIVE_ENV_NAME_PATTERNS.some((p) => p.test(key));
}

function looksLikeSensitiveValue(value: string): boolean {
  return SENSITIVE_VALUE_PATTERNS.some((p) => p.test(value));
}

/**
 * Redact one line in isolation. Returns null when the line is untouched.
 *
 * Both halves are judged separately: a telling key name (`password`) redacts
 * whatever it holds, and a value that looks like a credential (`eyJ…`) is
 * redacted whatever its key is called. The prefix is preserved so the reader
 * still learns WHICH setting went away and the surrounding indentation survives.
 *
 * Falls back to matching the raw line, because some patterns are positional and
 * a key/value split can straddle them: `postgresql://user:pass@host` splits into
 * key `postgresql` plus `//user:pass@host`, which the connection-string pattern
 * (anchored on `://`) no longer matches. When the split turns out not to fit the
 * line, the whole line goes rather than guessing where its value began.
 */
function redactOneLine(line: string): string | null {
  const split = splitKeyValue(line);
  if (split && (isSensitiveKeyName(split.key) || looksLikeSensitiveValue(split.value))) {
    return `${split.prefix}${REDACTED}`;
  }
  return looksLikeSensitiveValue(line.trim()) ? REDACTED : null;
}

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
 * Redact line by line, with NO state carried between lines.
 *
 * This is the line-safe primitive: the streaming sanitizer (background bash)
 * applies it to whatever complete lines a batch happens to contain, so it must
 * not depend on having seen an earlier line. That also caps what it can do — a
 * secret whose body sits on the lines BELOW its key is invisible here. Callers
 * holding a whole document must use redactDocument instead.
 */
export function redactLines(text: string): { text: string; redacted: boolean } {
  let redacted = false;
  const result = text.split("\n").map((line) => {
    const replaced = redactOneLine(line);
    if (replaced === null) return line;
    redacted = true;
    return replaced;
  });
  return { text: result.join("\n"), redacted };
}

/**
 * Redact a complete document, including secrets that span several lines.
 *
 * Two shapes need to look past the current line, and both were leaking their
 * body while the key line above them was dutifully redacted — the footer then
 * claimed the output was clean:
 *
 *   api_token: |            -----BEGIN RSA PRIVATE KEY-----
 *     ghp_AAAA…               MIIEvQIBADANBgkq…
 *
 * A block scalar owns every following line indented deeper than its key, so the
 * whole run collapses into one REDACTED. A PEM block runs to its END marker (or
 * to the end of the text, since a truncated key is still a key).
 */
export function redactDocument(text: string): { text: string; redacted: boolean } {
  const lines = text.split("\n");
  const out: string[] = [];
  let redacted = false;
  /** Indent of a sensitive key whose value is a nested mapping, while inside it. */
  let sensitiveMappingIndent: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Everything nested under a sensitive key is part of that secret, whatever
    // the inner field names are: `password:` followed by `inner: hunter2` says
    // nothing about `inner`, so judging that line on its own merits would leak it.
    // Field names are kept — they say WHAT was configured, not what its value is.
    if (sensitiveMappingIndent !== null) {
      if (!ownedByBlock(line, sensitiveMappingIndent)) {
        sensitiveMappingIndent = null;
      } else if (line.trim() === "") {
        out.push(line);
        continue;
      } else {
        const nested = splitKeyValue(line);
        // A nested mapping of its own has no value on this line to redact.
        if (nested && nested.value === "") {
          out.push(line);
          continue;
        }
        out.push(nested ? `${nested.prefix}${REDACTED}` : REDACTED);
        redacted = true;
        continue;
      }
    }

    // PEM: swallow through END. Checked before the key/value shapes because the
    // BEGIN marker can itself sit after a key (`tls.key: -----BEGIN …`).
    if (PEM_BEGIN_RE.test(line)) {
      const split = splitKeyValue(line);
      out.push(split ? `${split.prefix}${REDACTED}` : REDACTED);
      redacted = true;
      while (i < lines.length && !PEM_END_RE.test(lines[i])) i++;
      continue;
    }

    const split = splitKeyValue(line);
    if (split && (isSensitiveKeyName(split.key) || looksLikeSensitiveValue(split.value))) {
      // A block scalar (`key: |`) puts the value on the lines below, where no key
      // name marks it — the whole indented run collapses into this REDACTED.
      if (BLOCK_SCALAR_RE.test(split.value)) {
        out.push(`${split.prefix}${REDACTED}`);
        redacted = true;
        while (i + 1 < lines.length && ownedByBlock(lines[i + 1], split.indent)) i++;
        continue;
      }
      // An empty value opens a nested mapping: nothing on THIS line to redact,
      // and its children are pairs that match on their own keys.
      if (split.value === "") {
        out.push(line);
        sensitiveMappingIndent = split.indent;
        continue;
      }
      out.push(`${split.prefix}${REDACTED}`);
      redacted = true;
      continue;
    }

    const replaced = redactOneLine(line);
    if (replaced !== null) {
      out.push(replaced);
      redacted = true;
      continue;
    }

    out.push(line);
  }

  return { text: out.join("\n"), redacted };
}

/**
 * Whether a line belongs to a block scalar opened at `keyIndent`. Blank lines
 * inside a block are part of it; anything indented no deeper than the key ends it.
 */
function ownedByBlock(line: string, keyIndent: number): boolean {
  if (line.trim() === "") return true;
  const indent = line.length - line.trimStart().length;
  return indent > keyIndent;
}

/**
 * Whole-document redaction with the advisory footer. The sanitizer for every
 * non-JSON kubectl format, for file-reading commands, and the pipeline fallback
 * in restricted-bash.
 *
 * Uses redactDocument, so a PEM or block-scalar body is covered whenever the
 * whole text is in hand. Under streaming the caller passes one batch at a time,
 * where a block split across batches is inherently beyond reach — no worse than
 * before, and the per-line layer still applies.
 */
export function redactSensitiveContent(output: string): string {
  const { text, redacted } = redactDocument(output);
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
 * A ConfigMap entry is usually an entire config FILE — the data key is a
 * filename, the value is hundreds of lines — and its secrets are named by the
 * keys INSIDE it. So the value is redacted as a document (or as a JSON tree),
 * not tested as one blob: a blob test sees neither those inner key names nor the
 * value patterns on any individual line, and everything in the file survives it.
 *
 * Per-entry granularity is preferred where it is safe, so only the offending
 * line goes and the rest of the config stays diagnosable. Where it is NOT safe —
 * a sensitive-looking payload we cannot parse and therefore cannot rewrite with
 * confidence — the whole entry goes instead.
 */
function redactByPattern(obj: any, field: string): boolean {
  if (!obj[field] || typeof obj[field] !== "object") return false;

  let redacted = false;
  for (const key of Object.keys(obj[field])) {
    const value = obj[field][key];
    if (typeof value !== "string") continue;

    // The data key itself names a secret → the whole entry is the secret.
    if (SENSITIVE_KEY_PATTERNS.some((p) => p.test(key))) {
      obj[field][key] = REDACTED;
      redacted = true;
      continue;
    }

    // A JSON payload: walk the parsed tree so every nested key is judged, rather
    // than hoping a line-oriented pass copes with compact one-line objects.
    const asJson = redactJsonPayload(value);
    if (asJson) {
      if (asJson.redacted) {
        obj[field][key] = asJson.text;
        redacted = true;
      }
      continue;
    }

    const doc = redactDocument(value);
    if (doc.redacted) {
      obj[field][key] = doc.text;
      redacted = true;
    }
  }
  return redacted;
}

/**
 * Handle a ConfigMap value that is JSON.
 *
 * Returns null when the value is not JSON at all, so the caller falls through to
 * document redaction. When it LOOKS like JSON but does not parse, the entry is
 * dropped whole if it mentions a sensitive key: a compact `{"a":1,"token":"…"}`
 * puts several pairs on one line, and a line-oriented pass over something we
 * could not parse gives no confidence that it rewrote all of them.
 */
function redactJsonPayload(value: string): { text: string; redacted: boolean } | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return mentionsSensitiveKey(trimmed)
      ? { text: REDACTED, redacted: true }
      : null;
  }

  const redacted = redactJsonTree(parsed);
  return { text: redacted ? JSON.stringify(parsed, null, 2) : value, redacted };
}

/** Redact values under sensitive keys anywhere in a parsed JSON tree, in place. */
function redactJsonTree(node: unknown): boolean {
  if (Array.isArray(node)) {
    let redacted = false;
    for (const item of node) {
      if (redactJsonTree(item)) redacted = true;
    }
    return redacted;
  }
  if (!node || typeof node !== "object") return false;

  let redacted = false;
  const obj = node as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (typeof value === "string") {
      if (isSensitiveKeyName(key) || looksLikeSensitiveValue(value)) {
        obj[key] = REDACTED;
        redacted = true;
      }
      continue;
    }
    if (isSensitiveKeyName(key) && value !== null && typeof value === "object") {
      // A sensitive key holding a structure (e.g. `"auth": {…}`) — drop it all.
      obj[key] = REDACTED;
      redacted = true;
      continue;
    }
    if (redactJsonTree(value)) redacted = true;
  }
  return redacted;
}

/** Whether unparseable text names a sensitive key, e.g. `"password":` or `token=`. */
function mentionsSensitiveKey(text: string): boolean {
  for (const m of text.matchAll(/["']?([A-Za-z_][\w.\-]*)["']?\s*[:=]/g)) {
    if (isSensitiveKeyName(m[1])) return true;
  }
  return false;
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
