/**
 * AI Check Orchestrator
 *
 * Calls gpt-5-nano (JSON mode) with the build diff + check registry descriptions
 * to decide which agent-selected checks should run for a given build.
 *
 * Always-on checks are forced to run=true regardless of AI output.
 * On-demand checks are forced to run=false unless explicitly triggered.
 */
import { openai } from "@workspace/integrations-openai-ai-server";
import type { BuilderFile } from "../builder";
import type { CheckFinding, CheckRunStatus } from "@workspace/db";
import { logger } from "../logger";
import { CHECK_REGISTRY, getAlwaysOnChecks, getAgentSelectedChecks } from "./registry";
import { runSecretLeakCheck } from "./secret-leak";
import { runCodeQualityCheck } from "./code-quality";
import { runSastCheck } from "./sast";
import { runSyntaxCheck } from "./syntax-checker";
import {
  runAccessibilityCheck,
  runSeoCheck,
  runPerformanceCheck,
  runCdnSecurityCheck,
} from "./auditor-adapter";
import { runSemgrepCheck } from "./semgrep";
import { runPrivacyCheck } from "./privacy";

export type CheckSelectionItem = {
  checkName: string;
  run: boolean;
  reason: string;
};

export type RunResult = {
  checkName: string;
  status: CheckRunStatus;
  findings: CheckFinding[];
  aiReason: string;
};

export type OrchestratorResult = {
  runs: RunResult[];
  checkSummary: string;
};

type BuildDiffSummary = {
  filesAdded: string[];
  filesModified: string[];
  filesRemoved: string[];
};

/**
 * Ask the AI which agent-selected checks to run for this build.
 * Falls back to running all agent-selected checks if the AI call fails.
 */
async function selectChecks(
  diff: BuildDiffSummary,
  buildSummary: string,
  projectKind: string,
): Promise<CheckSelectionItem[]> {
  const agentSelectedChecks = getAgentSelectedChecks();

  const registryDescription = agentSelectedChecks
    .map((c) => `- ${c.name} (${c.category}): ${c.description}`)
    .join("\n");

  const diffText = [
    diff.filesAdded.length > 0 ? `Files added: ${diff.filesAdded.join(", ")}` : "",
    diff.filesModified.length > 0 ? `Files modified: ${diff.filesModified.join(", ")}` : "",
    diff.filesRemoved.length > 0 ? `Files removed: ${diff.filesRemoved.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const systemPrompt = `You are a build quality orchestrator. Given a list of code changes and available checks, decide which checks are relevant to run.
Return ONLY valid JSON — no prose, no markdown.
Output: { "checks": [ { "checkName": string, "run": boolean, "reason": string } ] }
The reason should be a single sentence (max 15 words) explaining why you selected or skipped the check.`;

  const userPrompt = `Project kind: ${projectKind}
Build summary: ${buildSummary.slice(0, 300)}

Changes:
${diffText || "No file changes (full build)"}

Available checks to evaluate:
${registryDescription}

Decide which checks to run. Be selective — skip checks unrelated to what changed.`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-5-nano",
      max_completion_tokens: 800,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as { checks?: CheckSelectionItem[] };

    if (Array.isArray(parsed.checks) && parsed.checks.length > 0) {
      const validNames = new Set(agentSelectedChecks.map((c) => c.name));
      return parsed.checks
        .filter(
          (c) =>
            typeof c.checkName === "string" &&
            typeof c.run === "boolean" &&
            typeof c.reason === "string" &&
            validNames.has(c.checkName),
        )
        .map((c) => ({
          checkName: c.checkName,
          run: c.run,
          reason: c.reason.slice(0, 120),
        }));
    }
  } catch (err) {
    logger.warn(
      { err },
      "AI check selection failed — falling back to running all agent-selected checks",
    );
  }

  return agentSelectedChecks.map((c) => ({
    checkName: c.name,
    run: true,
    reason: "AI selection unavailable — running all agent-selected checks as fallback.",
  }));
}

/**
 * Generate a one-line check summary for the task report.
 */
function buildCheckSummary(runs: RunResult[]): string {
  const passed = runs.filter((r) => r.status === "pass").length;
  const warnings = runs.filter((r) => r.status === "warning").length;
  const failed = runs.filter((r) => r.status === "fail").length;
  const skipped = runs.filter((r) => r.status === "skipped").length;

  const parts: string[] = [];
  if (passed > 0) parts.push(`${passed} passed`);
  if (warnings > 0) parts.push(`${warnings} warning${warnings !== 1 ? "s" : ""}`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (skipped > 0) parts.push(`${skipped} skipped`);

  return parts.join(" · ") || "No checks ran";
}

async function runCheckByName(
  name: string,
  files: BuilderFile[],
): Promise<{ status: CheckRunStatus; findings: CheckFinding[] }> {
  switch (name) {
    case "syntax": {
      const r = runSyntaxCheck(files);
      return { status: r.status, findings: r.findings };
    }
    case "secret-leak": {
      const r = runSecretLeakCheck(files);
      return { status: r.status, findings: r.findings };
    }
    case "code-quality": {
      const r = runCodeQualityCheck(files);
      return { status: r.status, findings: r.findings };
    }
    case "sast": {
      const r = runSastCheck(files);
      return { status: r.status, findings: r.findings };
    }
    case "semgrep-sast": {
      const r = await runSemgrepCheck(files);
      return { status: r.status, findings: r.findings };
    }
    case "accessibility": {
      const r = runAccessibilityCheck(files);
      return { status: r.status, findings: r.findings };
    }
    case "seo": {
      const r = runSeoCheck(files);
      return { status: r.status, findings: r.findings };
    }
    case "performance": {
      const r = runPerformanceCheck(files);
      return { status: r.status, findings: r.findings };
    }
    case "cdn-security": {
      const r = runCdnSecurityCheck(files);
      return { status: r.status, findings: r.findings };
    }
    case "privacy": {
      const r = runPrivacyCheck(files);
      return { status: r.status, findings: r.findings };
    }
    default:
      return { status: "skipped", findings: [] };
  }
}

/**
 * Main orchestration entry point.
 * Selects checks via AI, runs them in parallel, and returns all results.
 */
export async function runOrchestration(
  files: BuilderFile[],
  diff: BuildDiffSummary,
  buildSummary: string,
  projectKind: string,
  onDemandChecks?: string[],
): Promise<OrchestratorResult> {
  const alwaysOnChecks = getAlwaysOnChecks();

  const selections = await selectChecks(diff, buildSummary, projectKind);

  const selectionMap = new Map<string, CheckSelectionItem>(selections.map((s) => [s.checkName, s]));

  const allCheckNames = [
    ...new Set([
      ...alwaysOnChecks.map((c) => c.name),
      ...CHECK_REGISTRY.filter((c) => c.trigger === "agent-selected").map((c) => c.name),
    ]),
  ];

  const checkTasks = allCheckNames.map(async (name) => {
    const def = CHECK_REGISTRY.find((c) => c.name === name);
    const selection = selectionMap.get(name);

    let shouldRun: boolean;
    let reason: string;

    if (!def) {
      shouldRun = false;
      reason = "Unknown check — skipped.";
    } else if (def.trigger === "always") {
      shouldRun = true;
      reason = "Always-on check — runs after every build.";
    } else if (onDemandChecks && onDemandChecks.includes(name)) {
      shouldRun = true;
      reason = "Triggered by on-demand security review.";
    } else if (def.trigger === "on-demand") {
      shouldRun = false;
      reason = "On-demand only — not triggered.";
    } else {
      shouldRun = selection?.run ?? true;
      reason = selection?.reason ?? "Included by default.";
    }

    if (!shouldRun) {
      return {
        checkName: name,
        status: "skipped" as CheckRunStatus,
        findings: [] as CheckFinding[],
        aiReason: reason,
      };
    }

    try {
      const result = await runCheckByName(name, files);
      return {
        checkName: name,
        status: result.status,
        findings: result.findings,
        aiReason: reason,
      };
    } catch (err) {
      logger.warn({ err, checkName: name }, "Check failed — marking as skipped");
      return {
        checkName: name,
        status: "skipped" as CheckRunStatus,
        findings: [] as CheckFinding[],
        aiReason: `Check errored: ${err instanceof Error ? err.message : "unknown error"}`,
      };
    }
  });

  const runs = await Promise.all(checkTasks);
  const checkSummary = buildCheckSummary(runs);

  return { runs, checkSummary };
}

/**
 * Run a specific set of checks on demand (triggered by user security review request).
 */
export async function runOnDemandChecks(
  files: BuilderFile[],
  checkNames: string[],
): Promise<RunResult[]> {
  const tasks = checkNames.map(async (name) => {
    try {
      const result = await runCheckByName(name, files);
      return {
        checkName: name,
        status: result.status,
        findings: result.findings,
        aiReason: "Triggered by on-demand security review.",
      };
    } catch (err) {
      logger.warn({ err, checkName: name }, "On-demand check failed");
      return {
        checkName: name,
        status: "skipped" as CheckRunStatus,
        findings: [] as CheckFinding[],
        aiReason: `Check errored: ${err instanceof Error ? err.message : "unknown error"}`,
      };
    }
  });

  return Promise.all(tasks);
}
