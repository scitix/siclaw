import { it, expect, vi } from "vitest";
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

it("bounds UTF-8 and escaped JSON before synchronous redaction and after expansion", () => {
  const redact = vi.fn((text: string) => text);
  const metadata = persistableToolDetails({ skillPreview: { skill: { name: "large", specs: "界".repeat(400_000) } }, llm_round: 3 }, redact);
  expect(metadata).toMatchObject({ skillPreview: { status: "omitted", reason: "size_limit" }, llm_round: 3 });
  expect(redact.mock.calls[0][0].length).toBeLessThan(1000);
  expect(persistableToolDetails({ skillPreview: { skill: { name: "escaped", specs: "\u0000".repeat(180_000) } } })?.skillPreview).toMatchObject({ status: "omitted" });
  expect(persistableToolDetails({ skillPreview: { skill: { name: "expand", specs: "x".repeat(600_000) } } }, s => s.replaceAll("x", "xx"))?.skillPreview).toMatchObject({ status: "omitted" });
});
