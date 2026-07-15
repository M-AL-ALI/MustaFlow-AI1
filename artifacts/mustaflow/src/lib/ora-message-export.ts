import type { OraMessage } from "@/hooks/use-ora-chat";
import type { DatasetAnalysisResult, ActionItem } from "@/types/dataset-analysis";

export function sanitizeFilename(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9\-_.]/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "ora-message"
  );
}

function safeContent(message: OraMessage): string {
  return message.content;
}

export function formatOraMessageForMarkdown(message: OraMessage): string {
  const role = message.role === "user" ? "You" : "Ora";
  const lines: string[] = [];
  lines.push(`**${role}:**\n`);
  lines.push(safeContent(message));
  if (message.datasetResult) {
    const r = message.datasetResult;
    if (r.keyFindings && r.keyFindings.length > 0) {
      lines.push("\n\n**Key Findings:**");
      r.keyFindings.forEach((f) => lines.push(`\n- ${f}`));
    }
    if (r.recommendations && r.recommendations.length > 0) {
      lines.push("\n\n**Recommendations:**");
      r.recommendations.forEach((rec) => lines.push(`\n- ${rec}`));
    }
    if (r.nextSteps && r.nextSteps.length > 0) {
      lines.push("\n\n**Next Steps:**");
      r.nextSteps.forEach((s) => lines.push(`\n- ${s}`));
    }
  }
  return lines.join("");
}

export function formatConversationForMarkdown(messages: OraMessage[]): string {
  const header = `# Ora Conversation\n\n---\n\n`;
  const body = messages.map((m) => formatOraMessageForMarkdown(m)).join("\n\n---\n\n");
  return header + body;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export async function copyMessageText(message: OraMessage): Promise<"ok" | "failed"> {
  const text = safeContent(message);
  try {
    await navigator.clipboard.writeText(text);
    return "ok";
  } catch {
    return "failed";
  }
}

export function downloadMessageAsMarkdown(message: OraMessage, filename?: string): void {
  const md = formatOraMessageForMarkdown(message);
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const name = filename ?? `ora-${message.role}-message.md`;
  triggerDownload(blob, sanitizeFilename(name) + ".md");
}

export function downloadDatasetReport(result: DatasetAnalysisResult, basename?: string): void {
  const lines: string[] = [];
  lines.push(`# Dataset Analysis Report\n`);
  lines.push(`**Analysis Type:** ${result.analysisType}\n`);
  lines.push(`\n## Summary\n\n${result.summary}`);

  if (result.keyFindings && result.keyFindings.length > 0) {
    lines.push(`\n\n## Key Findings\n`);
    result.keyFindings.forEach((f) => lines.push(`\n- ${f}`));
  }
  if (result.kpiGaps && result.kpiGaps.length > 0) {
    lines.push(`\n\n## KPI Gaps\n`);
    result.kpiGaps.forEach((k) =>
      lines.push(
        `\n- **${k.metric}**: current ${k.current}${k.target ? `, target ${k.target}` : ""}${k.gap ? `, gap ${k.gap}` : ""}${k.trend ? ` (${k.trend})` : ""}`,
      ),
    );
  }
  if (result.trendFindings && result.trendFindings.length > 0) {
    lines.push(`\n\n## Trends\n`);
    result.trendFindings.forEach((t) =>
      lines.push(`\n- ${t.description}${t.direction ? ` [${t.direction}]` : ""}`),
    );
  }
  if (result.paretoFindings && result.paretoFindings.length > 0) {
    lines.push(`\n\n## Pareto Findings\n`);
    result.paretoFindings.forEach((p) =>
      lines.push(
        `\n- ${p.label}: ${p.value}${p.cumPct != null ? ` (${p.cumPct}% cumulative)` : ""}`,
      ),
    );
  }
  if (result.recommendations && result.recommendations.length > 0) {
    lines.push(`\n\n## Recommendations\n`);
    result.recommendations.forEach((r) => lines.push(`\n- ${r}`));
  }
  if (result.actionPlan && result.actionPlan.length > 0) {
    lines.push(`\n\n## Action Plan\n`);
    result.actionPlan.forEach((a) =>
      lines.push(
        `\n- [${a.priority.toUpperCase()}] ${a.action}${a.owner ? ` — Owner: ${a.owner}` : ""}${a.timeline ? ` — Timeline: ${a.timeline}` : ""}`,
      ),
    );
  }
  if (result.risksAndLimitations && result.risksAndLimitations.length > 0) {
    lines.push(`\n\n## Risks & Limitations\n`);
    result.risksAndLimitations.forEach((r) => lines.push(`\n- ${r}`));
  }
  if (result.nextSteps && result.nextSteps.length > 0) {
    lines.push(`\n\n## Next Steps\n`);
    result.nextSteps.forEach((s) => lines.push(`\n- ${s}`));
  }
  const workflow = result.analystWorkflow;
  if (workflow?.chartSuggestions && workflow.chartSuggestions.length > 0) {
    lines.push(`\n\n## Suggested Charts\n`);
    workflow.chartSuggestions.forEach((chart) =>
      lines.push(
        `\n- **${chart.title}** (${chart.chartType})${chart.xColumn ? ` — X: ${chart.xColumn}` : ""}${chart.yColumn ? `, Y: ${chart.yColumn}` : ""}. ${chart.reason}`,
      ),
    );
  }
  if (workflow?.calculationSuggestions && workflow.calculationSuggestions.length > 0) {
    lines.push(`\n\n## Repeatable Calculations\n`);
    workflow.calculationSuggestions.forEach((calc) =>
      lines.push(`\n- **${calc.label}**: \`${calc.expression}\` — ${calc.description}`),
    );
  }
  if (workflow?.reportSuggestions && workflow.reportSuggestions.length > 0) {
    lines.push(`\n\n## Downloadable Reports\n`);
    workflow.reportSuggestions.forEach((report) =>
      lines.push(`\n- **${report.format.toUpperCase()}**: ${report.title} — ${report.description}`),
    );
  }

  const md = lines.join("");
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const name = basename ?? "ora-dataset-report";
  triggerDownload(blob, sanitizeFilename(name) + ".md");
}

export function downloadDatasetJson(result: DatasetAnalysisResult, basename?: string): void {
  const safe = {
    analysisType: result.analysisType,
    summary: result.summary,
    datasetProfile: result.datasetProfile,
    keyFindings: result.keyFindings,
    kpiGaps: result.kpiGaps,
    trendFindings: result.trendFindings,
    paretoFindings: result.paretoFindings,
    recommendations: result.recommendations,
    actionPlan: result.actionPlan,
    risksAndLimitations: result.risksAndLimitations,
    nextSteps: result.nextSteps,
    analystWorkflow: result.analystWorkflow,
    truncated: result.truncated,
    usedFallback: result.usedFallback,
  };
  const blob = new Blob([JSON.stringify(safe, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const name = basename ?? "ora-dataset-result";
  triggerDownload(blob, sanitizeFilename(name) + ".json");
}

export function downloadActionPlanCsv(actionPlan: ActionItem[], basename?: string): void {
  const header = "Action,Priority,Owner,Timeline";
  const rows = actionPlan.map((a) => {
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    return [esc(a.action), esc(a.priority), esc(a.owner ?? ""), esc(a.timeline ?? "")].join(",");
  });
  const csv = [header, ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const name = basename ?? "ora-action-plan";
  triggerDownload(blob, sanitizeFilename(name) + ".csv");
}

// ─── Conversation-level exports ───────────────────────────────────────────────

export function downloadConversationAsMarkdown(messages: OraMessage[], basename?: string): void {
  if (messages.length === 0) return;
  const md = formatConversationForMarkdown(messages);
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const name = basename ?? "ora-conversation";
  triggerDownload(blob, sanitizeFilename(name) + ".md");
}

function sanitizeMessageForJson(msg: OraMessage): object {
  const entry: Record<string, unknown> = {
    role: msg.role,
    content: msg.content,
  };
  if (msg.messageKind) entry.messageKind = msg.messageKind;
  if (msg.datasetResult) {
    const r = msg.datasetResult;
    // Include only public analysis fields; strip any internal refs
    entry.datasetAnalysis = {
      analysisType: r.analysisType,
      summary: r.summary,
      keyFindings: r.keyFindings,
      kpiGaps: r.kpiGaps,
      trendFindings: r.trendFindings,
      paretoFindings: r.paretoFindings,
      recommendations: r.recommendations,
      actionPlan: r.actionPlan,
      risksAndLimitations: r.risksAndLimitations,
      nextSteps: r.nextSteps,
      analystWorkflow: r.analystWorkflow,
    };
  }
  // Intentionally omit: editedFrom, hadAttachment, suggestions
  return entry;
}

export function downloadConversationAsJson(messages: OraMessage[], basename?: string): void {
  if (messages.length === 0) return;
  const payload = {
    exportedAt: new Date().toISOString(),
    messageCount: messages.length,
    messages: messages.map(sanitizeMessageForJson),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const name = basename ?? "ora-conversation";
  triggerDownload(blob, sanitizeFilename(name) + ".json");
}
