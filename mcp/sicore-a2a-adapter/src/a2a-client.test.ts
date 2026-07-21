import { describe, expect, it, vi } from "vitest";
import { A2aClientError, normalizeTask, resolveAgentId, SicoreA2aClient } from "./a2a-client.js";
import type { ResolvedAdapterConfig } from "./config.js";

function config(extra: Partial<ResolvedAdapterConfig> = {}): ResolvedAdapterConfig {
  return {
    baseUrl: "https://sicore.example.com",
    agentId: "agent/one",
    apiKey: "super-secret-key",
    requestTimeoutMs: 5_000,
    pollIntervalMs: 100,
    ...extra,
  };
}

function task(state = "TASK_STATE_WORKING", artifact?: string) {
  return {
    id: "task-1",
    contextId: "context-1",
    status: {
      state,
      timestamp: "2026-07-18T00:00:00.000Z",
      message: { parts: [{ text: state === "TASK_STATE_FAILED" ? "investigation failed" : "Siclaw is working" }] },
    },
    ...(artifact ? { artifacts: [{ parts: [{ text: artifact }] }] } : {}),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/a2a+json" },
  });
}

describe("normalizeTask", () => {
  it("returns a stable completed task shape", () => {
    expect(normalizeTask(task("TASK_STATE_COMPLETED", "root cause"))).toEqual({
      task_id: "task-1",
      context_id: "context-1",
      state: "completed",
      a2a_state: "TASK_STATE_COMPLETED",
      is_terminal: true,
      status_message: "Siclaw is working",
      result: "root cause",
      error: null,
      updated_at: "2026-07-18T00:00:00.000Z",
    });
  });

  it("uses the status message as the error for failed tasks", () => {
    expect(normalizeTask(task("TASK_STATE_FAILED")).error).toBe("investigation failed");
  });
});

describe("resolveAgentId", () => {
  it("resolves the bound agent from the key via /self", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ agentId: "agent-9" }));
    await expect(resolveAgentId(config(), fetchImpl as typeof fetch)).resolves.toBe("agent-9");
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://sicore.example.com/api/v1/a2a/self");
  });

  it("tells the operator to pin SICLAW_AGENT_ID on an older Sicore", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: "A2A route not found" } }, 404));
    await expect(resolveAgentId(config(), fetchImpl as typeof fetch))
      .rejects.toThrow(/set SICLAW_AGENT_ID/);
  });

  it("propagates authentication failures without masking them", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      error: {
        status: "UNAUTHENTICATED",
        message: "A valid SiCore agent API key is required",
        details: [{ reason: "AUTHENTICATION_REQUIRED" }],
      },
    }, 401));
    const error = await resolveAgentId(config(), fetchImpl as typeof fetch).catch((value) => value as A2aClientError);
    expect(error).toBeInstanceOf(A2aClientError);
    expect(error.httpStatus).toBe(401);
    expect(error.reason).toBe("AUTHENTICATION_REQUIRED");
  });
});

describe("SicoreA2aClient", () => {
  it("sends the canonical text message without exposing the agent as tool input", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => jsonResponse({ task: task() }));
    const client = new SicoreA2aClient(config(), fetchImpl as typeof fetch);
    await client.sendMessage("check node", "context-1");

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://sicore.example.com/api/v1/a2a/agents/agent%2Fone/message:send");
    expect(init?.headers).toMatchObject({ authorization: "Bearer super-secret-key" });
    expect(JSON.parse(String(init?.body))).toEqual({
      message: {
        role: "ROLE_USER",
        parts: [{ text: "check node" }],
        contextId: "context-1",
      },
    });
  });

  it("maps A2A errors without including the bearer key", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      error: {
        status: "UNAUTHENTICATED",
        message: "A valid SiCore agent API key is required",
        details: [{ reason: "AUTHENTICATION_REQUIRED" }],
      },
    }, 401));
    const client = new SicoreA2aClient(config(), fetchImpl as typeof fetch);

    const error = await client.getTask("task-1").catch((value) => value as A2aClientError);
    expect(error).toBeInstanceOf(A2aClientError);
    expect(error.httpStatus).toBe(401);
    expect(error.reason).toBe("AUTHENTICATION_REQUIRED");
    expect(error.message).not.toContain("super-secret-key");
  });

  it("retries transient GET failures within one read timeout", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: "temporary" } }, 500))
      .mockResolvedValueOnce(new Response("not-json", { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ task: task("TASK_STATE_COMPLETED", "recovered") }));
    const client = new SicoreA2aClient(config(), fetchImpl as typeof fetch);

    await expect(client.getTask("task-1")).resolves.toMatchObject({ state: "completed", result: "recovered" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("bounds transient GET retries", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: "temporary" } }, 503));
    const client = new SicoreA2aClient(config(), fetchImpl as typeof fetch);

    await expect(client.getTask("task-1")).rejects.toBeInstanceOf(A2aClientError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("never retries task submission or cancellation", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: "temporary" } }, 503));
    const client = new SicoreA2aClient(config(), fetchImpl as typeof fetch);

    await expect(client.sendMessage("check node")).rejects.toBeInstanceOf(A2aClientError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await expect(client.cancelTask("task-1")).rejects.toBeInstanceOf(A2aClientError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("polls until a task becomes terminal", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ task: task() }))
      .mockResolvedValueOnce(jsonResponse({ task: task("TASK_STATE_COMPLETED", "done") }));
    const client = new SicoreA2aClient(config(), fetchImpl as typeof fetch);
    const result = await client.waitForTask("task-1", 1);
    expect(result.state).toBe("completed");
    expect(result.result).toBe("done");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps read retries inside the wait deadline and returns the last snapshot", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ task: task() }))
      .mockImplementationOnce(async (_url: string | URL | Request, init?: RequestInit) => (
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        })
      ));
    const client = new SicoreA2aClient(
      config({ requestTimeoutMs: 5_000, pollIntervalMs: 10 }),
      fetchImpl as typeof fetch,
    );

    const startedAt = Date.now();
    await expect(client.waitForTask("task-1", 0.05)).resolves.toMatchObject({ state: "working" });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("maps list and cancel routes", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ tasks: [task()], totalSize: 1, pageSize: 10, nextPageToken: "10" }))
      .mockResolvedValueOnce(jsonResponse({ task: task("TASK_STATE_CANCELED") }));
    const client = new SicoreA2aClient(config(), fetchImpl as typeof fetch);

    const list = await client.listTasks({ contextId: "context-1", status: "TASK_STATE_WORKING", pageSize: 10, pageToken: 0 });
    expect(list.total_size).toBe(1);
    expect(list.next_page_token).toBe(10);
    expect(String(fetchImpl.mock.calls[0][0])).toContain("contextId=context-1");
    expect(String(fetchImpl.mock.calls[0][0])).toContain("status=TASK_STATE_WORKING");

    expect((await client.cancelTask("task-1")).state).toBe("canceled");
    expect(String(fetchImpl.mock.calls[1][0])).toContain("/tasks/task-1:cancel");
  });
});
