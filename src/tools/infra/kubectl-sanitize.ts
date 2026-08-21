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

/** Is this the base64 of `user:password`? */
function looksLikeDockerAuth(value: string): boolean {
  if (!/^[A-Za-z0-9+/]{8,}={0,2}$/.test(value)) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64").toString("utf8");
  } catch {
    return false;
  }
  // `user:password` — a colon with printable text on both sides, and no control characters, which is
  // what separates a real encoding from base64-looking noise.
  return /^[\x20-\x7e]+:[\x20-\x7e]+$/.test(decoded);
}

function isSensitiveKeyName(key: string): boolean {
  // `auths` is a registry credential map by definition — its children are the credentials, whatever they
  // are named — so it is sensitive as a KEY even though `auth` alone is not. Matching it here means the
  // existing nested-mapping logic collapses the whole block, which is what the YAML form needs.
  if (key.trim().toLowerCase() === "auths") return true;
  return SENSITIVE_ENV_NAME_PATTERNS.some((p) => p.test(key));
}

function looksLikeSensitiveValue(value: string): boolean {
  // Docker encodes `user:password` as base64, so a value that decodes to `X:Y` IS a credential wherever
  // it sits. This is what covers a bare `auth:` line without making `auth` a sensitive key name — `auth:
  // none`, `auth: ldap` and `auth: rbac` are ordinary configuration and stay readable.
  if (looksLikeDockerAuth(value.trim().replace(/^["']|["']$/g, ""))) return true;
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

  // A ConfigMap entry whose value is JSON on ONE line — `app.json: '{"password":"…"}'` — names its
  // secrets by the keys INSIDE the blob, which no line-oriented test can see: the key on this line is
  // a filename, and the blob as a whole matches no value pattern. The `-o json` path already walks
  // such a payload (redactByPattern); the yaml / describe / pipeline-fallback path reaches the same
  // text through here, so it has to walk it too. Serialized compact to stay one line.
  if (split) {
    const asJson = redactJsonPayload(split.value, { compact: true });
    if (asJson?.redacted) return `${split.prefix}${asJson.text}`;
  }

  const wholeLine = redactJsonPayload(line.trim(), { compact: true });
  if (wholeLine?.redacted) return wholeLine.text;

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

/**
 * Appended when `-o json` output did not parse as JSON.
 *
 * Says what happened rather than hiding it: the structural sanitizer could not run, so the text got the
 * line redactor instead. The caller needs to know which of the two it received — a Secret's `data` is
 * redacted unconditionally by the structural pass, and only by that pass.
 */
export const NON_JSON_NOTICE =
  "\n\n⚠️ This output is not JSON, so the structural sanitizer did not run — the text redactor was "
  + "applied instead. If a value should have been masked structurally, treat this output as unverified.";

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
  "--as-uid",
  "--timeout",
  // kubectl's remaining global value flags. This table decides where the SUBCOMMAND is, and BOTH kinds of
  // error are real:
  //
  //   a missing entry     hands back the flag's value as the verb — `kubectl --as get delete pod victim`
  //                       read as subcommand `get`, and the mutating `delete` went through
  //   a wrong entry       swallows the verb — `--warnings-as-errors` is a BOOLEAN, so listing it here
  //                       made `kubectl --warnings-as-errors delete get pod victim` read as `get` while
  //                       real kubectl runs the delete. It also broke ordinary reads: plain
  //                       `--warnings-as-errors get pods` was refused for naming subcommand `pods`.
  //
  // So this table is not a memory exercise. It is checked against `kubectl options` — a snapshot lives in
  // `testdata/kubectl-options.txt` and `kubectl-flag-table.test.ts` compares the two. Refresh the
  // snapshot by running `kubectl options` when kubectl is upgraded; anything ending `=false` or `=true`
  // there is a boolean and must NOT be listed here.
  "--request-timeout",
  "--cache-dir",
  "--username",
  "--password",
  "--token",
  "--server", "-s",
  "--user",
  "--as-user-extra",
  "--kuberc",
  "--v", "-v",
  "--certificate-authority",
  "--client-certificate",
  "--client-key",
  "--tls-server-name",
  "--profile",
  "--profile-output",
  "--log-file",
  "--log-flush-frequency",
  "--vmodule",
]);

// ── Detection functions ──────────────────────────────────────────────

/**
 * Detect if kubectl args target a sensitive resource type.
 *
 * Handles: secret, secrets, secret/<name>, configmap, configmaps, cm,
 *          cm/<name>, pod, pods, po, po/<name>, comma-separated (pod,secret)
 * Skips flag values (-n, -l, --namespace, etc.)
 */
/**
 * One reading of a kubectl resource token, for the validator AND the sanitizer.
 *
 * They had two: the validator learned `secret.v1.` and `secrets.` (kubectl accepts a
 * `type.version[.group]` form, with a TRAILING dot for a core resource) while the sanitizer still split
 * only on `/`. So `kubectl get secret.v1. demo -o json` passed the format check — which permits `-o json`
 * BECAUSE the structural sanitizer redacts `data` — and then got no sanitizer at all, returning the
 * Secret verbatim. Exactly the drift a comment in this file warned about, on the same pair of functions.
 */
export function normalizeResourceToken(token: string): string {
  return token.split("/")[0].split(".")[0].trim().toLowerCase();
}

/**
 * The subcommand, skipping flag VALUES.
 *
 * `args.find(a => !a.startsWith("-"))` reads `kubectl -n default get secret …` as subcommand "default",
 * so the rule below never fired and a Secret came back unredacted. A global flag before the verb is
 * ordinary kubectl usage, and the flag-arity table needed to see past it already existed here.
 */
export function kubectlSubcommand(args: string[]): string | undefined {
  return subcommandSkippingFlagValues(args, FLAGS_WITH_VALUE);
}

/**
 * Value-taking global flags for `crictl`. Same problem, different binary: `crictl -r <sock> inspect X`
 * read as subcommand `<sock>`, so the inspect sanitizer never attached and the container's environment —
 * including its credentials — came back verbatim.
 *
 * Not reported by review; found by asking whether the kubectl bug generalised, which it did.
 */
const CRICTL_FLAGS_WITH_VALUE = new Set([
  "-r", "--runtime-endpoint",
  "-i", "--image-endpoint",
  "-c", "--config",
  "-t", "--timeout",
]);

export function crictlSubcommand(args: string[]): string | undefined {
  return subcommandSkippingFlagValues(args, CRICTL_FLAGS_WITH_VALUE);
}

/**
 * The first POSITIONAL argument, skipping flags and the values they consume.
 *
 * `args.find(a => !a.startsWith("-"))` is the shape this replaces, and it was written six times across
 * this codebase. Every copy had the same defect — a global flag before the verb hands back the flag's
 * VALUE as the subcommand — and each copy failed differently: no sanitizer for a Secret read, no
 * sanitizer for a crictl inspect, no Secret-into-pipe guard. Anything that needs a subcommand goes
 * through here with its own arity table.
 */
function subcommandSkippingFlagValues(args: string[], valueFlags: ReadonlySet<string>): string | undefined {
  let skipNext = false;
  for (const arg of args) {
    if (skipNext) { skipNext = false; continue; }
    // `--flag=value` carries its value inline, so it consumes nothing extra.
    if (valueFlags.has(arg)) { skipNext = true; continue; }
    if (arg.startsWith("-")) continue;
    return arg.toLowerCase();
  }
  return undefined;
}

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
      const resourceType = normalizeResourceToken(part);
      if (resourceType in RESOURCE_ALIAS_MAP) {
        return RESOURCE_ALIAS_MAP[resourceType];
      }
    }
  }

  return null;
}

/**
 * Short flags that consume the next token, so a cluster ends at them.
 *
 * Read off `kubectl get --help` / `logs --help` rather than recalled: `-o -n -l -c -L -k` take values,
 * `-A -R -w -p -i -t` do not. `-f` is ambiguous — a filename in `get`/`apply`, a boolean `--follow` in
 * `logs` — and is listed as value-taking because that is the reading that consumes MORE, which cannot
 * cause a format or `-A` declaration later in the cluster to be missed.
 */
const SHORT_FLAGS_WITH_VALUE = new Set(["o", "n", "l", "c", "s", "v", "L", "k", "f"]);

/**
 * Every output-format declaration in an argv, in the order kubectl sees them.
 *
 * Two facts about kubectl's real grammar, both measured against a live cluster, and each was a bypass:
 *
 *   LAST WINS.  `kubectl get secret x -o json -o jsonpath={.data.password}` returns the bare base64.
 *               Both readers here returned the FIRST format, so a Secret-safe `-o json` in front of an
 *               unsafe one passed the check and kubectl then printed the value.
 *   CLUSTERS.   pflag reads `-Ao json` and `-Aojson` as `-A` plus `-o json`. Both readers only matched a
 *               token STARTING with `-o`, so `kubectl get secrets -Ao json` was read as table output —
 *               permitted, and with no sanitizer attached, while kubectl returned every Secret as JSON.
 *
 * Returning the whole list rather than one answer is deliberate: the caller that decides whether a
 * command may run must refuse if ANY declared format is unsafe (kubectl only prints the last, but a
 * command carrying an unsafe one is not a command worth defending), while the caller choosing a sanitizer
 * wants the effective one. One reader, two questions, no third copy.
 */
export function kubectlOutputFormats(args: string[]): string[] {
  const formats: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // `--template=X` is the alias for `-o go-template=X`; `--raw` is not a format at all but a raw API
    // passthrough, which no printer and no sanitizer covers. Both belong in this list.
    if (arg === "--template" || arg.startsWith("--template=")) { formats.push("go-template"); continue; }
    if (arg === "--raw" || arg.startsWith("--raw=")) { formats.push("raw"); continue; }

    if (arg === "--output" || arg === "-o") {
      const next = args[i + 1];
      if (next && !next.startsWith("-")) { formats.push(extractFormatName(next)); i++; }
      continue;
    }
    if (arg.startsWith("--output=")) { formats.push(extractFormatName(arg.slice(9))); continue; }
    if (arg.startsWith("-o=")) { formats.push(extractFormatName(arg.slice(3))); continue; }
    if (arg.startsWith("--")) continue;

    // A short cluster. Walk it: a value-taking flag ends the cluster and claims the rest of the token,
    // or the next token when nothing is left. Unknown letters are treated as booleans and scanning
    // CONTINUES, so an `o` or an `A` behind one is still seen.
    if (arg.startsWith("-") && arg.length > 1) {
      for (let k = 1; k < arg.length; k++) {
        const ch = arg[k];
        if (!SHORT_FLAGS_WITH_VALUE.has(ch)) continue;
        let value = arg.slice(k + 1);
        if (value.startsWith("=")) value = value.slice(1);
        if (value === "") {
          const next = args[i + 1];
          if (next && !next.startsWith("-")) { value = next; i++; }
        }
        if (ch === "o" && value !== "") formats.push(extractFormatName(value));
        break;   // the rest of the token was this flag's value
      }
    }
  }
  return formats;
}

/** Does this argv declare `-A` / `--all-namespaces`, including inside a short cluster? */
export function kubectlAllNamespaces(args: string[]): boolean {
  for (const arg of args) {
    if (arg === "--all-namespaces" || arg === "-A") return true;
    if (arg.startsWith("--all-namespaces=")) return arg.slice(17) !== "false";
    if (!arg.startsWith("-") || arg.startsWith("--")) continue;
    // In a cluster, `A` counts wherever it appears before a value-taking flag consumes the rest.
    for (let k = 1; k < arg.length; k++) {
      if (arg[k] === "A") return true;
      if (SHORT_FLAGS_WITH_VALUE.has(arg[k])) break;
    }
  }
  return false;
}

/**
 * The format kubectl will actually use — the LAST declaration, or null for default table output.
 *
 * Sanitizer-side callers want this one. Callers deciding whether the command may run at all should use
 * `kubectlOutputFormats` and reject on any unsafe entry.
 */
export function getOutputFormat(args: string[]): string | null {
  const formats = kubectlOutputFormats(args);
  return formats.length > 0 ? formats[formats.length - 1] : null;
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
    // NOT JSON. Suppressing it wholesale was worse than the leak it guarded against: the usual reason
    // `-o json` returns non-JSON is that kubectl wrote an API error to stderr, and
    // "Failed to parse … Raw output suppressed" replaced `Error from server (NotFound)` with what reads
    // like a sanitizer malfunction. Four separate reviews reported that misdiagnosis; the actual
    // NotFound was gone from the record entirely.
    //
    // So the text is kept, run through the line redactor first. That is strictly better than
    // suppression in both directions: an API error survives, and a recognisable secret is still masked
    // — the structural sanitizer never applied to this text anyway, since it does not parse.
    const text = redactSensitiveContent(output);
    return text + NON_JSON_NOTICE;
  }

  let redacted = false;
  for (const item of getItems(obj)) {
    // Each item is judged by its OWN kind. `kubectl get pod,secret -o json` returns one List holding
    // both, and detectSensitiveResource stops at the first sensitive type it finds in the command — so
    // every item was treated as a Pod, the Secret's `data` was returned verbatim, and the redaction
    // notice went out anyway. A notice over an untouched secret is worse than no notice.
    //
    // The command-inferred type stays as the fallback: an item may carry no `kind` (a single object
    // fetched by name sometimes does not), and then the command is the only evidence available.
    const kind = typeof (item as any)?.kind === "string" ? (item as any).kind.toLowerCase() : "";
    const perItem = KIND_TO_SENSITIVE_RESOURCE[kind] ?? resourceType;
    // Not `redacted ||=` — that short-circuits and skips the remaining items.
    if (sanitizeObject(item, perItem)) redacted = true;
  }

  // Shape-agnostic sweep over the WHOLE document, after the structural pass. This is what covers a
  // payload the agent reshaped in the pipeline, where the structural walk has no path to follow.
  if (redactSensitiveNameValuePairs(obj)) redacted = true;
  // Registry credentials, which travel under names the key patterns do not cover (`config.json`, a bare
  // `auth`) and inside ConfigMap entries that hold a whole file.
  if (redactRegistryAuth(obj)) redacted = true;

  const sanitized = JSON.stringify(obj, null, 2);
  return redacted ? sanitized + REDACTION_NOTICE : sanitized;
}

/**
 * A resource kind, as it appears in `.kind`, mapped to the sanitizer that knows how to treat it.
 * Anything absent from here has no sensitive payload of its own.
 */
const KIND_TO_SENSITIVE_RESOURCE: Record<string, SensitiveResourceType> = {
  secret: "secret",
  configmap: "configmap",
  pod: "pod",
};

/**
 * Flatten a response into the objects that need judging.
 *
 * Recurses through `*List` nesting rather than looking one level deep: `kubectl get pod,secret -o json`
 * returns a List of items, but a List can itself hold a List, and an item that is never visited is an
 * item that is never redacted. Depth is bounded so a hand-crafted document cannot spin here.
 */
function getItems(obj: any, depth = 0): any[] {
  if (depth > 8 || !obj || typeof obj !== "object") return obj ? [obj] : [];
  if (Array.isArray(obj.items)) {
    return obj.items.flatMap((item: any) =>
      item && typeof item === "object" && Array.isArray(item.items)
        ? getItems(item, depth + 1)
        : [item],
    );
  }
  return [obj];
}

/**
 * `kubectl apply` stores a JSON copy of the whole object — INCLUDING `data` — in this annotation, so a
 * Secret managed that way carries its own values a second time, outside the field the sanitizer redacts.
 *
 * Measured: `kubectl get secret x -o json` on an applied Secret redacted `data.password`, appended the
 * "redacted" notice, and returned the base64 verbatim inside the annotation. `-o json` is the ONE format
 * the Secret control permits precisely because the structural sanitizer was believed to cover it, so
 * this defeated that control for every Secret created or updated with `apply` — which is how most are.
 *
 * Missed originally because the verification Secret was built with `kubectl create secret generic`,
 * which writes no such annotation. A blind spot in the fixture, not in the reasoning.
 */
const LAST_APPLIED_ANNOTATION = "kubectl.kubernetes.io/last-applied-configuration";



/**
 * Redact `{name, value}` pairs with a sensitive name, ANYWHERE in the document.
 *
 * The structural sanitizers walk known paths — `spec.containers[].env` for a Pod, `data` for a Secret —
 * which holds only while the payload keeps the shape kubectl produced. It routinely does not: the agent
 * pipes through jq. A real trace shows
 *
 *   kubectl get pod X -o json | jq '{podIP:…,containers:[.spec.containers[]|{name,ports,env,…}]}'
 *
 * whose output has `containers` at the TOP level and no `kind` at all. `getItems` returned it as one
 * item, the missing `kind` fell back to the command's "pod", and `sanitizePodEnv` looked for
 * `spec.containers` and found nothing — so four credential env vars went to the model and into a
 * persisted trace verbatim, with `outcome: success` and no notice. The text redactor does not cover it
 * either: it does not recognise the JSON `{name, value}` env shape, in compact OR pretty form (measured).
 *
 * This pass is shape-agnostic on purpose: it asks only "is this an object with a string `name` and a
 * string `value`", which is what an env entry looks like however the document was reshaped. It runs in
 * ADDITION to the structural pass, never instead of it — the structural pass redacts a Secret's `data`
 * unconditionally, which no name heuristic could do.
 */
function redactSensitiveNameValuePairs(node: unknown, depth = 0): boolean {
  if (depth > 64 || node === null || typeof node !== "object") return false;
  let redacted = false;
  if (Array.isArray(node)) {
    for (const child of node) if (redactSensitiveNameValuePairs(child, depth + 1)) redacted = true;
    return redacted;
  }
  const obj = node as Record<string, unknown>;
  if (typeof obj.name === "string" && typeof obj.value === "string" && obj.value !== REDACTED
      && SENSITIVE_ENV_NAME_PATTERNS.some((re) => re.test(obj.name as string))) {
    obj.value = REDACTED;
    redacted = true;
  }
  for (const key of Object.keys(obj)) {
    if (redactSensitiveNameValuePairs(obj[key], depth + 1)) redacted = true;
  }
  return redacted;
}

/**
 * A docker registry credential, wherever it is stored.
 *
 * `.dockerconfigjson` was covered by key name, but the same credential travels under `config.json`, or a
 * bare `auth`, or inside a ConfigMap entry that holds a whole file — a review found all three returning
 * `dXNlcjpwYXNz` verbatim, in JSON and in YAML.
 *
 * Two signals, both unambiguous, because `auth` on its own is NOT one: `auth: none`, `auth: ldap`,
 * `auth: rbac` are ordinary configuration and must stay readable.
 *
 *   1. CONTEXT — an `auths` object maps a registry to its credentials by definition, so everything
 *      credential-shaped inside it is a credential. No false positives available.
 *   2. VALUE SHAPE — docker encodes `user:password` as base64. A value that decodes to `X:Y` with
 *      printable halves is that encoding; `none`, `ldap` and `rbac` do not decode that way.
 */
const REGISTRY_CRED_FIELDS = new Set(["auth", "password", "identitytoken", "registrytoken"]);


/** Redact registry credentials anywhere in a parsed document. Returns whether anything changed. */
function redactRegistryAuth(node: unknown, insideAuths = false, depth = 0): boolean {
  if (depth > 64 || node === null || typeof node !== "object") return false;
  let redacted = false;
  if (Array.isArray(node)) {
    for (const child of node) if (redactRegistryAuth(child, insideAuths, depth + 1)) redacted = true;
    return redacted;
  }
  const obj = node as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const lower = key.toLowerCase();
    const value = obj[key];

    // (1) inside an `auths` subtree, every credential field is a credential
    if (insideAuths && REGISTRY_CRED_FIELDS.has(lower) && typeof value === "string" && value !== REDACTED) {
      obj[key] = REDACTED;
      redacted = true;
      continue;
    }

    // (2) outside it, only the docker encoding itself
    if (lower === "auth" && typeof value === "string" && value !== REDACTED && looksLikeDockerAuth(value)) {
      obj[key] = REDACTED;
      redacted = true;
      continue;
    }

    // A ConfigMap entry is often a whole FILE: parse it and look inside.
    if (typeof value === "string" && /"auths"\s*:/.test(value)) {
      try {
        const inner = JSON.parse(value);
        if (redactRegistryAuth(inner, insideAuths, depth + 1)) {
          obj[key] = JSON.stringify(inner);
          redacted = true;
          continue;
        }
      } catch {
        // not JSON after all — the text redactor still sees it
      }
    }

    if (redactRegistryAuth(value, insideAuths || lower === "auths", depth + 1)) redacted = true;
  }
  return redacted;
}

/** Sanitize a single Kubernetes object in place; returns whether anything was redacted. */
function sanitizeObject(obj: any, resourceType: SensitiveResourceType): boolean {
  let redacted = false;
  switch (resourceType) {
    case "secret": {
      // Both must run — `||` would short-circuit and leave the later one raw.
      const data = redactAllValues(obj, "data");
      const stringData = redactAllValues(obj, "stringData");
      redacted = data || stringData;
      break;
    }

    case "configmap": {
      const data = redactByPattern(obj, "data");
      const binaryData = redactByPattern(obj, "binaryData");
      redacted = data || binaryData;
      break;
    }

    case "pod":
      redacted = sanitizePodEnv(obj);
      break;
  }

  // `kubectl apply` keeps a JSON copy of the WHOLE object it was given in an annotation, so every
  // structural pass above has to run a second time on that copy. It is handled here rather than per kind
  // because doing it per kind is how a kind gets missed: Secret and ConfigMap were covered, Pod was not,
  // and an apply-managed Pod's `-o json` — the one permitted format — returned its container env
  // verbatim. Measured against a real applied Pod: the canary appeared twice in the response and once
  // after sanitizing.
  const applied = redactAppliedConfig(obj, resourceType);
  return redacted || applied;
}

/**
 * Redact the `last-applied-configuration` copy with the same passes as the live object.
 *
 * The copy is a JSON STRING, so the text redactor cannot see the shapes that matter — it does not
 * recognise the `{name, value}` env form in either compact or pretty JSON, which is documented on
 * `redactSensitiveNameValuePairs` and is exactly why the Pod case leaked. So the string is parsed,
 * sanitized structurally, and re-serialized; only when it does not parse does the text redactor apply.
 */
function redactAppliedConfig(obj: any, resourceType: SensitiveResourceType): boolean {
  const ann = obj?.metadata?.annotations;
  if (!ann || typeof ann !== "object") return false;

  // EVERY annotation whose value is a serialized object, not only the well-known key. A controller's own
  // snapshot or an operator's copy is the same disclosure under a different name, and the predecessor of
  // this function already handled that — narrowing it to `last-applied` while widening what it does to
  // the value would have been a straight regression, caught by the test that pins it.
  let any = false;
  for (const key of Object.keys(ann)) {
    const raw = ann[key];
    if (typeof raw !== "string" || raw === "") continue;
    const wellKnown = key === LAST_APPLIED_ANNOTATION;
    // A cheap shape test for the others, so an ordinary annotation string is not parsed on every object.
    if (!wellKnown && !/"(?:data|stringData|env|containers|spec)"\s*:/.test(raw)) continue;
    if (redactOneAnnotation(ann, key, raw, resourceType)) any = true;
  }
  return any;
}

function redactOneAnnotation(
  ann: Record<string, any>,
  annKey: string,
  value: string,
  resourceType: SensitiveResourceType,
): boolean {
  let parsed: any;
  try { parsed = JSON.parse(value); } catch { parsed = undefined; }
  if (parsed && typeof parsed === "object") {
    // A Secret's copy is blanked wholesale, as the live object is; the others get their own passes plus
    // the shape-agnostic sweep, which covers a copy whose shape does not match this kind.
    let hit = false;
    if (resourceType === "secret") {
      hit = redactAllValues(parsed, "data") || redactAllValues(parsed, "stringData") || hit;
    } else if (resourceType === "configmap") {
      hit = redactByPattern(parsed, "data") || redactByPattern(parsed, "binaryData") || hit;
    } else if (resourceType === "pod") {
      hit = sanitizePodEnv(parsed) || hit;
    }
    hit = redactSensitiveNameValuePairs(parsed) || hit;
    hit = redactRegistryAuth(parsed) || hit;
    if (hit) {
      ann[annKey] = JSON.stringify(parsed);
      return true;
    }
    return false;
  }

  const cleaned = redactSensitiveContent(value);
  if (cleaned === value) return false;
  ann[annKey] = cleaned;
  return true;
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
function redactJsonPayload(
  value: string,
  opts?: { compact?: boolean },
): { text: string; redacted: boolean } | null {
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
  // A line-level caller must not turn one line into several: it would corrupt the surrounding
  // document's shape, and the streaming sanitizer works a line at a time.
  const text = redacted
    ? (opts?.compact ? JSON.stringify(parsed) : JSON.stringify(parsed, null, 2))
    : value;
  return { text, redacted };
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
