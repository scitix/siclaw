/**
 * All tool entries — the ordered registry of tool registrations.
 *
 * Order determines the tool list order seen by the LLM.
 * Kept consistent with the original agent-factory.ts registration order.
 */

import type { ToolEntry } from "../core/tool-registry.js";

// cmd-exec
import { registration as nodeExec } from "./cmd-exec/node-exec.js";
import { registration as podExec } from "./cmd-exec/pod-exec.js";
import { registration as restrictedBash } from "./cmd-exec/restricted-bash.js";
import { registration as hostExec } from "./cmd-exec/host-exec.js";
// script-exec
import { registration as nodeScript } from "./script-exec/node-script.js";
import { registration as podScript } from "./script-exec/pod-script.js";
import { registration as localScript } from "./script-exec/local-script.js";
import { registration as hostScript } from "./script-exec/host-script.js";
// query
import { registration as clusterList } from "./query/cluster-list.js";
import { registration as hostList } from "./query/host-list.js";
// knowledge_search removed — replaced by LLM Wiki (Read tool + .siclaw/knowledge/)
// resolve_pod_netns removed — node_exec/pod_exec/*_script auto-resolve pod→netns
// internally via pod= (shared pod-netns-resolve.ts); the standalone tool was redundant.
import { registration as memorySearch } from "./query/memory-search.js";
import { registration as memoryGet } from "./query/memory-get.js";
// workflow — investigation_feedback / deep_search / propose_hypotheses /
// end_investigation removed as part of the DP state-machine teardown
// (see docs/design/2026-04-24-dp-mode-refactor-design.md §6.6).
// Sub-agent fan-out is handled by spawn_subagent (+ job_stop) below.
import { registration as saveFeedback } from "./workflow/save-feedback.js";
import { registration as manageSchedule } from "./workflow/manage-schedule.js";
import { registration as taskReport } from "./workflow/task-report.js";
import { registration as skillPreview } from "./workflow/skill-preview.js";
import { registration as channelUpdate } from "./workflow/channel-update.js";
import { registration as reportFindings } from "./workflow/report-findings.js";
import { registration as requestInput } from "./workflow/request-input.js";
import { registration as delegateToAgent } from "./workflow/delegate-to-agent.js";
import { registration as listDelegates } from "./workflow/list-delegates.js";
import {
  taskCreateRegistration, taskUpdateRegistration, taskListRegistration, taskGetRegistration,
} from "./workflow/task-tools.js";
import { registration as spawnSubagent } from "./workflow/spawn-subagent.js";
import { registration as jobStop } from "./workflow/job-stop.js";
import { registration as taskOutput } from "./workflow/task-output.js";

export const allToolEntries: ToolEntry[] = [
  // ── cmd-exec ──
  nodeExec, podExec, restrictedBash, hostExec,
  // ── script-exec ──
  nodeScript, podScript, localScript, hostScript,
  // ── query ──
  clusterList, hostList,
  memorySearch, memoryGet,
  // ── workflow ──
  saveFeedback, manageSchedule, taskReport, skillPreview,
  channelUpdate, reportFindings, requestInput,
  taskCreateRegistration, taskUpdateRegistration, taskListRegistration, taskGetRegistration,
  spawnSubagent, jobStop, taskOutput,
  delegateToAgent, listDelegates,
];
