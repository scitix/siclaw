import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * `json_path` has unit tests for its parser and for the pipeline hook that applies it, and a test that
 * refuses it alongside `run_in_background`. What nothing asserted is the WIRING: that a tool actually
 * hands the projector to `postExecSecurity`. Delete `project: jsonPathProjector(params.json_path)` from
 * a call site and every one of those tests still passes — the parameter is accepted, the schema still
 * advertises it, and the agent silently gets the whole document back. That is precisely the failure the
 * background refusal exists to prevent, on the path that actually runs.
 *
 * Two tests, because they fail in different directions: the first proves projection really happens
 * through the real pipeline, the second proves it happens at EVERY call site, including ones added later.
 */

const spawnMock = vi.fn(() => ({ on: vi.fn(), unref: vi.fn(), kill: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: (...a: unknown[]) => spawnMock(...a) }));
vi.mock("../infra/k8s-checks.js", () => ({ checkNodeReady: vi.fn(async () => null) }));
const runInDebugPod = vi.fn();
vi.mock("../infra/debug-pod.js", () => ({
  ensureDebugPodReady: vi.fn(async () => ({ podName: "node-debug-x", namespace: "siclaw-debug" })),
  runInDebugPod: (...a: unknown[]) => runInDebugPod(...a),
  acquireDebugPod: vi.fn(() => "node-debug-x"),
  releaseDebugPod: vi.fn(),
}));

const { createNodeExecTool } = await import("./node-exec.js");

describe("json_path is applied on the path that runs, not just in the parser", () => {
  const DOC = JSON.stringify([
    { ifname: "eth0", operstate: "UP", addr_info: [{ local: "10.0.0.5" }] },
    { ifname: "lo", operstate: "UNKNOWN", addr_info: [{ local: "127.0.0.1" }] },
  ]);

  it("projects the field out of a real exec result", async () => {
    runInDebugPod.mockResolvedValue({ stdout: DOC, stderr: "", exitCode: 0 });
    const res = await createNodeExecTool().execute(
      "t1", { node: "node-1", command: "ip -j addr", json_path: ".[].ifname" },
      new AbortController().signal, {} as never,
    );
    const text = res.content[0].text as string;
    expect(text).toContain("eth0");
    expect(text).toContain("lo");
    // The projection is the point: the fields NOT asked for must be gone. Without the wiring the whole
    // document comes back and every one of these would still be present.
    expect(text).not.toContain("operstate");
    expect(text).not.toContain("addr_info");
    expect(text).not.toContain("10.0.0.5");
  });

  it("reports a projection that matched nothing instead of returning the whole document", async () => {
    runInDebugPod.mockResolvedValue({ stdout: DOC, stderr: "", exitCode: 0 });
    const res = await createNodeExecTool().execute(
      "t2", { node: "node-1", command: "ip -j addr", json_path: ".[].no_such_field" },
      new AbortController().signal, {} as never,
    );
    const text = res.content[0].text as string;
    // Silently falling back to the full document is the dangerous outcome — the agent cannot tell its
    // filter did nothing, and on a large document that is exactly the context blowout json_path exists
    // to avoid.
    expect(text).not.toContain("operstate");
  });
});

describe("every tool offering json_path wires it at every output site", () => {
  it("passes project: to each postExecSecurity call", () => {
    const root = resolve(import.meta.dirname);
    for (const file of ["node-exec.ts", "pod-exec.ts", "host-exec.ts"]) {
      const src = readFileSync(resolve(root, file), "utf8");
      if (!src.includes("json_path")) continue;

      // Walk each postExecSecurity( … ) call by matching parentheses, so a nested call or a multi-line
      // options object cannot fool a regex.
      const sites: string[] = [];
      for (let i = src.indexOf("postExecSecurity("); i !== -1; i = src.indexOf("postExecSecurity(", i + 1)) {
        let depth = 0, j = i + "postExecSecurity".length;
        for (; j < src.length; j++) {
          if (src[j] === "(") depth++;
          else if (src[j] === ")" && --depth === 0) break;
        }
        sites.push(src.slice(i, j + 1));
      }
      expect(sites.length, `${file}: expected postExecSecurity call sites`).toBeGreaterThan(0);
      for (const site of sites) {
        expect(site, `${file}: a postExecSecurity call omits project:, so json_path is dropped there\n${site.slice(0, 200)}`)
          .toContain("project:");
      }
    }
  });
});
