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
import type { DelegateRosterMember } from "../../shared/agent-delegate.js";

interface DelegateParams {
  agent_id?: string;
  agent_name?: string;
  task?: string;
  session_id?: string;
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

export function createDelegateToAgentTool(refs: ToolRefs): ToolDefinition {
  const roster = refs.delegationRoster ?? [];
  const rosterMd = roster.map(rosterLine).join("\n");
  return {
    name: "delegate_to_agent",
    label: "Delegate to Agent",
    renderCall: (_a, theme) => new Text(theme.fg("toolTitle", theme.bold("delegate_to_agent")), 0, 0),
    renderResult: renderTextResult,
    description:
      "Delegate a bounded task to one of your specialist agents and get back its findings. The peer runs the " +
      "task in its OWN environment under its own capabilities and persona (you don't constrain it) and reports " +
      "back — you keep oversight. Use this when a task belongs to a peer's domain/resources rather than your " +
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
      const resp = await refs.delegateToAgentExecutor({ peerAgentId: member.id, text: task, peerSessionId: continueSessionId }, onProgress, signal)
        .catch((err) => ({ ok: false, peerAgentId: member.id, peerName: member.name, status: "failed" as const, steps: [], peerSessionId: undefined as string | undefined, error: err instanceof Error ? err.message : String(err) }));

      // Stopped by the coordinator (turn aborted): the relay was torn down and
      // the peer turn cancelled. Report a clean stop, not a scary error.
      if (signal?.aborted) {
        const msg = `Delegation to ${member.name} was stopped.`;
        return { content: [{ type: "text" as const, text: msg }], details: { agent_id: member.id, agent_name: member.name, tool_calls: resp.steps?.length ?? 0, steps: lastSteps, status: "stopped", summary: msg, ...(resp.peerSessionId ? { child_session_id: resp.peerSessionId } : {}) } };
      }

      // Card-facing shape (portal-web AgentWorkCard reads target from args and
      // status/summary/tool_calls/steps from result details). Carry the accumulated
      // live steps into the FINAL result so the card keeps them after completion.
      // session_id (=peer session) lets the card OPEN the full peer session and lets
      // the model pass it back to continue this peer thread.
      const cardBase = { agent_id: member.id, agent_name: member.name, tool_calls: resp.steps?.length ?? 0, steps: lastSteps, ...(resp.peerSessionId ? { child_session_id: resp.peerSessionId } : {}) };

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
        content: [{ type: "text" as const, text: `Result from ${member.name}:\n${full}${cont}` }],
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
