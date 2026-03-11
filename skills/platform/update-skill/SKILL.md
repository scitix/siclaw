---
name: update-skill
description: >-
  Procedure for modifying, updating, or fixing an existing Siclaw skill.
  Use the update_skill tool — never edit skill files directly.
---

# Update Skill

## When to Use

When the user's message contains `[Skill: <name>]` (UI skill editing context), or when the user asks to modify/update/fix an existing skill.

## Environments and Approval Workflow

| Environment | Behavior |
|-------------|----------|
| **Dev / Test** | Updated content (working copy) is immediately visible and testable. |
| **Production** | Only the **approved** version is active. Updates enter a staged review state; the old version remains in use until the new version is approved by an admin. |

- When scripts are changed, the update enters a **staged review** state.
- The **old version** of the skill remains usable in production during review.
- In dev/test, the working copy is available immediately for testing.

## How to Update

Call the `update_skill` tool (NOT `create_skill`) with the skill ID and the complete updated definition.

**Skill directories are read-only. All skill modifications must go through skill management tools (create_skill, update_skill, fork_skill).**

### Tool Call Format

```
update_skill({
  id: "<skill-id>",                // From [Skill: ...] context, or the skill's kebab-case name
  name: "skill-name",              // Keep original name unless user wants rename
  description: "What the skill does",
  type: "Monitoring",
  specs: "---\nname: skill-name\ndescription: >-\n  ...\n---\n\n# Skill Title\n\n## Procedure\n...",
  scripts: [                       // Optional
    { name: "run.sh", content: "#!/bin/bash\n..." },   // Changed: provide full content
    { name: "check.sh" }                                // Unchanged: name only
    // Omitted scripts are deleted
  ],
  labels: ["monitoring", "memory"] // Optional labels/tags
})
```

### Scripts Rules

| Scenario | What to pass |
|----------|-------------|
| Script content changed | `{ name: "run.sh", content: "#!/bin/bash\n# new content..." }` |
| Script unchanged | `{ name: "run.sh" }` (name only, no content) |
| Adding a new script | `{ name: "new.sh", content: "#!/bin/bash\n..." }` |
| Removing a script | Omit it from the array |

### Key Rules

1. Always provide **full** specs content (complete SKILL.md), not a diff
2. Preserve the original skill name unless the user explicitly asks to rename
3. Only change what the user asked for — don't add unnecessary modifications
4. Briefly explain your changes before calling `update_skill`
