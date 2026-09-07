/** Live, synthetic-only check. No repository prompts, credentials or real tools enter model context.
 * SICLAW_TEST_MODEL_URL and SICLAW_TEST_MODEL select the user-authorized endpoint.
 * Read the API key from stdin (disable terminal echo) or SICLAW_TEST_API_KEY.
 * Run: node --import tsx scripts/smoke/conversation-progress.mts
 */
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { PiAgentBrain } from "../../src/core/brains/pi-agent-brain.js";
import { consumeAgentSse } from "../../src/gateway/sse-consumer.js";

const baseUrl = process.env.SICLAW_TEST_MODEL_URL;
assert(baseUrl, "Set SICLAW_TEST_MODEL_URL to the authorized API base URL");
let key = process.env.SICLAW_TEST_API_KEY;
if (!key) {
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) { key = line.trim(); rl.close(); break; }
}
assert(key, "API key required via stdin or SICLAW_TEST_API_KEY");
const reports = [];
const api = process.env.SICLAW_TEST_API ?? "openai-responses";
const thinkingLevel = process.env.SICLAW_TEST_THINKING ?? "high";
const configurations = [{ api, thinkingLevel }];
for (const { api, thinkingLevel } of configurations) {
  const mode = "native";
  let executions = 0;
  const domainTool = {
    name: "lookup_inventory", label: "Inventory", description: "Read an imaginary laboratory inventory. First look up the laboratory, then the returned location to get a count.",
    parameters: Type.Object({ name: Type.String() }, { additionalProperties: false }),
    execute: async (_id: string, args: unknown) => {
      assert(!("_siclaw_progress" in (args as object)), "Communication must not reach the domain executor");
      assert(++executions <= 3, "Unexpected tool loop");
      return { content: [{ type: "text" as const, text: JSON.stringify(executions === 1 ? { location: "room-demo", next: "Look up room-demo for the count" } : { count: 5 }) }] };
    },
  };
  const events: any[] = [];
  const queue: any[] = [];
  let settled = false;
  let wake: (() => void) | undefined;
  const relayed: any[] = [];
  const consumption = consumeAgentSse({
    client: { async *streamEvents() {
      while (!settled || queue.length) {
        if (queue.length) yield queue.shift();
        else await new Promise<void>(resolve => { wake = resolve; });
      }
    } } as any,
    sessionId: `public-test-${mode}`, userId: "synthetic", agentId: "inventory-test",
    onEvent: (e, _kind, extras) => relayed.push({ ...e, ...extras }),
  });
  const agent = new Agent({ getApiKey: () => key,
    initialState: {
      systemPrompt: "You are a helpful assistant. This is a fictional test inventory. Briefly explain what you will check in the user's language before tool batches. After results, connect the observed finding to the next check. Never invent evidence or expose private reasoning. Prefer ordinary assistant text alongside tool calls. Finish with one self-contained answer.",
      model: { id: process.env.SICLAW_TEST_MODEL ?? "gpt-5.6-sol", name: "Test model", api, provider: "test", baseUrl,
        reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096,
        compat: { supportsDeveloperRole: false, maxTokensField: "max_completion_tokens" } },
      tools: [domainTool], thinkingLevel: thinkingLevel as any,
    },
  });
  // Exercise the actual engine and brain event adapter. The only replaced
  // transport is persistence below: this script never connects to Portal/DB.
  const brain = new PiAgentBrain({ agent, subscribe: agent.subscribe.bind(agent) } as any, new Map([["lookup_inventory", "query"]]));
  brain.subscribe(e => {
    const event = structuredClone(e); events.push(event); queue.push(event);
    wake?.(); wake = undefined;
  });
  const deadline = setTimeout(() => agent.abort(), 90000);
  try { await agent.prompt("帮我查一下示例实验室的试管数量。"); }
  finally { clearTimeout(deadline); settled = true; wake?.(); }
  const result = await consumption;
  assert.equal(result.errorMessage, "");
  assert.equal(executions, 2, "Expected location then count");
  let hasProgress = false; let covered = 0; let batches = 0;
  for (const e of relayed) {
    if (e.type === "turn_start") hasProgress = false;
    if (e.type.startsWith("item/") && e.item?.text?.trim()) hasProgress = true;
    if (e.type === "tool_execution_start") { batches++; if (hasProgress) covered++; }
  }
  assert.equal(covered, batches, "Every tool batch needs readable progress before execution");
  assert.match(result.resultText, /5/);
  const completed = new Map(relayed.filter(e => e.type === "item/completed").map(e => [e.item.id, e.item]));
  const progress = [...completed.values()].filter(item => item.phase === "commentary").map(item => item.text);
  if (api === "openai-responses") {
    assert(progress.length > 0, "Responses must preserve native commentary phases");
    assert.equal([...completed.values()].filter(item => item.phase === "final_answer").length, 1, "Exactly one native final answer");
  }
  assert(!relayed.some(e => e.type === "progress_update"), "Tool progress fallback must not be used");
  reports.push({ api, thinkingLevel, mode, covered, batches, progress, final: result.resultText });
  if (process.env.SICLAW_TEST_TRACE_DIR) writeFileSync(`${process.env.SICLAW_TEST_TRACE_DIR}/narration-${api}-${mode}.json`, JSON.stringify(relayed, null, 2));
}
console.log(JSON.stringify({ passed: true, reports }, null, 2));
