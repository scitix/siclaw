import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { buildDebugJobManifest } from "./debug-pod.js";
it("does not restart a relative lifetime when an expired diagnostic Job finally starts", () => {
  const job = buildDebugJobManifest("fixture", {}, "busybox", 120, "node", Date.now() - 5000) as any;
  const command: string[] = job.spec.template.spec.containers[0].command;
  const result = spawnSync(command[0], command.slice(1), { timeout: 1000 });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(1);
  expect(job.spec.backoffLimit).toBe(0);
});

import { ADMISSION_LEASE_MS, DISPATCH_WINDOW_MS, CLOCK_SKEW_MS, DIAGNOSTIC_CLEANUP_MS } from "../../script-sandbox/budgets.js";
it("leaves cleanup and clock-skew headroom after the absolute dispatch window", () => {
  expect(DISPATCH_WINDOW_MS + CLOCK_SKEW_MS + DIAGNOSTIC_CLEANUP_MS).toBeLessThan(ADMISSION_LEASE_MS);
});
