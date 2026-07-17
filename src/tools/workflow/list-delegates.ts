/**
 * list_delegates — a COORDINATOR searches which specialist agent covers a target
 * cluster / host / node before delegating. This is the explicit "who covers this
 * resource?" step: the coordinator determines the target (e.g. cluster roce-test,
 * node gpu-01) and queries by it, instead of guessing or reading its OWN
 * cluster_list (which is the coordinator's bindings, not the delegate's coverage).
 *
 * Modeled on host_list: server-agnostic `query` filter + capped, paginated
 * results. The roster (each member's bound clusters/hosts) is already fetched
 * into ToolRefs; matching runs in-box. An agent may be bound to hundreds of
 * hosts, so this NEVER dumps the full binding list into the model context — it
 * matches by target and caps what it renders (counts + matched/sampled names).
 *
 * Coordinator-only: available when a delegation roster is present.
 */

import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { renderTextResult } from "../infra/tool-render.js";
import type { ToolEntry, ToolRefs } from "../../core/tool-registry.js";
import type { DelegateRosterMember } from "../../shared/agent-delegate.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
/** Max binding names rendered per agent per kind — caps context for agents with many hosts. */
const MAX_BINDINGS_SHOWN = 12;

function decodeCursor(c: unknown): number {
  const n = typeof c === "string" ? Number(c) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/** Render one binding kind when SEARCHING: the matched names (capped), with the total count. */
function renderMatched(label: string, all: string[], matched: string[]): string {
  if (all.length === 0) return `${label}: (none)`;
  if (matched.length === 0) return `${label}: no match (${all.length} total)`;
  const shown = matched.slice(0, MAX_BINDINGS_SHOWN);
  const more = matched.length - shown.length;
  return `${label} matched: ${shown.join(", ")}${more > 0 ? ` …(+${more} more)` : ""} (${all.length} total)`;
}

interface Match { m: DelegateRosterMember; mc: string[]; mh: string[]; }

function matchRoster(roster: DelegateRosterMember[], q: string): Match[] {
  const out: Match[] = [];
  for (const m of roster) {
    if (!q) { out.push({ m, mc: [], mh: [] }); continue; }
    const mc = m.clusters.filter((s) => s.toLowerCase().includes(q));
    const mh = m.hosts.filter((s) => s.toLowerCase().includes(q));
    const nameHit = m.name.toLowerCase().includes(q) || (m.description ?? "").toLowerCase().includes(q);
    if (nameHit || mc.length > 0 || mh.length > 0) out.push({ m, mc, mh });
  }
  return out;
}

export function createListDelegatesTool(refs: ToolRefs): ToolDefinition {
  return {
    name: "list_delegates",
    label: "List Delegates",
    renderCall: (_a, theme) => new Text(theme.fg("toolTitle", theme.bold("list_delegates")), 0, 0),
    renderResult: renderTextResult,
    description:
      "Find which specialist agent you may delegate to covers a target resource. Pass `query` with a cluster " +
      "name, host name, or node name (matched against each delegate's bound clusters/hosts, plus their " +
      "name/description) to see WHICH agent covers it — then delegate to that one. Omit `query` to browse " +
      "(counts + a sample of bindings; agents may be bound to many hosts, so the full list is never dumped — " +
      "search by the target instead). Results are capped; use `cursor` to page.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({
        description: "Target cluster / host / node name (substring, case-insensitive). Omit to browse all delegates.",
      })),
      limit: Type.Optional(Type.Number({ description: "Max delegates per page (default 20, max 100)." })),
      cursor: Type.Optional(Type.String({ description: "Opaque pagination cursor from a previous response's next_cursor." })),
    }),
    async execute(_toolCallId, rawParams) {
      const roster = refs.delegationRoster ?? [];
      if (roster.length === 0) {
        return { content: [{ type: "text" as const, text: "You have no delegate agents configured." }], details: {} };
      }
      const params = (rawParams ?? {}) as { query?: string; limit?: number; cursor?: string };
      const rawQuery = typeof params.query === "string" ? params.query.trim() : "";
      const q = rawQuery.toLowerCase();
      const limit = Math.min(Math.max(1, Math.floor(params.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
      const offset = decodeCursor(params.cursor);

      const matched = matchRoster(roster, q);
      const total = matched.length;
      const page = matched.slice(offset, offset + limit);
      const lines = page.map(({ m, mc, mh }) => {
        const desc = m.description ? ` — ${m.description}` : "";
        // Browse (no query): ONE line per agent — counts only, never the binding
        // names (an agent may cover hundreds of hosts). Search by target instead.
        if (!q) {
          return `- ${m.name} [id: ${m.id}]${desc} (clusters: ${m.clusters.length}, hosts: ${m.hosts.length})`;
        }
        // Query: show which bindings matched the target.
        return `- ${m.name} [id: ${m.id}]${desc}\n    ${renderMatched("clusters", m.clusters, mc)}\n    ${renderMatched("hosts", m.hosts, mh)}`;
      });

      const nextOffset = offset + page.length;
      const hasMore = nextOffset < total;
      let hint = "";
      if (total === 0) {
        hint = `\n\nNo delegate agent covers "${rawQuery}". Do not delegate — tell the user no authorized agent covers that resource.`;
      } else if (hasMore) {
        hint = `\n\nShowing ${page.length} of ${total}. Refine the query, or pass cursor="${nextOffset}" for the next page.`;
      }
      const header = q
        ? `Delegate agents matching "${rawQuery}":`
        : "Your delegate agents (counts only — pass query=<cluster/host/node> to find who covers a target):";
      const body = lines.length ? `${header}\n${lines.join("\n")}` : header;
      return {
        content: [{ type: "text" as const, text: `${body}${hint}` }],
        details: { total, shown: page.length, ...(hasMore ? { next_cursor: String(nextOffset) } : {}) },
      };
    },
  };
}

export const registration: ToolEntry = {
  category: "workflow",
  create: createListDelegatesTool,
  available: (refs) => (refs.delegationRoster?.length ?? 0) > 0 && !refs.delegation,
};
