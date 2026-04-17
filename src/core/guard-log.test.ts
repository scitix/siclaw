import { describe, it, expect, vi, afterEach } from "vitest";
import { guardLog } from "./guard-log.js";

describe("guardLog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits JSON to console.warn with required fields", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    guardLog("my-guard", "transformed");

    expect(warn).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((warn.mock.calls[0][0] as string) ?? "{}");
    expect(payload.type).toBe("guard");
    expect(payload.guard).toBe("my-guard");
    expect(payload.action).toBe("transformed");
    expect(typeof payload.ts).toBe("number");
  });

  it("merges details into output record", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    guardLog("g2", "repaired", { count: 3, mode: "drop" });
    const payload = JSON.parse((warn.mock.calls[0][0] as string) ?? "{}");
    expect(payload.count).toBe(3);
    expect(payload.mode).toBe("drop");
    expect(payload.guard).toBe("g2");
    expect(payload.action).toBe("repaired");
  });

  it("handles undefined details without throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => guardLog("a", "b")).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("spreads details after base fields (details keys can override)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    guardLog("name", "act", { guard: "hijacked", extra: 1 });
    const payload = JSON.parse((warn.mock.calls[0][0] as string) ?? "{}");
    // Documented actual behavior: spread occurs after base fields, so detail keys win
    expect(payload.guard).toBe("hijacked");
    expect(payload.extra).toBe(1);
    expect(payload.action).toBe("act");
  });

  it("timestamp is close to Date.now()", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const before = Date.now();
    guardLog("g", "a");
    const after = Date.now();
    const payload = JSON.parse((warn.mock.calls[0][0] as string) ?? "{}");
    expect(payload.ts).toBeGreaterThanOrEqual(before);
    expect(payload.ts).toBeLessThanOrEqual(after);
  });
});
