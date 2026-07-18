import { createServer, type Server as HttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

const clients: Client[] = [];
const httpServers: HttpServer[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(httpServers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function listen(server: HttpServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock server did not bind TCP");
  return address.port;
}

function completedTask() {
  return {
    id: "task-e2e",
    contextId: "context-e2e",
    status: {
      state: "TASK_STATE_COMPLETED",
      timestamp: "2026-07-18T00:00:00.000Z",
      message: { parts: [{ text: "completed" }] },
    },
    artifacts: [{ parts: [{ text: "e2e root cause" }] }],
  };
}

describe("stdio process", () => {
  it("bridges a real MCP subprocess call to the Sicore A2A HTTP contract", async () => {
    let observedAuth = "";
    let observedBody: unknown;
    const mock = createServer(async (request, response) => {
      observedAuth = request.headers.authorization ?? "";
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      observedBody = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
      response.writeHead(200, { "content-type": "application/a2a+json" });
      response.end(JSON.stringify({ task: completedTask() }));
    });
    httpServers.push(mock);
    const port = await listen(mock);

    const adapterEntrypoint = fileURLToPath(new URL("./index.ts", import.meta.url));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", adapterEntrypoint],
      env: {
        SICORE_URL: `http://127.0.0.1:${port}`,
        SICLAW_AGENT_ID: "agent-e2e",
        SICLAW_A2A_KEY: "e2e-key",
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-e2e", version: "1.0.0" });
    clients.push(client);
    await client.connect(transport);

    const result = await client.callTool({
      name: "siclaw_investigate",
      arguments: { question: "check e2e", wait_seconds: 0 },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      task_id: "task-e2e",
      context_id: "context-e2e",
      state: "completed",
      result: "e2e root cause",
    });
    expect(observedAuth).toBe("Bearer e2e-key");
    expect(observedBody).toEqual({
      message: { role: "ROLE_USER", parts: [{ text: "check e2e" }] },
    });
  });
});
