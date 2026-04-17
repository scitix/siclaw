import { describe, it, expect } from "vitest";
import {
  GATEWAY_SYNC_DESCRIPTORS,
  type GatewaySyncType,
  type GatewaySyncDescriptor,
} from "../gateway-sync.js";

describe("GATEWAY_SYNC_DESCRIPTORS", () => {
  const expectedTypes: GatewaySyncType[] = ["mcp", "skills", "cluster", "host", "knowledge"];

  it("contains exactly the five expected syncable types", () => {
    const actual = Object.keys(GATEWAY_SYNC_DESCRIPTORS).sort();
    expect(actual).toEqual([...expectedTypes].sort());
  });

  for (const t of expectedTypes) {
    describe(`descriptor for "${t}"`, () => {
      const d: GatewaySyncDescriptor = GATEWAY_SYNC_DESCRIPTORS[t];

      it("has a matching type field", () => {
        expect(d.type).toBe(t);
      });

      it("has a reload path starting with /api/reload-", () => {
        expect(d.reloadPath.startsWith("/api/reload-")).toBe(true);
      });

      it("has a retry config with sane defaults", () => {
        expect(d.retry.maxRetries).toBeGreaterThanOrEqual(1);
        expect(d.retry.baseDelayMs).toBeGreaterThan(0);
      });

      it("has a boolean requiresGatewayClient", () => {
        expect(typeof d.requiresGatewayClient).toBe("boolean");
      });

      it("has a boolean initialSync", () => {
        expect(typeof d.initialSync).toBe("boolean");
      });
    });
  }

  // Invariants specific to each type — these encode the contract called out in gateway-sync.ts

  it("mcp: requires Gateway client and does initial sync", () => {
    const d = GATEWAY_SYNC_DESCRIPTORS.mcp;
    expect(d.requiresGatewayClient).toBe(true);
    expect(d.initialSync).toBe(true);
    expect(d.gatewayPath).toBe("/api/internal/mcp-servers");
  });

  it("skills: requires Gateway client and does initial sync (bundle endpoint)", () => {
    const d = GATEWAY_SYNC_DESCRIPTORS.skills;
    expect(d.requiresGatewayClient).toBe(true);
    expect(d.initialSync).toBe(true);
    expect(d.gatewayPath).toBe("/api/internal/skills/bundle");
  });

  it("cluster: does NOT require Gateway client and skips initial sync (broker-driven)", () => {
    const d = GATEWAY_SYNC_DESCRIPTORS.cluster;
    expect(d.requiresGatewayClient).toBe(false);
    expect(d.initialSync).toBe(false);
    // gatewayPath is unused when requiresGatewayClient=false — must be empty string per comment
    expect(d.gatewayPath).toBe("");
  });

  it("host: does NOT require Gateway client and skips initial sync", () => {
    const d = GATEWAY_SYNC_DESCRIPTORS.host;
    expect(d.requiresGatewayClient).toBe(false);
    expect(d.initialSync).toBe(false);
    expect(d.gatewayPath).toBe("");
  });

  it("knowledge: requires Gateway client and does initial sync", () => {
    const d = GATEWAY_SYNC_DESCRIPTORS.knowledge;
    expect(d.requiresGatewayClient).toBe(true);
    expect(d.initialSync).toBe(true);
    expect(d.gatewayPath).toBe("/api/internal/knowledge/bundle");
  });

  it("all reload paths are unique", () => {
    const paths = Object.values(GATEWAY_SYNC_DESCRIPTORS).map((d) => d.reloadPath);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("all gateway paths (when required) are unique", () => {
    const paths = Object.values(GATEWAY_SYNC_DESCRIPTORS)
      .filter((d) => d.requiresGatewayClient)
      .map((d) => d.gatewayPath);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
