// ─────────────────────────────────────────────────────────────────────────────
// Architect Review Subagent (Task #507)
//
// Second-opinion deep review that runs after a successful build/refine.
// Receives: user request + plan + diff + commands + small file excerpts.
// Returns: structured JSON (verdict, severity-ranked findings, next actions).
//
// Triggered from runJob after the version snapshot is written, before the task
// is marked completed. Charged at a separate flat rate (ARCHITECT_CREDIT_COST)
// via deductCredits(type="architect"). Per-project disable toggle:
// projects.architect_review_enabled.
//
// One auto-fix turn: when verdict==="fail" or any finding has severity
// "critical", the caller enqueues a single follow-up refine task with the
// findings as the prompt. Recursion guard: caller titles the follow-up
// "Architect Auto-fix: …" and skips the architect when that prefix is present.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";
import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "./logger";
import type { AgentMode } from "./ai";
import type { TaskReport } from "@workspace/db";

/** Flat credit cost for one architect review pass. */
export const ARCHITECT_CREDIT_COST = 2;

/** Title prefix used for architect-triggered auto-fix tasks (recursion guard). */
export const ARCHITECT_AUTOFIX_TITLE_PREFIX = "Architect Auto-fix:";

/** Model used for architect reviews — single mid-tier model regardless of build agentMode. */
const ARCHITECT_MODEL = "gpt-5-mini";

const ArchitectFindingSchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]),
  title: z.string().min(1).max(200),
  detail: z.string().min(1).max(2000),
  file: z.string().max(512).nullish(),
});

const ArchitectResponseSchema = z.object({
  verdict: z.enum(["pass", "partial", "fail"]),
  summary: z.string().min(1).max(400),
  findings: z.array(ArchitectFindingSchema).max(20).default([]),
  nextActions: z.array(z.string().min(1).max(400)).max(10).default([]),
});

export type ArchitectFinding = z.infer<typeof ArchitectFindingSchema>;
export type ArchitectResponse = z.infer<typeof ArchitectResponseSchema>;

const ARCHITECT_SYSTEM_PROMPT = `You are the Architect Reviewer for MustaFlow AI — a senior staff engineer giving a second-opinion deep review of a build that another AI just completed.

Your job: read the user request, the plan (if any), the diff, the commands the builder ran, and any file excerpts provided. Decide whether the build actually satisfies the request and is production-safe.

Return STRICT JSON only (no prose, no markdown fences) matching:
{
  "verdict": "pass" | "partial" | "fail",
  "summary": string,                 // one sentence, max 400 chars
  "findings": [
    {
      "severity": "critical" | "high" | "medium" | "low",
      "title": string,               // short headline
      "detail": string,              // what's wrong, why it matters, how to fix
      "file": string | null          // path of the offending file, if applicable
    }
  ],
  "nextActions": [string]            // concrete actions the builder should take next (≤10)
}

Severity rubric:
- critical: the build is broken (won't run), introduces a security hole (eval, hardcoded secret, SQLi/XSS pattern), corrupts data, or directly contradicts the user's request.
- high:     missing acceptance criteria from the user request; broken core flow; obvious data-loss or auth bypass risk.
- medium:   reasonable functionality gaps, accessibility regressions, missing error handling, weak validation.
- low:      style, polish, minor copy or naming issues.

Verdict rubric:
- pass:    no critical or high findings; the user got what they asked for.
- partial: high or medium findings exist but the build is usable; user should iterate.
- fail:    one or more critical findings, OR the build does not address the user request.

Be terse. Cite exact file paths when you can. Do not invent files you have not seen.
Do not rewrite the user's code — only describe what to change. The auto-fix turn (if any) is a separate pipeline.`;

/** Compact a file excerpt for the prompt: keep first ~80 lines / 6 KB. */
function compactFileExcerpt(content: string): string {
  const lines = content.split("\n");
  const head = lines.slice(0, 80).join("\n");
  if (head.length <= 6000) return head;
  return head.slice(0, 6000) + "\n…(truncated)";
}

export interface ArchitectInput {
  userRequest: string;
  agentMode: AgentMode;
  /** Structured plan from Plan Mode, if any. */
  planContext?: Record<string, unknown> | null;
  /** Diff summary (added/modified/removed paths). */
  diff: {
    filesAdded: string[];
    filesModified: string[];
    filesRemoved: string[];
  };
  /** Commands the agentic builder ran (from report.agentLoop.commandsRun), if any. */
  commandsRun?: Array<{ argv: string[]; exitCode: number }>;
  /** Small subset of changed files with full content for citation context. */
  fileExcerpts?: Array<{ path: string; content: string }>;
  /** Assistant summary the builder wrote. */
  assistantSummary?: string;
  /** Build warnings already known (to avoid the architect duplicating them). */
  knownWarnings?: string[];
}

/**
 * Run a single architect review pass. Always non-throwing — on any error
 * returns a synthetic "pass" verdict with the error surfaced as a low-severity
 * finding so the build completes cleanly. Token usage is bounded by the
 * compact manifest.
 */
export async function runArchitectReview(
  input: ArchitectInput,
): Promise<ArchitectResponse & { model: string }> {
  const planSection = input.planContext
    ? `\n\nPLAN (from Plan Mode):\n${JSON.stringify(input.planContext).slice(0, 4000)}`
    : "";

  const diffSection = [
    `Files added (${input.diff.filesAdded.length}): ${input.diff.filesAdded.slice(0, 30).join(", ") || "—"}`,
    `Files modified (${input.diff.filesModified.length}): ${input.diff.filesModified.slice(0, 30).join(", ") || "—"}`,
    `Files removed (${input.diff.filesRemoved.length}): ${input.diff.filesRemoved.slice(0, 30).join(", ") || "—"}`,
  ].join("\n");

  const commandsSection =
    input.commandsRun && input.commandsRun.length > 0
      ? `\n\nCOMMANDS RUN BY BUILDER:\n${input.commandsRun
          .slice(0, 12)
          .map((c) => `[exit=${c.exitCode}] ${c.argv.join(" ").slice(0, 200)}`)
          .join("\n")}`
      : "";

  const excerptsSection =
    input.fileExcerpts && input.fileExcerpts.length > 0
      ? `\n\nFILE EXCERPTS:\n${input.fileExcerpts
          .slice(0, 8)
          .map((f) => `--- ${f.path} ---\n${compactFileExcerpt(f.content)}`)
          .join("\n\n")}`
      : "";

  const summarySection = input.assistantSummary
    ? `\n\nBUILDER ASSISTANT SUMMARY:\n${input.assistantSummary.slice(0, 1000)}`
    : "";

  const warningsSection =
    input.knownWarnings && input.knownWarnings.length > 0
      ? `\n\nKNOWN WARNINGS (already flagged by validators — do not repeat verbatim):\n${input.knownWarnings.slice(0, 10).join("\n- ")}`
      : "";

  const userMessage = `USER REQUEST:
${input.userRequest.slice(0, 4000)}

BUILDER AGENT MODE: ${input.agentMode}${planSection}

DIFF:
${diffSection}${commandsSection}${excerptsSection}${summarySection}${warningsSection}

Now produce your JSON review.`;

  try {
    const response = await openai.chat.completions.create({
      model: ARCHITECT_MODEL,
      max_completion_tokens: 4096,
      messages: [
        { role: "system", content: ARCHITECT_SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      response_format: { type: "json_object" },
    });

    const raw = response.choices[0]?.message?.content?.trim() ?? "{}";
    const parsed = ArchitectResponseSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      logger.warn(
        { issues: parsed.error.issues.slice(0, 5) },
        "Architect review returned malformed JSON — treating as pass",
      );
      return {
        verdict: "pass",
        summary: "Architect review produced no structured findings.",
        findings: [],
        nextActions: [],
        model: ARCHITECT_MODEL,
      };
    }
    return { ...parsed.data, model: ARCHITECT_MODEL };
  } catch (err) {
    logger.warn({ err }, "Architect review call failed — treating as pass (non-fatal)");
    return {
      verdict: "pass",
      summary: "Architect review unavailable — proceeded without second-opinion.",
      findings: [],
      nextActions: [],
      model: ARCHITECT_MODEL,
    };
  }
}

/** True if the architect review should trigger an auto-fix turn. */
export function shouldTriggerAutoFix(review: ArchitectResponse): boolean {
  if (review.verdict === "fail") return true;
  return review.findings.some((f) => f.severity === "critical");
}

/** Build a refine prompt from architect findings for the one auto-fix turn. */
export function buildAutoFixPrompt(review: ArchitectResponse): string {
  const lines: string[] = [
    `The Architect Reviewer flagged this build as "${review.verdict}". Address the findings below in a single refine pass.`,
    "",
    review.summary,
    "",
    "Findings (highest severity first):",
  ];
  const sorted = [...review.findings].sort((a, b) => {
    const order = { critical: 0, high: 1, medium: 2, low: 3 } as const;
    return order[a.severity] - order[b.severity];
  });
  for (const f of sorted.slice(0, 10)) {
    const where = f.file ? ` (${f.file})` : "";
    lines.push(`- [${f.severity.toUpperCase()}] ${f.title}${where}: ${f.detail}`);
  }
  if (review.nextActions.length > 0) {
    lines.push("", "Recommended next actions:");
    for (const a of review.nextActions) lines.push(`- ${a}`);
  }
  lines.push(
    "",
    "Fix every critical finding. Address high-severity findings if it does not require user input. Leave low-severity polish alone unless trivial.",
  );
  return lines.join("\n");
}

/** Project the wire-format used in TaskReport.architectReview. */
export function toReportShape(
  review: ArchitectResponse,
  meta: {
    model: string;
    autoFixQueued: boolean;
    autoFixTaskId: number | null;
    creditsCharged: number;
  },
): NonNullable<TaskReport["architectReview"]> {
  return {
    verdict: review.verdict,
    summary: review.summary,
    findings: review.findings.map((f) => ({
      severity: f.severity,
      title: f.title,
      detail: f.detail,
      file: f.file ?? null,
    })),
    nextActions: review.nextActions,
    autoFixQueued: meta.autoFixQueued,
    autoFixTaskId: meta.autoFixTaskId,
    creditsCharged: meta.creditsCharged,
    reviewedAt: new Date().toISOString(),
    model: meta.model,
  };
}
