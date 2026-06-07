// Full-chain smoke: subscribes to the LIVE per-session SSE channel (not just DB polling)
// and verifies the real-time completion events, the streamed output content, and (MODE=stop)
// the job_stop / stopped path.
//   MODE=completed : host_exec bg `sleep N; echo MARKER` → assert live exec_job_done +
//                    background_turn_done, exec_job_event=completed, and the model's
//                    follow-up turn surfaces MARKER (proves output streamed to disk + read).
//   MODE=stop      : host_exec bg `sleep 60` → tell the model to job_stop it → assert
//                    exec_job_event status=stopped.
const baseUrl = process.env.SICLAW_PORTAL_URL ?? "http://127.0.0.1:18080";
const apiBase = `${baseUrl}/api/v1`;
const HOST = process.env.HOST_NAME ?? "172.16.73.22";
const MODE = process.env.MODE ?? "completed";
const MARKER = process.env.MARKER ?? "SMOKE_FC";
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

const token = (await jf(`${apiBase}/auth/login`, { method: "POST", body: JSON.stringify({ username: "admin", password: "admin" }) })).token;
const auth = { Authorization: `Bearer ${token}` };
const agent = (await jf(`${apiBase}/agents`, { headers: auth })).data?.[0];
const session = await jf(`${apiBase}/siclaw/agents/${agent.id}/chat/sessions`, { method: "POST", headers: auth, body: JSON.stringify({ title: `fullchain ${MODE} ${Date.now()}` }) });
console.log(JSON.stringify({ mode: MODE, sessionId: session.id, marker: MARKER }));

// --- subscribe to the LIVE persistent per-session SSE channel (query-token auth) ---
const liveEvents = [];
const sseAbort = new AbortController();
(async () => {
  try {
    const r = await fetch(`${apiBase}/siclaw/agents/${agent.id}/chat/sessions/${session.id}/events?token=${encodeURIComponent(token)}`, { signal: sseAbort.signal });
    const rd = r.body.getReader(); const dec = new TextDecoder(); let b = "";
    while (true) {
      const { done, value } = await rd.read(); if (done) break;
      b += dec.decode(value, { stream: true });
      const frames = b.split("\n\n"); b = frames.pop() ?? "";
      for (const f of frames) {
        let data = "";
        for (const line of f.split("\n")) if (line.startsWith("data: ")) data += line.slice(6);
        const p = pj(data);
        const inner = p.event ?? p; // chat.event wraps {type,...}
        if (inner && inner.type) liveEvents.push(inner.type === "exec_job_done" ? { type: "exec_job_done", status: inner.status, job_id: inner.job_id } : { type: inner.type });
      }
    }
  } catch { /* aborted at end */ }
})();

async function send(text) {
  const res = await fetch(`${apiBase}/siclaw/agents/${agent.id}/chat/send`, { method: "POST", headers: { "Content-Type": "application/json", ...auth }, body: JSON.stringify({ text, session_id: session.id }) });
  if (!res.ok) throw new Error(`send ${res.status}: ${await res.text()}`);
  const rd = res.body.getReader(); const dec = new TextDecoder(); let b = ""; const toolEnds = [];
  while (true) {
    const { done, value } = await rd.read(); if (done) break;
    b += dec.decode(value, { stream: true });
    const frames = b.split("\n\n"); b = frames.pop() ?? "";
    for (const f of frames) {
      let ev = "message", data = "";
      for (const line of f.split("\n")) { if (line.startsWith("event: ")) ev = line.slice(7); else if (line.startsWith("data: ")) data += line.slice(6); }
      if (ev === "chat.event") { const p = pj(data); if (p.type === "tool_execution_end") toolEnds.push(p); }
    }
  }
  return toolEnds;
}

const cmd = MODE === "stop" ? "sleep 60" : `sleep 6; echo ${MARKER}`;
const onDone = MODE === "stop"
  ? ""
  : ` When you are LATER notified that this background task has completed, read its output_file with the read tool and report the exact line it printed.`;
const launchPrompt = `Use the host_exec tool with run_in_background set to true to run this exact command on host "${HOST}": ${cmd} . After launching, immediately end your turn — do not read the output file yet, do not call any other tool, do not wait.${onDone}`;
const toolEnds = await send(launchPrompt);
const launch = toolEnds.find((t) => t.toolName === "host_exec");
const launchText = launch ? JSON.stringify(launch.result) : "";
const taskId = (launchText.match(/functions\.host_exec:\d+/) || [])[0] || (launchText.match(/"task_id":\s*"([^"]+)"/) || [])[1];
console.log(JSON.stringify({ launched: !!launch, taskId }));

if (MODE === "stop") {
  await sleep(2000);
  await send(`Call the job_stop tool with task_id "${taskId}" to stop that background task. Then end your turn.`);
}

// poll DB for the terminal exec_job_event
const startedAt = Date.now();
let execJobEvent = null, followupMarker = false;
while (Date.now() - startedAt < timeoutMs) {
  const rows = (await jf(`${apiBase}/siclaw/agents/${agent.id}/chat/sessions/${session.id}/messages?page=1&page_size=100`, { headers: auth })).data ?? [];
  execJobEvent = rows.find((m) => pj(m.metadata).kind === "exec_job_event" && String(pj(m.metadata).job_id || "").includes("host_exec")) ?? null;
  followupMarker = rows.some((m) => m.role === "assistant" && (m.content || "").includes(MARKER));
  const haveTerminal = execJobEvent && pj(execJobEvent.metadata).status;
  // background_turn_done fires AFTER the synthetic completion turn persists — well after the
  // exec_job_event row. So don't stop the instant the row appears; for completed mode wait
  // until the live background_turn_done arrives too (or the overall timeout).
  const haveBtd = MODE === "stop" || liveEvents.some((e) => e.type === "background_turn_done");
  if (haveTerminal && haveBtd) break;
  await sleep(2500);
}
await sleep(1500); // let any final live event arrive
sseAbort.abort();

const meta = pj(execJobEvent?.metadata);
console.log(JSON.stringify({ liveEvents, execJobEvent: execJobEvent ? { status: meta.status, exit_code: meta.exit_code, job_id: meta.job_id } : null, followupMarker }, null, 2));

const problems = [];
const expected = MODE === "stop" ? "stopped" : "completed";
if (!execJobEvent) problems.push("no exec_job_event persisted");
else if (meta.status !== expected) problems.push(`exec_job_event status=${meta.status}, expected ${expected}`);
if (!liveEvents.some((e) => e.type === "exec_job_done")) problems.push("no LIVE exec_job_done event received over SSE");
if (MODE !== "stop") {
  if (!liveEvents.some((e) => e.type === "background_turn_done")) problems.push("no LIVE background_turn_done event over SSE");
  if (!followupMarker) problems.push(`model follow-up did not surface ${MARKER} (output not streamed/read)`);
}
if (problems.length) { console.log("RESULT: FAIL — " + problems.join("; ")); process.exit(1); }
console.log(`RESULT: PASS — live exec_job_done${MODE !== "stop" ? "+background_turn_done" : ""} received, exec_job_event=${meta.status}${MODE !== "stop" ? `, output marker surfaced` : ""}`);
