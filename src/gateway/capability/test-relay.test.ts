import { describe, expect, it } from "vitest";
import { driveTestSession } from "./test-relay.js";
import type { AgentBoxClient } from "../agentbox/client.js";
import type { FrontendWsClient } from "../frontend-ws-client.js";
import type { CapabilityEventFrame } from "./contract.js";

function fakeClient(events: Array<Record<string, unknown>>, opts?: { expectPath?: (p: string) => void }): AgentBoxClient {
  return {
    async *streamPath(path: string) {
      opts?.expectPath?.(path);
      for (const e of events) yield e;
    },
  } as unknown as AgentBoxClient;
}

function fakeFrontend() {
  const emitted: Array<{ method: string; frame: CapabilityEventFrame }> = [];
  const requests: string[] = [];
  const frontend = {
    emitEvent: (method: string, frame: unknown) => {
      emitted.push({ method, frame: frame as CapabilityEventFrame });
    },
    request: async (method: string) => {
      requests.push(method);
      return {};
    },
  } as unknown as FrontendWsClient;
  return { frontend, emitted, requests };
}

describe("driveTestSession", () => {
  it("forwards test frames live on the parent run and stops at end", async () => {
    const { frontend, emitted } = fakeFrontend();
    let touched = 0;
    let streamedPath = "";
    await driveTestSession({
      client: fakeClient(
        [
          { type: "session", session_id: "sid-1" },
          { type: "log", text: "reading index.md" },
          { type: "turn_done", text: "the answer" },
          { type: "error", error: "boom" },
          { type: "end" },
          // anything after end must never be read
          { type: "log", text: "MUST NOT APPEAR" },
        ],
        { expectPath: (p) => (streamedPath = p) },
      ),
      runId: "run-1",
      testSessionId: "tid-1",
      frontendClient: frontend,
      touch: () => touched++,
    });

    expect(streamedPath).toBe("/test-events/tid-1");
    expect(touched).toBe(5); // one per consumed frame, none after end
    expect(emitted.map((e) => e.method)).toEqual(Array(5).fill("capability.event"));
    const frames = emitted.map((e) => e.frame);
    // every frame is a "test" frame on the PARENT run carrying the tid
    for (const f of frames) {
      expect(f.run_id).toBe("run-1");
      expect(f.type).toBe("test");
      expect(f.payload.test_session_id).toBe("tid-1");
    }
    expect(frames.map((f) => f.payload.kind)).toEqual(["session", "log", "turn_done", "error", "end"]);
    expect(frames[1].payload.text).toBe("reading index.md");
    expect(frames[2].payload.text).toBe("the answer");
    // error frames surface the error text (live-only diagnostics)
    expect(frames[3].payload.text).toBe("boom");
    expect(frames.some((f) => f.payload.text === "MUST NOT APPEAR")).toBe(false);
  });

  it("is stateless: never persists turns, artifacts, or lifecycle", async () => {
    const { frontend, emitted, requests } = fakeFrontend();
    await driveTestSession({
      client: fakeClient([
        { type: "turn_done", text: "a full assistant reply" },
        { type: "end" },
      ]),
      runId: "run-1",
      testSessionId: "tid-1",
      frontendClient: frontend,
    });
    // live frames only — the frontend client's request() (persistTurn /
    // persistArtifact / persistRunState) must never be touched by a test relay.
    expect(requests).toEqual([]);
    expect(emitted).toHaveLength(2);
  });
});
