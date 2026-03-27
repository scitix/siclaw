---
title: "Harness Design Philosophy"
sidebarTitle: "Harness"
description: "How we structure AI-assisted development to prevent knowledge drift, enforce invariants, and maintain code quality at scale."
---

# Harness Design Philosophy

> **Audience**: Human developers (the 3 of us + future contributors).
> This document explains *why* our development framework is designed the way it is,
> and *how* to work within it effectively.
>
> **Not for Claude alone** — this is for the team. Claude reads CLAUDE.md; this doc
> is the reasoning behind what's in CLAUDE.md.

---

## 1. The Problem We're Solving

Siclaw is developed primarily with AI coding assistants (Claude Code). This gives
us velocity — but introduces a class of problems that don't exist in pure-human
development:

### 1.1 Knowledge Drift

Each Claude session starts with a fresh context window. It reads CLAUDE.md and
whatever docs we point it to, but it has **no memory of past sessions' mistakes**.
Without explicit guardrails:

- Session A adds output sanitization to protect secrets
- Session B writes a skill that parses `kubectl get secret -o yaml` output
- Session C modifies the sanitizer, not knowing about Session B's skill
- The skill silently breaks — and nobody notices until production

This is not hypothetical. We experienced exactly this pattern with:
- **Output sanitization vs skill compatibility** — sanitizer changes broke
  skills that depended on raw kubectl output
- **kubectl tool removal** — the dedicated kubectl tool was dead code (never
  registered in agent-factory), deleted during cleanup, but docs still referenced
  it. No session caught the inconsistency because no session read both the docs
  and the registration code.

### 1.2 Context Anxiety

Research by Anthropic ("Harness Design for Long-Running Application Development",
2025) identified a behavioral pattern called **context anxiety**: as an LLM agent
approaches what it *believes* is its context limit, it begins prematurely wrapping
up work — cutting corners, skipping verification steps, declaring victory early.

Mitigations:
- **Structured pre-flight** forces each session to front-load understanding before coding
- **Pre-flight protocol** forces each session to front-load understanding before coding
- **Change Impact Matrix** makes blast radius explicit, reducing the temptation to
  "just change it and see"

### 1.3 Compounding Errors

Without explicit feedback loops, AI sessions repeat the same mistakes:
- Anthropic calls the fix "compounding engineering" — every time Claude does
  something wrong, add a note to CLAUDE.md so it doesn't happen again
- Our Change Impact Matrix is the structured form of this: each row encodes
  a lesson learned about what breaks when you touch a particular area

---

## 2. Our Harness Architecture

The harness is everything around the model that makes it produce correct, safe,
consistent code. It has three layers:

```
┌──────────────────────────────────────────────────────────┐
│ Layer 3: Automated Verification                           │
│ CI (typecheck + vitest), future: hooks, integration tests │
│ Catches: things that slipped through Layers 1-2           │
└───────────────────────────┬──────────────────────────────┘
                            │
┌───────────────────────────┴──────────────────────────────┐
│ Layer 2: Development Protocol (CLAUDE.md)                 │
│ Pre-flight, Change Impact Matrix, Post-flight             │
│ Catches: "I didn't know modifying X would break Y"        │
└───────────────────────────┬──────────────────────────────┘
                            │
┌───────────────────────────┴──────────────────────────────┐
│ Layer 1: Documentation Parity (docs/design/)              │
│ invariants.md, security.md, tools.md, sanitization.md,    │
│ skills.md, decisions.md                                    │
│ Catches: "I didn't know this constraint existed"           │
└──────────────────────────────────────────────────────────┘
```

### What Each Layer Does

**Layer 1 (Documentation Parity)**: The source of truth for how things work
and why. Every architectural constraint, security model, and design decision
is documented. Code and docs must stay in sync — outdated docs actively mislead.

**Layer 2 (Development Protocol)**: The operational rules for how to use
Layer 1 effectively. CLAUDE.md is auto-loaded by Claude Code at session start.
It contains:
- **Change Impact Matrix**: "If you change file X → must read doc Y → must
  verify Z → watch out for cross-cutting concern W"
- **Pre-flight Protocol**: Mandatory steps before any code modification
- **Post-flight**: Verification loop and compounding engineering
- **Design Documentation Map**: Which doc covers what

**Layer 3 (Automated Verification)**: The safety net. Currently:
- TypeScript strict mode + `npx tsc --noEmit` (type errors caught at compile)
- `vitest` test suite with heavy coverage on security paths
- CI pipeline (typecheck + test on every PR)

Future additions (see §5):
- Hooks that block edits to critical files without reading corresponding docs
- Integration tests for the security pipeline end-to-end
- DDL parity checks (schema-sqlite.ts ↔ migrate-sqlite.ts)

---

## 3. Design Principles

These principles guide how we evolve the harness itself:

### 3.1 Advisory vs Mandatory

CLAUDE.md rules are **advisory** — Claude reads them but can choose to skip them
under time pressure or context anxiety. Hooks and CI checks are **mandatory** —
they block the action if the rule is violated.

**Current state**: Most rules are advisory. This is acceptable while the team is
small (3 people) and sessions are supervised. As the project grows, critical rules
should migrate from advisory (CLAUDE.md) to mandatory (hooks/CI).

**Migration priority** (rules that should become mandatory first):
1. DDL parity check (schema vs migration) — automatable, high breakage risk
2. `src/core/prompt.ts` edit gate — security-critical, easy to automate
3. Doc-code sync detection — harder to automate, but high drift risk

### 3.2 Concise Over Comprehensive

Anthropic's research shows that **rules get lost in long files**. CLAUDE.md should
be ≤200 lines. Detailed specifications live in `docs/design/` and are loaded on
demand via the Change Impact Matrix.

If you find yourself adding more than 5 lines to CLAUDE.md, consider:
- Is this a rule that applies to ALL sessions? → CLAUDE.md
- Is this domain-specific knowledge? → Relevant `docs/design/*.md`
- Is this a one-time lesson? → Update the Change Impact Matrix row

### 3.3 Encode Assumptions Explicitly

From Anthropic's harness research: *"Every component in a harness encodes an
assumption about what the model can't do on its own."*

When we add a rule to CLAUDE.md or a check to CI, we should document *why* — what
failure mode does this prevent? This lets us remove rules when they become
unnecessary (e.g., if model capabilities improve enough to make a guardrail
redundant).

### 3.4 Separate Generation from Evaluation

AI models are poor critics of their own output. The session that writes code
should not be the sole judge of whether it's correct. Our approach:

- **review-maintainer skill**: Separate Claude session reviews PRs against
  design docs and the Change Impact Matrix
- **Pre-flight protocol**: Forces the developer session to acknowledge constraints
  before coding, not after
- **CI tests**: Automated evaluation independent of the coding session

### 3.5 Cross-Cutting Concerns Are First-Class

The most dangerous bugs come from changes that are correct in isolation but break
something elsewhere. The Change Impact Matrix's "Cross-cutting concerns" column
makes these dependencies explicit.

Current known cross-cutting concerns:
- **Sanitization ↔ Skills**: Changing output sanitization can break skills that
  parse command output; changing skills can expose unsanitized data
- **Command whitelist ↔ Skills**: Adding/removing commands affects what skills
  can use (though skill scripts are exempt from the whitelist)
- **Brain types ↔ Tools**: New tools must work with both pi-agent and claude-sdk
- **Local mode ↔ Resource sync**: Any sync code must respect shared filesystem

---

## 4. How to Work Within This Framework

### 4.1 Starting a Development Session

1. Claude Code loads CLAUDE.md automatically
2. You describe your task to Claude
3. Claude should follow the Pre-flight Protocol (identify files → find in matrix → read docs → list concerns)
4. If Claude skips pre-flight, remind it: "Follow the pre-flight protocol in CLAUDE.md"

### 4.2 During Development

- Each code change should be verified against the Change Impact Matrix's cross-cutting concerns
- If you discover a new cross-cutting concern, **update the matrix immediately** — don't save it for later
- If you find a doc-code inconsistency, **fix it now** — outdated docs compound

### 4.3 Reviewing Code (Human or AI)

1. Check the Change Impact Matrix: did the author read the required docs?
2. Check cross-cutting concerns: are they addressed?
3. Check documentation parity: are relevant docs updated?
4. For security changes: does the change maintain all 6 defense layers?

### 4.4 After a Mistake

When a Claude session breaks something it shouldn't have:
1. Fix the immediate issue
2. Ask: "What did the harness fail to catch?"
3. Update the appropriate layer:
   - Missing knowledge → Update `docs/design/*.md` (Layer 1)
   - Knowledge existed but wasn't consulted → Update Change Impact Matrix or
     Pre-flight Protocol (Layer 2)
   - Consulted but not enforced → Add CI check or hook (Layer 3)

This is "compounding engineering" — every mistake improves the harness.

---

## 5. Evolution Roadmap

### Current State (2026-03)

- Layer 1: 7 design docs covering architecture, security, tools, sanitization, skills, decisions, roadmap
- Layer 2: CLAUDE.md with Change Impact Matrix, Pre-flight / Post-flight Protocol
- Layer 3: CI (typecheck + vitest), ~38 test files with heavy security path coverage

### Near-Term Improvements

| Improvement | Layer | Impact | Effort |
|---|---|---|---|
| DDL parity CI check | 3 | Prevents silent schema drift | Low |
| `prompt.ts` edit hook | 3 | Prevents unauthorized system prompt changes | Low |
| Skill compatibility test | 3 | Detects sanitizer changes that break skills | Medium |
| Integration test for security pipeline | 3 | E2E: validateCommand → execute → applySanitizer | Medium |

### Long-Term Vision

As the team grows beyond 3 people:
- Layer 2 rules migrate to Layer 3 (advisory → mandatory)
- Per-directory CLAUDE.md files for domain-specific rules (monorepo pattern)
- Automated doc-code sync detection (flag stale docs in CI)
- Session handoff artifacts for multi-session tasks (Anthropic's `claude-progress.txt` pattern)

---

## 6. Relationship to Anthropic's Research

Our harness design is informed by Anthropic's published research on AI agent
engineering. Key mappings:

| Anthropic Concept | Our Implementation |
|---|---|
| "Every harness component encodes an assumption about what the model can't do" | Change Impact Matrix encodes "Claude can't know X affects Y without being told" |
| "Context anxiety" → premature task completion | Pre-flight front-loads understanding; Matrix makes blast radius explicit |
| "Compounding engineering" → learn from mistakes | After-mistake protocol (§4.4): fix → diagnose harness gap → update layer |
| "Separate generation from evaluation" | review-maintainer skill; CI as independent evaluator |
| "Stress-test assumptions regularly" | Periodically review: are these rules still needed? Can any be removed? |
| "Start simple, add complexity only when needed" | Advisory rules first; migrate to mandatory only when breakage proves necessary |

**Key insight we apply**: The harness should shrink or shift with model improvements,
not accumulate indefinitely. If a future Claude model reliably reads design docs
without being told, we can simplify the Pre-flight Protocol. The *why* behind each
rule (documented in this file) tells us when it's safe to remove.

---

## 7. Quick Reference: Design Doc Inventory

```
docs/design/
├── harness.md        ← This file (harness philosophy, for humans)
├── invariants.md     ← Architecture constraints (deployment modes, bundles, DB, security)
├── security.md       ← 6-layer defense model (OS isolation, command whitelist, containers)
├── sanitization.md   ← 3-layer output sanitization (pre/post strategy, skill exemption)
├── tools.md          ← Tool organization, execution pipelines, context system
├── skills.md         ← Skill lifecycle, approval workflow, execution model
├── decisions.md      ← ADRs (sql.js, LocalSpawner, whitelist, memory, mTLS, brain types)
└── roadmap.md        ← IM/KR/OB/PM/CS phases with current status
```
