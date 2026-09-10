import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSessionMcpTools } from "./session-mcp-tools.js";
import { resolveCapabilities } from "./tool-capabilities.js";
import type { McpClientManager } from "./mcp-client.js";

const mock = vi.hoisted(() => ({ initialize: vi.fn(), getTools: vi.fn(() => [{ name: "mcp__mutate" }]), shutdown: vi.fn(), construct: vi.fn() }));
vi.mock("./mcp-client.js", () => ({ McpClientManager: class {
  constructor() { mock.construct(); }
  initialize = mock.initialize;
  getTools = mock.getTools;
  shutdown = mock.shutdown;
} }));
afterEach(() => vi.clearAllMocks());
const mcpServers = { bound: { transport: "streamable-http" as const, url: "https://mcp.test" } };

describe("sandbox-only dynamic tool boundary", () => {
  it("honors a disabled harness for both configured and shared MCP tools", async () => {
    expect(await resolveSessionMcpTools({ enabled: false, allowedTools: ["bash"], mcpServers })).toEqual({ mcpTools: [] });
    expect(await resolveSessionMcpTools({ enabled: false, mcpManager: mock as unknown as McpClientManager,
      mcpTools: [{ name: "mcp__mutate" }] as any })).toEqual({ mcpTools: [] });
    expect(mock.construct).not.toHaveBeenCalled();
    expect(mock.initialize).not.toHaveBeenCalled();
    expect(mock.getTools).not.toHaveBeenCalled();
    expect(mock.shutdown).not.toHaveBeenCalled();
  });

  it("does not connect to a bound MCP server or inject its tools", async () => {
    expect(await resolveSessionMcpTools({ allowedTools: resolveCapabilities(["run_sandbox"]), mcpServers })).toEqual({ mcpTools: [] });
    expect(mock.construct).not.toHaveBeenCalled(); expect(mock.initialize).not.toHaveBeenCalled();
  });

  it("drops shared tools when capabilities change to sandbox-only on rebuild", async () => {
    const mcpManager = mock as unknown as McpClientManager;
    const previous = await resolveSessionMcpTools({ allowedTools: ["bash"], mcpManager });
    expect(previous.mcpTools).toHaveLength(1);
    mock.getTools.mockClear();
    expect(await resolveSessionMcpTools({ allowedTools: ["run_script"], ...previous })).toEqual({ mcpTools: [] });
    expect(mock.getTools).not.toHaveBeenCalled();
    expect(mock.shutdown).not.toHaveBeenCalled(); // The shared manager is owned by its original session.
  });

  it.each([null, [], ["bash"], ["run_script", "bash"]])("preserves direct MCP for ordinary capability selections: %j", async allowedTools => {
    const result = await resolveSessionMcpTools({ allowedTools, mcpServers });
    expect(result.mcpTools).toEqual([{ name: "mcp__mutate" }]);
    expect(mock.initialize).toHaveBeenCalledOnce();
  });
});
