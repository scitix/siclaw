# Compiler Agent Environment

## Goal

KBC must give the compiler agent a complete, open, and reliable working
environment for turning a frozen Raw snapshot into traceable knowledge.
Scheduling and safety controls should make good compilation easier; they must
not force the agent to hide evidence, guess across missing context, or optimize
for a document-only linter.

For a code knowledge profile, the useful output is a system-understanding model:
repository boundaries, components and responsibilities, interfaces and
dependencies, important control and data flows, configuration and deployment
contracts, operating signals, troubleshooting paths, and explicit unknowns.
It is not a page per file and not a line-by-line code reference.

## Environment contract

1. **Raw is complete and frozen.** The imported snapshot is the authoritative
   compilation input. Tools preserve original `raw/...` identities so candidate
   evidence remains traceable.
2. **Batch assignment is a responsibility boundary, not a visibility boundary.**
   A map session compiles only its assigned sources, but may consult the whole
   snapshot to understand cross-component relationships and avoid contradictions
   or duplicate pages.
3. **Fact-finding is engine-neutral.** `source_inventory`, `source_search`, and
   `source_read` provide the same bounded read-only Raw surface to Claude, Codex,
   and future engines. Native filesystem layout is not an engine capability
   contract.
4. **Context safety remains deterministic.** Oversized text and page-sliced PDFs
   are discoverable in the inventory, but their originals cannot bypass the
   assigned bounded view. Reads, search results, line counts, result counts, and
   paths are bounded and confined to Raw.
5. **Each phase gets the evidence it needs.** Map sessions may consult all Raw;
   structural section reduction is Candidate-only; semantic final review may
   return to Raw to verify load-bearing claims and cross-batch contradictions.
6. **Validation understands the source domain.** Planning, slicing, provenance,
   and linting share one source classification. Code and build files are valid
   UTF-8 evidence, not unknown binaries or malformed citations.
7. **Gates produce actionable truth.** Deterministic checks protect confinement,
   provenance, coverage, and output shape. They do not reward deleting citations
   or bulk-excluding ordinary code merely to make a score green.

## Phase access matrix

| Phase | Raw consultation | Write scope | Purpose |
|---|---|---|---|
| Map batch | Complete snapshot, except bounded originals | Assigned knowledge responsibility in `candidate/` | Compile one responsibility slice with whole-system context |
| Section reduce | None | Listed Candidate pages and index | Structural deduplication without recompiling sources |
| Final semantic review | Complete snapshot | Candidate and authoring close-out state | Verify contradictions and important claims across batches |

## Acceptance criteria

- A code archive can cite common source and build paths without
  `body_source_malformed` noise.
- Code, Dockerfile variants, and Makefiles are budgeted and sliced as text.
- Repository-control sources such as `.github/workflows/` and `.gitlab-ci.yml`
  remain visible while arbitrary hidden caches stay excluded.
- Every supported engine can inventory, search, and read permitted sources
  outside its assigned batch.
- Bounded originals remain visible as `bounded_view_only` and cannot be read or
  searched through the inspector.
- Structural reduce cannot access Raw; final semantic review can consult Raw but
  is explicitly prohibited from starting a second full compilation.
- All access remains read-only, path-confined, bounded, and covered by regression
  tests.
