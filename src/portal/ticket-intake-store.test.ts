import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, initDb } from "../gateway/db.js";
import { runPortalMigrations } from "./migrate.js";
import { beginTicketIntake, getActiveTicketIntake, transitionTicketIntake, updateTicketIntakeDraft } from "./ticket-intake-store.js";

describe("ticket intake state machine", () => {
  beforeEach(async () => {
    initDb("sqlite::memory:");
    await runPortalMigrations();
    await getDb().query(
      "INSERT INTO chat_sessions (id, agent_id, user_id, origin) VALUES (?, ?, ?, 'channel')",
      ["session-1", "agent-1", "owner-1"],
    );
  });

  afterEach(closeDb);

  it("requires a user-started draft, optimistic revisions, and requester confirmation", async () => {
    const created = await beginTicketIntake(getDb(), {
      session_id: "session-1",
      channel_id: "lark-channel-1",
      requester_external_id: "ou_requester",
      source_message_id: "om_source",
    });
    expect(created.success).toBe(true);
    expect(created.intake?.state).toBe("collecting");
    expect(created.intake?.revision).toBe(1);

    const duplicate = await beginTicketIntake(getDb(), {
      session_id: "session-1", channel_id: "lark-channel-1",
      requester_external_id: "ou_requester", source_message_id: "om_source",
    });
    expect(duplicate.intake?.id).toBe(created.intake?.id);

    const incomplete = await updateTicketIntakeDraft(getDb(), {
      session_id: "session-1", intake_id: created.intake!.id, expected_revision: 1,
      draft: {
        classification: "needs_clarification", summary: "Login fails",
        attempted_actions: [], source_refs: [], open_questions: ["Which tenant?"], ready_for_review: true,
      },
    });
    expect(incomplete).toEqual({ success: true });
    expect((await getActiveTicketIntake(getDb(), { session_id: "session-1", requester_external_id: "ou_requester" })).intake)
      .toMatchObject({ state: "collecting", revision: 2 });

    const stale = await updateTicketIntakeDraft(getDb(), {
      session_id: "session-1", intake_id: created.intake!.id, expected_revision: 1,
      draft: { classification: "incident_candidate", summary: "stale" },
    });
    expect(stale.success).toBe(false);

    const completeDraft = {
      classification: "incident_candidate",
      summary: "Users cannot log in",
      product: "Siclaw",
      category: "Authentication",
      impact: "All users in tenant A",
      affected_object: "tenant A",
      actual_behavior: "Login returns 500",
      expected_behavior: "Login succeeds",
      attempted_actions: ["Retried once"],
      source_refs: ["Feishu message om_source"],
      open_questions: [],
      ready_for_review: true,
    };
    expect(await updateTicketIntakeDraft(getDb(), {
      session_id: "session-1", intake_id: created.intake!.id, expected_revision: 2, draft: completeDraft,
    })).toEqual({ success: true });
    const review = (await getActiveTicketIntake(getDb(), {
      session_id: "session-1", requester_external_id: "ou_requester",
    })).intake!;
    expect(review).toMatchObject({ state: "review", revision: 3, draft: completeDraft });

    const forbidden = await transitionTicketIntake(getDb(), {
      intake_id: review.id, requester_external_id: "ou_someone_else", expected_revision: 3, action: "confirm",
    });
    expect(forbidden.success).toBe(false);

    const confirmed = await transitionTicketIntake(getDb(), {
      intake_id: review.id, requester_external_id: "ou_requester", expected_revision: 3, action: "confirm",
    });
    expect(confirmed.success).toBe(true);
    expect(confirmed.payload).toMatchObject({
      schema_version: "siclaw.ticket_intake.v1",
      intake_id: review.id,
      session_id: "session-1",
      channel: { type: "lark", requester_external_id: "ou_requester", source_message_id: "om_source" },
      draft: completeDraft,
    });
    expect((await getActiveTicketIntake(getDb(), {
      session_id: "session-1", requester_external_id: "ou_requester",
    })).intake).toBeNull();

    const retry = await transitionTicketIntake(getDb(), {
      intake_id: review.id, requester_external_id: "ou_requester", expected_revision: 3, action: "confirm",
    });
    expect(retry.payload).toEqual(confirmed.payload);
  });
});
