// Behavioral smoke for the background spawn_subagent guidance fix. Reproduces the exact user
// prompt that previously made the model spawn a SECOND "Wait for notification" sub-agent instead
// of just ending its turn and reporting the answer. Asserts: (1) exactly one background
// spawn_subagent launch, (2) NO launch whose description is a "wait/poll/notify" placeholder,
// (3) the model eventually reports the correct sum (34) to the user.
import { setTimeout as wait } from "node:timers/promises";

const baseUrl = process.env.SICLAW_PORTAL_URL ?? "http://127.0.0.1:18080";
const apiBase = `${baseUrl}/api/v1`;
const PROMPT = process.env.PROMPT ?? "使用subagent后台计算一下1+2+3+8+9+11,告诉我结果";
const ANSWER = process.env.ANSWER ?? "34";

async function jf(u, o = {}) {
  const r = await fetch(u, { ...o, headers: { "Content-Type": "application/json", ...(o.headers ?? {}) } });
  const t = await r.text();
  let b; try { b = t ? JSON.parse(t) : {}; } catch { b = t; }
  if (!r.ok) throw new Error(`${u} ${r.status}: ${t.slice(0, 200)}`);
  return b;
}
const pj = (v) => { if (!v) return {}; if (typeof v === "object") return v; try { return JSON.parse(v) ?? {}; } catch { return {}; } };

const token = (await jf(`${apiBase}/auth/login`, { method: "POST", body: JSON.stringify({ username: "admin", password: "admin" }) })).token;
const auth = { Authorization: `Bearer ${token}` };
const agent = (await jf(`${apiBase}/agents`, { headers: auth })).data?.[0];
const session = await jf(`${apiBase}/siclaw/agents/${agent.id}/chat/sessions`, { method: "POST", headers: auth, body: JSON.stringify({ title: `bg subagent noloop ${Date.now()}` }) });
console.log("session", session.id);

// Drain the launch turn's SSE so the request completes.
const res = await fetch(`${apiBase}/siclaw/agents/${agent.id}/chat/send`, { method: "POST", headers: { "Content-Type": "application/json", ...auth }, body: JSON.stringify({ text: PROMPT, session_id: session.id }) });
{ const rd = res.body.getReader(); while (true) { const { done } = await rd.read(); if (done) break; } }

// Poll until the model reports the answer OR we time out (~90s). The completion notification
// fires a synthetic turn; the answer should appear there if the model behaves.
let rows = [];
let answered = false;
for (let i = 0; i < 30; i++) {
  rows = (await jf(`${apiBase}/siclaw/agents/${agent.id}/chat/sessions/${session.id}/messages?page=1&page_size=100`, { headers: auth })).data ?? [];
  answered = rows.some((m) => m.role === "assistant" && (m.content || "").includes(ANSWER));
  if (answered) break;
  await wait(3000);
}

const launches = rows
  .filter((m) => m.role === "tool" && m.tool_name === "spawn_subagent")
  .map((m) => ({ args: pj(m.tool_input), meta: pj(m.metadata) }));
const bgLaunches = launches.filter((l) => l.args.run_in_background === true);
const descs = launches.map((l) => String(l.args.description ?? ""));
const WAIT_RE = /(wait|poll|notif|sleep|standby|等待|轮询|通知|稍等|等候)/i;
const waitLike = descs.filter((d) => WAIT_RE.test(d));

const checks = {
  reportedAnswer: answered,
  exactlyOneBackgroundLaunch: bgLaunches.length === 1,
  noWaitPlaceholderSubagent: waitLike.length === 0,
};
console.log(JSON.stringify({ checks, launchDescriptions: descs, bgLaunchCount: bgLaunches.length }, null, 2));
const fail = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
if (fail.length) {
  console.log("RESULT: FAIL — " + fail.join(", "));
  console.log("--- assistant messages ---");
  for (const m of rows.filter((r) => r.role === "assistant")) console.log("•", (m.content || "").slice(0, 200));
  process.exit(1);
}
console.log("RESULT: PASS — one background sub-agent, no wait-placeholder sub-agent, answer reported");
