// LIVE-path browser smoke for the background spawn_subagent card: sends the prompt FROM the UI
// (Enter), so the card is built from the live stream (not a refetch), then asserts the background
// (clock) indicator + a Running state appear immediately, and the card later folds to Done.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const baseUrl = process.env.SICLAW_PORTAL_URL ?? "http://127.0.0.1:18080";
const apiBase = `${baseUrl}/api/v1`;
const chromeBin = process.env.CHROME_BIN ?? "/usr/bin/google-chrome";
const BG_TITLE = "Runs in the background — returns immediately, notifies on completion";
const PROMPT = 'Use spawn_subagent with run_in_background set to true to dispatch ONE sub-agent whose scope is exactly: "In one sentence, say why notify beats polling for background tasks." After launching, immediately end your turn.';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function jf(u, o = {}) { const r = await fetch(u, { ...o, headers: { "Content-Type": "application/json", ...(o.headers ?? {}) } }); const t = await r.text(); let b; try { b = t ? JSON.parse(t) : {}; } catch { b = t; } if (!r.ok) throw new Error(`${u} ${r.status}: ${t.slice(0,200)}`); return b; }
async function freePort() { return new Promise((res, rej) => { const s = net.createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); }); }

const token = (await jf(`${apiBase}/auth/login`, { method: "POST", body: JSON.stringify({ username: "admin", password: "admin" }) })).token;
const auth = { Authorization: `Bearer ${token}` };
const agent = (await jf(`${apiBase}/agents`, { headers: auth })).data?.[0];
const session = await jf(`${apiBase}/siclaw/agents/${agent.id}/chat/sessions`, { method: "POST", headers: auth, body: JSON.stringify({ title: `bg subagent live ${Date.now()}` }) });
console.log("session", session.id);

const profile = await fs.mkdtemp(path.join(os.tmpdir(), "siclaw-bg-live-"));
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
  const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1600, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `${baseUrl}/login` });
  await wait(700);
  await evalJs(`localStorage.setItem('token', ${JSON.stringify(token)}); true`);
  await send("Page.navigate", { url: `${baseUrl}/chat?agent=${agent.id}&session=${session.id}` });
  // wait for the composer textarea
  for (let i = 0; i < 60; i++) { if (await evalJs(`!!document.querySelector('textarea')`)) break; await wait(300); }
  // type into the React-controlled textarea + press Enter to send (live turn streams into THIS page)
  await evalJs(`(() => {
    const ta = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(PROMPT)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    return true;
  })()`);

  const probe = async () => evalJs(`(() => {
    const bg = !!document.querySelector('[title=${JSON.stringify(BG_TITLE)}]');
    const body = document.body.innerText || "";
    return { bg, sub: body.includes("sub-agent"), running: body.includes("Running"), done: body.includes("Done"), ready: body.includes("Ready") };
  })()`);

  // Phase 1 (LIVE): poll fast right after send — capture the indicator + Running before it folds.
  let sawLiveRunning = false, cardAppeared = false;
  for (let i = 0; i < 120; i++) { // ~36s
    const p = await probe();
    if (p.sub) cardAppeared = true;
    if (p.bg && p.running && !p.done) sawLiveRunning = true;
    if (p.done) break;
    await wait(300);
  }
  // Phase 2: ensure it folds to Done
  let reachedDone = false;
  for (let i = 0; i < 120; i++) { const p = await probe(); if (p.done) { reachedDone = true; break; } await wait(500); }

  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  const screenshot = `/tmp/siclaw-bg-live-${session.id}.png`;
  await fs.writeFile(screenshot, Buffer.from(shot.data, "base64"));
  const checks = { cardAppeared, sawLiveRunningWithIndicator: sawLiveRunning, reachedDone };
  console.log(JSON.stringify({ checks, screenshot }, null, 2));
  const fail = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  if (fail.length) { console.log("RESULT: FAIL — " + fail.join(", ")); process.exit(1); }
  console.log("RESULT: PASS — live: card showed background indicator + Running immediately, then folded to Done");
} finally { ws?.close(); chrome.kill("SIGTERM"); }
