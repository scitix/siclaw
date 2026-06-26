import { describe, it, expect, vi } from "vitest";
import { driveCompile } from "./compile-driver.js";
import type { AgentBoxClient } from "./client.js";
import type { FrontendWsClient } from "../frontend-ws-client.js";

function makeClient(events: unknown[]): AgentBoxClient {
  return {
    postJson: vi.fn().mockResolvedValue({ ok: true }),
    // eslint-disable-next-line require-yield
    async *streamPath() {
      for (const e of events) yield e;
    },
  } as unknown as AgentBoxClient;
}

function makeFrontend(): {
  client: FrontendWsClient;
  calls: Array<{ method: string; params: any }>;
  events: Array<{ channel: string; data: any }>;
} {
  const calls: Array<{ method: string; params: any }> = [];
  const events: Array<{ channel: string; data: any }> = [];
  const client = {
    request: vi.fn((method: string, params: unknown) => {
      calls.push({ method, params });
      return Promise.resolve({ ok: true });
    }),
    emitEvent: vi.fn((channel: string, data: unknown) => {
      events.push({ channel, data });
    }),
  } as unknown as FrontendWsClient;
  return { client, calls, events };
}

describe("driveCompile", () => {
  it("starts the box and relays summary/parked/done to sicore compile.* RPCs", async () => {
    const { client: frontendClient, calls, events } = makeFrontend();
    const checkpoint = {
      round: 1,
      contradictions: [{ id: "c1", options: ["a", "b", "unsure"] }],
      ledger_ref: "run://r1",
    };
    const client = makeClient([
      { type: "summary", summary: "read 5 docs" },
      { type: "log", text: "thinking" }, // box-local, not relayed
      { type: "parked", checkpoint },
      { type: "done", bundle_b64: "YmFzZTY0", message: "compiled" },
      { type: "end" }, // not relayed
    ]);

    await driveCompile({ client, runId: "r1", round: 1, frontendClient });

    expect(client.postJson as any).toHaveBeenCalledWith("/compile", {
      run_id: "r1",
      round: 1,
      source_ref: undefined,
    });

    expect(calls.map((c) => c.method)).toEqual(["compile.summary", "compile.parked", "compile.done"]);
    expect(calls[0].params).toEqual({ run_id: "r1", summary: "read 5 docs" });
    expect(calls[1].params).toEqual({ run_id: "r1", checkpoint });
    expect(calls[2].params).toEqual({ run_id: "r1", bundle: "YmFzZTY0", message: "compiled" });

    // Live stream: EVERY box event (incl. log + end) is relayed as compile.event.
    expect(events.map((e) => e.channel)).toEqual(["compile.event", "compile.event", "compile.event", "compile.event", "compile.event"]);
    expect(events.map((e) => (e.data.event as { type: string }).type)).toEqual(["summary", "log", "parked", "done", "end"]);
    expect(events[0].data.run_id).toBe("r1");
  });

  it("relays box error events via the summary channel (v1 has no compile.failed)", async () => {
    const { client: frontendClient, calls } = makeFrontend();
    const client = makeClient([{ type: "error", error: "boom" }, { type: "end" }]);

    await driveCompile({ client, runId: "r1", round: 2, frontendClient });

    expect(calls).toEqual([{ method: "compile.summary", params: { run_id: "r1", summary: "error: boom" } }]);
  });
});
