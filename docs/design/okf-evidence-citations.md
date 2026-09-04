---
title: "OKF Evidence Citations"
sidebarTitle: "OKF Evidence Citations"
description: "Canonical marker grammar and fail-closed source binding for knowledge_cite."
---

# OKF Evidence Citations

For the end-to-end retrieval boundary and leaf-page citation contract, see
[Knowledge Retrieval and Citation Architecture](knowledge-retrieval-and-citations.md).

Compiled wiki pages may bind one answerable section to declared source ids.
`knowledge_cite` then re-derives the original URL from the frozen citation
manifest. The marker is input; the manifest is authority.

Three implementations must agree on the grammar:

- compile box: `selfcheck.py` in `SICLAW_COMPILE_BOX_IMAGE`
- agentbox: `knowledge-citation-tool.ts` in `SICLAW_AGENTBOX_IMAGE`
- Sicore import: `okf_citations.go` (`okfEvidenceMarker` / `okfEvidenceMarkerStart`)

Shared recognition cases live in `okf-evidence-marker-fixtures.json` and are
exercised by both `test_selfcheck.py` and `knowledge-citation-tool.test.ts`.
The Go importer must use the same start regex (`\b` after `okf:evidence`),
scan only the post-frontmatter body, and ignore fenced / inline code.

## Marker grammar

A marker is a single HTML comment on one line. Only space and tab are
whitespace. Newlines, NBSP, and other `\\s` characters are not.

```
<!--[ \t]*okf:evidence[ \t]+({[^\r\n]*})[ \t]*-->
```

The JSON object has exactly two keys: `id` and `sources`. `id` and each
source id match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`. `sources` has 1 to
`MAX_EVIDENCE_SOURCES_PER_MARKER` (8) unique declared frontmatter source ids.

Pretty-printed or newline-broken comments are not markers. Markers inside
fenced code or inline code spans are also not markers — they are examples.

## Binding

For `page.md#evidence-id`:

1. The page was Read this turn. Cite uses the exact bytes from that Read,
   not a later disk reread or knowledge reload.
2. Read captures a mount receipt, then reads the page, then checks the
   receipt again. Register only when both match: those bytes plus that
   manifest. A raced Read whose receipt does not match drops earlier
   snapshots and invalidates the pin. A later consistent Read on a new
   mount also drops earlier snapshots and re-pins, so the model can
   re-read and cite in this turn.
3. The evidence id parses from a canonical marker in the snapshot prose.
4. Each source id appears in the page frontmatter `sources`.
5. The same source id appears in the pinned manifest.
6. `normalizedResource` agrees. It strips a leading `raw/` or `drop/` and
   does not strip a leading `/`, matching `selfcheck._norm_source_entry`.

A page cannot claim a source it does not declare. A marker cannot re-point a
manifest entry at a different original.

## Fail-closed matrix

- One malformed marker does not invalidate other markers on the same page.
  Only the refs that do not resolve fail.
- Any unresolved `evidence_refs` entry registers zero citations for that
  call. Retry once with only the remaining valid refs. Fail-closed is
  reserved for correctness problems — unresolved refs and the two shape
  rules below — and no longer fires on breadth (see the cap bullet).
- A present-but-non-array `evidence_refs` or `pages` fails the whole call
  (pi does not validate tool params against the TypeBox schema; silently
  coercing to `[]` reported success while dropping the misshapen half).
- A `pages` item whose trimmed `claim` is outside 4–300 Unicode code points
  fails the whole call, same as a missing claim — the bounds are enforced
  at runtime, not advisory schema, or a one-character claim would let
  padding back in.
- `evidence_refs` and `pages` may be passed together. Marked pages must use
  `evidence_refs`; `pages` is only for pages with no parsed evidence marker.
  Each `pages` item is `{path, claim}`, where `claim` is the specific
  statement in the final answer the page supports: provenance validation
  cannot distinguish a cited-and-used page from a read-and-discarded one,
  so the claim is the one materiality demand the runtime can make. An item
  with a missing or blank claim (including the legacy bare-string form)
  registers zero citations for the call. Offline consumers parsing
  historical `knowledge_cite` tool rows must handle both shapes — `pages`
  was `string[]` before 2026-09.
- One answer never carries more than `MAX_KNOWLEDGE_CITATIONS` (8)
  originals. Crossing the cap no longer fails closed: the first 8 unique
  sources are registered — evidence refs first, then pages, each in its
  given order (there is no global order across the two lists, so the cap
  sacrifices pages first) — and the dropped overflow is NAMED in the tool
  result. Nothing is silently truncated. (The old reject-whole-call
  behavior zeroed the citations of exactly the best-supported answers, and
  its retry guidance looped on identical valid refs.) The cap applies to
  the TURN's union: gateway consumers ASSIGN the `knowledge_sources` event
  rather than merging, so the tool emits the deduped, capped union of every
  successful call this turn — a follow-up call adds to the references list
  instead of overwriting it, and cannot raise the ceiling. Gateway
  rendering (`appendKnowledgeSourceCitations`) uses the same cap.
- A mount that has any `sourceId` in the manifest offers evidence guidance.
  Mixed answers are expressed in one call, not by flipping modes.

## Compiler emission (kbc)

The compile agent authors provenance at one level only: a `(source: X)` tag on
each statement. `selfcheck.attribute_evidence_sections` runs at the turn seam
(same scope as `normalize_body_source_annotations`) and stamps the machine
shapes:

- `sources[].id` — copied from `authoring/manifest.yaml` (the frozen source
  manifest the control plane materializes). A missing id is inserted; an id
  that disagrees with the manifest is replaced, because only manifest ids pass
  `validateAuthoringEvidence` at publish. Unmanaged resources keep the author's id.
- One marker per answerable section (ATX heading spans plus the preamble),
  placed on the line directly above the heading. Sources = the tags inside the
  section, in order of first appearance, capped at 8; a single-source page binds
  every section to that source; a multi-source section with no tag falls back to
  the page's sources and is reported as `fallback`.
- Machine markers carry the `kbc-` id prefix and are regenerated on every pass
  (idempotent). A marker with any other id is authored: its section is left
  alone. A marker whose next non-blank line is a heading belongs to that
  heading's section, matching the agent's own convention.

`SELFCHECK.json.attribution` carries `{pages, sections, attributed, authored,
fallback, ratio, findings[], oversized_pages[]}`. It is advisory: the repair
prompt relays `findings` while a repair turn is running anyway, the publish
card shows the ratio, and nothing gates on it — an unattributed section still
answers, it just cites wide. `oversized_pages` lists pages above 30 sources as
a split hint.

## Deploy

The 3→8 render cap lives in `src/shared/knowledge-citations.ts` and is used
by AgentBox *and* Gateway (SSE consumer and Lark). Shipping only a new
agentbox image leaves Feishu / SSE rendering on the old 3-link ceiling.

- Agentbox (`SICLAW_AGENTBOX_IMAGE`): grammar, snapshots, mixed call.
- Gateway / Runtime image: the shared render cap.
- Compile box (`SICLAW_COMPILE_BOX_IMAGE`): `selfcheck.py` marker scan.
- Sicore apiserver: `okf_citations.go` import gate. A compile-green page
  can still fail package import if Go's start regex or scan range differs.

Live sessions keep the box they already have.
