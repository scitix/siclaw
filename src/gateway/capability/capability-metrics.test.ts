import { beforeEach, describe, expect, it } from "vitest";

import { federationSelfRegistry } from "../federation-self-metrics.js";
import {
  capabilityActiveRuns,
  capabilityMaterializationFailuresTotal,
  capabilityRelayFailuresTotal,
  capabilityStartDurationMs,
  capabilityStartsTotal,
} from "./capability-metrics.js";

describe("capability lifecycle metrics", () => {
  beforeEach(() => federationSelfRegistry.resetMetrics());

  it("exports only bounded lifecycle labels", async () => {
    capabilityStartsTotal.inc({ outcome: "success" });
    capabilityStartDurationMs.observe({ outcome: "success" }, 123);
    capabilityMaterializationFailuresTotal.inc({ stage: "workspace-fetch" });
    capabilityRelayFailuresTotal.inc();
    capabilityActiveRuns.set(2);

    const output = await federationSelfRegistry.metrics();
    expect(output).toContain('siclaw_gateway_capability_starts_total{outcome="success"} 1');
    expect(output).toContain('siclaw_gateway_capability_materialization_failures_total{stage="workspace-fetch"} 1');
    expect(output).toContain("siclaw_gateway_capability_relay_failures_total 1");
    expect(output).toContain("siclaw_gateway_capability_active_runs 2");
    expect(output).not.toContain("run_id=");
    expect(output).not.toContain("repo_id=");
  });
});
