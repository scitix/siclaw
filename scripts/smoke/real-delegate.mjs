const baseUrl = process.env.SICLAW_PORTAL_URL ?? "http://127.0.0.1:3000";
const apiBase = `${baseUrl}/api/v1`;

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
  body: JSON.stringify({ title: `Real delegate smoke ${Date.now()}` }),
});

const prompt =
  '[Deep Investigation]\nPlease test the real delegation tool. Call delegate_to_agent exactly once with agent_id "self", scope "Summarize in one sentence why hidden prompt pills are better than raw A/B/C checkpoint replies", and context_summary "We are validating Siclaw DP mode UX." After the tool returns, briefly summarize the delegated result.';

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

const messages = await jsonFetch(
  `${apiBase}/siclaw/agents/${agent.id}/chat/sessions/${session.id}/messages?page=1&page_size=50`,
  { headers: auth },
);
const result = {
  sessionId: session.id,
  events,
  errors,
  toolStarts: toolStarts.map((t) => ({ name: t.toolName, args: t.args })),
  toolEnds: toolEnds.map((t) => ({
    name: t.toolName,
    isError: t.isError,
    resultText: JSON.stringify(t.result).slice(0, 500),
  })),
  assistantPreview: text.slice(0, 800),
  stored: messages.data?.map((m) => ({
    role: m.role,
    tool_name: m.tool_name,
    outcome: m.outcome,
    content: (m.content ?? "").slice(0, 200),
  })),
};
console.log(JSON.stringify(result, null, 2));

if (!toolStarts.some((t) => t.toolName === "delegate_to_agent")) {
  throw new Error("delegate_to_agent was not called.");
}
if (!toolEnds.some((t) => t.toolName === "delegate_to_agent" && !t.isError)) {
  throw new Error("delegate_to_agent did not finish successfully.");
}
