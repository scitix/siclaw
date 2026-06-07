// Verifies job_stop on a background host_exec actually KILLS the remote process group
// (not just closes the channel). Launches `sleep 240; echo SENTINEL` in the background,
// stops it, then uses a FOREGROUND host_exec to count surviving processes carrying the
// sentinel. 0 survivors = the remote group was reaped.
import { setTimeout as wait } from "node:timers/promises";
const b = (process.env.SICLAW_PORTAL_URL ?? "http://127.0.0.1:18080") + "/api/v1";
const HOST = process.env.HOST_NAME ?? "172.16.73.22";
const SENT = "SENTINEL_" + Math.floor(Date.now() % 1e7);
const pj = (v) => { if (!v) return {}; if (typeof v === "object") return v; try { return JSON.parse(v) ?? {}; } catch { return {}; } };
async function jf(u, o = {}) { const r = await fetch(u, { ...o, headers: { "Content-Type": "application/json", ...(o.headers ?? {}) } }); const t = await r.text(); let x; try { x = t ? JSON.parse(t) : {}; } catch { x = t; } if (!r.ok) throw new Error(`${u} ${r.status}: ${t.slice(0,200)}`); return x; }
const token = (await jf(`${b}/auth/login`, { method: "POST", body: JSON.stringify({ username: "admin", password: "admin" }) })).token;
const auth = { Authorization: `Bearer ${token}` };
const agent = (await jf(`${b}/agents`, { headers: auth })).data[0];
const s = await jf(`${b}/siclaw/agents/${agent.id}/chat/sessions`, { method: "POST", headers: auth, body: JSON.stringify({ title: "host stop orphan " + Date.now() }) });
console.log("session", s.id, "sentinel", SENT);
const send = async (text) => { const r = await fetch(`${b}/siclaw/agents/${agent.id}/chat/send`, { method: "POST", headers: { "Content-Type": "application/json", ...auth }, body: JSON.stringify({ text, session_id: s.id }) }); const rd = r.body.getReader(); while (true) { const { done } = await rd.read(); if (done) break; } };

await send(`Use the host_exec tool with run_in_background set to true on host "${HOST}" to run this EXACT command: sleep 240; echo ${SENT} . After launching, END YOUR TURN immediately — do not call any other tool.`);
await wait(7000); // let the remote process group start + write its pgid file
await send(`Stop the background host command you just launched, using the job_stop tool with the job_id it returned. Then END YOUR TURN.`);
await wait(12000); // kill propagation: fresh ssh dial + kill -TERM/-KILL + up to 3s retry
await send(`Now use host_exec with run_in_background OMITTED (foreground) on host "${HOST}" to run this EXACT command (a pipeline, no other text): ps -ef | grep ${SENT} | grep -v grep | wc -l . Report ONLY the number it prints.`);
await wait(3000);

const rows = (await jf(`${b}/siclaw/agents/${agent.id}/chat/sessions/${s.id}/messages?page=1&page_size=100`, { headers: auth })).data ?? [];
// Find the foreground host_exec tool result carrying ORPHANS=
let orphans = null;
for (const m of rows) {
  if (m.role === "tool" && m.tool_name === "host_exec") {
    const txt = (m.content || "").trim();
    if (/^\d+$/.test(txt)) orphans = Number(txt); // the `wc -l` survivor count
  }
}
// Fallback: assistant prose reporting a lone number.
if (orphans === null) {
  for (const m of rows) { const mm = /\bsurvivors?\b[^0-9]*(\d+)|^\s*(\d+)\s*$/m.exec(m.content || ""); if (mm) { orphans = Number(mm[1] ?? mm[2]); break; } }
}
const stopEvt = rows.find((m) => pj(m.metadata).kind === "exec_job_event" && String(pj(m.metadata).job_id || "").includes("host_exec"));
console.log(JSON.stringify({ orphans, stopStatus: pj(stopEvt?.metadata).status ?? null }, null, 2));
if (orphans === null) { console.log("RESULT: INCONCLUSIVE — could not read ORPHANS= (model may not have run the check)"); process.exit(2); }
if (orphans === 0) { console.log("RESULT: PASS — remote process group reaped by job_stop (0 survivors)"); process.exit(0); }
console.log(`RESULT: FAIL — ${orphans} remote process(es) survived job_stop (orphaned until timeout)`); process.exit(1);
