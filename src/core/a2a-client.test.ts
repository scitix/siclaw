import { describe, it, expect, vi } from "vitest";
import { buildA2aTools, buildA2aToolName } from "./a2a-client.js";
import type { BackgroundExecRequest } from "./tool-registry.js";

const SERVERS = {
  "prod-sre": { baseUrl: "https://peer/a2a/agents/sre", apiKey: "sk-secret", description: "Remote SRE agent" },
};

function fakeExec() {
  const calls: BackgroundExecRequest[] = [];
  const exec = vi.fn((req: BackgroundExecRequest) => {
    calls.push(req);
    return { jobId: req.jobId, outputFile: `/tmp/${req.jobId}` };
  });
  return { exec, calls };
}

describe("buildA2aTools", () => {
  it("returns no tools when no background executor is wired (D2)", () => {
    expect(buildA2aTools(SERVERS, {})).toEqual([]);
  });

  it("builds one a2a__<name>__send tool per server with a baseUrl", () => {
    const { exec } = fakeExec();
    const tools = buildA2aTools(SERVERS, { backgroundExec: exec });
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("a2a__prod-sre__send");
    expect(buildA2aToolName("prod-sre")).toBe("a2a__prod-sre__send");
  });

  it("skips servers missing baseUrl", () => {
    const { exec } = fakeExec();
    const tools = buildA2aTools({ broken: { apiKey: "x" }, ok: { baseUrl: "https://h/a" } }, { backgroundExec: exec });
    expect(tools.map((t) => t.name)).toEqual(["a2a__ok__send"]);
  });

  it("never leaks the api key into the tool description", () => {
    const { exec } = fakeExec();
    const tools = buildA2aTools(SERVERS, { backgroundExec: exec });
    expect(tools[0].description).toContain("Remote SRE agent");
    expect(tools[0].description).not.toContain("sk-secret");
  });

  it("enriches the description from a cached agent card", () => {
    const { exec } = fakeExec();
    const tools = buildA2aTools({
      peer: { baseUrl: "https://h/a", agentCard: { description: "Card desc", skills: [{ name: "diagnose" }, { name: "triage" }] } },
    }, { backgroundExec: exec });
    expect(tools[0].description).toContain("Card desc");
    expect(tools[0].description).toContain("diagnose");
    expect(tools[0].description).toContain("triage");
  });

  it("rejects an empty message without launching", async () => {
    const { exec } = fakeExec();
    const tools = buildA2aTools(SERVERS, { backgroundExec: exec });
    const result = await tools[0].execute!("call-1", { message: "  " });
    expect(exec).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ blocked: true });
  });

  it("launches a background a2a job with a line-safe sanitizer and the session id", async () => {
    const { exec, calls } = fakeExec();
    const sessionIdRef = { current: "sess-9" };
    const tools = buildA2aTools(SERVERS, { backgroundExec: exec, sessionIdRef });
    const result = await tools[0].execute!("call-2", { message: "diagnose cluster-x", context_id: "ctx-7" });

    expect(exec).toHaveBeenCalledTimes(1);
    const req = calls[0];
    expect(req.jobId).toBe("call-2");
    expect(req.jobType).toBe("a2a");
    expect(req.parentSessionId).toBe("sess-9");
    expect(typeof req.streamFactory).toBe("function");
    expect(req.action?.lineSafe).toBe(true);
    // result is the standard "launched" envelope; never contains the api key
    const text = result.content[0].text;
    expect(text).toContain("launched");
    expect(text).toContain("call-2");
    expect(text).not.toContain("sk-secret");
  });

  it("returns an error envelope when the executor throws (concurrency cap)", async () => {
    const exec = vi.fn(() => { throw new Error("too many background jobs"); });
    const tools = buildA2aTools(SERVERS, { backgroundExec: exec as never });
    const result = await tools[0].execute!("call-3", { message: "go" });
    expect(result.details).toMatchObject({ blocked: true, reason: "background_launch_failed" });
  });
});
