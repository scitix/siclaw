import { describe, it, expect } from "vitest";
import {
  validateRequestContext,
  renderRequestContext,
  MAX_OBSERVATIONS,
  MAX_OBSERVATION_BYTES,
  REQUEST_BUDGET_BYTES,
  type DelegationRequestContextV1,
} from "./delegation-request-context.js";

/**
 * Assertions are on `rejected_by`, never on the prose — a refusal that pins its sentence breaks on
 * every rewording while proving nothing, and this codebase has ~46 tests elsewhere that learned
 * that the hard way.
 */

const snapshot = (over: Partial<DelegationRequestContextV1> = {}): unknown => ({
  schema_version: 1,
  mode: "snapshot",
  scope: "exact",
  targets: [{ type: "cluster", cluster_binding: "cluster-a" }],
  ...over,
});

describe("schema_version is an integer >= 1", () => {
  it("refuses anything that names no contract", () => {
    for (const v of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1", null, undefined]) {
      expect(validateRequestContext(snapshot({ schema_version: v as never }))?.rejected_by).toBe("schema_version");
    }
    expect(validateRequestContext(snapshot({ schema_version: 2 }))).toBeNull();
  });
});

describe("scope x targets — exactly one legal shape each", () => {
  it("accepts the three legal combinations", () => {
    expect(validateRequestContext(snapshot())).toBeNull();
    expect(validateRequestContext(snapshot({ scope: "all_peer_bindings", targets: [] }))).toBeNull();
    expect(validateRequestContext(snapshot({ scope: "discovery", targets: [] }))).toBeNull();
  });

  it("refuses the three illegal ones — they have no honest answer", () => {
    // exact without targets asserts knowledge it does not have.
    expect(validateRequestContext(snapshot({ targets: [] }))?.rejected_by).toBe("scope_targets");
    // all_peer_bindings + targets: intersection or override is unknowable from the request.
    expect(validateRequestContext(snapshot({
      scope: "all_peer_bindings", targets: [{ type: "cluster", cluster_binding: "c" }],
    }))?.rejected_by).toBe("scope_targets");
    // discovery + targets: a guess presented as confirmed identity. Candidates go in observations.
    expect(validateRequestContext(snapshot({
      scope: "discovery", targets: [{ type: "cluster", cluster_binding: "c" }],
    }))?.rejected_by).toBe("scope_targets");
  });
});

describe("delta mode: scope and targets are ATOMIC", () => {
  it("accepts both absent — the peer's existing targets stand", () => {
    expect(validateRequestContext({
      schema_version: 1, mode: "delta",
      constraints: { user_requirements: ["read only"] },
    })).toBeNull();
  });

  it("accepts both present", () => {
    expect(validateRequestContext({
      schema_version: 1, mode: "delta", scope: "exact",
      targets: [{ type: "cluster", cluster_binding: "c" }],
    })).toBeNull();
  });

  it("refuses one without the other — the merge it would require is undefined", () => {
    // This is the case that had no answer: keeping the old targets makes a discovery request carry
    // targets (illegal above); clearing them is a deletion the caller never asked for. And the
    // gateway holds no persisted effective context to merge against.
    expect(validateRequestContext({ schema_version: 1, mode: "delta", scope: "discovery" })?.rejected_by)
      .toBe("delta_atomicity");
    expect(validateRequestContext({
      schema_version: 1, mode: "delta", targets: [{ type: "cluster", cluster_binding: "c" }],
    })?.rejected_by).toBe("delta_atomicity");
  });

  it("snapshot still requires both", () => {
    expect(validateRequestContext({ schema_version: 1, mode: "snapshot" })?.rejected_by).toBe("snapshot_required");
  });
});

describe("target required-field matrix", () => {
  it("enforces the fields each type actually needs", () => {
    expect(validateRequestContext(snapshot({ targets: [{ type: "cluster" } as never] }))?.rejected_by).toBe("target_fields");
    expect(validateRequestContext(snapshot({ targets: [{ type: "host" } as never] }))?.rejected_by).toBe("target_fields");
    expect(validateRequestContext(snapshot({
      targets: [{ type: "k8s_resource", cluster_binding: "c", kind: "Pod" } as never],
    }))?.rejected_by).toBe("target_fields");
    // namespace is optional — absent means cluster-scoped, which is a real shape.
    expect(validateRequestContext(snapshot({
      targets: [{ type: "k8s_resource", cluster_binding: "c", kind: "Node", name: "n1" }],
    }))).toBeNull();
  });

  it("refuses an ip target — it can never be checked against a binding", () => {
    // Which is why it belongs in observations: `targets` claims confirmed routing identity, and an
    // IP cannot satisfy that claim.
    expect(validateRequestContext(snapshot({ targets: [{ type: "ip", ip: "10.0.0.1" } as never] }))?.rejected_by)
      .toBe("target_type");
  });
});

describe("no free-text escape hatch", () => {
  it("refuses the fields that would undo every other rule", () => {
    for (const field of ["known_facts", "steps", "notes", "extra", "instructions"]) {
      expect(validateRequestContext(snapshot({ [field]: "anything" } as never))?.rejected_by).toBe("forbidden_field");
    }
  });
});

describe("observations carry provenance or they are refused", () => {
  it("requires a recognised source on every entry", () => {
    expect(validateRequestContext(snapshot({
      observations: [{ text: "pod is crashlooping" } as never],
    }))?.rejected_by).toBe("observation_source");
    expect(validateRequestContext(snapshot({
      observations: [{ text: "x", source: "my_hunch" } as never],
    }))?.rejected_by).toBe("observation_source");
    expect(validateRequestContext(snapshot({
      observations: [{ text: "x", source: "coordinator_tool" }],
    }))).toBeNull();
  });

  it("is bounded by count AND per entry", () => {
    // A total-bytes cap alone lets one oversized observation crowd out thirty real ones.
    expect(validateRequestContext(snapshot({
      observations: Array.from({ length: MAX_OBSERVATIONS + 1 }, () => ({ text: "x", source: "user" as const })),
    }))?.rejected_by).toBe("observations_count");
    expect(validateRequestContext(snapshot({
      observations: [{ text: "a".repeat(MAX_OBSERVATION_BYTES + 1), source: "user" }],
    }))?.rejected_by).toBe("observation_size");
  });
});

describe("access_mode is enforced, so the name and the checks are strict", () => {
  it("accepts the two legal values", () => {
    expect(validateRequestContext(snapshot({ execution_policy: { access_mode: "read_only" } }))).toBeNull();
    expect(validateRequestContext(snapshot({ execution_policy: { access_mode: "normal" } }))).toBeNull();
    // Absent means normal: the cautious-looking inverse would strip write tools from every
    // existing remediation delegation.
    expect(validateRequestContext(snapshot({ execution_policy: {} }))).toBeNull();
  });

  it("refuses an unrecognised value rather than defaulting it", () => {
    // Same reason the receiving router refuses one: a typo silently downgraded to `normal` hands a
    // peer write tools the caller believed it had withheld, and nothing says so.
    expect(validateRequestContext(snapshot({ execution_policy: { access_mode: "readonly" } as never }))
      ?.rejected_by).toBe("access_mode");
    expect(validateRequestContext(snapshot({ execution_policy: { access_mode: "" } as never }))
      ?.rejected_by).toBe("access_mode");
  });

  it("refuses the RETIRED name rather than honouring it as a synonym", () => {
    // A caller still sending requested_access_mode believes the field only advises; it now
    // enforces. Silently honouring it would give a peer fewer tools than the caller thinks it
    // asked for — a surprise in the safe direction is still a surprise about a permission.
    expect(validateRequestContext(snapshot({
      execution_policy: { requested_access_mode: "read_only" } as never,
    }))?.rejected_by).toBe("requested_access_mode_retired");
  });
});

describe("the budget rejects rather than truncates", () => {
  it("refuses an over-budget context instead of trimming it", () => {
    // Nothing has run yet, so the caller can send less. A silent trim on the way IN would drop a
    // user constraint — the loss this contract exists to prevent.
    const big = Array.from({ length: 30 }, () => ({ text: "a".repeat(3000), source: "user" as const }));
    const r = validateRequestContext(snapshot({ observations: big }));
    expect(r?.rejected_by).toBe("request_budget");
    expect(r?.message).toContain(String(REQUEST_BUDGET_BYTES));
  });
});

describe("rendering is deterministic and labels observations as unverified", () => {
  it("renders each block, and prints observed_at as unknown rather than omitting it", () => {
    const rendered = renderRequestContext({
      schema_version: 1, mode: "snapshot", scope: "exact",
      targets: [
        { type: "cluster", cluster_binding: "cluster-a" },
        { type: "k8s_resource", cluster_binding: "cluster-a", kind: "Pod", name: "web-1", namespace: "prod" },
        { type: "k8s_resource", cluster_binding: "cluster-a", kind: "Node", name: "n1" },
      ],
      constraints: {
        time_window: { from: "2026-08-25T00:00:00Z", to: "2026-08-25T02:00:00Z", timezone: "UTC" },
        user_requirements: ["do not restart anything", "if you cannot find it, say so"],
      },
      observations: [
        { text: "cetus is only a candidate", source: "coordinator_tool" },
        { text: "coredns OOMKilled x3", source: "peer_report", session_id: "sess-9", observed_at: "2026-08-25T01:00:00Z" },
      ],
    });

    expect(rendered).toContain("[AUTHORITATIVE TARGETS]");
    expect(rendered).toContain("- cluster cluster-a");
    expect(rendered).toContain("Pod/web-1 in namespace prod");
    // A cluster-scoped resource says so, rather than looking like a namespace was forgotten.
    expect(rendered).toContain("Node/n1 (cluster-scoped)");
    expect(rendered).toContain("[USER CONSTRAINTS]");
    expect(rendered).toContain("time window: from 2026-08-25T00:00:00Z to 2026-08-25T02:00:00Z (UTC)");
    expect(rendered).toContain("do not restart anything");
    expect(rendered).toContain("[UNVERIFIED OBSERVATIONS]");
    expect(rendered).toContain("These are LEADS, not facts");
    expect(rendered).toContain("source: peer_report (session sess-9)");
    // The most stale-prone case is the one with no timestamp, so the absence must be visible.
    expect(rendered).toContain("observed_at: unknown");
    // Never labelled as fact.
    expect(rendered).not.toContain("[FACTS]");
  });

  it("says the target is not yet identified under discovery, rather than rendering nothing", () => {
    const rendered = renderRequestContext({ schema_version: 1, mode: "snapshot", scope: "discovery", targets: [] });
    expect(rendered).toContain("not yet identified");
  });

  it("omits a block entirely when the caller sent nothing for it", () => {
    const rendered = renderRequestContext({
      schema_version: 1, mode: "snapshot", scope: "exact",
      targets: [{ type: "cluster", cluster_binding: "c" }],
    });
    expect(rendered).not.toContain("[USER CONSTRAINTS]");
    expect(rendered).not.toContain("[UNVERIFIED OBSERVATIONS]");
  });
});
