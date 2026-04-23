# Skills Architecture

## Design Principles

1. **Management and execution chains are separated**: Gateway API + DB handle skill CRUD, sharing, review, and approval using only `id` + `name`. Disk directories (`dirName`) are generated from `name` at materialize time and are implementation details of the execution chain.
2. **Skill space is a collaborative development space**: maintainers edit space skills directly, publish to dev, submit + approve for production.
3. **Builtins are unified in the database**: Gateway startup scans Docker-baked builtin skills and syncs them to DB. After that, everything goes through DB -- no special handling.
4. **Per-user toggles**: skill enable/disable and skill space enable/disable are per-user, keyed by `skillId` (not `skillName`).
5. **Submit and Contribute are independent**: two separate approval flows, each with its own staging tag, review handler, and withdraw operation.
6. **No cross-origin name collisions**: skills with the same name but different `originId` are rejected at all entry points (create, fork, rename, move, contribute). Only fork from the same source is allowed to create a same-name copy.
7. **Content hash for change detection**: SHA-256 of specs + sorted scripts determines whether content has changed. Used by `canSubmit`, `canContribute`, `hasUnpublishedChanges`, and builtin sync.
8. **Skill preview in conversation**: the `skill_preview` tool reads skill draft files from disk and renders a side panel with copy buttons. Agent writes files first via file I/O tools, then calls `skill_preview` with the directory path. Does not persist to DB.

### The Security-Flexibility Trade-off

Siclaw's command whitelist (`ALLOWED_COMMANDS` in `command-sets.ts`) restricts the agent to a set of
safe, read-only binaries (e.g. `kubectl get`, `ip`, `ethtool`). This protects production environments
from accidental mutations but limits what the agent can do -- many real-world SRE tasks require
commands that go beyond read-only operations (restarting services, modifying configs, running
performance tests, etc.).

**Skill scripts are the escape hatch.** The command whitelist does *not* filter commands inside skill
scripts -- a script can use any binary, any flag, any pipeline. This gives users full flexibility to
encode arbitrary operational procedures as skills. The trade-off is managed through the approval
workflow:

- **Dev environment**: users can freely create, edit, and test skills with no restrictions.
  All personal skills (including drafts) are immediately available to the agent.
- **Prod environment**: only reviewer-approved skills are loaded. Before a skill reaches
  production, it goes through static pattern analysis + AI semantic review + human reviewer
  approval. This ensures scripts are safe and intentional before they can run against live
  infrastructure.

In effect, skills should be treated as **read-only at runtime** -- they are executed as-is, not
modified on the fly. The editing and iteration happen in dev; production gets immutable, approved
snapshots.

### Why skills instead of ad-hoc commands?

1. **Flexibility** -- skill scripts bypass the command whitelist, enabling operations that the
   agent cannot perform through ad-hoc commands alone.
2. **Reliability** -- tested scripts avoid the trial-and-error of ad-hoc command generation.
3. **Safety** -- the dev/prod split and approval workflow ensure only reviewed scripts run in
   production, even though the scripts themselves are unrestricted.
4. **Reusability** -- investigation patterns are encoded once, used by all users.
5. **Governance** -- the approval workflow ensures scripts meet the team's quality and security
   bar before they enter the shared pool.

---

## Skill Format

```
{skillName}/
├── SKILL.md              # Specification (YAML frontmatter + Markdown body)
└── scripts/
    ├── main-script.sh    # One or more executable scripts
    └── helper.py
```

### SKILL.md Frontmatter

```yaml
---
name: find-node
description: >-
  Fuzzy-match Kubernetes nodes by keyword.
  Use this instead of listing all nodes to keep context minimal.
---
```

The `name` and `description` fields are parsed by `SkillFileWriter.parseFrontmatter()` and surfaced
in the agent's system prompt for skill discovery.

### Labels (`meta.json`)

Each tier directory (`skills/core/`, `skills/extension/`) may contain a `meta.json`:

```json
{
  "labels": {
    "find-node":      ["kubernetes", "general", "diagnostic"],
    "dns-debug":      ["kubernetes", "network", "diagnostic"]
  }
}
```

Labels are loaded at startup by `builtin-sync.ts` and stored in the `labelsJson` column of the
`skills` table. Used for filtering in the UI. Core and extension labels are unified under the
`builtin` scope.

---

## Scope Model

| Scope | Owner | Editable by | Storage | How it gets there |
|-------|-------|-------------|---------|-------------------|
| **builtin** | Docker image | No (can only be disabled) | DB (synced from disk at startup) | `builtin-sync.ts` scans `skills/core/` + `skills/extension/` and upserts DB |
| **global** | System (admin) | No | DB | Personal/skillset skill contributed, reviewed, and promoted |
| **personal** | Individual user | Author | DB | User creates or forks from builtin/global |
| **skillset** | Skill space (team) | Space maintainers | DB | Fork from global/builtin, or move from personal |

## Skill Identity

### id

- Builtin skills: `builtin:<dirName>` (deterministic id, backward-compatible with forkedFromId chains and workspace composer refs)
- DB skills (global/personal/skillset): UUID

### originId

Each skill records an `originId` pointing to the **original source**. All forks inherit this value.

```
Global g1 (originId: g1)
  -> fork to personal: p1 (originId: g1)
  -> fork to skillset: ss1 (originId: g1)

Builtin "cluster-events" (originId: "builtin:cluster-events")
  -> fork to personal: p2 (originId: "builtin:cluster-events")
```

Uses:
- `resolveRelatedGlobalSkill`: query `WHERE originId=x AND scope='global'` to find related global skill
- `promoteToGlobal`: find existing global skill via originId and update (no duplicates)
- `rejectCrossOriginNameConflict`: reject same-name skills with different originId at all entry points
- Rename does not break the chain (originId is immutable)

### forkedFromId

Records the **direct parent** (one hop). Used for:
- Fork conflict detection: reject if target already has skill with same `forkedFromId`
- UI display "forked from xxx"
- On delete, chain relay (`relinkForkedFrom`)

### Name Conflict Rules

All entry points enforce: **same name + different originId = rejected**.

| Entry point | Same name, same origin | Same name, different origin |
|-------------|----------------------|---------------------------|
| `skill.create` | Allowed (fork) | Rejected |
| `skill.fork` | Rejected (already exists) | Rejected |
| `skill.update` (rename) | N/A | Rejected |
| `skill.moveToSpace` | Rejected (already in space) | Rejected |
| `skill.contribute` | Update existing global | Rejected |

---

## Skill Lifecycle

### Create & Edit

```
User creates skill -> scope: personal, editable
User edits skill   -> personal or skillset (maintainer)
```

### Fork (builtin/global only)

```
Fork to personal:   builtin/global -> personal copy (editable, inherits approved state)
Fork to skill space: builtin/global -> skillset copy (batch supported via sourceIds[])
```

Forks inherit `originId` and set `forkedFromId`. The forked skill starts with:
- `approvedVersion: 1`, `publishedVersion: 1`, `reviewStatus: "approved"`
- Content saved to `working`, `published`, and `approved` tags
- A version record with `tag: "approved"` is created

This means forked skills are **immediately available in production** -- no need to re-submit.

If the target (personal or skillset) already has a skill from the same source, fork is **rejected** (not updated). User must edit the existing copy directly.

### Move to Space (from personal)

```
Personal skill -> skill.moveToSpace(id, skillSpaceId) -> scope changes to skillset
```

- Destructive operation: personal copy no longer exists
- Only skill author + space maintainer can operate
- Rejected if space already has skill with same originId or same name
- Rejected if global/builtin has same name with different originId
- Resets lifecycle: `publishedVersion: null`, `approvedVersion: null`, `reviewStatus: draft`
- Clears all content tags except `working` (`published`, `approved`, `staging`, `staging-contribution`)

### Edit & Publish in Space

```
Space skill -> skill.update (edit working) -> skill.publishInSpace (working -> published + version)
```

- Maintainer edits directly, saves to working
- Publish: working -> published, creates version record, no approval needed
- Publish takes effect in **dev environment** (for all space members)
- **Production** requires additional `skill.submit` -> admin `skill.approveSubmit`
- Last-write-wins (sufficient for small teams)

### Submit (production review)

```
skill.submit -> reviewStatus: pending -> staging snapshot
  -> skill.approveSubmit -> approved (prod effective)
  -> skill.rejectSubmit  -> draft
  -> skill.withdrawSubmit -> withdraw
```

- Personal skill: copies working -> `staging`
- Skillset skill: copies published -> `staging` (must publishInSpace first)
- While pending, can re-submit to update staging (no need to withdraw first)
- Batch support: `ids[]`

#### Script Security Review

When a skill is submitted (`skill.submit`), `triggerScriptReview()` performs two-phase analysis:

**Phase 1 -- Static pattern matching** (`DANGER_PATTERNS` in `script-evaluator.ts`):
- Regex rules categorized by risk: `destructive_command`, `privilege_escalation`,
  `data_exfiltration`, `env_mutation`, etc.
- Severity levels: `critical`, `high`, `medium`, `low`
- Examples: `rm -rf` -> critical, `kubectl delete` -> high, `curl -d` -> high

**Phase 2 -- AI semantic analysis**:
- Calls LLM with script content + Phase 1 findings as context
- Returns structured risk assessment: `{ riskLevel, findings[], summary }`
- Falls back to static-only if AI is unavailable

Review results are stored in the `skill_reviews` table for audit.

### Contribute (promote to Global)

```
skill.contribute -> contributionStatus: pending -> staging-contribution snapshot
  -> skill.approveContribute -> promoted to global
  -> skill.rejectContribute  -> contribution reverted
  -> skill.withdrawContribute -> withdraw
```

- Requirement: already approved + no unpublished changes
- Copies approved -> `staging-contribution` (independent from submit's staging)
- **Submit and Contribute can be pending simultaneously**, they do not interfere
- Conflict check: same-name global skill with different originId -> rejected
- Batch support: `ids[]`

### Diff Preview

Before publish, submit, or contribute, the UI shows a GitHub-style diff dialog:

- **File diffs**: collapsible sections per file (SKILL.md, scripts/*), 3 lines context, hidden unchanged regions
- **Metadata diff**: type and labels shown as colored tag pills (+green, -red, unchanged gray)
- **Commit message**: optional text input, stored on skill record for version history
- **Origin fallback**: for first-time operations on forked skills, diffs against the fork source

### Version History

Each publish/approve creates a version record with:
- `tag: "published"` for dev versions, `tag: "approved"` for prod versions
- Inline specs + scriptsJson + metadata snapshot
- commitMessage from the user

The UI provides a version history drawer with tag filter (Dev / Prod) and rollback button.

### Rollback

```
skill.rollback(id, version, target: "dev" | "prod")
```

- Restores content from the selected version to the target content tag (`published` or `approved`)
- Restores metadata (name, description, type, labels) from the version snapshot
- Cleans up `staging` and `staging-contribution` content tags
- Resets `reviewStatus` and `contributionStatus` if they were pending
- Creates a new version record documenting the rollback

### Export / Download

```
skill.export(ids[]) -> { filename, data (base64), size }
```

- Exports selected skills as a tar.gz archive
- Single skill: `{name}-{timestamp}.tar.gz`
- Multiple skills: `skills-export-{timestamp}.tar.gz`
- UI provides a batch picker dialog in skill space (same pattern as submit/contribute)

### Delete

- **Builtin**: cannot delete, only disable (`skill.setEnabled(id, false)`)
- **Global**: after deletion, builtin skill with same name automatically "surfaces"
- **Personal/Skillset**: normal deletion. `relinkForkedFrom` ensures child skill chains are not broken.

### Per-user Enable/Disable

All skill and skill space toggles are per-user, effective across all of that user's workspaces:

| Operation | Table | Primary key |
|-----------|-------|-------------|
| `skill.setEnabled(id, enabled)` | `user_disabled_skills` | `(userId, skillId)` |
| `skillSpace.setEnabled(skillSpaceId, enabled)` | `user_disabled_skill_spaces` | `(userId, skillSpaceId)` |

---

## Skill Space

A skill space is a **shared collaboration space** for team development:

- Fork builtin/global skills into the space (batch supported)
- Move mature personal skills into the space
- Maintainers directly edit space skills
- Publish makes changes effective for space members (dev env)
- Submit + approve gates production deployment
- Contribute to global for organization-wide sharing
- Per-user enable/disable (each member independently controls whether to load)

### Membership

| Role | Can view | Can fork global to space | Can edit | Can publish | Can submit | Can contribute | Can add members | Can delete skills | Can delete space |
|------|---------|------------------------|---------|------------|-----------|---------------|----------------|------------------|-----------------|
| Owner | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes (if empty) |
| Maintainer | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | No |

### Typical workflow

```
Alice creates "pod-health-check" in My Skills
  -> edits and tests it
  -> moves to team space "SRE Tools" (skill.moveToSpace)

Carol adds 5 global skills to "SRE Tools"
  -> multi-selects from global list -> batch fork

Bob edits "pod-health-check" directly in "SRE Tools"
  -> changes saved to working copy
  -> clicks Publish -> effective for all space members in dev

Space maintainer batch-submits published skills -> admin approves -> production
Space maintainer batch-contributes approved skills -> admin approves -> Global
```

---

## Content Tags

| Tag | Purpose | Written by |
|-----|---------|-----------|
| `working` | Author's latest edits | `skill.update` |
| `published` | Dev published version (skillset); diff baseline (personal) | `skill.publishInSpace`, fork baseline |
| `approved` | Prod approved version (all scopes) | `skill.approveSubmit`, fork baseline |
| `staging` | Submit review snapshot | `skill.submit` |
| `staging-contribution` | Contribute review snapshot | `skill.contribute` |

Personal skills use `published` as a diff baseline (set during fork). Dev bundle uses `working` directly.

## Version Fields

| Field | Purpose | Set by |
|-------|---------|--------|
| `publishedVersion` | Dev published version (skillset); fork baseline version (personal) | `skill.publishInSpace`, fork |
| `approvedVersion` | Prod approved version (all scopes) | `skill.approveSubmit`, fork |
| `stagingVersion` | Optimistic concurrency for reviews | `skill.submit`, `skill.contribute` |

## Content Hash

SHA-256 of `specs + sorted scripts` (scripts sorted by name for order-independence). Stored in `skill_contents.content_hash`, auto-computed on every save.

Used by:
- `hasUnpublishedSkillChanges`: working hash vs published/approved hash
- `computeCanSubmit`: published hash vs approved hash + metadata comparison
- `computeCanContribute`: approved hash vs global published hash + metadata comparison
- `builtin-sync.ts`: detect content changes on startup

---

## Two Separate Chains

### Management Chain (Gateway API + DB)

Handles skill CRUD, sharing, and review. **No filesystem directories involved.**

```
skills table
  id, name, scope, authorId, skillSpaceId,
  originId, forkedFromId, contentHash, labelsJson,
  publishedVersion, approvedVersion, stagingVersion,
  reviewStatus, contributionStatus, commitMessage, ...

skill_contents table
  skillId, tag ("working"|"staging"|"staging-contribution"|"published"|"approved"),
  specs, scriptsJson, contentHash
  Unique index on (skillId, tag)

user_disabled_skills table
  userId, skillId (per-user skill enable/disable)

user_disabled_skill_spaces table
  userId, skillSpaceId (per-user space enable/disable)
```

### Execution Chain (AgentBox materialize -> disk -> agent)

```
Gateway (buildSkillBundle)
  -> reads skill_contents for all scopes from DB (including builtin)
  -> priority order: personal > skillset > global > builtin
  -> dedup by dirName (first wins), logs warning on collision
  -> skips per-user disabled skills and disabled skill spaces
  -> generates dirName slug from name at runtime
  -> builds SkillBundlePayload { skills: [{ dirName, scope, specs, scripts }] }

AgentBox (materialize)
  -> builds resolved/ directory with priority-based merging (first dirName wins):
      1. Personal skills
      2. Skillset skills
      3. Global skills
      4. Builtin skills
  -> Agent loads all skills from the single resolved/ directory
```

### K8s vs Local mode

| Mode | resolved/ location | Written by |
|------|-------------------|-----------|
| K8s (single-user pod) | `.siclaw/skills/resolved/` | `resource-handlers.ts materialize()` |
| Local (multi-user process) | `.siclaw/skills/user/{userId}/resolved/` | `local-spawner.ts syncSkills()` |

---

## Bundle Inclusion Rules

| Scope | Dev bundle | Prod bundle | Content tag |
|-------|-----------|-------------|-------------|
| Personal | Yes (working) | Only if `approvedVersion` exists | dev: working, prod: approved |
| Skillset | Only if `publishedVersion` exists | Only if `approvedVersion` exists | dev: published, prod: approved |
| Global | Yes | Yes | published |
| Builtin | Yes (unless disabled) | Yes (unless disabled) | published |

Per-user disabled skills and disabled skill spaces are excluded from all bundles.

---

## Builtin Skill Sync

Gateway startup executes `syncBuiltinSkills()`:

```
Scans skills/core/ + skills/extension/
  -> parses SKILL.md + scripts + meta.json labels for each skill
  -> computes content hash (SHA-256)
  -> compares with DB:
    - new -> INSERT (id = "builtin:<dirName>"), creates base version record
    - content hash changed -> UPDATE, creates version record
    - unchanged -> skip
    - in DB but not on disk -> DELETE
```

Startup fix-ups:
- Backfills null `originId` on global skills (inherits from forkedFromId chain)
- Backfills null `tag` on version records (infers from commitMessage)
- Creates missing version records for builtins and globals

---

## Skill Execution

### local_script Tool

The `local_script` tool (`src/tools/script-exec/local-script.ts`) is the primary execution path:

1. **Path resolution**: `resolveSkillScript(skill, script)` searches scope directories
   in priority order (personal > skillset > global > builtin)
2. **Interpreter selection**: `.py` -> `python3`, `.sh` -> `bash`
3. **Execution**: `child_process.spawn()` with args array (no shell interpolation)
4. **Security**: runs as `sandbox` user (OS-level isolation), inherits sanitized environment
5. **Limits**: 300s max timeout, 10 MB max output

### Bash Fallback

The `restricted-bash` tool also allows skill script execution. `isSkillScript()` resolves the
target path and allows scripts rooted under the repo `skills/` tree or the configured dynamic
`skillsDir`, including materialized `skillset` scripts.
This is a secondary path -- `local_script` is preferred.

---

## Skill Discovery by Agent

### How the Agent Sees Skills

`agent-factory.ts` loads skills from a single `resolved/` directory built by materialize (K8s)
or syncSkills (local). The directory contains all skills flattened with priority:
personal > skillset > global > builtin.

```typescript
// Local mode: per-user resolved dir at {skillsBase}/user/{userId}/resolved/
// K8s mode: {skillsBase}/resolved/
const resolvedSkillsDir = opts?.userId
  ? path.join(skillsBase, "user", opts.userId, "resolved")
  : path.join(skillsBase, "resolved");

// Fallback: if resolved/ doesn't exist yet (first boot, TUI mode),
// load builtin directories directly (skills/core/ + skills/extension/)
```

The resolved directory is passed to `DefaultResourceLoader` via `additionalSkillPaths`.
The loader auto-discovers skills by scanning for `SKILL.md` files, parsing frontmatter,
and injecting descriptions into the system prompt. The agent then knows which skills are
available and can invoke them via `local_script`.

### Deep Search Sub-Agents

Sub-agents in `src/tools/workflow/deep-search/sub-agent.ts` load skills separately:

```typescript
const { skills: coreSkills } = loadSkillsFromDir({ dir: "skills/core" });
const { skills: extSkills }  = loadSkillsFromDir({ dir: "skills/extension" });
```

This gives sub-agents access to builtin skills without depending on the bundle.

---

## Database Schema

| Table | Purpose |
|-------|---------|
| `skills` | Skill metadata: name, scope, dirName, authorId, skillSpaceId, originId, forkedFromId, contentHash, labelsJson, publishedVersion, approvedVersion, stagingVersion, reviewStatus, contributionStatus, commitMessage, globalSourceSkillId, globalPinnedVersion |
| `skill_contents` | File content (specs + scriptsJson + contentHash) by tag (working / staging / staging-contribution / published / approved). Unique index on (skillId, tag). CHECK constraint enforces valid tags. |
| `skill_versions` | Version history: version number, specs, scriptsJson, tag (published/approved), commitMessage, authorId |
| `skill_reviews` | AI + admin review records: reviewerType (ai/admin), riskLevel, summary, findings[], decision (approve/reject/info) |
| `skill_votes` | User upvotes/downvotes on global skills |
| `skill_spaces` | Skill space metadata: name, description, ownerId |
| `skill_space_members` | Space membership: userId, skillSpaceId, role (owner/maintainer) |
| `user_disabled_skills` | Per-user skill disabling: userId, skillId |
| `user_disabled_skill_spaces` | Per-user skill space disabling: userId, skillSpaceId |
| `workspace_skills` | Workspace-scoped skill assignments (schema exists, not yet enforced) |

---

## API Reference

### Skill CRUD

| RPC Method | Purpose |
|-----------|---------|
| `skill.create` | Create personal skill (cross-origin name conflict check) |
| `skill.update` | Edit personal or skillset skill (cross-origin name conflict on rename) |
| `skill.delete` | Delete personal or skillset skill (builtin cannot be deleted) |
| `skill.get` | Get skill details (any scope) |
| `skill.list` | List skills (with scope/workspace filtering, enriched with canSubmit/canContribute/hasUnpublishedChanges) |
| `skill.setEnabled` | Per-user enable/disable a skill (by skillId, resolves name to id for backward compat) |
| `skill.updateLabels` | Update skill labels |

### Fork & Share

| RPC Method | Purpose |
|-----------|---------|
| `skill.fork` | Fork builtin/global to personal or skillset. Batch via `sourceIds[]`. Inherits approved state. Rejects if same-source skill already exists. |
| `skill.moveToSpace` | Move personal skill to skill space (destructive, resets lifecycle, rejects same-origin/name conflicts) |
| `skill.publishInSpace` | Publish skillset skill: working -> published + version (dev only) |
| `skill.forkDiff` | Preview diff before forking into a skill space |

### Submit (production review)

| RPC Method | Purpose |
|-----------|---------|
| `skill.submit` | Submit for production review. Batch via `ids[]` |
| `skill.approveSubmit` | Approve submit -> production |
| `skill.rejectSubmit` | Reject submit -> back to draft |
| `skill.withdrawSubmit` | Withdraw pending submit |

### Contribute (promote to Global)

| RPC Method | Purpose |
|-----------|---------|
| `skill.contribute` | Contribute to global (cross-origin conflict check). Batch via `ids[]` |
| `skill.approveContribute` | Approve contribution -> promote to global |
| `skill.rejectContribute` | Reject contribution |
| `skill.withdrawContribute` | Withdraw pending contribution |

### Diff, History & Rollback

| RPC Method | Purpose |
|-----------|---------|
| `skill.previewDiff` | Preview diff before publish/submit/contribute (metadata + file diffs) |
| `skill.diff` | View diff between versions |
| `skill.history` | List version history with optional tag filter (published/approved) |
| `skill.rollback` | Rollback to previous version (restores content + metadata, cleans staging) |
| `skill.export` | Download skills as tar.gz (batch via `ids[]`) |

### Other

| RPC Method | Purpose |
|-----------|---------|
| `skill.vote` | Upvote/downvote global skills |
| `skill.revert` | Revert global skill to builtin version |
| `skill.getReview` | Get AI/admin review results |
| `skill.review` | Backward-compat dispatcher -> routes to approveSubmit/rejectSubmit/approveContribute/rejectContribute |
| `skill.withdraw` | Backward-compat dispatcher -> routes to withdrawSubmit/withdrawContribute |

### Skill Space

| RPC Method | Purpose |
|-----------|---------|
| `skillSpace.create` | Create skill space |
| `skillSpace.get` | Get space with members and skills (enriched with canSubmit/canContribute/hasUnpublishedChanges) |
| `skillSpace.list` | List all spaces for user |
| `skillSpace.update` | Update space name/description (owner only) |
| `skillSpace.delete` | Delete empty space (owner only) |
| `skillSpace.addMember` | Add maintainer to space |
| `skillSpace.removeMember` | Remove member (owner) or leave (self) |
| `skillSpace.listMembers` | List space members |
| `skillSpace.setEnabled` | Per-user enable/disable a skill space |

---

## Key Files

```
Execution & Resolution
  src/tools/script-exec/local-script.ts      local_script tool (primary execution path)
  src/tools/script-exec/node-script.ts       node_script tool (K8s node execution)
  src/tools/script-exec/pod-script.ts        pod_script tool (K8s pod execution)
  src/tools/infra/script-resolver.ts         Skill path resolution, scope priority
  src/tools/cmd-exec/restricted-bash.ts      Bash whitelist (isSkillScript)

Gateway Skills Management
  src/gateway/skills/file-writer.ts          Disk I/O: read, write, scan, snapshot
  src/gateway/skills/skill-bundle.ts         buildSkillBundle() -- priority-ordered packaging with dedup
  src/gateway/skills/script-evaluator.ts     Security review (static + AI)
  src/gateway/skills/builtin-sync.ts         Builtin skill sync + label loading + startup fix-ups
  src/gateway/rpc-methods.ts                 All skill.* and skillSpace.* RPC handlers

DB Repositories
  src/gateway/db/repositories/skill-repo.ts          Skill metadata CRUD
  src/gateway/db/repositories/skill-content-repo.ts  Content by tag, content hash
  src/gateway/db/repositories/skill-version-repo.ts  Version history
  src/gateway/db/repositories/skill-space-repo.ts    Space membership, per-user toggles

Agent Integration
  src/core/agent-factory.ts                  Skill directory setup, resolved/ loading, additionalSkillPaths
  src/tools/workflow/deep-search/sub-agent.ts  Sub-agent skill loading

Sync & Materialization
  src/agentbox/resource-handlers.ts          skillsHandler.materialize() (K8s)
  src/gateway/agentbox/local-spawner.ts      syncSkills() (local mode)

Frontend
  portal-web/src/pages/Skills.tsx          My Skills + Global tab
  portal-web/src/pages/SkillDetail.tsx     Skill space / editor / diff / history
  portal-web/src/pages/SkillImport.tsx     Skill import flow
  portal-web/src/components/chat/SkillPanel.tsx  Skill selector in chat
  portal-web/src/components/chat/SkillCard.tsx   Skill card presentation

Tests
  src/gateway/skills/skill-lifecycle.test.ts  91 comprehensive RPC handler tests

Filesystem Layout
  skills/core/                               Builtin core skills (Docker-baked)
  skills/extension/                          Builtin extension skills (inner project overlay)
  .siclaw/skills/resolved/                   Materialized skills -- all scopes merged (K8s)
  .siclaw/skills/user/{userId}/resolved/     Materialized skills -- per-user (local mode)
```
