import { describe, expect, it } from "vitest";
import { DIGEST_STRIPPED_ARGS, actionDigest } from "./action-digest.js";

describe("actionDigest", () => {
  it("is independent of key insertion order", () => {
    expect(actionDigest("k8s_scale", { a: 1, b: 2 })).toBe(actionDigest("k8s_scale", { b: 2, a: 1 }));
  });

  it("is independent of key order at EVERY nesting level", () => {
    const one = actionDigest("apply", { spec: { replicas: 3, image: "x", meta: { ns: "p", name: "q" } } });
    const two = actionDigest("apply", { spec: { meta: { name: "q", ns: "p" }, image: "x", replicas: 3 } });
    expect(one).toBe(two);
  });

  it("distinguishes different tools with identical arguments", () => {
    expect(actionDigest("scale", { n: 1 })).not.toBe(actionDigest("delete", { n: 1 }));
  });

  it("distinguishes different argument values", () => {
    expect(actionDigest("scale", { replicas: 3 })).not.toBe(actionDigest("scale", { replicas: 4 }));
  });

  it("is sensitive to ARRAY order (a list is part of the action)", () => {
    expect(actionDigest("evict", { pods: ["a", "b"] })).not.toBe(actionDigest("evict", { pods: ["b", "a"] }));
  });

  it("strips the control arguments at the top level", () => {
    const bare = actionDigest("k8s_scale", { replicas: 12 });
    for (const key of DIGEST_STRIPPED_ARGS) {
      expect(actionDigest("k8s_scale", { replicas: 12, [key]: "whatever" })).toBe(bare);
    }
    // Both at once, and a changed control value, still digest to the same action.
    expect(actionDigest("k8s_scale", {
      replicas: 12,
      approval_proposal_id: "prop_1",
      approval_receipt: "r.token",
    })).toBe(bare);
  });

  it("does NOT strip a same-named key nested inside the arguments", () => {
    // A nested field of that name is payload the approver saw; removing it would
    // silently digest a DIFFERENT action than the one about to run.
    const withNested = actionDigest("write", { body: { approval_proposal_id: "prop_1" } });
    const withoutNested = actionDigest("write", { body: {} });
    expect(withNested).not.toBe(withoutNested);
    // And stripping the top level does not touch the nested one.
    expect(actionDigest("write", { approval_proposal_id: "top", body: { approval_proposal_id: "prop_1" } }))
      .toBe(withNested);
  });

  it("sorts non-ASCII keys by UTF-8 BYTE order, not UTF-16 code-unit order", () => {
    // "\u{1F600}" (emoji, non-BMP) vs "Ａ" (fullwidth A): JS default string
    // sort puts the surrogate pair FIRST (0xD83D < 0xFF21) while UTF-8 bytes put
    // it LAST (0xF0 > 0xEF). Order-independence must hold either way.
    const keyA = "\u{1F600}";
    const keyB = "Ａ";
    expect([keyA, keyB].sort()).toEqual([keyA, keyB]); // pins the JS-sort disagreement
    expect(actionDigest("t", { [keyA]: 1, [keyB]: 2 })).toBe(actionDigest("t", { [keyB]: 2, [keyA]: 1 }));
    // A byte-ordered canonicalisation puts the fullwidth key before the emoji,
    // so the digest differs from one that trusted the default sort.
    expect(actionDigest("t", { [keyA]: 1, [keyB]: 2 })).not.toBe(actionDigest("t", { [keyA]: 2, [keyB]: 1 }));
  });

  it("drops undefined members so an explicit undefined equals an absent key", () => {
    expect(actionDigest("t", { a: 1, b: undefined })).toBe(actionDigest("t", { a: 1 }));
  });

  it("handles non-object arguments without throwing", () => {
    expect(actionDigest("t", undefined)).toMatch(/^[0-9a-f]{64}$/);
    expect(actionDigest("t", null)).toMatch(/^[0-9a-f]{64}$/);
    expect(actionDigest("t", "text")).toMatch(/^[0-9a-f]{64}$/);
    expect(actionDigest("t", [1, 2])).toMatch(/^[0-9a-f]{64}$/);
    // `undefined` and `null` both mean "this call takes no arguments", so they
    // canonicalise to the same encoding — the actions really are identical.
    expect(actionDigest("t", undefined)).toBe(actionDigest("t", null));
    expect(actionDigest("t", undefined)).not.toBe(actionDigest("t", {}));
  });

  it("returns a stable sha256 hex string", () => {
    const digest = actionDigest("k8s_scale", { replicas: 12 });
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(actionDigest("k8s_scale", { replicas: 12 })).toBe(digest);
  });
});
