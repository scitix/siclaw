import { describe, it, expect, vi } from "vitest";
import { createA2aPollStream } from "./a2a-poll.js";

/** Minimal Response-like stub. */
function res(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function task(state: string, extra: Record<string, unknown> = {}) {
  return { task: { id: "t1", contextId: "c1", status: { state }, ...extra } };
}

/** Drain a Readable to a string. */
async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  stream.setEncoding("utf8");
  let out = "";
  for await (const chunk of stream) out += chunk;
  return out;
}

const FAST = { pollIntervalMs: 1, deadlineMs: 10_000 };

describe("createA2aPollStream", () => {
  it("submits, polls WORKING then COMPLETED, emits artifact text, exitCode 0", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(res(200, task("TASK_STATE_WORKING")))   // message:send
      .mockResolvedValueOnce(res(200, task("TASK_STATE_WORKING")))   // poll 1
      .mockResolvedValueOnce(res(200, task("TASK_STATE_COMPLETED", {
        artifacts: [{ parts: [{ text: "the diagnosis" }] }],
      })));                                                          // poll 2 terminal
    const h = createA2aPollStream({ baseUrl: "https://peer/a2a/agents/x", apiKey: "sk-x", message: "go", fetchImpl, ...FAST });
    const [out, done] = await Promise.all([collect(h.stdout), h.done]);

    expect(done.exitCode).toBe(0);
    expect(out).toContain("the diagnosis");
    // First call is the submit; bearer header carried; never leaked to stdout.
    const submitInit = fetchImpl.mock.calls[0][1];
    expect(submitInit.headers.Authorization).toBe("Bearer sk-x");
    expect(out).not.toContain("sk-x");
    expect(out).not.toContain("https://peer");
  });

  it("honours a terminal state already present in the submit response (no poll)", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(res(200, task("TASK_STATE_COMPLETED", {
      artifacts: [{ parts: [{ text: "instant" }] }],
    })));
    const h = createA2aPollStream({ baseUrl: "https://peer/a", message: "go", fetchImpl, ...FAST });
    const [out, done] = await Promise.all([collect(h.stdout), h.done]);

    expect(done.exitCode).toBe(0);
    expect(out).toContain("instant");
    expect(fetchImpl).toHaveBeenCalledTimes(1); // submit only
  });

  it("falls back to status.message text on FAILED (no artifact), exitCode 1", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(res(200, task("TASK_STATE_WORKING")))
      .mockResolvedValueOnce(res(200, {
        task: { id: "t1", status: { state: "TASK_STATE_FAILED", message: { parts: [{ text: "boom on remote" }] } } },
      }));
    const h = createA2aPollStream({ baseUrl: "https://peer/a", message: "go", fetchImpl, ...FAST });
    const [out, done] = await Promise.all([collect(h.stdout), h.done]);

    expect(done.exitCode).toBe(1);
    expect(out).toContain("boom on remote");
    expect(out).toContain("TASK_STATE_FAILED");
  });

  it("fails when submit is rejected", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(res(403, { error: { message: "nope" } }));
    const h = createA2aPollStream({ baseUrl: "https://peer/a", message: "go", fetchImpl, ...FAST });
    const [out, done] = await Promise.all([collect(h.stdout), h.done]);

    expect(done.exitCode).toBe(1);
    expect(out).toContain("HTTP 403");
  });

  it("stops fast on a 4xx during polling", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(res(200, task("TASK_STATE_WORKING")))
      .mockResolvedValueOnce(res(404, {}));
    const h = createA2aPollStream({ baseUrl: "https://peer/a", message: "go", fetchImpl, ...FAST });
    const [out, done] = await Promise.all([collect(h.stdout), h.done]);

    expect(done.exitCode).toBe(1);
    expect(out).toContain("HTTP 404");
  });

  it("resolves null and cancels remote when aborted during polling", async () => {
    const calls: string[] = [];
    let handle: ReturnType<typeof createA2aPollStream>;
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith("/message:send")) return res(200, task("TASK_STATE_WORKING"));
      if (url.includes(":cancel")) return res(200, task("TASK_STATE_CANCELED"));
      handle.abort(); // first poll → trigger job_stop, then return non-terminal
      return res(200, task("TASK_STATE_WORKING"));
    });
    handle = createA2aPollStream({ baseUrl: "https://peer/a", message: "go", fetchImpl: fetchImpl as never, ...FAST });
    const [, done] = await Promise.all([collect(handle.stdout), handle.done]);

    expect(done.exitCode).toBeNull();
    expect(calls.some((u) => u.includes(":cancel"))).toBe(true);
  });

  it("fails after MAX consecutive poll network errors", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(res(200, task("TASK_STATE_WORKING")))
      .mockRejectedValue(new Error("ECONNRESET"));
    const h = createA2aPollStream({ baseUrl: "https://peer/a", message: "go", fetchImpl, ...FAST });
    const [out, done] = await Promise.all([collect(h.stdout), h.done]);

    expect(done.exitCode).toBe(1);
    expect(out).toContain("Lost contact");
  });

  it("concatenates multiple artifact parts (A2)", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(res(200, task("TASK_STATE_COMPLETED", {
      artifacts: [{ parts: [{ text: "part-a " }, { text: "part-b" }] }],
    })));
    const h = createA2aPollStream({ baseUrl: "https://peer/a", message: "go", fetchImpl, ...FAST });
    const [out, done] = await Promise.all([collect(h.stdout), h.done]);
    expect(done.exitCode).toBe(0);
    expect(out).toContain("part-a part-b");
  });

  it("emits a fallback line on COMPLETED with no text (A3)", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(res(200, task("TASK_STATE_COMPLETED")));
    const h = createA2aPollStream({ baseUrl: "https://peer/a", message: "go", label: "peer-x", fetchImpl, ...FAST });
    const [out, done] = await Promise.all([collect(h.stdout), h.done]);
    expect(done.exitCode).toBe(0);
    expect(out).toContain("no text output");
  });

  it("counts unparseable 200 bodies as failures and stops (A4)", async () => {
    const badJson = { ok: true, status: 200, json: async () => { throw new Error("bad"); } } as unknown as Response;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(res(200, task("TASK_STATE_WORKING"))) // submit
      .mockResolvedValue(badJson);                                 // every poll unparseable
    const h = createA2aPollStream({ baseUrl: "https://peer/a", message: "go", fetchImpl, ...FAST });
    const [out, done] = await Promise.all([collect(h.stdout), h.done]);
    expect(done.exitCode).toBe(1);
    expect(out).toContain("unparseable");
  });
});
