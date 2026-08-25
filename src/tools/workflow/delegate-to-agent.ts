/**
 * delegate_to_agent — a COORDINATOR agent delegates a bounded task to a PEER agent
 * (its own box, reached over the gateway) and gets the peer's structured artifact
 * back (design agent-delegation.md §3).
 *
 * The peer is resolved from the coordinator's roster (refs.delegationRoster);
 * membership IS the authorization, and the gateway re-validates it. The tool's
 * DESCRIPTION lists the roster (name + id + purpose + bound resources) so the
 * model knows who does what (§5 manifest). The cross-box call runs through
 * refs.delegateToAgentExecutor (gateway-mediated); the peer runs under its OWN
 * capabilities and persona (delegation does not force read-only).
 *
 * Exposed ONLY on a coordinator (non-empty roster + executor) and NOT on a
 * delegated turn (refs.delegation set) — one-level delegation (§2).
 *
 * Rendering: the tool call is named `delegate_to_agent`, which portal-web
 * renders as the "Expert collaboration" AgentWorkCard. To populate that card we
 * mirror its expected shape: the target from args (`agent_id` / `agent_name`)
 * and the outcome from the result `details` (`status` / `summary` / `tool_calls`).
 */

import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { renderTextResult } from "../infra/tool-render.js";
import type { ToolEntry, ToolRefs } from "../../core/tool-registry.js";
import type { DelegateRosterMember, DelegateResponse } from "../../shared/agent-delegate.js";
import { DELEGATION_RESULT_SCHEMA_VERSION } from "../../shared/agent-delegate.js";

interface DelegateParams {
  agent_id?: string;
  agent_name?: string;
  task?: string;
  session_id?: string;
  request_context?: unknown;
}

function rosterLine(m: DelegateRosterMember): string {
  // Counts only — never the binding names. An agent may cover hundreds of hosts;
  // dumping them here would bloat every turn (this text is resident tool context).
  // The coordinator resolves coverage on demand via list_delegates(query=…).
  const desc = m.description ? ` — ${m.description}` : "";
  return `- ${m.name} [id: ${m.id}]${desc} (covers ${m.clusters.length} clusters / ${m.hosts.length} hosts)`;
}

/** Resolve the model-supplied agent_id (accepts an id OR a name) to a member. */
function resolveTarget(roster: DelegateRosterMember[], idOrName: string): DelegateRosterMember | undefined {
  const t = idOrName.trim().toLowerCase();
  return roster.find((m) => m.id.toLowerCase() === t) ?? roster.find((m) => m.name.toLowerCase() === t);
}

/**
 * The result's state, in the MODEL-VISIBLE text.
 *
 * ⚠️ `details` DOES NOT REACH THE MODEL — it is stripped before a tool result is shown (see the
 * exit-classification contract in CLAUDE.md, which states the same rule for a different field:
 * "the class must be in the TEXT"). So the v1 fields sitting in `details` serve the card and the
 * analysis layer, and the coordinator — the reader this contract exists for — could not see them
 * at all. C1's entire purpose is letting a coordinator tell a plan from a finished result, and that
 * decision is made by the model, from the text.
 *
 * Written as one short line rather than a dump: it has to compete for attention with the findings
 * themselves, and a paragraph of metadata would be skimmed. `unknown` is spelled out with its
 * consequence attached, because that is the case the coordinator has been getting wrong.
 */
function statusLine(resp: DelegateResponse): string {
  if (resp.task_status === undefined) return "";
  switch (resp.task_status) {
    case "complete":
      return "[Task status: COMPLETE — the peer reported this as finished.]\n";
    case "partial":
      return "[Task status: PARTIAL — the peer reported findings but says work remains. " +
        "See residual state before treating this as done.]\n";
    case "blocked":
      return "[Task status: BLOCKED — the peer is waiting on the user. Relay its question; " +
        "do not answer on the user's behalf.]\n";
    case "unknown":
      return "[Task status: UNKNOWN — the peer ended its turn WITHOUT reporting a result, so this " +
        "text is narration, not findings. It may be a plan rather than an answer.]\n";
  }
}

export function createDelegateToAgentTool(refs: ToolRefs): ToolDefinition {
  const roster = refs.delegationRoster ?? [];
  const rosterMd = roster.map(rosterLine).join("\n");
  return {
    name: "delegate_to_agent",
    label: "Delegate to Agent",
    renderCall: (_a, theme) => new Text(theme.fg("toolTitle", theme.bold("delegate_to_agent")), 0, 0),
    renderResult: renderTextResult,
    // The first two sentences are a statement of FACT about this call's semantics, not advice, and
    // they are here rather than in a prompt because a tool description is the one channel prompt
    // customization cannot bypass. Both were added because a coordinator read a plan-shaped return
    // as "the peer is still working" and waited, then re-delegated the same question twice.
    // Do not soften them into "returns the peer's findings": what comes back may be narration, and
    // saying otherwise is what produced the misreading. See
    // docs/design/2026-08-25-coordinator-prompt-proposal.md (Proposal 1).
    description:
      "Delegate a bounded task to one of your specialist agents. This call is SYNCHRONOUS: it returns when the " +
      "peer's turn ends — the peer is not still working in the background afterwards. You get the peer's " +
      "structured findings when it reported them, otherwise its narration from that turn. A long result may " +
      "reach you shortened; the complete record stays in the peer's own session. Narration that describes a plan is " +
      "not a result. The peer runs the " +
      "task in its OWN environment under its own capabilities and persona (you don't constrain it) — you keep " +
      "oversight. Use this when a task belongs to a peer's domain/resources rather than your " +
      "own. Pass the target's `agent_id` (the [id: …] value below) and `agent_name`. " +
      "First use list_delegates(query=<target cluster/host/node>) to confirm WHICH agent covers the target " +
      "(the coverage is not listed here — only counts). To continue an earlier line of work with the SAME " +
      "specialist, pass the `session_id` that a prior delegation returned (the peer keeps its context); omit " +
      "it to start a fresh session for an unrelated task.\n\n" +
      "Agents you may delegate to:\n" + (rosterMd || "(none)"),
    parameters: Type.Object({
      agent_id: Type.String({ description: "The id of the agent to delegate to — the [id: …] value from the list above." }),
      agent_name: Type.Optional(Type.String({ description: "That agent's name (for display; from the list above)." })),
      task: Type.String({ minLength: 1, description: "The bounded task / question for that agent. Be specific about the target resource." }),
      session_id: Type.Optional(Type.String({ description: "Continue a prior peer session (the session_id a previous delegation to this agent returned) so the peer retains context. Omit to start fresh." })),
      // Structured context, in ADDITION to `task` — never instead of it. The two carry different
      // things: `task` is the goal in the user's words, this is what can be checked (targets are
      // verified against the peer's bindings) and what the specialist cannot obtain any other way
      // (the user's own constraints). Optional, so an older caller is unaffected.
      request_context: Type.Optional(Type.Object({
        schema_version: Type.Number({ description: "1" }),
        mode: Type.Union([Type.Literal("snapshot"), Type.Literal("delta")], {
          description:
            "\"snapshot\" = the whole context (required on a first delegation). \"delta\" = only what " +
            "CHANGED since this peer session's last turn — the peer still holds the rest, and " +
            "re-sending everything pollutes a context that is already correct.",
        }),
        scope: Type.Optional(Type.Union(
          [Type.Literal("exact"), Type.Literal("all_peer_bindings"), Type.Literal("discovery")],
          {
            description:
              "\"exact\" = you know the targets (send them). \"all_peer_bindings\" = check everything " +
              "this specialist covers (send NO targets). \"discovery\" = the target is not known yet " +
              "(send NO targets; a guess is a candidate and goes in observations). In delta mode, " +
              "scope and targets are sent together or not at all.",
          },
        )),
        targets: Type.Optional(Type.Array(Type.Object({}, { additionalProperties: true }), {
          description:
            "CONFIRMED routing identity, never a guess: {type:\"cluster\", cluster_binding} | " +
            "{type:\"host\", host} | {type:\"k8s_resource\", cluster_binding, kind, name, namespace?}. " +
            "Canonical binding names only — no aliases. An IP is not a target; it goes in observations.",
        })),
        constraints: Type.Optional(Type.Object({
          time_window: Type.Optional(Type.Object({
            from: Type.Optional(Type.String()), to: Type.Optional(Type.String()), timezone: Type.Optional(Type.String()),
          }, { description: "The window the user asked about." })),
          user_requirements: Type.Optional(Type.Array(Type.String(), {
            description:
              "The user's own words. Especially the NEGATIVE ones — \"don't restart anything\", \"if " +
              "you can't find it say so rather than guessing\" — and anything you were told not to do. " +
              "These are what the specialist cannot obtain any other way.",
          })),
        }, { additionalProperties: false })),
        observations: Type.Optional(Type.Array(Type.Object({
          text: Type.String(),
          source: Type.Union([
            Type.Literal("user"), Type.Literal("peer_report"),
            Type.Literal("knowledge_base"), Type.Literal("coordinator_tool"),
          ], { description: "Where this came from. Required — it is what keeps a candidate from being read as a fact." }),
          observed_at: Type.Optional(Type.String()),
          session_id: Type.Optional(Type.String({ description: "For source=peer_report: the peer session it came from." })),
        }, { additionalProperties: false }), {
          description:
            "LEADS, not facts. You do no hands-on work, so anything you hold about live state is " +
            "second-hand or already stale; the specialist re-checks whatever it relies on. Put " +
            "candidate cluster names here, not in targets.",
        })),
        execution_policy: Type.Optional(Type.Object({
          access_mode: Type.Optional(Type.Union([Type.Literal("read_only"), Type.Literal("normal")], {
            description:
              "Set \"read_only\" ONLY when the user asked for a read-only investigation. It is " +
              "ENFORCED: the specialist loses every write, exec and script tool, so it cannot " +
              "remediate anything — if the user might want a fix applied, leave this alone. " +
              "Omitted means normal.",
          })),
        }, { additionalProperties: false })),
      }, { additionalProperties: false })),
    }),
    async execute(toolCallId, rawParams, signal) {
      const params = rawParams as DelegateParams;
      const idOrName = (params.agent_id || params.agent_name || "").trim();
      const task = params.task?.trim() ?? "";
      if (!refs.delegateToAgentExecutor || roster.length === 0) {
        return { content: [{ type: "text" as const, text: "delegate_to_agent is not available (no delegation roster configured)." }], details: { status: "failed" } };
      }
      if (!idOrName || !task) {
        return { content: [{ type: "text" as const, text: "delegate_to_agent requires `agent_id` (or `agent_name`) and `task`." }], details: { status: "failed" } };
      }
      const member = resolveTarget(roster, idOrName);
      if (!member) {
        return {
          content: [{ type: "text" as const, text: `"${idOrName}" is not one of your delegatable agents. Available: ${roster.map((m) => `${m.name} [${m.id}]`).join(", ")}.` }],
          details: { status: "failed" },
        };
      }

      // Live-stream the peer's steps into THIS tool call's card: emit
      // tool_execution_update as the peer works. The frontend merges
      // partialResult.details into the tool card (AgentWorkCard/SubagentSteps
      // render details.steps live) — same path spawn_subagent uses.
      let lastSteps: unknown[] = [];
      let liveChildSessionId: string | undefined;
      const onProgress = (p: { toolCalls: number; steps: unknown[]; activity?: string; childSessionId?: string }) => {
        lastSteps = p.steps;
        if (p.childSessionId) liveChildSessionId = p.childSessionId;
        refs.sessionEventEmitter?.({
          type: "tool_execution_update",
          toolCallId,
          partialResult: {
            content: p.activity ? [{ type: "text", text: p.activity }] : [],
            // child_session_id surfaced live (known at start) → the card's
            // "open full session" affordance appears while the peer is still running.
            details: { status: "running", agent_id: member.id, agent_name: member.name, toolCalls: p.toolCalls, steps: p.steps, ...(liveChildSessionId ? { child_session_id: liveChildSessionId } : {}) },
          },
        });
      };
      const continueSessionId = params.session_id?.trim() || undefined;
      // toolCallId travels with the request so the peer's turn can nest under THIS tool span and be
      // correlated with THIS tool row — a coordinator may have several delegations in flight.
      const resp = await refs.delegateToAgentExecutor({ peerAgentId: member.id, text: task, peerSessionId: continueSessionId, toolCallId, requestContext: params.request_context }, onProgress, signal)
        // The executor threw rather than answering, so there is no wire result to copy — this
        // synthesizes one. It carries the v1 fields too: a card that shows nothing for a transport
        // failure is the same blind spot as a card that shows nothing for a plan-only turn.
        .catch((err): DelegateResponse => ({
          schema_version: DELEGATION_RESULT_SCHEMA_VERSION,
          turn_status: "failed", task_status: "unknown", payload_kind: "none",
          ok: false, peerAgentId: member.id, peerName: member.name, status: "failed" as const,
          steps: [], peerSessionId: undefined, error: err instanceof Error ? err.message : String(err),
        }));

      // The v1 result contract, copied onto the TOOL's details.
      //
      // This is not duplication for its own sake: the gateway's HTTP response and the tool's
      // `details` are two different readers. The chat card renders from `details`, so fields that
      // exist only on the response are invisible to it — the contract would be implemented and
      // unreadable at the same time, which is how "landed" and "in effect" come apart.
      //
      // Copied verbatim rather than re-derived. Re-deriving would put a second implementation of
      // task_status here, and a card disagreeing with the wire about whether a task completed is
      // worse than a card that shows nothing.
      const v1 = {
        ...(resp.schema_version !== undefined ? { schema_version: resp.schema_version } : {}),
        ...(resp.turn_status ? { turn_status: resp.turn_status } : {}),
        ...(resp.task_status ? { task_status: resp.task_status } : {}),
        ...(resp.payload_kind ? { payload_kind: resp.payload_kind } : {}),
        ...(resp.next_action ? { next_action: resp.next_action } : {}),
        ...(resp.truncation ? { truncation: resp.truncation } : {}),
      };
      const cardBase = { agent_id: member.id, agent_name: member.name, tool_calls: resp.steps?.length ?? 0, steps: lastSteps, ...v1, ...(resp.peerSessionId ? { child_session_id: resp.peerSessionId } : {}) };

      // Stopped by the coordinator (turn aborted): the relay was torn down and
      // the peer turn cancelled. Report a clean stop, not a scary error.
      //
      // Uses cardBase like every other exit. It used to hand-roll its own details object here, and
      // that copy carried turn_status/task_status WITHOUT schema_version — which by this contract's
      // own rule (absent version = pre-v1 producer) makes both fields invisible to a v1 reader.
      // Harmless while legacy `status: "stopped"` carries the meaning, but it was a duplicate of
      // cardBase placed before cardBase existed, and duplicates of that shape drift. This work
      // already hit "two paths that were supposed to carry the same fields" once.
      if (signal?.aborted) {
        const msg = `Delegation to ${member.name} was stopped.`;
        return { content: [{ type: "text" as const, text: msg }], details: { ...cardBase, status: "stopped", summary: msg } };
      }

      // Card-facing shape (portal-web AgentWorkCard reads target from args and
      // status/summary/tool_calls/steps from result details). Carry the accumulated
      // live steps into the FINAL result so the card keeps them after completion.
      // session_id (=peer session) lets the card OPEN the full peer session and lets
      // the model pass it back to continue this peer thread.

      if (!resp.ok || resp.status === "failed") {
        const msg = `Delegation to ${member.name} failed: ${resp.error ?? "unknown error"}`;
        return { content: [{ type: "text" as const, text: msg }], details: { ...cardBase, status: "failed", summary: msg } };
      }

      // The peer needs a human clarification (it called request_input and ended its
      // turn). Relay the question to the user; when they answer, delegate AGAIN with
      // session_id=<peerSessionId> so the peer resumes from its retained context.
      if (resp.status === "input_required") {
        const q = resp.inputQuestion?.trim() || "(the specialist asked for input but gave no question)";
        const cont = resp.peerSessionId
          ? ` Once the user answers, delegate to ${member.name} again with session_id="${resp.peerSessionId}" and their answer as the task.`
          : "";
        const text = `${member.name} needs a clarification before it can continue:\n\n${q}\n\nRelay this question to the user and wait for their answer — do NOT guess.${cont}`;
        return { content: [{ type: "text" as const, text }], details: { ...cardBase, status: "input_required", summary: q } };
      }
      const a = resp.artifact;
      const summary = a ? a.findings : (resp.finalText ?? "(no structured findings returned)");
      const full = a
        ? `Findings: ${a.findings}\nActions taken: ${a.actions_taken}\nResidual state: ${a.residual_state}`
        : summary;
      // Surface the peer session id in the TEXT (not just details) so the model can
      // pass it back as session_id to continue this peer thread on a follow-up.
      const cont = resp.peerSessionId ? `\n\n(To continue with ${member.name}, delegate again with session_id="${resp.peerSessionId}".)` : "";
      return {
        content: [{ type: "text" as const, text: `Result from ${member.name}:\n${statusLine(resp)}${full}${cont}` }],
        details: { ...cardBase, status: "done", summary, full_summary: full },
      };
    },
  };
}

export const registration: ToolEntry = {
  category: "workflow",
  create: createDelegateToAgentTool,
  // Coordinator-only: needs a roster + the executor, and must NOT itself be a
  // delegated turn (one-level recursion guard — a peer can't re-delegate).
  available: (refs) =>
    Boolean(refs.delegateToAgentExecutor && (refs.delegationRoster?.length ?? 0) > 0 && !refs.delegation),
  requiresUserApproval: false,
};
