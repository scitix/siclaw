import { afterEach, expect, it, vi } from "vitest";
import { createSiclawSession } from "./agent-factory.js";

afterEach(() => { vi.unstubAllEnvs(); });

it.each([undefined, { search: async () => ({ records: [] }) }])("refuses a remote brain without an execution guard even when memory is disabled", async privateMemory => {
  vi.stubEnv("SICLAW_WORKSPACE_MODE", "remote");
  vi.stubEnv("SICLAW_MEMORY_ENABLED", "false");
  await expect(createSiclawSession({ privateMemory })).rejects.toThrow(/active private workspace execution guard/);
});
