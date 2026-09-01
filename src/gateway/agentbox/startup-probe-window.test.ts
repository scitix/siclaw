/**
 * The three timeouts around an AgentBox coming up, and the ORDER they must stay in.
 *
 * 🔴 This file exists because the outage it describes was a relation between numbers, not a
 * mistake inside any one of them. Every value was defensible on its own:
 *
 *   startupProbe        periodSeconds 2 × failureThreshold 30 = 60s   (k8s-spawner manifest)
 *   waitForPodReady     60s                                          (Runtime)
 *   startup work        30s per step × 3 sequential steps = 90s       (AgentBox)
 *
 * Two independent failures came out of that. The Runtime's patience equalled the probe
 * window even though the two measure DIFFERENT spans — the probe budget starts when the
 * container starts, the readiness wait starts at pod creation and also covers scheduling,
 * image pull and volume attach — so a pod that was scheduled in 30s and passed its probe in
 * 40s was healthy at t=70s and had already been called a spawn failure at t=60s. And the
 * box's own pre-listen work could reach 90s, past the 60s window, at which point kubelet
 * (restartPolicy: Never) killed the pod into phase Failed instead of retrying it.
 *
 * No unit test could have caught either one, because the relation was written down nowhere:
 * two of the numbers were literals inside a manifest and a default parameter, and the third
 * lived in another image entirely. These assertions are that relation, made executable.
 *
 * The probe values are read from the manifest the spawner ACTUALLY emits rather than
 * re-stated here — a test that compared two copies of a number would pass while the pod got
 * a different one.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the k8s client the same way k8s-spawner.test.ts does, so a spawn can be observed.
const g = globalThis as any;
g.__probeCalls = { createNamespacedPod: [] as any[] };

vi.mock("@kubernetes/client-node", () => {
  class KubeConfig {
    loadFromDefault() {}
    makeApiClient() {
      return {
        async readNamespacedPod() { throw Object.assign(new Error("nf"), { code: 404 }); },
        async createNamespacedPod(args: any) {
          g.__probeCalls.createNamespacedPod.push(args);
          return {};
        },
        async createNamespacedSecret() { return {}; },
        async readNamespacedSecret() { throw Object.assign(new Error("nf"), { code: 404 }); },
        async deleteNamespacedSecret() { return {}; },
        async deleteNamespacedPod() { return {}; },
        async listNamespacedPod() { return { items: [] }; },
      };
    }
  }
  return { KubeConfig, CoreV1Api: class {}, default: { KubeConfig } };
});

import {
  K8sSpawner,
  POD_READY_TIMEOUT_MS,
  STARTUP_PROBE_WINDOW_MS,
} from "./k8s-spawner.js";
import { STARTUP_BUDGET_MS } from "../../agentbox/startup-budget.js";

/** The startup gate as it appears in the pod the spawner submits to the API server. */
async function emittedStartupProbeWindowMs(): Promise<number> {
  g.__probeCalls.createNamespacedPod.length = 0;
  const spawner = new K8sSpawner();
  spawner.setCertManager({
    issueAgentBoxCertificate: () => ({ cert: "CERT", key: "KEY", ca: "CA" }),
    caFingerprint: () => "fp",
  } as any);

  // The readiness wait never succeeds against this mock; the manifest is already captured
  // by then, which is all this file needs.
  await spawner.spawn({ agentId: "probe-agent" } as any).catch(() => {});

  const pod = g.__probeCalls.createNamespacedPod[0]?.body;
  const probe = pod?.spec?.containers?.[0]?.startupProbe;
  expect(probe, "the spawner must emit a startupProbe").toBeTruthy();
  return probe.periodSeconds * probe.failureThreshold * 1000;
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("the startup timeout hierarchy", () => {
  it("declares the same probe window the spawner actually emits", async () => {
    // Guards the other two assertions: they compare against the exported constant, which is
    // only meaningful while it matches the manifest.
    await expect(emittedStartupProbeWindowMs()).resolves.toBe(STARTUP_PROBE_WINDOW_MS);
  }, 20_000);

  /**
   * The Runtime must outwait kubelet by a clear margin, because its clock starts earlier
   * (scheduling + image pull + volume attach) and it cannot see how much of its own window
   * those consumed.
   */
  it("waits for readiness well past the window kubelet allows", () => {
    expect(POD_READY_TIMEOUT_MS).toBeGreaterThan(STARTUP_PROBE_WINDOW_MS * 2);
  });

  /**
   * And the box must finish its pre-listen work well INSIDE that window, since exceeding it
   * is not a slow start but a killed pod. Half leaves room for node startup and module
   * loading, neither of which the budget counts.
   */
  it("bounds the box's pre-listen work to a fraction of the window", () => {
    expect(STARTUP_BUDGET_MS).toBeLessThanOrEqual(STARTUP_PROBE_WINDOW_MS / 2);
  });

  /**
   * The ordering restated as one chain, so a future edit that moves a number into a
   * neighbour's territory fails here rather than in a cluster.
   */
  it("keeps budget < probe window < readiness wait", () => {
    expect(STARTUP_BUDGET_MS).toBeLessThan(STARTUP_PROBE_WINDOW_MS);
    expect(STARTUP_PROBE_WINDOW_MS).toBeLessThan(POD_READY_TIMEOUT_MS);
  });
});
