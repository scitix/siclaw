// Real-model acceptance using separately configured instance keys.
// Never log keys. The optional output directory contains private model results.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { reviewCases } from "../../examples/support-review/acceptance-cases.js";
import { runSupport, runTicketReview } from "../../examples/support-review/run-client.js";

const baseUrl = process.env.SICLAW_BASE_URL;
const reviewKey = process.env.SICLAW_REVIEW_API_KEY;
const supportKey = process.env.SICLAW_SUPPORT_API_KEY;
if (!baseUrl || !reviewKey || !supportKey) throw new Error("Set SICLAW_BASE_URL, SICLAW_REVIEW_API_KEY and SICLAW_SUPPORT_API_KEY");
if (reviewKey === supportKey) throw new Error("Support and review require distinct instance keys");
const output = process.env.SICLAW_ACCEPTANCE_DIR && resolve(process.env.SICLAW_ACCEPTANCE_DIR);
if (output) await mkdir(output, { recursive: true, mode: 0o700 });
let failures = 0;

async function record(id: string, operation: () => Promise<unknown>) {
  try {
    const value = await operation();
    if (output) await writeFile(resolve(output, `${id}.json`), JSON.stringify(value, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ case: id, passed: true }));
  } catch (error) {
    failures++;
    // Schema diagnostics and provider errors can contain supplied material.
    console.log(JSON.stringify({ case: id, passed: false, error: error instanceof Error ? error.name : "Error" }));
    if (output) await writeFile(resolve(output, `${id}.error.txt`), error instanceof Error ? error.message : "Unknown error", { mode: 0o600 });
  }
}

for (const scenario of reviewCases) {
  await record(scenario.id, async () => {
    const result = await runTicketReview({ baseUrl, apiKey: reviewKey, signal: AbortSignal.timeout(180_000) }, scenario.context);
    for (const [field, expected] of Object.entries(scenario.expected)) {
      if (result.result[field as keyof typeof scenario.expected] !== expected) throw new Error(`Unexpected ${field}`);
    }
    return { input: scenario.context, expected: scenario.expected, received: result };
  });
}

await record("support-answer", async () => {
  const received = await runSupport({ baseUrl, apiKey: supportKey, signal: AbortSignal.timeout(180_000) },
    "Use this supplied service note: Example Product permits three active instances per project; projects have independent quotas. Does the three-instance allowance apply to each project? I am only asking for an explanation, not human help.");
  if (received.result.label || received.result.info.missing_fields.length) throw new Error("Answerable consultation was treated as handoff or blocking clarification");
  return received;
});

let supportSession: string | undefined;
await record("support-handoff", async () => {
  const received = await runSupport({ baseUrl, apiKey: supportKey, signal: AbortSignal.timeout(180_000) },
    "I need human help. You already asked me to clarify this issue once. I cannot explain it further; please do not ask again. Preserve the unknown details and prepare the handoff information.");
  if (!received.result.label || received.result.info.missing_fields.length) throw new Error("Handoff was not prepared");
  supportSession = received.sessionId;
  return received;
});

await record("cross-agent-session", async () => {
  if (!supportSession) throw new Error("Support session prerequisite did not pass");
  try {
    await runTicketReview({ baseUrl, apiKey: reviewKey, sessionId: supportSession, signal: AbortSignal.timeout(30_000) }, reviewCases[0].context);
  } catch (error) {
    if (error instanceof Error && error.message === "RUN_SESSION_NOT_FOUND") return { rejected: true };
    throw error;
  }
  throw new Error("Review accepted the support session");
});

await record("concurrent-tickets", async () => {
  const received = await Promise.all(reviewCases.slice(0, 2).map(scenario => runTicketReview({ baseUrl, apiKey: reviewKey, signal: AbortSignal.timeout(180_000) }, scenario.context)));
  if (received[0].sessionId === received[1].sessionId) throw new Error("Different tickets shared a session");
  return received;
});

console.log(JSON.stringify({ failures, verification: "Automated shape, classification and reference checks; factual prose still requires review" }));
if (failures) process.exitCode = 1;
