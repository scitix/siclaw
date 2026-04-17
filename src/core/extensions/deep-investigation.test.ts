import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import deepInvestigationExtension from "./deep-investigation.js";
import { deepSearchEvents } from "../../tools/workflow/deep-search/events.js";
import type { MutableDpStateRef } from "../types.js";

// Every call to deepInvestigationExtension attaches a new "progress" listener
// on a module-level singleton EventEmitter — tests must clean up between cases
// to avoid MaxListenersExceeded warnings and cross-test contamination.
beforeEach(() => { deepSearchEvents.removeAllListeners("progress"); });
afterEach(() => { deepSearchEvents.removeAllListeners("progress"); });

type Handler = (...args: any[]) => unknown;

// ── Fake api ─────────────────────────────────────────────────────────

function makeApi(initialActive: string[] = []) {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const shortcuts = new Map<unknown, any>();
  const flags = new Map<string, any>();
  const renderers = new Map<string, any>();
  const sessionEntries: Array<{ key: string; data: unknown }> = [];
  let active = [...initialActive];
  const userMessages: Array<{ text: string; options?: unknown }> = [];

  const api: any = {
    on: vi.fn((evt: string, h: Handler) => {
      const arr = handlers.get(evt) ?? [];
      arr.push(h);
      handlers.set(evt, arr);
    }),
    registerTool: vi.fn((def: any) => tools.set(def.name, def)),
    registerCommand: vi.fn((name: string, def: any) => commands.set(name, def)),
    registerShortcut: vi.fn((key: unknown, def: any) => shortcuts.set(key, def)),
    registerFlag: vi.fn((name: string, def: any) => flags.set(name, def)),
    registerMessageRenderer: vi.fn((name: string, r: any) => renderers.set(name, r)),
    appendEntry: vi.fn((key: string, data: unknown) => sessionEntries.push({ key, data })),
    sendUserMessage: vi.fn((text: string, options?: unknown) => userMessages.push({ text, options })),
    getActiveTools: vi.fn(() => active),
    setActiveTools: vi.fn((next: string[]) => { active = next; }),
    getFlag: vi.fn(() => false),
  };
  return { api, handlers, tools, commands, shortcuts, flags, renderers, sessionEntries, userMessages, getActive: () => active };
}

function makeCtx(opts: { hasUI?: boolean; themeOK?: boolean; sessionEntries?: any[] } = {}) {
  const entries = opts.sessionEntries ?? [];
  const selectMock = vi.fn(async () => undefined);
  const ctx: any = {
    hasUI: opts.hasUI ?? false,
    abort: vi.fn(),
    sessionManager: {
      getEntries: () => entries,
    },
    ui: {
      theme: opts.themeOK ? { fg: (_: string, s: string) => s, bold: (s: string) => s } : {
        // throw on access to trigger isThemeUsable=false
        get fg() { throw new Error("no theme"); },
      },
      setStatus: vi.fn(),
      notify: vi.fn(),
      setWidget: vi.fn(),
      setWorkingMessage: vi.fn(),
      onTerminalInput: vi.fn(() => () => {}),
      getEditorText: vi.fn(() => ""),
      select: selectMock,
      input: vi.fn(async () => "feedback text"),
    },
  };
  return ctx;
}

async function call(handlers: Map<string, Handler[]>, event: string, ...args: any[]) {
  const arr = handlers.get(event) ?? [];
  let last: unknown;
  for (const h of arr) {
    last = await h(...args);
  }
  return last;
}

async function callAll(handlers: Map<string, Handler[]>, event: string, ...args: any[]) {
  const arr = handlers.get(event) ?? [];
  const results: unknown[] = [];
  for (const h of arr) results.push(await h(...args));
  return results;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("deepInvestigationExtension — registration surface", () => {
  it("registers flag, shortcut, command, tools, message renderer and handlers", () => {
    const { api, tools, commands, shortcuts, flags, renderers, handlers } = makeApi();
    deepInvestigationExtension(api);
    expect(flags.has("dp")).toBe(true);
    expect(shortcuts.size).toBe(1);
    expect(commands.has("dp")).toBe(true);
    expect(tools.has("end_investigation")).toBe(true);
    expect(tools.has("propose_hypotheses")).toBe(true);
    expect(renderers.has("dp-mode-toggle")).toBe(true);
    expect(handlers.has("input")).toBe(true);
    expect(handlers.has("session_start")).toBe(true);
    expect(handlers.has("agent_end")).toBe(true);
    expect(handlers.has("tool_call")).toBe(true);
    expect(handlers.has("tool_result")).toBe(true);
    expect(handlers.has("agent_start")).toBe(true);
    expect(handlers.has("context")).toBe(true);
  });
});

describe("deepInvestigationExtension — /dp command flow", () => {
  it("/dp toggles mode on when idle", async () => {
    const stateRef: MutableDpStateRef = { status: "idle" };
    const { api, commands, getActive } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);
    const ctx = makeCtx({ hasUI: true });
    await commands.get("dp")!.handler("", ctx);
    expect(stateRef.status).not.toBe("idle");
    expect(getActive()).toContain("deep_search");
    expect(ctx.ui.notify).toHaveBeenCalled();
  });

  it("/dp <question> activates and sends activation user message", async () => {
    const stateRef: MutableDpStateRef = { status: "idle" };
    const { api, commands, userMessages } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);
    const ctx = makeCtx({ hasUI: true });
    await commands.get("dp")!.handler("why pod crashes?", ctx);
    expect(stateRef.status).toBe("investigating");
    expect(userMessages.length).toBe(1);
    expect(userMessages[0].text).toContain("why pod crashes?");
  });

  it.skip("REGRESSION: /dp <question> does not sync dpStateRef.question — setDpStatus runs before dpQuestion is assigned, so the external ref observes undefined until the next state transition. // TODO(issue): reorder enableDpMode + question assignment or add an explicit setDpStatus('investigating') after.", async () => {
    const stateRef: MutableDpStateRef = { status: "idle" };
    const { api, commands } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);
    await commands.get("dp")!.handler("why pod crashes?", makeCtx({ hasUI: true }));
    expect(stateRef.question).toBe("why pod crashes?");
  });
});

describe("deepInvestigationExtension — end_investigation tool", () => {
  it("returns no-op message when idle", async () => {
    const stateRef: MutableDpStateRef = { status: "idle" };
    const { api, tools } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);
    const ctx = makeCtx({ hasUI: true });
    const result = await tools.get("end_investigation").execute("toolCall_1", { reason: "testing" }, new AbortController().signal, () => {}, ctx);
    expect(result.content[0].text).toMatch(/No investigation in progress/);
  });

  it("transitions to idle after completion", async () => {
    const stateRef: MutableDpStateRef = { status: "idle" };
    const { api, tools, commands } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);
    const ctx = makeCtx({ hasUI: true });
    // Activate first
    await commands.get("dp")!.handler("", ctx);
    expect(stateRef.status).toBe("investigating");

    const result = await tools.get("end_investigation").execute("t_1", { reason: "done" }, new AbortController().signal, () => {}, ctx);
    expect(result.content[0].text).toContain("done");
    expect(stateRef.status).toBe("idle");
  });
});

describe("deepInvestigationExtension — propose_hypotheses tool (web mode)", () => {
  it("transitions to awaiting_confirmation and returns instructional text when hasUI=false", async () => {
    const stateRef: MutableDpStateRef = { status: "idle" };
    const { api, tools, commands } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);
    // Activate first via /dp command
    const activateCtx = makeCtx({ hasUI: true });
    await commands.get("dp")!.handler("why", activateCtx);

    const webCtx = makeCtx({ hasUI: false });
    const result = await tools.get("propose_hypotheses").execute(
      "t1",
      {
        hypotheses: "### 1. Something is broken (Confidence: 80%)\nBecause reasons.",
        triageContext: "Found pods CrashLooping",
      },
      new AbortController().signal,
      () => {},
      webCtx,
    );
    expect(stateRef.status).toBe("awaiting_confirmation");
    expect(stateRef.round).toBe(1);
    expect(result.content[0].text).toMatch(/You MUST wait/);
  });

  it("TUI 'Proceed to deep search' → validating", async () => {
    const stateRef: MutableDpStateRef = { status: "idle" };
    const { api, tools, commands } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);
    await commands.get("dp")!.handler("ok", makeCtx({ hasUI: true }));

    const ctx = makeCtx({ hasUI: true, themeOK: true });
    ctx.ui.select.mockResolvedValueOnce("Proceed to deep search");
    const result = await tools.get("propose_hypotheses").execute(
      "t1",
      { hypotheses: "### 1. H (80%)", triageContext: "tri" },
      new AbortController().signal,
      () => {},
      ctx,
    );
    expect(stateRef.status).toBe("validating");
    expect(result.details.userChoice).toBe("proceed");
  });

  it("TUI 'Skip to conclusion' → concluding", async () => {
    const stateRef: MutableDpStateRef = { status: "idle" };
    const { api, tools, commands } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);
    await commands.get("dp")!.handler("ok", makeCtx({ hasUI: true }));

    const ctx = makeCtx({ hasUI: true, themeOK: true });
    ctx.ui.select.mockResolvedValueOnce("Skip to conclusion");
    const result = await tools.get("propose_hypotheses").execute(
      "t1",
      { hypotheses: "### 1. H (50%)", triageContext: "tri" },
      new AbortController().signal,
      () => {},
      ctx,
    );
    expect(stateRef.status).toBe("concluding");
    expect(result.details.userChoice).toBe("skip");
  });

  it("TUI 'Adjust hypotheses' → investigating with feedback", async () => {
    const stateRef: MutableDpStateRef = { status: "idle" };
    const { api, tools, commands } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);
    await commands.get("dp")!.handler("ok", makeCtx({ hasUI: true }));

    const ctx = makeCtx({ hasUI: true, themeOK: true });
    ctx.ui.select.mockResolvedValueOnce("Adjust hypotheses");
    ctx.ui.input = vi.fn(async () => "focus on #1");
    const result = await tools.get("propose_hypotheses").execute(
      "t1",
      { hypotheses: "### 1. H (50%)", triageContext: "tri" },
      new AbortController().signal,
      () => {},
      ctx,
    );
    expect(stateRef.status).toBe("investigating");
    expect(result.details.userChoice).toBe("adjust");
    expect(result.details.feedback).toBe("focus on #1");
  });
});

describe("deepInvestigationExtension — input handlers", () => {
  it("[DP_CONFIRM] marker transitions awaiting_confirmation → validating", async () => {
    const stateRef: MutableDpStateRef = { status: "idle" };
    const { api, tools, handlers, commands } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);
    // Activate DP + propose_hypotheses (web mode → awaiting_confirmation)
    await commands.get("dp")!.handler("q", makeCtx({ hasUI: true }));
    await tools.get("propose_hypotheses").execute(
      "t1",
      { hypotheses: "### 1. H (80%)", triageContext: "tri" },
      new AbortController().signal,
      () => {},
      makeCtx({ hasUI: false }),
    );
    expect(stateRef.status).toBe("awaiting_confirmation");

    const results = await callAll(handlers, "input", { text: "[DP_CONFIRM]\nproceed" }, makeCtx({ hasUI: false }));
    expect(stateRef.status).toBe("validating");
    const transform = results.find((r: any) => r?.action === "transform");
    expect(transform).toBeDefined();
  });

  it("[DP_EXIT] marker triggers disableDpMode and transforms the message", async () => {
    const stateRef: MutableDpStateRef = { status: "idle" };
    const { api, handlers, commands } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);
    await commands.get("dp")!.handler("q", makeCtx({ hasUI: true }));
    expect(stateRef.status).toBe("investigating");

    const results = await callAll(handlers, "input", { text: "[DP_EXIT]\nuser stopped" }, makeCtx({ hasUI: true }));
    expect(stateRef.status).toBe("idle");
    expect(results.some((r: any) => r?.action === "transform")).toBe(true);
  });

  it("[Deep Investigation] marker on idle activates and transforms text", async () => {
    const stateRef: MutableDpStateRef = { status: "idle" };
    const { api, handlers } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);
    const results = await callAll(handlers, "input", { text: "[Deep Investigation]\nwhy?" }, makeCtx({ hasUI: true }));
    expect(stateRef.status).toBe("investigating");
    expect(results.some((r: any) => r?.action === "transform")).toBe(true);
  });

  it("context handler filters dp-mode custom messages", async () => {
    const stateRef: MutableDpStateRef = { status: "idle" };
    const { api, handlers } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);
    const result = await call(handlers, "context", {
      messages: [
        { role: "user", content: "keep me" },
        { role: "custom", customType: "dp-mode", data: {} },
        { role: "user", content: "keep me too" },
      ],
    });
    expect((result as any).messages).toHaveLength(2);
  });
});

describe("deepInvestigationExtension — tool_call guard + agent_end nudge", () => {
  it("blocks non-propose_hypotheses tool calls during awaiting_confirmation", async () => {
    const stateRef: MutableDpStateRef = { status: "idle" };
    const { api, tools, handlers, commands } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);
    await commands.get("dp")!.handler("q", makeCtx({ hasUI: true }));
    await tools.get("propose_hypotheses").execute(
      "t",
      { hypotheses: "### 1. H (50%)", triageContext: "tri" },
      new AbortController().signal,
      () => {},
      makeCtx({ hasUI: false }),
    );
    const ctx = makeCtx({ hasUI: true });
    expect(() => handlers.get("tool_call")![0]({ toolName: "restricted_bash" }, ctx)).toThrow(/Blocked/);
  });

  it("does not block propose_hypotheses during awaiting_confirmation", async () => {
    const stateRef: MutableDpStateRef = { status: "idle" };
    const { api, tools, handlers, commands } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);
    await commands.get("dp")!.handler("q", makeCtx({ hasUI: true }));
    await tools.get("propose_hypotheses").execute(
      "t",
      { hypotheses: "### 1. H (50%)", triageContext: "tri" },
      new AbortController().signal,
      () => {},
      makeCtx({ hasUI: false }),
    );
    const ctx = makeCtx({ hasUI: true });
    expect(() => handlers.get("tool_call")![0]({ toolName: "propose_hypotheses" }, ctx)).not.toThrow();
  });

  it("agent_end nudges when investigating but no propose_hypotheses called", async () => {
    const stateRef: MutableDpStateRef = { status: "idle" };
    const { api, commands, handlers, userMessages } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);
    await commands.get("dp")!.handler("q", makeCtx({ hasUI: true }));
    // Simulate model ran a tool (restricted_bash) but NOT propose_hypotheses
    handlers.get("tool_call")![0]({ toolName: "restricted_bash" }, makeCtx({ hasUI: true }));
    // Fire agent_end
    await handlers.get("agent_end")![0]({}, makeCtx({ hasUI: true }));
    expect(userMessages.some((m) => m.text.includes("propose_hypotheses"))).toBe(true);
  });

  it("tool_result on propose_hypotheses in web mode aborts the turn", () => {
    const stateRef: MutableDpStateRef = { status: "idle" };
    const { api, handlers, commands, tools } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);
    // activate + propose in web mode
    commands.get("dp")!.handler("q", makeCtx({ hasUI: true }));
    tools.get("propose_hypotheses").execute(
      "t",
      { hypotheses: "### 1. H (50%)", triageContext: "tri" },
      new AbortController().signal,
      () => {},
      makeCtx({ hasUI: false }),
    );
    const ctx = makeCtx({ hasUI: false });
    handlers.get("tool_result")![0]({ toolName: "propose_hypotheses" }, ctx);
    expect(ctx.abort).toHaveBeenCalled();
  });

  it("tool_result on deep_search transitions validating → concluding", async () => {
    const stateRef: MutableDpStateRef = { status: "idle" };
    const { api, handlers, commands, tools } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);
    // activate, propose, confirm
    await commands.get("dp")!.handler("q", makeCtx({ hasUI: true }));
    await tools.get("propose_hypotheses").execute(
      "t",
      { hypotheses: "### 1. H (50%)", triageContext: "tri" },
      new AbortController().signal,
      () => {},
      makeCtx({ hasUI: false }),
    );
    await callAll(handlers, "input", { text: "[DP_CONFIRM]\n" }, makeCtx({ hasUI: false }));
    expect(stateRef.status).toBe("validating");

    // Simulate deep_search tool result
    const ctx = makeCtx({ hasUI: true });
    for (const h of handlers.get("tool_result") ?? []) {
      h({ toolName: "deep_search", details: { investigationId: "inv_123" } }, ctx);
    }
    expect(stateRef.status).toBe("concluding");
  });
});

describe("deepInvestigationExtension — session_start restoration", () => {
  it("clean session_start leaves status idle and hides deep_search", async () => {
    const stateRef: MutableDpStateRef = { status: "idle" };
    const { api, handlers, getActive } = makeApi(["deep_search", "memory_search"]);
    deepInvestigationExtension(api, undefined, stateRef);
    await handlers.get("session_start")![0]({}, makeCtx({ hasUI: true }));
    expect(stateRef.status).toBe("idle");
    expect(getActive()).not.toContain("deep_search");
  });

  it("restores investigating status from persisted dpStatus snapshot", async () => {
    const stateRef: MutableDpStateRef = { status: "idle" };
    const { api, handlers, getActive } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);
    const entries = [
      { type: "custom", customType: "dp-mode", data: { enabled: true, dpStatus: "investigating", dpQuestion: "why", dpRound: 2 } },
    ];
    await handlers.get("session_start")![0]({}, makeCtx({ hasUI: true, sessionEntries: entries }));
    expect(stateRef.status).toBe("investigating");
    expect(stateRef.question).toBe("why");
    expect(getActive()).toContain("deep_search");
  });

  it("restores legacy checklist-only entries as investigating", async () => {
    const stateRef: MutableDpStateRef = { status: "idle" };
    const { api, handlers } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);
    const entries = [
      { type: "custom", customType: "dp-mode", data: { enabled: true, checklist: { question: "q", items: [] } } },
    ];
    await handlers.get("session_start")![0]({}, makeCtx({ hasUI: true, sessionEntries: entries }));
    expect(stateRef.status).toBe("investigating");
  });
});

describe("deepInvestigationExtension — progress events", () => {
  beforeEach(() => {
    // Ensure no bleed between tests
    deepSearchEvents.removeAllListeners("progress");
  });

  it("progress events are listened for (no-op when no activeUI)", () => {
    const stateRef: MutableDpStateRef = { status: "idle" };
    const { api } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);
    // No active UI yet; emitter calls should not throw
    expect(() =>
      deepSearchEvents.emit("progress", { type: "phase", phase: "Phase 1", detail: "init" }),
    ).not.toThrow();
  });
});
