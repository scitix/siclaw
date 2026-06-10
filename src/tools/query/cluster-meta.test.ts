import { describe, it, expect } from "vitest";
import { flattenClusterMeta } from "./cluster-meta.js";

describe("flattenClusterMeta", () => {
  it("returns {} for undefined or empty entries", () => {
    expect(flattenClusterMeta(undefined)).toEqual({});
    expect(flattenClusterMeta([])).toEqual({});
  });

  it("flattens to key→value (stable key, not editable display_name)", () => {
    // key is what sicore guarantees unique per (org_id, key); display_name is
    // editable display text that can collide — so it must NOT be the map key.
    expect(flattenClusterMeta([
      { key: "rdma_type", display_name: "RDMA Type", value: "SR-IOV" },
      { key: "scheduler", value: "volcano" },
    ])).toEqual({ meta: { rdma_type: "SR-IOV", scheduler: "volcano" } });
  });

  it("does not collide when two entries share a display_name", () => {
    // Same display_name, distinct keys → both survive (would clobber if
    // display_name were the map key).
    expect(flattenClusterMeta([
      { key: "rdma_type", display_name: "Network", value: "SR-IOV" },
      { key: "cni", display_name: "Network", value: "calico" },
    ])).toEqual({ meta: { rdma_type: "SR-IOV", cni: "calico" } });
  });

  it("drops reserved system keys (registry) at the model-visible boundary", () => {
    // `registry` is sicore's internal debug-image plumbing (IsReservedSystemKey),
    // surfaced via debug_image — never an infra fact for the model.
    expect(flattenClusterMeta([
      { key: "registry", value: "registry.example.com/busybox:1.36" },
      { key: "rdma_type", value: "SR-IOV" },
    ])).toEqual({ meta: { rdma_type: "SR-IOV" } });
  });

  it("returns {} when only reserved/malformed entries remain", () => {
    expect(flattenClusterMeta([{ key: "registry", value: "x" }])).toEqual({});
  });

  it("drops malformed entries (defensive — list path is not pre-filtered)", () => {
    const entries = [
      { key: "ok", value: "good" },
      { key: "no_value" },     // missing value
      { value: "no_key" },     // missing key
      { key: 1, value: 2 },    // non-string key/value
      null,
      "garbage",
    ] as any;
    expect(flattenClusterMeta(entries)).toEqual({ meta: { ok: "good" } });
  });
});
