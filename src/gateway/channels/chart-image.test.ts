import { describe, expect, it } from "vitest";
import {
  extractChartSpec,
  maybeRenderChartPng,
  maybeRenderVisualImages,
  renderChartPng,
  stripFencedChartBlocks,
  stripVisualBlocks,
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

  it("extracts Chart.js-style fenced bar chart JSON", () => {
    const spec = extractChartSpec([
      "```chart",
      JSON.stringify({
        type: "bar",
        data: {
          labels: ["1月", "2月", "3月"],
          datasets: [{ label: "销售额", data: [120, 190, 150] }],
        },
        options: {
          plugins: {
            title: {
              display: true,
              text: "2026 上半年销售额",
            },
          },
        },
      }),
      "```",
    ].join("\n"));

    expect(spec).toEqual({
      title: "2026 上半年销售额",
      labels: ["1月", "2月", "3月"],
      values: [120, 190, 150],
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

describe("maybeRenderVisualImages", () => {
  it("does not redraw source-only chart or Mermaid blocks by default", async () => {
    const markdown = [
      "```chart",
      "{\"title\":\"Incidents\",\"labels\":[\"P0\",\"P1\"],\"values\":[1,4]}",
      "```",
      "",
      "```mermaid",
      "flowchart TD",
      "A[Check] --> B[Done]",
      "```",
    ].join("\n");

    await expect(maybeRenderVisualImages(markdown)).resolves.toEqual([]);
  });

  it("can still render MCP/Sicore bar chart specs from fenced chart blocks when explicitly enabled", async () => {
    const markdown = [
      "结论：East 增长最高。",
      "",
      "```chart",
      JSON.stringify({
        type: "bar",
        title: "Incidents by Region",
        data: {
          categories: ["East", "West"],
          series: [
            { name: "P0", values: [1, 2] },
            { name: "P1", values: [4, 3] },
          ],
        },
      }),
      "```",
    ].join("\n");

    const images = await maybeRenderVisualImages(markdown, { renderSourceBlocks: true });
    expect(images).toHaveLength(1);
    expect(images[0].kind).toBe("chart");
    expect([...images[0].image.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("can still render Chart.js-style bar chart specs from fenced chart blocks when explicitly enabled", async () => {
    const markdown = [
      "```chart",
      JSON.stringify({
        type: "bar",
        data: {
          labels: ["1月", "2月", "3月"],
          datasets: [{ label: "销售额", data: [120, 190, 150] }],
        },
        options: {
          plugins: {
            title: { display: true, text: "2026 上半年销售额" },
          },
        },
      }),
      "```",
    ].join("\n");

    const images = await maybeRenderVisualImages(markdown, { renderSourceBlocks: true });
    expect(images).toHaveLength(1);
    expect(images[0].kind).toBe("chart");
    expect([...images[0].image.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("can still render Mermaid flowcharts as PNG images when explicitly enabled", async () => {
    const images = await maybeRenderVisualImages([
      "```mermaid",
      "flowchart TD",
      "  A[Check pod] --> B{Ready?}",
      "  B -->|No| C[Inspect events]",
      "  B -->|Yes| D[Done]",
      "```",
    ].join("\n"), { renderSourceBlocks: true });

    expect(images).toHaveLength(1);
    expect(images[0].kind).toBe("mermaid");
    expect([...images[0].image.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("forwards final-answer data URI images as image attachments", async () => {
    const onePixelPng =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

    const images = await maybeRenderVisualImages(`结论卡片：\n\n![card](${onePixelPng})`);

    expect(images).toHaveLength(1);
    expect(images[0].kind).toBe("image");
    expect([...images[0].image.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("can still render Siclaw conclusion cards as PNG images when explicitly enabled", async () => {
    const images = await maybeRenderVisualImages([
      "结论：需要先处理 CrashLoopBackOff。",
      "",
      "```siclaw-card",
      JSON.stringify({
        title: "CrashLoopBackOff in prod",
        status: "critical",
        summary: "api pods are restarting after the latest config rollout.",
        metrics: [
          { label: "Affected pods", value: "3", detail: "namespace prod" },
          { label: "Restarts", value: "27", detail: "last 30m" },
        ],
        findings: ["ConfigMap changed 12 minutes before the first restart", "Readiness probes fail on /healthz"],
        actions: ["Rollback the config change", "Compare pod env against the last healthy replica"],
      }),
      "```",
    ].join("\n"), { renderSourceBlocks: true });

    expect(images).toHaveLength(1);
    expect(images[0].kind).toBe("card");
    expect([...images[0].image.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});

describe("stripFencedChartBlocks", () => {
  it("removes fenced chart JSON from display markdown only", () => {
    const markdown = [
      "结论：P1 最多。",
      "",
      "```chart",
      "{\"title\":\"Incidents\",\"labels\":[\"P0\",\"P1\"],\"values\":[1,4]}",
      "```",
      "",
      "后续建议：优先处理 P1。",
    ].join("\n");

    expect(stripFencedChartBlocks(markdown)).toBe([
      "结论：P1 最多。",
      "",
      "后续建议：优先处理 P1。",
    ].join("\n"));
  });
});

describe("stripVisualBlocks", () => {
  it("removes only data images from display markdown by default", () => {
    const onePixelPng =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
    const markdown = [
      "结论：需要扩容。",
      "",
      "```siclaw-card",
      "{\"title\":\"Pod pressure\",\"status\":\"warning\",\"summary\":\"pending pods increased\"}",
      "```",
      "",
      "```chart",
      "{\"title\":\"Pods\",\"labels\":[\"ready\",\"pending\"],\"values\":[8,2]}",
      "```",
      "",
      "```mermaid",
      "flowchart LR",
      "A[Check] --> B[Scale]",
      "```",
      "",
      `![card](${onePixelPng})`,
      "",
      "保留普通正文。",
    ].join("\n");

    const display = stripVisualBlocks(markdown);

    expect(display).toContain("```siclaw-card");
    expect(display).toContain("```chart");
    expect(display).toContain("```mermaid");
    expect(display).not.toContain("data:image/png");
    expect(display).toContain("保留普通正文。");
  });

  it("removes visual source blocks when a real image artifact is present", () => {
    const onePixelPng =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
    const markdown = [
      "结论：需要扩容。",
      "",
      "```siclaw-card",
      "{\"title\":\"Pod pressure\",\"status\":\"warning\",\"summary\":\"pending pods increased\"}",
      "```",
      "",
      "```chart",
      "{\"title\":\"Pods\",\"labels\":[\"ready\",\"pending\"],\"values\":[8,2]}",
      "```",
      "",
      "```mermaid",
      "flowchart LR",
      "A[Check] --> B[Scale]",
      "```",
      "",
      `![card](${onePixelPng})`,
      "",
      "保留普通正文。",
    ].join("\n");

    const display = stripVisualBlocks(markdown, { stripSourceBlocks: true });

    expect(display).toBe([
      "结论：需要扩容。",
      "",
      "保留普通正文。",
    ].join("\n"));
  });

  it("keeps Chart.js-style chart JSON visible when no image artifact exists", () => {
    const markdown = [
      "```chart",
      JSON.stringify({
        type: "bar",
        data: {
          labels: ["1月", "2月"],
          datasets: [{ label: "销售额", data: [120, 190] }],
        },
      }),
      "```",
      "",
      "图表结论：2月更高。",
    ].join("\n");

    expect(stripVisualBlocks(markdown)).toBe(markdown);
  });

  it("keeps unsupported chart source visible instead of swallowing the reply", () => {
    const markdown = [
      "```chart",
      JSON.stringify({
        type: "line",
        data: {
          labels: ["1月", "2月"],
          datasets: [{ label: "销售额", data: [120, 190] }],
        },
      }),
      "```",
    ].join("\n");

    expect(stripVisualBlocks(markdown)).toBe(markdown);
  });

  it("keeps readable markdown tables in the card body", () => {
    const markdown = [
      "统计如下：",
      "",
      "| Region | Count |",
      "|---|---:|",
      "| East | 12 |",
      "| West | 7 |",
    ].join("\n");

    expect(stripVisualBlocks(markdown)).toBe(markdown);
  });
});
