import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { PiAgentBrain } from "./brains/pi-agent-brain.js";
import { createPiExecutionSession } from "./pi-execution.js";
import { summarizeWithFallback } from "./compaction.js";
import { resolveSessionThinkingLevel } from "./session-thinking.js";
import { skillsHandler, knowledgeHandler } from "../agentbox/sync-handlers.js";

// Exercise installed Pi packages through the real HTTP serializer and agent loop.
// Only the network boundary is replaced; no SDK classes or events are mocked.
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllGlobals();
});

function completion(delta: Record<string, unknown>, finishReason = "stop"): Response {
  const chunk = {
    id: "response-test", object: "chat.completion.chunk", created: 1, model: "contract-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
  };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

function resultCall(name = "submit_result"): Response {
  return completion({ tool_calls: [{
    index: 0, id: "call-result", type: "function",
    function: { name, arguments: JSON.stringify({ answer: "accepted" }) },
  }] }, "tool_calls");
}

function mockNetwork(respond: (request: Request, body: any) => Response | Promise<Response>) {
  const requests: Array<{ request: Request; body: any }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    expect(new URL(request.url).hostname).toBe("pi-contract.invalid");
    const body = JSON.parse(await request.text());
    requests.push({ request, body });
    return respond(request, body);
  });
  return requests;
}

async function createFixture(
  customTools: ToolDefinition[] = [],
  fixtureSettings: Parameters<typeof SettingsManager.inMemory>[0] = {},
) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "siclaw-pi-contract-"));
  cleanups.push(() => fs.rm(cwd, { recursive: true, force: true }));
  const modelsPath = path.join(cwd, "models.json");
  await fs.writeFile(modelsPath, JSON.stringify({ providers: { "contract-provider": {
    baseUrl: "https://pi-contract.invalid/v1", api: "openai-completions",
    apiKey: "configured-key",
    headers: { "x-remove-me": "default-value" },
    models: [{
      id: "contract-model", name: "Contract model", reasoning: false, input: ["text"],
      contextWindow: 128_000, maxTokens: 2048,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  } } }));
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath,
    modelsStorePath: path.join(cwd, "models-cache.json"), refreshOnCreate: false,
  });
  await modelRuntime.setRuntimeApiKey("contract-provider", "contract-key");
  const model = modelRuntime.getModel("contract-provider", "contract-model")!;
  const sessionStarts = vi.fn();
  const services = await createAgentSessionServices({
    cwd, agentDir: cwd, modelRuntime,
    settingsManager: SettingsManager.inMemory({
      retry: { enabled: false },
      compaction: { enabled: false, reserveTokens: 2048, keepRecentTokens: 1 },
      ...fixtureSettings,
    }),
    resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true,
      noThemes: true, noContextFiles: true, systemPrompt: "Exercise the supplied tools.",
      extensionFactories: [api => { api.on("session_start", sessionStarts); }],
    },
  });
  const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
  const onModelEnvelope = vi.fn();
  const { session, llmCallRecorder, modelEnvelopeInspectionRef } = await createPiExecutionSession({
    services, sessionManager, model, customTools, onModelEnvelope,
    thinkingLevel: resolveSessionThinkingLevel(services.settingsManager, model),
  });
  cleanups.push(() => session.dispose());
  const brain = new PiAgentBrain(session, new Map(), llmCallRecorder);
  return { brain, session, sessionManager, model, services, modelRuntime, onModelEnvelope, modelEnvelopeInspectionRef, sessionStarts };
}

function resultTool(execute = vi.fn(async () => ({
  content: [{ type: "text" as const, text: "accepted" }],
  details: { structuredContent: { answer: "accepted" } },
}))): ToolDefinition {
  return {
    name: "submit_result", label: "Submit result", description: "Submit the result.",
    parameters: Type.Object({ answer: Type.String() }), execute,
  };
}

describe("installed Pi SDK contract", () => {
  it("retains the requested default effort when a reasoning model is bound after bootstrap", async () => {
    const requests = mockNetwork(() => completion({ content: "Completed." }));
    const { brain, session, services, modelRuntime } = await createFixture();
    // A bootstrap model without reasoning support clamps the initial high to off.
    expect(session.thinkingLevel).toBe("off");
    modelRuntime.registerProvider("late-provider", {
      baseUrl: "https://pi-contract.invalid/v1", api: "openai-completions", apiKey: "contract-key",
      models: [{ id: "late-reasoner", name: "Late reasoner", reasoning: true,
        input: ["text"], contextWindow: 128_000, maxTokens: 2048,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    });
    await modelRuntime.setRuntimeApiKey("late-provider", "contract-key");
    const model = modelRuntime.getModel("late-provider", "late-reasoner")!;
    await brain.setModel(model);
    expect(session.thinkingLevel).toBe("high");
    await brain.prompt("Confirm readiness.");
    expect(requests.at(-1)?.body.reasoning_effort).toBe("high");
    // Session defaults must not silently become a global user preference.
    expect(services.settingsManager.getGlobalSettings().defaultThinkingLevel).toBeUndefined();
    // An explicit routing override still wins after binding the model.
    brain.applyModelParams({ reasoningEffort: "low" });
    await brain.prompt("Confirm with the requested effort.");
    expect(requests.at(-1)?.body.reasoning_effort).toBe("low");
  });

  it.each([
    { defaultThinkingLevel: "off" as const, expected: "off" },
    { defaultThinkingLevel: "low" as const, expected: "low" },
    { defaultThinkingLevel: "high" as const,
      modelThinkingLevels: { "contract-provider/contract-model": "medium" as const }, expected: "medium" },
  ])("respects configured thinking defaults: $expected", async ({ expected, ...settings }) => {
    const { session, services, model } = await createFixture([], settings);
    expect(session.thinkingLevel).toBe("off"); // model capabilities remain authoritative
    expect(resolveSessionThinkingLevel(services.settingsManager, model)).toBe(expected);
    expect(services.settingsManager.getGlobalSettings().defaultThinkingLevel).toBe(settings.defaultThinkingLevel);
  });

  it.each([skillsHandler, knowledgeHandler])(
    "preserves an in-flight tool context across $type resource updates",
    async (handler) => {
      const requests = mockNetwork(() => requests.length === 1
        ? resultCall() : completion({ content: "Completed." }));
      let started!: () => void;
      let finish!: () => void;
      const ready = new Promise<void>(resolve => { started = resolve; });
      const gate = new Promise<void>(resolve => { finish = resolve; });
      const tool: ToolDefinition = {
        ...resultTool(),
        async execute(_id, _args, _signal, _update, ctx) {
          started();
          await gate;
          // The actual SDK checks this captured context after reload. A fake
          // brain cannot detect the stale context that loses the tool result.
          ctx.getContextUsage();
          return { content: [{ type: "text", text: "accepted" }], details: { accepted: true } };
        },
      };
      const { brain, session, sessionManager } = await createFixture([tool]);
      const events: any[] = [];
      brain.subscribe(event => events.push(event));
      const invalidate = vi.fn();
      const prompt = brain.prompt("Submit an answer.");
      try {
        await ready;
        await handler.postReload!({ sessions: [{ id: session.sessionId, brain, invalidate }] });
      } finally {
        finish();
        await prompt;
      }
      expect(events.find(e => e.type === "tool_execution_end")).toMatchObject({
        isError: false, result: { details: { accepted: true } },
      });
      expect(invalidate).toHaveBeenCalledOnce();
      const reopened = SessionManager.open(sessionManager.getSessionFile()!);
      expect(reopened.buildSessionContext().messages.find(m => m.role === "toolResult"))
        .toMatchObject({ isError: false, content: [{ type: "text", text: "accepted" }] });
    },
  );

  it("preserves guards, payload hooks, tool events, timing and persisted checkpoints", async () => {
    const requests = mockNetwork(() => requests.length === 1
      ? resultCall(" submit_result ") : completion({ content: "Completed." }));
    const tool = resultTool();
    const { brain, session, sessionManager, onModelEnvelope, modelEnvelopeInspectionRef, sessionStarts } = await createFixture([tool]);
    expect(sessionStarts).toHaveBeenCalledTimes(1);
    const payloads: unknown[] = [];
    const previousOnPayload = session.agent.onPayload;
    session.agent.onPayload = (payload, model) => {
      payloads.push(payload);
      return previousOnPayload?.(payload, model);
    };
    const events: any[] = [];
    brain.subscribe(event => events.push(event));

    await brain.prompt("Submit an answer.");

    expect(session.getActiveToolNames()).toEqual(["submit_result"]);
    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
    expect(requests[0].request.headers.get("authorization")).toBe("Bearer contract-key");
    expect(payloads).toHaveLength(2);
    expect(onModelEnvelope).toHaveBeenCalledTimes(1);
    expect(modelEnvelopeInspectionRef.current?.systemPrompt).toContain("Exercise the supplied tools.");
    expect(requests[1].body.messages.some((m: any) => m.role === "tool")).toBe(true);
    const assistants = events.filter(e => e.type === "message_end" && e.message.role === "assistant");
    expect(assistants).toHaveLength(2);
    expect(assistants.map(e => e.message.llmCall?.round)).toEqual([1, 2]);
    expect(assistants[0].message.llmCall.usage.total).toBe(25);
    expect(events.find(e => e.type === "tool_execution_end")).toMatchObject({ isError: false });

    const checkpoint = brain.createPromptCheckpoint();
    await brain.prompt("A later attempt.");
    brain.restorePromptCheckpoint(checkpoint);
    expect(JSON.stringify(session.messages)).not.toContain("A later attempt.");
    // Branch selection is persisted with the next entry, just as routing does
    // when a rejected attempt is followed by the accepted retry.
    await brain.prompt("Continue from the accepted checkpoint.");
    expect(JSON.stringify(requests.at(-1)!.body)).not.toContain("A later attempt.");
    const reopened = SessionManager.open(sessionManager.getSessionFile()!);
    expect(reopened.buildSessionContext().messages).toEqual(JSON.parse(JSON.stringify(session.messages)));
    expect(reopened.buildSessionContext().messages.map(m => m.role)).toEqual([
      "user", "assistant", "toolResult", "assistant", "user", "assistant",
    ]);
  });

  it("forces a required result on the actual repair request and restores active tools", async () => {
    const requests = mockNetwork(() => requests.length === 2
      ? resultCall() : completion({ content: "Completed." }));
    const { brain, session } = await createFixture([resultTool()]);
    const original = session.agent.streamFunction;
    await brain.prompt("Submit an answer.", undefined, { requiredResultToolName: "submit_result" });
    expect(requests).toHaveLength(3);
    expect(requests[1].body.tool_choice).toEqual({ type: "function", function: { name: "submit_result" } });
    expect(session.agent.streamFunction).toBe(original);
    expect(session.getActiveToolNames()).toEqual(["submit_result"]);
  });

  it("blocks mixed handoff calls before either tool can execute", async () => {
    const requests = mockNetwork(() => requests.length === 1 ? completion({ tool_calls: [
      { index: 0, id: "call-transfer", type: "function", function: { name: "transfer_to_agent", arguments: "{}" } },
      { index: 1, id: "call-result", type: "function", function: { name: "submit_result", arguments: '{"answer":"accepted"}' } },
    ] }, "tool_calls") : completion({ content: "I will reconsider." }));
    const transfer = { ...resultTool(), name: "transfer_to_agent", parameters: Type.Object({}) };
    const submit = resultTool();
    const { brain } = await createFixture([transfer, submit]);
    await brain.prompt("Hand off and submit together.");
    expect(transfer.execute).not.toHaveBeenCalled();
    expect(submit.execute).not.toHaveBeenCalled();
    expect(requests).toHaveLength(2);
    expect(requests[1].body.messages.filter((m: any) => m.role === "tool")).toHaveLength(2);
  });

  it("aborts an in-flight provider request without re-prompting", async () => {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const requests = mockNetwork(request => new Promise((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true });
      started();
    }));
    const { brain, session } = await createFixture();
    const prompt = brain.prompt("Wait for a reply.");
    await ready;
    await brain.abort();
    await prompt;
    expect(requests).toHaveLength(1);
    expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
    expect(session.isStreaming).toBe(false);
  });

  it("normalizes real compaction events and preserves header deletion during custom summaries", async () => {
    const requests = mockNetwork(() => completion({ content: "Summary or answer." }));
    const { brain, session, model } = await createFixture();
    const events: any[] = [];
    brain.subscribe(event => events.push(event));
    await brain.prompt("Remember the accepted result and its source.");
    await brain.prompt("Continue with a second turn.");
    await session.compact();
    expect(events.filter(e => e.type.startsWith("auto_compaction_")).map(e => e.type))
      .toEqual(["auto_compaction_start", "auto_compaction_end"]);
    const summary = await summarizeWithFallback({
      messages: [{ role: "user", content: "Remember the source.", timestamp: 1 }],
      model, apiKey: "contract-key", headers: { "x-remove-me": null, "x-keep-me": "present" },
      signal: new AbortController().signal, reserveTokens: 2048,
      maxChunkTokens: 8192, contextWindow: 128_000,
    });
    expect(summary).toBe("Summary or answer.");
    expect(requests.at(-1)!.request.headers.get("x-remove-me")).toBeNull();
    expect(requests.at(-1)!.request.headers.get("x-keep-me")).toBe("present");
  });

  it("keeps tools, histories and call recording separate across concurrent harnesses", async () => {
    const requests = mockNetwork((_request, body) => completion({ content: `Answer for ${body.messages.at(-1).content}` }));
    const first = await createFixture([{ ...resultTool(), name: "first_result" }]);
    const second = await createFixture([{ ...resultTool(), name: "second_result" }]);
    const firstEvents: any[] = [];
    const secondEvents: any[] = [];
    first.brain.subscribe(event => firstEvents.push(event));
    second.brain.subscribe(event => secondEvents.push(event));

    await Promise.all([first.brain.prompt("First private task."), second.brain.prompt("Second private task.")]);

    expect(requests).toHaveLength(2);
    const firstRequest = requests.find(({ body }) => JSON.stringify(body).includes("First private task."))!;
    const secondRequest = requests.find(({ body }) => JSON.stringify(body).includes("Second private task."))!;
    expect(firstRequest.body.tools.map((t: any) => t.function.name)).toEqual(["first_result"]);
    expect(secondRequest.body.tools.map((t: any) => t.function.name)).toEqual(["second_result"]);
    expect(JSON.stringify(first.session.messages)).not.toContain("Second private task.");
    expect(JSON.stringify(second.session.messages)).not.toContain("First private task.");
    for (const events of [firstEvents, secondEvents]) {
      expect(events.filter(e => e.type === "message_end" && e.message.role === "assistant")
        .map(e => e.message.llmCall.round)).toEqual([1]);
    }
    expect(first.sessionManager.getSessionFile()).not.toBe(second.sessionManager.getSessionFile());
  });
});
