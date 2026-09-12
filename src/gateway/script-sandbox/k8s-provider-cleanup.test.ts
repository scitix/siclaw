import { EventEmitter } from "node:events";
import * as k8s from "@kubernetes/client-node";
import { afterEach, expect, it, vi } from "vitest";
import { K8sScriptSandboxProvider, scriptJob } from "./k8s-provider.js";
import { loadScriptSandboxConfig } from "../../script-sandbox/config.js";
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const config = loadScriptSandboxConfig({ SICLAW_SCRIPT_SANDBOX_ENABLED: "true", SICLAW_SCRIPT_SANDBOX_IMAGE: "fixture" });
  const job = scriptJob("fixture", true, 60, config); job.metadata!.uid = "created-job";
  const pod = { metadata: { name: "fixture-pod", uid: "created-pod", ownerReferences: [{ uid: "created-job" }] },
    spec: job.spec!.template.spec, status: { containerStatuses: [{ name: "runner", state: { running: {} } }] } };
  let exists = false;
  const batch = {
    createNamespacedJob: vi.fn(async () => { exists = true; return job; }),
    readNamespacedJob: vi.fn(async () => { if (!exists) throw { code: 404 }; return job; }),
    deleteNamespacedJob: vi.fn(async () => { exists = false; return {}; }),
  };
  const core = { listNamespacedPod: vi.fn(async () => ({ items: [pod] })), readNamespacedPod: vi.fn(async () => pod),
    listNamespacedEvent: vi.fn(async () => ({ items: [] as any[] })) };
  const kc = new k8s.KubeConfig();
  vi.spyOn(kc, "makeApiClient").mockImplementation((type: any) => type === k8s.CoreV1Api ? core as any : batch as any);
  const socket = Object.assign(new EventEmitter(), { terminate: vi.fn() });
  vi.spyOn(k8s.Attach.prototype, "attach").mockResolvedValue(socket as any);
  const provider = new K8sScriptSandboxProvider(config, kc);
  return { provider, batch, core, job, setExists: (value: boolean) => { exists = value; } };
}
it("recovers creation ownership after a committed create reply is lost", async () => {
  const f = fixture(); f.batch.createNamespacedJob.mockImplementationOnce(async () => { f.setExists(true); throw new Error("lost create reply"); });
  await expect(f.provider.start("fixture", true, 60, new AbortController().signal)).rejects.toThrow("lost create reply");
  expect(f.batch.deleteNamespacedJob).toHaveBeenCalledWith(expect.objectContaining({ body: { propagationPolicy: "Foreground", preconditions: { uid: "created-job" } } }), expect.anything());
  expect(f.batch.readNamespacedJob).toHaveBeenCalledTimes(2);
});
it("reports cleanup failure and lets the same instance retry deletion", async () => {
  const f = fixture(); const c = await f.provider.start("fixture", true, 60, new AbortController().signal);
  f.batch.deleteNamespacedJob.mockRejectedValueOnce(new Error("control plane unavailable"));
  await expect(c.close()).rejects.toMatchObject({ cleanup: "pending" });
  await expect(c.close()).resolves.toBeUndefined();
  expect(f.batch.deleteNamespacedJob).toHaveBeenCalledTimes(2);
});
it("waits for foreground removal, rather than treating DELETE acceptance as cleanup", async () => {
  const f = fixture(); const c = await f.provider.start("fixture", true, 60, new AbortController().signal);
  f.batch.deleteNamespacedJob.mockImplementation(async () => ({}));
  const pending = c.close();
  await vi.waitFor(() => expect(f.batch.readNamespacedJob).toHaveBeenCalled());
  let completed = false; void pending.then(() => { completed = true; });
  await Promise.resolve(); expect(completed).toBe(false);
  f.setExists(false); await pending;
});
it("does not delete an existing resource after an explicit CREATE conflict", async () => {
  const f = fixture(); f.setExists(true); f.batch.createNamespacedJob.mockRejectedValueOnce({ code: 409 });
  await expect(f.provider.start("fixture", true, 60, new AbortController().signal)).rejects.toMatchObject({ code: 409 });
  expect(f.batch.deleteNamespacedJob).not.toHaveBeenCalled();
});
it("fails promptly when quota prevents the Job from creating a Pod", async () => {
  const f = fixture(); f.core.listNamespacedPod.mockResolvedValue({ items: [] });
  f.core.listNamespacedEvent.mockResolvedValue({ items: [{ reason: "FailedCreate", message: "exceeded quota: pod budget" }] });
  await expect(f.provider.start("fixture", true, 60, new AbortController().signal)).rejects.toMatchObject({ code: "RUNNER_CAPACITY" });
  expect(f.batch.deleteNamespacedJob).toHaveBeenCalledOnce();
});
it("retains a failed-start cleanup handle for shutdown recovery", async () => {
  const f = fixture(); f.batch.createNamespacedJob.mockImplementationOnce(async () => { f.setExists(true); throw new Error("lost reply"); });
  f.batch.deleteNamespacedJob.mockRejectedValueOnce(new Error("temporary outage"));
  await expect(f.provider.start("fixture", true, 60, new AbortController().signal)).rejects.toMatchObject({ cleanup: "pending" });
  await expect(f.provider.shutdown()).resolves.toBeUndefined();
  expect(f.batch.deleteNamespacedJob).toHaveBeenCalledTimes(2);
});
it("coalesces overlapping close attempts", async () => {
  const f = fixture(); const c = await f.provider.start("fixture", true, 60, new AbortController().signal);
  await Promise.all([c.close(), c.close(), c.close()]);
  expect(f.batch.deleteNamespacedJob).toHaveBeenCalledOnce();
});
it("retains uncertain creation until its late commit can be observed", async () => {
  const f = fixture(); f.batch.createNamespacedJob.mockRejectedValueOnce(new Error("lost reply"));
  await expect(f.provider.start("fixture", true, 60, new AbortController().signal)).rejects.toMatchObject({ cleanup: "pending" });
  expect(f.batch.deleteNamespacedJob).not.toHaveBeenCalled();
  f.setExists(true);
  await expect(f.provider.shutdown()).resolves.toBeUndefined();
  expect(f.batch.deleteNamespacedJob).toHaveBeenCalledOnce();
});
it("waits for an in-flight creation before shutdown removes its Job", async () => {
  const f = fixture(); let finish!: () => void;
  f.batch.createNamespacedJob.mockImplementationOnce(() => new Promise(resolve => {
    finish = () => { f.setExists(true); resolve(f.job); };
  }));
  const start = f.provider.start("fixture", true, 60, new AbortController().signal);
  const rejected = expect(start).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  await vi.waitFor(() => expect(f.batch.createNamespacedJob).toHaveBeenCalledOnce());
  const stopped = f.provider.shutdown();
  expect(f.batch.readNamespacedJob).not.toHaveBeenCalled();
  finish(); await rejected; await stopped;
  expect(f.batch.deleteNamespacedJob).toHaveBeenCalledOnce();
  await expect(f.provider.start("later", true, 60, new AbortController().signal)).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
});
