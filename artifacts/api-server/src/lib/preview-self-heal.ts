import { logger } from "./logger";

export type PreviewRuntimeIssueKind =
  | "preview_sync"
  | "boot_crash"
  | "server_exception"
  | "browser_exception"
  | "blank_page"
  | "interaction";

export type PreviewRuntimeIssue = {
  kind: PreviewRuntimeIssueKind;
  source: "preview" | "container_log" | "browser_qa";
  message: string;
};

export type PreviewRuntimeObservation = {
  issues: PreviewRuntimeIssue[];
  inspectedLogLines: number;
  qaErrors: number;
  unavailableChecks: string[];
};

const STRONG_RUNTIME_ERROR =
  /\b(?:uncaught|unhandled|fatal|panic|exception|syntaxerror|referenceerror|typeerror|cannot find module|module not found|failed to (?:start|compile|boot)|exited? with (?:code|status)|eaddrinuse|segmentation fault|heap out of memory)\b/i;
const ERROR_PREFIX = /(?:^|\s)(?:error|err)[:\s]/i;
const BENIGN_ERROR_TEXT =
  /\b(?:0 errors?|no errors?|without errors?|exited? with (?:code|status) 0|sigterm|signal 15|error overlay disabled|hmr update|deprecated|deprecation warning)\b/i;

function cleanMessage(message: string): string {
  const ansiColorSequence = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  return message.replace(ansiColorSequence, "").replace(/\s+/g, " ").trim().slice(0, 500);
}

export type PreviewSelfHealBudget = {
  stepBudget: number;
  wallClockBudgetMs: number;
  remainingSteps: number;
  remainingWallClockMs: number;
  canAttempt: boolean;
};

export function resolvePreviewSelfHealBudget(input: {
  stepsUsed: number;
  stepCap: number;
  taskElapsedMs: number;
  wallClockBudgetMs: number;
}): PreviewSelfHealBudget {
  const remainingSteps = Math.max(0, Math.floor(input.stepCap) - Math.floor(input.stepsUsed));
  const remainingWallClockMs = Math.max(
    0,
    Math.floor(input.wallClockBudgetMs) - Math.floor(input.taskElapsedMs),
  );
  const stepBudget = Math.min(8, remainingSteps);
  const wallClockBudgetMs = Math.min(3 * 60_000, remainingWallClockMs);
  return {
    stepBudget,
    wallClockBudgetMs,
    remainingSteps,
    remainingWallClockMs,
    canAttempt: stepBudget > 0 && wallClockBudgetMs >= 60_000,
  };
}

export function classifyRuntimeLogLines(
  lines: Array<{ level: string; message: string }>,
): PreviewRuntimeIssue[] {
  const issues: PreviewRuntimeIssue[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const message = cleanMessage(line.message);
    if (!message || BENIGN_ERROR_TEXT.test(message)) continue;
    const strong = STRONG_RUNTIME_ERROR.test(message);
    const stderrError = line.level === "stderr" && ERROR_PREFIX.test(message);
    if (!strong && !stderrError) continue;
    const kind: PreviewRuntimeIssueKind =
      /\b(?:exited?|failed to (?:start|boot)|fatal|panic|eaddrinuse|segmentation fault|heap out of memory)\b/i.test(
        message,
      )
        ? "boot_crash"
        : "server_exception";
    const key = `${kind}:${message.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push({ kind, source: "container_log", message });
    if (issues.length >= 12) break;
  }
  return issues;
}

export function classifyQAErrors(errors: string[]): {
  issues: PreviewRuntimeIssue[];
  unavailableChecks: string[];
} {
  const issues: PreviewRuntimeIssue[] = [];
  const unavailableChecks: string[] = [];
  const seen = new Set<string>();
  for (const raw of errors) {
    const message = cleanMessage(raw);
    if (!message) continue;
    if (/QA runner (?:failed|error)|playwright unavailable|no chromium/i.test(message)) {
      unavailableChecks.push(message);
      continue;
    }
    const kind: PreviewRuntimeIssueKind = /blank page/i.test(message)
      ? "blank_page"
      : /Could not (?:click|follow|type)/i.test(message)
        ? "interaction"
        : "browser_exception";
    const key = `${kind}:${message.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push({ kind, source: "browser_qa", message });
    if (issues.length >= 12) break;
  }
  return { issues, unavailableChecks };
}

export async function collectPreviewRuntimeObservation(input: {
  projectId: number;
  since: Date;
  previewUpdated: boolean;
  previewSyncFailed: boolean;
  qaErrors: string[];
}): Promise<PreviewRuntimeObservation> {
  const issues: PreviewRuntimeIssue[] = [];
  if (input.previewSyncFailed || !input.previewUpdated) {
    issues.push({
      kind: "preview_sync",
      source: "preview",
      message: input.previewSyncFailed
        ? "The preview runtime failed to sync or become reachable."
        : "The preview did not report a successful boot.",
    });
  }

  let logLines: Array<{ level: string; message: string }> = [];
  try {
    const [{ and, asc, eq, gte }, { containerLogsTable, db }] = await Promise.all([
      import("drizzle-orm"),
      import("@workspace/db"),
    ]);
    logLines = await db
      .select({
        level: containerLogsTable.level,
        message: containerLogsTable.message,
      })
      .from(containerLogsTable)
      .where(
        and(
          eq(containerLogsTable.projectId, input.projectId),
          gte(containerLogsTable.createdAt, input.since),
        ),
      )
      .orderBy(asc(containerLogsTable.createdAt))
      .limit(100);
  } catch (error) {
    logger.warn(
      { err: error, projectId: input.projectId },
      "preview-self-heal: recent container logs unavailable",
    );
  }
  issues.push(...classifyRuntimeLogLines(logLines));
  const qa = classifyQAErrors(input.qaErrors);
  issues.push(...qa.issues);

  const deduped = new Map<string, PreviewRuntimeIssue>();
  for (const issue of issues) {
    const key = `${issue.kind}:${issue.message.toLowerCase()}`;
    if (!deduped.has(key)) deduped.set(key, issue);
  }
  return {
    issues: [...deduped.values()].slice(0, 20),
    inspectedLogLines: logLines.length,
    qaErrors: input.qaErrors.length,
    unavailableChecks: qa.unavailableChecks,
  };
}

export function buildPreviewRepairObservation(observation: PreviewRuntimeObservation): string {
  const lines = [
    "POST-BOOT PREVIEW RUNTIME OBSERVATION",
    "The build files were already written and the preview was booted before this observation.",
    "Make the smallest repair that addresses these runtime failures. Do not add features.",
  ];
  for (const [index, issue] of observation.issues.entries()) {
    lines.push(`${index + 1}. [${issue.kind}/${issue.source}] ${issue.message}`);
  }
  lines.push(
    `Evidence: ${observation.inspectedLogLines} recent container log line(s), ${observation.qaErrors} browser QA error(s).`,
  );
  return lines.join("\n").slice(0, 8_000);
}

export function previewSelfHealEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ZERO_PREVIEW_SELF_HEAL_ENABLED !== "false";
}
