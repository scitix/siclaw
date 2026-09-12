import { expect, it, vi } from "vitest";
import { SandboxInvocations } from "./sandbox-invocations.js";

const scope = { language: "python" as const, code: "pass", clusters: [{ name: "prod" }] };
const args = { id: "1", tool: "bash", arguments: { cluster: "prod", command: "kubectl get nodes" } };
const signal = () => new AbortController().signal;
it("binds callbacks to the active invocation, owning box, session and immutable scope", async () => {
  const box = new SandboxInvocations();
  const other = new SandboxInvocations();
  const grant = box.open("session-a", scope);
  const exec = vi.fn(async () => ({ text: "ok" }));
  await expect(box.execute("forged", "session-a", args, signal(), exec)).rejects.toThrow();
  await expect(box.execute(grant.token, "session-b", args, signal(), exec)).rejects.toThrow();
  await expect(other.execute(grant.token, "session-a", args, signal(), exec)).rejects.toThrow();
  await expect(box.execute(grant.token, "session-a", { ...args, arguments: { ...args.arguments, cluster: "other" } }, signal(), exec)).rejects.toThrow();
  expect(exec).not.toHaveBeenCalled();
  await expect(box.execute(grant.token, "session-a", args, signal(), exec)).resolves.toEqual({ text: "ok" });
  grant.close();
  await expect(box.execute(grant.token, "session-a", args, signal(), exec)).rejects.toThrow();
  expect(exec).toHaveBeenCalledOnce();
});
it("propagates cancellation to a running tool and prevents concurrent/replayed work", async () => {
  const box = new SandboxInvocations();
  const controller = new AbortController();
  const grant = box.open("session", scope, controller.signal);
  let entered = false;
  const pending = box.execute(grant.token, "session", args, signal(), async (_, s) => {
    entered = true;
    await new Promise<void>(resolve => s.addEventListener("abort", () => resolve(), { once: true }));
    expect(s.aborted).toBe(true);
  });
  expect(entered).toBe(true);
  await expect(box.execute(grant.token, "session", args, signal(), vi.fn())).rejects.toThrow();
  controller.abort(); await pending;
  await expect(box.execute(grant.token, "session", args, signal(), vi.fn())).rejects.toThrow();
  grant.close();
});

it("accepts ten distinct concurrent callbacks and cancels every slot on close", async () => {
  const box = new SandboxInvocations(); const grant = box.open("session", scope);
  const entered: string[] = [];
  const executor = vi.fn(async (_: unknown, s: AbortSignal) => {
    entered.push("entered");
    await new Promise<void>(resolve => s.addEventListener("abort", () => resolve(), { once: true }));
    return "cancelled";
  });
  const run = (id: string) => box.execute(grant.token, "session", { ...args, id }, signal(), executor);
  const pending = Array.from({ length: 10 }, (_, i) => run(String(i)));
  expect(entered).toHaveLength(10);
  await expect(run("11")).rejects.toThrow();
  await expect(run("0")).rejects.toThrow();
  grant.close(); expect(await Promise.all(pending)).toHaveLength(10);
  expect(executor).toHaveBeenCalledTimes(10);
});
