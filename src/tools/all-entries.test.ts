import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { encodeToolCapabilitiesForDb, parseToolCapabilitiesAtBoundary, resolveCapabilities } from "../core/tool-capabilities.js";
import { effectiveCapabilityKeys } from "../core/agent-types.js";
import { appendAllowedTools } from "../core/tool-append.js";
import { describe, expect, it, vi } from "vitest";
import { ToolRegistry, type ToolRefs } from "../core/tool-registry.js";
import { resolveAgentHarness } from "../core/agent-context.js";
import { allToolEntries } from "./all-entries.js";

function refs(): ToolRefs {
  return {
    kubeconfigRef: {}, userId: "user-1", agentId: "entry",
    sessionIdRef: { current: "session-1" }, memoryRef: {}, dpStateRef: { active: false },
    sessionEventEmitter: vi.fn(), allowInputRequest: true, handoffSupported: true,
    handoffTargets: [{ id: "receiver", name: "Receiver", routeKey: "receiver", description: "Arithmetic", isFacade: false }],
    searchHandoffTargets: vi.fn(),
    handoffSearchMatches: new Map([["receiver", { id: "receiver", routeKey: "receiver", name: "Receiver", agentType: "sre", description: "Arithmetic", matches: [], matchCount: 1 }]]),
    channelMessageExecutor: vi.fn(async () => ({ delivered: true, message: "Delivered" })),
  };
}

describe("production tool registry", () => {
  it.each([false, true])("keeps the retired-only selection out of execution tools (handoff=%s)", (handoffAvailable) => {
    const registry = new ToolRegistry();
    registry.register(...allToolEntries);
    const stored = encodeToolCapabilitiesForDb(["delegate_agents"]);
    const allowedTools = resolveCapabilities(effectiveCapabilityKeys("custom", parseToolCapabilitiesAtBoundary(stored)));
    expect(allowedTools).toEqual([]);
    const harness = resolveAgentHarness({ agentType: "custom", allowedTools, memoryConfigured: false, handoffAvailable });
    expect(harness.legacyUnrestrictedCustom).toBe(false);
    const tools = registry.resolve({ mode: "web", refs: refs(), allowedTools: harness.allowedTools });
    appendAllowedTools(tools, ["read", "write", "edit"].map(name => ({ name }) as ToolDefinition), harness.allowedTools);
    expect(tools.map(t => t.name).sort()).toEqual(handoffAvailable ? ["search_handoff_targets", "transfer_to_agent"] : []);
  });

  it("executes an authorized handoff through the complete SRE registry", async () => {
    const registry = new ToolRegistry();
    registry.register(...allToolEntries);
    const context = refs();
    const harness = resolveAgentHarness({ agentType: "sre", allowedTools: null, memoryConfigured: false, handoffAvailable: true });
    const tools = registry.resolve({ mode: "web", refs: context, allowedTools: harness.allowedTools });
    expect(tools.map(t => t.name)).toContain("search_handoff_targets");
    const transfer = tools.find(t => t.name === "transfer_to_agent");
    expect(transfer).toBeDefined();
    const result = await transfer!.execute!("transfer-1", { route_key: "receiver", brief: "Verify the calculation" }, undefined as never);
    expect(result).toMatchObject({ details: { transferred: true } });
    expect(context.sessionEventEmitter).toHaveBeenCalledWith({ type: "handoff_requested", targetAgentId: "receiver", brief: "Verify the calculation" });
  });

  it("keeps interactive input and channel updates registered after peer retirement", () => {
    const registry = new ToolRegistry();
    registry.register(...allToolEntries);
    const names = registry.resolve({ mode: "channel", refs: refs() }).map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(["request_input", "channel_update"]));
    expect(names).not.toContain("delegate_to_agent");
    expect(names).not.toContain("list_delegates");
    expect(names).not.toContain("report_findings");
  });
});
