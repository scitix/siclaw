import { describe, it, expect, vi, beforeEach } from "vitest";
import { CapabilityMaterializationError, materializeCapabilityInputs } from "./materialize.js";
import { CAPABILITY_FETCH_INPUT, CAPABILITY_INPUT_WORKSPACE_REF } from "./contract.js";

function fakes(opts: {
  raw?: { bundle_base64?: string; bundle_sha256?: string; locale?: string; input_revision?: string };
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
      if (path === "/authoring" && opts.authoringError) throw opts.authoringError;
      posts.push({ path, body });
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
      sourcesError: new Error("AgentBox request failed: 409 run r1 already exists"),
    });
    const result = await materializeCapabilityInputs({ client, backend, runId: "r1" });

    expect(posts).toEqual([]); // no /authoring — live on-disk state wins
    expect(backend.request).toHaveBeenCalledTimes(1); // workspace never fetched
    expect(result.inputRevision).toBeUndefined(); // keep the run's recovered checkpoint
  });

  it("live box detected via structured err.status (message wording independent)", async () => {
    // The client attaches err.status; a reworded message with no "failed: 409"
    // substring must still be recognized as box-already-live (finding E).
    const err = Object.assign(new Error("conflict: box already holds this run"), { status: 409 });
    const { client, backend, posts } = fakes({
      raw: { bundle_base64: "UkFX" },
      workspace: { bundle_base64: "V1M=" },
      sourcesError: err,
    });
    await materializeCapabilityInputs({ client, backend, runId: "r1" });

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
