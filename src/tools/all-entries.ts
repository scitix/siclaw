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
import { registration as investigationFeedback } from "./query/investigation-feedback.js";
import { registration as clusterList } from "./query/cluster-list.js";
import { registration as clusterProbe } from "./query/cluster-probe.js";
import { registration as clusterInfo } from "./query/cluster-info.js";
import { registration as hostList } from "./query/host-list.js";
// knowledge_search removed — replaced by LLM Wiki (Read tool + .siclaw/knowledge/)
import { registration as resolvePodNetns } from "./query/resolve-pod-netns.js";
import { registration as memorySearch } from "./query/memory-search.js";
import { registration as memoryGet } from "./query/memory-get.js";
// workflow
import { registration as deepSearch } from "./workflow/deep-search/tool.js";
import { registration as saveFeedback } from "./workflow/save-feedback.js";
import { registration as manageSchedule } from "./workflow/manage-schedule.js";
import { registration as taskReport } from "./workflow/task-report.js";
import { registration as skillPreview } from "./workflow/skill-preview.js";

// Total: 21 entries (knowledge_search removed — LLM Wiki uses Read tool)
export const allToolEntries: ToolEntry[] = [
  // ── cmd-exec ──
  nodeExec, podExec, restrictedBash, hostExec,
  // ── script-exec ──
  nodeScript, podScript, localScript, hostScript,
  // ── query ──
  investigationFeedback, clusterList, clusterProbe, clusterInfo, hostList,
  resolvePodNetns, memorySearch, memoryGet,
  // ── workflow ──
  deepSearch, saveFeedback, manageSchedule, taskReport, skillPreview,
];
