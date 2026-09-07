/**
 * Wire contract for the AgentBox sync-status envelope, focused on `tiers`.
 *
 * The box and the Runtime are released independently, so this normalizer is the
 * boundary where an older box's payload becomes a shape the Runtime can use. For
 * `tiers` the distinctions it has to preserve are unusually load-bearing: the
 * whole point of the field is to make a silent failure observable, and the two
 * ways of "saying nothing" mean opposite things.
 */
import { describe, it, expect } from "vitest";
import { AGENT_SYNC_STATUS_SCHEMA_VERSION, normalizeBoxSyncStatus } from "./agentbox-sync-status.js";

const REV_A = "a".repeat(64);
const REV_B = "b".repeat(64);

/** A minimal valid payload; each test overrides the part it is about. */
function payload(extra: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: AGENT_SYNC_STATUS_SCHEMA_VERSION,
    knowledge: { syncedAt: null, repos: [] },
    skills: { names: [] },
    mcp: { names: [] },
    ...extra,
  };
}

describe("tiers observation", () => {
  it("preserves both revisions when tiering ran end to end", () => {
    const status = normalizeBoxSyncStatus(payload({
      tiers: { menuRevision: REV_A, candidatesRevision: REV_A, observedAt: "2026-08-27T00:00:00.000Z" },
    }));
    expect(status.tiers).toEqual({
      menuRevision: REV_A,
      candidatesRevision: REV_A,
      observedAt: "2026-08-27T00:00:00.000Z",
    });
  });

  it("keeps the object when a turn ran with NO tiers, rather than dropping it", () => {
    // This is the report, not the absence of one. Dropping it here would make a
    // box that legitimately has no tiers indistinguishable from a box too old to
    // report — and that ambiguity is precisely why a consumer cannot adopt
    // "validate when present, skip when absent".
    const status = normalizeBoxSyncStatus(payload({
      tiers: { menuRevision: null, candidatesRevision: null, observedAt: "2026-08-27T00:00:00.000Z" },
    }));
    expect(status.tiers).toMatchObject({ menuRevision: null, candidatesRevision: null });
    expect(status).toHaveProperty("tiers");
  });

  it("distinguishes an OLD box, which says nothing at all", () => {
    // No `tiers` key: the field is absent, not null. Combined with schemaVersion
    // this is what tells a consumer "this box cannot report" apart from "this box
    // reports no tiers".
    const status = normalizeBoxSyncStatus(payload());
    expect("tiers" in status).toBe(false);
  });

  it("preserves an explicit null — observed nothing yet", () => {
    // The box sets this before any turn has completed, same convention as
    // harness/model. Distinct again from {both null}, which means a turn DID run.
    const status = normalizeBoxSyncStatus(payload({ tiers: null }));
    expect(status.tiers).toBeNull();
  });

  it("carries a one-sided pairing through verbatim, because which side is missing IS the diagnosis", () => {
    const menuOnly = normalizeBoxSyncStatus(payload({
      tiers: { menuRevision: REV_A, candidatesRevision: null, observedAt: "t" },
    }));
    expect(menuOnly.tiers).toMatchObject({ menuRevision: REV_A, candidatesRevision: null });

    const candidatesOnly = normalizeBoxSyncStatus(payload({
      tiers: { menuRevision: null, candidatesRevision: REV_A, observedAt: "t" },
    }));
    expect(candidatesOnly.tiers).toMatchObject({ menuRevision: null, candidatesRevision: REV_A });
  });

  it("keeps differing revisions differing, so a version skew stays visible", () => {
    const status = normalizeBoxSyncStatus(payload({
      tiers: { menuRevision: REV_A, candidatesRevision: REV_B, observedAt: "t" },
    }));
    expect(status.tiers!.menuRevision).not.toBe(status.tiers!.candidatesRevision);
  });

  it("rejects anything that is not a revision instead of passing it through", () => {
    // A consumer compares these for equality to decide whether tiering is live. A
    // non-revision value that survived would be compared as if it meant something:
    // two boxes both reporting "unknown" would look consistent with each other.
    for (const bad of ["not-hex", "A".repeat(64), "a".repeat(63), "", 42, {}, []]) {
      const status = normalizeBoxSyncStatus(payload({
        tiers: { menuRevision: bad, candidatesRevision: bad, observedAt: "t" },
      }));
      expect(status.tiers, `value ${JSON.stringify(bad)}`)
        .toMatchObject({ menuRevision: null, candidatesRevision: null });
    }
  });

  it("does not throw on a hostile tiers value", () => {
    // A malformed optional field must not cost the Runtime the whole observation;
    // everything else in the payload is still usable.
    for (const bad of [42, "tiers", [], true]) {
      const status = normalizeBoxSyncStatus(payload({ tiers: bad }));
      expect(status.skills).toEqual({ names: [] });
    }
  });
});

describe("mcp.servers observation", () => {
  it("leaves `servers` absent when the box did not send it (v3 box or MCP never initialized)", () => {
    const status = normalizeBoxSyncStatus(payload({ mcp: { names: ["devops"] } }));
    expect(status.mcp).toEqual({ names: ["devops"] });
    expect("servers" in status.mcp).toBe(false);
  });

  it("keeps an empty `servers` array distinct from an absent one", () => {
    const status = normalizeBoxSyncStatus(payload({ mcp: { names: [], servers: [] } }));
    expect(status.mcp.servers).toEqual([]);
  });

  it("preserves a connected and a failed server with the classified error", () => {
    const status = normalizeBoxSyncStatus(payload({
      mcp: {
        names: ["devops", "siverse"],
        servers: [
          { name: "devops", transport: "streamable-http", state: "connected", toolCount: 2,
            toolNames: ["get_change_detail", "list_change_records"], durationMs: 361, observedAt: "2026-09-07T09:44:58.643Z" },
          { name: "siverse", transport: "streamable-http", state: "failed", toolCount: 0, toolNames: [], durationMs: 20,
            observedAt: "2026-09-07T09:45:00.168Z",
            error: { kind: "not_found", httpStatus: 404, contentType: "text/html", message: "HTML page: Simate" } },
        ],
      },
    }));
    expect(status.mcp.servers).toEqual([
      { name: "devops", transport: "streamable-http", state: "connected", toolCount: 2,
        toolNames: ["get_change_detail", "list_change_records"], durationMs: 361, observedAt: "2026-09-07T09:44:58.643Z" },
      { name: "siverse", transport: "streamable-http", state: "failed", toolCount: 0, toolNames: [], durationMs: 20,
        observedAt: "2026-09-07T09:45:00.168Z",
        error: { kind: "not_found", httpStatus: 404, contentType: "text/html", message: "HTML page: Simate" } },
    ]);
  });

  it("drops entries without a name or a recognised state and never invents a connection", () => {
    const status = normalizeBoxSyncStatus(payload({
      mcp: {
        names: ["a", "b", "c"],
        servers: [
          { transport: "sse", state: "connected" },
          { name: "b", state: "pending" },
          { name: "c", state: "failed" },
        ],
      },
    }));
    expect(status.mcp.servers).toEqual([
      // A failed server without an explanation still reports failed, with an
      // `unknown` error rather than a fabricated success.
      { name: "c", transport: "", state: "failed", toolCount: 0, toolNames: [], durationMs: 0, observedAt: "",
        error: { kind: "unknown", message: "" } },
    ]);
  });

  it("maps an unrecognised error kind to unknown instead of leaking free text into the vocabulary", () => {
    const status = normalizeBoxSyncStatus(payload({
      mcp: { names: ["x"], servers: [{ name: "x", state: "failed", error: { kind: "weird", message: "boom" } }] },
    }));
    expect(status.mcp.servers?.[0].error).toEqual({ kind: "unknown", message: "boom" });
  });
});
