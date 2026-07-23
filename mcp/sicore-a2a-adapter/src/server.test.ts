import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SiclawA2aApi, SiclawTask } from "./a2a-client.js";
import { AgentRouter } from "./router.js";
import { createMcpServer } from "./server.js";

const closeAfter: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(closeAfter.splice(0).map((item) => item.close()));
});

function completedTask(): SiclawTask {
  return {
    task_id: "task-1",
    context_id: "context-1",
    state: "completed",
    a2a_state: "TASK_STATE_COMPLETED",
    is_terminal: true,
    status_message: "completed",
    result: "root cause",
    error: null,
    updated_at: "2026-07-18T00:00:00.000Z",
  };
}

function fakeApi(): SiclawA2aApi {
  return {
    sendMessage: vi.fn(async () => completedTask()),
    getTask: vi.fn(async () => completedTask()),
    cancelTask: vi.fn(async () => completedTask()),
    listTasks: vi.fn(async () => ({ tasks: [completedTask()], total_size: 1, page_size: 20, next_page_token: null })),
    waitForTask: vi.fn(async () => completedTask()),
  };
}

function singleRouter(api: SiclawA2aApi): AgentRouter {
  return new AgentRouter([{ alias: "default", agentId: "agent-default", api }]);
}

describe("MCP server", () => {
  it("completes MCP initialization, lists tools, and calls Siclaw through the adapter", async () => {
    const api = fakeApi();
    const server = createMcpServer(singleRouter(api));
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeAfter.push(client, server);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    expect(client.getInstructions()).toContain("call siclaw_wait_task");
    expect(client.getInstructions()).toContain("Never resubmit the same question");

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "siclaw_investigate",
      "siclaw_wait_task",
      "siclaw_get_task",
      "siclaw_cancel_task",
      "siclaw_list_tasks",
    ]);

    const result = await client.callTool({
      name: "siclaw_investigate",
      arguments: { question: "check node", wait_seconds: 0 },
    });
    expect(api.sendMessage).toHaveBeenCalledWith("check node", undefined);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      task_id: "task-1",
      state: "completed",
      result: "root cause",
    });
  });
});
