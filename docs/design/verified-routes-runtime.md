# Verified Routes — runtime contract

Verified routes are maintainer-curated fast paths into a knowledge base: a
high-frequency question mapped to an ordered list of leaf pages that answer it.
They are authored and published in Sicore (see the Sicore repo's
`docs/design/kb-verified-routes.md`); this document is the **consumer/runtime**
side that lives in Siclaw — what reaches a bound agent, and the trust rules that
gate it. It records contracts and rationale, not call order.

## Producer → consumer shape

The Sicore renderer owns three projections, deterministically regenerated after
every compile commit and shipped inside the published knowledge version:

1. `candidate/.okf-routes.json` — the machine contract (routes + load-bearing
   target paths). **Never reaches the model tree** (see "Sidecar exclusion").
2. `candidate/检索路由/index.md` — a human-readable route manual page.
3. A delimited block inside `candidate/index.md`, between the paired markers
   `<!-- verified-routes:begin -->` and `<!-- verified-routes:end -->`.

The runtime consumes only the **rendered block** in `index.md`. The markers are
a load-bearing literal: the box compile prompt (`kbc/platform/pod/prompts/{en,zh}/box_role.md`)
pins them so a compile agent leaves the block alone, and
`src/memory/overview-generator.ts` extracts by the same paired literal.

## Sidecar exclusion (`.okf-routes.json`)

`OKF_ROUTES_SIDECAR` (`.okf-routes.json`) is in `UPLOADER_ONLY_SIDECAR_FILES`
(`src/shared/knowledge-package.ts`): the extractor strips it at every depth so
it never becomes a model-visible page (the runtime needs only the rendered
projections; the raw machine contract would be redundant noise the agent could
Read). Its **presence in the package is still recorded** — see the trust gate.

## Injection into the system prompt

`buildKnowledgeWikiCatalog` lifts each authorized library's verified-routes
block into a `## Verified Fast Routes` section ahead of the ordinary catalog,
rewriting relative link destinations to Read-ready paths (via the single
`rewriteCatalogLinkPaths` grammar in `catalog-graph.ts`, so titled links,
`#fragment`s, and image links are handled once, not by a second hand-rolled
parser). The block is removed from the ordinary catalog so it is not shown
twice.

Marker scanning runs on a **code-masked copy** (`maskMarkdownCode`) so a fenced
example marker (the box prompt teaches authors the literal) cannot pair with the
real block's end and delete catalog content between them — a stated correctness
contract: the root catalog is never silently truncated.

## Trust gate — why a marker block is not enough

A `<!-- verified-routes -->` block is plain text inside `index.md`. An uploaded
(non-authoring) package could hand-write one and, unguarded, have it presented
to every bound agent in the platform's own "verified shortcut, read these pages
first" voice — trust elevation / prompt injection.

The gate: a block is lifted **only for a repo whose package carried the
`.okf-routes.json` machine contract**. `validateKnowledgePackage` reports
`hasRoutesSidecar`; the materializer records it per repo as `verifiedRoutes` in
`.citation-manifest.json`; `collectVerifiedRoutes` reads that manifest and lifts
a block only for a repo marked `verifiedRoutes: true`. No manifest, or the flag
false ⇒ the block stays an ordinary (untrusted) catalog entry.

The manifest is also the **authoritative source of each library's root**, so the
scan does not hardcode a `repos/` layout — it covers both the nested
(sync-handlers, K8s) and any manifest-bearing materialization uniformly.

**Residual, by design:** the gate raises the bar (a forged marker block without
the machine contract is not lifted) but is not a cryptographic proof of
provenance — an attacker who also crafts a matching `.okf-routes.json` in the
same package would pass it. The complete fix is server-side provenance (only
versions produced by the authoring/compile pipeline may carry routes); that
belongs on the Sicore side and is out of scope here. The flat TUI+Portal
materializer writes no citation-manifest today, so it lifts no routes — routes
in that mode are follow-up work, not a silent partial.

## References list de-duplication (consumer side)

Both gateway consumers (`sse-consumer.ts`, `lark.ts`) **assign** the
`knowledge_sources` event (`pendingKnowledgeSources = ev.sources`) and append it
to an ending assistant message. To keep each source rendered exactly once across
a turn's messages — without losing it when the model narrates or re-cites before
its final answer, and without duplicating it across bubbles — the consumer keeps
`pendingKnowledgeSources` for the whole turn and appends only the
not-yet-rendered delta (tracked in a per-turn URL set), resetting at the
user-message turn boundary. This is why `knowledge_cite` emits the growing
deduped **union** rather than per-call sources.
