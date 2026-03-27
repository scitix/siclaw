/**
 * Script Security Evaluator
 *
 * Two-phase analysis of skill scripts:
 * 1. Static regex-based pattern matching for known dangerous patterns
 * 2. AI semantic analysis via OpenAI-compatible API for deeper understanding
 *
 * Used by skill.create / skill.update to gate scripts before activation.
 */

import type { ReviewFinding } from "../db/schema.js";
import type { ModelConfigRepository } from "../db/repositories/model-config-repo.js";

export interface ScriptReviewResult {
  riskLevel: "low" | "medium" | "high" | "critical";
  findings: ReviewFinding[];
  summary: string;
}

interface EvaluateRequest {
  skillName: string;
  scripts: Array<{ name: string; content: string }>;
  specs?: string;
}

// ─── Static Pattern Rules ────────────────────────────

interface PatternRule {
  category: string;
  severity: "low" | "medium" | "high" | "critical";
  pattern: RegExp;
  description: string;
}

// Cross-reference: src/tools/infra/command-sets.ts (ALLOWED_COMMANDS, COMMAND_RULES).
// When modifying either file, verify the other still makes sense.
const DANGER_PATTERNS: PatternRule[] = [
  // Critical
  { category: "destructive_command", severity: "critical", pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--recursive)\b/g, description: "Recursive forced file deletion (rm -rf)" },
  { category: "destructive_command", severity: "critical", pattern: /\bmkfs\b/g, description: "Filesystem format command" },
  { category: "destructive_command", severity: "critical", pattern: /\bdd\s+.*of=/g, description: "Direct disk write (dd)" },
  { category: "network_modification", severity: "critical", pattern: /\biptables\b/g, description: "Firewall rule modification" },
  { category: "network_modification", severity: "critical", pattern: /\bip\s+route\s+(add|del)/g, description: "Network route modification" },
  { category: "privilege_escalation", severity: "critical", pattern: /\bsudo\b/g, description: "Privilege escalation via sudo" },
  { category: "privilege_escalation", severity: "critical", pattern: /\bnsenter\b/g, description: "Namespace entry (container escape risk)" },
  { category: "privilege_escalation", severity: "critical", pattern: /\bchroot\b/g, description: "Root directory change" },

  // High
  { category: "env_mutation", severity: "high", pattern: /\bkubectl\s+(create|apply|patch|delete|scale|drain|cordon|uncordon|edit|replace|set|annotate|label|taint|rollout\s+undo)\b/g, description: "Kubernetes write/mutation operation" },
  { category: "env_mutation", severity: "high", pattern: /\bsed\s+-i\b/g, description: "In-place file modification (sed -i)" },
  { category: "env_mutation", severity: "medium", pattern: /\bmysql\b.*\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\b/gi, description: "Database write operation" },
  { category: "system_modification", severity: "high", pattern: /\bsystemctl\s+(stop|disable|restart|mask)\b/g, description: "System service modification" },
  { category: "system_modification", severity: "high", pattern: /\b(mount|umount)\b/g, description: "Filesystem mount/unmount" },
  { category: "system_modification", severity: "high", pattern: /\bchmod\s+[0-7]*[0-7][0-7][0-7]\b/g, description: "File permission change" },
  { category: "data_exfiltration", severity: "high", pattern: /\bcurl\s+.*(-d|--data|--upload-file|-F)\b/g, description: "Data upload via curl" },
  { category: "data_exfiltration", severity: "high", pattern: /\b(nc|netcat|ncat)\b/g, description: "Netcat — potential reverse shell or data exfiltration" },
  { category: "destructive_command", severity: "high", pattern: /\bkill\s+(-9|-KILL)\b/g, description: "Forced process kill" },

  // Medium
  { category: "file_write", severity: "medium", pattern: />\s*\/[^\s]/g, description: "File write via redirect to absolute path" },
  { category: "file_write", severity: "medium", pattern: /\btee\s+/g, description: "File write via tee" },
  { category: "package_management", severity: "medium", pattern: /\b(apt|apt-get|yum|dnf)\s+install\b/g, description: "System package installation" },
  { category: "package_management", severity: "medium", pattern: /\bpip\s+install\b/g, description: "Python package installation" },
  { category: "package_management", severity: "medium", pattern: /\bnpm\s+install\b/g, description: "Node.js package installation" },
];

// ─── LLM Config ─────────────────────────────────────

interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

// ─── ScriptEvaluator ─────────────────────────────────

const SYSTEM_PROMPT = `You are a security reviewer for operational scripts that run in Kubernetes clusters.
Analyze scripts for security risks across these dimensions:
1. Destructive operations (data loss, resource deletion)
2. Privilege escalation
3. Network modifications
4. Data exfiltration
5. System modification
6. Package installation (supply chain risk)
7. Credential exposure
8. Resource abuse (crypto mining, fork bombs)
9. Container escape
10. Unintended side effects
11. **Write operations / Environment mutation** — Scripts MUST be read-only. Any command that modifies files, databases, K8s resources, or system state is a finding. Allowed: read, get, describe, list, logs, top, cat, head, grep, jq, curl (GET only), etc. Disallowed: write, create, update, patch, apply, delete, tee, redirect (>), sed -i, etc.

CRITICAL RULE: Skills MUST NOT modify the environment. They may have filesystem write permission (for temp files, reports), but the intent and actual commands must be strictly read-only diagnostic/reporting operations. Flag ANY command that could mutate cluster state, databases, or system configuration as HIGH or CRITICAL risk.

Respond with ONLY valid JSON (no markdown fences) in this exact format:
{
  "riskLevel": "low" | "medium" | "high" | "critical",
  "findings": [
    {
      "category": "string",
      "severity": "low" | "medium" | "high" | "critical",
      "description": "string",
      "lineRef": "filename:lineNumber (optional)",
      "snippet": "relevant code snippet (optional)"
    }
  ],
  "summary": "1-3 sentence overall assessment"
}

Be practical: scripts meant for K8s operations may legitimately use kubectl for read operations. Focus on truly dangerous patterns and any commands that could mutate environment state.
If the static analysis flagged something, confirm or refute with context.`;

export class ScriptEvaluator {
  private config: LlmConfig | null | undefined = undefined; // undefined = not loaded yet
  private modelConfigRepo: ModelConfigRepository | null;

  constructor(modelConfigRepo?: ModelConfigRepository | null) {
    this.modelConfigRepo = modelConfigRepo ?? null;
  }

  private async getConfig(): Promise<LlmConfig> {
    // Don't cache null results — config may become available after startup
    if (this.config) return this.config;
    if (this.modelConfigRepo) {
      this.config = await this.modelConfigRepo.getResolvedDefaultConfig();
    }
    if (!this.config) throw new Error("No LLM provider configured — add one via WebUI or DB");
    return this.config;
  }

  /** Run both static and AI analysis on skill scripts */
  async evaluate(req: EvaluateRequest): Promise<ScriptReviewResult> {
    // Static analysis on both scripts and specs (specs contain command templates the agent follows)
    const allContent = [...req.scripts];
    if (req.specs) {
      allContent.push({ name: "skill.md", content: req.specs });
    }
    const staticFindings = this.staticAnalysis(allContent);

    try {
      return await this.aiAnalysis(req, staticFindings);
    } catch (err) {
      console.warn("[ScriptEvaluator] AI analysis failed, using static-only:", (err as Error).message);
      // Fallback to static analysis only
      const riskLevel = this.computeRiskLevel(staticFindings);
      return {
        riskLevel,
        findings: staticFindings,
        summary: staticFindings.length > 0
          ? `Static analysis found ${staticFindings.length} potential issue(s). AI analysis unavailable.`
          : "No issues found by static analysis. AI analysis unavailable.",
      };
    }
  }

  /** Phase 1: Regex-based static pattern matching */
  staticAnalysis(scripts: Array<{ name: string; content: string }>): ReviewFinding[] {
    const findings: ReviewFinding[] = [];

    for (const script of scripts) {
      const lines = script.content.split("\n");
      for (const rule of DANGER_PATTERNS) {
        // Reset regex lastIndex for global patterns
        rule.pattern.lastIndex = 0;

        for (let i = 0; i < lines.length; i++) {
          rule.pattern.lastIndex = 0;
          const match = rule.pattern.exec(lines[i]);
          if (match) {
            findings.push({
              category: rule.category,
              severity: rule.severity,
              description: rule.description,
              lineRef: `${script.name}:${i + 1}`,
              snippet: lines[i].trim().slice(0, 120),
            });
          }
        }
      }
    }

    return findings;
  }

  /** Phase 2: AI semantic analysis via OpenAI-compatible API */
  private async aiAnalysis(
    req: EvaluateRequest,
    staticFindings: ReviewFinding[],
  ): Promise<ScriptReviewResult> {
    const config = await this.getConfig();

    const scriptContents = req.scripts
      .map((s) => `--- ${s.name} ---\n${s.content}`)
      .join("\n\n");

    const staticContext = staticFindings.length > 0
      ? `\n\nStatic analysis found these patterns:\n${JSON.stringify(staticFindings, null, 2)}`
      : "\n\nStatic analysis found no issues.";

    const userContent = `Review the following scripts for skill "${req.skillName}":\n\n${scriptContents}${req.specs ? `\nSkill specification:\n${req.specs}` : ""}${staticContext}`;

    const resp = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 2048,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`LLM API error ${resp.status}: ${body.slice(0, 200)}`);
    }

    const data = await resp.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content ?? "";

    // Strip markdown fences if present
    const cleaned = text.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();

    try {
      const parsed = JSON.parse(cleaned) as ScriptReviewResult;
      // Merge static findings that AI didn't cover
      const aiCategories = new Set(parsed.findings.map((f) => `${f.category}:${f.lineRef}`));
      for (const sf of staticFindings) {
        if (!aiCategories.has(`${sf.category}:${sf.lineRef}`)) {
          parsed.findings.push(sf);
        }
      }
      // Validate riskLevel
      if (!["low", "medium", "high", "critical"].includes(parsed.riskLevel)) {
        parsed.riskLevel = this.computeRiskLevel(parsed.findings);
      }
      return parsed;
    } catch {
      // AI returned invalid JSON — fall back to static
      console.warn("[ScriptEvaluator] Failed to parse AI response, using static findings");
      return {
        riskLevel: this.computeRiskLevel(staticFindings),
        findings: staticFindings,
        summary: `AI analysis returned unparseable response. Static analysis found ${staticFindings.length} issue(s).`,
      };
    }
  }

  /** Compute overall risk from findings */
  private computeRiskLevel(findings: ReviewFinding[]): ScriptReviewResult["riskLevel"] {
    if (findings.some((f) => f.severity === "critical")) return "critical";
    if (findings.some((f) => f.severity === "high")) return "high";
    if (findings.some((f) => f.severity === "medium")) return "medium";
    return "low";
  }
}
