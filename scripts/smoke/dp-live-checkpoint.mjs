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
  body: JSON.stringify({ title: `DP live checkpoint smoke ${Date.now()}` }),
});

const prompt = `[Deep Investigation]
We are validating Siclaw DP mode UX. Work like a real DP session for this product question:
"DP removed the state machine and per-turn three buttons. We need the agent to stay autonomous, form H1/H2/H3 only when useful, and expose checkpoint controls only at meaningful hypothesis forks."

Do not call external tools. Analyze the requirement itself, propose candidate hypotheses, and if you reach a meaningful hypothesis fork, emit the hidden checkpoint comments exactly as instructed by DP mode.`;

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
let assistant = "";
const events = [];

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
    if (!data) continue;
    events.push(ev);
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      parsed = data;
    }
    if (ev === "chat.text") assistant += parsed.text ?? "";
    if (ev === "chat.event") {
      if (parsed.type === "agent_message") assistant += parsed.text ?? "";
      const assistantEvent = parsed.assistantMessageEvent;
      if (assistantEvent?.type === "text_delta") assistant += assistantEvent.delta ?? "";
    }
  }
}

const messages = await jsonFetch(
  `${apiBase}/siclaw/agents/${agent.id}/chat/sessions/${session.id}/messages?page=1&page_size=20`,
  { headers: auth },
);
const storedAssistant = [...(messages.data ?? [])].reverse().find((m) => m.role === "assistant")?.content;
const text = storedAssistant || assistant;

const result = {
  sessionId: session.id,
  eventTypes: [...new Set(events)],
  hasHypothesisMarker: /<!--\s*hypothesis-checkpoint\s*-->/i.test(text),
  hasSuggestedReplies: /<!--\s*suggested-replies:/i.test(text),
  hasVisibleProtocolChoices: /^\s*[ABC][.)|]/m.test(text),
  assistantPreview: text.slice(0, 1800),
};
console.log(JSON.stringify(result, null, 2));

if (!result.hasHypothesisMarker) throw new Error("Missing hypothesis checkpoint marker.");
if (!result.hasSuggestedReplies) throw new Error("Missing suggested replies marker.");
if (result.hasVisibleProtocolChoices) throw new Error("Visible A/B/C protocol choices leaked into assistant output.");
