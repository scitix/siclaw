import { describe, it, expect } from "vitest";
import type { DiagnosticEvent } from "./diagnostic-events.js";

describe("a tool_call duration is absent rather than wrong", () => {
  it("expresses \"unknown\" instead of reporting 0", () => {
    // `durationMs` used to be required, so an unpairable end reported 0 — indistinguishable from a call
    // that really took no measurable time.
    const unknown: DiagnosticEvent = {
      type: "tool_call", toolName: "bash", outcome: "success", userId: "u", agentId: null,
    };
    expect(unknown.type).toBe("tool_call");
    expect("durationMs" in unknown).toBe(false);
  });

  it("does not pair a duration by ORDER when the event carries no call id", async () => {
    // The emitter minted `seq-N` on start and read `seq-<current counter>` on end, which pairs an end
    // with the LATEST start rather than its own. pi-agent runs a same-turn tool batch in PARALLEL, so
    // under concurrency the duration landed on a different call — the same class of bug as the
    // persistence pairing fixed in 895c23e4, and just as invisible, because a wrong number looks like a
    // number.
    //
    // Asserted at source level: driving the real brain subscription needs a live session, and the
    // property worth protecting is "there is no order-based fallback here" rather than any one timing.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(import.meta.dirname, "../agentbox/session.ts"), "utf8");
    const block = src.slice(src.indexOf('if (event.type === "tool_execution_start")'),
                            src.indexOf("if (event.type === \"agent_start\")"));
    expect(block, "no seq-N counter pairing").not.toMatch(/seq-\$\{/);
    expect(block, "the end must pair on the id alone").toMatch(/const callId = event\.toolCallId;/);
  });
});
