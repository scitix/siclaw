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

interface Match {
  m: DelegateRosterMember;
  mc: string[];
  mh: string[];
}

function matchRoster(roster: DelegateRosterMember[], q: string): Match[] {
  const out: Match[] = [];
  for (const m of roster) {
    if (!q) {
      out.push({ m, mc: [], mh: [] });
      continue;
    }
    // Coverage is an authorization decision, so only an exact resource binding
    // proves that a delegate covers the target. Agent names/descriptions and
    // partial binding matches are discovery hints, not coverage evidence.
    const mc = m.clusters.filter((s) => s.trim().toLowerCase() === q);
    const mh = m.hosts.filter((s) => s.trim().toLowerCase() === q);
    if (mc.length > 0 || mh.length > 0) out.push({ m, mc, mh });
  }
  return out;
}

export function createListDelegatesTool(refs: ToolRefs): ToolDefinition {
  // The retry state is tool-owned (one per agent session), not caller-owned.
  // `closed` matters because clearing the token after a terminal miss without
  // remembering that terminal state lets a later hit bypass the retry bound.
  type RetryPhase = "idle" | "offered" | "closed";
  let retryPhase: RetryPhase = "idle";
  // The one outstanding retry offer, as an opaque single-use token.
  //
  // Neither `binding_name_confirmed` nor remembering the missed query string can
  // bound the retries. The flag is caller-supplied. And a per-string memory only
  // catches a repeat of the SAME string, while the real alias flow changes it —
  // `local-alias` misses, the helper resolves it, and `canonical-name` is a
  // different key, so an omitted flag would earn a second retry offer. Both holes
  // are the same shape: the caller decides whether the retry has been used.
  //
  // The token closes them because the tool owns it: a miss issues one, the retry
  // must present it, presenting it consumes it, and while one is outstanding a
  // further miss is terminal. A terminal outcome closes the current turn so a
  // later hit cannot bypass the bound.
  let pendingRetryToken: string | null = null;
  // The turn the current retry state belongs to. An offer the model never spent —
  // e.g. it was told to consult a helper, none was attached, so it correctly
  // answered the user instead — must not survive into the next question and make
  // that question's first miss look terminal.
  let retryTurn = -1;
  return {
    name: "list_delegates",
    label: "List Delegates",
    renderCall: (_a, theme) => new Text(theme.fg("toolTitle", theme.bold("list_delegates")), 0, 0),
    renderResult: renderTextResult,
    description:
      "Find which specialist agent you may delegate to covers a target resource. Pass `query` with a cluster " +
      "name, host name, or node name. Coverage requires an exact, case-insensitive match against a delegate's " +
      "bound clusters/hosts; agent names, descriptions, and partial resource names never prove coverage. " +
      "Omit `query` to browse " +
      "(counts + a sample of bindings; agents may be bound to many hosts, so the full list is never dumped — " +
      "search by the target instead). Results are capped; use `cursor` to page.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({
        description: "Exact target cluster / host / node binding name (case-insensitive). Omit to browse all delegates.",
      })),
      binding_name_confirmed: Type.Optional(Type.Boolean({
        description:
          "Set true only when `query` is a canonical Siclaw binding name confirmed by an attached routing helper.",
      })),
      retry_token: Type.Optional(Type.String({
        description:
          "The retry_token handed back by a previous empty result. Required to spend that one retry; it is single-use.",
      })),
      limit: Type.Optional(Type.Number({ description: "Max delegates per page (default 20, max 100)." })),
      cursor: Type.Optional(Type.String({ description: "Opaque pagination cursor from a previous response's next_cursor." })),
    }),
    async execute(_toolCallId, rawParams) {
      const roster = refs.delegationRoster ?? [];
      if (roster.length === 0) {
        return { content: [{ type: "text" as const, text: "You have no delegate agents configured." }], details: {} };
      }
      const params = (rawParams ?? {}) as {
        query?: string;
        binding_name_confirmed?: boolean;
        retry_token?: string;
        limit?: number;
        cursor?: string;
      };
      const rawQuery = typeof params.query === "string" ? params.query.trim() : "";
      const q = rawQuery.toLowerCase();
      const bindingNameConfirmed = params.binding_name_confirmed === true;
      const limit = Math.min(Math.max(1, Math.floor(params.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
      const offset = decodeCursor(params.cursor);

      const currentTurn = refs.turnRef?.current ?? -1;
      const hasTurnBoundary = refs.turnRef !== undefined;
      if (hasTurnBoundary && retryPhase !== "idle" && currentTurn !== retryTurn) {
        // A new user turn starts a fresh routing attempt.
        retryPhase = "idle";
        pendingRetryToken = null;
        retryTurn = -1;
      }

      let matched = matchRoster(roster, q);
      const presentedToken = typeof params.retry_token === "string" ? params.retry_token.trim() : "";
      const validRetryToken =
        retryPhase === "offered" && presentedToken !== "" && presentedToken === pendingRetryToken;
      let retryBlocked = retryPhase === "closed";

      if (retryPhase === "offered" && matched.length > 0) {
        if (validRetryToken) {
          // A valid retry is consumed on a hit before the result is rendered.
          retryPhase = "idle";
          pendingRetryToken = null;
          retryTurn = -1;
        } else {
          // A hit without the single-use token is not an authorized retry.
          retryPhase = hasTurnBoundary ? "closed" : "idle";
          pendingRetryToken = null;
          retryTurn = hasTurnBoundary ? currentTurn : -1;
          retryBlocked = true;
        }
      }

      if (retryBlocked) {
        // Do not leak or authorize a roster match after this attempt is closed.
        matched = [];
      }

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
        if (retryBlocked) {
          hint =
            `\n\nNo delegate agent covers "${rawQuery}" — this routing attempt is already closed.` +
            " Do not retry and do not delegate — tell the user no authorized agent covers that resource.";
        } else {
          // One retry per routing attempt, enforced by the tool. The retry is spent
          // by presenting the token; while one is outstanding a further miss is
          // terminal, so a caller that changes the name (alias → canonical) or drops
          // the flag cannot earn a second offer.
          const spentRetry = validRetryToken;
          const offerOutstanding = pendingRetryToken !== null;
          if (bindingNameConfirmed || spentRetry || offerOutstanding) {
            retryPhase = hasTurnBoundary ? "closed" : "idle";
            pendingRetryToken = null;
            retryTurn = hasTurnBoundary ? currentTurn : -1;
            const because = bindingNameConfirmed
              ? " (confirmed binding name)."
              : spentRetry
                ? " — the resolved name was already retried."
                : " — the one alias-resolution retry for this attempt was already offered.";
            hint =
              `\n\nNo delegate agent covers "${rawQuery}"${because}` +
              " Do not retry and do not delegate — tell the user no authorized agent covers that resource" +
              (bindingNameConfirmed ? "." : ", and that the name may be an alias.");
          } else {
            retryPhase = "offered";
            pendingRetryToken = crypto.randomUUID();
            retryTurn = currentTurn;
            hint =
              `\n\nNo exact delegate resource binding matches "${rawQuery}" as written. If this may be a cluster ` +
              "alias, localized name, local nickname, or spelling variant, consult a routing-helper skill you " +
              "were given, if any. Retry ONCE with its confirmed canonical binding name, " +
              `\`binding_name_confirmed=true\` and \`retry_token="${pendingRetryToken}"\` — that token is single-use. ` +
              "If no helper is attached or it cannot confirm one binding name, " +
              "do not guess or retry — tell the user no authorized agent covers the name as written and that it " +
              "may be an alias. Do not delegate until coverage is confirmed.";
          }
        }
      } else if (hasMore) {
        hint = `\n\nShowing ${page.length} of ${total}. Refine the query, or pass cursor="${nextOffset}" for the next page.`;
      }
      const header = q
        ? `Delegate agents matching "${rawQuery}":`
        : "Your delegate agents (counts only — pass query=<cluster/host/node> to find who covers a target):";
      const body = lines.length ? `${header}\n${lines.join("\n")}` : header;
      return {
        content: [{ type: "text" as const, text: `${body}${hint}` }],
        details: {
          total,
          shown: page.length,
          match_basis: q ? "exact_resource_binding" : "browse",
          binding_name_confirmed: bindingNameConfirmed,
          ...(hasMore ? { next_cursor: String(nextOffset) } : {}),
        },
      };
    },
  };
}

export const registration: ToolEntry = {
  category: "workflow",
  create: createListDelegatesTool,
  available: (refs) => (refs.delegationRoster?.length ?? 0) > 0 && !refs.delegation,
};
