// Live smoke for background exec/script tools + completion-event handling.
// Usage: SICLAW_PORTAL_URL=... PROMPT="..." MARKER="SMOKE_DONE_x" node bg-exec.mjs
// Verifies: (1) the tool launched in background (task_id), (2) a hidden exec_job_event
// completion row is persisted (the box-fold signal), (3) the model produced a follow-up
// assistant turn AFTER the launch (the synthetic completion turn), (4) terminal status.
const baseUrl = process.env.SICLAW_PORTAL_URL ?? "http://127.0.0.1:18080";
const apiBase = `${baseUrl}/api/v1`;
const PROMPT = process.env.PROMPT;
const MARKER = process.env.MARKER ?? "SMOKE_DONE";
const TOOL = process.env.TOOL; // expected launch tool (e.g. node_script); verdict keys on this
const timeoutMs = Number(process.env.BG_TIMEOUT_MS ?? 180_000);

async function jf(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) } });
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
  if (!res.ok) throw new Error(`${opts.method ?? "GET"} ${url} ${res.status}: ${text.slice(0, 300)}`);
  return body;
}
const pj = (v) => { if (!v) return {}; if (typeof v === "object") return v; try { return JSON.parse(v) ?? {}; } catch { return {}; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const token = (await jf(`${apiBase}/auth/login`, { method: "POST", body: JSON.stringify({ username: process.env.SICLAW_SMOKE_USER ?? "admin", password: process.env.SICLAW_SMOKE_PASSWORD ?? "admin" }) })).token;
const auth = { Authorization: `Bearer ${token}` };
const agent = (await jf(`${apiBase}/agents`, { headers: auth })).data?.[0];
const session = await jf(`${apiBase}/siclaw/agents/${agent.id}/chat/sessions`, { method: "POST", headers: auth, body: JSON.stringify({ title: `bg smoke ${Date.now()}` }) });
console.log(JSON.stringify({ agent: agent.name, sessionId: session.id, marker: MARKER }));

// Send + drain the SSE stream (the launch turn).
const res = await fetch(`${apiBase}/siclaw/agents/${agent.id}/chat/send`, { method: "POST", headers: { "Content-Type": "application/json", ...auth }, body: JSON.stringify({ text: PROMPT, session_id: session.id }) });
if (!res.ok) throw new Error(`send ${res.status}: ${await res.text()}`);
const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
const toolEnds = []; const toolStarts = [];
while (true) {
  const { done, value } = await reader.read(); if (done) break;
  buf += dec.decode(value, { stream: true });
  const frames = buf.split("\n\n"); buf = frames.pop() ?? "";
  for (const f of frames) {
    let ev = "message", data = "";
    for (const line of f.split("\n")) { if (line.startsWith("event: ")) ev = line.slice(7); else if (line.startsWith("data: ")) data += line.slice(6); }
    if (ev === "chat.event") { let p = data; try { p = JSON.parse(data); } catch {} if (p.type === "tool_execution_start") toolStarts.push(p); if (p.type === "tool_execution_end") toolEnds.push(p); }
  }
}
const launch = toolEnds.find((t) => /host_exec|host_script|local_script|node_script|pod_script|bash/.test(t.toolName || ""));
const launchText = launch ? JSON.stringify(launch.result) : "";
const launchedInBg = /task_id|output_file|backgroundTaskId|background/i.test(launchText);
console.log(JSON.stringify({ launchTool: launch?.toolName, launchedInBg, launchHead: launchText.slice(0, 300) }));

// Poll the DB for the completion-event chain.
const startedAt = Date.now();
let execJobEvent = null, assistantAfterLaunch = false, launchRow = null, rowsN = 0;
while (Date.now() - startedAt < timeoutMs) {
  const msgs = await jf(`${apiBase}/siclaw/agents/${agent.id}/chat/sessions/${session.id}/messages?page=1&page_size=100`, { headers: auth });
  const rows = msgs.data ?? []; rowsN = rows.length;
  const launchRe = TOOL ? new RegExp(`^${TOOL}$`) : /host_exec|host_script|local_script|node_script|pod_script|bash/;
  const launchIdx = rows.findIndex((m) => m.tool_name && launchRe.test(m.tool_name));
  launchRow = launchIdx >= 0 ? rows[launchIdx] : null;
  // Key the completion event on the TARGET tool's job_id (discovery calls may precede it).
  execJobEvent = rows.find((m) => pj(m.metadata).kind === "exec_job_event" && (!TOOL || String(pj(m.metadata).job_id || "").includes(TOOL))) ?? null;
  // a substantive assistant turn after the launch row (the synthetic completion turn)
  assistantAfterLaunch = launchIdx >= 0 && rows.slice(launchIdx + 1).some((m) => m.role === "assistant" && (m.content || "").trim().length > 0);
  if (execJobEvent && (execJobEvent && pj(execJobEvent.metadata).status)) break;
  await sleep(3000);
}

const meta = pj(execJobEvent?.metadata);
const result = {
  rows: rowsN,
  launchRow: launchRow ? { tool: launchRow.tool_name, backgroundTaskId: pj(launchRow.metadata).backgroundTaskId ?? null } : null,
  execJobEvent: execJobEvent ? { kind: meta.kind, status: meta.status, exit_code: meta.exit_code, job_id: meta.job_id } : null,
  assistantAfterLaunch,
};
console.log(JSON.stringify(result, null, 2));

// Verdict keys on DB truth (the exec_job_event for the target tool), not the SSE heuristic:
// a discovery bash/node_exec call may precede the real background launch.
const problems = [];
if (!execJobEvent) problems.push(`no exec_job_event completion row for ${TOOL ?? "the tool"} (box would not fold)`);
else if (!meta.status) problems.push("exec_job_event has no terminal status");
if (!assistantAfterLaunch) problems.push("no assistant follow-up after launch (completion turn missing)");
if (TOOL && !launchRow) problems.push(`no persisted ${TOOL} launch row`);
if (problems.length) { console.log("RESULT: FAIL — " + problems.join("; ")); process.exit(1); }
console.log(`RESULT: PASS — launched bg, exec_job_event status=${meta.status} exit=${meta.exit_code}, model followed up`);
