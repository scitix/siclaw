import { describe, it, expect, beforeEach } from "vitest";
import { SystemConfigRepo, ALLOWED_CONFIG_KEYS } from "./system-config-repo.js";
import type { FrontendWsClient } from "./frontend-ws-client.js";

class FakeFrontendWsClient {
  calls: Array<{ method: string; params: unknown }> = [];
  responses = new Map<string, unknown>();
  nextError: Error | null = null;

  request(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (this.nextError) {
      const err = this.nextError;
      this.nextError = null;
      return Promise.reject(err);
    }
    if (this.responses.has(method)) return Promise.resolve(this.responses.get(method));
    return Promise.resolve({});
  }
}

let fake: FakeFrontendWsClient;
let repo: SystemConfigRepo;

beforeEach(() => {
  fake = new FakeFrontendWsClient();
  repo = new SystemConfigRepo(fake as unknown as FrontendWsClient);
});

describe("SystemConfigRepo.getAll", () => {
  it("returns the config map from the RPC payload", async () => {
    fake.responses.set("config.getSystemConfig", {
      config: { "system.grafanaUrl": "https://grafana.example.com" },
    });
    const all = await repo.getAll();
    expect(all).toEqual({ "system.grafanaUrl": "https://grafana.example.com" });
    expect(fake.calls[0].method).toBe("config.getSystemConfig");
  });

  it("returns empty object when RPC returns empty config", async () => {
    fake.responses.set("config.getSystemConfig", { config: {} });
    await expect(repo.getAll()).resolves.toEqual({});
  });
});

describe("SystemConfigRepo.get", () => {
  it("returns the value for a known key", async () => {
    fake.responses.set("config.getSystemConfig", {
      config: { "system.grafanaUrl": "https://g.example.com" },
    });
    await expect(repo.get("system.grafanaUrl")).resolves.toBe("https://g.example.com");
  });

  it("returns null when the key is not present", async () => {
    fake.responses.set("config.getSystemConfig", { config: {} });
    await expect(repo.get("missing.key")).resolves.toBeNull();
  });
});

describe("SystemConfigRepo.set", () => {
  it("issues config.setSystemConfig with key, value, and updated_by", async () => {
    await repo.set("system.grafanaUrl", "https://g", "admin-user");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].method).toBe("config.setSystemConfig");
    expect(fake.calls[0].params).toEqual({
      key: "system.grafanaUrl",
      value: "https://g",
      updated_by: "admin-user",
    });
  });

  it("propagates transport errors", async () => {
    fake.nextError = new Error("rpc down");
    await expect(repo.set("k", "v", "u")).rejects.toThrow("rpc down");
  });
});

describe("ALLOWED_CONFIG_KEYS", () => {
  it("whitelists system.grafanaUrl", () => {
    expect(ALLOWED_CONFIG_KEYS.has("system.grafanaUrl")).toBe(true);
  });

  it("does not accept arbitrary keys", () => {
    expect(ALLOWED_CONFIG_KEYS.has("system.adminSecret")).toBe(false);
    expect(ALLOWED_CONFIG_KEYS.has("__proto__")).toBe(false);
  });
});
