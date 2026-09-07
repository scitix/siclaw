# Native narration implementation and verification

## Delivered

- Removed `_siclaw_progress` schema wrapping, Brain extraction, generated tool-intent paragraphs and the web progress_update handler. Normal conversation instructions remain; tools contain only execution arguments.
- Runtime preserves individual public text blocks and provider phases with started/delta/completed item events. Each persisted row retains its identity, signature and actual model source. Only non-commentary output contributes to the final-result selection; unclassified legacy output remains compatible.
- History export and reconstruction preserve native item metadata, including through real SessionManager storage. The frontend updates by item identity and sequence during streaming, completion and polling; it ignores the duplicate body on native-marked legacy events.
- API forwarding stamps a copy of each native event with the real executor. Existing handoff boundaries, expandable commands and whole-process folding remain.
- Updated OpenAPI, developer contract and Chinese/English product documentation. The source audit records why this replaces the prior fallback.

## Evidence

- Runtime: 224 distinct tests passed across targeted and expanded checks; one existing placeholder test skipped. Coverage includes prompts, Brain, persistence, multiple text phases, two-tool batches, history export/rebuild, stop handling and model prompt wiring. The final target worktree passed 77 tests including all three Git-index-dependent AgentBox image-boundary checks. Runtime `tsc --noEmit` passed.
- Frontend: 78 tests across event attribution, message merging and process rendering/interaction passed. Whole-project typecheck still has the same five unrelated errors (script version state, MCP version type, workflow Markdown plugin and two attachment test fixtures).
- Go proxy/agentroute tests with `-race` passed, including concurrent forwarding of all three native item event types.
- Real GPT `gpt-5.6-sol`, Responses/high, user-authorized endpoint, synthetic inventory tools: two tool batches each preceded by ordinary model-authored text; both progress items carry commentary; one final_answer. No extra narration parameter or summary-model call. Original Chat Completions/off attempt returned a 400 requiring Responses or explicit reasoning_effort=none; no production configuration was changed.
- Real public event replay in existing frontend components passed Playwright: two visible progress paragraphs, command output expansion, completed process folding/reopening, exactly one final answer, mobile no-overflow, zero browser errors.

Screenshots:

- `/Users/lrli/.codex/visualizations/2026/09/07/01a07aa9-107c-72a0-9c4f-234ddfe9f2b9/native-narration-running.png`
- `/Users/lrli/.codex/visualizations/2026/09/07/01a07aa9-107c-72a0-9c4f-234ddfe9f2b9/native-narration-completed.png`
- `/Users/lrli/.codex/visualizations/2026/09/07/01a07aa9-107c-72a0-9c4f-234ddfe9f2b9/native-narration-mobile.png`

## Limits

Not deployed. The live model test used fictional data and a short public prompt, not production agent configuration, cluster access or live cross-agent handoff. It demonstrates native narration through the real engine and transport; it does not establish that all tasks match Codex's execution quality. The public Codex protocol/core/TUI were the reference, not unavailable desktop frontend source.
