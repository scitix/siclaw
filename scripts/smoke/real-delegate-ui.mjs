import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const baseUrl = process.env.SICLAW_PORTAL_URL ?? "http://127.0.0.1:3000";
const chromeBin = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sessionId = process.argv[2];

if (!sessionId) {
  throw new Error("Usage: node scripts/smoke/real-delegate-ui.mjs <session-id-from-real-delegate-smoke>");
}

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

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

const login = await jsonFetch(`${baseUrl}/api/v1/auth/login`, {
  method: "POST",
  body: JSON.stringify({
    username: process.env.SICLAW_SMOKE_USER ?? "admin",
    password: process.env.SICLAW_SMOKE_PASSWORD ?? "admin",
  }),
});
const token = login.token;
const agents = await jsonFetch(`${baseUrl}/api/v1/agents`, {
  headers: { Authorization: `Bearer ${token}` },
});
const agent = agents.data?.[0];
if (!agent) throw new Error("No agent is available for smoke testing.");

const profile = await fs.mkdtemp(path.join(os.tmpdir(), "siclaw-real-delegate-ui-"));
const cdpPort = await freePort();
const chrome = spawn(
  chromeBin,
  [
    "--headless=new",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-extensions",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function cdpWsUrl() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      const page = list.find((target) => target.type === "page") ?? list[0];
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await wait(100);
  }
  throw new Error("Chrome CDP did not start.");
}

let ws;
try {
  ws = new WebSocket(await cdpWsUrl());
  let seq = 0;
  const pending = new Map();
  ws.on("message", (buf) => {
    const msg = JSON.parse(buf.toString());
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  function send(method, params = {}) {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      pending.set(id, (msg) => (msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)));
      setTimeout(() => reject(new Error(`CDP timeout ${method}`)), 10000);
    });
  }

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1600,
    height: 1200,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: `${baseUrl}/login` });
  await wait(500);
  await send("Runtime.evaluate", {
    expression: `localStorage.setItem('token', ${JSON.stringify(token)}); true`,
    awaitPromise: true,
  });
  await send("Page.navigate", { url: `${baseUrl}/chat?agent=${agent.id}&session=${sessionId}` });

  async function bodyText() {
    const result = await send("Runtime.evaluate", {
      expression: "document.body.innerText",
      returnByValue: true,
    });
    return result.result.value ?? "";
  }

  async function waitForText(needle) {
    for (let i = 0; i < 80; i++) {
      const text = await bodyText();
      if (text.includes(needle)) return text;
      await wait(250);
    }
    throw new Error(`Timed out waiting for ${needle}\n${await bodyText()}`);
  }

  let text = await waitForText("Delegated investigation");
  for (const needle of ["Done", "self sub-agent", "Summarize in one sentence"]) {
    if (!text.includes(needle)) throw new Error(`Real delegate card missing ${needle}\n${text}`);
  }

  await send("Runtime.evaluate", {
    expression: `
      const cardButton = Array.from(document.querySelectorAll('button'))
        .find((button) => button.innerText.includes('Delegated investigation'));
      cardButton?.scrollIntoView({ block: 'center', inline: 'center' });
      cardButton?.click();
      true
    `,
    awaitPromise: true,
  });
  await wait(300);
  text = await bodyText();
  for (const needle of ["SCOPE", "CAPSULE SENT TO PARENT", "FULL SUB-AGENT REPORT", "tool calls"]) {
    if (!text.includes(needle)) throw new Error(`Expanded real delegate card missing ${needle}\n${text}`);
  }
  if (text.includes("TRACE")) {
    throw new Error(`Expanded real delegate card should not expose debug trace id by default\n${text}`);
  }

  const screenshot = `/tmp/siclaw-real-delegate-ui-smoke-${sessionId}.png`;
  await send("Runtime.evaluate", {
    expression: `
      const cardButton = Array.from(document.querySelectorAll('button'))
        .find((button) => button.innerText.includes('Delegated investigation'));
      cardButton?.scrollIntoView({ block: 'center', inline: 'center' });
      window.scrollBy(0, -80);
      true
    `,
    awaitPromise: true,
  });
  await wait(200);
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await fs.writeFile(screenshot, Buffer.from(shot.data, "base64"));
  console.log(JSON.stringify({ ok: true, sessionId, screenshot }, null, 2));
} finally {
  ws?.close();
  chrome.kill("SIGTERM");
}
