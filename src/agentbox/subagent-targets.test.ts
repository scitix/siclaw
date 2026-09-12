import { describe, expect, it } from "vitest";
import { selectSubagentTargets, type SubagentTargetSource } from "./subagent-targets.js";
const source: SubagentTargetSource = { artifact_id: "snapshot", array_pointer: "/items", total_pointer: "/total", fields: { uid: "/metadata/uid", name: "/metadata/name" }, identity_field: "uid" };
const document = (count: number) => ({ total: count, items: Array.from({ length: count }, (_, i) => ({ metadata: { uid: `id-${i}`, name: `node-${i}` } })) });
describe("subagent inventory snapshots", () => {
  it("selects all targets across bounded waves without retelling the inventory", () => {
    const text = JSON.stringify(document(123));
    const ids: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const selected = selectSubagentTargets(text, { ...source, offset }, 50);
      ids.push(...selected.coverage.target_ids);
      expect(selected.items.length).toBeLessThanOrEqual(50);
      offset = selected.coverage.next_offset;
    }
    expect(ids).toEqual(document(123).items.map(row => row.metadata.uid));
  });
  it("rejects partial pages even if the selected batch would fit", () => {
    expect(() => selectSubagentTargets(JSON.stringify({ ...document(10), total: 100 }), source, 50)).toThrow(/incomplete/);
  });
  it("checks duplicate identities outside the selected wave before spawning any children", () => {
    const input = document(51); input.items[50].metadata.uid = "id-0";
    expect(() => selectSubagentTargets(JSON.stringify(input), source, 50)).toThrow(/Duplicate/);
  });
  it("does not traverse prototype properties or accept missing identities", () => {
    expect(() => selectSubagentTargets(JSON.stringify(document(1)), { ...source, fields: { uid: "/__proto__/uid" } }, 50)).toThrow(/Missing/);
    expect(() => selectSubagentTargets(JSON.stringify(document(1)), { ...source, identity_field: "missing" }, 50)).toThrow(/identity_field/);
  });
  it("rejects unsafe, empty and out-of-range selections", () => {
    for (const range of [{ offset: -1 }, { offset: 2 }, { limit: 0 }, { limit: 51 }]) {
      expect(() => selectSubagentTargets(JSON.stringify(document(2)), { ...source, ...range }, 50)).toThrow(/range/);
    }
    expect(() => selectSubagentTargets(JSON.stringify(document(0)), source, 50)).toThrow(/empty/);
  });
});

import { finishTargetCoverage } from "./subagent-targets.js";
it("does not equate terminal tasks or a successful partial wave with full inventory success", () => {
  const coverage = selectSubagentTargets(JSON.stringify(document(2)), source, 50).coverage;
  expect(finishTargetCoverage(coverage, ["done", "failed"])).toMatchObject({ snapshot_complete: false, outcomes: { "id-0": "done", "id-1": "failed" } });
  expect(finishTargetCoverage(coverage, ["done"])).toMatchObject({ snapshot_complete: false, outcomes: { "id-1": "missing" } });
  expect(finishTargetCoverage(coverage, ["done", "done"])?.snapshot_complete).toBe(true);
  const wave = selectSubagentTargets(JSON.stringify(document(51)), source, 50).coverage;
  expect(finishTargetCoverage(wave, Array(50).fill("done"))?.snapshot_complete).toBe(false);
});
