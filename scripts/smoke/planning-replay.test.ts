import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const response = {
  event: "chat.event",
  data: {
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Completed." }] },
  },
};
const streamError = {
  event: "error",
  data: { code: "STREAM_INTERRUPTED", message: "The stream was interrupted." },
};
const terminalEvents = [
  { event: "chat.event", data: { type: "prompt_done" } },
  { event: "done", data: {} },
];

// Run the actual CLI against HTTP/SSE fixtures to cover exit status, artifacts,
// and whether a failed replay stops the batch.
async function replay(events: Array<{ event: string; data: unknown }>) {
  const directory = await mkdtemp(path.join(tmpdir(), "siclaw-planning-replay-test-"));
  const chatPath = "/api/v1/siclaw/agents/replay-contract/chat";
  let sessions = 0;
  let sends = 0;
  const unexpectedRoutes: string[] = [];
  const server = createServer((request, reply) => {
    request.resume();
    const route = new URL(request.url!, "http://localhost").pathname;
    reply.setHeader("Content-Type", "application/json");
    if (request.method === "POST" && route === `${chatPath}/sessions`) {
      reply.end(JSON.stringify({ id: `session-${++sessions}` }));
    } else if (request.method === "POST" && route === `${chatPath}/send`) {
      sends++;
      reply.setHeader("Content-Type", "text/event-stream");
      reply.end(events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""));
    } else if (request.method === "GET" && route.startsWith(`${chatPath}/sessions/`) && route.endsWith("/messages")) {
      reply.end(JSON.stringify({ data: [] }));
    } else if (request.method === "GET" && route === "/api/v1/agents/replay-contract/prompt-inspection") {
      reply.end(JSON.stringify({ available: false }));
    } else {
      unexpectedRoutes.push(`${request.method} ${route}`);
      reply.writeHead(404).end("{}");
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const tokenPath = path.join(directory, "token.txt");
    await writeFile(tokenPath, "synthetic-test-token", { mode: 0o600 });
    const exitCode = await new Promise<number>((resolve, reject) => {
      execFile(process.execPath, [fileURLToPath(new URL("./planning-replay.mjs", import.meta.url))], {
        timeout: 10_000,
        env: {
          ...process.env,
          SICLAW_PORTAL_URL: `http://127.0.0.1:${address.port}`,
          SICLAW_AGENT_ID: "replay-contract",
          SICLAW_TOKEN_FILE: tokenPath,
          SICLAW_REPLAY_DIR: directory,
          SICLAW_REPLAY_LABEL: "contract",
          SICLAW_REPLAY_CASES: "direct,known",
          SICLAW_REPLAY_REPEAT: "1",
          SICLAW_REPLAY_EXPECT_VARIANT: "",
        },
      }, (error) => {
        if (!error) resolve(0);
        else if (typeof error.code === "number") resolve(error.code);
        else reject(error);
      });
    });
    const summaries = JSON.parse(await readFile(path.join(directory, "contract-summary.json"), "utf8"));
    const artifacts = await Promise.all(summaries.map(async ({ key }: { key: string }) =>
      JSON.parse(await readFile(path.join(directory, `${key}.json`), "utf8"))));
    return { exitCode, summaries, artifacts, sessions, sends, unexpectedRoutes };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

describe("planning replay stream errors", () => {
  it("fails and stops the batch when an error follows the final response", async () => {
    const result = await replay([response, streamError, ...terminalEvents]);
    expect(result.unexpectedRoutes).toEqual([]);
    expect(result.exitCode).toBe(1);
    expect(result.sessions).toBe(1);
    expect(result.sends).toBe(1);
    expect(result.summaries).toHaveLength(1);
    expect(result.summaries[0].errors).toBe(1);
    expect(result.summaries[0].failure).toMatch(/execution\/model error/);
    expect(result.artifacts[0].failure).toBe(result.summaries[0].failure);
    expect(result.artifacts[0].events.map(({ event, data }: { event: string; data: unknown }) => ({ event, data })))
      .toEqual([response, streamError, ...terminalEvents]);
  }, 15_000);

  it("allows a successful recovery after an earlier error and continues the batch", async () => {
    const result = await replay([streamError, response, ...terminalEvents]);
    expect(result.unexpectedRoutes).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.sessions).toBe(2);
    expect(result.sends).toBe(2);
    expect(result.summaries.map(({ key }: { key: string }) => key))
      .toEqual(["contract-direct-1", "contract-known-1"]);
    for (const summary of result.summaries) {
      expect(summary.errors).toBe(1);
      expect(summary.failure).toBeUndefined();
    }
    for (const artifact of result.artifacts) expect(artifact.failure).toBeUndefined();
  }, 15_000);
});
