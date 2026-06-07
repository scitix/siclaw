// Recon: what does a BACKGROUND spawn_subagent produce in the DB? Dump the message rows
// (tool_name / role / metadata.kind / status fields / content head) so we can see whether the
// sub-agent completes + notifies the parent, and what event (if any) should update the card.
const apiBase = (process.env.SICLAW_PORTAL_URL ?? "http://127.0.0.1:18080") + "/api/v1";
async function jf(u, o = {}) { const r = await fetch(u, { ...o, headers: { "Content-Type": "application/json", ...(o.headers ?? {}) } }); const t = await r.text(); let b; try { b = t ? JSON.parse(t) : {}; } catch { b = t; } if (!r.ok) throw new Error(`${u} ${r.status}: ${t.slice(0,200)}`); return b; }
const pj = (v) => { if (!v) return {}; if (typeof v === "object") return v; try { return JSON.parse(v) ?? {}; } catch { return {}; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const token = (await jf(`${apiBase}/auth/login`, { method: "POST", body: JSON.stringify({ username: "admin", password: "admin" }) })).token;
const auth = { Authorization: `Bearer ${token}` };
const agent = (await jf(`${apiBase}/agents`, { headers: auth })).data?.[0];
const session = await jf(`${apiBase}/siclaw/agents/${agent.id}/chat/sessions`, { method: "POST", headers: auth, body: JSON.stringify({ title: `bg subagent recon ${Date.now()}` }) });
console.log("session", session.id);
const prompt = `Use spawn_subagent with run_in_background set to true to dispatch ONE sub-agent whose scope is: "In one sentence, say why notify beats polling for background tasks." After launching, immediately end your turn. When the sub-agent completes and notifies you, summarize its conclusion in one line.`;
const res = await fetch(`${apiBase}/siclaw/agents/${agent.id}/chat/send`, { method: "POST", headers: { "Content-Type": "application/json", ...auth }, body: JSON.stringify({ text: prompt, session_id: session.id }) });
{ const rd = res.body.getReader(); while (true) { const { done } = await rd.read(); if (done) break; } }
for (let i = 0; i < 50; i++) {
  await wait(3000);
  const rows = (await jf(`${apiBase}/siclaw/agents/${agent.id}/chat/sessions/${session.id}/messages?page=1&page_size=100`, { headers: auth })).data ?? [];
  const dump = rows.map((m) => { const md = pj(m.metadata); return { role: m.role, tool: m.tool_name ?? null, kind: md.kind ?? null, status: m.outcome ?? md.status ?? md.event_type ?? null, head: (typeof m.content === "string" ? m.content : JSON.stringify(m.content) ?? "").slice(0, 90) }; });
  console.log(`--- poll ${i} (${rows.length} rows) ---`);
  console.log(JSON.stringify(dump, null, 1));
  const parentFollowup = rows.some((m) => m.role === "assistant" && /notify|poll|background|轮询|通知/.test(m.content || ""));
  const subagentDone = rows.some((m) => (m.tool_name === "spawn_subagent") && (pj(m.metadata).status === "done" || m.outcome === "done"));
  if (parentFollowup && rows.length > 3) { console.log("STOP: parent follow-up present"); break; }
}
