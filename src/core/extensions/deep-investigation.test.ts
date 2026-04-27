import { describe, it, expect, vi } from "vitest";
import deepInvestigationExtension from "./deep-investigation.js";
import type { MutableDpStateRef } from "../types.js";

// Post-refactor DP test suite. Covers:
//   - Activation via [Deep Investigation] marker (first message prepends
//     the prompt preamble; later ones just strip the marker)
//   - Deactivation via [DP_EXIT] marker
//   - Session restoration from persisted entries (new + legacy shapes)
//   - /dp command toggle behaviour
//   - Context-filter strips UI-only dp-mode messages
//
// The old 25-test suite exercised the state machine (awaiting_confirmation
// transitions, agent_end nudge, tool_call guard, propose_hypotheses,
// end_investigation, checklist sync). All of those mechanisms were
// deleted in the refactor — their tests are gone with them.

type Handler = (...args: any[]) => unknown;

function makeApi(initialActive: string[] = []) {
  const handlers = new Map<string, Handler[]>();
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
    registerTool: vi.fn(),
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
  return { api, handlers, commands, shortcuts, flags, renderers, sessionEntries, userMessages };
}

function makeCtx(opts: { hasUI?: boolean; sessionEntries?: any[] } = {}) {
  return {
    hasUI: opts.hasUI ?? false,
    abort: vi.fn(),
    sessionManager: { getEntries: () => opts.sessionEntries ?? [] },
    ui: {
      theme: { fg: (_: string, s: string) => s, bold: (s: string) => s },
      setStatus: vi.fn(),
      notify: vi.fn(),
    },
  } as any;
}

async function callAll(handlers: Map<string, Handler[]>, event: string, ...args: any[]) {
  const arr = handlers.get(event) ?? [];
  const results: unknown[] = [];
  for (const h of arr) results.push(await h(...args));
  return results;
}

function delegationCompleteMessage(capsule = "node evidence."): string {
  return [
    "[Delegation Batch Complete]",
    "Delegation ID: delegation-1",
    "Status: done",
    "",
    "Evidence capsules:",
    "- Agent 1 (done)",
    `  Capsule: ${capsule}`,
    "",
    "Synthesize these capsules into the current investigation. Do not call more tools in this turn unless the user explicitly asks; if evidence is incomplete, say what is still uncertain.",
  ].join("\n");
}

describe("deepInvestigationExtension — registration surface", () => {
  it("registers /dp command, Ctrl+I shortcut, --dp flag, dp-mode renderer, and no tools", () => {
    const { api, commands, shortcuts, flags, renderers, handlers } = makeApi();
    deepInvestigationExtension(api);
    expect(commands.has("dp")).toBe(true);
    expect(shortcuts.size).toBe(1);
    expect(flags.has("dp")).toBe(true);
    expect(renderers.has("dp-mode-toggle")).toBe(true);
    expect(handlers.has("input")).toBe(true);
    expect(handlers.has("session_start")).toBe(true);
    expect(handlers.has("context")).toBe(true);
    // No tools registered — the propose_hypotheses / deep_search /
    // end_investigation trio was deleted in the refactor.
    expect(api.registerTool).not.toHaveBeenCalled();
  });
});

describe("deepInvestigationExtension — activation via [Deep Investigation] marker", () => {
  it("first marker-bearing message flips dpActive on and prepends the prompt preamble", async () => {
    const stateRef: MutableDpStateRef = { active: false };
    const { api, handlers } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);

    const results = await callAll(handlers, "input",
      { text: "[Deep Investigation]\n排查集群 DNS 异常" },
      makeCtx({ hasUI: false }),
    );
    const transform = results.find((r: any) => r?.action === "transform") as any;

    expect(stateRef.active).toBe(true);
    expect(transform).toBeDefined();
    expect(transform.text).toContain("Deep Investigation mode");  // preamble
    expect(transform.text).toContain("Do not ask the user to choose A/B/C after every message");
    expect(transform.text).toContain('delegate_to_agent with agent_id="self"');
    expect(transform.text).toContain("prefer delegate_to_agents with 1-3 tasks");
    expect(transform.text).toContain("Do not call one sub-agent, wait for it");
    expect(transform.text).toContain('delegate_to_agents result with status="running" as a launch acknowledgement only');
    expect(transform.text).toContain("do not attribute parent-collected evidence to sub-agents");
    expect(transform.text).toContain("[Delegation Batch Complete]");
    expect(transform.text).toContain("Do not render any visible choice list in the markdown");
    expect(transform.text).toContain("<!-- hypothesis-checkpoint -->");
    expect(transform.text).toContain("<!-- suggested-replies: A|Proceed, B|Refine, C|Summarize -->");
    expect(transform.text).not.toContain("继续验证当前最强假设");
    expect(transform.text).toContain("排查集群 DNS 异常");         // original user text preserved
  });

  it("strips UI-only prefix chip markers before forwarding DP input to the model", async () => {
    const stateRef: MutableDpStateRef = { active: false };
    const { api, handlers } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);

    const results = await callAll(handlers, "input",
      { text: `[Deep Investigation]
[Adjust]
Adjust your investigation direction based on my input below.

Additional direction from user: focus on ingress` },
      makeCtx(),
    );
    const transform = results.find((r: any) => r?.action === "transform") as any;

    expect(transform.text).not.toContain("[Adjust]");
    expect(transform.text).toContain("focus on ingress");
  });

  it("strips current DP checkpoint prefix markers but preserves their hidden instruction body", async () => {
    const stateRef: MutableDpStateRef = { active: false };
    const { api, handlers } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);

    const results = await callAll(handlers, "input",
      { text: `[Deep Investigation]
[Refine]
Refine or add hypotheses based on my additional direction below.

Additional direction from user: compare H2 with kube-proxy evidence` },
      makeCtx(),
    );
    const transform = results.find((r: any) => r?.action === "transform") as any;

    expect(transform.text).not.toContain("[Refine]");
    expect(transform.text).toContain("Refine or add hypotheses");
    expect(transform.text).toContain("compare H2 with kube-proxy evidence");
  });

  it("subsequent [Deep Investigation]-prefixed messages only strip the marker (no preamble re-injection)", async () => {
    const stateRef: MutableDpStateRef = { active: false };
    const { api, handlers } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);

    await callAll(handlers, "input",
      { text: "[Deep Investigation]\nfirst question" },
      makeCtx(),
    );
    expect(stateRef.active).toBe(true);

    const results = await callAll(handlers, "input",
      { text: "[Deep Investigation]\nfollow-up question" },
      makeCtx(),
    );
    const transform = results.find((r: any) => r?.action === "transform") as any;

    expect(transform.text).toBe("follow-up question");
    expect(transform.text).not.toContain("Deep Investigation mode");
  });

  it("bare marker enables DP mode without forwarding marker text", async () => {
    const stateRef: MutableDpStateRef = { active: false };
    const { api, handlers } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);
    const results = await callAll(handlers, "input",
      { text: "[Deep Investigation]\n   " },
      makeCtx(),
    );
    expect(stateRef.active).toBe(true);
    expect(results.some((r: any) => r?.action === "handled")).toBe(true);
    expect(results.some((r: any) => r?.action === "transform")).toBe(false);
  });
});
describe("deepInvestigationExtension — deactivation via [DP_EXIT] marker", () => {
  it("turns dpActive off and transforms the message into a user-exited notice", async () => {
    const stateRef: MutableDpStateRef = { active: false };
    const { api, handlers } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);

    await callAll(handlers, "input", { text: "[Deep Investigation]\nq" }, makeCtx());
    expect(stateRef.active).toBe(true);

    const results = await callAll(handlers, "input",
      { text: "[DP_EXIT]\ndone for now" },
      makeCtx(),
    );
    const transform = results.find((r: any) => r?.action === "transform") as any;

    expect(stateRef.active).toBe(false);
    expect(transform.text).toContain("exited Deep Investigation");
    expect(transform.text).toContain("done for now");
  });

  it("bare [DP_EXIT] without trailing newline/text also deactivates", async () => {
    const stateRef: MutableDpStateRef = { active: false };
    const { api, handlers } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);
    await callAll(handlers, "input", { text: "[Deep Investigation]\nq" }, makeCtx());
    expect(stateRef.active).toBe(true);

    await callAll(handlers, "input", { text: "[DP_EXIT]" }, makeCtx());
    expect(stateRef.active).toBe(false);
  });
});

describe("deepInvestigationExtension — session restoration", () => {
  it("clean session_start (no entries) leaves dpActive false", async () => {
    const stateRef: MutableDpStateRef = { active: false };
    const { api, handlers } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);

    await callAll(handlers, "session_start", {}, makeCtx());
    expect(stateRef.active).toBe(false);
  });

  it("restores active=true from the new {active:true} entry shape", async () => {
    const stateRef: MutableDpStateRef = { active: false };
    const { api, handlers } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);

    const ctx = makeCtx({
      sessionEntries: [{ type: "custom", customType: "dp-mode", data: { active: true } }],
    });
    await callAll(handlers, "session_start", {}, ctx);
    expect(stateRef.active).toBe(true);
  });

  it("restores active=true from the legacy {enabled:true} shape", async () => {
    const stateRef: MutableDpStateRef = { active: false };
    const { api, handlers } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);

    const ctx = makeCtx({
      sessionEntries: [{ type: "custom", customType: "dp-mode", data: { enabled: true } }],
    });
    await callAll(handlers, "session_start", {}, ctx);
    expect(stateRef.active).toBe(true);
  });

  it("restores active=true from the legacy {dpStatus:'investigating'} shape", async () => {
    const stateRef: MutableDpStateRef = { active: false };
    const { api, handlers } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);

    const ctx = makeCtx({
      sessionEntries: [{ type: "custom", customType: "dp-mode", data: { dpStatus: "investigating" } }],
    });
    await callAll(handlers, "session_start", {}, ctx);
    expect(stateRef.active).toBe(true);
  });

  it("legacy {dpStatus:'idle'} leaves dpActive false", async () => {
    const stateRef: MutableDpStateRef = { active: false };
    const { api, handlers } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);

    const ctx = makeCtx({
      sessionEntries: [{ type: "custom", customType: "dp-mode", data: { dpStatus: "idle" } }],
    });
    await callAll(handlers, "session_start", {}, ctx);
    expect(stateRef.active).toBe(false);
  });
});

describe("deepInvestigationExtension — /dp command toggle", () => {
  it("/dp toggles the mode on when idle", async () => {
    const stateRef: MutableDpStateRef = { active: false };
    const { api, commands } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);

    const ctx = makeCtx({ hasUI: true });
    await commands.get("dp")!.handler("", ctx);
    expect(stateRef.active).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalled();
  });

  it("/dp toggles the mode off when active", async () => {
    const stateRef: MutableDpStateRef = { active: false };
    const { api, commands } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);

    const ctx = makeCtx({ hasUI: true });
    await commands.get("dp")!.handler("", ctx);
    expect(stateRef.active).toBe(true);
    await commands.get("dp")!.handler("", ctx);
    expect(stateRef.active).toBe(false);
  });
});

describe("deepInvestigationExtension — context filter", () => {
  it("strips UI-only dp-mode custom messages from the LLM context", async () => {
    const { api, handlers } = makeApi();
    deepInvestigationExtension(api);

    const res = (await callAll(handlers, "context", {
      messages: [
        { role: "user", content: "hi" },
        { customType: "dp-mode", content: "🔍 Deep Investigation ON" },
        { role: "assistant", content: "hello" },
      ],
    }))[0] as any;

    expect(res.messages).toHaveLength(2);
    expect(res.messages.every((m: any) => m.customType !== "dp-mode")).toBe(true);
  });
});

describe("deepInvestigationExtension — delegation synthesis barrier", () => {
  it("blocks tool calls after delegated results arrive until the parent synthesizes them", async () => {
    const stateRef: MutableDpStateRef = { active: false };
    const { api, handlers } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);

    await callAll(handlers, "input", { text: "[Deep Investigation]\ncheck cluster" }, makeCtx());
    await callAll(handlers, "context", {
      messages: [
        { role: "user", content: "check cluster" },
        { role: "assistant", content: "I started delegated checks." },
        {
          role: "user",
          content: delegationCompleteMessage(),
        },
      ],
    });

    const res = (await callAll(handlers, "tool_call", {
      toolName: "bash",
      input: { command: "kubectl get pods" },
    }))[0] as any;

    expect(res.block).toBe(true);
    expect(res.reason).toContain("synthesize the delegated evidence");
  });

  it("allows tool calls after a visible assistant synthesis follows the delegated event", async () => {
    const stateRef: MutableDpStateRef = { active: false };
    const { api, handlers } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);

    await callAll(handlers, "input", { text: "[Deep Investigation]\ncheck cluster" }, makeCtx());
    await callAll(handlers, "context", {
      messages: [
        { role: "user", content: "check cluster" },
        {
          role: "user",
          content: delegationCompleteMessage(),
        },
        { role: "assistant", content: "The delegated evidence points to node pressure. Next I will validate events." },
      ],
    });

    const res = (await callAll(handlers, "tool_call", {
      toolName: "bash",
      input: { command: "kubectl get events" },
    }))[0] as any;

    expect(res.block).toBeUndefined();
  });

  it("does not enable the barrier outside Deep Investigation mode", async () => {
    const { api, handlers } = makeApi();
    deepInvestigationExtension(api);

    await callAll(handlers, "context", {
      messages: [
        {
          role: "user",
          content: delegationCompleteMessage(),
        },
      ],
    });

    const res = (await callAll(handlers, "tool_call", {
      toolName: "bash",
      input: { command: "kubectl get pods" },
    }))[0] as any;

    expect(res.block).toBeUndefined();
  });

  it("does not trigger when a normal user prompt merely mentions the delegation marker", async () => {
    const stateRef: MutableDpStateRef = { active: false };
    const { api, handlers } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);

    await callAll(handlers, "input", { text: "[Deep Investigation]\ncheck cluster" }, makeCtx());
    await callAll(handlers, "context", {
      messages: [
        {
          role: "user",
          content: "When [Delegation Batch Complete] appears later, synthesize the result.",
        },
      ],
    });

    const res = (await callAll(handlers, "tool_call", {
      toolName: "cluster_info",
      input: {},
    }))[0] as any;

    expect(res.block).toBeUndefined();
  });

  it("does not trigger from the DP activation prompt text itself", async () => {
    const stateRef: MutableDpStateRef = { active: false };
    const { api, handlers } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);

    const results = await callAll(handlers, "input", { text: "[Deep Investigation]\ncheck cluster" }, makeCtx());
    const transform = results.find((r: any) => r?.action === "transform") as any;

    await callAll(handlers, "context", {
      messages: [
        {
          role: "user",
          content: transform.text,
        },
      ],
    });

    const res = (await callAll(handlers, "tool_call", {
      toolName: "cluster_info",
      input: {},
    }))[0] as any;

    expect(res.block).toBeUndefined();
  });

  it("clears stale delegated-result pressure when a real user turn arrives later", async () => {
    const stateRef: MutableDpStateRef = { active: false };
    const { api, handlers } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);

    await callAll(handlers, "input", { text: "[Deep Investigation]\ncheck cluster" }, makeCtx());
    await callAll(handlers, "context", {
      messages: [
        { role: "user", content: "old question" },
        { role: "assistant", content: "I started delegated checks." },
        { role: "user", content: delegationCompleteMessage() },
        { role: "user", content: "new question: collect baseline first" },
      ],
    });

    const res = (await callAll(handlers, "tool_call", {
      toolName: "cluster_info",
      input: {},
    }))[0] as any;

    expect(res.block).toBeUndefined();
  });

  it("session_start clears stale delegated-result and checkpoint guard state", async () => {
    const stateRef: MutableDpStateRef = { active: false };
    const { api, handlers } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);

    await callAll(handlers, "input", { text: "[Deep Investigation]\ncheck cluster" }, makeCtx());
    await callAll(handlers, "context", {
      messages: [
        { role: "user", content: delegationCompleteMessage() },
        ...Array.from({ length: 20 }, (_, index) => ({
          role: "tool",
          content: `tool result ${index + 1}`,
        })),
      ],
    });
    let res = (await callAll(handlers, "tool_call", {
      toolName: "bash",
      input: { command: "kubectl get pods" },
    }))[0] as any;
    expect(res.block).toBe(true);

    await callAll(handlers, "session_start", {}, makeCtx());
    await callAll(handlers, "input", { text: "[Deep Investigation]\nnew session question" }, makeCtx());
    await callAll(handlers, "context", {
      messages: [{ role: "user", content: "new session question" }],
    });

    res = (await callAll(handlers, "tool_call", {
      toolName: "cluster_info",
      input: {},
    }))[0] as any;
    expect(res.block).toBeUndefined();
  });
});

describe("deepInvestigationExtension — investigation checkpoint budget", () => {
  it("blocks the next tool call after twenty DP tool results without visible synthesis", async () => {
    const stateRef: MutableDpStateRef = { active: false };
    const { api, handlers } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);

    await callAll(handlers, "input", { text: "[Deep Investigation]\ncheck cluster" }, makeCtx());
    await callAll(handlers, "context", {
      messages: [
        { role: "user", content: "check cluster" },
        { role: "assistant", content: "I will collect baseline evidence." },
        ...Array.from({ length: 20 }, (_, index) => ({
          role: "tool",
          content: `tool result ${index + 1}`,
        })),
      ],
    });

    const res = (await callAll(handlers, "tool_call", {
      toolName: "bash",
      input: { command: "kubectl get events" },
    }))[0] as any;

    expect(res.block).toBe(true);
    expect(res.reason).toContain("Hypothesis Checkpoint");
    expect(res.reason).toContain("current hypotheses");
  });

  it("counts pi-agent toolResult messages toward the DP checkpoint budget", async () => {
    const stateRef: MutableDpStateRef = { active: false };
    const { api, handlers } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);

    await callAll(handlers, "input", { text: "[Deep Investigation]\ncheck cluster" }, makeCtx());
    await callAll(handlers, "context", {
      messages: [
        { role: "user", content: "check cluster" },
        { role: "assistant", content: "I will collect baseline evidence." },
        ...Array.from({ length: 20 }, (_, index) => ({
          role: "toolResult",
          content: `tool result ${index + 1}`,
        })),
      ],
    });

    const res = (await callAll(handlers, "tool_call", {
      toolName: "bash",
      input: { command: "kubectl get events" },
    }))[0] as any;

    expect(res.block).toBe(true);
    expect(res.reason).toContain("Hypothesis Checkpoint");
  });

  it("allows tool calls before the DP checkpoint budget is exhausted", async () => {
    const stateRef: MutableDpStateRef = { active: false };
    const { api, handlers } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);

    await callAll(handlers, "input", { text: "[Deep Investigation]\ncheck cluster" }, makeCtx());
    await callAll(handlers, "context", {
      messages: [
        { role: "user", content: "check cluster" },
        { role: "assistant", content: "I will collect baseline evidence." },
        ...Array.from({ length: 19 }, (_, index) => ({
          role: "tool",
          content: `tool result ${index + 1}`,
        })),
      ],
    });

    const res = (await callAll(handlers, "tool_call", {
      toolName: "bash",
      input: { command: "kubectl get events" },
    }))[0] as any;

    expect(res.block).toBeUndefined();
  });

  it("resets the DP checkpoint budget after a visible assistant checkpoint", async () => {
    const stateRef: MutableDpStateRef = { active: false };
    const { api, handlers } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);

    await callAll(handlers, "input", { text: "[Deep Investigation]\ncheck cluster" }, makeCtx());
    await callAll(handlers, "context", {
      messages: [
        { role: "user", content: "check cluster" },
        { role: "assistant", content: "I will collect baseline evidence." },
        ...Array.from({ length: 20 }, (_, index) => ({
          role: "tool",
          content: `tool result ${index + 1}`,
        })),
        { role: "assistant", content: "Checkpoint: current evidence points to node pressure. I will validate events next." },
      ],
    });

    const res = (await callAll(handlers, "tool_call", {
      toolName: "bash",
      input: { command: "kubectl get events" },
    }))[0] as any;

    expect(res.block).toBeUndefined();
  });

  it("does not apply the checkpoint budget outside Deep Investigation mode", async () => {
    const { api, handlers } = makeApi();
    deepInvestigationExtension(api);

    await callAll(handlers, "context", {
      messages: [
        { role: "user", content: "check cluster" },
        ...Array.from({ length: 25 }, (_, index) => ({
          role: "tool",
          content: `tool result ${index + 1}`,
        })),
      ],
    });

    const res = (await callAll(handlers, "tool_call", {
      toolName: "bash",
      input: { command: "kubectl get events" },
    }))[0] as any;

    expect(res.block).toBeUndefined();
  });

  it("prioritizes delegated-result synthesis over the generic checkpoint budget", async () => {
    const stateRef: MutableDpStateRef = { active: false };
    const { api, handlers } = makeApi();
    deepInvestigationExtension(api, undefined, stateRef);

    await callAll(handlers, "input", { text: "[Deep Investigation]\ncheck cluster" }, makeCtx());
    await callAll(handlers, "context", {
      messages: [
        { role: "user", content: "check cluster" },
        { role: "assistant", content: "I started delegated checks." },
        ...Array.from({ length: 20 }, (_, index) => ({
          role: "tool",
          content: `tool result ${index + 1}`,
        })),
        {
          role: "user",
          content: delegationCompleteMessage(),
        },
      ],
    });

    const res = (await callAll(handlers, "tool_call", {
      toolName: "bash",
      input: { command: "kubectl get events" },
    }))[0] as any;

    expect(res.block).toBe(true);
    expect(res.reason).toContain("Delegated investigation results are ready");
  });
});
