// Replay the same cases against a configured Portal agent with a REAL model.
// Bind planning-fixture.mjs as an MCP and skillFixture as a Skill first.
// Required: SICLAW_PORTAL_URL, SICLAW_AGENT_ID, SICLAW_TOKEN_FILE (raw bearer token).
// Optional: SICLAW_REPLAY_LABEL, SICLAW_REPLAY_DIR, SICLAW_REPLAY_CASES (comma-separated),
// SICLAW_REPLAY_REPEAT (default 1), SICLAW_REPLAY_EXPECT_VARIANT (baseline/candidate).
// Artifacts contain full prompts/results; keep private.
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { planningCases } from "./planning-fixture.mjs";

const base = process.env.SICLAW_PORTAL_URL?.replace(/\/$/, "");
const agentId = process.env.SICLAW_AGENT_ID;
const tokenPath = process.env.SICLAW_TOKEN_FILE;
if (!base || !agentId || !tokenPath) throw new Error("Set SICLAW_PORTAL_URL, SICLAW_AGENT_ID and SICLAW_TOKEN_FILE");
const token = (await readFile(tokenPath, "utf8")).trim();
const label = process.env.SICLAW_REPLAY_LABEL ?? "candidate";
if (!/^[a-zA-Z0-9_-]+$/.test(label)) throw new Error("Use a simple filename-safe replay label");
const expectedVariant = process.env.SICLAW_REPLAY_EXPECT_VARIANT;
if (expectedVariant && !["baseline", "candidate"].includes(expectedVariant)) {
  throw new Error("Expected variant must be baseline or candidate");
}
const out = process.env.SICLAW_REPLAY_DIR
  ? path.resolve(process.env.SICLAW_REPLAY_DIR)
  : await mkdtemp(path.join(tmpdir(), "siclaw-planning-replay-"));
await mkdir(out, { recursive: true, mode: 0o700 });
console.log(JSON.stringify({ artifactDirectory: out }));
const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const repeat = Number(process.env.SICLAW_REPLAY_REPEAT ?? 1);
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10) throw new Error("Repeat must be between 1 and 10");
const selection = process.env.SICLAW_REPLAY_CASES?.split(",");
const cases = planningCases.filter((c) => !selection || selection.includes(c.id));
if (!cases.length || selection?.some((id) => !planningCases.some((c) => c.id === id))) throw new Error("Unknown case selection");

async function jsonRequest(route, method = "GET", body) {
  const response = await fetch(`${base}/api/v1${route}`, {
    method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status}`);
  return response.json();
}

function parseFrame(frame) {
  let event = "message";
  const data = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  const raw = data.join("\n");
  try { return { event, data: JSON.parse(raw) }; }
  catch { return { event, data: raw }; }
}

const summaries = [];
replays: for (let run = 1; run <= repeat; run++) {
  for (const scenario of cases) {
    const key = `${label}-${scenario.id}-${run}`;
    const session = await jsonRequest(`/siclaw/agents/${agentId}/chat/sessions`, "POST", { title: `Planning replay ${key}` });
    const started = Date.now();
    const events = [];
    let failure;
    try {
      const response = await fetch(`${base}/api/v1/siclaw/agents/${agentId}/chat/send`, {
        method: "POST", headers: auth, body: JSON.stringify({ text: scenario.prompt, session_id: session.id }),
        signal: AbortSignal.timeout(10 * 60_000),
      });
      if (!response.ok) throw new Error(`Chat send: HTTP ${response.status}`);
      let buffer = "";
      const decoder = new TextDecoder();
      const accept = (frame) => {
        const parsed = parseFrame(frame);
        if (parsed) events.push({ ms: Date.now() - started, ...parsed });
      };
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
        let split;
        while ((split = buffer.indexOf("\n\n")) >= 0) {
          accept(buffer.slice(0, split));
          buffer = buffer.slice(split + 2);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) accept(buffer);
      const lastAssistantIndex = events.findLastIndex((e) => e.data?.type === "message_end"
        && e.data.message?.role === "assistant");
      const lastAssistant = events[lastAssistantIndex]?.data.message;
      const lastStreamErrorIndex = events.findLastIndex((e) => e.event === "error");
      // Only a later completed response can recover an earlier SSE error.
      const streamError = lastAssistant?.stopReason === "error"
        || (lastStreamErrorIndex >= 0
          && (lastStreamErrorIndex > lastAssistantIndex || lastAssistant?.stopReason !== "stop"));
      if (streamError) failure = "The chat stream ended with an execution/model error; inspect the trace";
      else if (!events.some((e) => e.event === "done")) failure = "Chat stream ended without its terminal event";
      else if (lastAssistant?.stopReason !== "stop"
        || !lastAssistant.content?.some((part) => part.type === "text" && part.text?.trim())) {
        failure = "Chat stream ended without a completed text response; inspect the trace";
      }
    } catch (error) {
      failure = error.message;
    }
    const artifact = { label, scenario: scenario.id, run, agentId, sessionId: session.id, prompt: scenario.prompt, elapsedMs: Date.now() - started, failure, events };
    // Save the trace even if follow-up inspection fails or the model never finishes.
    await writeFile(path.join(out, `${key}.json`), JSON.stringify(artifact, null, 2), { mode: 0o600 });
    for (const [field, route] of [
      ["messages", `/siclaw/agents/${agentId}/chat/sessions/${session.id}/messages?page=1&page_size=200`],
      ["inspection", `/agents/${agentId}/prompt-inspection?session_id=${session.id}`],
    ]) {
      try { artifact[field] = await jsonRequest(route); }
      catch (error) { artifact[`${field}Error`] = error.message; }
    }
    if (expectedVariant) {
      const inspection = artifact.inspection?.inspection;
      const prompt = inspection?.prompt?.text ?? "";
      const create = inspection?.tools?.find((t) => t.name === "task_create")?.description ?? "";
      const update = inspection?.tools?.find((t) => t.name === "task_update")?.description ?? "";
      const actualVariant = prompt.includes("## Planning") && create.includes("Ground the plan")
        && update.includes("Update from observed evidence") ? "candidate"
        : prompt.includes("FIRST move") && !create.includes("Ground the plan") ? "baseline" : "unknown";
      artifact.variantCheck = { expected: expectedVariant, actual: actualVariant };
      if (actualVariant !== expectedVariant) {
        artifact.variantCheck.failure = `Resident instructions are ${actualVariant}; expected ${expectedVariant}. Check deployed images before continuing.`;
        failure ??= artifact.variantCheck.failure;
        artifact.failure = failure;
      }
    }
    await writeFile(path.join(out, `${key}.json`), JSON.stringify(artifact, null, 2), { mode: 0o600 });
    const calls = events.filter((e) => e.event === "chat.event" && e.data?.type === "tool_execution_start").map((e) => ({ ms: e.ms, name: e.data.toolName, args: e.data.args }));
    const errors = events.filter((e) => e.event === "error" || e.data?.isError === true);
    const modelErrors = events.filter((e) => e.data?.type === "message_end"
      && e.data.message?.stopReason === "error").length;
    const summary = {
      key, sessionId: session.id, elapsedMs: artifact.elapsedMs, failure,
      calls: calls.map((c) => c.name), errors: errors.length, modelErrors,
      creates: calls.filter((c) => c.name === "task_create").map((c) => c.args),
      updates: calls.filter((c) => c.name === "task_update").map((c) => c.args),
    };
    summaries.push(summary);
    await writeFile(path.join(out, `${label}-summary.json`), JSON.stringify(summaries, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ key, sessionId: session.id, elapsedMs: artifact.elapsedMs, tools: calls.length, errors: errors.length, modelErrors, failure }));
    if (failure) {
      process.exitCode = 1;
      break replays;
    }
  }
}
// This runner records evidence. It deliberately does not equate keyword presence
// with plan quality; review task edits, tool results, and final answers together.
