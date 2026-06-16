import { describe, expect, it } from "vitest";
import {
  extractChartSpec,
  maybeRenderChartPng,
  renderChartPng,
  type ChartSpec,
} from "./chart-image.js";

describe("extractChartSpec", () => {
  it("returns null for plain text and non-numeric tables", () => {
    expect(extractChartSpec("plain answer without structured data")).toBeNull();
    expect(extractChartSpec([
      "| Region | Status |",
      "|---|---|",
      "| East | ok |",
      "| West | warning |",
    ].join("\n"))).toBeNull();
  });

  it("extracts a bar chart from the first numeric markdown table", () => {
    const spec = extractChartSpec([
      "Summary:",
      "",
      "| Region | Count |",
      "|---|---:|",
      "| East | 12 |",
      "| West | 7 |",
      "| North | 4 |",
    ].join("\n"));

    expect(spec).toEqual({
      title: "Count by Region",
      labels: ["East", "West", "North"],
      values: [12, 7, 4],
    });
  });

  it("extracts fenced chart JSON before looking at tables", () => {
    const spec = extractChartSpec([
      "```chart",
      "{\"title\":\"Incidents\",\"labels\":[\"P0\",\"P1\"],\"values\":[1,4]}",
      "```",
      "",
      "| Region | Count |",
      "|---|---:|",
      "| East | 12 |",
      "| West | 7 |",
    ].join("\n"));

    expect(spec).toEqual({
      title: "Incidents",
      labels: ["P0", "P1"],
      values: [1, 4],
    });
  });

  it("caps rows and clamps long labels", () => {
    const rows = Array.from({ length: 16 }, (_, i) =>
      `| Extremely long region label ${i} with extra suffix | ${i + 1} |`,
    );
    const spec = extractChartSpec([
      "| Region | Count |",
      "|---|---:|",
      ...rows,
    ].join("\n"));

    expect(spec).not.toBeNull();
    expect(spec!.labels).toHaveLength(12);
    expect(spec!.values).toHaveLength(12);
    expect(spec!.labels[0].length).toBeLessThanOrEqual(28);
    expect(spec!.labels[0].endsWith("...")).toBe(true);
  });
});

describe("renderChartPng", () => {
  it("returns a non-empty PNG buffer below Feishu's image upload limit", async () => {
    const spec: ChartSpec = {
      title: "Count by Region",
      labels: ["East", "West", "North"],
      values: [12, 7, 4],
    };

    const png = await renderChartPng(spec);
    expect(Buffer.isBuffer(png)).toBe(true);
    expect(png.length).toBeGreaterThan(1024);
    expect(png.length).toBeLessThan(10 * 1024 * 1024);
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});

describe("maybeRenderChartPng", () => {
  it("returns null when the markdown has no chart-worthy data", async () => {
    await expect(maybeRenderChartPng("just text")).resolves.toBeNull();
  });

  it("renders a PNG when the markdown has a numeric table", async () => {
    const png = await maybeRenderChartPng([
      "| Region | Count |",
      "|---|---:|",
      "| East | 12 |",
      "| West | 7 |",
    ].join("\n"));

    expect(png).not.toBeNull();
    expect([...png!.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});
