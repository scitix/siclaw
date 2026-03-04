---
name: update-skill
description: >-
  Procedure for modifying, updating, or fixing an existing Siclaw skill.
  Skills are on a read-only filesystem — use the update_skill tool,
  never edit files directly.
---

# Update Skill

## When to Use

When the user's message contains `[Editing Skill: <name> (id:<id>)]` followed by the current skill content, or when the user asks to modify/update/fix an existing skill.

## How to Update

Call the `update_skill` tool (NOT `create_skill`) with the skill ID and the complete updated definition.

**Do NOT use `read`, `edit`, `write`, or `bash` on files under `/mnt/skills/` — the filesystem is read-only.**

### Tool Call Format

```
update_skill({
  id: "<skill-id>",                // Required — from [Editing Skill: ... (id:<id>)]
  name: "skill-name",              // Keep original name unless user wants rename
  description: "What the skill does",
  type: "Monitoring",
  specs: "---\nname: skill-name\ndescription: >-\n  ...\n---\n\n# Skill Title\n\n## Procedure\n...",
  scripts: [                       // Optional
    { name: "run.sh", content: "#!/bin/bash\n..." },   // Changed: provide full content
    { name: "check.sh" }                                // Unchanged: name only
    // Omitted scripts are deleted
  ]
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
