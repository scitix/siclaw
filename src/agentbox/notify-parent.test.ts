import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentBoxSessionManager } from "./session.js";

/**
 * Focused tests for the background-job → parent-model notification path
 * (notifyParent / flushPendingNotifications / runSyntheticPrompt). The methods are private;
 * we drive them via `as any` with a hand-built ManagedSession + brain stub, since a full
 * session boot is unnecessary to exercise the in-flight / idle / dedup / coalesce branches.
 *
 * The idle path coalesces completions over a short timer window, so those tests use fake
 * timers and advance past the window to deliver.
 */

const COALESCE_MS = 600;
const flushCoalesce = () => vi.advanceTimersByTimeAsync(COALESCE_MS + 50);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function fakeBrain() {
  return {
    followUp: vi.fn(async () => {}),
    prompt: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
  };
}

function fakeManaged(id: string, brain: ReturnType<typeof fakeBrain>, promptDone: boolean) {
  return {
    id,
    brain,
    _promptDone: promptDone,
    _promptInflight: null as Promise<void> | null,
    _syntheticPromptQueue: null as Promise<void> | null,
    _promptDoneCallbacks: new Set<() => void>(),
    _backgroundWorkCount: 1, // >0 so runSyntheticPrompt's finally skips scheduleRelease (no timers)
    _aborted: false,
    _routeBrainEventsThroughExtra: false,
    _eventBuffer: [] as unknown[],
    _bufferUnsub: null as null | (() => void),
    _extraEventBuffer: [] as unknown[],
    _extraEventSubs: new Set<(e: Record<string, unknown>) => void>(),
    _pendingNotifications: [] as unknown[],
    _coalesceTimer: null as ReturnType<typeof setTimeout> | null,
  };
}

function setup(promptDone: boolean) {
  const mgr = new AgentBoxSessionManager() as any;
  const brain = fakeBrain();
  const managed = fakeManaged("s1", brain, promptDone);
  mgr.sessions.set("s1", managed);
  mgr.jobs.register({
    jobId: "j1", type: "bash", parentSessionId: "s1", description: "cmd",
    status: "completed", startedAt: 0, notified: false, outputFile: "/o",
  });
  return { mgr, brain, managed };
}

describe("notifyParent", () => {
  it("in-flight parent: buffered and delivered as a synthetic turn once idle (never followUp)", async () => {
    const { mgr, brain, managed } = setup(false); // turn in-flight
    await mgr.notifyParent("s1", "j1", { taskId: "j1", outputFile: "/o", status: "completed", summary: "done" });
    await flushCoalesce();
    // Still in-flight → NOT delivered, and never via followUp (its ack can't be suppressed).
    expect(brain.followUp).not.toHaveBeenCalled();
    expect(brain.prompt).not.toHaveBeenCalled();
    // Turn ends → the re-armed coalesce window delivers it as a synthetic turn.
    managed._promptDone = true;
    await flushCoalesce();
    expect(brain.prompt).toHaveBeenCalledTimes(1);
    expect(brain.prompt.mock.calls[0][0]).toContain("<task_notification>");
    expect(brain.followUp).not.toHaveBeenCalled();
  });

  it("idle parent (prompt done) → synthetic prompt (after the coalesce window)", async () => {
    const { mgr, brain } = setup(true);
    await mgr.notifyParent("s1", "j1", { taskId: "j1", outputFile: "/o", status: "completed", summary: "done" });
    expect(brain.prompt).not.toHaveBeenCalled(); // buffered, not yet delivered
    await flushCoalesce();
    expect(brain.prompt).toHaveBeenCalledTimes(1);
    expect(brain.prompt.mock.calls[0][0]).toContain("<task_notification>");
    expect(brain.followUp).not.toHaveBeenCalled();
  });

  it("coalesces a burst of idle completions into ONE synthetic turn", async () => {
    const { mgr, brain } = setup(true);
    mgr.jobs.register({
      jobId: "j2", type: "bash", parentSessionId: "s1", description: "cmd2",
      status: "completed", startedAt: 0, notified: false, outputFile: "/o2",
    });
    await mgr.notifyParent("s1", "j1", { taskId: "j1", status: "completed", summary: "a" });
    await mgr.notifyParent("s1", "j2", { taskId: "j2", status: "completed", summary: "b" });
    expect(brain.prompt).not.toHaveBeenCalled(); // both buffered within the window
    await flushCoalesce();
    expect(brain.prompt).toHaveBeenCalledTimes(1); // ONE turn, not two
    const text = brain.prompt.mock.calls[0][0] as string;
    expect((text.match(/<task_notification>/g) || []).length).toBe(2); // both jobs delivered together
  });

  it("dedups: second notifyParent for the same job is a no-op", async () => {
    const { mgr, brain } = setup(true); // idle
    await mgr.notifyParent("s1", "j1", { taskId: "j1", status: "completed", summary: "x" });
    await mgr.notifyParent("s1", "j1", { taskId: "j1", status: "completed", summary: "x" }); // claimNotification dedups
    await flushCoalesce();
    expect(brain.prompt).toHaveBeenCalledTimes(1); // one synthetic turn for j1, not two
    expect((brain.prompt.mock.calls[0][0] as string).match(/<task_notification>/g)?.length).toBe(1);
  });

  // #7: a job that completed just BEFORE Stop has already buffered its notification + armed the
  // coalesce timer. The Stop must not let that timer wake the model ("comes back to life").
  it("#7 Stop: a buffered completion is NOT flushed as a synthetic turn while _aborted", async () => {
    const { mgr, brain, managed } = setup(true); // idle, job completed
    await mgr.notifyParent("s1", "j1", { taskId: "j1", status: "completed", summary: "done" });
    expect(managed._pendingNotifications.length).toBe(1); // buffered, timer armed
    managed._aborted = true; // user presses Stop before the coalesce flush
    await flushCoalesce();
    expect(brain.prompt).not.toHaveBeenCalled();           // no resurrection
    expect(brain.followUp).not.toHaveBeenCalled();
    expect(managed._pendingNotifications.length).toBe(0);  // drained, not delivered
  });

  it("#7 discardPendingNotifications clears the buffer + cancels the coalesce timer", async () => {
    const { mgr, brain, managed } = setup(true);
    await mgr.notifyParent("s1", "j1", { taskId: "j1", status: "completed", summary: "done" });
    expect(managed._pendingNotifications.length).toBe(1);
    expect(managed._coalesceTimer).not.toBeNull();
    mgr.discardPendingNotifications("s1");
    expect(managed._pendingNotifications.length).toBe(0);
    expect(managed._coalesceTimer).toBeNull();
    await flushCoalesce();
    expect(brain.prompt).not.toHaveBeenCalled();
  });

  it("restores _promptDone after a synthetic turn", async () => {
    const { mgr, managed } = setup(true);
    await mgr.notifyParent("s1", "j1", { taskId: "j1", status: "completed", summary: "x" });
    await flushCoalesce();
    expect(managed._promptDone).toBe(true);
    expect(managed._promptInflight).toBeNull();
  });

  it("clears a pending release timer when a synthetic turn starts (no release mid-turn)", async () => {
    const { mgr, managed } = setup(true);
    // Simulate the race: a background job's onSettled armed a release timer just before
    // this turn. The synthetic turn must cancel it so release() can't fire mid-turn.
    let released = false;
    managed._releaseTimer = setTimeout(() => { released = true; }, 10_000) as any;
    managed._backgroundWorkCount = 1; // keep finally from re-arming
    await mgr.notifyParent("s1", "j1", { taskId: "j1", status: "completed", summary: "x" });
    await flushCoalesce();
    expect(managed._releaseTimer).toBeNull();
    expect(released).toBe(false);
  });

  it("no-op when the session was already released", async () => {
    const { mgr, brain } = setup(true);
    mgr.sessions.delete("s1");
    await mgr.notifyParent("s1", "j1", { taskId: "j1", status: "completed", summary: "x" });
    await flushCoalesce();
    expect(brain.prompt).not.toHaveBeenCalled();
    expect(brain.followUp).not.toHaveBeenCalled();
  });

  it("emits a live exec_job_done box update on completion (when persistable)", async () => {
    const { mgr } = setup(true);
    const send = vi.fn(async () => ({ ok: true }));
    mgr.gatewayClient = { sendDelegationPersistenceEvent: send };
    mgr.agentId = "agent-1";
    await mgr.notifyParent("s1", "j1", { taskId: "j1", status: "completed", summary: "done" });
    await flushCoalesce();
    const updates = send.mock.calls
      .map((c) => c[0])
      .filter((e: any) => e?.type === "delegation.emit_chat_event" && e?.event?.type === "exec_job_done");
    expect(updates).toHaveLength(1);
    expect(updates[0].event.job_id).toBe("j1");
    expect(updates[0].event.status).toBe("completed");
  });

  it("persists a hidden exec_job_event (box completion) for an exec job", async () => {
    const { mgr } = setup(true);
    const send = vi.fn(async () => ({ ok: true, id: "x" }));
    mgr.gatewayClient = { sendDelegationPersistenceEvent: send };
    mgr.agentId = "agent-1";
    await mgr.notifyParent("s1", "j1", { taskId: "j1", status: "completed", summary: "done" });
    await flushCoalesce();
    const appends = send.mock.calls.map((c) => c[0]).filter((e: any) => e?.type === "delegation.append_message");
    const execEvent = appends.find((e: any) => e.message?.metadata?.kind === "exec_job_event");
    expect(execEvent).toBeTruthy();
    expect(execEvent.message.metadata.job_id).toBe("j1");
    expect(execEvent.message.metadata.status).toBe("completed");
  });

  it("a no-tool-call synthetic turn persists NOTHING (pure ack → no bubble)", async () => {
    const { mgr } = setup(true);
    const send = vi.fn(async () => ({ ok: true, id: "x" }));
    mgr.gatewayClient = { sendDelegationPersistenceEvent: send };
    mgr.agentId = "agent-1";
    await mgr.notifyParent("s1", "j1", { taskId: "j1", status: "completed", summary: "done" });
    await flushCoalesce();
    const appends = send.mock.calls.map((c) => c[0]).filter((e: any) => e?.type === "delegation.append_message");
    // Only the exec_job_event row (box completion) is persisted; the synthetic turn made no
    // tool call, so its (ack) message is NOT persisted → no chat bubble.
    const nonExec = appends.filter((e: any) => e.message?.metadata?.kind !== "exec_job_event");
    expect(nonExec).toHaveLength(0);
  });

  it("a text-only synthetic turn for a SUB-AGENT (inline result, no output_file) persists the report + fires background_turn_done", async () => {
    const mgr = new AgentBoxSessionManager() as any;
    // Brain that, on prompt(), emits one assistant text message (the inline result report) and no tool call.
    let cb: ((e: any) => void) | undefined;
    const brain = {
      followUp: vi.fn(async () => {}),
      subscribe: vi.fn((fn: (e: any) => void) => { cb = fn; return () => {}; }),
      prompt: vi.fn(async () => {
        cb?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "The sum is 34" }] } });
      }),
    };
    const managed = fakeManaged("s1", brain as any, true);
    mgr.sessions.set("s1", managed);
    mgr.jobs.register({ jobId: "sa1", type: "subagent", parentSessionId: "s1", description: "compute", status: "completed", startedAt: 0, notified: false }); // no outputFile
    const send = vi.fn(async () => ({ ok: true, id: "x" }));
    mgr.gatewayClient = { sendDelegationPersistenceEvent: send };
    mgr.agentId = "agent-1";
    await mgr.notifyParent("s1", "sa1", { taskId: "sa1", status: "completed", summary: "result: 34" }); // no output_file → inline result
    await flushCoalesce();
    const events = send.mock.calls.map((c) => c[0]);
    const report = events.filter((e: any) => e?.type === "delegation.append_message").find((e: any) => (e.message?.content || "").includes("34"));
    expect(report).toBeTruthy(); // the text-only report is persisted (not dropped)
    const btd = events.filter((e: any) => e?.type === "delegation.emit_chat_event" && e?.event?.type === "background_turn_done");
    expect(btd).toHaveLength(1); // refetch trigger fired so the UI shows the report
  });

  it("routes an idle synthetic turn through fallback using the session's last modelRouting policy", async () => {
    const mgr = new AgentBoxSessionManager() as any;
    const listeners = new Set<(event: any) => void>();
    const emit = (event: any) => {
      for (const listener of listeners) listener(event);
    };
    const models = [
      { id: "gpt-4", provider: "openai", name: "GPT-4" },
      { id: "claude", provider: "anthropic", name: "Claude" },
    ];
    let currentModel = models[0];
    const seenModels: string[] = [];
    const routeFlagDuringPrompt: boolean[] = [];
    const brain = {
      followUp: vi.fn(async () => {}),
      subscribe: vi.fn((fn: (e: any) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      }),
      prompt: vi.fn(async () => {
        seenModels.push(`${currentModel.provider}/${currentModel.id}`);
        // The routed runner buffers brain events; the SSE route's live brain
        // subscription must be suppressed for the whole turn or a connected
        // client streams every failed attempt raw.
        routeFlagDuringPrompt.push(managed._routeBrainEventsThroughExtra);
        if (currentModel.provider === "openai") {
          emit({
            type: "message_end",
            message: {
              role: "assistant",
              content: [],
              stopReason: "error",
              errorMessage: "429 rate limit exceeded",
            },
          });
          return;
        }
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "fallback synthetic report" }],
            stopReason: "stop",
          },
        });
      }),
      getModel: vi.fn(() => currentModel),
      findModel: vi.fn((provider: string, id: string) =>
        models.find((model) => model.provider === provider && model.id === id),
      ),
      setModel: vi.fn(async (model: typeof currentModel) => { currentModel = model; }),
    };
    const managed = fakeManaged("s1", brain as any, true);
    managed.modelRouteState = { cooldowns: {}, attempts: [] };
    managed.modelRoutePolicy = {
      enabled: true,
      strategy: "ordered_fallback",
      cooldownMsByKind: { rate_limit: 1000 },
      candidates: [
        { provider: "openai", modelId: "gpt-4" },
        { provider: "anthropic", modelId: "claude" },
      ],
    };
    mgr.sessions.set("s1", managed);
    mgr.persistModelRouteState = vi.fn();
    mgr.jobs.register({ jobId: "sa1", type: "subagent", parentSessionId: "s1", description: "compute", status: "completed", startedAt: 0, notified: false });
    const send = vi.fn(async () => ({ ok: true, id: "x" }));
    mgr.gatewayClient = { sendDelegationPersistenceEvent: send };
    mgr.agentId = "agent-1";

    await mgr.notifyParent("s1", "sa1", { taskId: "sa1", status: "completed", summary: "result" });
    await flushCoalesce();

    expect(seenModels).toEqual(["openai/gpt-4", "anthropic/claude"]);
    expect(routeFlagDuringPrompt).toEqual([true, true]);
    expect(managed._routeBrainEventsThroughExtra).toBe(false);
    expect(managed.modelRouteState.activeCandidateKey).toBe("anthropic/claude");
    const events = send.mock.calls.map((c) => c[0]);
    const report = events
      .filter((e: any) => e?.type === "delegation.append_message")
      .find((e: any) => (e.message?.content || "").includes("fallback synthetic report"));
    expect(report?.message?.metadata?.model_route).toMatchObject({
      provider: "anthropic",
      model_id: "claude",
      is_fallback: true,
      switched_from_provider: "openai",
      failure_kind: "rate_limit",
    });
  });

  it("a text-only synthetic turn for a BASH job (output_file present) is still dropped (pure ack)", async () => {
    const mgr = new AgentBoxSessionManager() as any;
    let cb: ((e: any) => void) | undefined;
    const brain = {
      followUp: vi.fn(async () => {}),
      subscribe: vi.fn((fn: (e: any) => void) => { cb = fn; return () => {}; }),
      prompt: vi.fn(async () => {
        cb?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "no new info" }] } });
      }),
    };
    const managed = fakeManaged("s1", brain as any, true);
    mgr.sessions.set("s1", managed);
    mgr.jobs.register({ jobId: "j1", type: "bash", parentSessionId: "s1", description: "cmd", status: "completed", startedAt: 0, notified: false, outputFile: "/o" });
    const send = vi.fn(async () => ({ ok: true, id: "x" }));
    mgr.gatewayClient = { sendDelegationPersistenceEvent: send };
    mgr.agentId = "agent-1";
    await mgr.notifyParent("s1", "j1", { taskId: "j1", outputFile: "/o", status: "completed", summary: "done" }); // output_file → data in file, text-only ack is noise
    await flushCoalesce();
    const events = send.mock.calls.map((c) => c[0]);
    const ack = events.filter((e: any) => e?.type === "delegation.append_message").find((e: any) => (e.message?.content || "").includes("no new info"));
    expect(ack).toBeFalsy(); // the pure-ack text is NOT persisted
    const btd = events.filter((e: any) => e?.type === "delegation.emit_chat_event" && e?.event?.type === "background_turn_done");
    expect(btd).toHaveLength(0);
  });

  it("a MIXED batch (sub-agent + shell job) keeps the strict guard — text-only ack is dropped", async () => {
    const mgr = new AgentBoxSessionManager() as any;
    let cb: ((e: any) => void) | undefined;
    const brain = {
      followUp: vi.fn(async () => {}),
      subscribe: vi.fn((fn: (e: any) => void) => { cb = fn; return () => {}; }),
      prompt: vi.fn(async () => {
        cb?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "both done, nothing new" }] } });
      }),
    };
    const managed = fakeManaged("s1", brain as any, true);
    mgr.sessions.set("s1", managed);
    mgr.jobs.register({ jobId: "sa1", type: "subagent", parentSessionId: "s1", description: "sub", status: "completed", startedAt: 0, notified: false }); // inline (no outputFile)
    mgr.jobs.register({ jobId: "j1", type: "bash", parentSessionId: "s1", description: "cmd", status: "completed", startedAt: 0, notified: false, outputFile: "/o" });
    const send = vi.fn(async () => ({ ok: true, id: "x" }));
    mgr.gatewayClient = { sendDelegationPersistenceEvent: send };
    mgr.agentId = "agent-1";
    // Both complete within the coalesce window → ONE synthetic turn covering the mixed batch.
    await mgr.notifyParent("s1", "sa1", { taskId: "sa1", status: "completed", summary: "sub result" });
    await mgr.notifyParent("s1", "j1", { taskId: "j1", outputFile: "/o", status: "completed", summary: "done" });
    await flushCoalesce();
    const events = send.mock.calls.map((c) => c[0]);
    // The shell job present in the batch flips off allowTextOnlyPersist, so a text-only reaction
    // is NOT persisted as a bubble (the sub-agent result still shows via its own card fold).
    const ack = events.filter((e: any) => e?.type === "delegation.append_message").find((e: any) => (e.message?.content || "").includes("nothing new"));
    expect(ack).toBeFalsy();
    const btd = events.filter((e: any) => e?.type === "delegation.emit_chat_event" && e?.event?.type === "background_turn_done");
    expect(btd).toHaveLength(0);
  });

  it("emits a live subagent_done fold event when a background sub-agent completes", async () => {
    const { mgr } = setup(true);
    mgr.jobs.register({ jobId: "sa9", type: "subagent", parentSessionId: "s1", description: "sub", status: "completed", startedAt: 0, notified: false });
    const send = vi.fn(async () => ({ ok: true, id: "x" }));
    mgr.gatewayClient = { sendDelegationPersistenceEvent: send };
    mgr.agentId = "agent-1";
    await mgr.notifyParent("s1", "sa9", { taskId: "sa9", status: "completed", summary: "result: 42" });
    await flushCoalesce();
    const fold = send.mock.calls
      .map((c) => c[0])
      .filter((e: any) => e?.type === "delegation.emit_chat_event" && e?.event?.type === "subagent_done");
    expect(fold).toHaveLength(1);
    expect(fold[0].event.job_id).toBe("sa9");
    expect(fold[0].event.status).toBe("completed");
    // Sub-agents are NOT given an exec_job_event (that's for shell/exec jobs).
    const execEvents = send.mock.calls.map((c) => c[0]).filter((e: any) => e?.message?.metadata?.kind === "exec_job_event");
    expect(execEvents).toHaveLength(0);
  });

  it("does NOT emit background_turn_done when not persistable (no gatewayClient)", async () => {
    const { mgr, brain } = setup(true);
    // No gatewayClient / agentId → canPersist is false.
    await mgr.notifyParent("s1", "j1", { taskId: "j1", status: "completed", summary: "done" });
    await flushCoalesce();
    expect(brain.prompt).toHaveBeenCalledTimes(1); // synthetic turn still runs
    // (nothing to assert on a send mock — there is no gatewayClient; the guard prevents the call)
  });

  it("persists a COMPLETED tool call in a synthetic turn with outcome 'success' (not null → no stuck 'running' card on refresh)", async () => {
    const mgr = new AgentBoxSessionManager() as any;
    let cb: ((e: any) => void) | undefined;
    const brain = {
      followUp: vi.fn(async () => {}),
      subscribe: vi.fn((fn: (e: any) => void) => { cb = fn; return () => {}; }),
      prompt: vi.fn(async () => {
        cb?.({ type: "tool_execution_start", name: "read" }); // turnHadTool → the turn persists
        cb?.({ type: "message_end", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "PING … 0.264 ms" }] } });
        cb?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "gateway ok" }] } });
      }),
    };
    const managed = fakeManaged("s1", brain as any, true);
    mgr.sessions.set("s1", managed);
    mgr.jobs.register({ jobId: "j1", type: "bash", parentSessionId: "s1", description: "ping", status: "completed", startedAt: 0, notified: false, outputFile: "/o" });
    const send = vi.fn(async () => ({ ok: true, id: "x" }));
    mgr.gatewayClient = { sendDelegationPersistenceEvent: send };
    mgr.agentId = "agent-1";
    await mgr.notifyParent("s1", "j1", { taskId: "j1", outputFile: "/o", status: "completed", summary: "done" });
    await flushCoalesce();
    const toolRow = send.mock.calls
      .map((c) => c[0])
      .filter((e: any) => e?.type === "delegation.append_message")
      .find((e: any) => e.message?.role === "tool");
    expect(toolRow).toBeTruthy();
    expect(toolRow.message.outcome).toBe("success"); // terminal → card renders done, NOT a forever-spinner
  });
});

describe("stopSessionJobs (the Stop button halts all of a session's background jobs)", () => {
  it("stops only THIS session's RUNNING jobs (bg exec + bg sub-agents), leaving others alone", () => {
    const mgr = new AgentBoxSessionManager() as any;
    const reg = (jobId: string, parentSessionId: string, status: string, type = "bash") => {
      const abort = vi.fn();
      mgr.jobs.register({ jobId, type, parentSessionId, description: jobId, status, startedAt: 0, notified: false, abort });
      return abort;
    };
    const aRun = reg("a", "s1", "running");             // bg exec, this session, running → stop
    const aSub = reg("sub", "s1", "running", "subagent"); // bg sub-agent, this session, running → stop
    const aDone = reg("done", "s1", "completed");        // already finished → untouched
    const other = reg("b", "s2", "running");             // other session → untouched

    const n = mgr.stopSessionJobs("s1");

    expect(n).toBe(2);
    expect(aRun).toHaveBeenCalledTimes(1);
    expect(aSub).toHaveBeenCalledTimes(1);
    expect(aDone).not.toHaveBeenCalled();
    expect(other).not.toHaveBeenCalled();
    expect(mgr.jobs.get("a").status).toBe("stopped");
    expect(mgr.jobs.get("sub").status).toBe("stopped");
    expect(mgr.jobs.get("b").status).toBe("running"); // other session's job keeps running
  });

  it("returns 0 when the session has no running jobs", () => {
    const mgr = new AgentBoxSessionManager() as any;
    expect(mgr.stopSessionJobs("nope")).toBe(0);
  });

  it("marks user-stopped jobs suppressNotifyTurn so their completion folds the card but does NOT wake the model", async () => {
    const { mgr, brain } = setup(true); // idle parent
    // j1 is registered as running with an abort hook; stopSessionJobs stops it with suppression.
    mgr.jobs.setStatus("j1", "running");
    mgr.jobs.setAbort("j1", vi.fn());
    expect(mgr.stopSessionJobs("s1")).toBe(1);
    expect(mgr.jobs.get("j1").suppressNotifyTurn).toBe(true);

    // The settle path still calls notifyParent (dedup/card-fold), but the synthetic turn is suppressed.
    await mgr.notifyParent("s1", "j1", { taskId: "j1", outputFile: "/o", status: "stopped", summary: "stopped" });
    await flushCoalesce();
    expect(brain.prompt).not.toHaveBeenCalled();   // model is NOT woken to react to its own cancellation
    expect(brain.followUp).not.toHaveBeenCalled();
  });

  it("a NORMAL job_stop (model tool, no suppression) still notifies the parent", async () => {
    const { mgr, brain } = setup(true);
    mgr.jobs.setStatus("j1", "running");
    mgr.jobs.setAbort("j1", vi.fn());
    mgr.jobs.stopJob("j1"); // model's job_stop — no suppressNotifyTurn
    expect(mgr.jobs.get("j1").suppressNotifyTurn).toBeFalsy();
    await mgr.notifyParent("s1", "j1", { taskId: "j1", status: "stopped", summary: "stopped by model" });
    await flushCoalesce();
    expect(brain.prompt).toHaveBeenCalledTimes(1); // model-initiated stop still reacts (unchanged)
  });
});
