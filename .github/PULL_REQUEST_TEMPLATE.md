## Summary

<!-- 1-3 sentences: what problem does this solve and how. -->

### Problem

<!-- What broke or was missing? What symptom/impact did it cause? -->

### Solution

<!-- What changed and why this approach over alternatives? -->

## Test Plan

- [ ] `npx tsc --noEmit` passes
- [ ] `npm test` passes
- [ ] Manual verification (describe below if applicable)

## Architecture Checklist

<!-- Skip items that clearly don't apply. -->

- [ ] **Deployment mode**: If touching resource sync, skills, or filesystem writes — verified behaviour in both local (LocalSpawner) and K8s (K8sSpawner) modes. See [`docs/design/invariants.md §1-2`](../docs/design/invariants.md).
- [ ] **Security model**: No new shell execution paths bypassing `command-sets.ts`. Skill scripts go through the review gate.
- [ ] **SQLite DDL parity**: New tables added to both `schema-sqlite.ts` AND `migrate-sqlite.ts`.
- [ ] **Both brain types**: Tool changes work with pi-agent (TypeBox) and claude-sdk (MCP/Zod).

## General Checklist

- [ ] Changes are focused on a single logical change
- [ ] Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
- [ ] No unrelated changes included
