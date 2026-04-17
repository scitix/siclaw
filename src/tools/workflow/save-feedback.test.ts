import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRequest, mockGatewayClient, mockLoadConfig } = vi.hoisted(() => {
  const req = vi.fn();
  const ctor = vi.fn().mockImplementation(() => ({
    toClientLike: () => ({ request: req }),
  }));
  return { mockRequest: req, mockGatewayClient: ctor, mockLoadConfig: vi.fn() };
});

vi.mock("../../agentbox/gateway-client.js", () => ({
  GatewayClient: mockGatewayClient,
}));

vi.mock("../../core/config.js", () => ({
  loadConfig: () => mockLoadConfig(),
}));

import { createSaveFeedbackTool } from "./save-feedback.js";

beforeEach(() => {
  mockRequest.mockReset();
  mockGatewayClient.mockClear();
  mockLoadConfig.mockReturnValue({
    userId: "user-1",
    server: { gatewayUrl: "http://gw", port: 7000 },
  });
});

function makeTool(sessionId = "sess-1") {
  return createSaveFeedbackTool({ current: sessionId });
}

describe("save_feedback tool", () => {
  it("has correct metadata", () => {
    const tool = makeTool();
    expect(tool.name).toBe("save_feedback");
    expect(tool.label).toBe("Save Session Feedback");
  });

  it("rejects when userId not configured", async () => {
    mockLoadConfig.mockReturnValue({ userId: undefined, server: { port: 7000 } });
    const tool = makeTool();
    const res = await tool.execute("id", { overallRating: 4, summary: "ok" });
    expect(res.content[0].text).toContain("userId not configured");
    expect((res.details as any).error).toBe(true);
  });

  it("rejects when session ID missing", async () => {
    const tool = makeTool("");
    const res = await tool.execute("id", { overallRating: 4, summary: "ok" });
    expect(res.content[0].text).toContain("session ID not available");
  });

  it("posts valid feedback to Gateway", async () => {
    mockRequest.mockResolvedValue({ ok: true, id: "fb-1" });
    const tool = makeTool("sess-abc");
    const res = await tool.execute("id", {
      overallRating: 5,
      summary: "great",
      decisionPoints: JSON.stringify([{ step: 1, wasCorrect: true }]),
      strengths: JSON.stringify(["clear"]),
      improvements: JSON.stringify(["more tests"]),
      tags: JSON.stringify(["wins"]),
    });
    expect(res.content[0].text).toContain("Feedback saved successfully (id: fb-1)");
    const [, , body] = mockRequest.mock.calls[0];
    expect(body.sessionId).toBe("sess-abc");
    expect(body.overallRating).toBe(5);
    expect(body.decisionPoints).toEqual([{ step: 1, wasCorrect: true }]);
    expect(body.strengths).toEqual(["clear"]);
  });

  it("parses valid fields, reports warnings for invalid JSON", async () => {
    mockRequest.mockResolvedValue({ ok: true, id: "fb-2" });
    const tool = makeTool();
    const res = await tool.execute("id", {
      overallRating: 3, summary: "ok",
      decisionPoints: "not json", // will fail
      strengths: JSON.stringify(["keeps"]), // will succeed
    });
    expect(res.content[0].text).toContain("Warning: failed to parse decisionPoints");
    const [, , body] = mockRequest.mock.calls[0];
    expect(body.decisionPoints).toBeUndefined();
    expect(body.strengths).toEqual(["keeps"]);
  });

  it("omits oversized feedbackConversation with notice", async () => {
    mockRequest.mockResolvedValue({ ok: true, id: "fb-3" });
    const tool = makeTool();
    // Create a big conversation >100KB
    const bigConv = { messages: Array.from({ length: 5000 }, () => ({ role: "user", text: "x".repeat(100) })) };
    const res = await tool.execute("id", {
      overallRating: 3, summary: "ok",
      feedbackConversation: JSON.stringify(bigConv),
    });
    expect(res.content[0].text).toContain("conversation transcript omitted");
    const [, , body] = mockRequest.mock.calls[0];
    expect(body.feedbackConversation).toBeUndefined();
  });

  it("returns gateway error when request fails", async () => {
    mockRequest.mockRejectedValue(new Error("500 internal"));
    const tool = makeTool();
    const res = await tool.execute("id", { overallRating: 4, summary: "ok" });
    expect(res.content[0].text).toContain("Failed to save feedback");
    expect(res.content[0].text).toContain("500 internal");
    expect((res.details as any).error).toBe(true);
  });

  it("uses default gateway URL when not configured", async () => {
    mockLoadConfig.mockReturnValue({
      userId: "user-1",
      server: { gatewayUrl: undefined, port: 7000 },
    });
    mockRequest.mockResolvedValue({ ok: true, id: "fb-4" });
    const tool = makeTool();
    await tool.execute("id", { overallRating: 4, summary: "ok" });
    const ctorArgs = mockGatewayClient.mock.calls[0][0];
    expect(ctorArgs.gatewayUrl).toBe("http://localhost:7000");
  });
});
