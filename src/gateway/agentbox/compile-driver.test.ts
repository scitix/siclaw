import { describe, it, expect, vi } from "vitest";
import { driveCompile, driveSession } from "./compile-driver.js";
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
    emitEvent: vi.fn((channel: string, data: unknown) => {
      events.push({ channel, data });
    }),
    request: vi.fn((method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "compile.sourceBundle") {
        return Promise.resolve({
          bundle_base64: "c291cmNlcy10Zy16",
          bundle_sha256: "abc123",
          source_ref: "knowledge://repos/kb/manifests/m1",
        });
      }
      return Promise.resolve({ ok: true });
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

    await driveCompile({
      client,
      runId: "r1",
      round: 1,
      instruction: "# KB Authoring Compile Task",
      authoringBundleBase64: "YXV0aG9yaW5nLXRnei16",
      authoringBundleSHA256: "authoring123",
      authoringBundleSizeBytes: 19,
      frontendClient,
    });

    expect(client.postJson as any).toHaveBeenNthCalledWith(1, "/sources", {
      run_id: "r1",
      bundle_base64: "c291cmNlcy10Zy16",
      bundle_sha256: "abc123",
    });
    expect(client.postJson as any).toHaveBeenNthCalledWith(2, "/authoring", {
      run_id: "r1",
      bundle_base64: "YXV0aG9yaW5nLXRnei16",
      bundle_sha256: "authoring123",
      bundle_size_bytes: 19,
    });
    expect(client.postJson as any).toHaveBeenNthCalledWith(3, "/compile", {
      run_id: "r1",
      round: 1,
      source_ref: "knowledge://repos/kb/manifests/m1",
      instruction: "# KB Authoring Compile Task",
    });

    expect(calls.map((c) => c.method)).toEqual(["compile.sourceBundle", "compile.summary", "compile.parked", "compile.done"]);
    expect(calls[0].params).toEqual({ run_id: "r1" });
    expect(calls[1].params).toEqual({ run_id: "r1", summary: "read 5 docs" });
    expect(calls[2].params).toEqual({ run_id: "r1", checkpoint });
    expect(calls[3].params).toEqual({ run_id: "r1", bundle: "YmFzZTY0", message: "compiled" });

    // Live stream: EVERY box event (incl. log + end) is relayed as compile.event.
    expect(events.map((e) => e.channel)).toEqual(["compile.event", "compile.event", "compile.event", "compile.event", "compile.event"]);
    expect(events.map((e) => (e.data.event as { type: string }).type)).toEqual(["summary", "log", "parked", "done", "end"]);
    expect(events[0].data.run_id).toBe("r1");
  });

  it("relays a box error as compile.failed so the run goes terminal", async () => {
    const { client: frontendClient, calls } = makeFrontend();
    const client = makeClient([{ type: "error", error: "boom" }, { type: "end" }]);

    await driveCompile({ client, runId: "r1", round: 2, frontendClient });

    expect(calls).toEqual([
      { method: "compile.sourceBundle", params: { run_id: "r1" } },
      { method: "compile.failed", params: { run_id: "r1", error: "boom" } },
    ]);
  });

  it("relays box syncArtifacts to compile.syncArtifacts so mid-compile work is durable", async () => {
    const { client: frontendClient, calls } = makeFrontend();
    const artifacts = [{ path: "candidate/01.md", content: "# hi" }];
    const client = makeClient([
      { type: "syncArtifacts", artifacts },
      { type: "done", bundle_b64: "YmFzZTY0", message: "compiled" },
      { type: "end" },
    ]);

    await driveCompile({ client, runId: "r1", round: 1, frontendClient });

    expect(calls.map((c) => c.method)).toEqual(["compile.sourceBundle", "compile.syncArtifacts", "compile.done"]);
    expect(calls[1].params).toEqual({ run_id: "r1", artifacts });
  });

  it("relays a conversational turn_done to compile.assistantTurn (prepare chat persist)", async () => {
    const { client: frontendClient, calls, events } = makeFrontend();
    const client = makeClient([
      { type: "log", text: "let me think" },
      { type: "turn_done", text: "Here is my answer." },
    ]);

    await driveCompile({ client, runId: "r1", round: 1, frontendClient });

    // log is box-local (live only); turn_done persists the assistant reply.
    expect(calls.map((c) => c.method)).toEqual(["compile.sourceBundle", "compile.assistantTurn"]);
    expect(calls[1].params).toEqual({ run_id: "r1", text: "Here is my answer." });
    expect(events.map((e) => (e.data.event as { type: string }).type)).toEqual(["log", "turn_done"]);
  });
});

describe("driveSession", () => {
  it("relays the session stream WITHOUT the compile setup POSTs", async () => {
    const { client: frontendClient, calls, events } = makeFrontend();
    const client = makeClient([
      { type: "log", text: "thinking out loud" },
      { type: "turn_done", text: "the KB should cover X and Y" },
      { type: "end" },
    ]);

    await driveSession({ client, runId: "s1", frontendClient });

    // A session is started/fed by the compile.message handler, not the relay —
    // so driveSession never POSTs /sources|/authoring|/compile.
    expect(client.postJson as any).not.toHaveBeenCalled();
    expect(calls.map((c) => c.method)).toEqual(["compile.assistantTurn"]);
    expect(calls[0].params).toEqual({ run_id: "s1", text: "the KB should cover X and Y" });
    expect(events.map((e) => (e.data.event as { type: string }).type)).toEqual(["log", "turn_done", "end"]);
  });

  it("an empty turn_done relays an empty text (sicore no-ops, e.g. a pure tool turn)", async () => {
    const { client: frontendClient, calls } = makeFrontend();
    const client = makeClient([{ type: "turn_done" }, { type: "end" }]);

    await driveSession({ client, runId: "s1", frontendClient });

    expect(calls).toEqual([{ method: "compile.assistantTurn", params: { run_id: "s1", text: "" } }]);
  });
});
