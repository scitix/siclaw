import { beforeEach, expect, it, vi } from "vitest";
import type { ExecEnv } from "./exec-utils.js";
const { kubectl } = vi.hoisted(() => ({ kubectl: vi.fn() }));
vi.mock("./debug-pod.js", () => ({ kubectlExec: kubectl }));
import { ensureSandboxDebugQuota, SANDBOX_DEBUG_NAMESPACE } from "./sandbox-debug.js";
const env = {} as ExecEnv;
let objects: Map<string, any>;
beforeEach(() => {
  objects = new Map();
  kubectl.mockReset().mockImplementation(async (args: string[], _env, _timeout, _signal, namespace, data) => {
    if (args[0] === "get") return { stdout: JSON.stringify(objects.get(args[1])) ?? "" };
    const manifest = JSON.parse(data);
    const key = manifest.kind.toLowerCase();
    if (objects.has(key)) throw new Error("already exists");
    if (key === "namespace") expect(manifest.metadata.name).toBe(SANDBOX_DEBUG_NAMESPACE);
    else expect(namespace).toBe(SANDBOX_DEBUG_NAMESPACE);
    objects.set(key, manifest);
    return { stdout: "" };
  });
});
it("provisions a dedicated namespace and counts every Pod, including terminal/terminating Pods", async () => {
  await Promise.all(Array.from({ length: 10 }, () => ensureSandboxDebugQuota(env)));
  expect(objects.get("resourcequota").spec).toEqual({ hard: { "count/pods": "10", "count/jobs.batch": "20" } });
  expect(objects.size).toBe(2);
  kubectl.mockClear(); await ensureSandboxDebugQuota(env);
  expect(kubectl.mock.calls.every(([args]) => args[0] === "get")).toBe(true);
});
it("does not modify someone else's namespace", async () => {
  objects.set("namespace", { metadata: { name: SANDBOX_DEBUG_NAMESPACE, labels: {} } });
  await expect(ensureSandboxDebugQuota(env)).rejects.toThrow("namespace");
  expect(objects.has("resourcequota")).toBe(false);
  expect(kubectl.mock.calls.every(([args]) => args[0] === "get")).toBe(true);
});
it.each(["missing", "too-large", "active-only", "selector", "deleting"])("fails closed on %s quota, with no attempted broadening", async kind => {
  await ensureSandboxDebugQuota(env);
  const quota = objects.get("resourcequota");
  if (kind === "missing") delete quota.spec.hard["count/pods"];
  if (kind === "too-large") quota.spec.hard["count/pods"] = "11";
  if (kind === "active-only") quota.spec.scopes = ["NotTerminating"];
  if (kind === "selector") quota.spec.scopeSelector = {};
  if (kind === "deleting") quota.metadata.deletionTimestamp = "now";
  kubectl.mockClear(); await expect(ensureSandboxDebugQuota(env)).rejects.toThrow("quota");
  expect(kubectl.mock.calls.every(([args]) => args[0] === "get")).toBe(true);
});
it("accepts a stricter operator quota", async () => {
  await ensureSandboxDebugQuota(env); objects.get("resourcequota").spec.hard["count/pods"] = "1";
  await ensureSandboxDebugQuota(env);
});
it("does not start diagnostics when quota creation is forbidden", async () => {
  objects.set("namespace", { metadata: { labels: { "siclaw.io/component": "script-diagnostics" } } });
  kubectl.mockImplementation(async args => { if (args[0] === "create") throw new Error("forbidden"); return { stdout: JSON.stringify(objects.get(args[1])) ?? "" }; });
  await expect(ensureSandboxDebugQuota(env)).rejects.toThrow("quota");
});
