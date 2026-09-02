import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { AddressInfo } from "node:net";
import {
  a2aTransportConfig,
  runA2aDelegation,
  __resetA2aThreads,
  type A2aTransportConfig,
} from "./delegate-a2a-transport.js";

type Route = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

let server: http.Server;
let cfg: A2aTransportConfig;
let routes: Map<string, Route>;
let requests: Array<{ path: string; body: string; auth?: string }>;

function sse(res: http.ServerResponse, frames: unknown[]): void {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`);
  res.end();
}

const workingTask = (id: string, state = "TASK_STATE_SUBMITTED") => ({
  task: { id, contextId: "ctx-1", status: { state }, metadata: { sessionId: "remote-s1" } },
});
const statusUpdate = (state: string, text = "", metadata: Record<string, unknown> = {}) => ({
  statusUpdate: { status: { state, message: { parts: [{ text }] } }, metadata },
});
const artifact = (text: string) => ({ artifactUpdate: { artifact: { parts: [{ text }] } } });

beforeEach(async () => {
  __resetA2aThreads();
  routes = new Map();
  requests = [];
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ path: req.url ?? "", body, auth: req.headers.authorization });
      const route = routes.get(req.url ?? "");
      if (!route) {
        res.writeHead(404).end();
        return;
      }
      route(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, () => r()));
  cfg = { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: "wk-test" };
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function baseArgs(observe: (evt: Record<string, unknown>) => void, signal?: AbortSignal) {
  return {
    cfg,
    peerAgentId: "peer-1",
    text: "diagnose the payment errors",
    localSessionId: "local-s1",
    delegationId: "d-1",
    signal: signal ?? new AbortController().signal,
    observe,
  };
}

describe("a2aTransportConfig", () => {
  it("is undefined unless the flag AND endpoint AND token are all set", () => {
    expect(a2aTransportConfig({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(a2aTransportConfig({ SICLAW_DELEGATION_TRANSPORT: "a2a" } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(
      a2aTransportConfig({
        SICLAW_DELEGATION_TRANSPORT: "a2a",
        SICLAW_INNER_A2A_URL: "http://cp:9000/",
        SICLAW_INNER_A2A_TOKEN: "wk-x",
      } as NodeJS.ProcessEnv),
    ).toEqual({ baseUrl: "http://cp:9000", token: "wk-x" });
  });
});

describe("runA2aDelegation", () => {
  it("translates a completed task into tool steps and a final message_end", async () => {
    routes.set("/inner/a2a/agents/peer-1/message:stream", (_req, res) =>
      sse(res, [
        workingTask("t1"),
        statusUpdate("TASK_STATE_WORKING", "Running tool: kubectl", { currentTool: "kubectl" }),
        artifact("root cause: "),
        artifact("PCIe link flap"),
        statusUpdate("TASK_STATE_COMPLETED", "done"),
      ]),
    );
    const events: Array<Record<string, unknown>> = [];
    const outcome = await runA2aDelegation(baseArgs((e) => events.push(e)));

    expect(outcome).toMatchObject({ taskId: "t1", remoteSessionId: "remote-s1" });
    expect(outcome.error).toBeUndefined();
    expect(events[0]).toEqual({ type: "tool_execution_end", toolName: "kubectl" });
    const done = events.at(-1) as any;
    expect(done.type).toBe("message_end");
    expect(done.message.content[0].text).toBe("root cause: PCIe link flap");
    expect(requests[0].auth).toBe("Bearer wk-test");
  });

  it("pauses on INPUT_REQUIRED and resumes the SAME task on the next leg", async () => {
    routes.set("/inner/a2a/agents/peer-1/message:stream", (_req, res) =>
      sse(res, [workingTask("t1"), statusUpdate("TASK_STATE_INPUT_REQUIRED", "Which cluster?")]),
    );
    const events: Array<Record<string, unknown>> = [];
    const first = await runA2aDelegation(baseArgs((e) => events.push(e)));
    expect(first.error).toBeUndefined();
    expect(events.at(-1)).toEqual({ type: "input_required", question: "Which cluster?" });

    // The answer leg: message:send with the WAITING task id, then subscribe.
    routes.set("/inner/a2a/agents/peer-1/message:send", (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ task: { id: "t1", status: { state: "TASK_STATE_WORKING" } } }));
    });
    routes.set("/inner/a2a/agents/peer-1/tasks/t1:subscribe", (_req, res) =>
      sse(res, [workingTask("t1", "TASK_STATE_WORKING"), artifact("answer for cluster-a"), statusUpdate("TASK_STATE_COMPLETED")]),
    );
    const second = await runA2aDelegation({ ...baseArgs((e) => events.push(e)), text: "cluster-a" });
    expect(second.error).toBeUndefined();
    const resume = requests.find((r) => r.path.endsWith("message:send"));
    const parsed = JSON.parse(resume!.body);
    expect(parsed.message.taskId).toBe("t1");
    expect(parsed.message.messageId).toBeTruthy(); // idempotency key always present
    expect(parsed.message.parts[0].text).toBe("cluster-a");
  });

  it("reuses the remote context for a follow-up on the same peer thread", async () => {
    routes.set("/inner/a2a/agents/peer-1/message:stream", (_req, res) =>
      sse(res, [workingTask("t1"), statusUpdate("TASK_STATE_COMPLETED")]),
    );
    await runA2aDelegation(baseArgs(() => {}));
    await runA2aDelegation({ ...baseArgs(() => {}), text: "follow up" });
    const second = JSON.parse(requests.at(-1)!.body);
    expect(second.message.contextId).toBe("ctx-1");
  });

  it("surfaces FAILED as a stream_error with the machine-readable detail", async () => {
    routes.set("/inner/a2a/agents/peer-1/message:stream", (_req, res) =>
      sse(res, [workingTask("t1"), statusUpdate("TASK_STATE_FAILED", "Input wait expired", { errorCode: "INPUT_TIMEOUT" })]),
    );
    const events: Array<Record<string, unknown>> = [];
    const outcome = await runA2aDelegation(baseArgs((e) => events.push(e)));
    expect(outcome.error).toBe("Input wait expired");
    expect((events.at(-1) as any).type).toBe("stream_error");
  });

  it("applies the redactor to every model-visible text", async () => {
    routes.set("/inner/a2a/agents/peer-1/message:stream", (_req, res) =>
      sse(res, [workingTask("t1"), artifact("token sk-secret123 leaked"), statusUpdate("TASK_STATE_COMPLETED")]),
    );
    const events: Array<Record<string, unknown>> = [];
    await runA2aDelegation({
      ...baseArgs((e) => events.push(e)),
      redact: (t) => t.replaceAll("sk-secret123", "[REDACTED]"),
    });
    const done = events.at(-1) as any;
    expect(done.message.content[0].text).toContain("[REDACTED]");
    expect(JSON.stringify(events)).not.toContain("sk-secret123");
  });

  it("cancels the remote task when the coordinator aborts mid-stream", async () => {
    let cancelHit = false;
    routes.set("/inner/a2a/agents/peer-1/message:stream", (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify(workingTask("t1"))}\n\n`);
      // never ends — the abort has to break the read
    });
    routes.set("/inner/a2a/agents/peer-1/tasks/t1:cancel", (_req, res) => {
      cancelHit = true;
      res.writeHead(200).end("{}");
    });
    const ac = new AbortController();
    const done = runA2aDelegation(baseArgs(() => {}, ac.signal));
    await new Promise((r) => setTimeout(r, 100));
    ac.abort();
    const outcome = await done;
    expect(outcome.stopped).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(cancelHit).toBe(true);
  });
});
