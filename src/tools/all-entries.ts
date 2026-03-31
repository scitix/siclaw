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
// script-exec
import { registration as nodeScript } from "./script-exec/node-script.js";
import { registration as podScript } from "./script-exec/pod-script.js";
import { registration as localScript } from "./script-exec/local-script.js";
// query (investigationFeedback physically in workflow/deep-search/, but kept at original position)
import { registration as investigationFeedback } from "./workflow/deep-search/investigation-feedback.js";
import { registration as credentialList } from "./query/credential-list.js";
import { registration as clusterInfo } from "./query/cluster-info.js";
import { registration as knowledgeSearch } from "./query/knowledge-search.js";
import { registration as resolvePodNetns } from "./query/resolve-pod-netns.js";
import { registration as memorySearch } from "./query/memory-search.js";
import { registration as memoryGet } from "./query/memory-get.js";
// workflow
import { registration as deepSearch } from "./workflow/deep-search/tool.js";
import { registration as saveFeedback } from "./workflow/save-feedback.js";
import { registration as manageSchedule } from "./workflow/manage-schedule.js";
import { registration as createSkill } from "./workflow/create-skill.js";
import { registration as updateSkill } from "./workflow/update-skill.js";
import { registration as forkSkill } from "./workflow/fork-skill.js";

// Total: 19 entries
export const allToolEntries: ToolEntry[] = [
  // ── cmd-exec ──
  nodeExec, podExec, restrictedBash,
  // ── script-exec ──
  nodeScript, podScript, localScript,
  // ── query ──
  investigationFeedback, credentialList, clusterInfo,
  knowledgeSearch, resolvePodNetns, memorySearch, memoryGet,
  // ── workflow ──
  deepSearch, saveFeedback, manageSchedule,
  createSkill, updateSkill, forkSkill,
];
