/**
 * Two-phase script security evaluation for skill review.
 * Phase 1: Static regex pattern matching for known dangerous patterns.
 * Phase 2: AI semantic analysis (placeholder for now).
 */

export interface SecurityFinding {
  category: string;
  severity: "critical" | "high" | "medium" | "low";
  pattern: string;
  match: string;
  scriptName: string;
  line: number;
}

export interface SecurityAssessment {
  risk_level: "critical" | "high" | "medium" | "low" | "safe";
  findings: SecurityFinding[];
  summary: string;
}

interface DangerPattern {
  category: string;
  severity: SecurityFinding["severity"];
  pattern: RegExp;
  description: string;
}

const DANGER_PATTERNS: DangerPattern[] = [
  // Critical: destructive filesystem operations
  { category: "destructive_command", severity: "critical", pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--recursive)\b/g, description: "Recursive force delete" },
  { category: "destructive_command", severity: "critical", pattern: /\bmkfs\b/g, description: "Format filesystem" },
  { category: "destructive_command", severity: "critical", pattern: /\bdd\s+.*of=/g, description: "Direct disk write" },

  // Critical: kubectl mutations
  { category: "cluster_mutation", severity: "critical", pattern: /\bkubectl\s+(delete|patch|apply|create|replace|edit|scale|cordon|drain|taint)\b/g, description: "kubectl write operation" },
  { category: "cluster_mutation", severity: "high", pattern: /\bkubectl\s+exec\b/g, description: "kubectl exec" },

  // High: privilege escalation
  { category: "privilege_escalation", severity: "high", pattern: /\bsudo\b/g, description: "sudo usage" },
  { category: "privilege_escalation", severity: "high", pattern: /\bchmod\s+[0-7]*[2367][0-7]*\b/g, description: "Set dangerous permissions" },
  { category: "privilege_escalation", severity: "high", pattern: /\bchown\b/g, description: "Change file ownership" },

  // High: data exfiltration
  { category: "data_exfiltration", severity: "high", pattern: /\bcurl\s+.*(-d|--data|--data-raw|-F|--form|-T|--upload-file)\b/g, description: "curl data upload" },
  { category: "data_exfiltration", severity: "high", pattern: /\bwget\s+.*--post/g, description: "wget POST" },
  { category: "data_exfiltration", severity: "medium", pattern: /\bnc\b|\bnetcat\b|\bncat\b/g, description: "Netcat usage" },

  // Medium: environment mutation
  { category: "env_mutation", severity: "medium", pattern: /\bexport\s+(PATH|LD_PRELOAD|LD_LIBRARY_PATH|KUBECONFIG)=/g, description: "Sensitive env var override" },
  { category: "env_mutation", severity: "medium", pattern: /\bsource\s+/g, description: "Source external script" },

  // Medium: network operations
  { category: "network", severity: "medium", pattern: /\bcurl\b|\bwget\b/g, description: "Network fetch" },
  { category: "network", severity: "medium", pattern: /\bssh\b|\bscp\b|\brsync\b/g, description: "Remote access" },

  // Low: info gathering
  { category: "info_gathering", severity: "low", pattern: /\benv\b|\bprintenv\b/g, description: "Environment dump" },
  { category: "info_gathering", severity: "low", pattern: /\/etc\/(passwd|shadow|hosts)/g, description: "System file access" },
];

interface ScriptEntry {
  name: string;
  content: string;
}

export function evaluateScriptsStatic(scripts: ScriptEntry[]): SecurityFinding[] {
  const findings: SecurityFinding[] = [];

  for (const script of scripts) {
    const lines = script.content.split("\n");
    for (const dp of DANGER_PATTERNS) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Reset lastIndex for global regex
        dp.pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = dp.pattern.exec(line)) !== null) {
          findings.push({
            category: dp.category,
            severity: dp.severity,
            pattern: dp.description,
            match: match[0],
            scriptName: script.name,
            line: i + 1,
          });
        }
      }
    }
  }

  return findings;
}

export function computeRiskLevel(findings: SecurityFinding[]): SecurityAssessment["risk_level"] {
  if (findings.some(f => f.severity === "critical")) return "critical";
  if (findings.some(f => f.severity === "high")) return "high";
  if (findings.some(f => f.severity === "medium")) return "medium";
  if (findings.some(f => f.severity === "low")) return "low";
  return "safe";
}

export function buildAssessment(findings: SecurityFinding[]): SecurityAssessment {
  const riskLevel = computeRiskLevel(findings);
  const summary = findings.length === 0
    ? "No dangerous patterns detected."
    : `Found ${findings.length} finding(s): ${findings.filter(f => f.severity === "critical").length} critical, ${findings.filter(f => f.severity === "high").length} high, ${findings.filter(f => f.severity === "medium").length} medium, ${findings.filter(f => f.severity === "low").length} low.`;

  return { risk_level: riskLevel, findings, summary };
}
