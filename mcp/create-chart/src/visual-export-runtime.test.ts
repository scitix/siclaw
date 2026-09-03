import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { launchMock } = vi.hoisted(() => ({ launchMock: vi.fn() }));

vi.mock("playwright-core", () => ({
  chromium: { launch: launchMock },
}));

import { exportMarkdownVisualsWithVisualExportWeb } from "./visual-export.js";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

describe("visual export deadline", () => {
  beforeEach(() => {
    launchMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shares one timeout budget across browser launch, navigation, and readiness", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const goto = vi.fn(async () => { now = 1_700; });
    const waitForFunction = vi.fn(async () => { now = 1_800; });
    const page = {
      goto,
      waitForFunction,
      evaluate: vi.fn(async () => [{ kind: "visual-card", dataUrl: `data:image/png;base64,${png}` }]),
    };
    const browser = {
      newPage: vi.fn(async () => { now = 1_200; return page; }),
      close: vi.fn(async () => undefined),
    };
    launchMock.mockImplementation(async () => { now = 1_100; return browser; });

    await exportMarkdownVisualsWithVisualExportWeb("```visual-card\n{}\n```", {
      baseUrl: "https://console.example.com/siclaw-visual-export",
      timeoutMs: 1_000,
    });

    expect(launchMock.mock.calls[0][0].timeout).toBe(1_000);
    expect(goto.mock.calls[0][1].timeout).toBe(800);
    expect(waitForFunction.mock.calls[0][2].timeout).toBe(300);
  });

  it("stops before the next phase when an earlier phase exhausts the shared budget", async () => {
    let now = 2_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const waitForFunction = vi.fn();
    const browser = {
      newPage: vi.fn(async () => ({
        goto: vi.fn(async () => { now = 2_501; }),
        waitForFunction,
        evaluate: vi.fn(),
      })),
      close: vi.fn(async () => undefined),
    };
    launchMock.mockResolvedValue(browser);

    await expect(exportMarkdownVisualsWithVisualExportWeb("```chart\n{}\n```", {
      baseUrl: "https://console.example.com/siclaw-visual-export",
      timeoutMs: 500,
    })).rejects.toThrow(/timed out after 500ms/);
    expect(waitForFunction).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });
});
