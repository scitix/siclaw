import { describe, it, expect, vi, beforeEach } from "vitest";

const mockClient = {
  listAgentTasks: vi.fn(),
  createAgentTask: vi.fn(),
  updateAgentTask: vi.fn(),
  deleteAgentTask: vi.fn(),
};

vi.mock("../../agentbox/gateway-client.js", () => ({
  GatewayClient: vi.fn().mockImplementation(() => mockClient),
}));

vi.mock("../../core/config.js", () => ({
  loadConfig: () => ({
    userId: "u",
    server: { gatewayUrl: "http://gw", port: 7000 },
  }),
}));

import { createManageScheduleTool } from "./manage-schedule.js";

beforeEach(() => {
  mockClient.listAgentTasks.mockReset();
  mockClient.createAgentTask.mockReset();
  mockClient.updateAgentTask.mockReset();
  mockClient.deleteAgentTask.mockReset();
});

const tool = createManageScheduleTool();

describe("manage_schedule tool", () => {
  it("has correct metadata", () => {
    expect(tool.name).toBe("manage_schedule");
    expect(tool.label).toBe("Manage Schedule");
  });

  describe("list action", () => {
    it("returns message when no tasks", async () => {
      mockClient.listAgentTasks.mockResolvedValue([]);
      const res = await tool.execute("id", { action: "list" });
      expect(res.content[0].text).toContain("No scheduled tasks");
    });

    it("lists all tasks with running/paused indicators", async () => {
      mockClient.listAgentTasks.mockResolvedValue([
        { id: "1", name: "daily", status: "active", schedule: "0 9 * * *", description: "desc" },
        { id: "2", name: "weekly", status: "paused", schedule: "0 0 * * 0" },
      ]);
      const res = await tool.execute("id", { action: "list" });
      const text = res.content[0].text;
      expect(text).toContain("daily");
      expect(text).toContain("weekly");
      expect(text).toContain("Running");
      expect(text).toContain("Paused");
    });
  });

  describe("create action", () => {
    it("fails without name", async () => {
      const res = await tool.execute("id", { action: "create", schedule: "0 9 * * *" });
      expect(JSON.parse(res.content[0].text).error).toContain("name is required");
    });

    it("fails without schedule", async () => {
      const res = await tool.execute("id", { action: "create", name: "x" });
      expect(JSON.parse(res.content[0].text).error).toContain("Cron schedule");
    });

    it("rejects invalid cron expression", async () => {
      const res = await tool.execute("id", {
        action: "create", name: "bad", schedule: "not cron",
      });
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.error).toBeDefined();
      expect(mockClient.createAgentTask).not.toHaveBeenCalled();
    });

    it("creates task with valid schedule", async () => {
      mockClient.createAgentTask.mockResolvedValue({ id: "new-1" });
      const res = await tool.execute("id", {
        action: "create", name: "daily",
        schedule: "0 9 * * *",
        description: "Check cluster health",
      });
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.summary).toContain("Created");
      expect(mockClient.createAgentTask).toHaveBeenCalledOnce();
      const call = mockClient.createAgentTask.mock.calls[0][0];
      expect(call.name).toBe("daily");
      expect(call.schedule).toBe("0 9 * * *");
      expect(call.description).toBe("Check cluster health");
    });
  });

  describe("update action", () => {
    it("fails when no id/name provided", async () => {
      const res = await tool.execute("id", { action: "update" });
      expect(JSON.parse(res.content[0].text).error).toContain("required for update");
    });

    it("updates by id", async () => {
      mockClient.listAgentTasks.mockResolvedValue([{ id: "t1", name: "foo" }]);
      const res = await tool.execute("id", {
        action: "update", id: "t1", schedule: "0 10 * * *",
      });
      expect(JSON.parse(res.content[0].text).summary).toContain("Updated");
      expect(mockClient.updateAgentTask).toHaveBeenCalled();
    });

    it("resolves by name when id not provided", async () => {
      mockClient.listAgentTasks.mockResolvedValue([{ id: "tX", name: "by-name" }]);
      await tool.execute("id", { action: "update", name: "by-name", description: "new" });
      expect(mockClient.updateAgentTask).toHaveBeenCalledWith("tX", expect.any(Object));
    });
  });

  describe("delete / pause / resume", () => {
    beforeEach(() => {
      mockClient.listAgentTasks.mockResolvedValue([{ id: "t1", name: "foo" }]);
    });

    it("deletes by name", async () => {
      const res = await tool.execute("id", { action: "delete", name: "foo" });
      expect(JSON.parse(res.content[0].text).summary).toContain("Deleted");
      expect(mockClient.deleteAgentTask).toHaveBeenCalledWith("t1");
    });

    it("pauses", async () => {
      const res = await tool.execute("id", { action: "pause", id: "t1" });
      expect(JSON.parse(res.content[0].text).summary).toContain("Paused");
      expect(mockClient.updateAgentTask).toHaveBeenCalledWith("t1", { status: "paused" });
    });

    it("resumes", async () => {
      const res = await tool.execute("id", { action: "resume", id: "t1" });
      expect(JSON.parse(res.content[0].text).summary).toContain("Resumed");
      expect(mockClient.updateAgentTask).toHaveBeenCalledWith("t1", { status: "active" });
    });
  });

  describe("rename", () => {
    it("fails without newName", async () => {
      mockClient.listAgentTasks.mockResolvedValue([{ id: "t1", name: "old" }]);
      const res = await tool.execute("id", { action: "rename", name: "old" });
      expect(JSON.parse(res.content[0].text).error).toContain("New name");
    });

    it("renames successfully", async () => {
      mockClient.listAgentTasks.mockResolvedValue([{ id: "t1", name: "old" }]);
      const res = await tool.execute("id", {
        action: "rename", name: "old", newName: "new",
      });
      expect(JSON.parse(res.content[0].text).summary).toContain("Renamed");
      expect(mockClient.updateAgentTask).toHaveBeenCalledWith("t1", { name: "new" });
    });
  });

  it("rejects unknown action", async () => {
    const res = await tool.execute("id", { action: "frobnicate" as any });
    expect(JSON.parse(res.content[0].text).error).toContain("Unknown action");
  });
});
