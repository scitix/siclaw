/**
 * Offline fixtures for the P0 metering path.
 *
 * These drive the real recorder through a scripted stream and a scripted fetch,
 * so they exercise the whole chain — instrumented fetch → raw observation →
 * provenance → measurement — without a network or a model.
 *
 * Every case here is one of the counter-examples that made the design what it
 * is. They all share a shape: something produces zeros, and a naive reader would
 * bank them as "this call was free".
 */

import { describe, it, expect } from "vitest";
import { LlmCallRecorder } from "./llm-call-recorder.js";
import type { LlmCallMeasurement } from "../shared/llm-call-record.js";

/** A stream that yields nothing and settles with `finalMessage`. */
function streamOf(finalMessage: any) {
  return {
    async result() { return finalMessage; },
    [Symbol.asyncIterator]() {
      return {
        async next() { return { done: true as const, value: undefined }; },
        async return() { return { done: true as const, value: undefined }; },
        async throw() { return { done: true as const, value: undefined }; },
      };
    },
  };
}

/** Body of a Responses SSE stream whose terminal event carries `usage`. */
const sseWithUsage = (usage: unknown): string =>
  `data: ${JSON.stringify({ type: "response.completed", response: { usage } })}\n\ndata: [DONE]\n\n`;

/** An SSE stream that never reports usage at all. */
const sseWithoutUsage = (): string =>
  `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hi" })}\n\ndata: [DONE]\n\n`;

interface Harness {
  recorder: LlmCallRecorder;
  measurements: LlmCallMeasurement[];
  /** Runs one call whose HTTP response body is `body`; omit to leave fetch uninstrumented-by-the-caller. */
  call(body: string | null, finalMessage?: any, context?: any): Promise<void>;
}

function harness(options: { instrument?: boolean } = {}): Harness {
  const measurements: LlmCallMeasurement[] = [];
  const recorder = new LlmCallRecorder({
    ...(options.instrument === false ? {} : { onMeasurement: (m) => measurements.push(m) }),
    newCallId: (() => { let n = 0; return () => `id-${++n}`; })(),
  });

  const call: Harness["call"] = async (body, finalMessage = {}, context = { tools: [], messages: [] }) => {
    const base = (_model: any, _context: any, opts: any) => {
      // Exercise the injected fetch exactly as the SDK would.
      if (body !== null && opts?.fetch) {
        void opts.fetch("https://provider.invalid/v1/responses").then((r: Response) => r.text());
      }
      return streamOf({ api: "openai-responses", provider: "example-gateway", model: "gpt-5", ...finalMessage });
    };
    const wrapped = recorder.wrapStreamFn(base as any);
    const stream = wrapped({ provider: "example-gateway", id: "gpt-5" }, context, {
      fetch: body === null ? undefined : async () => new Response(body, { status: 200 }),
    });
    await stream.result();
    await new Promise((r) => setTimeout(r, 0)); // let the observer branch settle
  };

  return { recorder, measurements, call };
}

describe("metering: provenance of every zero", () => {
  it("records provider-reported figures, keeping an explicit zero as a zero", async () => {
    const h = harness();
    h.recorder.beginPrompt();
    await h.call(sseWithUsage({
      input_tokens: 1_000,
      output_tokens: 200,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 50 },
    }));

    expect(h.measurements).toHaveLength(1);
    const m = h.measurements[0];
    expect(m.usage_source).toBe("provider");
    expect(m.usage_status).toBe("reported");
    expect(m.cache_read_tokens).toBe(0);         // reported zero survives as 0
    expect(m.input_tokens_total).toBe(1_000);
    expect(m.reasoning_tokens).toBe(50);
    expect(m.inconsistencies).toEqual([]);
  });

  it("1. a call that settles normally without usage is `missing`, not zeros", async () => {
    const h = harness();
    h.recorder.beginPrompt();
    await h.call(sseWithoutUsage(), { stopReason: "stop" });

    const m = h.measurements[0];
    expect(m.usage_source).toBe("sdk_default");
    expect(m.usage_status).toBe("missing");
    // The decisive assertion: unreported figures are null, never 0.
    expect(m.input_tokens_total).toBeNull();
    expect(m.output_tokens_total).toBeNull();
    expect(m.cache_read_tokens).toBeNull();
  });

  it("2. an aborted call leaves nulls rather than initialisation zeros", async () => {
    const h = harness();
    h.recorder.beginPrompt();
    await h.call(sseWithoutUsage(), { stopReason: "aborted" });

    const m = h.measurements[0];
    expect(m.usage_status).toBe("missing");
    expect(m.output_tokens_total).toBeNull();
  });

  it("3. a transport that never calls fetch is `unknown`, which is not `missing`", async () => {
    // Nothing was observed, so we cannot claim the provider stayed silent —
    // `missing` would be an assertion we have no basis for. The measurement
    // waits out the observation grace period and then settles as unknown.
    const h = harness();
    h.recorder.beginPrompt();
    await h.call(null);
    await new Promise((r) => setTimeout(r, 300)); // > OBSERVATION_GRACE_MS

    const m = h.measurements[0];
    expect(m.usage_source).toBe("unknown");
    expect(m.usage_status).toBe("unknown");
    expect(m.input_tokens_total).toBeNull();
  });

  it("4. partial reports are marked partial and keep the fields that did arrive", async () => {
    const h = harness();
    h.recorder.beginPrompt();
    await h.call(sseWithUsage({ input_tokens: 17 }));

    const m = h.measurements[0];
    expect(m.usage_source).toBe("provider");
    expect(m.usage_status).toBe("partial");
    expect(m.reported_fields).toEqual(["input"]);
    expect(m.input_tokens_total).toBe(17);
    // pi would have shown 0 here; the raw observation says "never sent".
    expect(m.reasoning_tokens).toBeNull();
  });

  it("5. contradictory figures are surfaced, not clamped away", async () => {
    const h = harness();
    h.recorder.beginPrompt();
    await h.call(sseWithUsage({
      input_tokens: 100,
      output_tokens: 10,
      input_tokens_details: { cached_tokens: 120 },
      output_tokens_details: { reasoning_tokens: 20 },
    }));

    const m = h.measurements[0];
    expect(m.inconsistencies.map((p) => p.field).sort()).toEqual(["cache_vs_input", "reasoning_vs_output"]);
    // The raw values are preserved as evidence rather than normalised.
    expect(m.output_tokens_total).toBe(10);
    expect(m.reasoning_tokens).toBe(20);
  });
});

describe("metering: identity and correlation", () => {
  it("gives each call its own call_id while holding prompt_id steady", async () => {
    const h = harness();
    h.recorder.beginPrompt();
    await h.call(sseWithUsage({ input_tokens: 1 }));
    await h.call(sseWithUsage({ input_tokens: 2 }));

    const [a, b] = h.measurements;
    expect(a.call_id).not.toBe(b.call_id);
    expect(a.prompt_id).toBe(b.prompt_id);
  });

  it("never emits an empty prompt_id", async () => {
    const h = harness();
    h.recorder.beginPrompt();
    await h.call(sseWithUsage({ input_tokens: 1 }));
    expect(h.measurements[0].prompt_id).not.toBe("");
  });

  it("counts transport retries without minting extra call_ids", async () => {
    const measurements: LlmCallMeasurement[] = [];
    const recorder = new LlmCallRecorder({ onMeasurement: (m) => measurements.push(m) });
    recorder.beginPrompt();

    let attempts = 0;
    const base = (_m: any, _c: any, opts: any) => {
      // Two HTTP attempts inside ONE logical call.
      void (async () => {
        await opts.fetch("https://provider.invalid").then((r: Response) => r.text());
        await opts.fetch("https://provider.invalid").then((r: Response) => r.text());
      })();
      return streamOf({ api: "openai-responses", provider: "example-gateway", model: "gpt-5" });
    };
    const wrapped = recorder.wrapStreamFn(base as any);
    const stream = wrapped({ provider: "example-gateway", id: "gpt-5" }, { tools: [], messages: [] }, {
      fetch: async () => {
        attempts += 1;
        return new Response(sseWithUsage({ input_tokens: attempts * 10 }), { status: 200 });
      },
    });
    await stream.result();
    await new Promise((r) => setTimeout(r, 5));

    expect(measurements).toHaveLength(1);
    expect(measurements[0].network_attempts).toBeGreaterThanOrEqual(1);
  });

  it("marks aux calls distinctly from agent calls", async () => {
    const h = harness();
    h.recorder.beginPrompt();
    // No `tools` on the context ⇒ auxiliary (compaction/summarisation) call.
    await h.call(sseWithUsage({ input_tokens: 5 }), {}, { messages: [] });

    expect(h.measurements[0].kind).toBe("aux");
  });
});

describe("metering: the FINAL attempt decides", () => {
  /** Drives one call whose fetch answers differently per attempt. */
  async function callWithAttempts(bodies: Array<{ body: string; delayMs?: number }>) {
    const measurements: LlmCallMeasurement[] = [];
    const recorder = new LlmCallRecorder({ onMeasurement: (m) => measurements.push(m) });
    recorder.beginPrompt();

    let n = 0;
    // Retries happen while the SDK is still trying to obtain a response, i.e.
    // BEFORE the stream settles — so every attempt is started by seal time.
    const base = async (_m: any, _c: any, opts: any) => {
      for (let i = 0; i < bodies.length; i++) {
        await opts.fetch("https://provider.invalid").then((r: Response) => r.text()).catch(() => {});
      }
      return streamOf({ api: "openai-responses", provider: "example-gateway", model: "gpt-5" });
    };
    const stream = await recorder.wrapStreamFn(base as any)(
      { provider: "example-gateway", id: "gpt-5" },
      { tools: [], messages: [] },
      {
        fetch: async () => {
          const spec = bodies[Math.min(n++, bodies.length - 1)];
          if (spec.delayMs) await new Promise((r) => setTimeout(r, spec.delayMs));
          return new Response(spec.body, { status: 200 });
        },
      },
    );
    await stream.result();
    await new Promise((r) => setTimeout(r, 400)); // past the observation grace
    return measurements;
  }

  it("does not let an earlier success stand in for a final unreadable attempt", async () => {
    const measurements = await callWithAttempts([
      { body: sseWithUsage({ input_tokens: 500 }) },     // attempt 1 succeeded
      { body: 'data: {"type":"response.compl\n\n' },     // attempt 2 broke
    ]);
    // Reporting 500 here would quote a response the SDK discarded.
    expect(measurements[0].usage_source).toBe("unknown");
    expect(measurements[0].input_tokens_total).toBeNull();
  });

  it("waits for a slow final attempt rather than recording the 503 before it", async () => {
    const measurements = await callWithAttempts([
      { body: "upstream unavailable" },                                  // 503-ish, unparseable
      { body: sseWithUsage({ input_tokens: 77, output_tokens: 3 }), delayMs: 80 },
    ]);
    expect(measurements[0].usage_source).toBe("provider");
    expect(measurements[0].input_tokens_total).toBe(77);
    expect(measurements[0].network_attempts).toBe(2);
  });
});

describe("metering: request snapshot", () => {
  it("separates history growth from history rewriting", async () => {
    const h = harness();
    h.recorder.beginPrompt();
    const shared = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }];

    // Growth: same prefix, one more message appended.
    await h.call(sseWithUsage({ input_tokens: 1 }), {}, { tools: [], messages: [...shared] });
    await h.call(sseWithUsage({ input_tokens: 1 }), {}, { tools: [], messages: [...shared, { role: "user", content: "c" }] });
    // Rewrite: an OLD message changed — the cache prefix is dead.
    await h.call(sseWithUsage({ input_tokens: 1 }), {}, {
      tools: [],
      messages: [{ role: "user", content: "a" }, { role: "assistant", content: "REWRITTEN" }, { role: "user", content: "c" }],
    });

    const [grow1, grow2, rewrite] = h.measurements.map((m) => m.request_snapshot);
    // First call's prefix is just the user turn; second call's prefix is the two
    // shared messages — different, but each is a stable extension.
    expect(grow2.history_message_count).toBe(3);
    expect(rewrite.history_message_count).toBe(3);
    // Same length, different prefix ⇒ this is the signal that matters.
    expect(rewrite.history_prefix_sha256).not.toBe(grow2.history_prefix_sha256);
    expect(grow1.history_prefix_sha256).toBeTruthy();
  });

  it("fingerprints system prompt and tools separately", async () => {
    const h = harness();
    h.recorder.beginPrompt();
    await h.call(sseWithUsage({ input_tokens: 1 }), {}, { tools: [{ name: "bash" }], messages: [], systemPrompt: "S1" });
    await h.call(sseWithUsage({ input_tokens: 1 }), {}, { tools: [{ name: "bash" }], messages: [], systemPrompt: "S2" });

    const [a, b] = h.measurements.map((m) => m.request_snapshot);
    expect(a.tools_sha256).toBe(b.tools_sha256);      // tools unchanged
    expect(a.system_sha256).not.toBe(b.system_sha256); // prompt changed
  });
});

describe("metering is strictly additive", () => {
  it("produces nothing and instruments no fetch when no sink is configured", async () => {
    const h = harness({ instrument: false });
    h.recorder.beginPrompt();

    let sawInjectedFetch = false;
    const base = (_m: any, _c: any, opts: any) => {
      sawInjectedFetch = typeof opts?.fetch === "function" && opts.fetch.name !== "boundFetch";
      return streamOf({ api: "openai-responses", provider: "example-gateway", model: "gpt-5" });
    };
    const wrapped = h.recorder.wrapStreamFn(base as any);
    await wrapped({ provider: "example-gateway", id: "gpt-5" }, { tools: [], messages: [] }, {}).result();

    expect(h.measurements).toHaveLength(0);
    expect(sawInjectedFetch).toBe(false);
  });
});

describe("metering: which user request a call served", () => {
  it("carries the bound request across rounds and routing retries", async () => {
    const h = harness();
    h.recorder.setRootRequestId("turn-abc");
    h.recorder.beginPrompt();
    await h.call(sseWithUsage({ input_tokens: 10, output_tokens: 1 }));
    // A routing retry is the SAME user request on another candidate.
    h.recorder.beginAttempt(2);
    await h.call(sseWithUsage({ input_tokens: 10, output_tokens: 1 }));

    expect(h.measurements.map((m) => m.root_request_id)).toEqual(["turn-abc", "turn-abc"]);
    // …while staying distinct calls, so the correlation groups them rather than
    // collapsing two real calls into one row.
    expect(new Set(h.measurements.map((m) => m.call_id)).size).toBe(2);
  });

  it("records null when nothing bound a request, rather than inventing one", async () => {
    const h = harness();
    h.recorder.beginPrompt();
    await h.call(sseWithUsage({ input_tokens: 10, output_tokens: 1 }));

    expect(h.measurements[0].root_request_id).toBeNull();
  });

  it("drops an unstorable id instead of truncating it, and keeps the measurement", async () => {
    const h = harness();
    h.recorder.setRootRequestId("x".repeat(65));
    h.recorder.beginPrompt();
    await h.call(sseWithUsage({ input_tokens: 10, output_tokens: 1 }));

    // A prefix would join calls from different requests; null says we could not
    // carry the correlation. Either way the usage figures still land.
    expect(h.measurements[0].root_request_id).toBeNull();
    expect(h.measurements[0].input_tokens_total).toBe(10);
  });

  it("names the call whose tools are running, so a spawn can record its dispatcher", async () => {
    const h = harness();
    h.recorder.beginPrompt();
    expect(h.recorder.getToolDispatchCallId()).toBeNull();   // nothing has sealed yet

    await h.call(sseWithUsage({ input_tokens: 10, output_tokens: 1 }));
    const firstRound = h.recorder.getToolDispatchCallId();
    expect(firstRound).toBe(h.measurements[0].call_id);

    // The NEXT round replaces it — which is exactly why a spawn must read this
    // synchronously at dispatch rather than later.
    await h.call(sseWithUsage({ input_tokens: 10, output_tokens: 1 }));
    expect(h.recorder.getToolDispatchCallId()).toBe(h.measurements[1].call_id);
    expect(h.recorder.getToolDispatchCallId()).not.toBe(firstRound);
  });

  it("does not let an aux call stand in as the dispatcher", async () => {
    // A summarisation issues no tools; naming it would attribute the spawn to a
    // call that could not have made it.
    const h = harness();
    h.recorder.beginPrompt();
    await h.call(sseWithUsage({ input_tokens: 10, output_tokens: 1 }));
    const agentCall = h.recorder.getToolDispatchCallId();

    await h.call(sseWithUsage({ input_tokens: 5, output_tokens: 1 }), {}, { systemPrompt: "summarise", messages: [] });

    expect(h.measurements[1].kind).toBe("aux");
    expect(h.recorder.getToolDispatchCallId()).toBe(agentCall);
  });

  it("stamps a sub-agent's calls with the call that spawned it", async () => {
    const child = harness();
    child.recorder.setParentCallId("call-parent-round-2");
    child.recorder.beginPrompt();
    await child.call(sseWithUsage({ input_tokens: 10, output_tokens: 1 }));

    expect(child.measurements[0].parent_call_id).toBe("call-parent-round-2");
    // A parent's own calls have no dispatcher.
    const parent = harness();
    parent.recorder.beginPrompt();
    await parent.call(sseWithUsage({ input_tokens: 10, output_tokens: 1 }));
    expect(parent.measurements[0].parent_call_id).toBeNull();
  });

  it("keeps the request a call opened under, not one rebound mid-flight", async () => {
    const h = harness();
    h.recorder.setRootRequestId("turn-1");
    h.recorder.beginPrompt();
    const started = h.call(sseWithUsage({ input_tokens: 10, output_tokens: 1 }));
    h.recorder.setRootRequestId("turn-2");
    await started;

    expect(h.measurements[0].root_request_id).toBe("turn-1");
  });
});
