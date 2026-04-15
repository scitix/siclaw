/**
 * Evaluator — scores agent diagnostic results against expected answers using LLM
 */

import type { AgentBoxClient } from "../agentbox/client.js";
import { consumeAgentSse, type OnEventCallback } from "../sse-consumer.js";

interface ScoreInput {
  faultType: string;
  expectedAnswer: string;
  diagnosticSteps: string[];
  agentResponse: string;
  agentCommands: string[];
  modelProvider?: string;
  modelId?: string;
  /** Optional callback to forward SSE events (for streaming to frontend) */
  onEvent?: OnEventCallback;
}

export interface ScoreResult {
  scoreCommands: number;
  scoreConclusion: number;
  scoreReasoning: string;
}

const SCORING_PROMPT = `You are an expert evaluator for a K8S SRE diagnostic agent benchmark.

Given the expected diagnosis and the agent's actual output, score the agent's performance.

## Fault Type
{faultType}

## Expected Diagnostic Steps (kubectl commands)
{expectedSteps}

## Expected Root Cause / Answer
{expectedAnswer}

## Agent's Proposed kubectl Commands / Diagnostic Path
{agentCommands}

## Agent's Response / Conclusion
{agentResponse}

## Scoring Criteria

1. **Diagnostic Path Score (1-5)**: Are the kubectl commands the agent proposed/used CORRECT for diagnosing this fault type? Judge the commands themselves (are they the right commands to run?), NOT whether the agent actually executed them.
   - 5: All necessary diagnostic commands are correct and sufficient, efficient investigation path
   - 4: Most key commands are correct, minor omissions
   - 3: Some relevant commands but missed important diagnostic steps
   - 2: Few relevant commands, mostly wrong approach
   - 1: Commands are irrelevant, wrong, or no diagnostic commands proposed at all

2. **Conclusion Score (1-5)**: Did the agent correctly identify the root cause?
   - 5: Perfect root cause identification with correct fix recommendation
   - 4: Correct root cause, minor inaccuracies in details or fix
   - 3: Partially correct, identified the area but missed specifics
   - 2: Vaguely related conclusion, significant gaps
   - 1: Wrong conclusion or no conclusion

Think step by step before giving scores. Then output VALID JSON:
{
  "scoreCommands": <1-5>,
  "scoreConclusion": <1-5>,
  "scoreReasoning": "<brief explanation of scores>"
}`;

export async function scoreCase(
  client: AgentBoxClient,
  input: ScoreInput,
): Promise<ScoreResult> {
  const prompt = SCORING_PROMPT
    .replace("{faultType}", input.faultType)
    .replace("{expectedSteps}", input.diagnosticSteps.join("\n") || "(none specified)")
    .replace("{expectedAnswer}", input.expectedAnswer || "(none specified)")
    .replace("{agentCommands}", input.agentCommands.join("\n") || "(no commands proposed)")
    .replace("{agentResponse}", input.agentResponse || "(no response)");

  const sessionId = `deveval-score-${Date.now()}`;

  const result = await client.prompt({
    sessionId,
    text: prompt,
    modelProvider: input.modelProvider,
    modelId: input.modelId,
  });

  // Collect the response via the shared SSE consumer, forwarding events if callback provided
  const sseResult = await consumeAgentSse({
    client,
    sessionId: result.sessionId,
    userId: "deveval-system",
    chatRepo: null,
    signal: AbortSignal.timeout(120_000),
    onEvent: input.onEvent,
  });

  const assistantText = sseResult.resultText || sseResult.taskReportText;
  if (!assistantText) {
    throw new Error("LLM returned empty response for scoring");
  }

  // Parse scores from response
  const jsonStr = extractJson(assistantText);
  const scores = JSON.parse(jsonStr);

  return {
    scoreCommands: clampScore(scores.scoreCommands),
    scoreConclusion: clampScore(scores.scoreConclusion),
    scoreReasoning: String(scores.scoreReasoning ?? ""),
  };
}

function clampScore(v: unknown): number {
  const n = Number(v);
  if (isNaN(n)) return 1;
  return Math.min(5, Math.max(1, Math.round(n)));
}

function extractJson(text: string): string {
  // 1) Prefer a fenced ```json code block — standard LLM output format
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    const inner = codeBlockMatch[1].trim();
    const balanced = findBalancedJsonObject(inner);
    if (balanced) return balanced;
  }

  // 2) Walk the text from the END looking for a balanced {...} object that
  //    contains a score field. Reasoning text often mentions jsonpath like
  //    `{.spec...}` which a naive /\{[\s\S]*\}/ would swallow.
  const balanced = findBalancedJsonObject(text);
  if (balanced) return balanced;

  throw new Error("Failed to extract JSON from LLM scoring response");
}

/**
 * Find the last balanced {...} block in `text` that contains "scoreCommands".
 * Walks right-to-left from each `}`, matching braces while respecting strings,
 * to reliably pull the scoring JSON out of chatty reasoning text.
 */
function findBalancedJsonObject(text: string): string | null {
  const endPositions: number[] = [];
  for (let i = 0; i < text.length; i++) if (text[i] === "}") endPositions.push(i);

  for (let k = endPositions.length - 1; k >= 0; k--) {
    const end = endPositions[k];
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = end; i >= 0; i--) {
      const ch = text[i];
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "}") depth++;
      else if (ch === "{") {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(i, end + 1);
          if (candidate.includes("scoreCommands")) return candidate;
          break; // this {...} doesn't contain the score — try next closing brace
        }
      }
    }
  }
  return null;
}
