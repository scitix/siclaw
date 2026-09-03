import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import { AddressInfo } from "node:net";
import {
  a2aTransportConfig,
  runA2aDelegation,
  stableMessageId,
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
  const env = (extra: Record<string, string>) => extra as unknown as NodeJS.ProcessEnv;

  it("is undefined only when the flag is deliberately off", () => {
    expect(a2aTransportConfig(env({}))).toBeUndefined();
    expect(a2aTransportConfig(env({ SICLAW_DELEGATION_TRANSPORT: "legacy" }))).toBeUndefined();
  });

  it("accepts a fully configured https endpoint", () => {
    expect(a2aTransportConfig(env({
      SICLAW_DELEGATION_TRANSPORT: "a2a",
      SICLAW_INNER_A2A_URL: "https://cp:9000/",
      SICLAW_INNER_A2A_TOKEN: "wk-x",
    }))).toEqual({ baseUrl: "https://cp:9000", token: "wk-x" });
  });

  it("THROWS instead of silently downgrading when the flag is on but incomplete", () => {
    // The previous behaviour returned undefined and logged a warning, so the
    // operator who set the flag ran on the legacy relay believing otherwise.
    expect(() => a2aTransportConfig(env({ SICLAW_DELEGATION_TRANSPORT: "a2a" }))).toThrow(/requires both/);
    expect(() => a2aTransportConfig(env({
      SICLAW_DELEGATION_TRANSPORT: "a2a",
      SICLAW_INNER_A2A_URL: "https://cp:9000",
    }))).toThrow(/requires both/);
    expect(() => a2aTransportConfig(env({
      SICLAW_DELEGATION_TRANSPORT: "a2a",
      SICLAW_INNER_A2A_TOKEN: "wk-x",
    }))).toThrow(/requires both/);
    expect(() => a2aTransportConfig(env({
      SICLAW_DELEGATION_TRANSPORT: "a2a",
      SICLAW_INNER_A2A_URL: "not a url",
      SICLAW_INNER_A2A_TOKEN: "wk-x",
    }))).toThrow(/not a valid URL/);
  });

  it("refuses a plaintext base URL unless the escape hatch is set", () => {
    const plaintext = {
      SICLAW_DELEGATION_TRANSPORT: "a2a",
      SICLAW_INNER_A2A_URL: "http://cp:9000",
      SICLAW_INNER_A2A_TOKEN: "wk-x",
    };
    expect(() => a2aTransportConfig(env(plaintext))).toThrow(/must use https/);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(a2aTransportConfig(env({ ...plaintext, SICLAW_INNER_A2A_ALLOW_PLAINTEXT: "1" })))
      .toEqual({ baseUrl: "http://cp:9000", token: "wk-x" });
    // The escape hatch announces itself so it cannot become the silent norm.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("plaintext"));
    warn.mockRestore();
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

  it("harvests the answer from a terminal snapshot when the turn finished before subscribe", async () => {
    // Leg 1 parks the thread on a question.
    routes.set("/inner/a2a/agents/peer-1/message:stream", (_req, res) =>
      sse(res, [workingTask("t1"), statusUpdate("TASK_STATE_INPUT_REQUIRED", "Which cluster?")]),
    );
    await runA2aDelegation(baseArgs(() => {}));

    // Leg 2: the resumed turn completes BEFORE the subscribe attaches — the
    // stream's only frame is a terminal task snapshot carrying the artifacts.
    routes.set("/inner/a2a/agents/peer-1/message:send", (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ task: { id: "t1", status: { state: "TASK_STATE_WORKING" } } }));
    });
    routes.set("/inner/a2a/agents/peer-1/tasks/t1:subscribe", (_req, res) =>
      sse(res, [
        {
          task: {
            id: "t1", contextId: "ctx-1",
            status: { state: "TASK_STATE_COMPLETED" },
            metadata: { sessionId: "remote-s1" },
            artifacts: [{ parts: [{ text: "fast answer for cluster-a" }] }],
          },
        },
      ]),
    );
    const events: Array<Record<string, unknown>> = [];
    const outcome = await runA2aDelegation({ ...baseArgs((e) => events.push(e)), text: "cluster-a" });
    expect(outcome.error).toBeUndefined();
    const done = events.at(-1) as any;
    expect(done.type).toBe("message_end");
    expect(done.message.content[0].text).toBe("fast answer for cluster-a");
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

  // ── #8 fast completion: no subscribe on an already-terminal task ──────────
  it("short-circuits on a terminal task in the message:send body, without subscribing", async () => {
    // Park the thread on a question first.
    routes.set("/inner/a2a/agents/peer-1/message:stream", (_req, res) =>
      sse(res, [workingTask("t1"), statusUpdate("TASK_STATE_INPUT_REQUIRED", "Which cluster?")]),
    );
    await runA2aDelegation(baseArgs(() => {}));

    // The resume itself answers with the finished task: a short answer settled
    // before we could attach. Subscribing on a terminal task is answered 400
    // UNSUPPORTED_OPERATION, which used to be reported as a delegation failure.
    routes.set("/inner/a2a/agents/peer-1/message:send", (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        task: {
          id: "t1", contextId: "ctx-1",
          status: { state: "TASK_STATE_COMPLETED" },
          metadata: { sessionId: "remote-s1" },
          artifacts: [{ parts: [{ text: "settled instantly" }] }],
        },
      }));
    });
    const events: Array<Record<string, unknown>> = [];
    const outcome = await runA2aDelegation({ ...baseArgs((e) => events.push(e)), text: "cluster-a" });

    expect(outcome.error).toBeUndefined();
    expect(outcome).toMatchObject({ taskId: "t1", remoteSessionId: "remote-s1" });
    expect((events.at(-1) as any).message.content[0].text).toBe("settled instantly");
    expect(requests.some((r) => r.path.includes(":subscribe"))).toBe(false);
  });

  it("falls back to GET /tasks/{id} when subscribe refuses with 400", async () => {
    routes.set("/inner/a2a/agents/peer-1/message:stream", (_req, res) =>
      sse(res, [workingTask("t1"), statusUpdate("TASK_STATE_INPUT_REQUIRED", "Which cluster?")]),
    );
    await runA2aDelegation(baseArgs(() => {}));

    // Resume acks non-terminal, then the task settles in the gap before subscribe.
    routes.set("/inner/a2a/agents/peer-1/message:send", (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ task: { id: "t1", status: { state: "TASK_STATE_WORKING" } } }));
    });
    routes.set("/inner/a2a/agents/peer-1/tasks/t1:subscribe", (_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: "UNSUPPORTED_OPERATION" } }));
    });
    routes.set("/inner/a2a/agents/peer-1/tasks/t1", (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        task: {
          id: "t1", contextId: "ctx-1",
          status: { state: "TASK_STATE_COMPLETED" },
          metadata: { sessionId: "remote-s1" },
          artifacts: [{ parts: [{ text: "read from the durable projection" }] }],
        },
      }));
    });
    const events: Array<Record<string, unknown>> = [];
    const outcome = await runA2aDelegation({ ...baseArgs((e) => events.push(e)), text: "cluster-a" });

    expect(outcome.error).toBeUndefined();
    expect((events.at(-1) as any).message.content[0].text).toBe("read from the durable projection");
  });

  // ── #9 bridge recovery ────────────────────────────────────────────────────
  it("sends a STABLE messageId, identical across two attempts with the same input", async () => {
    let attempt = 0;
    routes.set("/inner/a2a/agents/peer-1/message:stream", (_req, res) => {
      attempt += 1;
      if (attempt === 1) {
        // First attempt dies mid-stream, so the caller retries the same open.
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end();
        return;
      }
      sse(res, [workingTask("t1"), statusUpdate("TASK_STATE_COMPLETED")]);
    });
    routes.set("/inner/a2a/agents/peer-1/tasks/t1", (_req, res) => res.writeHead(404).end());

    await runA2aDelegation(baseArgs(() => {}));
    __resetA2aThreads(); // simulate the retry starting from a cold map
    await runA2aDelegation(baseArgs(() => {}));

    const opens = requests.filter((r) => r.path.endsWith("message:stream")).map((r) => JSON.parse(r.body));
    expect(opens).toHaveLength(2);
    expect(opens[0].message.messageId).toBeTruthy();
    // Same delegation + same text ⇒ the same idempotency key, so a retried open
    // cannot create a second task. (The old code sent randomUUID() each time,
    // which meant the key could never match and replay protection was dead.)
    expect(opens[0].message.messageId).toBe(opens[1].message.messageId);
    expect(opens[0].message.messageId).toBe(stableMessageId(["d-1", "open", undefined, "diagnose the payment errors"]));
  });

  it("uses a stable, task-scoped messageId on a resume too", async () => {
    routes.set("/inner/a2a/agents/peer-1/message:stream", (_req, res) =>
      sse(res, [workingTask("t1"), statusUpdate("TASK_STATE_INPUT_REQUIRED", "Which cluster?")]),
    );
    await runA2aDelegation(baseArgs(() => {}));
    routes.set("/inner/a2a/agents/peer-1/message:send", (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ task: { id: "t1", status: { state: "TASK_STATE_COMPLETED" } } }));
    });
    await runA2aDelegation({ ...baseArgs(() => {}), text: "cluster-a" });
    const resume = JSON.parse(requests.find((r) => r.path.endsWith("message:send"))!.body);
    expect(resume.message.messageId).toBe(stableMessageId(["d-1", "t1", "cluster-a"]));
  });

  it("recovers a lost continuation by adopting a parked task from the listing", async () => {
    // Leg 1 establishes the remote context.
    routes.set("/inner/a2a/agents/peer-1/message:stream", (_req, res) =>
      sse(res, [workingTask("t1"), statusUpdate("TASK_STATE_COMPLETED")]),
    );
    await runA2aDelegation(baseArgs(() => {}));

    // The peer later parked on a question, but this process never saw that frame
    // (restart, dropped stream). The control plane's listing is authoritative:
    // parked tasks appear under the `working` filter.
    routes.set("/inner/a2a/agents/peer-1/tasks?contextId=ctx-1&status=working", (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        tasks: [
          { id: "t-other", status: { state: "TASK_STATE_WORKING" } },
          { id: "t-parked", status: { state: "TASK_STATE_INPUT_REQUIRED" } },
        ],
      }));
    });
    routes.set("/inner/a2a/agents/peer-1/message:send", (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        task: {
          id: "t-parked", contextId: "ctx-1",
          status: { state: "TASK_STATE_COMPLETED" },
          artifacts: [{ parts: [{ text: "resumed the parked task" }] }],
        },
      }));
    });

    const events: Array<Record<string, unknown>> = [];
    const outcome = await runA2aDelegation({ ...baseArgs((e) => events.push(e)), text: "cluster-a" });

    expect(outcome.error).toBeUndefined();
    // It resumed the parked task rather than opening a brand-new one.
    const resume = requests.find((r) => r.path.endsWith("message:send"));
    expect(JSON.parse(resume!.body).message.taskId).toBe("t-parked");
    expect(requests.filter((r) => r.path.endsWith("message:stream"))).toHaveLength(1);
    expect((events.at(-1) as any).message.content[0].text).toBe("resumed the parked task");
  });

  it("opens a new task when the listing has nothing parked to adopt", async () => {
    routes.set("/inner/a2a/agents/peer-1/message:stream", (_req, res) =>
      sse(res, [workingTask("t1"), statusUpdate("TASK_STATE_COMPLETED")]),
    );
    await runA2aDelegation(baseArgs(() => {}));
    routes.set("/inner/a2a/agents/peer-1/tasks?contextId=ctx-1&status=working", (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ tasks: [] }));
    });
    const outcome = await runA2aDelegation({ ...baseArgs(() => {}), text: "follow up" });
    expect(outcome.error).toBeUndefined();
    expect(requests.filter((r) => r.path.endsWith("message:stream"))).toHaveLength(2);
    expect(requests.some((r) => r.path.endsWith("message:send"))).toBe(false);
  });

  it("GETs the task when the stream ends without a terminal frame", async () => {
    // The comment promised this fallback; the code used to just error out while
    // the answer sat readable on the durable side.
    routes.set("/inner/a2a/agents/peer-1/message:stream", (_req, res) =>
      sse(res, [workingTask("t1"), artifact("partial…")]),
    );
    routes.set("/inner/a2a/agents/peer-1/tasks/t1", (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        task: {
          id: "t1", contextId: "ctx-1",
          status: { state: "TASK_STATE_COMPLETED" },
          metadata: { sessionId: "remote-s1" },
        },
      }));
    });
    const events: Array<Record<string, unknown>> = [];
    const outcome = await runA2aDelegation(baseArgs((e) => events.push(e)));
    expect(outcome.error).toBeUndefined();
    expect(requests.some((r) => r.path === "/inner/a2a/agents/peer-1/tasks/t1")).toBe(true);
    // What DID stream is kept rather than discarded.
    expect((events.at(-1) as any).message.content[0].text).toBe("partial…");
  });

  it("still reports an error when the stream drops AND the task cannot be read", async () => {
    routes.set("/inner/a2a/agents/peer-1/message:stream", (_req, res) => sse(res, [workingTask("t1")]));
    routes.set("/inner/a2a/agents/peer-1/tasks/t1", (_req, res) => res.writeHead(503).end());
    const outcome = await runA2aDelegation(baseArgs(() => {}));
    expect(outcome.error).toBe("delegation stream ended before a terminal state");
  });

  // ── #11 on-behalf-of identity + evidence refs ─────────────────────────────
  it("sends onBehalfOfUserId on BOTH the open and the resume bodies", async () => {
    routes.set("/inner/a2a/agents/peer-1/message:stream", (_req, res) =>
      sse(res, [workingTask("t1"), statusUpdate("TASK_STATE_INPUT_REQUIRED", "Which cluster?")]),
    );
    await runA2aDelegation({ ...baseArgs(() => {}), onBehalfOfUserId: "user-42" });
    routes.set("/inner/a2a/agents/peer-1/message:send", (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ task: { id: "t1", status: { state: "TASK_STATE_COMPLETED" } } }));
    });
    await runA2aDelegation({ ...baseArgs(() => {}), text: "cluster-a", onBehalfOfUserId: "user-42" });

    const open = JSON.parse(requests.find((r) => r.path.endsWith("message:stream"))!.body);
    const resume = JSON.parse(requests.find((r) => r.path.endsWith("message:send"))!.body);
    expect(open.metadata["siclaw.onBehalfOfUserId"]).toBe("user-42");
    expect(resume.metadata["siclaw.onBehalfOfUserId"]).toBe("user-42");
  });

  it("OMITS onBehalfOfUserId when the originating user is unknown — never a placeholder", async () => {
    routes.set("/inner/a2a/agents/peer-1/message:stream", (_req, res) =>
      sse(res, [workingTask("t1"), statusUpdate("TASK_STATE_COMPLETED")]),
    );
    await runA2aDelegation(baseArgs(() => {}));
    const open = JSON.parse(requests.find((r) => r.path.endsWith("message:stream"))!.body);
    expect("siclaw.onBehalfOfUserId" in open.metadata).toBe(false);
  });

  it("carries evidence_refs as a data part, not inlined bytes", async () => {
    routes.set("/inner/a2a/agents/peer-1/message:stream", (_req, res) =>
      sse(res, [workingTask("t1"), statusUpdate("TASK_STATE_COMPLETED")]),
    );
    await runA2aDelegation({ ...baseArgs(() => {}), evidenceRefs: ["trace://t1", "metric://m2"] });
    const open = JSON.parse(requests.find((r) => r.path.endsWith("message:stream"))!.body);
    expect(open.message.parts[0]).toEqual({ text: "diagnose the payment errors" });
    expect(open.message.parts[1]).toEqual({
      data: { evidence_refs: ["trace://t1", "metric://m2"] },
      mediaType: "application/vnd.siclaw.context+json",
    });
  });

  it("sends only the text part when there are no evidence refs", async () => {
    routes.set("/inner/a2a/agents/peer-1/message:stream", (_req, res) =>
      sse(res, [workingTask("t1"), statusUpdate("TASK_STATE_COMPLETED")]),
    );
    await runA2aDelegation(baseArgs(() => {}));
    const open = JSON.parse(requests.find((r) => r.path.endsWith("message:stream"))!.body);
    expect(open.message.parts).toHaveLength(1);
  });
});
