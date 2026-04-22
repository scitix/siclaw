import { describe, it, expect } from "vitest";
import {
  createDpState,
  syncChecklistFromStatus,
  createChecklist,
  applyPhaseToChecklist,
  parsePhaseNum,
  buildActivationMessage,
  createProposeHypothesesTool,
  createEndInvestigationTool,
  type DpState,
} from "./dp-tools.js";

describe("createDpState", () => {
  it("initializes idle with no checklist", () => {
    const s = createDpState();
    expect(s.status).toBe("idle");
    expect(s.checklist).toBeNull();
    expect(s.round).toBe(0);
  });
});

describe("createChecklist", () => {
  it("creates 4-item checklist in pending state", () => {
    const cl = createChecklist("why?");
    expect(cl.question).toBe("why?");
    expect(cl.items).toHaveLength(4);
    expect(cl.items.map(i => i.id)).toEqual(["triage", "hypotheses", "deep_search", "conclusion"]);
    expect(cl.items.every(i => i.status === "pending")).toBe(true);
  });
});

describe("syncChecklistFromStatus", () => {
  function state(status: DpState["status"]): DpState {
    const s = createDpState();
    s.checklist = createChecklist("q");
    s.status = status;
    return s;
  }

  it("no-op when no checklist", () => {
    const s = createDpState();
    expect(() => syncChecklistFromStatus(s)).not.toThrow();
  });

  it("idle → all pending", () => {
    const s = state("idle");
    syncChecklistFromStatus(s);
    expect(s.checklist!.items.map(i => i.status)).toEqual(["pending","pending","pending","pending"]);
  });

  it("investigating → triage in_progress, rest pending", () => {
    const s = state("investigating");
    syncChecklistFromStatus(s);
    expect(s.checklist!.items.map(i => i.status)).toEqual(["in_progress","pending","pending","pending"]);
  });

  it("awaiting_confirmation → triage done, hypotheses in_progress", () => {
    const s = state("awaiting_confirmation");
    syncChecklistFromStatus(s);
    expect(s.checklist!.items.map(i => i.status)).toEqual(["done","in_progress","pending","pending"]);
  });

  it("validating → deep_search in_progress", () => {
    const s = state("validating");
    syncChecklistFromStatus(s);
    expect(s.checklist!.items.map(i => i.status)).toEqual(["done","done","in_progress","pending"]);
  });

  it("concluding → marks deep_search skipped if never ran", () => {
    const s = state("concluding");
    syncChecklistFromStatus(s);
    // items[2] starts pending; concluding treats pending as skipped
    expect(s.checklist!.items[2].status).toBe("skipped");
    expect(s.checklist!.items[3].status).toBe("in_progress");
  });

  it("concluding preserves in_progress→done for deep_search", () => {
    const s = state("validating");
    syncChecklistFromStatus(s);
    s.status = "concluding";
    syncChecklistFromStatus(s);
    expect(s.checklist!.items[2].status).toBe("done");
  });

  it("completed preserves deep_search skipped vs done", () => {
    const s = state("concluding");
    syncChecklistFromStatus(s);
    s.status = "completed";
    syncChecklistFromStatus(s);
    expect(s.checklist!.items[2].status).toBe("skipped");
    expect(s.checklist!.items[3].status).toBe("done");
  });

  it("supports regression (awaiting_confirmation → investigating)", () => {
    const s = state("awaiting_confirmation");
    syncChecklistFromStatus(s);
    s.status = "investigating";
    syncChecklistFromStatus(s);
    expect(s.checklist!.items[0].status).toBe("in_progress");
    expect(s.checklist!.items[1].status).toBe("pending");
  });
});

describe("applyPhaseToChecklist", () => {
  it("marks items 1..N-1 done and item N in_progress", () => {
    const cl = createChecklist("q");
    applyPhaseToChecklist(cl.items, 3);
    expect(cl.items[0].status).toBe("done");
    expect(cl.items[1].status).toBe("done");
    expect(cl.items[2].status).toBe("in_progress");
    expect(cl.items[3].status).toBe("pending");
  });

  it("forward-only: does not regress done/skipped", () => {
    const cl = createChecklist("q");
    cl.items[0].status = "skipped";
    cl.items[2].status = "done"; // already done
    applyPhaseToChecklist(cl.items, 3);
    expect(cl.items[0].status).toBe("skipped");
    expect(cl.items[2].status).toBe("done");
  });
});

describe("parsePhaseNum", () => {
  it("parses Phase 3/4", () => {
    expect(parsePhaseNum("Phase 3/4")).toBe(3);
  });
  it("returns 0 on unparseable string", () => {
    expect(parsePhaseNum("no phase")).toBe(0);
  });
  it("parses leading number", () => {
    expect(parsePhaseNum("2nd phase")).toBe(2);
  });
});

describe("buildActivationMessage", () => {
  it("includes the question", () => {
    const msg = buildActivationMessage("why crashed?");
    expect(msg).toContain("[DEEP_INVESTIGATION]");
    expect(msg).toContain("why crashed?");
    expect(msg).toContain("begin the investigation");
  });
});

describe("createProposeHypothesesTool", () => {
  it("has expected shape", () => {
    const dp = createDpState();
    const tool = createProposeHypothesesTool(dp);
    expect(tool.name).toBe("propose_hypotheses");
    expect(tool.label).toBe("Propose Hypotheses");
  });

  it("filters out pipe-table rows and meta 'hypothesis summary' items", async () => {
    const dp = createDpState();
    dp.status = "investigating";
    dp.checklist = createChecklist("q");
    const tool = createProposeHypothesesTool(dp);
    await tool.execute("id", {
      hypotheses: [
        { id: "H1", text: "Actual hypothesis about MTU", confidence: 80 },
        { id: "H2", text: "| id | text | confidence |", confidence: 10 },
        { id: "H3", text: "Proposed Hypotheses Summary", confidence: 0 },
      ],
    });
    expect(dp.hypothesesDraft).toHaveLength(1);
    expect(dp.hypothesesDraft![0].id).toBe("H1");
  });

  it("transitions to awaiting_confirmation in DP mode", async () => {
    const dp = createDpState();
    dp.status = "investigating";
    dp.checklist = createChecklist("q");
    const tool = createProposeHypothesesTool(dp);
    const res = await tool.execute("id", {
      hypotheses: [{ id: "H1", text: "MTU mismatch", confidence: 80 }],
      triageContext: "pod X in ns Y is crashing",
    });
    expect(dp.status).toBe("awaiting_confirmation");
    expect(dp.triageContextDraft).toBe("pod X in ns Y is crashing");
    expect(dp.round).toBe(1);
    expect(res.content[0].text).toContain("wait for the user");
  });

  it("does NOT modify state when not in DP mode", async () => {
    const dp = createDpState(); // status=idle
    const tool = createProposeHypothesesTool(dp);
    await tool.execute("id", {
      hypotheses: [{ id: "H1", text: "MTU mismatch", confidence: 80 }],
    });
    expect(dp.status).toBe("idle");
    expect(dp.hypothesesDraft).toBeUndefined();
  });

  it("increments round counter on each call", async () => {
    const dp = createDpState();
    dp.status = "investigating";
    dp.checklist = createChecklist("q");
    const tool = createProposeHypothesesTool(dp);
    await tool.execute("id", { hypotheses: [{ id: "H1", text: "one real", confidence: 80 }] });
    await tool.execute("id", { hypotheses: [{ id: "H1", text: "one real", confidence: 80 }] });
    expect(dp.round).toBe(2);
  });
});

describe("createEndInvestigationTool", () => {
  it("returns no-op message when idle", async () => {
    const dp = createDpState();
    const tool = createEndInvestigationTool(dp);
    const res = await tool.execute("id", { reason: "nothing to do" });
    expect(res.content[0].text).toContain("No investigation in progress");
    expect(dp.status).toBe("idle");
  });

  it("marks pending/in_progress items as skipped and sets status completed", async () => {
    const dp = createDpState();
    dp.status = "investigating";
    dp.checklist = createChecklist("q");
    dp.checklist.items[0].status = "in_progress";
    const tool = createEndInvestigationTool(dp);
    const res = await tool.execute("id", { reason: "user asked to stop" });
    expect(dp.status).toBe("completed");
    expect(dp.checklist.items.every(i => i.status === "skipped")).toBe(true);
    expect(dp.checklist.items[0].summary).toBe("user asked to stop");
    expect(res.content[0].text).toContain("Investigation ended");
  });
});
