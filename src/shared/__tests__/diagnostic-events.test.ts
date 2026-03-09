import { describe, it, expect, beforeEach, vi } from "vitest";
import { emitDiagnostic, onDiagnostic, type DiagnosticEvent } from "../diagnostic-events.js";

describe("diagnostic event bus", () => {
  it("should call registered listeners", () => {
    const listener = vi.fn();
    const unsub = onDiagnostic(listener);

    const event: DiagnosticEvent = { type: "session_created", sessionId: "s1" };
    emitDiagnostic(event);

    expect(listener).toHaveBeenCalledWith(event);
    unsub();
  });

  it("should support multiple listeners", () => {
    const l1 = vi.fn();
    const l2 = vi.fn();
    const unsub1 = onDiagnostic(l1);
    const unsub2 = onDiagnostic(l2);

    emitDiagnostic({ type: "ws_connected" });

    expect(l1).toHaveBeenCalledTimes(1);
    expect(l2).toHaveBeenCalledTimes(1);
    unsub1();
    unsub2();
  });

  it("should unsubscribe correctly", () => {
    const listener = vi.fn();
    const unsub = onDiagnostic(listener);

    emitDiagnostic({ type: "ws_connected" });
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    emitDiagnostic({ type: "ws_connected" });
    expect(listener).toHaveBeenCalledTimes(1); // not called again
  });

  it("should not throw when a listener throws", () => {
    const badListener = vi.fn(() => { throw new Error("boom"); });
    const goodListener = vi.fn();
    const unsub1 = onDiagnostic(badListener);
    const unsub2 = onDiagnostic(goodListener);

    // Should not throw
    expect(() => emitDiagnostic({ type: "ws_connected" })).not.toThrow();

    // Good listener still called despite bad listener throwing
    expect(goodListener).toHaveBeenCalledTimes(1);
    unsub1();
    unsub2();
  });
});
