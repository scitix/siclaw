#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fssync from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SESSION_ID = "routing-smoke-session";
const PRIMARY = { provider: "primary", modelId: "gpt-primary" };
const FALLBACK = { provider: "fallback", modelId: "gpt-fallback" };

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function listen(server, host = "127.0.0.1") {
  return new Promise((resolve) => {
    server.listen(0, host, () => {
      resolve(server.address().port);
    });
  });
}

function createMockLlmServer() {
  const requests = [];

  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    const body = await readRequestBody(req);
    requests.push({
      model: body.model,
      stream: body.stream,
      messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
    });

    if (body.model === PRIMARY.modelId) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: {
          message: "429 rate limit exceeded by routing smoke",
          type: "rate_limit_error",
        },
      }));
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const created = Math.floor(Date.now() / 1000);
    const send = (chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    send({
      id: `chatcmpl-${body.model}-start`,
      object: "chat.completion.chunk",
      created,
      model: body.model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });
    send({
      id: `chatcmpl-${body.model}-delta`,
      object: "chat.completion.chunk",
      created,
      model: body.model,
      choices: [{ index: 0, delta: { content: `ok from ${body.model}` }, finish_reason: null }],
    });
    send({
      id: `chatcmpl-${body.model}-done`,
      object: "chat.completion.chunk",
      created,
      model: body.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    });
    res.write("data: [DONE]\n\n");
    res.end();
  });

  return {
    server,
    requests,
    async start() {
      const port = await listen(server);
      return { port, baseUrl: `http://127.0.0.1:${port}/v1` };
    },
    async stop() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function getFreePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(() => resolve()));
  return port;
}

async function writeSettings(tmpDir, llmBaseUrl, agentboxPort) {
  const dirs = {
    config: path.join(tmpDir, "config"),
    userData: path.join(tmpDir, "user-data"),
    skills: path.join(tmpDir, "skills"),
    credentials: path.join(tmpDir, "credentials"),
    repos: path.join(tmpDir, "repos"),
    docs: path.join(tmpDir, "docs"),
    knowledge: path.join(tmpDir, "knowledge"),
    piAgent: path.join(tmpDir, "pi-agent"),
  };

  for (const dir of Object.values(dirs)) {
    await fs.mkdir(dir, { recursive: true });
  }
  await fs.mkdir(path.join(dirs.skills, "core"), { recursive: true });
  await fs.mkdir(path.join(dirs.skills, "extension"), { recursive: true });

  const settings = {
    providers: {
      [PRIMARY.provider]: {
        baseUrl: llmBaseUrl,
        apiKey: "sk-routing-smoke-primary",
        api: "openai-completions",
        authHeader: true,
        models: [
          {
            id: PRIMARY.modelId,
            name: "Routing Smoke Primary",
            reasoning: false,
            contextWindow: 8192,
            maxTokens: 1024,
            compat: {
              supportsDeveloperRole: false,
              supportsUsageInStreaming: true,
              supportsToolUse: false,
              maxTokensField: "max_tokens",
            },
          },
        ],
      },
      [FALLBACK.provider]: {
        baseUrl: llmBaseUrl,
        apiKey: "sk-routing-smoke-fallback",
        api: "openai-completions",
        authHeader: true,
        models: [
          {
            id: FALLBACK.modelId,
            name: "Routing Smoke Fallback",
            reasoning: false,
            contextWindow: 8192,
            maxTokens: 1024,
            compat: {
              supportsDeveloperRole: false,
              supportsUsageInStreaming: true,
              supportsToolUse: false,
              maxTokensField: "max_tokens",
            },
          },
        ],
      },
    },
    default: { provider: PRIMARY.provider, modelId: PRIMARY.modelId },
    modelRouting: {
      enabled: true,
      strategy: "ordered_fallback",
      candidates: [
        { provider: PRIMARY.provider, modelId: PRIMARY.modelId },
        { provider: FALLBACK.provider, modelId: FALLBACK.modelId },
      ],
    },
    paths: {
      userDataDir: dirs.userData,
      skillsDir: dirs.skills,
      credentialsDir: dirs.credentials,
      reposDir: dirs.repos,
      docsDir: dirs.docs,
      knowledgeDir: dirs.knowledge,
    },
    server: { port: agentboxPort, gatewayUrl: "" },
    allowedTools: [],
    mcpServers: {},
  };

  await fs.writeFile(path.join(dirs.config, "settings.json"), JSON.stringify(settings, null, 2) + "\n");
  return dirs;
}

function startAgentBox({ dirs, port, label }) {
  const logs = [];
  const child = spawn(process.execPath, ["dist/agentbox-main.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      SICLAW_CONFIG_DIR: dirs.config,
      SICLAW_USER_DATA_DIR: dirs.userData,
      SICLAW_SKILLS_DIR: dirs.skills,
      SICLAW_CREDENTIALS_DIR: dirs.credentials,
      SICLAW_REPOS_DIR: dirs.repos,
      SICLAW_DOCS_DIR: dirs.docs,
      SICLAW_AGENTBOX_PORT: String(port),
      SICLAW_MEMORY_ENABLED: "false",
      SICLAW_AGENT_ID: "routing-smoke-agent",
      USER_ID: "routing-smoke-user",
      PI_CODING_AGENT_DIR: dirs.piAgent,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => logs.push(`[${label} stdout] ${chunk.toString()}`));
  child.stderr.on("data", (chunk) => logs.push(`[${label} stderr] ${chunk.toString()}`));

  return { child, logs };
}

async function stopAgentBox(handle) {
  if (!handle || handle.child.exitCode !== null || handle.child.signalCode !== null) return;
  const exited = new Promise((resolve) => handle.child.once("exit", () => resolve()));
  handle.child.kill("SIGTERM");
  const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), 5000));
  const result = await Promise.race([exited, timeout]);
  if (result === "timeout") {
    handle.child.kill("SIGKILL");
    await new Promise((resolve) => handle.child.once("exit", () => resolve()));
  }
}

async function waitForHealth(baseUrl, handle) {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < 30_000) {
    if (handle.child.exitCode !== null) {
      throw new Error(`AgentBox exited early with code ${handle.child.exitCode}\n${handle.logs.join("")}`);
    }
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`AgentBox health check timed out: ${lastError}\n${handle.logs.join("")}`);
}

async function fetchJson(url, init) {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const text = await res.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Keep raw body.
  }
  return { status: res.status, ok: res.ok, body };
}

async function readSseEvents(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const events = [];
  try {
    const res = await fetch(url, { signal: controller.signal });
    assert.equal(res.status, 200, `SSE HTTP status for ${url}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trimStart();
          if (!data) continue;
          events.push(JSON.parse(data));
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return events;
}

async function promptAndStream(baseUrl, text) {
  const prompt = await fetchJson(`${baseUrl}/api/prompt`, {
    method: "POST",
    body: JSON.stringify({ sessionId: SESSION_ID, text }),
  });
  assert.equal(prompt.status, 200, `POST /api/prompt status: ${JSON.stringify(prompt.body)}`);
  assert.equal(prompt.body.ok, true, "POST /api/prompt ok");
  assert.equal(prompt.body.sessionId, SESSION_ID, "POST /api/prompt sessionId");
  const events = await readSseEvents(`${baseUrl}/api/stream/${SESSION_ID}`);
  return { prompt: prompt.body, events };
}

function hasAssistantText(events, text) {
  return events.some((event) =>
    event?.type === "message_end" &&
    event.message?.role === "assistant" &&
    Array.isArray(event.message.content) &&
    event.message.content.some((block) => block?.type === "text" && String(block.text ?? "").includes(text)),
  );
}

async function waitForRouteStateFile(userDataDir) {
  const file = path.join(userDataDir, "agent", "sessions", SESSION_ID, ".model-route-state.json");
  const started = Date.now();
  while (Date.now() - started < 5000) {
    if (fssync.existsSync(file)) {
      const raw = JSON.parse(await fs.readFile(file, "utf8"));
      if (raw.activeCandidateKey === `${FALLBACK.provider}/${FALLBACK.modelId}`) return raw;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for route state file at ${file}`);
}

async function waitForUserRouteStateFile(userDataDir) {
  const file = path.join(userDataDir, "agent", "sessions", SESSION_ID, ".model-route-state.json");
  const started = Date.now();
  while (Date.now() - started < 5000) {
    if (fssync.existsSync(file)) {
      const raw = JSON.parse(await fs.readFile(file, "utf8"));
      if (
        raw.activeCandidateKey === `${PRIMARY.provider}/${PRIMARY.modelId}` &&
        raw.activeCandidateSource === "user" &&
        Object.keys(raw.cooldowns ?? {}).length === 0
      ) {
        return raw;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for manual route state file at ${file}`);
}

async function main() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "siclaw-agentbox-routing-smoke-"));
  const mock = createMockLlmServer();
  let agentbox = null;
  let restartAgentbox = null;
  let keepTmp = process.env.SICLAW_SMOKE_KEEP_TMP === "1";

  try {
    const { baseUrl: llmBaseUrl } = await mock.start();
    const agentboxPort = await getFreePort();
    const dirs = await writeSettings(tmpDir, llmBaseUrl, agentboxPort);
    const agentboxBaseUrl = `http://127.0.0.1:${agentboxPort}`;

    agentbox = startAgentBox({ dirs, port: agentboxPort, label: "agentbox-1" });
    await waitForHealth(agentboxBaseUrl, agentbox);

    const health = await fetchJson(`${agentboxBaseUrl}/health`);
    assert.equal(health.status, 200, "GET /health");
    assert.equal(health.body.status, "ok", "GET /health status");

    const models = await fetchJson(`${agentboxBaseUrl}/api/models`);
    assert.equal(models.status, 200, "GET /api/models");
    assert.deepEqual(
      models.body.models.map((model) => `${model.provider}/${model.id}`).sort(),
      [`${FALLBACK.provider}/${FALLBACK.modelId}`, `${PRIMARY.provider}/${PRIMARY.modelId}`].sort(),
      "GET /api/models returned configured models",
    );

    const first = await promptAndStream(agentboxBaseUrl, "route smoke first prompt");
    assert(first.events.some((event) => event?.type === "model_route_switch"), "first prompt emitted model_route_switch");
    assert(!first.events.some((event) => event?.type === "stream_error"), "first prompt emitted no stream_error");
    assert(hasAssistantText(first.events, `ok from ${FALLBACK.modelId}`), "first prompt ended with fallback assistant text");
    const routeState = await waitForRouteStateFile(dirs.userData);
    assert(routeState.cooldowns?.[`${PRIMARY.provider}/${PRIMARY.modelId}`] > Date.now(), "primary cooldown persisted");
    const firstModels = mock.requests.map((request) => request.model);
    assert(firstModels.length >= 2, "first prompt made multiple provider calls");
    assert(firstModels.slice(0, -1).every((model) => model === PRIMARY.modelId), "first prompt retried only primary before fallback");
    assert.equal(firstModels.at(-1), FALLBACK.modelId, "first prompt ended on fallback");

    const modelBeforeSwitch = await fetchJson(`${agentboxBaseUrl}/api/sessions/${SESSION_ID}/model`);
    assert.equal(modelBeforeSwitch.status, 200, "GET current model");
    assert.equal(modelBeforeSwitch.body.model.provider, FALLBACK.provider, "current model after fallback");
    assert.equal(modelBeforeSwitch.body.model.id, FALLBACK.modelId, "current model id after fallback");

    await stopAgentBox(agentbox);
    agentbox = null;

    const beforeRestartCalls = mock.requests.length;
    restartAgentbox = startAgentBox({ dirs, port: agentboxPort, label: "agentbox-2" });
    await waitForHealth(agentboxBaseUrl, restartAgentbox);

    const second = await promptAndStream(agentboxBaseUrl, "route smoke after restart");
    assert(!second.events.some((event) => event?.type === "stream_error"), "restart prompt emitted no stream_error");
    assert(hasAssistantText(second.events, `ok from ${FALLBACK.modelId}`), "restart prompt ended with fallback assistant text");
    assert.deepEqual(
      mock.requests.slice(beforeRestartCalls).map((request) => request.model),
      [FALLBACK.modelId],
      "restart prompt used persisted fallback candidate while primary cooled",
    );

    const switchBack = await fetchJson(`${agentboxBaseUrl}/api/sessions/${SESSION_ID}/model`, {
      method: "PUT",
      body: JSON.stringify({ provider: PRIMARY.provider, modelId: PRIMARY.modelId }),
    });
    assert.equal(switchBack.status, 200, "PUT /api/sessions/:id/model");
    assert.equal(switchBack.body.model.provider, PRIMARY.provider, "PUT model provider");
    assert.equal(switchBack.body.model.id, PRIMARY.modelId, "PUT model id");
    const manualState = await waitForUserRouteStateFile(dirs.userData);
    assert.equal(manualState.lastSwitchReason, "user_selection", "manual model switch records route state source");

    console.log(JSON.stringify({
      ok: true,
      tmpDir,
      mockRequests: mock.requests,
      routeState,
      manualState,
      firstEventTypes: first.events.map((event) => event.type).filter(Boolean),
      secondEventTypes: second.events.map((event) => event.type).filter(Boolean),
    }, null, 2));
  } catch (err) {
    keepTmp = true;
    const logs = [
      ...(agentbox?.logs ?? []),
      ...(restartAgentbox?.logs ?? []),
    ].join("");
    console.error(logs);
    console.error(`[smoke] failed: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    console.error(`[smoke] temp dir preserved: ${tmpDir}`);
    process.exitCode = 1;
  } finally {
    await stopAgentBox(agentbox);
    await stopAgentBox(restartAgentbox);
    await mock.stop().catch(() => {});
    if (!keepTmp) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }
}

main();
