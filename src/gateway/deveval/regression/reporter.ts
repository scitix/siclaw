/**
 * Regression Reporter — renders CaseResult[] into a markdown report.
 */

import type { CaseResult } from "./runner.js";

export interface ReportMeta {
  runId: string;
  startedAt: string;
  finishedAt: string;
  agentVersion?: string;
  modelProvider?: string;
  modelId?: string;
}

export function renderReport(results: CaseResult[], meta: ReportMeta): string {
  const pass = results.filter(r => r.outcome === "PASS").length;
  const fail = results.filter(r => r.outcome === "FAIL").length;
  const skip = results.filter(r => r.outcome === "SKIP").length;
  const error = results.filter(r => r.outcome === "ERROR").length;
  const totalMs = results.reduce((s, r) => s + r.durationMs, 0);

  const overall = fail === 0 && error === 0 ? "✅ PASS" : "❌ FAIL";

  const lines: string[] = [];
  lines.push(`# 回归测试报告 — ${meta.finishedAt}`);
  lines.push("");
  lines.push(`**整体结果**: ${overall}`);
  lines.push("");
  lines.push(`| 字段 | 值 |`);
  lines.push(`|---|---|`);
  lines.push(`| Run ID | \`${meta.runId}\` |`);
  lines.push(`| 开始时间 | ${meta.startedAt} |`);
  lines.push(`| 结束时间 | ${meta.finishedAt} |`);
  lines.push(`| 总耗时 | ${formatDuration(totalMs)} |`);
  if (meta.agentVersion) lines.push(`| Agent 版本 | ${meta.agentVersion} |`);
  if (meta.modelProvider) lines.push(`| 模型提供方 | ${meta.modelProvider} |`);
  if (meta.modelId) lines.push(`| 模型 ID | ${meta.modelId} |`);
  lines.push(`| 总计 | ${results.length} |`);
  lines.push(`| 通过 | ${pass} |`);
  lines.push(`| 失败 | ${fail} |`);
  lines.push(`| 跳过 | ${skip} |`);
  lines.push(`| 错误 | ${error} |`);
  lines.push("");

  lines.push(`## 汇总`);
  lines.push("");
  lines.push(`| Case | 类型 | 命令分 | 结论分 | 阈值 | 耗时 | 结果 |`);
  lines.push(`|---|---|---|---|---|---|---|`);
  for (const r of results) {
    const type = r.reproducible ? "reproducible" : "stubbed";
    const cs = r.scoreCommands != null ? String(r.scoreCommands) : "-";
    const cc = r.scoreConclusion != null ? String(r.scoreConclusion) : "-";
    const th = `${r.passThreshold.commands}/${r.passThreshold.conclusion}`;
    lines.push(
      `| \`${r.id}\` | ${type} | ${cs} | ${cc} | ${th} | ${formatDuration(r.durationMs)} | ${outcomeIcon(r.outcome)} ${r.outcome} |`,
    );
  }
  lines.push("");

  // Always list inject commands for every reproducible case — this is the
  // "before-solving" kubectl that Runner (NOT the agent) used to set up the
  // fault. Required by project spec so every case is independently reproducible.
  const reproducible = results.filter(r => r.reproducible && r.injectCommand);
  if (reproducible.length > 0) {
    lines.push(`## 故障注入命令清单`);
    lines.push("");
    lines.push(`> 以下命令由 Runner 在 agent 解题**之前**执行,agent 全程无法看到这些命令或 YAML。`);
    lines.push("");
    for (const r of reproducible) {
      lines.push(`### \`${r.id}\``);
      lines.push("");
      if (r.podName) lines.push(`- Pod: \`${r.podName}\``);
      if (r.namespace) lines.push(`- Namespace: \`${r.namespace}\``);
      lines.push("");
      lines.push("```bash");
      lines.push(r.injectCommand!);
      lines.push("```");
      if (r.injectOutput) {
        lines.push("");
        lines.push(`**注入输出**: \`${truncate(r.injectOutput, 300)}\``);
      }
      lines.push("");
    }
  }

  const problems = results.filter(r => r.outcome !== "PASS");
  if (problems.length > 0) {
    lines.push(`## 失败 / 跳过 / 错误 详情`);
    lines.push("");
    for (const r of problems) {
      lines.push(`### ${outcomeIcon(r.outcome)} \`${r.id}\` — ${r.title}`);
      lines.push("");
      lines.push(`**结果**: ${r.outcome}`);
      if (r.reason) lines.push(`**原因**: ${r.reason}`);
      if (r.podName) lines.push(`**Pod 名**: \`${r.podName}\``);
      if (r.namespace) lines.push(`**Namespace**: \`${r.namespace}\``);
      if (r.workOrderDifficulty) lines.push(`**工单难度**: ${r.workOrderDifficulty}`);
      if (r.workOrderText) {
        lines.push(`**工单**:`);
        lines.push("");
        lines.push(`> ${r.workOrderText}`);
      }
      if (r.injectCommand) {
        lines.push(`**故障注入命令**: 见上文 "故障注入命令清单 → \`${r.id}\`"`);
      }
      if (r.scoreReasoning) {
        lines.push("");
        lines.push(`**评分理由**:`);
        lines.push("");
        lines.push(`> ${r.scoreReasoning}`);
      }
      if (r.expectedAnswer) {
        lines.push("");
        lines.push(`**期望结论**:`);
        lines.push("");
        lines.push(`\`\`\``);
        lines.push(r.expectedAnswer);
        lines.push(`\`\`\``);
      }
      if (r.agentResponse) {
        lines.push("");
        lines.push(`**Agent 实际结论**:`);
        lines.push("");
        lines.push(`\`\`\``);
        lines.push(truncate(r.agentResponse, 4000));
        lines.push(`\`\`\``);
      }
      if (r.agentCommands && r.agentCommands.length > 0) {
        lines.push("");
        lines.push(`**Agent 执行的命令**:`);
        lines.push("");
        lines.push(`\`\`\``);
        for (const c of r.agentCommands) lines.push(c);
        lines.push(`\`\`\``);
      }
      if (r.injectOutput) {
        lines.push("");
        lines.push(`**注入输出**: \`${truncate(r.injectOutput, 200)}\``);
      }
      lines.push("");
      lines.push(`---`);
      lines.push("");
    }
  }

  return lines.join("\n") + "\n";
}

function outcomeIcon(o: CaseResult["outcome"]): string {
  switch (o) {
    case "PASS": return "✅";
    case "FAIL": return "❌";
    case "SKIP": return "⏭️";
    case "ERROR": return "⚠️";
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n...[truncated ${s.length - max} chars]`;
}
