/**
 * Task #535 — Specialist subagents + isolated parallel sub-tasks.
 *
 * Roles:
 *   • designer   — media generation + writing media files (3 credits)
 *   • explorer   — read-only investigation (1 credit)
 *   • tester     — Playwright E2E (2 credits)
 *   • reviewer   — architect code review (2 credits)
 *
 * Two surfaces:
 *   - `dispatchSubagentFromTool(ctx, args)` — handler for the
 *     `dispatch_subagent` tool the parent agent-loop emits.
 *   - `planSubtasksFromTool(ctx, args)` — handler for `plan_subtasks`:
 *     LLM-plans an ordered list of subtasks, runs each in an ISOLATED
 *     FileWorkspace clone, then 3-way merges results back into the parent.
 *   - `dispatchSubagent(opts)` — direct in-process invocation used by
 *     `jobs.ts` to route the existing architect review through the same
 *     code path (no behavior change for the user).
 */

import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat";
import type { E2eRunSummary } from "@workspace/db";
import { eq } from "drizzle-orm";
import { db, projectsTable, taskEventsTable } from "@workspace/db";
import { logger } from "./logger";
import { publishTaskEvent } from "./event-bus";
import { deductCreditsAtomic } from "../routes/credits";
import {
  runArchitectReview,
  type ArchitectInput,
  type ArchitectReviewResult,
  type ReviewerAssembledPromptStats,
} from "./architect";
import {
  buildReviewerContextFromFiles,
  buildReviewerWorkspaceContext,
  type ReviewerFile,
} from "./reviewer-context";
import { runE2eScenarios, defaultSmokeScenarios, type E2eScenario } from "./checks/e2e-runner";
import {
  FileWorkspace,
  TOOLS,
  executeTool,
  type AgentLoopInput,
  type ToolCallRecord,
  type ToolCtx,
} from "./agent-loop";

function nz(n: number | null | undefined): number | undefined {
  return n == null ? undefined : n;
}

export type SubagentRole = "designer" | "explorer" | "tester" | "reviewer";

export const ROLE_CREDIT_COST: Record<SubagentRole, number> = {
  designer: 3,
  explorer: 1,
  tester: 2,
  reviewer: 2,
};

const ROLE_STEP_CAP: Record<SubagentRole, number> = {
  designer: 8,
  explorer: 6,
  tester: 1,
  reviewer: 1,
};

const ROLE_TOOL_NAMES: Record<SubagentRole, string[]> = {
  designer: [
    "list_files",
    "find_files",
    "read_file",
    "write_file",
    "apply_patch",
    "generate_image",
    "generate_audio",
    "generate_video",
    "remove_image_background",
    "present_asset",
    "report_progress",
    "finalize",
  ],
  explorer: [
    "list_files",
    "find_files",
    "read_file",
    "search",
    "semantic_search",
    "fetch_prod_logs",
    "report_progress",
    "finalize",
  ],
  tester: ["run_e2e", "finalize"],
  reviewer: ["finalize"],
};

const ROLE_SYSTEM_PROMPT: Record<SubagentRole, string> = {
  designer:
    "You are a DESIGNER subagent. Goal: produce or place visual/audio assets requested in the brief. Use generate_image / generate_audio / remove_image_background to create media, then write_file to commit it to the workspace at the path the brief specifies. Call finalize with a short summary of what you produced. Do not modify code; do not run shell commands.",
  explorer:
    "You are an EXPLORER subagent. Goal: investigate and report. Read files, search, and (if a published snapshot exists) fetch prod logs. NEVER write, patch, or delete anything. Finalize with a structured one-paragraph answer to the brief plus a short bullet list of citations (file paths / line ranges).",
  tester:
    "You are a TESTER subagent. Goal: run Playwright E2E against the live preview. Call run_e2e once with either the provided scenarios or the smoke defaults, then finalize with a one-line verdict (passed/failed + counts).",
  reviewer:
    "You are a REVIEWER subagent. (This role bypasses the loop and calls the architect review directly — you should never see this prompt.)",
};

// ─────────────────────────────────────────────────────────────────────────────
// Event helpers
// ─────────────────────────────────────────────────────────────────────────────

function emitSubagentEvent(
  taskId: number | null | undefined,
  _projectId: number,
  phase: "started" | "progress" | "done",
  role: SubagentRole,
  detail: string,
  payload?: Record<string, unknown>,
): void {
  if (taskId == null) return;
  try {
    publishTaskEvent({
      id: 0,
      taskId,
      eventType: `subagent_${phase}`,
      message: JSON.stringify({ role, detail: detail.slice(0, 240), ...(payload ?? {}) }),
      filePath: null,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn({ err, taskId, role, phase }, "publishTaskEvent (subagent) failed");
  }
}

async function persistReviewerContextEvent(input: {
  taskId: number | null | undefined;
  reviewPath: "in_loop" | "post_build";
  reviewerPayloadStats: ReviewerPayloadStats;
  reviewerAssembledPromptStats: ReviewerAssembledPromptStats;
}): Promise<void> {
  if (input.taskId == null) return;
  try {
    const [row] = await db
      .insert(taskEventsTable)
      .values({
        taskId: input.taskId,
        eventType: "review_context",
        message: `Reviewer context assembled (${input.reviewPath}).`,
        filePath: null,
        data: {
          reviewPath: input.reviewPath,
          reviewerPayloadStats: input.reviewerPayloadStats,
          reviewerAssembledPromptStats: input.reviewerAssembledPromptStats,
        },
      })
      .returning();
    if (row) {
      publishTaskEvent({
        id: row.id,
        taskId: row.taskId,
        eventType: row.eventType,
        message: row.message,
        filePath: row.filePath ?? null,
        data: (row.data as Record<string, unknown> | undefined) ?? undefined,
        createdAt: row.createdAt,
      });
    }
  } catch (err) {
    logger.warn(
      { err, taskId: input.taskId, reviewPath: input.reviewPath },
      "Failed to persist reviewer context instrumentation",
    );
  }
}

async function lookupOwnerId(projectId: number): Promise<string | null> {
  try {
    const rows = await db
      .select({ ownerId: projectsTable.ownerId })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId))
      .limit(1);
    return rows[0]?.ownerId ?? null;
  } catch (err) {
    logger.warn({ err, projectId }, "subagent: ownerId lookup failed");
    return null;
  }
}

async function chargeRoleCredits(
  input: AgentLoopInput,
  role: SubagentRole,
  taskId: number | null | undefined,
): Promise<{ ok: true; charged: number } | { ok: false; reason: string }> {
  const ownerId = await lookupOwnerId(input.projectId);
  const cost = ROLE_CREDIT_COST[role];
  if (!ownerId) return { ok: true, charged: 0 };
  try {
    const debit = await deductCreditsAtomic(ownerId, cost, {
      projectId: input.projectId,
      type: "architect",
      description: `Subagent dispatch (${role}) for task #${taskId ?? "?"}`,
    });
    if ("insufficient" in debit) {
      return { ok: false, reason: `insufficient credits (need ${cost}, have ${debit.balance})` };
    }
    return { ok: true, charged: cost };
  } catch (err) {
    logger.warn({ err, role }, "Subagent credit deduction failed (non-fatal)");
    return { ok: true, charged: 0 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Role: reviewer (wraps runArchitectReview)
// ─────────────────────────────────────────────────────────────────────────────

interface ReviewerOpts {
  parentInput: AgentLoopInput;
  taskId?: number;
  brief: string;
  diff: ArchitectInput["diff"];
  commandsRun?: ArchitectInput["commandsRun"];
  fileExcerpts?: ArchitectInput["fileExcerpts"];
  assistantSummary?: string;
  planContext?: ArchitectInput["planContext"];
  knownWarnings?: string[];
}

export interface ReviewerPayloadStats {
  excerptCount: number;
  totalExcerptChars: number;
  filesAdded: number;
  filesModified: number;
  filesRemoved: number;
  selectedPaths: string[];
  missingRequestedPaths: string[];
}

function reviewerPayloadStats(input: {
  diff: ArchitectInput["diff"];
  fileExcerpts?: ArchitectInput["fileExcerpts"];
  missingRequestedPaths?: string[];
}): ReviewerPayloadStats {
  return {
    excerptCount: input.fileExcerpts?.length ?? 0,
    totalExcerptChars:
      input.fileExcerpts?.reduce((total, excerpt) => total + excerpt.content.length, 0) ?? 0,
    filesAdded: input.diff.filesAdded.length,
    filesModified: input.diff.filesModified.length,
    filesRemoved: input.diff.filesRemoved.length,
    selectedPaths: input.fileExcerpts?.map((excerpt) => excerpt.path) ?? [],
    missingRequestedPaths: input.missingRequestedPaths ?? [],
  };
}

function hasReviewerPayload(stats: ReviewerPayloadStats): boolean {
  return (
    stats.excerptCount > 0 ||
    stats.filesAdded > 0 ||
    stats.filesModified > 0 ||
    stats.filesRemoved > 0
  );
}

function reviewerPayloadStatsLine(stats: ReviewerPayloadStats): string {
  return `reviewerPayloadStats=${JSON.stringify(stats)}`;
}

function reviewerAssembledPromptStatsLine(stats: ReviewerAssembledPromptStats): string {
  return `reviewerAssembledPromptStats=${JSON.stringify(stats)}`;
}

function emptyReviewerAssembledPromptStats(): ReviewerAssembledPromptStats {
  return {
    excerptCount: 0,
    totalExcerptChars: 0,
    excerptBlockChars: 0,
    selectedPaths: [],
  };
}

function emptyReviewerObservation(stats: ReviewerPayloadStats): string {
  return [
    reviewerPayloadStatsLine(stats),
    reviewerAssembledPromptStatsLine(emptyReviewerAssembledPromptStats()),
    "REVIEW_DEFERRED: There are no changed files or file excerpts to review yet.",
    "Write the files before requesting review, then request the reviewer again.",
  ].join("\n");
}

async function runReviewer(
  opts: ReviewerOpts,
): Promise<{ ok: boolean; observation: string; review: ArchitectReviewResult }> {
  const review = await runArchitectReview({
    userRequest: opts.parentInput.userPrompt,
    reviewBrief: opts.brief,
    agentMode: opts.parentInput.agentMode,
    planContext: opts.planContext ?? null,
    diff: opts.diff,
    commandsRun: opts.commandsRun,
    fileExcerpts: opts.fileExcerpts,
    assistantSummary: opts.assistantSummary,
    knownWarnings: opts.knownWarnings,
  });
  const lines = [
    `verdict: ${review.verdict}`,
    `summary: ${review.summary}`,
    `findings (${review.findings.length}):`,
    ...review.findings.slice(0, 6).map((f, i) => `  ${i + 1}. [${f.severity}] ${f.title}`),
  ];
  return {
    ok: review.verdict === "pass",
    observation: lines.join("\n"),
    review,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Role: tester (wraps runE2eScenarios)
// ─────────────────────────────────────────────────────────────────────────────

interface TesterOpts {
  parentCtx: ToolCtx;
  brief: string;
  scenarios?: unknown[];
}

async function runTester(
  opts: TesterOpts,
): Promise<{ ok: boolean; observation: string; summary?: E2eRunSummary }> {
  const { parentCtx } = opts;
  if (parentCtx.input.e2eEnabled === false) {
    return { ok: false, observation: "ERROR: E2E disabled for this project." };
  }
  const raw = Array.isArray(opts.scenarios) ? opts.scenarios : null;
  let scenarios: E2eScenario[] = defaultSmokeScenarios();
  if (raw && raw.length > 0) {
    // Best-effort parse: only accept entries with { name, steps:[] }
    const parsed: E2eScenario[] = [];
    for (const r of raw) {
      if (!r || typeof r !== "object") continue;
      const o = r as Record<string, unknown>;
      const name = typeof o.name === "string" ? o.name.slice(0, 120) : null;
      const steps = Array.isArray(o.steps) ? o.steps : null;
      if (!name || !steps) continue;
      parsed.push({ name, source: "smoke", steps: steps as E2eScenario["steps"] });
    }
    if (parsed.length > 0) scenarios = parsed;
  }
  const fallbackHtml =
    parentCtx.stack === "static-html"
      ? (parentCtx.workspace.read("index.html")?.content ?? null)
      : null;
  const previewUrl = parentCtx.input.previewUrl ?? null;
  if (!previewUrl && !fallbackHtml) {
    return {
      ok: false,
      observation: "ERROR: no preview URL or static HTML available — start container first.",
    };
  }
  const summary = await runE2eScenarios({
    targetUrl: previewUrl,
    scenarios,
    fallbackHtml,
    maxScreenshotBytes: parentCtx.screenshotBudget.remaining,
    signal: parentCtx.input.signal,
  });
  parentCtx.e2eResults.push(summary);
  const obs = [
    `E2E ${summary.passed} passed / ${summary.failed} failed (${summary.totalDurationMs}ms)`,
    ...summary.scenarios
      .slice(0, 8)
      .map((s) => `  ${s.passed ? "PASS" : "FAIL"} ${s.name} — ${s.message.slice(0, 120)}`),
  ].join("\n");
  return { ok: summary.failed === 0, observation: obs, summary };
}

// ─────────────────────────────────────────────────────────────────────────────
// Roles: designer + explorer (mini agent-loop with role-filtered tools)
// ─────────────────────────────────────────────────────────────────────────────

interface MiniLoopResult {
  ok: boolean;
  observation: string;
  toolCalls: ToolCallRecord[];
  summary: string;
}

async function runMiniLoop(
  parentCtx: ToolCtx,
  role: SubagentRole,
  brief: string,
  workspace: FileWorkspace,
): Promise<MiniLoopResult> {
  const allowed = new Set(ROLE_TOOL_NAMES[role]);
  const tools: ChatCompletionTool[] = TOOLS.filter(
    (t) => t.type === "function" && allowed.has(t.function.name),
  );
  const stepCap = ROLE_STEP_CAP[role];
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: ROLE_SYSTEM_PROMPT[role] },
    {
      role: "user",
      content:
        `BRIEF:\n${brief.slice(0, 4000)}\n\n` +
        `Workspace has ${workspace.list().length} files. Available tools: ${[...allowed].join(", ")}. ` +
        `You have at most ${stepCap} tool calls. Finalize with a concise outcome.`,
    },
  ];

  const { createChatCompletion, resolveStageProvider } = await import("./ai-providers");
  const { provider, model } = resolveStageProvider(
    "refine",
    parentCtx.input.agentMode,
    "gpt-5-mini",
  );

  const toolCalls: ToolCallRecord[] = [];
  let summary = "";
  let finalized = false;

  for (let step = 1; step <= stepCap; step++) {
    if (parentCtx.input.signal.aborted) break;
    let response;
    try {
      response = await createChatCompletion({
        provider,
        model,
        messages,
        tools,
        tool_choice: "auto",
        signal: parentCtx.input.signal,
      });
    } catch (err) {
      logger.warn({ err, role, step }, "subagent mini-loop: model call failed");
      break;
    }
    const choice = response.choices[0];
    if (!choice) break;
    const msg = choice.message;
    const reqs = msg.tool_calls ?? [];
    messages.push({
      role: "assistant",
      content: msg.content ?? null,
      tool_calls: reqs.length > 0 ? reqs : undefined,
    } as ChatCompletionMessageParam);

    if (reqs.length === 0) {
      summary = msg.content ?? "";
      break;
    }

    for (const req of reqs) {
      if (req.type !== "function") continue;
      const name = req.function.name;
      let args: Record<string, unknown> = {};
      try {
        args = req.function.arguments ? JSON.parse(req.function.arguments) : {};
      } catch {
        // ignore malformed args — observation will record error
      }
      if (name === "finalize") {
        summary = typeof args.summary === "string" ? args.summary : "Subagent done.";
        finalized = true;
        messages.push({
          role: "tool",
          tool_call_id: req.id,
          content: "finalized",
        } as ChatCompletionMessageParam);
        toolCalls.push({
          step,
          tool: name,
          args,
          ok: true,
          durationMs: 0,
          preview: "finalized",
        });
        continue;
      }
      // Block tools the role isn't allowed to use, just in case.
      if (!allowed.has(name)) {
        messages.push({
          role: "tool",
          tool_call_id: req.id,
          content: `ERROR: tool "${name}" not available for role ${role}`,
        } as ChatCompletionMessageParam);
        continue;
      }
      // Reuse the parent's executeTool with the subagent's workspace.
      const subCtx: ToolCtx = { ...parentCtx, name, args, workspace, step };
      let result;
      try {
        result = await executeTool(subCtx);
      } catch (err) {
        result = { ok: false, observation: `ERROR: ${String((err as Error).message ?? err)}` };
      }
      toolCalls.push({
        step,
        tool: name,
        args,
        ok: result.ok,
        durationMs: 0,
        preview: result.observation.slice(0, 400),
      });
      messages.push({
        role: "tool",
        tool_call_id: req.id,
        content: result.observation.slice(0, 4000),
      } as ChatCompletionMessageParam);
    }
    if (finalized) break;
  }

  return {
    ok: true,
    observation: summary || `${role} subagent completed ${toolCalls.length} tool calls.`,
    toolCalls,
    summary: summary || `${role} subagent completed.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatcher (tool entry point + direct invocation)
// ─────────────────────────────────────────────────────────────────────────────

export interface DispatchOpts {
  role: SubagentRole;
  brief: string;
  parentCtx: ToolCtx;
  /** Optional isolated workspace; defaults to parentCtx.workspace. */
  workspace?: FileWorkspace;
  /** Tester-specific: scenarios passed through to run_e2e. */
  scenarios?: unknown[];
  /** Reviewer-specific: diff/commands/excerpts injected from the caller. */
  reviewer?: Omit<ReviewerOpts, "parentInput" | "taskId" | "brief">;
  /** When true, dispatchSubagent skips its own credit charge (caller charges). */
  skipCredits?: boolean;
}

export interface DispatchResult {
  ok: boolean;
  observation: string;
  role: SubagentRole;
  creditsCharged: number;
  toolCalls?: ToolCallRecord[];
  review?: ArchitectReviewResult;
  e2eSummary?: E2eRunSummary;
  reviewerPayloadStats?: ReviewerPayloadStats;
  reviewerAssembledPromptStats?: ReviewerAssembledPromptStats;
}

export async function dispatchSubagent(opts: DispatchOpts): Promise<DispatchResult> {
  const { role, brief, parentCtx } = opts;
  const taskId = parentCtx.input.taskId;
  emitSubagentEvent(taskId, parentCtx.input.projectId, "started", role, brief.slice(0, 160));

  const reviewerContext =
    role === "reviewer"
      ? {
          ...buildReviewerWorkspaceContext({
            existingFiles: parentCtx.input.existingFiles,
            workspace: parentCtx.workspace,
            reviewRequest: brief,
          }),
          ...(opts.reviewer ?? {}),
        }
      : null;
  const reviewerStats = reviewerContext ? reviewerPayloadStats(reviewerContext) : null;
  if (reviewerContext && reviewerStats && !hasReviewerPayload(reviewerStats)) {
    const reviewerAssembledPromptStats = emptyReviewerAssembledPromptStats();
    await persistReviewerContextEvent({
      taskId,
      reviewPath: "in_loop",
      reviewerPayloadStats: reviewerStats,
      reviewerAssembledPromptStats,
    });
    emitSubagentEvent(
      taskId,
      parentCtx.input.projectId,
      "done",
      role,
      "deferred: no files to review",
      { deferred: true, reviewerPayloadStats: reviewerStats, reviewerAssembledPromptStats },
    );
    return {
      ok: true,
      observation: emptyReviewerObservation(reviewerStats),
      role,
      creditsCharged: 0,
      reviewerPayloadStats: reviewerStats,
      reviewerAssembledPromptStats,
    };
  }

  const charge = opts.skipCredits
    ? ({ ok: true, charged: 0 } as const)
    : await chargeRoleCredits(parentCtx.input, role, taskId);
  if (!charge.ok) {
    emitSubagentEvent(taskId, parentCtx.input.projectId, "done", role, `aborted: ${charge.reason}`);
    return { ok: false, observation: `ERROR: ${charge.reason}`, role, creditsCharged: 0 };
  }

  try {
    if (role === "reviewer" && reviewerContext && reviewerStats) {
      const r = await runReviewer({
        parentInput: parentCtx.input,
        taskId: nz(taskId),
        brief,
        diff: reviewerContext.diff,
        commandsRun: reviewerContext.commandsRun,
        fileExcerpts: reviewerContext.fileExcerpts,
        assistantSummary: reviewerContext.assistantSummary,
        planContext: reviewerContext.planContext,
        knownWarnings: reviewerContext.knownWarnings,
      });
      const reviewerAssembledPromptStats = r.review.reviewerAssembledPromptStats;
      await persistReviewerContextEvent({
        taskId,
        reviewPath: "in_loop",
        reviewerPayloadStats: reviewerStats,
        reviewerAssembledPromptStats,
      });
      emitSubagentEvent(
        taskId,
        parentCtx.input.projectId,
        "done",
        role,
        r.review ? `verdict ${r.review.verdict}` : "done",
        {
          verdict: r.review?.verdict,
          findings: r.review?.findings.length ?? 0,
          reviewerPayloadStats: reviewerStats,
          reviewerAssembledPromptStats,
        },
      );
      return {
        ok: r.ok,
        observation: [
          reviewerPayloadStatsLine(reviewerStats),
          reviewerAssembledPromptStatsLine(reviewerAssembledPromptStats),
          r.observation,
        ].join("\n"),
        role,
        creditsCharged: charge.charged,
        review: r.review,
        reviewerPayloadStats: reviewerStats,
        reviewerAssembledPromptStats,
      };
    }
    if (role === "tester") {
      const r = await runTester({ parentCtx, brief, scenarios: opts.scenarios });
      emitSubagentEvent(
        taskId,
        parentCtx.input.projectId,
        "done",
        role,
        r.summary
          ? `${r.summary.passed} passed / ${r.summary.failed} failed`
          : r.observation.slice(0, 160),
        { passed: r.summary?.passed, failed: r.summary?.failed },
      );
      return {
        ok: r.ok,
        observation: r.observation,
        role,
        creditsCharged: charge.charged,
        e2eSummary: r.summary,
      };
    }
    // designer + explorer — mini agent loop
    const workspace = opts.workspace ?? parentCtx.workspace;
    const r = await runMiniLoop(parentCtx, role, brief, workspace);
    emitSubagentEvent(taskId, parentCtx.input.projectId, "done", role, r.summary.slice(0, 160), {
      toolCalls: r.toolCalls.length,
    });
    return {
      ok: r.ok,
      observation: r.observation,
      role,
      creditsCharged: charge.charged,
      toolCalls: r.toolCalls,
    };
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    logger.warn({ err, role }, "subagent dispatch threw");
    emitSubagentEvent(
      taskId,
      parentCtx.input.projectId,
      "done",
      role,
      `error: ${msg.slice(0, 160)}`,
    );
    return {
      ok: false,
      observation: `ERROR: subagent ${role} threw: ${msg}`,
      role,
      creditsCharged: charge.charged,
    };
  }
}

/**
 * Standalone dispatch entry point for callers that don't have a full
 * ToolCtx (e.g. `jobs.ts` invoking the architect after a build). Currently
 * supports the `reviewer` role only — that's the only path `jobs.ts` exercises.
 * Goes through the same emit/credit machinery as the tool-driven dispatcher.
 */
export async function dispatchReviewerStandalone(args: {
  input: AgentLoopInput;
  brief: string;
  reviewer: Omit<ReviewerOpts, "parentInput" | "taskId" | "brief" | "fileExcerpts"> & {
    workspaceFiles: ReviewerFile[];
  };
  skipCredits?: boolean;
}): Promise<DispatchResult> {
  const role: SubagentRole = "reviewer";
  const taskId = args.input.taskId;
  emitSubagentEvent(taskId, args.input.projectId, "started", role, args.brief.slice(0, 160));
  const selectedContext = buildReviewerContextFromFiles({
    diff: args.reviewer.diff,
    workspaceFiles: args.reviewer.workspaceFiles,
    reviewRequest: args.brief,
  });
  const reviewerContext = {
    ...args.reviewer,
    diff: selectedContext.diff,
    fileExcerpts: selectedContext.fileExcerpts,
    missingRequestedPaths: selectedContext.missingRequestedPaths,
  };
  const reviewerStats = reviewerPayloadStats(reviewerContext);
  if (!hasReviewerPayload(reviewerStats)) {
    const reviewerAssembledPromptStats = emptyReviewerAssembledPromptStats();
    await persistReviewerContextEvent({
      taskId,
      reviewPath: "post_build",
      reviewerPayloadStats: reviewerStats,
      reviewerAssembledPromptStats,
    });
    emitSubagentEvent(
      taskId,
      args.input.projectId,
      "done",
      role,
      "deferred: no files to review",
      { deferred: true, reviewerPayloadStats: reviewerStats, reviewerAssembledPromptStats },
    );
    return {
      ok: true,
      observation: emptyReviewerObservation(reviewerStats),
      role,
      creditsCharged: 0,
      reviewerPayloadStats: reviewerStats,
      reviewerAssembledPromptStats,
    };
  }
  const charge = args.skipCredits
    ? ({ ok: true, charged: 0 } as const)
    : await chargeRoleCredits(args.input, role, taskId);
  if (!charge.ok) {
    emitSubagentEvent(taskId, args.input.projectId, "done", role, `aborted: ${charge.reason}`);
    return { ok: false, observation: `ERROR: ${charge.reason}`, role, creditsCharged: 0 };
  }
  try {
    const r = await runReviewer({
      parentInput: args.input,
      taskId: nz(taskId),
      brief: args.brief,
      diff: reviewerContext.diff,
      commandsRun: reviewerContext.commandsRun,
      fileExcerpts: reviewerContext.fileExcerpts,
      assistantSummary: reviewerContext.assistantSummary,
      planContext: reviewerContext.planContext,
      knownWarnings: reviewerContext.knownWarnings,
    });
    const reviewerAssembledPromptStats = r.review.reviewerAssembledPromptStats;
    await persistReviewerContextEvent({
      taskId,
      reviewPath: "post_build",
      reviewerPayloadStats: reviewerStats,
      reviewerAssembledPromptStats,
    });
    emitSubagentEvent(
      taskId,
      args.input.projectId,
      "done",
      role,
      r.review ? `verdict ${r.review.verdict}` : "done",
      {
        verdict: r.review?.verdict,
        findings: r.review?.findings.length ?? 0,
        reviewerPayloadStats: reviewerStats,
        reviewerAssembledPromptStats,
      },
    );
    return {
      ok: r.ok,
      observation: [
        reviewerPayloadStatsLine(reviewerStats),
        reviewerAssembledPromptStatsLine(reviewerAssembledPromptStats),
        r.observation,
      ].join("\n"),
      role,
      creditsCharged: charge.charged,
      review: r.review,
      reviewerPayloadStats: reviewerStats,
      reviewerAssembledPromptStats,
    };
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    logger.warn({ err, role }, "dispatchReviewerStandalone threw");
    emitSubagentEvent(taskId, args.input.projectId, "done", role, `error: ${msg.slice(0, 160)}`);
    return {
      ok: false,
      observation: `ERROR: subagent ${role} threw: ${msg}`,
      role,
      creditsCharged: charge.charged,
    };
  }
}

/**
 * Tool-call adapter for `dispatch_subagent`.
 */
export async function dispatchSubagentFromTool(
  ctx: ToolCtx,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; observation: string }> {
  const role = args.role;
  const brief = typeof args.brief === "string" ? args.brief : "";
  if (role !== "designer" && role !== "explorer" && role !== "tester" && role !== "reviewer") {
    return { ok: false, observation: `ERROR: invalid role "${String(role)}".` };
  }
  if (!brief.trim()) {
    return { ok: false, observation: "ERROR: brief is required." };
  }
  const scenarios = Array.isArray(args.scenarios) ? (args.scenarios as unknown[]) : undefined;
  const result = await dispatchSubagent({ role, brief, parentCtx: ctx, scenarios });
  const header = `[${role} subagent · ${result.creditsCharged} credits · ${result.ok ? "ok" : "failed"}]`;
  return { ok: result.ok, observation: `${header}\n${result.observation}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-task planning + 3-way merge
// ─────────────────────────────────────────────────────────────────────────────

interface PlannedSubtask {
  id: string;
  title: string;
  brief: string;
  role: SubagentRole;
  dependsOn: string[];
}

interface MergeReport {
  applied: string[];
  conflicts: Array<{ path: string; subtaskId: string; reason: string }>;
  added: string[];
  unchanged: string[];
}

/**
 * Three-way merge of one subtask's workspace back into the live parent.
 *
 *   base    — workspace snapshot captured BEFORE the subtask ran
 *   branch  — workspace snapshot AFTER the subtask ran (its result)
 *   live    — the parent workspace as it is right now (may include
 *             changes from earlier-merged subtasks)
 *
 * Per file:
 *   • branch unchanged from base → no-op
 *   • live unchanged from base → take branch
 *   • both diverge from base → CONFLICT — keep live, record it
 *   • branch added a new path that doesn't exist live → take branch
 *   • branch added but live already has the same path → conflict if content differs
 */
export function threeWayMerge(
  base: Map<string, string>,
  branch: Map<string, string>,
  live: FileWorkspace,
  subtaskId: string,
): MergeReport {
  const report: MergeReport = { applied: [], conflicts: [], added: [], unchanged: [] };
  for (const [path, branchContent] of branch) {
    const baseContent = base.get(path);
    const liveFile = live.read(path);
    const liveContent = liveFile?.content;
    if (baseContent === undefined && liveContent === undefined) {
      // New file in branch only — safe to add.
      live.write(path, branchContent);
      report.added.push(path);
      continue;
    }
    if (baseContent === branchContent) {
      // Subtask didn't touch this file.
      report.unchanged.push(path);
      continue;
    }
    if (baseContent === liveContent) {
      // Live hasn't moved — safe to apply branch.
      live.write(path, branchContent);
      report.applied.push(path);
      continue;
    }
    if (liveContent === branchContent) {
      // Identical change already in live — no-op.
      report.unchanged.push(path);
      continue;
    }
    // Both diverge — conflict. Keep live.
    report.conflicts.push({
      path,
      subtaskId,
      reason: "both branch and live diverged from base",
    });
  }
  return report;
}

interface PlannerResponse {
  subtasks: Array<{
    id?: unknown;
    title?: unknown;
    brief?: unknown;
    role?: unknown;
    depends_on?: unknown;
  }>;
}

function normalizePlan(raw: PlannerResponse, maxSubtasks: number): PlannedSubtask[] {
  const out: PlannedSubtask[] = [];
  for (let i = 0; i < raw.subtasks.length && out.length < maxSubtasks; i++) {
    const s = raw.subtasks[i]!;
    const id = typeof s.id === "string" && s.id.trim() ? s.id.trim().slice(0, 32) : `t${i + 1}`;
    const title = typeof s.title === "string" ? s.title.slice(0, 120) : `Subtask ${i + 1}`;
    const brief = typeof s.brief === "string" ? s.brief.slice(0, 1000) : "";
    const role: SubagentRole =
      s.role === "designer" || s.role === "explorer" || s.role === "tester" || s.role === "reviewer"
        ? s.role
        : "explorer";
    const dependsOnRaw: unknown[] = Array.isArray(s.depends_on) ? s.depends_on : [];
    const dependsOn = dependsOnRaw.filter((d): d is string => typeof d === "string").slice(0, 4);
    if (!brief) continue;
    out.push({ id, title, brief, role, dependsOn });
  }
  return out;
}

function topoOrder(subtasks: PlannedSubtask[]): PlannedSubtask[] {
  const byId = new Map(subtasks.map((s) => [s.id, s]));
  const visited = new Set<string>();
  const result: PlannedSubtask[] = [];
  const visit = (s: PlannedSubtask, stack: Set<string>) => {
    if (visited.has(s.id)) return;
    if (stack.has(s.id)) return; // cycle — drop the cycle edge
    stack.add(s.id);
    for (const d of s.dependsOn) {
      const dep = byId.get(d);
      if (dep) visit(dep, stack);
    }
    stack.delete(s.id);
    visited.add(s.id);
    result.push(s);
  };
  for (const s of subtasks) visit(s, new Set());
  return result;
}

async function planSubtasksLLM(
  parentCtx: ToolCtx,
  goal: string,
  maxSubtasks: number,
): Promise<PlannedSubtask[]> {
  const { createChatCompletion, resolveStageProvider } = await import("./ai-providers");
  const { provider, model } = resolveStageProvider("plan", parentCtx.input.agentMode, "gpt-5-mini");
  const sys = `You break a goal into ${maxSubtasks} or fewer ISOLATED subtasks for specialist subagents.
Roles available: designer (media), explorer (read-only investigation), tester (E2E), reviewer (architect review).
Each subtask must be safely runnable in a workspace clone without coordinating with the others.
Output strict JSON: { "subtasks": [{ "id": "t1", "title": "...", "brief": "...", "role": "...", "depends_on": [] }, ...] }`;
  const userPrompt = `GOAL:\n${goal.slice(0, 2000)}\n\nCurrent workspace has ${parentCtx.workspace.list().length} files. Return JSON only.`;
  try {
    const response = await createChatCompletion({
      provider,
      model,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      signal: parentCtx.input.signal,
    });
    const raw = response.choices[0]?.message?.content?.trim() ?? "{}";
    const parsed = JSON.parse(raw) as PlannerResponse;
    if (!parsed || !Array.isArray(parsed.subtasks)) return [];
    return normalizePlan(parsed, maxSubtasks);
  } catch (err) {
    logger.warn({ err }, "plan_subtasks LLM failed");
    return [];
  }
}

export async function planSubtasksFromTool(
  ctx: ToolCtx,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; observation: string }> {
  const goal = typeof args.goal === "string" ? args.goal : "";
  if (!goal.trim()) return { ok: false, observation: "ERROR: goal is required." };
  const requested = typeof args.max_subtasks === "number" ? args.max_subtasks : 4;
  const maxSubtasks = Math.max(1, Math.min(6, Math.floor(requested)));
  const taskId = ctx.input.taskId;
  emitSubagentEvent(
    taskId,
    ctx.input.projectId,
    "started",
    "explorer",
    `planning: ${goal.slice(0, 120)}`,
  );

  const subtasks = await planSubtasksLLM(ctx, goal, maxSubtasks);
  if (subtasks.length === 0) {
    return {
      ok: false,
      observation: "ERROR: planner produced no usable subtasks. Try a more concrete goal.",
    };
  }
  const ordered = topoOrder(subtasks);

  // Capture parent base before any subtask runs.
  const baseSnapshot = new Map<string, string>();
  for (const f of ctx.workspace.snapshot()) baseSnapshot.set(f.path, f.content);

  const results: Array<{
    id: string;
    title: string;
    role: SubagentRole;
    ok: boolean;
    merge?: MergeReport;
    observation: string;
  }> = [];
  let totalConflicts = 0;
  let totalCharged = 0;

  for (const st of ordered) {
    if (ctx.input.signal.aborted) break;
    emitSubagentEvent(taskId, ctx.input.projectId, "progress", st.role, `${st.id}: ${st.title}`, {
      subtaskId: st.id,
    });
    if (st.role === "tester" || st.role === "reviewer") {
      // These roles operate on live workspace (no merge needed).
      const r = await dispatchSubagent({ role: st.role, brief: st.brief, parentCtx: ctx });
      totalCharged += r.creditsCharged;
      results.push({
        id: st.id,
        title: st.title,
        role: st.role,
        ok: r.ok,
        observation: r.observation,
      });
      continue;
    }
    // designer + explorer — isolated workspace clone.
    const clone = ctx.workspace.clone();
    const subBase = new Map<string, string>();
    for (const f of clone.snapshot()) subBase.set(f.path, f.content);
    const r = await dispatchSubagent({
      role: st.role,
      brief: st.brief,
      parentCtx: ctx,
      workspace: clone,
    });
    totalCharged += r.creditsCharged;
    const branch = new Map<string, string>();
    for (const f of clone.snapshot()) branch.set(f.path, f.content);
    const merge = threeWayMerge(subBase, branch, ctx.workspace, st.id);
    totalConflicts += merge.conflicts.length;
    results.push({
      id: st.id,
      title: st.title,
      role: st.role,
      ok: r.ok,
      merge,
      observation: r.observation,
    });
  }

  const lines: string[] = [
    `plan_subtasks: ran ${results.length}/${ordered.length} subtasks (${totalCharged} credits, ${totalConflicts} conflicts)`,
  ];
  for (const r of results) {
    const m = r.merge
      ? ` · merged ${r.merge.applied.length + r.merge.added.length} files, ${r.merge.conflicts.length} conflicts`
      : "";
    lines.push(`  • [${r.role}] ${r.id} ${r.title} — ${r.ok ? "ok" : "failed"}${m}`);
    if (r.merge && r.merge.conflicts.length > 0) {
      for (const c of r.merge.conflicts.slice(0, 4)) {
        lines.push(`      ! conflict: ${c.path} (${c.reason}) — kept live version`);
      }
    }
  }
  emitSubagentEvent(
    taskId,
    ctx.input.projectId,
    "done",
    "explorer",
    `done: ${results.length} subtasks, ${totalConflicts} conflicts`,
  );
  return { ok: totalConflicts === 0, observation: lines.join("\n") };
}
