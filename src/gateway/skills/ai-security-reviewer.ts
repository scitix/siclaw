/**
 * Phase 2: AI semantic security analysis for skill review.
 *
 * Calls a configured LLM with the skill scripts + Phase 1 static findings,
 * and returns a structured risk assessment. Falls back to static-only if
 * no model provider is available or the call fails.
 */

import { getDb } from "../db.js";
import type { SecurityAssessment, SecurityFinding } from "./script-evaluator.js";

interface ModelProvider {
  base_url: string;
  api_key: string;
  api_type: string;
}

interface ModelEntry {
  model_id: string;
}

interface AIReviewResult {
  risk_level: string;
  findings: Array<{
    category: string;
    severity: string;
    description: string;
    scriptName: string;
    line?: number;
  }>;
  summary: string;
}

const SYSTEM_PROMPT = `You are a security reviewer for operational scripts used by an SRE AI copilot.
These scripts run inside Kubernetes pods and have access to cluster resources via kubectl and the host filesystem.

Analyze the provided scripts for security risks. Consider:
1. Can this script modify or delete cluster resources?
2. Can it exfiltrate data (send data to external endpoints)?
3. Can it escalate privileges?
4. Can it access sensitive files or credentials?
5. Are there command injection vectors?
6. Could it cause denial of service?

Return your analysis as JSON with this exact structure:
{
  "risk_level": "critical" | "high" | "medium" | "low" | "safe",
  "findings": [
    {
      "category": "string (e.g. cluster_mutation, data_exfiltration, privilege_escalation)",
      "severity": "critical" | "high" | "medium" | "low",
      "description": "string describing the risk",
      "scriptName": "string filename",
      "line": number or null
    }
  ],
  "summary": "one paragraph summary of the overall risk assessment"
}

Return ONLY valid JSON, no markdown fences or explanation outside the JSON.`;

function buildUserPrompt(
  scripts: { name: string; content: string }[],
  staticFindings: SecurityFinding[],
): string {
  let prompt = "## Scripts to review\n\n";
  for (const s of scripts) {
    prompt += `### ${s.name}\n\`\`\`\n${s.content}\n\`\`\`\n\n`;
  }

  if (staticFindings.length > 0) {
    prompt += "## Static analysis findings (for context)\n\n";
    for (const f of staticFindings) {
      prompt += `- [${f.severity}] ${f.pattern} in ${f.scriptName}:${f.line} — matched: \`${f.match}\`\n`;
    }
  }

  prompt += "\nProvide your security assessment as JSON.";
  return prompt;
}

async function getDefaultProvider(): Promise<{ provider: ModelProvider; model: ModelEntry } | null> {
  const db = getDb();
  // Find any provider with a model entry
  const [providers] = await db.query(
    "SELECT id, base_url, api_key, api_type FROM model_providers ORDER BY sort_order ASC LIMIT 1",
  ) as any;
  if (providers.length === 0) return null;

  const provider = providers[0];
  const [models] = await db.query(
    "SELECT model_id FROM model_entries WHERE provider_id = ? ORDER BY is_default DESC, sort_order ASC LIMIT 1",
    [provider.id],
  ) as any;
  if (models.length === 0) return null;

  return { provider, model: models[0] };
}

async function callLLM(
  provider: ModelProvider,
  model: ModelEntry,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // OpenAI-compatible API format (covers OpenAI, Claude via proxy, vLLM, etc.)
  if (provider.api_key) {
    headers["Authorization"] = `Bearer ${provider.api_key}`;
  }

  const body = {
    model: model.model_id,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0,
    max_tokens: 2048,
  };

  const resp = await fetch(`${provider.base_url}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    throw new Error(`LLM API error: ${resp.status} ${await resp.text()}`);
  }

  const data = await resp.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices?.[0]?.message?.content || "";
}

function parseAIResponse(raw: string): AIReviewResult | null {
  try {
    // Strip markdown fences if present
    const cleaned = raw.replace(/^```(?:json)?\n?/gm, "").replace(/\n?```$/gm, "").trim();
    const parsed = JSON.parse(cleaned);
    if (parsed.risk_level && Array.isArray(parsed.findings) && parsed.summary) {
      return parsed as AIReviewResult;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Run AI semantic security analysis on skill scripts.
 * Returns enhanced assessment merging static + AI findings, or null if AI is unavailable.
 */
export async function evaluateScriptsAI(
  scripts: { name: string; content: string }[],
  staticFindings: SecurityFinding[],
): Promise<SecurityAssessment | null> {
  try {
    const config = await getDefaultProvider();
    if (!config) {
      console.log("[ai-security-reviewer] No model provider configured, skipping AI review");
      return null;
    }

    const userPrompt = buildUserPrompt(scripts, staticFindings);
    const raw = await callLLM(config.provider, config.model, SYSTEM_PROMPT, userPrompt);
    const result = parseAIResponse(raw);

    if (!result) {
      console.warn("[ai-security-reviewer] Failed to parse AI response:", raw.slice(0, 200));
      return null;
    }

    // Convert AI findings to SecurityFinding format
    const aiFindings: SecurityFinding[] = result.findings.map(f => ({
      category: f.category || "ai_review",
      severity: (["critical", "high", "medium", "low"].includes(f.severity) ? f.severity : "medium") as SecurityFinding["severity"],
      pattern: f.description,
      match: "[AI analysis]",
      scriptName: f.scriptName || "unknown",
      line: f.line || 0,
    }));

    // Merge: static findings + AI findings, deduplicated by category+scriptName+line
    const mergedFindings = [...staticFindings];
    const seen = new Set(staticFindings.map(f => `${f.category}:${f.scriptName}:${f.line}`));
    for (const af of aiFindings) {
      const key = `${af.category}:${af.scriptName}:${af.line}`;
      if (!seen.has(key)) {
        mergedFindings.push(af);
        seen.add(key);
      }
    }

    // Use the higher risk level between static and AI
    const riskLevels = ["safe", "low", "medium", "high", "critical"] as const;
    const staticRiskIdx = riskLevels.indexOf(
      staticFindings.some(f => f.severity === "critical") ? "critical" :
      staticFindings.some(f => f.severity === "high") ? "high" :
      staticFindings.some(f => f.severity === "medium") ? "medium" :
      staticFindings.some(f => f.severity === "low") ? "low" : "safe",
    );
    const aiRiskIdx = riskLevels.indexOf(
      (result.risk_level as typeof riskLevels[number]) || "safe",
    );
    const finalRisk = riskLevels[Math.max(staticRiskIdx, aiRiskIdx)];

    return {
      risk_level: finalRisk,
      findings: mergedFindings,
      summary: `Static: ${staticFindings.length} finding(s). AI: ${result.summary}`,
    };
  } catch (err) {
    console.warn("[ai-security-reviewer] AI review failed, using static-only:", (err as Error).message);
    return null;
  }
}
