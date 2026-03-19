import { describe, it, expect } from "vitest";
import { computeSigId } from "./id.js";

describe("computeSigId", () => {
  it("returns a 12-character lowercase hex string", () => {
    const id = computeSigId("pkg/server.go", 42, "failed to connect to %s:%d");
    expect(id).toMatch(/^[0-9a-f]{12}$/);
  });

  it("is deterministic — same inputs produce same output", () => {
    const id1 = computeSigId("pkg/server.go", 42, "failed to connect to %s:%d");
    const id2 = computeSigId("pkg/server.go", 42, "failed to connect to %s:%d");
    expect(id1).toBe(id2);
  });

  it("different templates produce different IDs", () => {
    const id1 = computeSigId("pkg/server.go", 42, "failed to connect to %s:%d");
    const id2 = computeSigId("pkg/server.go", 42, "connection established to %s:%d");
    expect(id1).not.toBe(id2);
  });

  it("different line numbers produce different IDs", () => {
    const id1 = computeSigId("pkg/server.go", 42, "failed to connect to %s:%d");
    const id2 = computeSigId("pkg/server.go", 43, "failed to connect to %s:%d");
    expect(id1).not.toBe(id2);
  });

  it("different files produce different IDs", () => {
    const id1 = computeSigId("a.go", 42, "failed to connect to %s:%d");
    const id2 = computeSigId("b.go", 42, "failed to connect to %s:%d");
    expect(id1).not.toBe(id2);
  });
});
