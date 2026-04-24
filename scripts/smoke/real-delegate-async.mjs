const baseUrl = process.env.SICLAW_PORTAL_URL ?? "http://127.0.0.1:3000";
const apiBase = `${baseUrl}/api/v1`;
const timeoutMs = Number(process.env.SICLAW_ASYNC_DELEGATE_TIMEOUT_MS ?? 12 * 60_000);
const removedAsyncBatchTool = ["delegate_to_agents", "async"].join("_");

async function jsonFetch(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = text;
  }
  if (!res.ok) throw new Error(`${opts.method ?? "GET"} ${url} ${res.status}: ${text}`);
  return body;
}

function parseMaybeJson(value) {
  if (value && typeof value === "object") return value;
  if (!value || typeof value !== "string") return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const login = await jsonFetch(`${apiBase}/auth/login`, {
  method: "POST",
  body: JSON.stringify({
    username: process.env.SICLAW_SMOKE_USER ?? "admin",
    password: process.env.SICLAW_SMOKE_PASSWORD ?? "admin",
  }),
});
const token = login.token;
const auth = { Authorization: `Bearer ${token}` };

const agents = await jsonFetch(`${apiBase}/agents`, { headers: auth });
const agent = agents.data?.[0];
if (!agent) throw new Error("No agent is available for smoke testing.");

const session = await jsonFetch(`${apiBase}/siclaw/agents/${agent.id}/chat/sessions`, {
  method: "POST",
  headers: auth,
  body: JSON.stringify({ title: `Async delegate smoke ${Date.now()}` }),
});

const prompt = `[Deep Investigation]
Please validate Siclaw async batch delegation.

Call delegate_to_agents exactly once with this exact input:
{
  "tasks": [
    {
      "agent_id": "self",
      "scope": "Explain in one concise paragraph why async sub-agent notify is more reliable than making the parent model poll for child results.",
      "context_summary": "We are validating Siclaw's DP async notify path. Keep the delegated result short and evidence-capsule friendly."
    },
    {
      "agent_id": "self",
      "scope": "Explain in one concise paragraph what information should be shown in a compact delegated investigation batch card.",
      "context_summary": "We are validating Siclaw's DP async notify path. Keep the delegated result short and evidence-capsule friendly."
    }
  ]
}

Do not call delegate_to_agent. After calling delegate_to_agents, stop and wait for runtime notification.`;

console.log(JSON.stringify({ agent: agent.name, agentId: agent.id, sessionId: session.id }, null, 2));

const res = await fetch(`${apiBase}/siclaw/agents/${agent.id}/chat/send`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...auth },
  body: JSON.stringify({ text: prompt, session_id: session.id }),
});
if (!res.ok) throw new Error(`send failed ${res.status}: ${await res.text()}`);

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
const events = {};
const errors = [];
const toolStarts = [];
const toolEnds = [];

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const frames = buffer.split("\n\n");
  buffer = frames.pop() ?? "";
  for (const frame of frames) {
    if (!frame.trim()) continue;
    let ev = "message";
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event: ")) ev = line.slice(7);
      else if (line.startsWith("data: ")) data += line.slice(6);
    }
    events[ev] = (events[ev] ?? 0) + 1;
    let parsed = data;
    try {
      parsed = JSON.parse(data);
    } catch {}
    if (ev === "error") errors.push(parsed);
    if (ev === "chat.event") {
      if (parsed.type === "tool_execution_start") toolStarts.push(parsed);
      if (parsed.type === "tool_execution_end") toolEnds.push(parsed);
    }
  }
}

if (!toolStarts.some((t) => t.toolName === "delegate_to_agents")) {
  throw new Error("delegate_to_agents was not called.");
}
if (toolStarts.some((t) => t.toolName === "delegate_to_agent" || t.toolName === removedAsyncBatchTool)) {
  throw new Error("Smoke expected only delegate_to_agents.");
}
const batchEnd = toolEnds.find((t) => t.toolName === "delegate_to_agents");
if (!batchEnd || batchEnd.isError) {
  throw new Error("delegate_to_agents did not return an initial running result.");
}

const startedAt = Date.now();
let messages;
let storedBatchRow;
let asyncContent = {};
let delegationEvents = [];
let assistantAfterEvent = false;

while (Date.now() - startedAt < timeoutMs) {
  messages = await jsonFetch(
    `${apiBase}/siclaw/agents/${agent.id}/chat/sessions/${session.id}/messages?page=1&page_size=80`,
    { headers: auth },
  );
  const rows = messages.data ?? [];
  storedBatchRow = rows.find((m) => m.tool_name === "delegate_to_agents");
  asyncContent = parseMaybeJson(storedBatchRow?.content);
  delegationEvents = rows.filter((m) => parseMaybeJson(m.metadata).kind === "delegation_event");
  const eventIndex = rows.findIndex((m) => parseMaybeJson(m.metadata).kind === "delegation_event");
  assistantAfterEvent = eventIndex >= 0 && rows.slice(eventIndex + 1).some((m) => m.role === "assistant");
  if (asyncContent.status && asyncContent.status !== "running" && delegationEvents.length > 0 && assistantAfterEvent) break;
  await sleep(3000);
}

const result = {
  sessionId: session.id,
  events,
  errors,
  initialToolEnds: toolEnds.map((t) => ({
    name: t.toolName,
    isError: t.isError,
    resultText: JSON.stringify(t.result).slice(0, 800),
  })),
  storedBatchRow: storedBatchRow
    ? {
        outcome: storedBatchRow.outcome,
        content: (storedBatchRow.content ?? "").slice(0, 1200),
        metadata: JSON.stringify(storedBatchRow.metadata ?? {}).slice(0, 1200),
      }
    : null,
  delegationEvents: delegationEvents.length,
  assistantAfterEvent,
};
console.log(JSON.stringify(result, null, 2));

if (!storedBatchRow) {
  throw new Error("Expected one persisted delegate_to_agents row.");
}
if (!asyncContent.status || asyncContent.status === "running") {
  throw new Error(`Async delegation did not complete within ${timeoutMs}ms.`);
}
if (!Array.isArray(asyncContent.tasks) || asyncContent.tasks.length !== 2) {
  throw new Error(`Persisted async batch result did not contain two tasks: ${storedBatchRow.content?.slice(0, 500)}`);
}
if (delegationEvents.length === 0) {
  throw new Error("Expected a hidden delegation_event row in the parent session.");
}
if (!assistantAfterEvent) {
  throw new Error("Expected parent assistant synthesis after delegation_event notification.");
}
