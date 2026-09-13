# Siclaw plugin for Claude Code

Delegate SRE investigations to a hosted Siclaw agent, and brief it the
way its caller contract (v1) expects. The plugin ships two things:

- an MCP server declaration pointing at `${SICLAW_CONTROL_PLANE_URL}/api/v1/mcp` (tools:
  siclaw_investigate / wait_task / get_task / cancel_task / list_tasks), and
- the `siclaw-brief` skill, which teaches how to fill the structured brief
  (target, time_window, open_question, …) and how to read Siclaw's echo.

## Install

```bash
export SICLAW_CONTROL_PLANE_URL="https://control-plane.example.com" # origin, without a trailing slash
export SICLAW_A2A_KEY=sk-...   # your agent API key, from your control-plane self-service page
claude plugin marketplace add scitix/siclaw
claude plugin install siclaw@siclaw
```

Set the origin to the control plane that issued your Agent key. Restart Claude Code
(or open a new session). The origin and key are read from your shell environment.
An explicitly generated deployment URL takes precedence over the origin variable.

If your Claude Code build does not expand environment variables in plugin MCP
configuration, register the server directly instead and keep the skill:

```bash
claude mcp add --transport http -s user siclaw "${SICLAW_CONTROL_PLANE_URL}/api/v1/mcp" \
  --header "Authorization: Bearer $SICLAW_A2A_KEY"
```

## Codex and other clients

Copy `siclaw-brief.md` (repository root) into your skills directory
(`~/.codex/skills/siclaw-brief/SKILL.md`) or paste it into your agent's
system prompt. Register the MCP server with your client's own mechanism.

## Regenerating

This directory is generated from the control-plane contract source
(`internal/siclaw/a2a/brief`, command `go run ./tools/siclaw-plugin`). Do not
edit these files by hand; change the contract and regenerate.
