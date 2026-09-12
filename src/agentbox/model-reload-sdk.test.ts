import { expect, it, vi } from "vitest";
import { ExtensionRunner, wrapRegisteredTool } from "@earendil-works/pi-coding-agent";
import { modelHandler } from "./sync-handlers.js";
import { AgentBoxSessionManager } from "./session.js";

it("model-only invalidation preserves the SDK tool runner until the captured turn ends", async () => {
  const runner = Object.create(ExtensionRunner.prototype);
  runner.extensions = [];
  runner.runtime = { flagValues: new Map(), getActiveTools: () => ["probe"], invalidate: vi.fn() };
  let finish!: (value: any) => void;
  const tool = wrapRegisteredTool({ definition: {
    name: "probe", description: "Probe", parameters: {},
    execute: () => new Promise((resolve) => { finish = resolve; }),
  } } as any, runner);
  const managed = {
    _invalidated: false, _promptDone: false, _promptInflight: Promise.resolve(),
    _promptDoneCallbacks: new Set<() => void>(),
  };
  const manager = Object.create(AgentBoxSessionManager.prototype);
  manager.sessions = new Map([["busy", managed]]);
  manager.scheduleRelease = vi.fn();
  const reload = vi.fn(async () => runner.invalidate());
  const pending = tool.execute("first", {}, undefined, undefined);
  await modelHandler.postReload!({ sessions: [{ brain: { reload }, invalidate: () => manager.invalidate("busy") }] } as any);
  expect(managed._invalidated).toBe(true);
  expect(manager.scheduleRelease).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
  finish({ content: [{ type: "text", text: "success" }] });
  await expect(pending).resolves.toMatchObject({ content: [{ text: "success" }] });
  const nextTool = tool.execute("second", {}, undefined, undefined);
  finish({ content: [{ type: "text", text: "next tool succeeded" }] });
  await expect(nextTool).resolves.toMatchObject({ content: [{ text: "next tool succeeded" }] });
  managed._promptDone = true;
  for (const callback of managed._promptDoneCallbacks) callback();
  expect(manager.scheduleRelease).toHaveBeenCalledWith("busy", 0);
});
