// Verifies job_stop on a background pod_script reaps the in-pod process tree (not just the
// local kubectl). Launches exec-smoke `sleep 240` in a pod, stops it, then uses a foreground
// pod_exec to count surviving processes carrying the sentinel. 0 = the in-pod session reaped.
import { setTimeout as wait } from "node:timers/promises";
const b = (process.env.SICLAW_PORTAL_URL ?? "http://127.0.0.1:18080") + "/api/v1";
const POD = process.env.POD_NAME ?? "managed-target";
const NS = process.env.POD_NS ?? "siclaw-inner";
const SENT = "PODSENT_" + Math.floor(Date.now() % 1e7);
const pj = (v) => { if (!v) return {}; if (typeof v === "object") return v; try { return JSON.parse(v) ?? {}; } catch { return {}; } };
async function jf(u, o = {}) { const r = await fetch(u, { ...o, headers: { "Content-Type": "application/json", ...(o.headers ?? {}) } }); const t = await r.text(); let x; try { x = t ? JSON.parse(t) : {}; } catch { x = t; } if (!r.ok) throw new Error(`${u} ${r.status}: ${t.slice(0,200)}`); return x; }
const token = (await jf(`${b}/auth/login`, { method: "POST", body: JSON.stringify({ username: "admin", password: "admin" }) })).token;
const auth = { Authorization: `Bearer ${token}` };
const agent = (await jf(`${b}/agents`, { headers: auth })).data[0];
const s = await jf(`${b}/siclaw/agents/${agent.id}/chat/sessions`, { method: "POST", headers: auth, body: JSON.stringify({ title: "pod stop orphan " + Date.now() }) });
console.log("session", s.id, "sentinel", SENT);
const send = async (text) => { const r = await fetch(`${b}/siclaw/agents/${agent.id}/chat/send`, { method: "POST", headers: { "Content-Type": "application/json", ...auth }, body: JSON.stringify({ text, session_id: s.id }) }); const rd = r.body.getReader(); while (true) { const { done } = await rd.read(); if (done) break; } };

await send(`Use the pod_script tool with run_in_background set to true to run skill "exec-smoke" script "sleep-echo.sh" with args "--seconds 240 --marker ${SENT}" inside pod "${POD}" in namespace "${NS}". After launching, END YOUR TURN immediately.`);
await wait(8000);
await send(`Stop the background pod_script job you just launched, using the job_stop tool with its job_id. Then END YOUR TURN.`);
await wait(12000);
await send(`Now use pod_exec (foreground) inside pod "${POD}" namespace "${NS}" to run this EXACT single command (no pipes): pgrep -c sleep . Report ONLY the integer it prints (0 if none).`);
await wait(3000);

const rows = (await jf(`${b}/siclaw/agents/${agent.id}/chat/sessions/${s.id}/messages?page=1&page_size=100`, { headers: auth })).data ?? [];
let orphans = null;
for (const m of rows) {
  if (m.role === "tool" && m.tool_name === "pod_exec") { const mm = /(?:^|\D)(\d+)/.exec((m.content || "").trim()); if (mm) orphans = Number(mm[1]); }
}
console.log(JSON.stringify({ orphans, stopStatus: pj(rows.find((m) => pj(m.metadata).kind === "exec_job_event" && String(pj(m.metadata).job_id||"").includes("pod_script"))?.metadata).status ?? null }, null, 2));
if (orphans === null) { console.log("RESULT: INCONCLUSIVE — no count read"); process.exit(2); }
if (orphans === 0) { console.log("RESULT: PASS — in-pod session reaped by job_stop (0 survivors)"); process.exit(0); }
console.log(`RESULT: FAIL — ${orphans} in-pod process(es) survived job_stop`); process.exit(1);
