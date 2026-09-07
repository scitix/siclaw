import { describe, expect, it } from "vitest";

import {
  CHAT_MESSAGE_KINDS,
  SYNTHETIC_USER_KINDS,
  type ChatMessageKind,
} from "./message-kinds.js";

describe("CHAT_MESSAGE_KINDS", () => {
  // Pinned as an exact list. Every value here is written by this runtime and
  // read by the frontend and by sicore; a kind joining or leaving changes what
  // those readers see. Two of these were found by the compiler rather than by
  // the author when metadata.kind was first narrowed to this union, which is
  // the argument for keeping the list explicit instead of inferred.
  it("is the registered set", () => {
    expect([...CHAT_MESSAGE_KINDS]).toEqual([
      "delegation_event",
      "error_response",
      "exec_job_event",
      "model_route_notice",
      "steer",
      "task_event",
      "task_notification",
      "thinking",
    ]);
  });
});

describe("SYNTHETIC_USER_KINDS", () => {
  // No cross-repo parity is asserted, deliberately: sicore counts prompts with
  // no kind filter at all, and the sets it does have answer adjacent questions
  // (a trace's title, feedback attribution). An earlier version of this test
  // named a sicore symbol that does not exist. See the file header.
  it("is the agreed set", () => {
    expect([...SYNTHETIC_USER_KINDS]).toEqual([
      "delegation_event",
      "exec_job_event",
      "task_event",
      "task_notification",
    ]);
  });

  it("includes task_event, the largest category by far", () => {
    // Called out on its own because leaving it out was the actual defect: with
    // only delegation_event filtered, the ledger rows an agent writes while
    // working were all counted as questions somebody asked.
    expect(SYNTHETIC_USER_KINDS).toContain("task_event");
  });

  it("excludes steer — a person typing mid-turn is a person asking", () => {
    // The `steer` tag says WHEN a message was sent, not who wrote it. Reading
    // it as plumbing would undercount exactly the users who interact most.
    expect(SYNTHETIC_USER_KINDS).not.toContain("steer");
  });

  it("excludes the kinds that ride assistant rows", () => {
    expect(SYNTHETIC_USER_KINDS).not.toContain("error_response");
    expect(SYNTHETIC_USER_KINDS).not.toContain("model_route_notice");
  });

  it("is a subset of the registered kinds", () => {
    // Also enforced at compile time by `satisfies readonly ChatMessageKind[]`;
    // asserted here because `npm test` does not run tsc.
    const registered = new Set<ChatMessageKind>(CHAT_MESSAGE_KINDS);
    for (const kind of SYNTHETIC_USER_KINDS) expect(registered.has(kind)).toBe(true);
  });
});
