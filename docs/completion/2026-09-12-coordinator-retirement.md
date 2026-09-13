# Coordinator and peer delegation retirement

Date: 2026-09-12. Baseline: `origin/main` at `946e0675227438439b2ba86dfaa7bd1d65e244fe`, fetched before creating the isolated worktree. Branch: `codex/assess-coordinator-removal`.

## Delivered behavior

Cross-Agent collaboration uses conversation handoff. Remove the Coordinator registry entry and prompt, peer roster configuration and invalidation, the `delegate_agents` capability, `delegate_to_agent`, `list_delegates`, `report_findings`, private HTTP/A2A transports, peer execution parameters, terminal ledger, unused shutdown hooks and delegation smoke scripts. Portal no longer exposes the retired type or roster controls.

Portal refuses creation, modification, reactivation and forks of the retired type. Runtime and AgentBox reject old peer execution requests before creating or persisting a session. Historical peer target metadata no longer grants callback write access. Database migration disables remaining retired instances and drops the roster table while preserving historical sessions and messages.

Conversation handoff, same-Agent subagents, scheduled jobs and historical transcript/trace readers remain supported. Shared `delegation_id` fields and the `delegation-events` persistence API remain in use by subagents, plans and background jobs. Handoff authorization and the restriction against subagents transferring the main conversation remain in place.

See the [design and compatibility boundary](../design/2026-09-12-coordinator-retirement-assessment.md).

## Validation

| Check | Result |
|---|---|
| `npx vitest run --reporter=dot` | 361 files passed; 7353 tests passed, 2 skipped, rerun after the staging fix |
| `npx tsc --noEmit` | Passed |
| `npx tsc --noEmit -p tsconfig.agentbox.json` | Passed |
| `npm run build` | Passed |
| Portal `npx vitest run --reporter=dot` | 31 files and 271 tests passed |
| Portal `npx tsc --noEmit` and Vite build | Passed |

Regression coverage includes handoff, cancellation and shutdown, subagents, callback ownership, rejection of retired request formats, Portal type validation, SQLite migration and historical transcript access. The dependency versions and lockfiles are unchanged.

## Staging acceptance

The first live handoff check found that removing peer registrations had also removed `transfer_to_agent`, `search_handoff_targets`, `request_input` and `channel_update` from shared array lines. Restore all four registrations. A new regression test resolves the complete production registry, executes an authorized handoff and checks input/channel tools; both new cases fail before the fix and pass afterward. The final registry removes exactly the three retired peer tools.

Rebuilt and deployed Linux amd64 Runtime and AgentBox images after the fix. With a compatible control plane, real streaming checks passed for ordinary chat, destination discovery followed by ownership transfer, and a same-Agent foreground subagent. Persistence checks confirm the original entry Agent remains on the logical session, its active Agent changes to the receiver, one handoff audit row is written, and the receiver's answer is stored. The subagent used the `fast` tier with `gpt-5.6-luna`, produced `42`, and retained its child-session/parent link with no child tool calls. An earlier model-generated invalid task template was rejected before execution; the successful check used the documented single-item form.

## Deployment boundary

Staging was deployed from the worktree source snapshot. Production was not deployed. Live handoff used one active Runtime; multi-Runtime behavior remains covered by automated tests rather than this live check. The standalone Portal was validated by its tests and build, not a separate live deployment. Restoring the retired workflow requires restoring its old configuration and data separately.

## Pre-merge review fixes

- Replace obsolete harness references to deleted peer tools/transports and acknowledge the complete-registry regression. Preserve the explanation for historical orphan traces.
- Use a shared `AGENT_RETIRED` error detail (410, non-retriable) in normalization, Portal REST and peer-request rejection. HTTP/JSON/RPC round-trip tests and the Web error client preserve the same fields and message.
- Read the stored type on every Agent PUT, including name/description-only and empty bodies; keep 404 and change-driven reload behavior. Script authorization rejects retired types independently of active/disabled status.
- Show retired instances explicitly in the list and a read-only settings view. Remove targetAgentId from the ownership cache while retaining durable historical lineage and provenance/invalidation behavior.
- Clean retired capability keys on repeatable Portal migration and new writes. Use the explicit no_tools group when filtering removes the final key; null/[] group selections keep their unrestricted meaning. Display that distinction and omit untouched selections on save. Null/[] changes do not reload tools; explicitly clearing no_tools does.

Validation after these fixes: full root suite **361 files, 7354 passed, 2 skipped**; Portal **33 files, 274 passed**; root/AgentBox TypeScript, root build and Portal TypeScript/Vite build passed. Tests include a real settings Save interaction and repeated SQLite upgrades after the original migration, with only-retired/mixed/null/empty/future/malformed capability configurations.

The staging and Linux image acceptance above applies to the earlier removal snapshot. These review fixes have not been redeployed or rebuilt as container images; their AgentBox import stays within the shared image boundary and the full boundary tests/typecheck pass.

## Capability cleanup correction

The first review fix confused a capability-group array with a concrete tool whitelist. Reproducing its actual encode → parse → resolve path yields stored `[]` and `allowedTools: null`, which is unrestricted. The corrected path yields stored `["no_tools"]` and `allowedTools: []`. The resolver's null/empty compatibility behavior and tool-append's null semantics are unchanged. Mixed selections keep their surviving keys; no_tools adds no tools and does not veto other selected groups.

Coverage now follows encoded and migrated values through parsing, Custom type resolution and capability resolution. Runtime internal API tests verify the concrete JSON whitelist, and the production-registry test verifies command/file tools remain absent while separately authorized handoff tools survive. Portal tests check no_tools versus null/[] rendering and an unrelated Save; null/[] transitions no longer reload warm sessions. The redundant current-state optional access was removed.

The faulty cleanup snapshot was not deployed by this task. If it was applied independently, an already-written [] row no longer identifies its former selection; recover affected selections from a backup instead of converting every legitimate unrestricted [] row.

Validation: `npm test -- --maxWorkers=4` passed all 361 files (7367 passed, 2 skipped); Portal passed 33 files / 276 tests. Root and AgentBox typechecks, root build and Portal build passed. The first unconstrained full run hit timeouts in unchanged output/security and shell-script tests plus asynchronous teardown errors; the complete four-worker rerun passed with no assertion or timeout changes. These corrections have not been deployed.
