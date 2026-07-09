/**
 * otel-provider unit tests — reinitTracing serial lock + sendContent module state.
 *
 * These exercise the hot-reload contract without standing up real OTLP
 * exporters: configs use either the disabled path (enabled:false) or an empty
 * exporter list (enabled:true but nothing valid → provider stays null), both of
 * which still refresh the sendContent gate. The serial-lock test asserts that
 * concurrent reinitTracing calls chain (never interleave) by ordering their
 * effects on the module-state gate.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  initTracing,
  reinitTracing,
  shutdownTracing,
  isTracingEnabled,
  isSendContentEnabled,
  buildResourceAttributes,
  __installTracerProviderForTest,
} from "./otel-provider.js";
import type { SiclawConfig } from "../../core/config.js";

/** Minimal SiclawConfig carrying only the tracing block reinit/init read. */
function cfg(tracing: Partial<NonNullable<SiclawConfig["tracing"]>>): SiclawConfig {
  return { tracing } as unknown as SiclawConfig;
}

afterEach(async () => {
  // Reset module state between tests (provider=null, enabled=false, gate=false).
  __installTracerProviderForTest(null);
  await shutdownTracing();
});

describe("buildResourceAttributes", () => {
  it("defaults service.name and omits environment when unset", () => {
    expect(buildResourceAttributes({})).toEqual({ "service.name": "siclaw-agentbox" });
  });

  it("carries the deployment.environment.name when environment is set", () => {
    expect(buildResourceAttributes({ serviceName: "svc", environment: "prod" })).toEqual({
      "service.name": "svc",
      "deployment.environment.name": "prod",
    });
  });

  it("omits deployment.environment.name for an empty-string environment", () => {
    expect(buildResourceAttributes({ environment: "" })).toEqual({
      "service.name": "siclaw-agentbox",
    });
  });
});

describe("sendContent module state", () => {
  it("initTracing reflects config.tracing.sendContent even on the disabled path", () => {
    expect(isSendContentEnabled()).toBe(false);
    initTracing(cfg({ enabled: false, sendContent: true }));
    // Disabled → no provider, but the gate still tracks the latest config.
    expect(isTracingEnabled()).toBe(false);
    expect(isSendContentEnabled()).toBe(true);
  });

  it("reinitTracing flips the gate atomically", async () => {
    initTracing(cfg({ enabled: false, sendContent: false }));
    expect(isSendContentEnabled()).toBe(false);

    await reinitTracing(cfg({ enabled: false, sendContent: true }));
    expect(isSendContentEnabled()).toBe(true);

    await reinitTracing(cfg({ enabled: false, sendContent: false }));
    expect(isSendContentEnabled()).toBe(false);
  });
});

describe("reinitTracing serial lock", () => {
  it("serialises concurrent reinit calls (no interleaved shutdown+init)", async () => {
    // Fire three reinits without awaiting between them. The in-flight Promise
    // chain must run them strictly in order; the final gate value is the LAST
    // call's sendContent, proving they didn't race to an arbitrary order.
    const p1 = reinitTracing(cfg({ enabled: false, sendContent: true }));
    const p2 = reinitTracing(cfg({ enabled: false, sendContent: false }));
    const p3 = reinitTracing(cfg({ enabled: false, sendContent: true }));
    await Promise.all([p1, p2, p3]);
    expect(isSendContentEnabled()).toBe(true);
  });

  it("a failing reinit does not poison the chain (errors swallowed)", async () => {
    // The first reinit throws inside shutdown via a provider whose shutdown
    // rejects; the chain's .catch(()=>{}) must let the next reinit proceed.
    const badProvider = {
      forceFlush: () => Promise.reject(new Error("flush boom")),
      shutdown: () => Promise.reject(new Error("shutdown boom")),
      getTracer: () => ({}) as never,
      register: () => {},
    };
    __installTracerProviderForTest(badProvider as never);
    expect(isTracingEnabled()).toBe(true);

    // reinit shuts down the bad provider (swallows the errors) then inits a
    // disabled config → provider becomes null, gate set from config.
    await reinitTracing(cfg({ enabled: false, sendContent: true }));
    expect(isTracingEnabled()).toBe(false);
    expect(isSendContentEnabled()).toBe(true);

    // A subsequent reinit still works — the chain wasn't poisoned.
    await reinitTracing(cfg({ enabled: false, sendContent: false }));
    expect(isSendContentEnabled()).toBe(false);
  });
});
