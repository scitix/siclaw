import { describe, it, expect, vi, beforeEach } from "vitest";
import { CapabilityMaterializationError, materializeCapabilityInputs } from "./materialize.js";
import {
  CAPABILITY_FETCH_INPUT,
  CAPABILITY_INPUT_SOURCE_PART_REF,
  CAPABILITY_INPUT_WORKSPACE_REF,
} from "./contract.js";
import type { CapabilityFetchInputResponse } from "./contract.js";

function fakes(opts: {
  raw?: CapabilityFetchInputResponse;
  parts?: Record<string, CapabilityFetchInputResponse>;
  missingParts?: string[];
  workspace?: { bundle_base64?: string; bundle_sha256?: string };
  rawError?: Error;
  workspaceError?: Error;
  sourcesError?: Error;
  authoringError?: Error;
}) {
  const posts: Array<{ path: string; body: any }> = [];
  const client = {
    postJson: vi.fn(async (path: string, body: any) => {
      if (path === "/sources" && opts.sourcesError) throw opts.sourcesError;
      if (path.startsWith("/sources/") && opts.sourcesError) throw opts.sourcesError;
      if (path === "/authoring" && opts.authoringError) throw opts.authoringError;
      posts.push({ path, body });
      if (path === "/sources/begin") {
        return {
          ok: true,
          missing_parts: opts.missingParts ?? body.snapshot.parts.map((part: { part_id: string }) => part.part_id),
        };
      }
      return { ok: true };
    }),
  };
  const backend = {
    request: vi.fn(async (method: string, params: any) => {
      expect(method).toBe(CAPABILITY_FETCH_INPUT);
      if (params?.ref === CAPABILITY_INPUT_WORKSPACE_REF) {
        if (opts.workspaceError) throw opts.workspaceError;
        return opts.workspace ?? {};
      }
      if (params?.ref === CAPABILITY_INPUT_SOURCE_PART_REF) {
        return opts.parts?.[params.part_id] ?? {};
      }
      if (opts.rawError) throw opts.rawError;
      return opts.raw ?? {};
    }),
  };
  return { client, backend, posts };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("materializeCapabilityInputs", () => {
  it("fresh box: posts raw sources, then rehydrates the authoring workspace (locale rides along)", async () => {
    const { client, backend, posts } = fakes({
      raw: { bundle_base64: "UkFX", bundle_sha256: "aa", locale: "zh", input_revision: "manifest-1" },
      workspace: { bundle_base64: "V1M=", bundle_sha256: "bb" },
    });
    const result = await materializeCapabilityInputs({ client, backend, runId: "r1" });

    // The consumer-declared locale is surfaced to the caller (→ /session body)
    // and forwarded on both installs (they seed the constitution).
    expect(result.locale).toBe("zh");
    expect(result.inputRevision).toBe("manifest-1");
    expect(posts.map((p) => p.path)).toEqual(["/sources", "/authoring"]);
    expect(posts[0].body).toMatchObject({ locale: "zh" });
    expect(posts[1].body).toEqual({ run_id: "r1", bundle_base64: "V1M=", bundle_sha256: "bb", locale: "zh" });
    // Two fetches: default ref (raw) then the workspace ref.
    expect(backend.request).toHaveBeenNthCalledWith(1, CAPABILITY_FETCH_INPUT, { run_id: "r1" });
    expect(backend.request).toHaveBeenNthCalledWith(2, CAPABILITY_FETCH_INPUT, { run_id: "r1", ref: CAPABILITY_INPUT_WORKSPACE_REF });
  });

  it("dead-box recovery requests the exact checkpointed input revision", async () => {
    const { client, backend } = fakes({
      raw: { bundle_base64: "UkFX", input_revision: "manifest-1" },
    });
    const result = await materializeCapabilityInputs({
      client,
      backend,
      runId: "r1",
      inputRevision: "manifest-1",
    });
    expect(backend.request).toHaveBeenNthCalledWith(1, CAPABILITY_FETCH_INPUT, {
      run_id: "r1",
      input_revision: "manifest-1",
    });
    expect(result.inputRevision).toBe("manifest-1");
  });

  it("Source Snapshot v2 uploads only box-reported missing parts and commits before workspace", async () => {
    const snapshot = {
      version: 2 as const,
      manifest_sha256: "f".repeat(64),
      total_bytes: 7,
      file_count: 2,
      parts: [
        {
          part_id: "part-000001",
          sha256: "a".repeat(64),
          bundle_size_bytes: 10,
          unpacked_size_bytes: 3,
          file_count: 1,
          files: [{ path: "a.md", size_bytes: 3, sha256: "1".repeat(64) }],
        },
        {
          part_id: "part-000002",
          sha256: "b".repeat(64),
          bundle_size_bytes: 11,
          unpacked_size_bytes: 4,
          file_count: 1,
          files: [{ path: "b.md", size_bytes: 4, sha256: "2".repeat(64) }],
        },
      ],
    };
    const { client, backend, posts } = fakes({
      raw: { source_snapshot: snapshot, input_revision: "manifest-2", locale: "zh" },
      parts: {
        "part-000002": {
          bundle_base64: "UDI=",
          bundle_sha256: "b".repeat(64),
          input_revision: "manifest-2",
        },
      },
      missingParts: ["part-000002"],
      workspace: { bundle_base64: "V1M=" },
    });

    const result = await materializeCapabilityInputs({ client, backend, runId: "r2" });

    expect(result).toMatchObject({ inputRevision: "manifest-2", locale: "zh" });
    expect(posts.map((post) => post.path)).toEqual([
      "/sources/begin",
      "/sources/part",
      "/sources/commit",
      "/authoring",
    ]);
    expect(backend.request).toHaveBeenNthCalledWith(2, CAPABILITY_FETCH_INPUT, {
      run_id: "r2",
      input_revision: "manifest-2",
      ref: CAPABILITY_INPUT_SOURCE_PART_REF,
      part_id: "part-000002",
    });
  });

  it("Source Snapshot v2 rejects a part from another revision before upload", async () => {
    const snapshot = {
      version: 2 as const,
      manifest_sha256: "f".repeat(64),
      total_bytes: 3,
      file_count: 1,
      parts: [{
        part_id: "part-000001",
        sha256: "a".repeat(64),
        bundle_size_bytes: 10,
        unpacked_size_bytes: 3,
        file_count: 1,
        files: [{ path: "a.md", size_bytes: 3, sha256: "1".repeat(64) }],
      }],
    };
    const { client, backend, posts } = fakes({
      raw: { source_snapshot: snapshot, input_revision: "manifest-2" },
      parts: { "part-000001": { bundle_base64: "UDE=", input_revision: "manifest-other" } },
    });

    await expect(materializeCapabilityInputs({ client, backend, runId: "r2" })).rejects.toMatchObject({
      name: "CapabilityMaterializationError",
      stage: "source-install",
      message: expect.stringContaining("revision mismatch"),
    });
    expect(posts.map((post) => post.path)).toEqual(["/sources/begin"]);
  });

  it("Source Snapshot v2 requires an immutable input revision", async () => {
    const { client, backend, posts } = fakes({
      raw: {
        source_snapshot: {
          version: 2,
          manifest_sha256: "f".repeat(64),
          total_bytes: 0,
          file_count: 0,
          parts: [],
        },
      },
    });

    await expect(materializeCapabilityInputs({ client, backend, runId: "r2" })).rejects.toMatchObject({
      name: "CapabilityMaterializationError",
      stage: "source-install",
      message: expect.stringContaining("requires input_revision"),
    });
    expect(posts).toEqual([]);
  });

  it("rejects a consumer response for a different pinned revision before installing sources", async () => {
    const { client, backend, posts } = fakes({
      raw: { bundle_base64: "UkFX", input_revision: "manifest-2" },
    });

    await expect(materializeCapabilityInputs({
      client,
      backend,
      runId: "r1",
      inputRevision: "manifest-1",
    })).rejects.toMatchObject({
      name: "CapabilityMaterializationError",
      stage: "source-fetch",
      message: expect.stringContaining("input revision mismatch"),
    });
    expect(posts).toEqual([]);
  });

  it("rejects a pinned revision with no source bundle instead of starting empty", async () => {
    const { client, backend, posts } = fakes({
      raw: { input_revision: "manifest-1" },
    });

    await expect(materializeCapabilityInputs({
      client,
      backend,
      runId: "r1",
      inputRevision: "manifest-1",
    })).rejects.toMatchObject({
      name: "CapabilityMaterializationError",
      stage: "source-fetch",
      message: expect.stringContaining("returned no source bundle"),
    });
    expect(posts).toEqual([]);
  });

  it("live box (409 on /sources): never touches the workspace", async () => {
    const { client, backend, posts } = fakes({
      raw: { bundle_base64: "UkFX", input_revision: "current-but-not-installed" },
      workspace: { bundle_base64: "V1M=" },
      sourcesError: new Error(
        'AgentBox request failed: 409 {"error":"run already exists; upload sources before /session","run_id":"r1"}',
      ),
    });
    const result = await materializeCapabilityInputs({ client, backend, runId: "r1" });

    expect(posts).toEqual([]); // no /authoring — live on-disk state wins
    expect(backend.request).toHaveBeenCalledTimes(1); // workspace never fetched
    expect(result.inputRevision).toBeUndefined(); // keep the run's recovered checkpoint
  });

  it("live box detected via stable conflict code (message wording independent)", async () => {
    const err = Object.assign(new Error("conflict: box already holds this run"), {
      status: 409,
      code: "KBC_RUN_ALREADY_LIVE",
    });
    const { client, backend, posts } = fakes({
      raw: { bundle_base64: "UkFX" },
      workspace: { bundle_base64: "V1M=" },
      sourcesError: err,
    });
    await materializeCapabilityInputs({ client, backend, runId: "r1" });

    expect(posts).toEqual([]);
    expect(backend.request).toHaveBeenCalledTimes(1);
  });

  it("Source Snapshot v2 treats an untagged 409 as an install conflict, not a live reattach", async () => {
    const snapshot = {
      version: 2 as const,
      manifest_sha256: "f".repeat(64),
      total_bytes: 3,
      file_count: 1,
      parts: [{
        part_id: "part-000001",
        sha256: "a".repeat(64),
        bundle_size_bytes: 10,
        unpacked_size_bytes: 3,
        file_count: 1,
        files: [{ path: "a.md", size_bytes: 3, sha256: "1".repeat(64) }],
      }],
    };
    const conflict = Object.assign(
      new Error("AgentBox request failed: 409 source snapshot descriptor changed for the same run and revision"),
      { status: 409, code: "CONFLICT" },
    );
    const { client, backend, posts } = fakes({
      raw: { source_snapshot: snapshot, input_revision: "manifest-2" },
      sourcesError: conflict,
    });

    await expect(materializeCapabilityInputs({ client, backend, runId: "r2" })).rejects.toMatchObject({
      name: "CapabilityMaterializationError",
      stage: "source-install",
      cause: expect.objectContaining({ status: 409, code: "CONFLICT" }),
    });
    expect(posts).toEqual([]);
    expect(backend.request).toHaveBeenCalledTimes(1);
  });

  it("empty KB (no raw bundle): posts nothing and does not guess freshness", async () => {
    const { client, backend, posts } = fakes({ raw: {}, workspace: { bundle_base64: "V1M=" } });
    await materializeCapabilityInputs({ client, backend, runId: "r1" });
    expect(posts).toEqual([]);
    expect(backend.request).toHaveBeenCalledTimes(1);
  });

  it("raw fetch transport failure is typed and fails closed", async () => {
    const { client, backend, posts } = fakes({ rawError: new Error("consumer RPC timed out") });
    const error = await materializeCapabilityInputs({ client, backend, runId: "r1" }).catch((err) => err);

    expect(error).toMatchObject({
      name: "CapabilityMaterializationError",
      stage: "source-fetch",
      cause: expect.objectContaining({ message: "consumer RPC timed out" }),
    });
    expect(error).toBeInstanceOf(CapabilityMaterializationError);
    expect(posts).toEqual([]);
  });

  it("raw source install failure is typed and fails closed", async () => {
    const { client, backend, posts } = fakes({
      raw: { bundle_base64: "UkFX" },
      sourcesError: new Error("box install failed: 500"),
    });
    await expect(materializeCapabilityInputs({ client, backend, runId: "r1" })).rejects.toMatchObject({
      name: "CapabilityMaterializationError",
      stage: "source-install",
    });
    expect(posts).toEqual([]);
  });

  it("workspace fetch failure is typed and fails closed", async () => {
    const { client, backend, posts } = fakes({
      raw: { bundle_base64: "UkFX" },
      workspaceError: new Error("store hiccup"),
    });
    await expect(materializeCapabilityInputs({ client, backend, runId: "r1" })).rejects.toMatchObject({
      name: "CapabilityMaterializationError",
      stage: "workspace-fetch",
    });
    expect(posts.map((p) => p.path)).toEqual(["/sources"]);
  });

  it("workspace install failure is typed and fails closed", async () => {
    const { client, backend, posts } = fakes({
      raw: { bundle_base64: "UkFX" },
      workspace: { bundle_base64: "V1M=" },
      authoringError: new Error("box authoring install failed: 500"),
    });
    await expect(materializeCapabilityInputs({ client, backend, runId: "r1" })).rejects.toMatchObject({
      name: "CapabilityMaterializationError",
      stage: "workspace-install",
    });
    expect(posts.map((p) => p.path)).toEqual(["/sources"]);
  });

  it("brand-new attempt (empty workspace bundle): raw only, no /authoring", async () => {
    const { client, backend, posts } = fakes({ raw: { bundle_base64: "UkFX" }, workspace: {} });
    await materializeCapabilityInputs({ client, backend, runId: "r1" });
    expect(posts.map((p) => p.path)).toEqual(["/sources"]);
  });
});
