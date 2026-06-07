// Real-browser full-chain smoke for background exec. Phase A: drive a real agent to launch a
// background host_exec that completes, and (on completion) read+report its output. Phase B: open
// that session in headless Chrome (CDP) and assert the RENDERED DOM shows the host_exec tool box
// folded to the done state, the completion bubble with the output marker, and NO raw
// <task_notification> bubble. Screenshots are written to /tmp for evidence.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const baseUrl = process.env.SICLAW_PORTAL_URL ?? "http://127.0.0.1:18080";
const apiBase = `${baseUrl}/api/v1`;
const chromeBin = process.env.CHROME_BIN ?? "/usr/bin/google-chrome";
const HOST = process.env.HOST_NAME ?? "172.16.73.22";
const MARKER = process.env.MARKER ?? `SMOKE_UI_${Date.now() % 100000}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function jf(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) } });
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
  if (!res.ok) throw new Error(`${opts.method ?? "GET"} ${url} ${res.status}: ${text.slice(0, 200)}`);
  return body;
}
const pj = (v) => { if (!v) return {}; if (typeof v === "object") return v; try { return JSON.parse(v) ?? {}; } catch { return {}; } };
async function freePort() { return new Promise((res, rej) => { const s = net.createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); }); }

// ---------- Phase A: create a completed-background session ----------
const token = (await jf(`${apiBase}/auth/login`, { method: "POST", body: JSON.stringify({ username: "admin", password: "admin" }) })).token;
const auth = { Authorization: `Bearer ${token}` };
const agent = (await jf(`${apiBase}/agents`, { headers: auth })).data?.[0];
const session = await jf(`${apiBase}/siclaw/agents/${agent.id}/chat/sessions`, { method: "POST", headers: auth, body: JSON.stringify({ title: `bg ui ${Date.now()}` }) });
console.log(JSON.stringify({ sessionId: session.id, marker: MARKER }));

const prompt = `Use the host_exec tool with run_in_background set to true to run this exact command on host "${HOST}": sleep 5; echo ${MARKER} . After launching, immediately end your turn — do not read the output yet. When you are LATER notified that it completed, read its output_file with the read tool and report the exact line it printed.`;
const res = await fetch(`${apiBase}/siclaw/agents/${agent.id}/chat/send`, { method: "POST", headers: { "Content-Type": "application/json", ...auth }, body: JSON.stringify({ text: prompt, session_id: session.id }) });
{ const rd = res.body.getReader(); const dec = new TextDecoder(); while (true) { const { done } = await rd.read(); if (done) break; } } // drain launch turn

// wait until the completion turn (with MARKER) is persisted
let ok = false;
for (let i = 0; i < 60; i++) {
  const rows = (await jf(`${apiBase}/siclaw/agents/${agent.id}/chat/sessions/${session.id}/messages?page=1&page_size=100`, { headers: auth })).data ?? [];
  const ev = rows.find((m) => pj(m.metadata).kind === "exec_job_event" && String(pj(m.metadata).job_id || "").includes("host_exec"));
  const marker = rows.some((m) => m.role === "assistant" && (m.content || "").includes(MARKER));
  if (ev && pj(ev.metadata).status === "completed" && marker) { ok = true; break; }
  await wait(3000);
}
if (!ok) { console.log("RESULT: FAIL — completion turn with marker not persisted (phase A)"); process.exit(1); }
console.log("phase A done: exec_job_event completed + completion turn persisted");

// ---------- Phase B: open in headless Chrome, inspect rendered DOM ----------
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "siclaw-bg-ui-"));
const cdpPort = await freePort();
const chrome = spawn(chromeBin, ["--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-extensions", "about:blank"], { stdio: "ignore" });
async function cdpWsUrl() { for (let i = 0; i < 50; i++) { try { const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json(); const page = list.find((t) => t.type === "page") ?? list[0]; if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl; } catch {} await wait(100); } throw new Error("Chrome CDP did not start"); }
let ws;
try {
  ws = new WebSocket(await cdpWsUrl());
  let seq = 0; const pending = new Map();
  ws.on("message", (buf) => { const m = JSON.parse(buf.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => { pending.set(id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result))); setTimeout(() => reject(new Error(`CDP timeout ${method}`)), 15000); }); };
  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1600, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `${baseUrl}/login` });
  await wait(700);
  await send("Runtime.evaluate", { expression: `localStorage.setItem('token', ${JSON.stringify(token)}); true`, awaitPromise: true });
  await send("Page.navigate", { url: `${baseUrl}/chat?agent=${agent.id}&session=${session.id}` });
  const bodyText = async () => (await send("Runtime.evaluate", { expression: "document.body.innerText", returnByValue: true })).result.value ?? "";
  const waitForText = async (needle) => { for (let i = 0; i < 100; i++) { const t = await bodyText(); if (t.includes(needle)) return t; await wait(300); } throw new Error(`timeout waiting for "${needle}"`); };

  // The completion bubble carries the marker — wait for it to render.
  await waitForText(MARKER);
  // Expand the host_exec tool box to reveal its body (lifecycle text).
  await send("Runtime.evaluate", { expression: `
    const btn = Array.from(document.querySelectorAll('[role=button],button')).find((b)=>/host_exec/.test(b.innerText||''));
    btn?.scrollIntoView({block:'center'}); btn?.click(); true`, awaitPromise: true });
  await wait(600);
  const text = await bodyText();
  await wait(200);
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  const screenshot = `/tmp/siclaw-bg-ui-${session.id}.png`;
  await fs.writeFile(screenshot, Buffer.from(shot.data, "base64"));

  const checks = {
    hostExecBoxRendered: text.includes("host_exec"),
    completionBubbleHasMarker: text.includes(MARKER),
    boxFoldedDone: text.includes("Background task completed") || /exit 0/.test(text),
    stillRunningGone: !text.includes("Running in the background"),
    noRawTaskNotification: !text.includes("<task_notification>") && !text.includes("task_notification"),
  };
  console.log(JSON.stringify({ checks, screenshot }, null, 2));
  const fail = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  if (fail.length) { console.log("RESULT: FAIL — " + fail.join(", ") + "\n--- body ---\n" + text.slice(0, 1500)); process.exit(1); }
  console.log("RESULT: PASS — browser rendered: host_exec box folded to done, completion bubble shows output marker, no raw task_notification bubble");
} finally { ws?.close(); chrome.kill("SIGTERM"); }
