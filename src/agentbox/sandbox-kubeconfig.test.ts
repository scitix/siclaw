import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { withSandboxKubeconfig } from "./sandbox-kubeconfig.js";

const exec = vi.hoisted(() => vi.fn());
vi.mock("../tools/infra/bounded-exec.js", () => ({
  boundedExec: exec, DEFAULT_MAX_BUFFER: 10 * 1024 * 1024,
  BoundedExecTimeout: class extends Error {}, BoundedExecFailure: class extends Error {},
  BoundedExecAborted: class extends Error {}, BoundedExecOverflow: class extends Error {},
}));
const { createRestrictedBashTool } = await import("../tools/cmd-exec/restricted-bash.js");
const dirs: string[] = [];
function directory() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-credential-")); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); vi.clearAllMocks(); });
const config = (token: string) => JSON.stringify({ "current-context": "c", contexts: [{ name: "c", context: { cluster: "c", user: "u" } }],
  clusters: [{ name: "c", cluster: { server: "https://example.test" } }], users: [{ name: "u", user: { token } }] });

it("executes with the authorized snapshot despite a stale cache and removes it afterwards", async () => {
  const dir = directory();
  const cached = path.join(dir, "cached.kubeconfig");
  fs.writeFileSync(cached, config("old-token"));
  const ensureCluster = vi.fn();
  const listClustersLocalInfo = vi.fn(() => [{ path: cached, meta: { name: "prod" } }]);
  const approved = config("current-token");
  let snapshot = "";
  exec.mockImplementation(async (_command: string, options: any) => {
    snapshot = options.env.KUBECONFIG;
    fs.writeFileSync(cached, config("concurrent-refresh"));
    expect(fs.readFileSync(snapshot, "utf8")).toBe(approved);
    expect(fs.statSync(snapshot).mode & 0o007).toBe(0);
    return { stdout: "node-1", stderr: "" };
  });
  await withSandboxKubeconfig(dir, approved, async kubeconfigPath => {
    const tool = createRestrictedBashTool({ credentialBroker: { ensureCluster, listClustersLocalInfo } as any }, undefined, { kubeconfigPath, outputMode: "data" });
    const result = await tool.execute("snapshot-test", { cluster: "prod", command: "kubectl get nodes" });
    expect(JSON.stringify(result)).toContain("node-1");
    expect(JSON.stringify(result)).not.toContain("current-token");
  });
  expect(exec).toHaveBeenCalledOnce();
  expect(ensureCluster).not.toHaveBeenCalled();
  expect(listClustersLocalInfo).not.toHaveBeenCalled();
  expect(fs.existsSync(snapshot)).toBe(false);
  expect(fs.readdirSync(dir)).toEqual(["cached.kubeconfig"]);
});

it("cleans up on execution failure and rejects active authentication before creating files", async () => {
  const dir = directory();
  await expect(withSandboxKubeconfig(dir, config("t"), async () => { throw new Error("cancelled"); })).rejects.toThrow("cancelled");
  expect(fs.readdirSync(dir)).toEqual([]);
  const doc = JSON.parse(config("t")); doc.users[0].user.exec = { command: "sh" };
  const execute = vi.fn();
  await expect(withSandboxKubeconfig(dir, JSON.stringify(doc), execute)).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
  expect(fs.readdirSync(dir)).toEqual([]);
});
