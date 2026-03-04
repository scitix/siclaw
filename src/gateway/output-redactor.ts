/**
 * Output redaction module — last-line defense for credential leakage.
 *
 * Builds regex patterns from the credential payload (server URLs, file paths,
 * cluster internal names) and replaces them with [REDACTED] in outbound text
 * sent to the user via WebSocket.
 *
 * Only applied to the WS stream — DB stores the original data for debugging.
 */

export interface RedactionConfig {
  patterns: RegExp[];
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface CredentialManifest {
  name: string;
  type: string;
  files: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Build redaction patterns from credential payload, credentials directory path,
 * and any additional sensitive strings (e.g. API keys, provider URLs).
 */
export function buildRedactionConfig(
  manifest?: CredentialManifest[],
  credentialsDir?: string,
  sensitiveStrings?: string[],
): RedactionConfig {
  const patterns: RegExp[] = [];

  // Redact the credentials directory path and any sub-paths
  if (credentialsDir) {
    patterns.push(new RegExp(escapeRegex(credentialsDir) + "[^\\s\"']*", "g"));
  }

  if (manifest) {
    for (const cred of manifest) {
      // File names (relative paths within credentials dir)
      for (const file of cred.files) {
        patterns.push(new RegExp(escapeRegex(file), "g"));
      }

      // Metadata: server URLs, cluster internal names
      if (cred.metadata) {
        const clusters = (cred.metadata as Record<string, unknown>).clusters as
          Array<{ name: string; server?: string }> | undefined;
        if (clusters) {
          for (const c of clusters) {
            if (c.server) {
              patterns.push(new RegExp(escapeRegex(c.server), "g"));
            }
            // Redact cluster internal ID if it differs from the credential display name
            if (c.name && c.name !== cred.name) {
              patterns.push(new RegExp("\\b" + escapeRegex(c.name) + "\\b", "g"));
            }
          }
        }
      }
    }
  }

  // Extra sensitive strings (API keys, provider base URLs, etc.)
  if (sensitiveStrings) {
    for (const s of sensitiveStrings) {
      if (s && s.length >= 8) {
        patterns.push(new RegExp(escapeRegex(s), "g"));
      }
    }
  }

  // Always redact settings.json path references
  patterns.push(/\.siclaw\/config\/settings\.json/g);

  // Generic secret patterns — catch unknown tokens by format (defense-in-depth)
  for (const p of GENERIC_SECRET_PATTERNS) {
    patterns.push(p);
  }

  return { patterns };
}

/**
 * Built-in patterns for common secret/token formats.
 * Each regex uses a non-capturing group and global flag.
 * Patterns are designed to minimize false positives by requiring known prefixes
 * or structural markers.
 */
const GENERIC_SECRET_PATTERNS: RegExp[] = [
  // OpenAI / compatible: sk-<20+ chars>
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  // GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_, github_pat_
  /\b(?:ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // Slack tokens: xox[baprs]-
  /\bxox[baprs]-[A-Za-z0-9\-]{20,}\b/g,
  // Google AI: AIza
  /\bAIza[A-Za-z0-9\-_]{30,}\b/g,
  // Authorization header values
  /\bBearer\s+[A-Za-z0-9\-_.~+/]{20,}=*\b/g,
  // PEM private key blocks
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
  // Generic "apiKey": "value" or "api_key": "value" in JSON output
  /(?<="(?:api[_-]?[Kk]ey|apikey|token|secret|password|access_key|secret_key)":\s*")[^"]{8,}(?=")/g,
  // ENV assignment: API_KEY=value, SECRET_TOKEN=value (printenv/env output)
  /\b(?:API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|SECRET_KEY|ACCESS_KEY|AWS_SECRET_ACCESS_KEY|TOKEN|SECRET_TOKEN|PASSWORD)=\S+/g,
];

/**
 * Replace all sensitive patterns in text with [REDACTED].
 */
export function redactText(text: string, config: RedactionConfig): string {
  if (config.patterns.length === 0) return text;

  let result = text;
  for (const pattern of config.patterns) {
    // Reset lastIndex for stateful (global) regexes
    pattern.lastIndex = 0;
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}
