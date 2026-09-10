import { it, expect } from "vitest";
import {
  persistableToolDetails,
  traceVisualIds,
} from "./tool-result-metadata.js";
it("bounds IM link lookups to the same eight attachments accepted by Web", () => {
  const visuals = Array.from({ length: 20 }, (_, i) => ({
    visual_id: `v${i}`,
    kind: "chart",
    spec: { type: "waterfall", visual_id: `v${i}` },
  }));
  expect(traceVisualIds({ structuredContent: { schema_version: 2, visuals } }))
    .toEqual(visuals.slice(0, 8).map(v => v.visual_id));
});
it("nested details survive redaction and round trip without outcome flags", () => {
  const d = persistableToolDetails(
    {
      blocked: true,
      error: false,
      structuredContent: {
        schema_version: 2,
        visuals: [
          {
            visual_id: "v1",
            kind: "chart",
            spec: { type: "waterfall", visual_id: "v1", label: "secret" },
          },
        ],
      },
    },
    (s) => s.replaceAll("secret", "[REDACTED]"),
  );
  expect(d).not.toHaveProperty("blocked");
  expect(JSON.stringify(d)).toContain("[REDACTED]");
  expect(traceVisualIds(d)).toEqual(["v1"]);
});
it("invalid redacted JSON and untrusted ID mismatches fail closed", () => {
  expect(persistableToolDetails({ a: 1 }, () => "bad")).toBeNull();
  expect(
    traceVisualIds({
      structuredContent: {
        schema_version: 2,
        visuals: [
          {
            visual_id: "a",
            kind: "chart",
            spec: { type: "waterfall", visual_id: "b" },
          },
        ],
      },
    }),
  ).toEqual([]);
});
