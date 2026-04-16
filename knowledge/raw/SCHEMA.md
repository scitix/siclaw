# Siclaw SRE Wiki — Schema & Workflow

This wiki is the semantic knowledge layer for the Siclaw SRE agent. Following the [Karpathy LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f), it replaces vector-search RAG with a compiled, interlinked markdown knowledge base that the agent navigates directly via index + file reads.

## Audience

This document has two audiences:

1. **Compiler/maintainer** (Claude Code or any LLM doing wiki maintenance) — reads this file to understand how to ingest sources, structure pages, and run lint
2. **Runtime agent** (Siclaw's diagnostic agent, e.g. Kimi K2.5) — does NOT read this file; instead reads `index.md` for navigation and follows `[[wikilink]]` references between pages

## Directory Layout

```
.siclaw/knowledge/        (deployed from overlay/knowledge/)
├── SCHEMA.md             # this file — for maintainers, not runtime agent
├── index.md              # navigation entry — runtime agent reads this first
├── log.md                # append-only operation log
├── components/           # one page per system component
├── concepts/             # foundational concepts shared across components
└── diagnostics/          # cross-cutting diagnostic patterns (symptom → cause → check)
```

**No `raw/` directory.** Unlike the canonical pattern, siclaw doesn't store source documents in the wiki — sources are SKILL.md files (in `overlay/skills/`), component reference docs (provided by component owners), source code (in `roce-operator-ref/`, `rdma-doctor-ref/`, etc.), and live cluster state. The wiki references them via `compiled_from` frontmatter but does not duplicate them.

## Page Types

| Type | Directory | Purpose | Examples |
|------|-----------|---------|----------|
| `component` | `components/` | One specific system or operator. CRDs, lifecycle, failure modes, configuration | roce-operator, rdma-doctor, vce-operator |
| `concept` | `concepts/` | Foundational concept that spans multiple components | RoCE modes, GID consistency, tenant isolation, policy routing |
| `diagnostic` | `diagnostics/` | Symptom-to-cause diagnostic pattern that crosses multiple components | NCCL timeout, pod stuck creating, RDMA traffic failure |

Component pages answer "how does X work and what can go wrong?" Concept pages answer "what is X and why does it matter?" Diagnostic pages answer "user reports symptom Y — what's the differential diagnosis?"

## Page Format

Every wiki page has this frontmatter:

```yaml
---
title: "Page Title"
type: component | concept | diagnostic
compiled_from:
  - <relative path to source 1>
  - <relative path to source 2>
last_updated: YYYY-MM-DD
---
```

The body should follow this rough structure (adapt as appropriate for the page type):

```markdown
## When to use this page
One paragraph: what symptoms or questions bring an agent here.

## <body sections specific to page type>

## See Also
- [[related-page-1]] — why it's relevant
- [[related-page-2]] — why it's relevant
```

### Linking Convention

Use `[[page-name]]` wikilinks for cross-references. The runtime agent will follow these by reading the referenced file. Use the file basename without `.md` extension and without directory prefix — the agent resolves the path by searching the wiki structure.

When the relationship is not symmetric, prefix with the relationship type:
- `[[page]] @depends_on` — this page requires that one to be understood first
- `[[page]] @contradicts` — this page contradicts that one (annotate which side is current)
- `[[page]] @supersedes` — this page replaces that one
- `[[page]] @related` — general related reading

Without a prefix, default semantic is `@related`.

### Content Rules

1. **No hardcoded runtime data.** Specific IPs, node names, namespace names, VLAN IDs, MAC addresses change per cluster and per session. They have no semantic value and dilute the page. Use placeholders like `<node>`, `<ns>`, `<subnet>` in examples.
2. **Patterns over instances.** Document the structure of an IPAllocation, not the contents of a specific one.
3. **Causal relationships, not just facts.** "Manager creates IPAllocation CR" is a fact. "If Manager is down during pod deletion, IPs are not released until restart" is a causal relationship — the latter is what helps diagnosis.
4. **Decision boundaries explicit.** Where one diagnostic path branches from another, name the branch condition. "If gateway_ping fails on PF but not on pod → physical network issue. If reverse → pod-specific config issue."
5. **No skill invocation syntax.** Don't write `local_script: skill="X"...` — that's procedural memory belonging in SKILL.md, not semantic memory. The wiki tells the agent WHEN and WHY to investigate something; the SKILL.md tells the agent HOW to run the check.
6. **No vendor/driver-specific "normal" or "anomaly" assertions.** Statements like "X is normal on vendor Y" or "tool Z is only available on driver W" are unsafe for two reasons: (a) Kubernetes resource names (e.g. `rdma/brcm_sriov_bnxt_*`) are plugin-registration strings and may not reflect the actual hardware — clusters where the name says Broadcom but the running driver is `mlx5_*` do exist; (b) clusters may have mixed vendors across nodes. The wiki describes mechanisms and failure modes at the architecture level. Agents judge "is this normal *here*?" by first verifying the node's actual NIC vendor/driver via `lspci`, `lsmod`, and `/sys/class/infiniband/<dev>/device/driver`, then combining that with vendor-specific references (which live outside this wiki).

## Index Format

`index.md` is the runtime agent's navigation map. It must fit in agent context (target: under 4KB).

Structure:

```markdown
# Siclaw SRE Knowledge

## How to use this wiki

(Brief instructions for the agent — when to consult, how to navigate.)

## Components

| Page | Summary |
|------|---------|
| [[component-name]] | One-line summary |

## Concepts

| Page | Summary |
|------|---------|
| [[concept-name]] | One-line summary |

## Diagnostics by Symptom

| Symptom | Start here | Then check |
|---------|-----------|------------|
| User reports X | [[diagnostic-page]] | [[component-page]] |
```

The "Diagnostics by Symptom" section is the most important — it lets the agent route from a user's symptom to the right starting page without searching.

## Log Format

`log.md` is append-only. Each entry:

```
## [YYYY-MM-DD] <operation> | <primary page or topic>
- Updated: <cascade-updated page>
- Notes: <brief notes about decisions made>
```

Operations: `compile` (new page), `update` (modify existing page), `lint` (audit pass), `cascade` (cross-page propagation only).

Greppable with: `grep "^## \[" log.md | tail -10`

## Workflows

### Compile (new page)

When ingesting a new source or compiling new knowledge:

1. **Read all relevant raw sources** — SKILL.md files, component docs, source code if needed. Verify understanding against live cluster if possible.
2. **Identify page type** — component, concept, or diagnostic
3. **Identify cascade targets** — what existing pages reference this topic and need updating?
4. **Write the new page** following the format above
5. **Update `index.md`** — add entry under appropriate section, with one-line summary
6. **Cascade update** — for each existing page that references this topic, add or update the `[[wikilink]]` and any affected explanation
7. **Append to `log.md`**

### Update (modify existing page)

1. Read the existing page and understand what's changing
2. Read all pages that reference it (find via `grep -l "[[page-name]]" .siclaw/knowledge/`)
3. Make the update
4. Cascade update referencing pages if the change affects them
5. Update `last_updated` in frontmatter
6. Update `index.md` summary if it changed
7. Append to `log.md`

### Query (runtime agent — not maintainer)

This is what the runtime agent does, defined here for reference:

1. Read `index.md` to identify relevant pages from the symptom
2. Read those pages with the Read tool (whole pages, not chunks)
3. Follow `[[wikilink]]` references for additional context
4. Synthesize answer with inline citations as `[[page-name]]`

Runtime agent does NOT do compile, update, or lint. Those are maintainer operations.

### Lint (periodic maintenance)

Run periodically to keep the wiki healthy:

**Auto-fix:**
- Frontmatter missing → add minimum viable frontmatter
- Index entry missing for a page that exists → add with placeholder summary
- Index entry pointing to non-existent file → mark `[MISSING]`
- Broken `[[wikilink]]` where one match exists elsewhere → fix the link

**Report only (require judgment):**
- Contradictions between pages on the same topic
- Stale claims that newer sources have superseded
- Orphan pages (no inbound `[[wikilinks]]` from other pages)
- Concepts mentioned in 3+ pages but lacking their own page
- `compiled_from` paths that no longer exist
- Pages where source code has changed significantly since `last_updated`

Append lint result to `log.md`.

## Compiler Discipline

Critical rules for whoever is compiling this wiki:

1. **Verify before claiming.** If asserting a causal relationship between components ("X depends on Y"), verify against source code or live cluster — do not infer from documentation alone. Document what was verified in `compiled_from`.
2. **Update existing pages, don't duplicate.** If new knowledge fits an existing page, update that page. Create a new page only for genuinely distinct concepts.
3. **No cluster-specific data.** Repeating: specific IPs, node names, namespaces, VLAN IDs do not belong in the wiki.
4. **Cross-references are claims, not decoration.** A `[[wikilink]]` says "this other page is needed to understand this one." Don't add links for SEO-style "related reading" — only when the linked page genuinely contributes.
5. **Each ingest touches multiple pages.** A single new source typically updates 3-10 wiki pages via cascade. If a compile doesn't trigger any cascade, double-check whether you missed connections.
