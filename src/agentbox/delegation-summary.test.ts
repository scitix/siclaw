import { describe, expect, it } from "vitest";
import { buildDelegateSummaryBundle } from "./delegation-summary.js";

describe("buildDelegateSummaryBundle", () => {
  it("extracts the explicit evidence capsule for parent-visible context", () => {
    const bundle = buildDelegateSummaryBundle(`
## Evidence Capsule
- Verdict: likely
- Confidence: medium
- Key evidence: scheduler rejected the pod

## Full Report
Longer audit notes that should remain available in UI only.
`);

    expect(bundle.capsule).toContain("Verdict: likely");
    expect(bundle.capsule).not.toContain("Longer audit notes");
    expect(bundle.fullSummary).toBe("Longer audit notes that should remain available in UI only.");
    expect(bundle.truncated).toBe(false);
  });

  it("caps oversized parent-visible summaries", () => {
    const long = `## Evidence Capsule\n${"evidence ".repeat(500)}\n\n## Full Report\nfull`;
    const bundle = buildDelegateSummaryBundle(long);

    expect(bundle.capsule.length).toBeLessThanOrEqual(1800);
    expect(bundle.capsule).toContain("Full sub-agent report is available");
    expect(bundle.truncated).toBe(true);
    expect(bundle.fullSummary).toBe("full");
  });

  it("keeps nested headings inside the full report body", () => {
    const bundle = buildDelegateSummaryBundle(`
## Evidence Capsule
- Verdict: likely

## Full Report
### Evidence
Longer audit notes.

### Commands
kubectl get pods
`);

    expect(bundle.fullSummary).toContain("### Evidence");
    expect(bundle.fullSummary).toContain("### Commands");
  });

  it("uses a stable fallback when the child returns no final text", () => {
    const bundle = buildDelegateSummaryBundle(" ");
    expect(bundle.capsule).toBe("Completed. No concise summary was returned.");
    expect(bundle.fullSummary).toBe("Completed. No concise summary was returned.");
  });
});
