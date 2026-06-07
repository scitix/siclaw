// Real-browser smoke for the BACKGROUND spawn_subagent card. Phase A: launch a background
// sub-agent and wait until its completion delegation_event is persisted. Phase B: open the
// session in headless Chrome and assert the card shows the background (clock) indicator, folded
// to a done state (not the default "Ready"), with the result rendered.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const baseUrl = process.env.SICLAW_PORTAL_URL ?? "http://127.0.0.1:18080";
const apiBase = `${baseUrl}/api/v1`;
const chromeBin = process.env.CHROME_BIN ?? "/usr/bin/google-chrome";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function jf(u, o = {}) { const r = await fetch(u, { ...o, headers: { "Content-Type": "application/json", ...(o.headers ?? {}) } }); const t = await r.text(); let b; try { b = t ? JSON.parse(t) : {}; } catch { b = t; } if (!r.ok) throw new Error(`${u} ${r.status}: ${t.slice(0,200)}`); return b; }
const pj = (v) => { if (!v) return {}; if (typeof v === "object") return v; try { return JSON.parse(v) ?? {}; } catch { return {}; } };
async function freePort() { return new Promise((res, rej) => { const s = net.createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); }); }

const token = (await jf(`${apiBase}/auth/login`, { method: "POST", body: JSON.stringify({ username: "admin", password: "admin" }) })).token;
const auth = { Authorization: `Bearer ${token}` };
const agent = (await jf(`${apiBase}/agents`, { headers: auth })).data?.[0];
const session = await jf(`${apiBase}/siclaw/agents/${agent.id}/chat/sessions`, { method: "POST", headers: auth, body: JSON.stringify({ title: `bg subagent ui ${Date.now()}` }) });
console.log("session", session.id);
const prompt = `Use spawn_subagent with run_in_background set to true to dispatch ONE sub-agent whose scope is exactly: "In one sentence, say why notify beats polling for background tasks." After launching, immediately end your turn.`;
const res = await fetch(`${apiBase}/siclaw/agents/${agent.id}/chat/send`, { method: "POST", headers: { "Content-Type": "application/json", ...auth }, body: JSON.stringify({ text: prompt, session_id: session.id }) });
{ const rd = res.body.getReader(); while (true) { const { done } = await rd.read(); if (done) break; } }
let ok = false;
for (let i = 0; i < 60; i++) {
  const rows = (await jf(`${apiBase}/siclaw/agents/${agent.id}/chat/sessions/${session.id}/messages?page=1&page_size=100`, { headers: auth })).data ?? [];
  if (rows.some((m) => pj(m.metadata).kind === "delegation_event")) { ok = true; break; }
  await wait(3000);
}
if (!ok) { console.log("RESULT: FAIL — sub-agent completion (delegation_event) not persisted"); process.exit(1); }
console.log("phase A done: sub-agent completion persisted");

const profile = await fs.mkdtemp(path.join(os.tmpdir(), "siclaw-bg-sa-ui-"));
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
  const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result.value;
  // wait until the sub-agent card has rendered + folded (not "Ready")
  let probe = {};
  for (let i = 0; i < 100; i++) {
    probe = await evalJs(`(() => {
      const bg = !!document.querySelector('[title="Runs in the background — returns immediately, notifies on completion"]');
      const body = document.body.innerText || "";
      return { bgIndicator: bg, hasSubAgentChip: body.includes("sub-agent"), hasDone: body.includes("Done"), hasReady: body.includes("Ready"), bodyLen: body.length };
    })()`);
    if (probe.hasSubAgentChip && (probe.hasDone || !probe.hasReady)) break;
    await wait(400);
  }
  // expand the card to reveal the result
  await send("Runtime.evaluate", { expression: `(() => { const b = Array.from(document.querySelectorAll('button')).find(x=>/sub-agent/.test(x.innerText||'')); b?.scrollIntoView({block:'center'}); b?.click(); return true; })()`, awaitPromise: true });
  await wait(600);
  const text = await evalJs("document.body.innerText");
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  const screenshot = `/tmp/siclaw-bg-sa-ui-${session.id}.png`;
  await fs.writeFile(screenshot, Buffer.from(shot.data, "base64"));
  const checks = {
    subAgentCardRendered: probe.hasSubAgentChip,
    backgroundIndicatorShown: probe.bgIndicator,
    foldedNotStuckReady: probe.hasDone === true, // card flipped to Done (not default Ready)
    resultVisibleAfterExpand: /result/i.test(text) && /(notify|polling|poll)/i.test(text),
  };
  console.log(JSON.stringify({ checks, screenshot }, null, 2));
  const fail = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  if (fail.length) { console.log("RESULT: FAIL — " + fail.join(", ") + "\n--- body ---\n" + text.slice(0, 1200)); process.exit(1); }
  console.log("RESULT: PASS — sub-agent card: background indicator shown, folded to Done, result rendered");
} finally { ws?.close(); chrome.kill("SIGTERM"); }
