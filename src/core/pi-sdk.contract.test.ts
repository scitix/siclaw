import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { PiAgentBrain } from "./brains/pi-agent-brain.js";
import { createGuardRegistry, installGuardPipeline } from "./guard-pipeline.js";
import { LlmCallRecorder } from "./llm-call-recorder.js";
import { summarizeWithFallback } from "./compaction.js";
import { resolveSessionThinkingLevel } from "./session-thinking.js";

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
    },
  });
  const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
  const { session } = await createAgentSessionFromServices({
    services, sessionManager, model, noTools: "builtin", customTools,
    thinkingLevel: resolveSessionThinkingLevel(services.settingsManager, model),
  });
  await session.bindExtensions({});
  cleanups.push(() => session.dispose());
  const recorder = new LlmCallRecorder();
  session.agent.streamFunction = recorder.wrapStreamFn(session.agent.streamFunction);
  installGuardPipeline(createGuardRegistry(model.contextWindow), { agent: session.agent, sessionManager });
  const brain = new PiAgentBrain(session, new Map(), recorder);
  return { brain, session, sessionManager, model, services, modelRuntime };
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

  it("preserves guards, payload hooks, tool events, timing and persisted checkpoints", async () => {
    const requests = mockNetwork(() => requests.length === 1
      ? resultCall(" submit_result ") : completion({ content: "Completed." }));
    const tool = resultTool();
    const { brain, session, sessionManager } = await createFixture([tool]);
    const payloads: unknown[] = [];
    session.agent.onPayload = (payload) => { payloads.push(payload); return payload; };
    const events: any[] = [];
    brain.subscribe(event => events.push(event));

    await brain.prompt("Submit an answer.");

    expect(session.getActiveToolNames()).toEqual(["submit_result"]);
    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
    expect(requests[0].request.headers.get("authorization")).toBe("Bearer contract-key");
    expect(payloads).toHaveLength(2);
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
});
