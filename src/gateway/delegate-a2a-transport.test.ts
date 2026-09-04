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
      requests.push({
        path: req.url ?? "",
        body,
        auth: req.headers["x-auth-token"] as string | undefined,
        caller: req.headers["x-siclaw-caller-agent"] as string | undefined,
      });
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
    coordinatorAgentId: "coord-1",
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

  it("reuses the Runtime's OWN endpoint and adapter secret", () => {
    // The point of this shape: there is nothing delegation-specific to
    // configure, so it cannot be pointed at the wrong control plane or handed a
    // stale token. It used to demand three variables of its own because the
    // entrance authenticated a separate workload identity; that identity is gone.
    expect(a2aTransportConfig(env({
      SICLAW_DELEGATION_TRANSPORT: "a2a",
      SICLAW_SERVER_URL: "http://control-plane-adapter:8081/",
      SICLAW_PORTAL_SECRET: "adapter-secret",
    }))).toEqual({ baseUrl: "http://control-plane-adapter:8081", token: "adapter-secret" });
  });

  it("accepts plain HTTP: the adapter listener is ClusterIP-only and the WS already rides it", () => {
    // There is deliberately no https requirement and no escape hatch. Demanding
    // TLS here while the control-plane WS runs over the same plain channel would
    // have been theatre whose only real effect was an env var people set.
    expect(a2aTransportConfig(env({
      SICLAW_DELEGATION_TRANSPORT: "a2a",
      SICLAW_SERVER_URL: "http://control-plane-adapter:8081",
      SICLAW_PORTAL_SECRET: "s",
    }))).toEqual({ baseUrl: "http://control-plane-adapter:8081", token: "s" });
  });

  it("THROWS instead of silently downgrading when the flag is on but the Runtime is unconfigured", () => {
    // The previous behaviour returned undefined and logged a warning, so the
    // operator who set the flag ran on the legacy relay believing otherwise.
    expect(() => a2aTransportConfig(env({ SICLAW_DELEGATION_TRANSPORT: "a2a" }))).toThrow(/requires the Runtime/);
    expect(() => a2aTransportConfig(env({
      SICLAW_DELEGATION_TRANSPORT: "a2a",
      SICLAW_SERVER_URL: "http://cp:8081",
    }))).toThrow(/requires the Runtime/);
    expect(() => a2aTransportConfig(env({
      SICLAW_DELEGATION_TRANSPORT: "a2a",
      SICLAW_PORTAL_SECRET: "s",
    }))).toThrow(/requires the Runtime/);
    expect(() => a2aTransportConfig(env({
      SICLAW_DELEGATION_TRANSPORT: "a2a",
      SICLAW_SERVER_URL: "not a url",
      SICLAW_PORTAL_SECRET: "s",
    }))).toThrow(/not a valid URL/);
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
    // ⚠️ A WORKING statusUpdate is NO LONGER a tool event. It fires on both the
    // start and the end of a call and is identical both times, so translating it
    // into `tool_execution_end` made every tool appear twice and always
    // finished. Against a control plane that sends only these, a delegation now
    // degrades to "no step detail" rather than to "each tool ran twice".
    expect(events.filter((e) => String(e.type).startsWith("tool_execution"))).toEqual([]);
    const done = events.at(-1) as any;
    expect(done.type).toBe("message_end");
    expect(done.message.content[0].text).toBe("root cause: PCIe link flap");
    // 认证换成 Runtime 自己的 adapter secret,并显式声明是哪个 coordinator 在调 ——
    // 后者是断言,由控制面对着 siclaw_agents.runtime_id 校验,再由它决定名册问题。
    expect(requests[0].auth).toBe("wk-test");
    expect(requests[0].caller).toBe("coord-1");
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
  // ⚠️ on-behalf-of 整个概念已经没了。它当初是为被删掉的 workload 身份服务的:
  // 一个平台组件代表某个人发起委托,所以要声明"这一轮算谁头上"。现在发起方**就是
  // 一个 agent**,归属由 coordinator 自身携带,不需要也不接受这个断言。
  //
  // 控制面侧的对应实现也一并删掉了 —— 它允许同组织内任意成员被冒充,
  // 而那正是它被拿掉的原因之一。
  // 新的保真路径:控制面按 toolCallId 去重后,每次"变化"发一帧 toolCall,
  // 传输把它翻译成 box 侧翻译器已经能解析的那套富事件。
  it("translates toolCall frames into rich start/end events", async () => {
    const toolCall = (call: Record<string, unknown>) => ({ toolCall: { taskId: "t1", call } });
    routes.set("/inner/a2a/agents/peer-1/message:stream", (_req, res) =>
      sse(res, [
        workingTask("t1"),
        toolCall({ toolCallId: "c1", toolName: "kubectl", phase: "running", input: '{"ns":"default"}' }),
        toolCall({ toolCallId: "c1", toolName: "kubectl", phase: "success", output: "5 nodes", durationMs: 1200 }),
        statusUpdate("TASK_STATE_COMPLETED", "done"),
      ]),
    );
    const events: Array<Record<string, unknown>> = [];
    await runA2aDelegation(baseArgs((e) => events.push(e)));

    const tools = events.filter((e) => String(e.type).startsWith("tool_execution"));
    // 一次调用两帧 → 一个 start + 一个 end,配对靠 toolCallId。
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({
      type: "tool_execution_start", toolCallId: "c1", toolName: "kubectl", args: '{"ns":"default"}',
    });
    expect(tools[1]).toMatchObject({
      type: "tool_execution_end", toolCallId: "c1", toolName: "kubectl", isError: false, durationMs: 1200,
    });
    // 结果文本是 box 侧翻译器构造 DelegateStep.content 的来源。
    expect((tools[1] as any).result.content[0].text).toBe("5 nodes");
  });

  // 失败的工具必须显示为失败,而不是中性完成。
  it("marks a failed tool call as an error", async () => {
    routes.set("/inner/a2a/agents/peer-1/message:stream", (_req, res) =>
      sse(res, [
        workingTask("t1"),
        { toolCall: { taskId: "t1", call: { toolCallId: "c1", toolName: "bash", phase: "error", output: "boom" } } },
        statusUpdate("TASK_STATE_COMPLETED", "done"),
      ]),
    );
    const events: Array<Record<string, unknown>> = [];
    await runA2aDelegation(baseArgs((e) => events.push(e)));
    const end = events.find((e) => e.type === "tool_execution_end") as any;
    expect(end.isError).toBe(true);
  });

  // 工具结果也过脱敏 —— 它和参数是链路上风险最高的载荷。
  it("redacts tool output before the coordinator's model sees it", async () => {
    routes.set("/inner/a2a/agents/peer-1/message:stream", (_req, res) =>
      sse(res, [
        workingTask("t1"),
        { toolCall: { taskId: "t1", call: { toolCallId: "c1", toolName: "bash", phase: "success", output: "key=sk-secret123" } } },
        statusUpdate("TASK_STATE_COMPLETED", "done"),
      ]),
    );
    const events: Array<Record<string, unknown>> = [];
    await runA2aDelegation({ ...baseArgs((e) => events.push(e)), redact: (t) => t.replace(/sk-\S+/g, "[redacted]") });
    expect(JSON.stringify(events)).not.toContain("sk-secret123");
  });

  it("carries the delegation marker on BOTH the open and the resume", async () => {
    routes.set("/inner/a2a/agents/peer-1/message:stream", (_req, res) =>
      sse(res, [workingTask("t1"), statusUpdate("TASK_STATE_INPUT_REQUIRED", "Which cluster?")]),
    );
    await runA2aDelegation(baseArgs(() => {}));
    routes.set("/inner/a2a/agents/peer-1/message:send", (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ task: { id: "t1", status: { state: "TASK_STATE_COMPLETED" } } }));
    });
    await runA2aDelegation({ ...baseArgs(() => {}), text: "cluster-a" });

    const open = JSON.parse(requests.find((r) => r.path.endsWith("message:stream"))!.body);
    const resume = JSON.parse(requests.find((r) => r.path.endsWith("message:send"))!.body);
    // 续跑也必须带 —— 只在首轮带的话,peer 的第二轮就不再是委托 turn,
    // report_findings / request_input 随之失效。
    expect(open.metadata["siclaw.delegationId"]).toBe("d-1");
    expect(resume.metadata["siclaw.delegationId"]).toBe("d-1");
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
