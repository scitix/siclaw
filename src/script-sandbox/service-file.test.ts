import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { ScriptSandboxService } from "./service.js";
import { loadScriptSandboxConfig } from "./config.js";
import type { ScriptChannel, ScriptToolBinding } from "./types.js";

describe("file delivery over native and external channels", () => {
  it.each([false, true])("large data stays outside model output (external=%s)", async external => {
    let binding: ScriptToolBinding;
    let pending!: (value: any) => void;
    let failed: unknown;
    let id = 0;
    const c: ScriptChannel = { instanceId: "runner", stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      done: new Promise(() => {}), close: vi.fn(async () => {}),
      ...(external ? { bindTools: async (b: ScriptToolBinding) => { binding = b; } } : {}) };
    const emit = (frame: unknown) => (c.stdout as PassThrough).write(JSON.stringify(frame) + "\n");
    const invoke = async (tool: string, args: Record<string, unknown>, delivery?: "file") => {
      const call = { id: String(++id), tool, arguments: args, ...(delivery ? { delivery } : {}) };
      if (external) return binding.call(call) as Promise<any>;
      return new Promise<any>(resolve => { pending = resolve; emit({ type: "tool", call }); });
    };
    const value = { text: "node-data-🐍".repeat(40_000) };
    const broker = { authorize: vi.fn(async () => {}), authorizeResult: vi.fn(async () => {}), call: vi.fn(async () => value) };
    c.stdin.on("data", data => {
      const frame = JSON.parse(String(data));
      if (frame.type === "tool_result") { pending(frame.response); return; }
      void (async () => {
        const info = (await invoke("mcp.call", { server: "test", tool: "query", arguments: {} }, "file")).result;
        // Independent results may remain open while another is consumed.
        const second = (await invoke("mcp.call", { server: "test", tool: "query", arguments: {} }, "file")).result;
        expect(second.transfer_id).not.toBe(info.transfer_id);
        expect(broker.call).toHaveBeenCalledTimes(2);
        let offset = 0; const chunks: Buffer[] = [];
        while (offset < info.bytes) {
          const chunk = (await invoke("result.read", { transfer_id: info.transfer_id, offset })).result;
          chunks.push(Buffer.from(chunk.data, "base64")); offset = chunk.next_offset;
        }
        expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual(value);
        expect(broker.call).toHaveBeenCalledTimes(2); expect(broker.authorizeResult).toHaveBeenCalledTimes(chunks.length + 2);
        // Reusing a transfer cannot re-run the upstream tool or retrieve old data.
        expect((await invoke("result.read", { transfer_id: info.transfer_id, offset: 0 })).error).toBeTruthy();
        emit({ type: "stdout", data: Buffer.from("summary only").toString("base64") });
        emit({ type: "exit", code: 0 });
      })().catch(error => { failed = error; emit({ type: "exit", code: 1 }); });
    });
    const config = loadScriptSandboxConfig({ SICLAW_SCRIPT_SANDBOX_ENABLED: "true", SICLAW_SCRIPT_SANDBOX_IMAGE: "test" });
    const result = await new ScriptSandboxService(config, { start: async () => c }, broker).run({ language: "python", code: "pass" }, { userId: "u", agentId: "a", boxId: "b", sessionId: "s" });
    expect(failed).toBeUndefined(); expect(result.status).toBe("completed"); expect(result.tool_calls).toBe(2);
    expect(result.stdout).toBe("summary only"); expect(JSON.stringify(result)).not.toContain("node-data");
    expect(c.close).toHaveBeenCalledOnce();
  });
});

it("reports unconfirmed runner cleanup without losing a completed script result", async () => {
  const c: ScriptChannel = { instanceId: "fixture", stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    done: new Promise(() => {}), close: async () => { throw new Error("private-cleanup-error"); } };
  c.stdin.on("data", () => { (c.stdout as PassThrough).write(JSON.stringify({ type: "stdout", data: Buffer.from("summary").toString("base64") }) + "\n" + JSON.stringify({ type: "exit", code: 0 }) + "\n"); });
  const service = new ScriptSandboxService(loadScriptSandboxConfig({ SICLAW_SCRIPT_SANDBOX_ENABLED: "true", SICLAW_SCRIPT_SANDBOX_IMAGE: "fixture" }), { start: async () => c }, { authorize: async () => {}, call: async () => {} });
  const result = await service.run({ language: "python", code: "pass" }, { agentId: "a", userId: "u", sessionId: "s", boxId: "b" });
  expect(result).toMatchObject({ status: "completed", stdout: "summary", cleanup: "pending" });
  expect(result.notices?.join(" ")).toContain("do not automatically retry"); expect(JSON.stringify(result)).not.toContain("private-cleanup-error");
});

it("preserves unconfirmed cleanup when startup never returns a channel", async () => {
  const { SandboxToolError } = await import("./errors.js");
  const service = new ScriptSandboxService(loadScriptSandboxConfig({ SICLAW_SCRIPT_SANDBOX_ENABLED: "true", SICLAW_SCRIPT_SANDBOX_IMAGE: "fixture" }),
    { start: async () => { throw new SandboxToolError("CLEANUP_PENDING", "UNKNOWN", "pending"); } }, { authorize: async () => {}, call: async () => {} });
  const result = await service.run({ language: "python", code: "pass" }, { agentId: "a", userId: "u", sessionId: "s", boxId: "b" });
  expect(result).toMatchObject({ status: "failed", cleanup: "pending" });
});
