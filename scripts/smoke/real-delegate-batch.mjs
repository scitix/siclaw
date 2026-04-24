const baseUrl = process.env.SICLAW_PORTAL_URL ?? "http://127.0.0.1:3000";
const apiBase = `${baseUrl}/api/v1`;
const timeoutMs = Number(process.env.SICLAW_DELEGATE_BATCH_TIMEOUT_MS ?? 12 * 60_000);

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
  body: JSON.stringify({ title: `Real delegate batch smoke ${Date.now()}` }),
});

const prompt = `[Deep Investigation]
Please validate Siclaw batch delegation.

Call delegate_to_agents exactly once with this exact input:
{
  "tasks": [
    {
      "agent_id": "self",
      "scope": "Explain in one concise paragraph why grouping two independent sub-agent checks into one batch call improves Deep Investigation UX.",
      "context_summary": "We are validating Siclaw's DP mode. Keep the delegated result short and evidence-capsule friendly."
    },
    {
      "agent_id": "self",
      "scope": "Explain in one concise paragraph the main risk of sending too much sub-agent detail back into the parent context.",
      "context_summary": "We are validating Siclaw's DP mode. Keep the delegated result short and evidence-capsule friendly."
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
let text = "";
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
      if (parsed.type === "agent_message") text += parsed.text ?? "";
      const assistantEvent = parsed.assistantMessageEvent;
      if (assistantEvent?.type === "text_delta") text += assistantEvent.delta ?? "";
    }
  }
}

const batchEnds = toolEnds.filter((t) => t.toolName === "delegate_to_agents");
const singleStarts = toolStarts.filter((t) => t.toolName === "delegate_to_agent");
const startedAt = Date.now();
let messages;
let storedBatchRows = [];
let contentJson = {};
let delegationEvents = [];
let assistantAfterEvent = false;
while (Date.now() - startedAt < timeoutMs) {
  messages = await jsonFetch(
    `${apiBase}/siclaw/agents/${agent.id}/chat/sessions/${session.id}/messages?page=1&page_size=80`,
    { headers: auth },
  );
  storedBatchRows = (messages.data ?? []).filter((m) => m.tool_name === "delegate_to_agents");
  contentJson = {};
  try {
    contentJson = JSON.parse(storedBatchRows[0]?.content ?? "{}");
  } catch {}
  delegationEvents = (messages.data ?? []).filter((m) => parseMaybeJson(m.metadata).kind === "delegation_event");
  const eventIndex = (messages.data ?? []).findIndex((m) => parseMaybeJson(m.metadata).kind === "delegation_event");
  assistantAfterEvent = eventIndex >= 0 && (messages.data ?? []).slice(eventIndex + 1).some((m) => m.role === "assistant");
  if (contentJson.status && contentJson.status !== "running" && delegationEvents.length > 0 && assistantAfterEvent) break;
  await sleep(3000);
}
const result = {
  sessionId: session.id,
  events,
  errors,
  toolStarts: toolStarts.map((t) => ({ name: t.toolName, args: t.args })),
  toolEnds: toolEnds.map((t) => ({
    name: t.toolName,
    isError: t.isError,
    resultText: JSON.stringify(t.result).slice(0, 800),
  })),
  assistantPreview: text.slice(0, 800),
  delegationEvents: delegationEvents.length,
  assistantAfterEvent,
  stored: messages.data?.map((m) => ({
    role: m.role,
    tool_name: m.tool_name,
    outcome: m.outcome,
    content: (m.content ?? "").slice(0, 240),
  })),
};
console.log(JSON.stringify(result, null, 2));

if (!toolStarts.some((t) => t.toolName === "delegate_to_agents")) {
  throw new Error("delegate_to_agents was not called.");
}
if (singleStarts.length > 0) {
  throw new Error("delegate_to_agent was called; batch smoke expected only delegate_to_agents.");
}
if (!batchEnds.some((t) => !t.isError)) {
  throw new Error("delegate_to_agents did not return an initial running result.");
}
if (storedBatchRows.length !== 1) {
  throw new Error(`Expected one persisted delegate_to_agents row, got ${storedBatchRows.length}.`);
}

const contentText = storedBatchRows[0]?.content ?? "";
if (!contentJson.status || contentJson.status === "running") {
  throw new Error(`delegate_to_agents did not complete within ${timeoutMs}ms.`);
}
if (!Array.isArray(contentJson.tasks) || contentJson.tasks.length !== 2) {
  throw new Error(`Persisted batch result did not contain two tasks: ${contentText.slice(0, 500)}`);
}
if (delegationEvents.length === 0) {
  throw new Error("Expected a hidden delegation_event row in the parent session.");
}
if (!assistantAfterEvent) {
  throw new Error("Expected parent assistant synthesis after delegation_event notification.");
}
