import { eq, sql, and, inArray, desc, or, asc, isNull, count, ne } from "drizzle-orm";
import {
  db,
  pool,
  projectsTable,
  agentTasksTable,
  projectFilesTable,
  projectVersionsTable,
  previewSnapshotsTable,
  chatMessagesTable,
  taskEventsTable,
  knowledgeEntriesTable,
  secretsTable,
  deploymentLogsTable,
  buildAnalyticsTable,
  projectSuggestionsTable,
  checkRunsTable,
  appTestRunsTable,
  cveFindingsTable,
  projectDomainsTable,
  userSubscriptionsTable,
  projectActivityTable,
  notificationsTable,
  type AgentTaskCompletionKind,
  type TaskReport,
  type FileSnapshotEntry,
  type CvePatchStatus,
} from "@workspace/db";
import {
  runBuildPipeline,
  runRefinePipeline,
  runReactViteBuildPipeline,
  runReactViteRefinePipeline,
  runMobileBuildPipeline,
  runMobileRefinePipeline,
  runNextjsBuildPipeline,
  runNextjsRefinePipeline,
  runNodeApiBuildPipeline,
  runNodeApiRefinePipeline,
  runFlaskBuildPipeline,
  runFlaskRefinePipeline,
  runFastapiBuildPipeline,
  runFastapiRefinePipeline,
  runGoGinBuildPipeline,
  runGoGinRefinePipeline,
  runSlidesBuildPipeline,
  runSlidesRefinePipeline,
  runAnimationBuildPipeline,
  runAnimationRefinePipeline,
  runAutomationBuildPipeline,
  runAutomationRefinePipeline,
  scanCodeSmells,
  sanitisePrompt,
  scanForSecrets,
  validateCrossFileConsistency,
  runCvePatchPipeline,
  type BuilderFile,
  type ConversationTurn,
} from "./builder";
import { openai } from "@workspace/integrations-openai-ai-server";
import type { AgentMode } from "./ai";
import { detectRequiredStack } from "./ai";
import { logger } from "./logger";
import { writeKnowledge, getInstalledBlueprintKnowledge, inferStyleForUser } from "./knowledge";
import { generateEmbedding, cosineSimilarity } from "./embeddings";
import type { DiffSummary } from "@workspace/db";
import {
  getOrCreateCredits,
  deductCreditsAtomic,
  refundCredits,
  CREDITS_ENFORCEMENT_ENABLED,
} from "../routes/credits";
import { isSuperuser } from "./superusers";
import { extractPageMap } from "./page-map";
import { publishTaskEvent } from "./event-bus";
import {
  publishProjectFilesChanged,
  type ProjectFilesChangedPayload,
  publishPreviewReady,
  publishPreviewSyncFailed,
} from "./preview-events";
import { EventTypes } from "./event-types";
import { runAudit } from "./auditor";
import { runOrchestration } from "./checks/orchestrator";
import { getCheckByName } from "./checks/registry";
import { persistSecurityFindings } from "./security-findings";
import {
  triggerEasBuild,
  getEasBuildStatus,
  triggerEasSubmit,
  mapEasStatusToDeploymentStatus,
  type EasPlatform,
} from "./eas";
import { autoCommitProjectFiles } from "./github";
import { staleDraftCandidate } from "./testing-invalidation";
import { healthCheckPathForStack } from "./health-inject";
import { fetchAttachmentAsDataUri } from "../routes/images.js";
import { sendBuildFailureEmail } from "./emailClient";
import { getClerkUserById } from "./clerk-users";
import {
  shouldTriggerAutoFix,
  buildAutoFixPrompt,
  toReportShape as architectToReportShape,
  ARCHITECT_CREDIT_COST,
  ARCHITECT_AUTOFIX_TITLE_PREFIX,
} from "./architect";
import { encryptionService } from "./encryption";
import { DEVELOPER_MODE_RUNTIME_NOT_READY } from "./errors";
import {
  CHECK_PROFILES,
  PARTIAL_VALIDATION_WARNING,
  failedChecksEligibleForRepair,
  isDeferredCheckResult,
  resolveStackId,
} from "./check-profiles";
import { hasContainerLayerCredentials, isContainerLayerConfigured } from "./container";
import { architectureChangeMessage, shouldAutoDetectStack } from "./stack-selection";
import {
  buildAgentTaskTerminalUpdate,
  builderCompletionMessage,
  builderPersistedCompletionSummary,
} from "./builder-task-completion";

/**
 * Pre-build gate for agentic projects.
 *
 * 1. Capability guard — if builderMode is 'agentic' and containerId is null,
 *    runtime-only validation is deferred while the agent continues file work.
 *
 * 2. Container wake check — if the project has a containerId, wake it and
 *    wait up to 30 seconds for it to respond. Emits a narration event so the
 *    user sees "Waking your server…" in the chat.
 *
 * 3. Runtime proof test — after the container wakes, runs pwd / ls /app /
 *    write+read+delete to prove real container exec is working end-to-end.
 *    Fails hard if any step does not respond as expected.
 *
 * 4. Neon database health check — if the project has a DATABASE_URL secret,
 *    run a `SELECT 1` with 3-retry exponential back-off (1 s, 2 s, 4 s) to
 *    confirm the database is reachable before the agent loop starts.
 *
 * Returns { ok: false, message } when an available runtime check fails so the caller can
 * emit a "failed" event and abort the task instead of crashing mid-loop.
 * Returns { ok: true } when the project has no container (e.g. static-html)
 * or when FLY_API_TOKEN / NEON_API_KEY are not configured (dev-mode).
 */
async function runAgenticPreflightGate(
  projectId: number,
  taskId: number,
  containerId: string | null,
  containerUrl: string | null,
  builderMode?: string | null,
): Promise<{ ok: boolean; message?: string }> {
  const containerLayerOperational = await isContainerLayerConfigured();
  if (!containerLayerOperational) {
    if (!hasContainerLayerCredentials() && containerId) {
      await db
        .update(projectsTable)
        .set({ containerId: null, containerUrl: null, containerStatus: "stopped" })
        .where(eq(projectsTable.id, projectId));
      logger.info(
        { projectId, taskId, staleContainerId: containerId },
        "Cleared stale task container because the container layer is disabled",
      );
    }
    if (builderMode === "agentic") {
      await emitEvent(
        taskId,
        "live_server_deferred",
        "Live cloud-server infrastructure is unavailable for this project. Continuing with file and non-runtime validation; container-dependent checks are deferred.",
      );
    }
    return { ok: true };
  }

  // ── 0. Capability gap: agentic project with no container ────────────────
  // builderMode='agentic' means a container should exist, but provisioning
  // is an infrastructure capability gap, not an application failure. The loop
  // writes to project_files and defers runtime-only checks without repair turns.
  if (builderMode === "agentic" && !containerId) {
    await emitEvent(
      taskId,
      "live_server_deferred",
      "Live cloud-server infrastructure is unavailable for this project. Continuing with file and non-runtime validation; server startup and healthz are deferred.",
    );
    return { ok: true };
  }

  // ── 0b. Preflight heartbeat ───────────────────────────────────────────────
  // Write a heartbeat to agent_tasks before the container wake so the
  // stuck-run-scheduler's clock starts from now, not from when the job was
  // first enqueued.  The wake loop can take 3–4 min on a cold Fly machine.
  void (async () => {
    try {
      await db
        .update(agentTasksTable)
        .set({ lastHeartbeatAt: new Date() })
        .where(eq(agentTasksTable.id, taskId));
    } catch {
      // non-fatal — stuck-run will still fire after 8 min if the build truly hangs
    }
  })();

  // ── 1. Container wake check ──────────────────────────────────────────────
  if (containerId) {
    // Detect first-build: if no project_versions with validationStatus='passed' exist
    // then the container has never served a working app, so /healthz cannot possibly
    // respond. Skip the HTTP health check and only verify the container OS exec layer.
    // This covers both (a) truly first builds and (b) projects whose previous builds
    // all failed validation — the container is running but has no HTTP server yet.
    const [passedVersionRow] = await db
      .select({ n: count() })
      .from(projectVersionsTable)
      .where(
        and(
          eq(projectVersionsTable.projectId, projectId),
          eq(projectVersionsTable.validationStatus, "passed"),
        ),
      );
    const isFirstBuild = (passedVersionRow?.n ?? 0) === 0;

    if (isFirstBuild) {
      await emitEvent(
        taskId,
        "narration",
        "Starting fresh — waking your container for the first build…",
      );
      logger.info(
        { projectId, taskId, containerId },
        "First-build detected: skipping /healthz check — no app deployed yet",
      );
    } else {
      await emitEvent(taskId, "narration", "Waking your server…");
    }

    // For first builds pass null as containerUrl so ensureContainerAwake only
    // checks that the Fly machine is running (machine-level wake) and does NOT
    // poll /healthz (which would always fail before the first app is built).
    const effectiveContainerUrl = isFirstBuild ? null : containerUrl;

    const { ensureContainerAwake, execInContainer } = await import("./container");
    const { ContainerUnavailableError } = await import("./errors");
    let wakeResult: { ok: boolean; message?: string };
    try {
      wakeResult = await ensureContainerAwake(containerId, projectId, effectiveContainerUrl, 30);
    } catch (err) {
      if (err instanceof ContainerUnavailableError) {
        return {
          ok: false,
          message: DEVELOPER_MODE_RUNTIME_NOT_READY,
        };
      }
      throw err;
    }
    if (!wakeResult.ok) {
      // Single automatic retry after 10 s to recover from transient cold-start
      // delays without requiring the user to re-submit their prompt.
      logger.warn(
        { projectId, taskId, containerId },
        "Container did not wake on first attempt — waiting 10 s before retry",
      );
      await emitEvent(taskId, "narration", "Server is slow to wake — retrying in 10 seconds…");
      await new Promise((r) => setTimeout(r, 10_000));
      try {
        wakeResult = await ensureContainerAwake(containerId, projectId, effectiveContainerUrl, 30);
      } catch (err) {
        if (err instanceof ContainerUnavailableError) {
          return {
            ok: false,
            message: DEVELOPER_MODE_RUNTIME_NOT_READY,
          };
        }
        throw err;
      }
      if (!wakeResult.ok) {
        // /healthz is still not responding — the HTTP server process may have
        // crashed (e.g. the server throws at startup due to a missing env var).
        // The Fly machine itself can still be alive.  Verify exec-layer access:
        // if `ls /app` succeeds the agent CAN write files and fix the crash.
        logger.warn(
          { projectId, taskId, containerId },
          "Server not responding to /healthz — probing exec layer to detect crashed server process",
        );
        let execLayerOk: boolean;
        try {
          const execProbe = await execInContainer(containerId, ["ls", "/app"], projectId);
          execLayerOk = execProbe.ok;
        } catch {
          execLayerOk = false;
        }

        if (execLayerOk) {
          // Machine is running but the server process has crashed.
          // Allow the agent loop to proceed so it can fix the startup error.
          logger.info(
            { projectId, taskId, containerId },
            "Container exec layer accessible despite /healthz failure — server process likely crashed; proceeding so agent can fix it",
          );
          await emitEvent(
            taskId,
            "narration",
            "Server process appears to have crashed — proceeding to diagnose and fix…",
          );
        } else {
          return { ok: false, message: wakeResult.message ?? "Container did not wake in time." };
        }
      } else {
        await emitEvent(taskId, "narration", "Server woke up after a delay — proceeding");
        logger.info(
          { projectId, taskId, containerId },
          "Container awake after retry — proceeding with build",
        );
      }
    } else {
      logger.info(
        { projectId, taskId, containerId, isFirstBuild },
        "Container awake — proceeding with build",
      );
    }

    // ── 2. Runtime proof test ────────────────────────────────────────────────
    // Verify end-to-end container exec: pwd, ls /app, write → read → delete.
    // Any step failing here means the container cannot accept file writes and
    // the agent loop must not start.
    try {
      const pwdResult = await execInContainer(containerId, ["pwd"], projectId);
      if (!pwdResult.ok) {
        logger.warn({ projectId, taskId, containerId }, "Preflight proof: pwd failed");
        await emitEvent(taskId, "container_unavailable", DEVELOPER_MODE_RUNTIME_NOT_READY);
        return { ok: false, message: DEVELOPER_MODE_RUNTIME_NOT_READY };
      }

      const lsResult = await execInContainer(containerId, ["ls", "/app"], projectId);
      if (!lsResult.ok) {
        logger.warn({ projectId, taskId, containerId }, "Preflight proof: ls /app failed");
        await emitEvent(taskId, "container_unavailable", DEVELOPER_MODE_RUNTIME_NOT_READY);
        return { ok: false, message: DEVELOPER_MODE_RUNTIME_NOT_READY };
      }

      const writeResult = await execInContainer(
        containerId,
        ["/bin/sh", "-c", "printf 'runtime working' > /app/.mustaflow-runtime-test && echo ok"],
        projectId,
      );
      if (!writeResult.ok) {
        logger.warn({ projectId, taskId, containerId }, "Preflight proof: write test file failed");
        await emitEvent(taskId, "container_unavailable", DEVELOPER_MODE_RUNTIME_NOT_READY);
        return { ok: false, message: DEVELOPER_MODE_RUNTIME_NOT_READY };
      }

      const readResult = await execInContainer(
        containerId,
        ["cat", "/app/.mustaflow-runtime-test"],
        projectId,
      );
      const readContent = (readResult.stdout ?? readResult.output ?? "").trim();
      if (!readResult.ok || readContent !== "runtime working") {
        logger.warn(
          { projectId, taskId, containerId, readContent },
          "Preflight proof: read test file content mismatch",
        );
        await emitEvent(taskId, "container_unavailable", DEVELOPER_MODE_RUNTIME_NOT_READY);
        return { ok: false, message: DEVELOPER_MODE_RUNTIME_NOT_READY };
      }

      await execInContainer(containerId, ["rm", "-f", "/app/.mustaflow-runtime-test"], projectId);

      logger.info({ projectId, taskId, containerId }, "Preflight proof test passed");
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn(
        { err, projectId, taskId, containerId },
        "Preflight proof test failed with exception",
      );
      await emitEvent(taskId, "container_unavailable", DEVELOPER_MODE_RUNTIME_NOT_READY);
      if (err instanceof ContainerUnavailableError) {
        return { ok: false, message: DEVELOPER_MODE_RUNTIME_NOT_READY };
      }
      return {
        ok: false,
        message: `${DEVELOPER_MODE_RUNTIME_NOT_READY} (${errMsg.slice(0, 120)})`,
      };
    }

    // ── 3. Neon database health check ───────────────────────────────────────
    // Only run if the project has a DATABASE_URL secret.
    try {
      const [secretRow] = await db
        .select({ valueEncrypted: secretsTable.valueEncrypted })
        .from(secretsTable)
        .where(and(eq(secretsTable.projectId, projectId), eq(secretsTable.name, "DATABASE_URL")));

      if (secretRow?.valueEncrypted) {
        const databaseUrl = encryptionService.decrypt(secretRow.valueEncrypted);

        // 3-retry exponential back-off: 1 s, 2 s, 4 s
        let dbOk = false;
        let lastDbError = "";
        const delays = [1_000, 2_000, 4_000];
        for (let attempt = 0; attempt < delays.length; attempt++) {
          try {
            const pg = await import("pg");
            const client = new pg.default.Client({
              connectionString: databaseUrl,
              connectionTimeoutMillis: 5_000,
            });
            await client.connect();
            await client.query("SELECT 1");
            await client.end();
            dbOk = true;
            break;
          } catch (err) {
            lastDbError = err instanceof Error ? err.message : String(err);
            logger.warn(
              { projectId, taskId, attempt, err: lastDbError },
              "DB health check attempt failed",
            );
            if (attempt < delays.length - 1) {
              await new Promise((r) => setTimeout(r, delays[attempt]));
            }
          }
        }

        if (!dbOk) {
          return {
            ok: false,
            message: `Your database is unreachable after 3 attempts. Check your DATABASE_URL secret and retry. (${lastDbError.slice(0, 120)})`,
          };
        }

        logger.info({ projectId, taskId }, "Database health check passed");
      }
    } catch (err) {
      // Secret lookup or decrypt error — surface to user as a hard failure.
      // A decrypt error indicates a misconfigured ENCRYPTION_KEY; a DB error
      // here means even the platform DB is unreachable, both are blocking.
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ err, projectId, taskId }, "DB pre-flight check failed with unexpected error");
      return {
        ok: false,
        message: `Database pre-flight check failed unexpectedly: ${errMsg.slice(0, 120)}`,
      };
    }
  }

  return { ok: true };
}

/**
 * Credit cost per AI call, keyed by agentMode. Kept as a flat table for
 * backwards compat with callers that don't know the resolved provider. For
 * provider-aware costing use `creditCostFor(mode, provider)` from
 * `./ai-providers.ts` — it applies the per-provider multiplier so a Claude
 * Opus build costs proportionally more than the equivalent gpt-5 build.
 */
export const CREDIT_COST: Record<string, number> = {
  lite: 1,
  eco: 2,
  power: 5,
  pro: 10,
};

/**
 * Sentinel prefix for domain-rewrite refine tasks enqueued by the domain
 * attachment/promotion flow. Jobs with this prefix:
 *   - Skip architect review (mechanical URL rewrite, not a logic change).
 *   - Are recognised in the builder as needing domain-focused rewrite prompts.
 */
export const DOMAIN_REWRITE_SENTINEL = "[domain-rewrite]";

/**
 * Per-mode wall-clock cap for long-running background workflows (Task #509).
 * Foreground jobs use the lower default in agent-loop.ts. Background jobs may
 * run up to 30 minutes — these caps gate when the loop must give up.
 */
export const BACKGROUND_WALL_CLOCK_MS: Record<string, number> = {
  lite: 10 * 60_000,
  eco: 15 * 60_000,
  power: 25 * 60_000,
  pro: 30 * 60_000,
};

export function backgroundWallClockFor(mode: AgentMode | string): number {
  return BACKGROUND_WALL_CLOCK_MS[mode] ?? 15 * 60_000;
}

/** OpenAI model per agent mode — kept in sync with builder.ts for analytics recording. */
const MODEL_FOR_MODE: Record<AgentMode, string> = {
  lite: "gpt-5-nano",
  eco: "gpt-5-mini",
  power: "gpt-5.4",
  pro: "gpt-5.4",
};

/**
 * Auto-escalation: if correction pass fails, retry at the next model tier.
 * Capped at one level to avoid runaway credit consumption.
 * power/pro both use the same model so escalation stops there.
 */
const ESCALATION_MAP: Partial<Record<AgentMode, AgentMode>> = {
  lite: "eco",
  eco: "power",
};

/**
 * Maximum repair-loop attempts per agent mode (Phase 2A — TypeScript repair).
 * Higher modes get more attempts; lite is single-shot to keep costs predictable.
 */
function repairLoopMaxAttempts(mode: AgentMode): number {
  if (mode === "lite") return 1;
  if (mode === "pro") return 3;
  return 2; // eco, power
}

/**
 * Detect the dominant failure category from a set of failed check labels/outputs.
 * Used to route buildRepairPrompt to the right targeted instructions.
 */
function detectRepairCategory(
  failedChecks: Array<{ label: string; output: string }>,
): "server-start" | "install" | "typecheck" | "build" | "preview" | "generic" {
  const combined = failedChecks
    .map((c) => `${c.label} ${c.output}`)
    .join(" ")
    .toLowerCase();
  if (/server.*start|healthz|not reachable|port|listen|eaddrinuse/.test(combined))
    return "server-start";
  if (/install|npm.*err|dependency|package.*not found|oom|sigkill|exit 137|lock/.test(combined))
    return "install";
  if (/tsc|typescript|type error|ts\(/.test(combined)) return "typecheck";
  if (/vite|build.*fail|compilation/.test(combined)) return "build";
  if (/preview|iframe|http 200|reachable/.test(combined)) return "preview";
  return "generic";
}

/**
 * Build a focused repair prompt from failed quality-gate check results.
 * Routes to a category-specific template so the agent receives targeted
 * instructions instead of a generic retry. When previousErrors is provided,
 * the prompt also explains how errors changed between attempts.
 */
function buildRepairPrompt(
  failedChecks: Array<{ label: string; output: string }>,
  recentlyChangedPaths: string[],
  attemptNumber = 1,
  previousErrors: Array<{ label: string; output: string }> = [],
): string {
  const errorDetail = failedChecks
    .map((c) => `### ${c.label}\n${c.output.slice(0, 1500)}`)
    .join("\n\n");
  const fileHint =
    recentlyChangedPaths.length > 0
      ? `\nRecently changed files (most likely sources of errors):\n${recentlyChangedPaths.map((p) => `- ${p}`).join("\n")}`
      : "";

  // On attempt 2+, compare against previous errors so the agent understands
  // whether it made progress and should try a different approach.
  let progressSection = "";
  if (attemptNumber >= 2 && previousErrors.length > 0) {
    const prevLabels = new Set(previousErrors.map((e) => e.label));
    const currLabels = new Set(failedChecks.map((e) => e.label));
    const fixed = [...prevLabels].filter((l) => !currLabels.has(l));
    const newlyBroken = [...currLabels].filter((l) => !prevLabels.has(l));
    const unchanged = [...currLabels].filter((l) => prevLabels.has(l));

    const progressLines: string[] = [];
    if (fixed.length > 0) progressLines.push(`  FIXED: ${fixed.join(", ")}`);
    if (newlyBroken.length > 0)
      progressLines.push(
        `  NEW errors introduced: ${newlyBroken.join(", ")} — do NOT introduce new failures`,
      );
    if (unchanged.length > 0)
      progressLines.push(`  UNCHANGED (still failing): ${unchanged.join(", ")}`);

    progressSection =
      `\n[PROGRESS SINCE LAST ATTEMPT]\n` +
      progressLines.join("\n") +
      (unchanged.length > 0
        ? `\n\nIMPORTANT: The same checks are still failing after attempt ${attemptNumber - 1}. ` +
          `Your previous patch did not resolve them. Try a DIFFERENT strategy:\n` +
          `  - Read the file(s) again to check what actually landed on disk\n` +
          `  - Check imports/exports in related modules for contract mismatches\n` +
          `  - Replace the whole failing module with a minimal correct version\n` +
          `  - Add an explicit type annotation or cast instead of restructuring logic\n` +
          `Do NOT repeat the same patch approach.`
        : "");
  }

  // Route to a category-specific header + rules so the model receives
  // targeted instructions rather than a generic TypeScript-only prompt.
  const category = detectRepairCategory(failedChecks);

  const categoryHeaders: Record<typeof category, string[]> = {
    "server-start": [
      `[REPAIR attempt ${attemptNumber}] The server did not start or /healthz did not respond.`,
      "Fix ONLY the server startup problem. Do NOT add new features.",
      "Rules:",
      "  1. read_file the server entry point (src/index.ts, server.ts, app.ts, or equivalent)",
      "  2. Check that the server calls app.listen(Number(process.env.PORT) || 3000)",
      "  3. Verify the package.json 'start' or 'dev' script points to the correct entry file",
      "  4. Add a GET /healthz route that always returns HTTP 200 and never touches the database",
      "  5. Ensure no module-level throws on missing env vars — use lazy initialization",
      "  6. After fixing, run_command(['node', 'src/index.ts']) or the equivalent to verify it starts",
      "Do NOT call finalize until GET /healthz returns HTTP 200.",
    ],
    install: [
      `[REPAIR attempt ${attemptNumber}] Dependency install failed.`,
      "Fix ONLY the install problem. Do NOT write feature code.",
      "Rules:",
      "  1. read_file package.json — check for typos, version conflicts, unsupported package names",
      "  2. If exit 137 / SIGKILL: remove large optional packages to reduce memory pressure",
      "  3. If 'idealTree' / lock error: run_command(['rm', '-f', '/root/.npm/_locks/*'])",
      "  4. If ENOTFOUND / ETIMEDOUT: verify the package name on npmjs.com — it may be misspelled",
      "  5. If E404: the package does not exist at that version — find the correct version",
      "  6. After fixing package.json, pkg_install will re-run automatically on the next check",
      "Do NOT add more packages — fix the existing install problem first.",
    ],
    typecheck: [
      `[REPAIR attempt ${attemptNumber}] TypeScript errors were detected.`,
      "Fix ONLY the TypeScript errors listed below. Do NOT add new features.",
      "Rules:",
      "  - Fix only the files involved in the errors",
      "  - Do NOT use `any` or `@ts-ignore` to bypass errors",
      "  - Do NOT disable strict TypeScript checks",
      "  - Do NOT remove working features to make errors disappear",
      "  - Make the smallest safe change that resolves each listed error",
      "  - Preserve all existing UI and behavior",
    ],
    build: [
      `[REPAIR attempt ${attemptNumber}] Build (Vite/tsc --build) failed.`,
      "Fix ONLY the compilation error. Do NOT add new features.",
      "Rules:",
      "  1. run_command(['npm', 'run', 'build']) and read the FULL output",
      "  2. read_file every file mentioned in the error stack",
      "  3. Fix ONLY the compilation error: missing imports, invalid JSX, circular deps",
      "  4. Do not add new routes or components until the build passes",
      "Do NOT call finalize until npm run build exits 0.",
    ],
    preview: [
      `[REPAIR attempt ${attemptNumber}] Preview is not reachable.`,
      "Diagnose and fix the preview/server/proxy problem. Do NOT edit UI features.",
      "Rules:",
      "  1. run_command(['cat', '/proc/1/status']) — check if the server process is alive",
      "  2. run_command the start command and watch for immediate exit or port conflict",
      "  3. Verify PORT is read from process.env.PORT",
      "  4. Verify GET /healthz returns HTTP 200",
      "  5. Fix any crash reported in container logs before touching feature code",
    ],
    generic: [
      `[REPAIR attempt ${attemptNumber}] Required checks failed after the last change.`,
      "Fix ONLY the failures listed below. Do NOT add new features.",
      "Rules:",
      "  - Read each failing file before editing",
      "  - Make the smallest safe change that resolves each listed error",
      "  - Re-run the relevant check after fixing",
    ],
  };

  return [
    ...categoryHeaders[category],
    progressSection,
    "",
    "ERRORS TO FIX:",
    errorDetail,
    fileHint,
  ]
    .filter((s) => s !== "")
    .join("\n");
}

/**
 * In-memory per-project advisory lock.
 * Prevents concurrent runJob calls for the same project within this Node.js process.
 * The route-level conflict check is the primary guard; this is a safety net.
 */
const activeProjectJobs = new Set<number>();

/**
 * Registry of AbortControllers for in-flight AI builds, keyed by taskId.
 * Used by cancelActiveJob() to abort a running pipeline mid-flight.
 */
const activeJobControllers = new Map<number, AbortController>();

/**
 * Abort an in-flight build job by taskId.
 * Returns true if a controller was found and aborted, false if the task wasn't running.
 */
export function cancelActiveJob(taskId: number): boolean {
  const controller = activeJobControllers.get(taskId);
  if (controller) {
    controller.abort();
    activeJobControllers.delete(taskId);
    return true;
  }
  return false;
}

export type JobKind = "build" | "refine";

export type AgentIdentity = "planning" | "task" | "main";

export interface JobInput {
  taskId: number;
  projectId: number;
  kind: JobKind;
  userPrompt: string;
  agentMode: AgentMode;
  /** Which visible executor handles this task. New work uses planning or main; task is legacy. */
  agentIdentity?: AgentIdentity;
  /** Source surface that created the task. Mirrors chat_messages.origin. */
  origin?: string | null;
  /** Structured plan from the Planning Agent (injected into build/refine prompt). */
  planContext?: Record<string, unknown> | null;
  conversationHistory?: ConversationTurn[];
  /** Vision image attachments (data URIs) the user uploaded with this prompt. */
  imageAttachments?: Array<{ dataUri: string; alt?: string }>;
  queueBatchId?: string | null;
  queueIndex?: number | null;
  queueTotalCount?: number | null;
  /** "background" jobs run with extended wall-clock + skip post-success deduction. */
  runMode?: "foreground" | "background";
  /** Wall-clock cap (ms) to pass into the agent loop. */
  wallClockCapMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent routing — deterministic rules (no AI)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determine which visible executor should handle a request.
 * Agent Zero v2 keeps background, batch, and initial builds on Main Agent so
 * preview receives committed project_files instead of hidden staging snapshots.
 */
export function resolveAgentIdentity(
  _prompt: string,
  _projectHasFiles: boolean,
  _isBackground: boolean,
  _isBatchQueued: boolean,
  planMode: boolean,
): AgentIdentity {
  if (planMode) return "planning";
  return "main";
}

async function emitEvent(
  taskId: number,
  eventType: string,
  message: string,
  filePath?: string,
  data?: Record<string, unknown>,
): Promise<void> {
  try {
    const [row] = await db
      .insert(taskEventsTable)
      .values({
        taskId,
        eventType,
        message,
        filePath: filePath ?? null,
        data: data ?? null,
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
    logger.warn({ err, taskId, eventType }, "Failed to emit task event");
  }
}

async function finalizeAgentTaskWithEvent(input: {
  taskId: number;
  completionKind: AgentTaskCompletionKind;
  currentStep: number;
  message: string;
}): Promise<boolean> {
  const completedAt = new Date();
  const terminalTaskUpdate = buildAgentTaskTerminalUpdate({
    completionKind: input.completionKind,
    finalStepCount: input.currentStep,
    completedAt,
  });
  const terminalEvent = await db.transaction(async (tx) => {
    const [updatedTask] = await tx
      .update(agentTasksTable)
      .set(terminalTaskUpdate)
      .where(
        and(
          eq(agentTasksTable.id, input.taskId),
          // A cancel that wins this race remains authoritative.
          inArray(agentTasksTable.status, ["building", "planning"]),
        ),
      )
      .returning({ id: agentTasksTable.id });

    if (!updatedTask) return null;

    const [event] = await tx
      .insert(taskEventsTable)
      .values({
        taskId: input.taskId,
        eventType: "completed",
        message: input.message,
        filePath: null,
        data: null,
        createdAt: completedAt,
      })
      .returning();
    return event ?? null;
  });

  if (!terminalEvent) return false;

  publishTaskEvent({
    id: terminalEvent.id,
    taskId: terminalEvent.taskId,
    eventType: terminalEvent.eventType,
    message: terminalEvent.message,
    filePath: terminalEvent.filePath ?? null,
    data: (terminalEvent.data as Record<string, unknown> | undefined) ?? undefined,
    createdAt: terminalEvent.createdAt,
  });
  return true;
}

/**
 * Publishes a canonical, safe PROJECT_FILES_CHANGED payload to both the
 * project-wide preview stream and, when taskId is present, the task stream.
 */
function emitFilesChangedEvent(
  taskId: number,
  projectId: number,
  files: BuilderFile[],
  removedPaths: string[],
  operationType: ProjectFilesChangedPayload["operationType"],
): void {
  try {
    const payload = publishProjectFilesChanged(
      projectId,
      files.map((f) => ({ path: f.path, content: f.content })),
      removedPaths,
      operationType,
    );
    publishTaskEvent({
      id: 0,
      taskId,
      eventType: EventTypes.PROJECT_FILES_CHANGED,
      message: `${payload.changedPaths.length} file(s) updated`,
      filePath: null,
      createdAt: new Date(),
      data: payload,
    });
  } catch (err) {
    logger.warn({ err, taskId }, "project_files_changed emit failed (non-fatal)");
  }
}

// ── Preview reachability verification ─────────────────────────────────────────
/**
 * After a preview refresh is triggered (updating_preview event), poll the
 * container's /healthz endpoint to verify the server is actually serving
 * before marking previewUpdated: true in the task report.
 *
 * Emits granular events so the Builder timeline shows real reachability state
 * instead of optimistically reporting success.
 *
 * Event sequence on success:
 *   preview_refresh_requested → preview_server_reachable → preview_ready
 *
 * Event sequence on timeout/failure:
 *   preview_refresh_requested → preview_unreachable_503
 *
 * @param taskId       - Task ID for emitting events
 * @param containerUrl - Base URL of the container (e.g. https://project-83.fly.dev)
 * @param opts         - maxWaitMs (default 75 s), intervalMs (default 5 s), signal
 */
async function pollPreviewReachability(
  taskId: number,
  containerUrl: string,
  opts: {
    healthPath?: string;
    maxWaitMs?: number;
    intervalMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<{ reachable: boolean; httpStatus: number | null }> {
  const maxWaitMs = opts.maxWaitMs ?? 75_000; // 75-second ceiling
  const intervalMs = opts.intervalMs ?? 5_000; // check every 5 s
  const healthPath = opts.healthPath ?? "/healthz";
  const signal = opts.signal;
  const deadline = Date.now() + maxWaitMs;

  await emitEvent(
    taskId,
    "preview_refresh_requested",
    "Preview refresh requested, verifying server is reachable…",
  );

  const healthzUrl = containerUrl.replace(/\/$/, "") + healthPath;
  let lastHttpStatus: number | null = null;

  while (Date.now() < deadline) {
    if (signal?.aborted) break;

    try {
      const res = await fetch(healthzUrl, {
        signal: AbortSignal.timeout(4_000),
        headers: { "User-Agent": "mustaflow-preview-check/1.0" },
      });
      lastHttpStatus = res.status;

      if (res.status === 200) {
        logger.info({ taskId, containerUrl, httpStatus: 200 }, "Preview server reachable");
        await emitEvent(taskId, "preview_server_reachable", "Preview server responded (HTTP 200).");
        await emitEvent(taskId, "preview_ready", "Preview is ready.");
        return { reachable: true, httpStatus: 200 };
      }

      logger.debug(
        { taskId, containerUrl, httpStatus: res.status },
        "Preview poll: non-200, retrying…",
      );
    } catch {
      // Network timeout or DNS failure — keep polling
    }

    // Only sleep if we still have budget left
    if (Date.now() + intervalMs < deadline) {
      await new Promise<void>((r) => setTimeout(r, intervalMs));
    }
  }

  const statusLabel = lastHttpStatus !== null ? `HTTP ${lastHttpStatus}` : "no response";
  logger.warn(
    { taskId, containerUrl, lastHttpStatus, maxWaitMs },
    "Preview server not reachable within cap — marking preview as unreachable",
  );
  await emitEvent(
    taskId,
    "preview_unreachable_503",
    `Preview is not yet reachable (${statusLabel}). Files were saved — the preview will load once your server starts.`,
  );
  return { reachable: false, httpStatus: lastHttpStatus };
}

// ── Per-task LLM token counter ────────────────────────────────────────────────
// Accumulates an approximate token count (chars / 4) from streaming deltas.
// Written to agent_tasks.token_count on task completion and then cleared.
// Module-level so it survives across async pipeline steps within the same
// process. The entry is always removed when a task reaches a terminal state.
const taskTokenCounters = new Map<number, number>();

/**
 * Return the accumulated token count for a task and remove it from the map.
 * Returns 0 if no tokens were recorded (e.g. early pre-flight failures).
 */
function flushTokenCount(taskId: number): number {
  const count = taskTokenCounters.get(taskId) ?? 0;
  taskTokenCounters.delete(taskId);
  return count;
}

/**
 * Emit a token delta directly to the event bus without persisting to the DB.
 * Used for streaming code-generation output so the frontend can show a live
 * typing effect while the builder accumulates the full response.
 * Also accumulates an approximate token count (chars / 4) for billing analytics.
 */
function emitTokenEvent(taskId: number, delta: string): void {
  publishTaskEvent({
    id: 0,
    taskId,
    eventType: "token",
    message: delta,
    filePath: null,
    createdAt: new Date(),
  });
  // Approximate: 1 token ≈ 4 characters of English text.
  const approxTokens = Math.ceil(delta.length / 4);
  taskTokenCounters.set(taskId, (taskTokenCounters.get(taskId) ?? 0) + approxTokens);
}

async function loadFiles(projectId: number): Promise<BuilderFile[]> {
  const rows = await db
    .select()
    .from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, projectId));
  return rows.map((r) => ({
    path: r.path,
    content: r.content,
    mimeType: r.mimeType,
  }));
}

async function snapshotFilesForVersion(projectId: number): Promise<FileSnapshotEntry[]> {
  const rows = await db
    .select()
    .from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, projectId));
  return rows.map((r) => ({
    path: r.path,
    content: r.content,
    mimeType: r.mimeType,
  }));
}

/**
 * Bulk-safe file writer. For replaceAll (initial build): one DELETE + one bulk INSERT.
 * For refine (replaceAll=false): one DELETE of affected paths + one bulk INSERT.
 * Eliminates the N+1 per-file loop.
 */
async function writeFiles(
  projectId: number,
  files: BuilderFile[],
  replaceAll: boolean,
  artifactId?: number | null,
): Promise<void> {
  // Resolve which artifact the new file rows should be stamped with (Task #544).
  // Defaults to the project's primary artifact so legacy callers keep working.
  const { resolveArtifactId } = await import("./artifacts");
  const resolvedArtifactId = await resolveArtifactId(projectId, artifactId ?? null);

  if (replaceAll) {
    if (resolvedArtifactId !== null) {
      // Scope the wipe to the active artifact so other artifacts in the same
      // project aren't clobbered by a rebuild of one of them.
      await db
        .delete(projectFilesTable)
        .where(
          and(
            eq(projectFilesTable.projectId, projectId),
            eq(projectFilesTable.artifactId, resolvedArtifactId),
          ),
        );
    } else {
      await db.delete(projectFilesTable).where(eq(projectFilesTable.projectId, projectId));
    }
  } else if (files.length > 0) {
    const baseConds = [
      eq(projectFilesTable.projectId, projectId),
      inArray(
        projectFilesTable.path,
        files.map((f) => f.path),
      ),
    ];
    if (resolvedArtifactId !== null) {
      baseConds.push(eq(projectFilesTable.artifactId, resolvedArtifactId));
    }
    await db.delete(projectFilesTable).where(and(...baseConds));
  }
  if (files.length > 0) {
    await db.insert(projectFilesTable).values(
      files.map((f) => ({
        projectId,
        artifactId: resolvedArtifactId,
        path: f.path,
        content: f.content,
        mimeType: f.mimeType,
      })),
    );
  }
}

/**
 * Bulk-safe file deleter — one DELETE with inArray instead of N individual deletes.
 */
async function deleteFiles(projectId: number, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await db
    .delete(projectFilesTable)
    .where(and(eq(projectFilesTable.projectId, projectId), inArray(projectFilesTable.path, paths)));
}

/** Map of integration name → required secret key names (subset of the frontend registry). */
const INTEGRATION_KEY_MAP: Array<{ name: string; keys: string[] }> = [
  { name: "OpenAI", keys: ["OPENAI_API_KEY"] },
  { name: "Anthropic", keys: ["ANTHROPIC_API_KEY"] },
  { name: "Gemini", keys: ["GEMINI_API_KEY"] },
  { name: "Clerk", keys: ["CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY"] },
  { name: "Auth0", keys: ["AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET"] },
  { name: "Supabase Auth", keys: ["SUPABASE_URL", "SUPABASE_ANON_KEY"] },
  {
    name: "Firebase Auth",
    keys: ["FIREBASE_API_KEY", "FIREBASE_AUTH_DOMAIN", "FIREBASE_PROJECT_ID"],
  },
  { name: "PostgreSQL / Neon", keys: ["DATABASE_URL"] },
  { name: "Supabase", keys: ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_KEY"] },
  { name: "Firebase Firestore", keys: ["FIREBASE_PROJECT_ID", "FIREBASE_API_KEY"] },
  {
    name: "AWS S3",
    keys: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_S3_BUCKET", "AWS_REGION"],
  },
  {
    name: "Cloudflare R2",
    keys: ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_ACCOUNT_ID"],
  },
  { name: "Supabase Storage", keys: ["SUPABASE_URL", "SUPABASE_SERVICE_KEY"] },
  {
    name: "Stripe",
    keys: ["STRIPE_PUBLISHABLE_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
  },
  {
    name: "Stripe Connect",
    keys: ["STRIPE_PUBLISHABLE_KEY", "STRIPE_SECRET_KEY", "STRIPE_CONNECT_CLIENT_ID"],
  },
  { name: "Google Maps", keys: ["GOOGLE_MAPS_API_KEY"] },
  {
    name: "Apple Maps",
    keys: ["APPLE_MAPS_KEY_ID", "APPLE_MAPS_TEAM_ID", "APPLE_MAPS_PRIVATE_KEY"],
  },
  { name: "Mapbox", keys: ["MAPBOX_PUBLIC_TOKEN"] },
  { name: "Resend", keys: ["RESEND_API_KEY"] },
  { name: "SendGrid", keys: ["SENDGRID_API_KEY"] },
  { name: "Mailgun", keys: ["MAILGUN_API_KEY", "MAILGUN_DOMAIN"] },
  { name: "Twilio", keys: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"] },
  { name: "Firebase Cloud Messaging", keys: ["FIREBASE_PROJECT_ID", "FIREBASE_SERVER_KEY"] },
  { name: "PostHog", keys: ["POSTHOG_API_KEY", "POSTHOG_HOST"] },
  { name: "Sentry", keys: ["SENTRY_DSN"] },
  { name: "Google Analytics", keys: ["GA_MEASUREMENT_ID"] },
  { name: "GitHub", keys: ["GITHUB_TOKEN"] },
  { name: "Vercel", keys: ["VERCEL_TOKEN"] },
  { name: "Render", keys: ["RENDER_API_KEY"] },
  { name: "Fly.io", keys: ["FLY_API_TOKEN"] },
  { name: "Railway", keys: ["RAILWAY_API_TOKEN"] },
];

async function loadActiveIntegrations(projectId: number): Promise<string> {
  try {
    const rows = await db
      .select({ name: secretsTable.name, verificationStatus: secretsTable.verificationStatus })
      .from(secretsTable)
      .where(eq(secretsTable.projectId, projectId));
    const secretMap = new Map(rows.map((r) => [r.name, r.verificationStatus ?? "unverified"]));
    const active = INTEGRATION_KEY_MAP.filter((integration) =>
      integration.keys.every((k) => secretMap.has(k) && secretMap.get(k) === "verified"),
    ).map((i) => i.name);
    const partial = INTEGRATION_KEY_MAP.filter((integration) => {
      const isActive = active.includes(integration.name);
      if (isActive) return false;
      const somePresent = integration.keys.some((k) => secretMap.has(k));
      return somePresent;
    }).map((i) => i.name);
    const parts: string[] = [];
    if (active.length > 0) {
      parts.push(
        `ACTIVE INTEGRATIONS (connected and verified): ${active.join(", ")}. When generating or refining code, prefer these services over alternatives and reference their environment variables from project secrets.`,
      );
    }
    if (partial.length > 0) {
      parts.push(
        `PARTIALLY CONFIGURED (keys present but not yet verified): ${partial.join(", ")}. These may work but have not been verified — mention them if the user asks.`,
      );
    }
    return parts.join("\n");
  } catch {
    return "";
  }
}

type KnowledgeContextResult = {
  context: string;
  applied: Array<{ id: number; title: string; category: string }>;
};

/**
 * Compute a diff summary for an initial build (previous = empty).
 */
function computeBuildDiff(newFiles: BuilderFile[]): DiffSummary {
  const filesAdded = newFiles.map((f) => f.path);
  const linesAdded = newFiles.reduce((sum, f) => sum + f.content.split("\n").length, 0);
  return { filesAdded, filesModified: [], filesRemoved: [], linesAdded, linesRemoved: 0 };
}

/**
 * Compute a diff summary for a refine operation from the existing file set.
 */
function computeRefineDiff(
  existingFiles: BuilderFile[],
  changedFiles: BuilderFile[],
  removedPaths: string[],
): DiffSummary {
  const prevMap = new Map(existingFiles.map((f) => [f.path, f.content]));
  const filesAdded: string[] = [];
  const filesModified: string[] = [];
  let linesAdded = 0;
  let linesRemoved = 0;

  for (const f of changedFiles) {
    if (!prevMap.has(f.path)) {
      filesAdded.push(f.path);
      linesAdded += f.content.split("\n").length;
    } else if (prevMap.get(f.path) !== f.content) {
      filesModified.push(f.path);
      const newLines = f.content.split("\n").length;
      const prevLines = (prevMap.get(f.path) ?? "").split("\n").length;
      linesAdded += Math.max(0, newLines - prevLines);
      linesRemoved += Math.max(0, prevLines - newLines);
    }
  }

  for (const path of removedPaths) {
    linesRemoved += (prevMap.get(path) ?? "").split("\n").length;
  }

  return { filesAdded, filesModified, filesRemoved: removedPaths, linesAdded, linesRemoved };
}

/**
 * Tokenise a string into a set of meaningful lowercase words (≥3 chars).
 */
function tokenise(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[\s,.:;_\-/()[\]{}'"!?]+/)
      .filter((w) => w.length >= 3),
  );
}

/**
 * Configurable token budget for the Knowledge Vault context section (in characters;
 * ~4 chars per token is a reasonable approximation for English prose).
 * Set KNOWLEDGE_TOKEN_BUDGET env var to override. Default: 2400 chars (~600 tokens).
 */
const KNOWLEDGE_CHAR_BUDGET = parseInt(process.env.KNOWLEDGE_TOKEN_BUDGET ?? "2400", 10);

/**
 * Relevance-ranked knowledge injection with embedding similarity (primary) and
 * TF-IDF (fallback) plus recency + severity + project scoring.
 *
 * Eligibility: project-scoped entries for this project, plus globally approved entries.
 * Ranking signals (combined additively, then approved multiplier):
 *   - Semantic match: cosine similarity × 6.0 when both prompt + entry have an
 *     embedding; otherwise TF-IDF keyword overlap (per-entry graceful fallback).
 *   - Recency: entries created in last 24 h (+2.0), last 7 days (+1.0)
 *   - Severity: "error" (+1.5), "warning" (+0.5)
 *   - Approved for reuse: ×1.5 boost
 *   - Same project: +2.0 additive boost (prefer own history)
 *
 * Token budget: lower-scoring entries are dropped first until the total character
 * count fits within KNOWLEDGE_CHAR_BUDGET.
 *
 * Controlled by KNOWLEDGE_RETRIEVAL_ENABLED env var (default: true).
 * When disabled, only the integrations note is returned (no vault entries).
 *
 * Returns both the formatted context string and the applied entry metadata
 * (id + title + category) so they can be surfaced in the TaskReport.
 */
// Exported for the Ora↔Builder isolation regression test
// (src/lib/__tests__/ora-builder-isolation.test.ts). The reverse-leak guard
// inside this query — `or(isNull(origin), ne(origin, "ora"))` — is the
// load-bearing filter that keeps personal Ora memories out of build prompts.
export async function loadKnowledgeContext(
  projectId: number,
  userPrompt?: string,
): Promise<KnowledgeContextResult> {
  try {
    const retrievalEnabled = process.env.KNOWLEDGE_RETRIEVAL_ENABLED !== "false";

    // Look up the project owner so we can also pull in their user-scope
    // entries (e.g. brand profile, inferred style preferences).
    const [ownerRow] = retrievalEnabled
      ? await db
          .select({ ownerId: projectsTable.ownerId })
          .from(projectsTable)
          .where(eq(projectsTable.id, projectId))
          .limit(1)
      : [undefined];
    const ownerId = ownerRow?.ownerId ?? null;

    const [entries, integrationsNote] = await Promise.all([
      retrievalEnabled
        ? db
            .select()
            .from(knowledgeEntriesTable)
            .where(
              and(
                or(
                  eq(knowledgeEntriesTable.approvedForReuse, true),
                  eq(knowledgeEntriesTable.projectId, projectId),
                  ownerId
                    ? and(
                        eq(knowledgeEntriesTable.userId, ownerId),
                        eq(knowledgeEntriesTable.scope, "user"),
                      )
                    : sql`false`,
                ),
                // ISOLATION (reverse leak): the AI Builder must NEVER pull
                // origin="ora" entries into a build's knowledge context. This
                // guard applies to the entire eligibility query — the
                // approved-for-reuse, project-scoped, and user-scope branches
                // above — so personal Ora memories can never become "lessons
                // from prior builds". (NULL origin is legacy/pre-backfill and
                // is treated as Builder-owned.)
                or(isNull(knowledgeEntriesTable.origin), ne(knowledgeEntriesTable.origin, "ora")),
                isNull(knowledgeEntriesTable.archivedAt),
              ),
            )
            .orderBy(desc(knowledgeEntriesTable.createdAt))
            .limit(100)
        : Promise.resolve([] as import("@workspace/db").KnowledgeEntry[]),
      loadActiveIntegrations(projectId),
    ]);

    if (entries.length === 0) {
      return { context: integrationsNote, applied: [] };
    }

    const now = Date.now();
    const ONE_DAY_MS = 86_400_000;
    const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;

    const APPROVED_BOOST = 1.5;
    const SEVERITY_SCORE: Record<string, number> = { error: 1.5, warning: 0.5, info: 0 };
    const SAME_PROJECT_BOOST = 2.0;
    const USAGE_WEIGHT = parseFloat(process.env.KNOWLEDGE_USAGE_WEIGHT ?? "0.1");
    const FEEDBACK_WEIGHT = parseFloat(process.env.KNOWLEDGE_FEEDBACK_WEIGHT ?? "0.2");

    let topEntries: typeof entries;

    if (userPrompt && userPrompt.length > 0) {
      const promptTokens = tokenise(userPrompt);
      const N = entries.length;

      // Compute document frequency (df) for each query token across all entries
      const df = new Map<string, number>();
      for (const t of promptTokens) {
        let count = 0;
        for (const e of entries) {
          if (tokenise(`${e.title} ${e.content} ${e.tags ?? ""}`).has(t)) count++;
        }
        df.set(t, count);
      }

      // Try to generate an embedding for the user prompt. If this fails (or any
      // single entry lacks an embedding), we transparently fall back to TF-IDF
      // for that entry — never the whole call.
      const SEMANTIC_WEIGHT = 6.0;
      const promptEmbedding = await generateEmbedding(userPrompt);

      const scored = entries.map((e) => {
        const entryText = `${e.title} ${e.content} ${e.tags ?? ""}`;
        const entryWords = entryText.toLowerCase().split(/\W+/).filter(Boolean);
        const termCounts = new Map<string, number>();
        for (const w of entryWords) {
          termCounts.set(w, (termCounts.get(w) ?? 0) + 1);
        }

        let score = 0;
        const entryEmbedding = e.embedding;
        if (
          promptEmbedding &&
          Array.isArray(entryEmbedding) &&
          entryEmbedding.length === promptEmbedding.length
        ) {
          // Primary path: semantic similarity (cosine ∈ [-1, 1], typically [0, 1]).
          score += cosineSimilarity(promptEmbedding, entryEmbedding) * SEMANTIC_WEIGHT;
        } else {
          // Fallback path: TF-IDF keyword overlap (per-entry, graceful).
          for (const t of promptTokens) {
            if (termCounts.has(t)) {
              const tf = (termCounts.get(t) ?? 0) / Math.max(entryWords.length, 1);
              const idf = Math.log((N + 1) / ((df.get(t) ?? 0) + 1)) + 1;
              score += tf * idf;
            }
          }
        }

        // Recency boost
        const ageMs = now - new Date(e.createdAt).getTime();
        if (ageMs < ONE_DAY_MS) score += 2.0;
        else if (ageMs < SEVEN_DAYS_MS) score += 1.0;

        // Severity boost
        score += SEVERITY_SCORE[e.severity] ?? 0;

        // Feedback-weighted boost: usage frequency + thumbs signal
        score += (e.usageCount ?? 0) * USAGE_WEIGHT;
        score += ((e.thumbsUp ?? 0) - (e.thumbsDown ?? 0)) * FEEDBACK_WEIGHT;

        // Same-project preference
        if (e.projectId === projectId) score += SAME_PROJECT_BOOST;

        // Approved-for-reuse multiplier (applied last so it amplifies the full base score)
        if (e.approvedForReuse) score *= APPROVED_BOOST;

        return { entry: e, score };
      });
      scored.sort((a, b) => b.score - a.score);
      // Take up to 12 candidates; budget trim happens below
      topEntries = scored.slice(0, 12).map((s) => s.entry);
    } else {
      // No prompt: rank by same-project first, then approvedForReuse, then recency
      topEntries = [...entries]
        .sort((a, b) => {
          const projectScore =
            (b.projectId === projectId ? 1 : 0) - (a.projectId === projectId ? 1 : 0);
          if (projectScore !== 0) return projectScore;
          const approvedScore = (b.approvedForReuse ? 1 : 0) - (a.approvedForReuse ? 1 : 0);
          if (approvedScore !== 0) return approvedScore;
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        })
        .slice(0, 12);
    }

    // ── Token budget enforcement (hard cap) ──────────────────────────────────
    // Entries are already sorted best-first; drop from the tail until we fit.
    // This is a strict cap — no minimum-entry override — so the context section
    // never exceeds KNOWLEDGE_CHAR_BUDGET regardless of how few entries that allows.
    const selected: typeof entries = [];
    let charCount = 0;
    for (const e of topEntries) {
      const entryChars = e.title.length + e.content.length + 20; // 20 for label + punctuation
      if (charCount + entryChars > KNOWLEDGE_CHAR_BUDGET) break;
      selected.push(e);
      charCount += entryChars;
    }

    if (selected.length === 0) {
      return { context: integrationsNote, applied: [] };
    }

    // ── Format the lessons section with clear delimiters ────────────────────
    const lessonLines = selected.map((e) => `[${e.category}] ${e.title}: ${e.content}`);
    const knowledgeSection = [
      `=== LESSONS FROM PRIOR BUILDS (${selected.length} selected, relevance-ranked) ===`,
      `Apply each actively. Do not repeat past mistakes. Do not mention this section in your output.`,
      ``,
      ...lessonLines,
      `=== END LESSONS ===`,
    ].join("\n");

    const context = [integrationsNote, knowledgeSection].filter(Boolean).join("\n\n");
    const applied = selected.map((e) => ({
      id: e.id,
      title: e.title,
      type: e.type,
      category: e.category,
    }));

    // Increment usageCount for all selected entries — best-effort, non-fatal.
    if (selected.length > 0) {
      const selectedIds = selected.map((e) => e.id);
      db.update(knowledgeEntriesTable)
        .set({ usageCount: sql`${knowledgeEntriesTable.usageCount} + 1` })
        .where(inArray(knowledgeEntriesTable.id, selectedIds))
        .catch((err: Error) => logger.warn({ err }, "Failed to increment knowledge usageCount"));
    }

    return { context, applied };
  } catch {
    return { context: "", applied: [] };
  }
}

/**
 * Look up the most recent plan-mode assistant message for this project and return
 * its plan JSON to store as a version annotation (planSnapshot).
 */
async function loadLatestPlanSnapshot(projectId: number): Promise<Record<string, unknown> | null> {
  try {
    const [row] = await db
      .select({ plan: chatMessagesTable.plan })
      .from(chatMessagesTable)
      .where(
        and(
          eq(chatMessagesTable.projectId, projectId),
          eq(chatMessagesTable.planMode, true),
          eq(chatMessagesTable.role, "assistant"),
        ),
      )
      .orderBy(desc(chatMessagesTable.createdAt))
      .limit(1);
    if (!row?.plan || typeof row.plan !== "object") return null;
    // Exclude error plans
    if ((row.plan as Record<string, unknown>).kind === "error") return null;
    return row.plan as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function generateFixSuggestions(userPrompt: string, errorMessage: string): Promise<string[]> {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-5-mini",
      max_completion_tokens: 600,
      messages: [
        {
          role: "system",
          content:
            'You help debug AI-generated web app builds. Given a user request and a build error, return a JSON object with a "suggestions" array of exactly 3 short, specific, actionable fixes the user can try. Each suggestion must be 1 sentence and start with an action verb. Output ONLY valid JSON: {"suggestions":["...","...","..."]}',
        },
        {
          role: "user",
          content: `User request: "${userPrompt}"\n\nBuild error: ${errorMessage}`,
        },
      ],
      response_format: { type: "json_object" },
    });
    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as { suggestions?: string[] };
    if (Array.isArray(parsed.suggestions) && parsed.suggestions.length > 0) {
      return parsed.suggestions.slice(0, 3);
    }
  } catch (err) {
    logger.warn({ err }, "Failed to generate fix suggestions");
  }
  return [
    "Simplify the request and try rebuilding with fewer features.",
    "Use Plan Mode first to outline the approach before building.",
    "Check that all required integrations and secrets are configured.",
  ];
}

async function autoWriteFailureLesson(
  userPrompt: string,
  errorMessage: string,
  projectId: number,
  userId?: string,
): Promise<void> {
  await writeKnowledge({
    title: `Build failed: "${userPrompt.slice(0, 60)}"`,
    category: "diagnostic",
    content: `Attempt failed with error: ${errorMessage.slice(0, 300)}. Review the fix suggestions and adjust the approach before retrying.`,
    type: "build",
    severity: "error",
    projectId,
    userId,
  });
}

/**
 * Checks whether warnings from the current build also appeared in recent prior builds.
 * If so, writes a "recurring warning" escalation entry to the Knowledge Vault so the AI
 * can proactively avoid the pattern in future builds.
 */
async function maybeEscalateWarnings(projectId: number, currentWarnings: string[]): Promise<void> {
  if (currentWarnings.length === 0) return;
  try {
    const prevTasks = await db
      .select({ report: agentTasksTable.report })
      .from(agentTasksTable)
      .where(and(eq(agentTasksTable.projectId, projectId), eq(agentTasksTable.status, "completed")))
      .orderBy(desc(agentTasksTable.createdAt))
      .limit(3);

    const prevWarnings = prevTasks.flatMap((t) => t.report?.warnings ?? []);
    const repeated = currentWarnings.filter((w) =>
      prevWarnings.some((pw) => pw.slice(0, 50) === w.slice(0, 50)),
    );

    if (repeated.length > 0) {
      await writeKnowledge({
        title: `Recurring warning: "${repeated[0]!.slice(0, 60)}"`,
        category: "lesson",
        content: `This warning has appeared across multiple builds for project ${projectId}: ${repeated.join("; ")}. Proactively address it in future builds.`,
        type: "refine",
        severity: "warning",
        projectId,
      });
      logger.info({ projectId, repeated }, "Escalated recurring warning to Knowledge Vault");
    }
  } catch (err) {
    logger.warn({ err }, "Failed to escalate repeated warnings");
  }
}

type PostBuildSuggestion = {
  title: string;
  description: string;
  category: "feature" | "fix" | "improvement" | "idea";
  prompt: string;
};

/**
 * Generate 3-5 contextual AI suggestions after a successful or failed build.
 * Uses gpt-5-mini (free background work — no credit deduction).
 * Persists results to project_suggestions so the frontend can poll for them.
 *
 * Called via setImmediate so it never blocks the visible pipeline completion.
 */
async function generatePostBuildSuggestions(
  projectId: number,
  taskId: number,
  projectName: string,
  projectKind: string,
  projectFormat: string,
  userPrompt: string,
  assistantSummary: string,
  filePaths: string[],
  activeIntegrations: string,
): Promise<void> {
  try {
    const isMobile = ["mobile-ios", "mobile-android", "mobile-cross"].includes(projectKind);
    const platformHint = isMobile
      ? "React Native / Expo mobile app"
      : projectFormat === "react-vite"
        ? "React + Vite web app (TypeScript + Tailwind CSS)"
        : "static web app (HTML/CSS/JS + Tailwind)";

    const systemPrompt = `You are a senior product/engineering advisor reviewing a just-completed AI-generated ${platformHint} build.
Based on the build context, generate 3-5 specific, actionable next-step suggestions the user could build or improve next.
Each suggestion must be concrete and directly relevant to this project — not generic advice.

Categories:
- feature: a new capability or page to add
- fix: a bug, UX issue, or missing piece to address  
- improvement: make existing functionality better, faster, or more polished
- idea: an experimental or innovative enhancement

OUTPUT STRICT JSON:
{
  "suggestions": [
    { "title": "...", "description": "...", "category": "feature|fix|improvement|idea", "prompt": "..." }
  ]
}

Rules:
- title: 3-6 words max, action-oriented
- description: one sentence (max 15 words) explaining the value
- prompt: exact text to feed the refine pipeline — specific and self-contained (30-80 words)
- Mix categories — don't return all features
- Vary difficulty — include at least one quick win and one more ambitious idea
- If active integrations exist, suggest at least one integration-specific improvement`;

    const userContent = `Project: "${projectName}" (${platformHint})
Last build request: "${userPrompt.slice(0, 200)}"
Build summary: "${assistantSummary.slice(0, 300)}"
Files in project: ${filePaths.slice(0, 20).join(", ")}
${activeIntegrations ? `Active integrations: ${activeIntegrations}` : ""}`;

    const response = await openai.chat.completions.create({
      model: "gpt-5-mini",
      max_completion_tokens: 1200,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      response_format: { type: "json_object" },
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as { suggestions?: PostBuildSuggestion[] };

    if (!Array.isArray(parsed.suggestions) || parsed.suggestions.length === 0) {
      logger.warn({ taskId, projectId }, "Post-build suggestion generation returned empty array");
      return;
    }

    const validCategories = new Set(["feature", "fix", "improvement", "idea"]);
    const valid = parsed.suggestions
      .filter(
        (s) =>
          typeof s.title === "string" &&
          typeof s.description === "string" &&
          typeof s.category === "string" &&
          typeof s.prompt === "string" &&
          validCategories.has(s.category),
      )
      .slice(0, 5);

    if (valid.length === 0) return;

    await db.insert(projectSuggestionsTable).values(
      valid.map((s) => ({
        projectId,
        taskId,
        title: s.title.slice(0, 120),
        description: s.description.slice(0, 300),
        category: s.category,
        prompt: s.prompt.slice(0, 1000),
        status: "pending" as const,
      })),
    );

    logger.info({ taskId, projectId, count: valid.length }, "Post-build suggestions generated");
  } catch (err) {
    logger.warn({ err, taskId, projectId }, "Post-build suggestion generation failed (non-fatal)");
  }
}

async function drainNextBatchTask(completedTaskId: number): Promise<void> {
  const [completedTask] = await db
    .select()
    .from(agentTasksTable)
    .where(eq(agentTasksTable.id, completedTaskId));
  if (!completedTask?.queueBatchId) return;

  // Staging gate: if any task in this batch is awaiting review, block the queue
  const [batchBlocked] = await db
    .select({ id: agentTasksTable.id })
    .from(agentTasksTable)
    .where(
      and(
        eq(agentTasksTable.queueBatchId, completedTask.queueBatchId),
        inArray(agentTasksTable.status, ["needs_review", "needs_fix"]),
      ),
    )
    .limit(1);
  if (batchBlocked) {
    logger.info(
      { completedTaskId, blockedByTaskId: batchBlocked.id, batchId: completedTask.queueBatchId },
      "drainNextBatchTask: blocked - staged output awaiting review/fix",
    );
    return;
  }

  const [nextTask] = await db
    .select()
    .from(agentTasksTable)
    .where(
      and(
        eq(agentTasksTable.queueBatchId, completedTask.queueBatchId),
        eq(agentTasksTable.status, "queued"),
      ),
    )
    .orderBy(asc(agentTasksTable.queueIndex))
    .limit(1);

  if (!nextTask) return;

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, completedTask.projectId));
  if (!project) return;

  const recentMessages = await db
    .select({ role: chatMessagesTable.role, content: chatMessagesTable.content })
    .from(chatMessagesTable)
    .where(eq(chatMessagesTable.projectId, completedTask.projectId))
    .orderBy(asc(chatMessagesTable.createdAt));

  const conversationHistory: ConversationTurn[] = recentMessages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))
    .slice(-8);

  const batchTasks = await db
    .select({ id: agentTasksTable.id })
    .from(agentTasksTable)
    .where(eq(agentTasksTable.queueBatchId, completedTask.queueBatchId));

  const drainedImageAttachments = await hydrateTaskAttachments(nextTask.attachments);

  enqueueJob({
    taskId: nextTask.id,
    projectId: completedTask.projectId,
    kind: "refine",
    userPrompt: nextTask.prompt ?? "",
    // Use the mode frozen at enqueue time; fall back to the project-level setting for
    // legacy rows that predate the taskAgentMode column (Task #item-4).
    agentMode:
      (nextTask.taskAgentMode as AgentMode | null | undefined) ??
      (project.agentMode as AgentMode) ??
      "power",
    // Preserve the agentIdentity and execution context that were set when this
    // batch task was originally enqueued (Task #item-1).
    agentIdentity: (nextTask.agentIdentity as AgentIdentity | undefined) ?? undefined,
    origin: nextTask.origin ?? null,
    conversationHistory,
    imageAttachments: drainedImageAttachments,
    queueBatchId: completedTask.queueBatchId,
    queueIndex: nextTask.queueIndex ?? undefined,
    queueTotalCount: batchTasks.length,
    runMode: (nextTask.runMode as "foreground" | "background" | undefined) ?? undefined,
    wallClockCapMs: nextTask.wallClockCapMs ?? undefined,
  });
}

/**
 * Load object-storage URLs persisted on agent_tasks.attachments and resolve them
 * into data URIs the builder pipelines can hand to the vision model. Returns
 * undefined when the task had no attachments (so the JobInput shape stays clean).
 */
async function hydrateTaskAttachments(
  raw: unknown,
): Promise<Array<{ dataUri: string; alt?: string }> | undefined> {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const hydrated: Array<{ dataUri: string; alt?: string }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const url = (entry as { url?: unknown }).url;
    if (typeof url !== "string" || url.length === 0) continue;
    const alt = (entry as { alt?: unknown }).alt;
    const dataUri = await fetchAttachmentAsDataUri(url);
    if (dataUri) hydrated.push({ dataUri, alt: typeof alt === "string" ? alt : undefined });
  }
  return hydrated.length > 0 ? hydrated : undefined;
}

/**
 * After a job completes, drain the next orphaned queued task for the project that has
 * no queueBatchId (i.e. tasks created by the per-project conflict detection in
 * routes/messages.ts and routes/tasks.ts). These never belong to a batch, so
 * drainNextBatchTask won't find them.
 */
export async function drainNextProjectTask(
  projectId: number,
  preferTaskId?: number,
): Promise<void> {
  // Staging gate: if any task for this project is awaiting review, block the queue
  const [blocked] = await db
    .select({ id: agentTasksTable.id })
    .from(agentTasksTable)
    .where(
      and(
        eq(agentTasksTable.projectId, projectId),
        inArray(agentTasksTable.status, ["needs_review", "needs_fix"]),
      ),
    )
    .limit(1);
  if (blocked) {
    logger.info(
      { projectId, blockedByTaskId: blocked.id },
      "drainNextProjectTask: blocked - staged output awaiting review/fix",
    );
    return;
  }

  // If a specific task was requested (e.g. force-start), try it first; fall back
  // to the oldest queued task only if the preferred one isn't actually queued.
  let nextTask: typeof agentTasksTable.$inferSelect | undefined;
  if (preferTaskId !== undefined) {
    const [preferred] = await db
      .select()
      .from(agentTasksTable)
      .where(
        and(
          eq(agentTasksTable.id, preferTaskId),
          eq(agentTasksTable.projectId, projectId),
          eq(agentTasksTable.status, "queued"),
        ),
      )
      .limit(1);
    nextTask = preferred;
  }
  if (!nextTask) {
    const [oldest] = await db
      .select()
      .from(agentTasksTable)
      .where(
        and(
          eq(agentTasksTable.projectId, projectId),
          eq(agentTasksTable.status, "queued"),
          isNull(agentTasksTable.queueBatchId),
        ),
      )
      .orderBy(asc(agentTasksTable.createdAt))
      .limit(1);
    nextTask = oldest;
  }

  if (!nextTask) return;

  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
  if (!project) return;

  const [fileRow] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(sql`(select 1 from project_files where project_id = ${projectId} limit 1) as f`);
  const hasFiles = (fileRow?.c ?? 0) > 0;

  const drainedImageAttachments = await hydrateTaskAttachments(nextTask.attachments);

  // Forward persisted execution context so the drained task runs identically
  // to its original enqueue (Task #509): runMode, wallClockCapMs, agentIdentity.
  enqueueJob({
    taskId: nextTask.id,
    projectId,
    kind: hasFiles ? "refine" : "build",
    userPrompt: nextTask.prompt ?? "",
    agentMode:
      (nextTask.taskAgentMode as AgentMode | null | undefined) ??
      (project.agentMode as AgentMode) ??
      "power",
    agentIdentity: (nextTask.agentIdentity as AgentIdentity | undefined) ?? undefined,
    origin: nextTask.origin ?? null,
    imageAttachments: drainedImageAttachments,
    runMode: (nextTask.runMode as "foreground" | "background" | undefined) ?? undefined,
    wallClockCapMs: nextTask.wallClockCapMs ?? undefined,
  });
  logger.info(
    {
      projectId,
      nextTaskId: nextTask.id,
      runMode: nextTask.runMode,
      agentIdentity: nextTask.agentIdentity,
    },
    "Drained next project-level queued task",
  );
}

/**
 * Task #638 — Pause the rest of a user's queued AI tasks when credits run out.
 *
 * Called from the credit pre-flight failure path so that an entire queue of
 * builds doesn't drain one-by-one with the same insufficient-credits error.
 * Transitions every still-queued task for this project (and, if the failed
 * task belongs to a batch, every still-queued task in that batch — even if it
 * lives in a different project) into the "paused-insufficient-credits" status
 * with pausedAt = now(). Resume via `resumeProjectPausedTasks`.
 */
async function pauseRemainingQueuedTasks(failedTaskId: number, projectId: number): Promise<void> {
  try {
    const [failedTask] = await db
      .select({ queueBatchId: agentTasksTable.queueBatchId })
      .from(agentTasksTable)
      .where(eq(agentTasksTable.id, failedTaskId))
      .limit(1);

    const conds = [
      eq(agentTasksTable.status, "queued"),
      failedTask?.queueBatchId
        ? or(
            eq(agentTasksTable.projectId, projectId),
            eq(agentTasksTable.queueBatchId, failedTask.queueBatchId),
          )
        : eq(agentTasksTable.projectId, projectId),
    ];

    const paused = await db
      .update(agentTasksTable)
      .set({ status: "paused-insufficient-credits", pausedAt: sql`now()` })
      .where(and(...conds))
      .returning({ id: agentTasksTable.id });

    if (paused.length > 0) {
      logger.info(
        { failedTaskId, projectId, pausedCount: paused.length },
        "Paused remaining queued tasks — insufficient credits",
      );
    }
  } catch (err) {
    logger.warn({ err, failedTaskId, projectId }, "Failed to pause remaining queued tasks");
  }
}

/**
 * Task #638 — Resume paused-insufficient-credits tasks after a top-up.
 *
 * Transitions every paused task in this project back to "queued", clears
 * `pausedAt`, then kicks off the drain helpers so the queue starts running
 * again. Scoped to a single project so the drawer's resume CTA is local.
 */
export async function resumeProjectPausedTasks(projectId: number): Promise<number> {
  const resumed = await db
    .update(agentTasksTable)
    .set({ status: "queued", pausedAt: null })
    .where(
      and(
        eq(agentTasksTable.projectId, projectId),
        eq(agentTasksTable.status, "paused-insufficient-credits"),
      ),
    )
    .returning({
      id: agentTasksTable.id,
      queueBatchId: agentTasksTable.queueBatchId,
    });

  if (resumed.length === 0) return 0;

  const batchIds = new Set<string>();
  for (const r of resumed) {
    if (r.queueBatchId) batchIds.add(r.queueBatchId);
  }

  // Pick a "head" task per batch to kick off the drain (it walks queueIndex).
  for (const batchId of batchIds) {
    const [head] = await db
      .select({ id: agentTasksTable.id })
      .from(agentTasksTable)
      .where(
        and(
          eq(agentTasksTable.queueBatchId, batchId),
          inArray(agentTasksTable.status, ["completed", "failed", "canceled"]),
        ),
      )
      .orderBy(desc(agentTasksTable.queueIndex))
      .limit(1);
    if (head) {
      void drainNextBatchTask(head.id).catch((err) =>
        logger.warn({ err, batchId }, "drainNextBatchTask after resume failed"),
      );
    }
  }

  void drainNextProjectTask(projectId).catch((err) =>
    logger.warn({ err, projectId }, "drainNextProjectTask after resume failed"),
  );

  logger.info({ projectId, resumedCount: resumed.length }, "Resumed paused tasks after top-up");
  return resumed.length;
}

async function cancelRemainingBatchTasks(failedTaskId: number): Promise<void> {
  const [failedTask] = await db
    .select({ queueBatchId: agentTasksTable.queueBatchId, projectId: agentTasksTable.projectId })
    .from(agentTasksTable)
    .where(eq(agentTasksTable.id, failedTaskId));
  if (!failedTask?.queueBatchId) return;

  try {
    await db
      .update(agentTasksTable)
      .set({ status: "canceled", completedAt: sql`now()` })
      .where(
        and(
          eq(agentTasksTable.queueBatchId, failedTask.queueBatchId),
          eq(agentTasksTable.status, "queued"),
        ),
      );
    logger.info(
      { queueBatchId: failedTask.queueBatchId },
      "Cancelled remaining batch tasks after failure",
    );
  } catch (err) {
    logger.warn({ err }, "Failed to cancel remaining batch tasks");
  }
}

export async function runJob(input: JobInput): Promise<void> {
  const {
    taskId,
    projectId,
    kind,
    conversationHistory,
    imageAttachments,
    queueBatchId,
    queueIndex,
    queueTotalCount,
  } = input;
  let { userPrompt, agentMode } = input;
  const agentIdentity: AgentIdentity = input.agentIdentity ?? "main";
  const jobOrigin =
    typeof input.origin === "string" && input.origin.length > 0 ? input.origin : null;
  // Task #665 — image layout analysis. When the user drops in screenshots,
  // we run a vision pass once and prepend a structured layout brief to the
  // prompt so every downstream pipeline (including JSON-mode builders that
  // can't natively consume image_url blocks) has something concrete to work
  // with. Best-effort: failures fall back to the existing multimodal path.
  // eslint-disable-next-line no-useless-assignment
  let imageLayoutBrief: string | null = null;

  const jobStartTime = Date.now();
  let wasEscalated = false;
  let analyticsErrorCategory: string | null = null;
  let analyticsCorrectionPasses = 0;
  // Persisted validation status for the version snapshot written by this job.
  // "passed"               = all checks clean.
  // "passed_with_warnings" = required checks passed; at least one non-required check failed.
  //                          Preview is available but the build is not fully clean.
  // "failed"               = legacy hard-gate failure (no container for repair).
  // "completed_with_errors"= repair loop exhausted after required check failures.
  let versionValidationStatus:
    | "passed"
    | "passed_with_warnings"
    | "failed"
    | "completed_with_errors" = "passed";
  let validationWasPartial = false;
  // Collects ALL check results (required + non-required) from the agent loop.
  // Populated in the build/refine paths regardless of correctionFailed status.
  // Used after the repair loop to detect non-required failures → passed_with_warnings.
  let _allAgentCheckResults: Array<{
    id: string;
    label: string;
    passed: boolean;
    message?: string;
  }> = [];
  // Populated by the correctionFailed handlers in the build/refine paths when the
  // agentic loop terminates with check failures. The repair loop (below, after the
  // build/refine blocks) drains this to attempt targeted TypeScript fixes before
  // falling back to "completed_with_errors".
  let _pendingRepairChecks: Array<{ label: string; output: string }> = [];
  let _pendingRepairChangedPaths: string[] = [];
  // Keepalive handle — cleared in the outer finally block.
  let stopContainerKeepalive: (() => void) | null = null;
  // Machine ID whose autostop was patched to "off" — restored in the outer finally.
  let keepaliveMachineId: string | null = null;
  // Job-level heartbeat timer — runs every 30 s for the entire job duration.
  // The per-step heartbeat (step%5===1 in agent-loop.ts) only fires when AI tool
  // steps complete. Long-blocking operations — AI calls, npm install, container
  // execs — can exceed the 8-min stuck-run window without ever advancing a step.
  // This timer ensures the scheduler never kills an actively running job.
  // Cleared in the finally block below.
  let jobHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // Sanitise prompt before injecting into AI context — strip injection patterns
  const { cleaned: sanitisedPrompt, wasModified: promptWasModified } = sanitisePrompt(userPrompt);
  if (promptWasModified) {
    logger.warn(
      { taskId, projectId },
      "Prompt injection patterns detected and stripped from user prompt",
    );
    userPrompt = sanitisedPrompt;
  }

  // Per-project in-memory lock — fast in-process guard to prevent duplicate enqueue.
  activeProjectJobs.add(projectId);

  // Create a per-task AbortController so the cancel endpoint can kill in-flight AI calls.
  const abortController = new AbortController();
  const { signal } = abortController;
  activeJobControllers.set(taskId, abortController);

  // Acquire a Postgres session-level advisory lock keyed by projectId.
  // pg_advisory_lock blocks until the lock is free, serializing same-project jobs
  // across all Node processes / replicas. Released in the finally block.
  const lockClient = await pool.connect();
  let lockAcquired = false;

  try {
    await lockClient.query("SELECT pg_advisory_lock($1::bigint)", [projectId]);
    lockAcquired = true;

    await emitEvent(taskId, "queued", "Task received, starting pipeline…");

    // Atomically transition queued/planning → building.
    // Tasks are created with status "queued" (background) or "planning" (immediate foreground).
    // Using WHERE status IN ('queued','planning') makes the check+update a single round-trip,
    // eliminating the TOCTOU window. If the user dismissed (canceled) the task while we were
    // waiting for the advisory lock, status = 'canceled' so 0 rows are updated → abort cleanly.
    // Both build and refine tasks transition to "building" so the frontend never shows a refine
    // task stuck on "planning" while the pipeline is actively running.
    const transitioned = await db
      .update(agentTasksTable)
      .set({ status: "building", startedAt: sql`now()` })
      .where(
        and(
          eq(agentTasksTable.id, taskId),
          inArray(agentTasksTable.status, ["queued", "planning"]),
        ),
      )
      .returning({ id: agentTasksTable.id });
    if (transitioned.length === 0) {
      logger.info({ taskId, projectId }, "Task was canceled before pipeline started — skipping");
      return;
    }

    // Start the job-level heartbeat now that we're committed to running.
    // Fire immediately (in case the pre-build setup is slow) and every 30 s.
    const writeJobHeartbeat = () => {
      void (async () => {
        try {
          await db
            .update(agentTasksTable)
            .set({ lastHeartbeatAt: new Date() })
            .where(eq(agentTasksTable.id, taskId));
        } catch {
          // Non-fatal — a missed heartbeat only risks a stuck-run false-positive
        }
      })();
    };
    writeJobHeartbeat(); // immediate write — replaces the one-shot in ensureContainerAwake
    jobHeartbeatTimer = setInterval(writeJobHeartbeat, 30_000);

    // Persist agentIdentity to the task record so queries and the frontend can read it
    if (agentIdentity !== "main") {
      await db.update(agentTasksTable).set({ agentIdentity }).where(eq(agentTasksTable.id, taskId));
    }

    const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
    if (!project) {
      await emitEvent(taskId, "failed", "Project not found.");
      await db
        .update(agentTasksTable)
        .set({
          status: "failed",
          result: "Project not found",
          completedAt: sql`now()`,
          tokenCount: flushTokenCount(taskId),
        })
        .where(eq(agentTasksTable.id, taskId));
      return;
    }
    const containerLayerOperational = await isContainerLayerConfigured();
    const projectHasLiveServer = (): boolean =>
      containerLayerOperational && Boolean(project.containerId);

    const [
      { context: rawKnowledgeContext, applied: knowledgeApplied },
      conversationSummary,
      blueprintContext,
    ] = await Promise.all([
      loadKnowledgeContext(projectId, userPrompt),
      (async () => {
        try {
          const [row] = await db
            .select({ content: knowledgeEntriesTable.content })
            .from(knowledgeEntriesTable)
            .where(
              and(
                eq(knowledgeEntriesTable.projectId, projectId),
                eq(knowledgeEntriesTable.type, "conversation_summary"),
                // ISOLATION: never read an Ora-origin row into a Builder prompt.
                or(isNull(knowledgeEntriesTable.origin), ne(knowledgeEntriesTable.origin, "ora")),
              ),
            )
            .orderBy(desc(knowledgeEntriesTable.createdAt))
            .limit(1);
          return row?.content ?? undefined;
        } catch {
          return undefined;
        }
      })(),
      getInstalledBlueprintKnowledge(projectId),
    ]);

    // ── Domain context — inject primary domain so the builder uses real absolute URLs ──
    let domainContextStr: string | undefined;
    try {
      const [primaryDomain] = await db
        .select({ hostname: projectDomainsTable.hostname })
        .from(projectDomainsTable)
        .where(
          and(
            eq(projectDomainsTable.projectId, projectId),
            eq(projectDomainsTable.isPrimary, true),
          ),
        )
        .limit(1);

      const platformDomain = process.env.PLATFORM_DOMAIN ?? "mustaflow.app";
      const platformSubdomain = project.publicSlug
        ? `${project.publicSlug}.${platformDomain}`
        : null;

      const primaryUrl = primaryDomain
        ? `https://${primaryDomain.hostname}`
        : platformSubdomain
          ? `https://${platformSubdomain}`
          : null;

      if (primaryUrl) {
        const domainType = primaryDomain ? "custom domain" : "platform subdomain";
        domainContextStr = `DOMAIN CONTEXT — This project's public URL is: ${primaryUrl} (${domainType}).
When generating code that requires absolute URLs (canonical <link> tags, <meta property="og:url">, <meta property="og:image">, sitemap.xml <loc> entries, robots.txt Sitemap line, Stripe success_url/cancel_url, OAuth redirect_uri, webhook endpoints), always use: ${primaryUrl}
Do NOT use window.location.origin, localhost, or placeholder domains in these contexts — use the primary URL above.`;
      }
    } catch {
      // Non-fatal — domain context is best-effort
    }

    // Prepend installed-blueprint context unconditionally (before the token-budgeted
    // relevance-ranked lessons block). This ensures the builder always knows which
    // integrations are already scaffolded, even when the user's prompt doesn't
    // mention the integration by name.
    const mergedKnowledgeContext = blueprintContext
      ? rawKnowledgeContext
        ? `${blueprintContext}\n\n${rawKnowledgeContext}`
        : blueprintContext
      : rawKnowledgeContext;

    // Merge vault knowledge + domain context into a single context string
    const knowledgeContext =
      mergedKnowledgeContext && domainContextStr
        ? `${mergedKnowledgeContext}\n\n${domainContextStr}`
        : mergedKnowledgeContext
          ? mergedKnowledgeContext
          : (domainContextStr ?? undefined);

    // Build database context when the project has a provisioned DB
    let databaseContext: string | undefined;
    if (project.dbProvider && project.dbProvider !== "none" && project.dbStatus === "connected") {
      const dbSecretRow = await db
        .select({ name: secretsTable.name })
        .from(secretsTable)
        .where(and(eq(secretsTable.projectId, projectId), eq(secretsTable.name, "DATABASE_URL")))
        .limit(1);
      if (dbSecretRow.length > 0) {
        const providerLabel =
          project.dbProvider === "postgres" ? "PostgreSQL (Neon serverless)" : "SQLite";
        databaseContext = `DATABASE CONTEXT — This project has a provisioned ${providerLabel} database. The DATABASE_URL secret is set and contains the connection string.
When generating or modifying code for this project, you MUST:
1. Use real database queries instead of hardcoded/mock data.
2. Generate a Drizzle ORM schema file at "src/db/schema.ts" (or "drizzle/schema.ts") defining the tables your app needs.
3. Generate a Drizzle config file at "drizzle.config.ts" using process.env.DATABASE_URL as the connection string.
4. Generate migration SQL files in "drizzle/migrations/" for schema changes.
5. For server-side routes (Express/Node), use the pg package (Postgres) or better-sqlite3 (SQLite) connected via process.env.DATABASE_URL.
6. Return real database records from API routes — never placeholder arrays.
7. Add proper error handling for database connection failures.
Stack: Drizzle ORM preferred; raw SQL via parameterized queries is acceptable. Never interpolate user input into SQL. Wrap mutations in transactions where appropriate.`;
      }
    }

    // --- Subscription tier gate: enforce model access per tier ---
    // Free → lite/eco only. Pro/Team → all modes (power/pro unlocked).
    // Gated by CREDITS_ENFORCEMENT_ENABLED so we can run free/unlimited in dev
    // and degrade gracefully when the user_subscriptions table is missing.
    if (
      CREDITS_ENFORCEMENT_ENABLED &&
      project.ownerId &&
      (agentMode === "power" || agentMode === "pro")
    ) {
      try {
        const [sub] = await db
          .select({ tier: userSubscriptionsTable.tier })
          .from(userSubscriptionsTable)
          .where(eq(userSubscriptionsTable.userId, project.ownerId))
          .limit(1);
        const tier = sub?.tier ?? "free";
        if (tier === "free") {
          const msg = `The ${agentMode === "pro" ? "Pro" : "Power"} mode is available on the Pro and Team plans. Upgrade your subscription in Billing to use this mode, or switch to Lite or Eco.`;
          await emitEvent(taskId, "failed", msg);
          await db
            .update(agentTasksTable)
            .set({
              status: "failed",
              result: msg,
              completedAt: sql`now()`,
              tokenCount: flushTokenCount(taskId),
            })
            .where(eq(agentTasksTable.id, taskId));
          return;
        }
      } catch (err) {
        // Table missing or query failed → fail-open: don't block the build.
        logger.warn({ err }, "Subscription tier gate skipped (query failed)");
      }
    }

    // --- Credit pre-flight: fail fast if user cannot afford this AI call ---
    // For background jobs (Task #509) the credits were already reserved at enqueue,
    // so the pre-flight check + post-success deduction is skipped here.
    // Provider-aware cost — Anthropic premium tiers cost ~1.6× more, Gemini ~0.7×.
    const { creditCostFor, resolveStageProvider } = await import("./ai-providers");
    const buildStageForCost = input.kind === "refine" ? "refine" : "build";
    const { provider: costProvider } = resolveStageProvider(buildStageForCost, agentMode);
    const creditCost = creditCostFor(agentMode, costProvider);
    const creditsAlreadyReserved =
      input.runMode === "background" ||
      (await db
        .select({ reserved: agentTasksTable.creditsReserved })
        .from(agentTasksTable)
        .where(eq(agentTasksTable.id, taskId))
        .limit(1)
        .then((r) => (r[0]?.reserved ?? null) !== null));
    if (
      CREDITS_ENFORCEMENT_ENABLED &&
      project.ownerId &&
      !creditsAlreadyReserved &&
      !(await isSuperuser(project.ownerId))
    ) {
      const credits = await getOrCreateCredits(project.ownerId);
      if (credits.balance < creditCost) {
        const msg = `Insufficient credits. This ${agentMode} build costs ${creditCost} credit(s) but your balance is ${credits.balance}. Top up in Billing to continue.`;
        await emitEvent(taskId, "failed", msg);
        await db
          .update(agentTasksTable)
          .set({
            status: "failed",
            result: msg,
            completedAt: sql`now()`,
            tokenCount: flushTokenCount(taskId),
          })
          .where(eq(agentTasksTable.id, taskId));
        // Task #638 — pause any remaining queued siblings so they don't drain
        // and fail one-by-one with the same insufficient-credits error.
        await pauseRemainingQueuedTasks(taskId, projectId);
        return;
      }
    }

    // Task #665 — run image layout analysis once up front so every pipeline
    // branch (build / refine, legacy / agentic, mobile / web) inherits the
    // structured brief without re-paying the vision call.
    if (imageAttachments && imageAttachments.length > 0) {
      try {
        await emitEvent(
          taskId,
          "narration",
          `Analyzing ${imageAttachments.length === 1 ? "your screenshot" : `your ${imageAttachments.length} screenshots`}…`,
        );
        const { analyzeImagesToLayout } = await import("./builder");
        imageLayoutBrief = await analyzeImagesToLayout(imageAttachments, signal);
        if (imageLayoutBrief) {
          await emitEvent(taskId, "narration", "Image analysis complete — using it as a brief.");
          // Inject the brief into the prompt so even JSON-mode builders that
          // can't natively consume image_url blocks ground their output in
          // what the user actually attached. The image_url blocks are still
          // passed through too (multimodal models will see both).
          userPrompt = `${userPrompt}\n\n[ATTACHED IMAGE ANALYSIS — derived from the user's uploaded screenshot(s); treat as ground truth about the desired layout]\n${imageLayoutBrief}`;
        }
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), taskId },
          "Image analysis step failed — continuing with multimodal-only path",
        );
      }
    }

    try {
      let report: TaskReport;
      let assistantSummary: string;
      let nextVersionLabel: string;
      let diffSummary: DiffSummary | undefined;
      let filesToSmellScan: BuilderFile[] = [];
      // Legacy staged-review path: collect files before writing to project_files.
      let stagingData: Array<{ path: string; content: string; mimeType: string }> = [];
      // Staged-review refine: keep existing files for building the full merged snapshot.
      let existingFilesSnapshot: BuilderFile[] = [];
      let _refineChangedFiles: BuilderFile[] = [];
      let _refineRemovedPaths: string[] = [];

      const isMobileProject = ["mobile-ios", "mobile-android", "mobile-cross"].includes(
        project.kind,
      );
      let resolvedProjectStack = project.stack ?? "static-html";
      let resolvedProjectFormat = project.projectFormat ?? null;

      // Developer Mode projects always run as real server processes inside a Linux
      // container — raw static-html is never the right stack. Upgrade the fallback
      // so the agent generates a real server app (minimum: node-api / Express).
      if (project.projectMode === "developer" && resolvedProjectStack === "static-html") {
        resolvedProjectStack = "node-api";
        resolvedProjectFormat = "static-html";
      }

      // ── Auto-detect required stack on the very first build ──────────────────
      // The project is created before the user writes their first real request,
      // so the stack is not locked at creation time. Right before the first
      // build we classify the prompt and pick the correct architecture — the
      // user never has to choose. Priority: mobile > full-stack > react > static.
      let resolvedIsMobile = isMobileProject;
      if (
        shouldAutoDetectStack({
          jobKind: kind,
          isMobileProject,
          stackLocked: project.stackLocked,
        })
      ) {
        try {
          await emitEvent(
            taskId,
            "narration",
            "Reading your request to choose the right architecture…",
          );
          const isDevMode = project.projectMode === "developer";
          const detectedStack = await detectRequiredStack(userPrompt, isDevMode);
          const stackChanged = detectedStack !== resolvedProjectStack;
          const becomesMobile = detectedStack === "mobile-cross";
          const detectedProjectStack = becomesMobile ? "react-vite" : detectedStack;
          const detectedProjectFormat =
            detectedStack === "react-vite" ? "react-vite" : "static-html";
          const previousProjectStack = resolvedProjectStack;
          const previousProjectFormat = resolvedProjectFormat;

          if (stackChanged || becomesMobile) {
            logger.info(
              { taskId, projectId, from: resolvedProjectStack, to: detectedStack },
              "Auto-selecting project stack based on request",
            );

            // #757 — emit a clear summary of what was chosen and why.
            const architectureSummaries: Record<string, string> = {
              "mobile-cross":
                "Building a native mobile app for iOS and Android using Expo and React Native.",
              "node-api":
                "Building a full-stack app with a Node.js server, REST API, and PostgreSQL database.",
              "react-vite": "Building an interactive React single-page app.",
              "static-html":
                "Building a fast, lightweight static page with HTML, CSS, and JavaScript.",
              "python-flask": "Building a Python Flask web app with REST endpoints.",
              "python-fastapi":
                "Building a Python FastAPI service with async handlers and Pydantic schemas.",
              "go-gin":
                "Building a Go + Gin REST API with idiomatic Go handlers and typed structs.",
              slides: "Building an interactive slide deck powered by Reveal.js.",
              animation: "Building an animated web experience using React and Framer Motion.",
              automation: "Building a Node.js automation script with scheduling and logging.",
            };
            const archMessage =
              architectureSummaries[detectedStack] ?? `Architecture selected: ${detectedStack}.`;
            await emitEvent(taskId, "architecture_chosen", archMessage);
            // #757 — write a permanent chat message so the user always sees what was chosen.
            await db.insert(chatMessagesTable).values({
              projectId,
              role: "assistant",
              content: archMessage,
              agentMode,
              planMode: false,
              origin: jobOrigin,
              plan: {
                kind: "architecture_chosen",
                stack: detectedStack,
              } as unknown as Record<string, unknown>,
            });

            if (becomesMobile) {
              // Upgrade project kind + platform so the mobile pipeline runs.
              await db
                .update(projectsTable)
                .set({
                  kind: "mobile-cross",
                  platform: "cross",
                  stack: "react-vite",
                  projectFormat: "static-html",
                })
                .where(eq(projectsTable.id, projectId));
              resolvedProjectStack = "react-vite";
              resolvedProjectFormat = "static-html";
              resolvedIsMobile = true;
            } else if (
              detectedStack === "slides" ||
              detectedStack === "animation" ||
              detectedStack === "automation"
            ) {
              // Upgrade project kind so the dedicated pipeline runs.
              await db
                .update(projectsTable)
                .set({ kind: detectedStack, stack: detectedStack, projectFormat: "static-html" })
                .where(eq(projectsTable.id, projectId));
              resolvedProjectStack = detectedStack;
              resolvedProjectFormat = "static-html";
              // Update primary artifact kind so the frontend tab switches automatically.
              const { projectArtifactsTable } = await import("@workspace/db");
              await db
                .update(projectArtifactsTable)
                .set({ kind: detectedStack })
                .where(
                  and(
                    eq(projectArtifactsTable.projectId, projectId),
                    eq(projectArtifactsTable.isPrimary, true),
                    isNull(projectArtifactsTable.deletedAt),
                  ),
                );
            } else {
              await db
                .update(projectsTable)
                .set({ stack: detectedStack, projectFormat: detectedProjectFormat })
                .where(eq(projectsTable.id, projectId));
              resolvedProjectStack = detectedStack;
              resolvedProjectFormat = detectedProjectFormat;
            }

            await emitEvent(
              taskId,
              "architecture_changed",
              architectureChangeMessage({
                previousStack: previousProjectStack,
                previousFormat: previousProjectFormat,
                nextStack: detectedProjectStack,
                nextFormat: detectedProjectFormat,
              }),
              undefined,
              {
                source: "auto-detection",
                previousStack: previousProjectStack,
                previousFormat: previousProjectFormat,
                nextStack: detectedProjectStack,
                nextFormat: detectedProjectFormat,
              },
            );

            // Reload project row so downstream code has fresh containerId etc.
            const [refreshed] = await db
              .select()
              .from(projectsTable)
              .where(eq(projectsTable.id, projectId));
            if (refreshed) Object.assign(project, refreshed);

            // Full-stack upgrade: kick off container + DB provisioning in background.
            if (detectedStack === "node-api" && !project.containerId && containerLayerOperational) {
              const { enqueueProvisionProjectJob } = await import("./provisioning");
              enqueueProvisionProjectJob(projectId);
              logger.info({ taskId, projectId }, "Provisioning job enqueued for stack upgrade");
              // #758 — wait up to 90 s for the Fly container to become available
              // before handing off to the agent loop (which needs a live containerId).
              await emitEvent(taskId, "narration", "Setting up your server environment…");
              const containerDeadline = Date.now() + 90_000;
              while (Date.now() < containerDeadline) {
                const [waitRow] = await db
                  .select({
                    containerId: projectsTable.containerId,
                    provisioningStatus: projectsTable.provisioningStatus,
                  })
                  .from(projectsTable)
                  .where(eq(projectsTable.id, projectId));
                if (waitRow?.containerId || waitRow?.provisioningStatus === "ready") break;
                await new Promise<void>((r) => setTimeout(r, 5_000));
              }
              // Reload so the agent loop gets the fresh containerId.
              const [containerReady] = await db
                .select()
                .from(projectsTable)
                .where(eq(projectsTable.id, projectId));
              if (containerReady) Object.assign(project, containerReady);
            }
          }
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err), taskId },
            "Stack auto-detection failed — continuing with existing stack",
          );
        }
      }

      const isSlidesProject = !resolvedIsMobile && resolvedProjectStack === "slides";
      const isAnimationProject = !resolvedIsMobile && resolvedProjectStack === "animation";
      const isAutomationProject = !resolvedIsMobile && resolvedProjectStack === "automation";
      const isSpecializedStaticProject =
        isSlidesProject || isAnimationProject || isAutomationProject;
      const isReactViteProject =
        !resolvedIsMobile && !isSpecializedStaticProject && resolvedProjectFormat === "react-vite";
      const isNextjsProject =
        !resolvedIsMobile && !isSpecializedStaticProject && resolvedProjectStack === "nextjs";
      const isNodeApiProject =
        !resolvedIsMobile && !isSpecializedStaticProject && resolvedProjectStack === "node-api";
      const isPythonFlaskProject =
        !resolvedIsMobile && !isSpecializedStaticProject && resolvedProjectStack === "python-flask";
      const isPythonFastapiProject =
        !resolvedIsMobile &&
        !isSpecializedStaticProject &&
        resolvedProjectStack === "python-fastapi";
      const isGoGinProject =
        !resolvedIsMobile && !isSpecializedStaticProject && resolvedProjectStack === "go-gin";

      // For mobile projects: load last successful task's wired modules + project secret names once,
      // so both build and refine pipelines have durable module context.
      let activeModuleIds: string[] = [];
      let configuredSecretNames: string[] = [];
      if (resolvedIsMobile) {
        const [lastTask, projectSecrets] = await Promise.all([
          db
            .select({ report: agentTasksTable.report })
            .from(agentTasksTable)
            .where(
              and(
                eq(agentTasksTable.projectId, projectId),
                eq(agentTasksTable.status, "completed"),
              ),
            )
            .orderBy(desc(agentTasksTable.completedAt))
            .limit(1),
          db
            .select({ name: secretsTable.name })
            .from(secretsTable)
            .where(eq(secretsTable.projectId, projectId)),
        ]);
        const lastReport = lastTask[0]?.report as TaskReport | null;
        activeModuleIds = lastReport?.modulesWired?.map((m) => m.id) ?? [];
        configuredSecretNames = projectSecrets.map((s) => s.name);
      }

      if (kind === "build") {
        await emitEvent(
          taskId,
          "narration",
          resolvedIsMobile
            ? "Let me plan the mobile app structure before writing any code."
            : isSlidesProject
              ? "Let me plan the slide deck structure before writing any code."
              : isAnimationProject
                ? "Let me plan the animation sequence before writing any code."
                : isAutomationProject
                  ? "Let me plan the automation script before writing any code."
                  : isReactViteProject
                    ? "Let me plan the React + Vite project structure before writing any code."
                    : isNodeApiProject
                      ? "Let me plan the Node.js project structure before writing any code."
                      : isPythonFlaskProject || isPythonFastapiProject
                        ? "Let me plan the Python project structure before writing any code."
                        : isGoGinProject
                          ? "Let me plan the Go + Gin project structure before writing any code."
                          : "Let me plan the app structure before writing any code.",
        );
        await emitEvent(taskId, "planning", "Reading project configuration…");
        await emitEvent(
          taskId,
          "generating_code",
          resolvedIsMobile
            ? "Generating Expo/React Native app with AI…"
            : isSlidesProject
              ? "Generating Reveal.js slide deck with AI…"
              : isAnimationProject
                ? "Generating animated web experience with AI…"
                : isAutomationProject
                  ? "Generating Node.js automation script with AI…"
                  : isReactViteProject
                    ? "Generating React + Vite project with AI…"
                    : isNodeApiProject
                      ? "Generating Node.js / Express project with AI…"
                      : isPythonFlaskProject || isPythonFastapiProject
                        ? "Generating Python / Flask project with AI…"
                        : isGoGinProject
                          ? "Generating Go + Gin project with AI…"
                          : "Generating app blueprint and code with AI…",
        );

        const stackBuildArgs = {
          projectName: project.name,
          projectKind: project.kind,
          userPrompt,
          agentMode,
          conversationHistory,
          knowledgeContext: knowledgeContext || undefined,
          planContext: input.planContext ?? null,
          conversationSummary,
          imageAttachments,
          onEvent: async (type: string, message: string) => emitEvent(taskId, type, message),
          signal,
        };

        // ── Agentic pre-flight gate ────────────────────────────────────────────
        // Ensures the container is awake, proves real exec works end-to-end,
        // and confirms the database is reachable before the agent loop starts.
        // Hard-fails for agentic projects that have no containerId (unprovisioned).
        if (project.containerId || project.builderMode === "agentic") {
          const preflightResult = await runAgenticPreflightGate(
            projectId,
            taskId,
            project.containerId ?? null,
            project.containerUrl ?? null,
            project.builderMode,
          );
          if (!preflightResult.ok) {
            const preflightMsg = preflightResult.message ?? "Pre-flight check failed.";
            await emitEvent(taskId, "preflight_error", preflightMsg);
            await emitEvent(taskId, "failed", preflightMsg);
            await db
              .update(agentTasksTable)
              .set({ status: "failed", completedAt: new Date() })
              .where(eq(agentTasksTable.id, taskId));
            await db
              .update(projectsTable)
              .set({ status: "failed", updatedAt: sql`now()` })
              .where(eq(projectsTable.id, projectId));
            return;
          }
        }
        // ── End agentic pre-flight gate ────────────────────────────────────────

        // Disable Fly autostop on the build machine so it cannot idle-stop during
        // long-running inline execs (npm install, tsc, vite build).  The keepalive
        // loop is a belt-and-suspenders fallback in case the PATCH hasn't propagated.
        if (project.containerId && project.containerUrl) {
          const { patchMachineAutostop, startContainerKeepalive, startContainerHealthServer } =
            await import("./container");
          keepaliveMachineId = project.containerId;
          logger.info(
            { taskId, projectId, machineId: project.containerId },
            "Build task: disabling autostop + setting min_machines_running=1",
          );
          await patchMachineAutostop(project.containerId, projectId, "off");
          await startContainerHealthServer(project.containerId, projectId);
          stopContainerKeepalive = startContainerKeepalive(project.containerUrl, projectId);
        }

        const USE_AGENT_LOOP_BUILD = process.env.AGENTIC_BUILDER_ENABLED !== "false";
        logger.info(
          { taskId, projectId, pipeline: USE_AGENT_LOOP_BUILD ? "agentic" : "legacy" },
          "Builder pipeline selected",
        );
        let result:
          | Awaited<ReturnType<typeof runBuildPipeline>>
          | Awaited<ReturnType<typeof runMobileBuildPipeline>> =
          USE_AGENT_LOOP_BUILD && !isSpecializedStaticProject
            ? await (async () => {
                const { runAgentLoop, loopResultToBuildResult } = await import("./agent-loop");
                await emitEvent(taskId, "narration", "Agentic builder loop engaged.");
                const loopRes = await runAgentLoop({
                  mode: "build",
                  projectId,
                  projectName: project.name,
                  projectKind: project.kind,
                  projectFormat: project.projectFormat ?? null,
                  stack: project.stack ?? null,
                  projectMode: project.projectMode ?? null,
                  userPrompt,
                  agentMode,
                  conversationHistory,
                  knowledgeContext: knowledgeContext || undefined,
                  planContext: input.planContext ?? null,
                  existingFiles: [],
                  containerId: projectHasLiveServer() ? project.containerId : null,
                  liveServerAvailable: projectHasLiveServer(),
                  policyStrictness:
                    (project.policyStrictness as "safe" | "standard" | "permissive" | undefined) ??
                    null,
                  requireCommandApproval: project.requireCommandApproval ?? false,
                  onBeforeRiskyOp: async (reason: string) => {
                    try {
                      const snap = await snapshotFilesForVersion(projectId);
                      await db.insert(projectVersionsTable).values({
                        projectId,
                        label: `Checkpoint: ${reason.slice(0, 60)}`,
                        note: `Auto-checkpoint before: ${reason}`,
                        changelogEntry: `Auto-checkpoint before risky operation: ${reason.slice(0, 80)}`,
                        filesSnapshot: snap,
                      });
                    } catch (err) {
                      logger.warn(
                        { err, projectId },
                        "onBeforeRiskyOp: auto-checkpoint failed (non-fatal)",
                      );
                    }
                  },
                  taskId,
                  wallClockMs: input.wallClockCapMs,
                  previewUrl: project.containerUrl ?? null,
                  e2eEnabled: project.e2eEnabled ?? true,
                  onEvent: async (t, m) => emitEvent(taskId, t, m),
                  signal,
                  onBillableSenseBatch: (credits, total) => {
                    if (!project.ownerId) return;
                    void getOrCreateCredits(project.ownerId)
                      .then((bal) => {
                        if (bal.balance < credits) {
                          logger.warn(
                            { projectId, credits, balance: bal.balance },
                            "credits_exhausted: skipping senses deduction — insufficient balance",
                          );
                          return;
                        }
                        return deductCreditsAtomic(project.ownerId!, credits, {
                          type: "senses",
                          description: `Web senses batch (${total} call${total === 1 ? "" : "s"}) — project ${projectId}`,
                          projectId,
                        }).then((result) => {
                          if ("insufficient" in result) {
                            logger.warn(
                              { projectId, credits },
                              "Sense credit deduction: insufficient balance — work already delivered",
                            );
                          }
                        });
                      })
                      .catch((err) =>
                        logger.warn({ err }, "Sense credit deduction failed (non-fatal)"),
                      );
                  },
                  onBillableCreativeCall: (credits, tool) => {
                    if (!project.ownerId) return;
                    void getOrCreateCredits(project.ownerId)
                      .then((bal) => {
                        if (bal.balance < credits) {
                          logger.warn(
                            { projectId, credits, tool, balance: bal.balance },
                            "credits_exhausted: skipping creative deduction — insufficient balance",
                          );
                          return;
                        }
                        return deductCreditsAtomic(project.ownerId!, credits, {
                          type: "creative",
                          description: `Agent ${tool} — project ${projectId}`,
                          projectId,
                        }).then((result) => {
                          if ("insufficient" in result) {
                            logger.warn(
                              { projectId, credits, tool },
                              "Creative credit deduction: insufficient balance — work already delivered",
                            );
                          }
                        });
                      })
                      .catch((err) =>
                        logger.warn({ err }, "Creative credit deduction failed (non-fatal)"),
                      );
                  },
                });
                return loopResultToBuildResult(loopRes, userPrompt, project.name);
              })()
            : resolvedIsMobile
              ? await runMobileBuildPipeline({
                  projectName: project.name,
                  projectKind: project.kind,
                  userPrompt,
                  agentMode,
                  conversationHistory,
                  knowledgeContext: knowledgeContext || undefined,
                  activeModuleIds,
                  configuredSecretNames,
                  imageAttachments,
                  onEvent: async (type, message) => emitEvent(taskId, type, message),
                  signal,
                })
              : isSlidesProject
                ? await runSlidesBuildPipeline(stackBuildArgs)
                : isAnimationProject
                  ? await runAnimationBuildPipeline(stackBuildArgs)
                  : isAutomationProject
                    ? await runAutomationBuildPipeline(stackBuildArgs)
                    : isReactViteProject
                      ? await runReactViteBuildPipeline({
                          projectName: project.name,
                          projectKind: project.kind,
                          userPrompt,
                          agentMode,
                          conversationHistory,
                          knowledgeContext: knowledgeContext || undefined,
                          databaseContext,
                          planContext: input.planContext ?? null,
                          conversationSummary,
                          imageAttachments,
                          onEvent: async (type, message) => emitEvent(taskId, type, message),
                          signal,
                        })
                      : isNextjsProject
                        ? await runNextjsBuildPipeline(stackBuildArgs)
                        : isNodeApiProject
                          ? await runNodeApiBuildPipeline(stackBuildArgs)
                          : isPythonFlaskProject
                            ? await runFlaskBuildPipeline(stackBuildArgs)
                            : isPythonFastapiProject
                              ? await runFastapiBuildPipeline(stackBuildArgs)
                              : isGoGinProject
                                ? await runGoGinBuildPipeline(stackBuildArgs)
                                : await runBuildPipeline({
                                    projectName: project.name,
                                    projectKind: project.kind,
                                    userPrompt,
                                    agentMode,
                                    conversationHistory,
                                    knowledgeContext: knowledgeContext || undefined,
                                    databaseContext,
                                    planContext: input.planContext ?? null,
                                    conversationSummary,
                                    imageAttachments,
                                    builderMode: project.builderMode,
                                    onEvent: async (type: string, message: string) =>
                                      emitEvent(taskId, type, message),
                                    onToken: (delta: string) => emitTokenEvent(taskId, delta),
                                    signal,
                                  });

        analyticsCorrectionPasses = result.correctionPasses;
        analyticsErrorCategory = result.primaryErrorCategory;

        // Auto-escalation: if correction pass failed, retry at next model tier.
        // When the agentic builder loop is active it owns its own retry semantics
        // (write → check → fix iteration + per-tier model selection), so we skip
        // the legacy single-shot escalation path to avoid mixing pipelines.
        const buildEscalationMode = ESCALATION_MAP[agentMode];
        if (
          result.correctionFailed &&
          buildEscalationMode &&
          !resolvedIsMobile &&
          !USE_AGENT_LOOP_BUILD
        ) {
          logger.info(
            { taskId, projectId, from: agentMode, to: buildEscalationMode },
            "Auto-escalating build to higher model tier",
          );
          await emitEvent(
            taskId,
            "generating_code",
            `Validation failed — escalating to ${buildEscalationMode} mode and retrying…`,
          );
          const escalatedStackBuildArgs = {
            projectName: project.name,
            projectKind: project.kind,
            userPrompt,
            agentMode: buildEscalationMode,
            conversationHistory,
            knowledgeContext: knowledgeContext || undefined,
            planContext: input.planContext ?? null,
            conversationSummary,
            imageAttachments,
            onEvent: async (type: string, message: string) => emitEvent(taskId, type, message),
            signal,
          };
          const escalatedResult = isSlidesProject
            ? await runSlidesBuildPipeline(escalatedStackBuildArgs)
            : isAnimationProject
              ? await runAnimationBuildPipeline(escalatedStackBuildArgs)
              : isAutomationProject
                ? await runAutomationBuildPipeline(escalatedStackBuildArgs)
                : isReactViteProject
                  ? await runReactViteBuildPipeline({
                      projectName: project.name,
                      projectKind: project.kind,
                      userPrompt,
                      agentMode: buildEscalationMode,
                      conversationHistory,
                      knowledgeContext: knowledgeContext || undefined,
                      databaseContext,
                      planContext: input.planContext ?? null,
                      conversationSummary,
                      imageAttachments,
                      signal,
                    })
                  : isNextjsProject
                    ? await runNextjsBuildPipeline(escalatedStackBuildArgs)
                    : isNodeApiProject
                      ? await runNodeApiBuildPipeline(escalatedStackBuildArgs)
                      : isPythonFlaskProject
                        ? await runFlaskBuildPipeline(escalatedStackBuildArgs)
                        : isPythonFastapiProject
                          ? await runFastapiBuildPipeline(escalatedStackBuildArgs)
                          : isGoGinProject
                            ? await runGoGinBuildPipeline(escalatedStackBuildArgs)
                            : await runBuildPipeline({
                                projectName: project.name,
                                projectKind: project.kind,
                                userPrompt,
                                agentMode: buildEscalationMode,
                                conversationHistory,
                                knowledgeContext: knowledgeContext || undefined,
                                imageAttachments,
                                databaseContext,
                                planContext: input.planContext ?? null,
                                conversationSummary,
                                builderMode: project.builderMode,
                                onEvent: async (type: string, message: string) =>
                                  emitEvent(taskId, type, message),
                                onToken: (delta: string) => emitTokenEvent(taskId, delta),
                                signal,
                              });
          wasEscalated = true;
          agentMode = buildEscalationMode;
          result = escalatedResult;
          analyticsCorrectionPasses += escalatedResult.correctionPasses;
          analyticsErrorCategory = escalatedResult.primaryErrorCategory ?? analyticsErrorCategory;
          result.report.warnings = [
            `Auto-escalated from ${input.agentMode} to ${buildEscalationMode} mode after validation failure`,
            ...(result.report.warnings ?? []),
          ];
        }

        // Hard gate (legacy) — refuse to write broken files; throw so runJob marks the task failed.
        // Agentic builder exception: persist the snapshot anyway with validation_status="failed"
        // so the user can inspect what the loop produced and iterate.
        // Always capture all check results so we can detect non-required failures
        // for passed_with_warnings even when correctionFailed is false.
        if (USE_AGENT_LOOP_BUILD) {
          _allAgentCheckResults =
            (result.report.agentLoop?.checkResults as typeof _allAgentCheckResults) ?? [];
        }
        if (result.correctionFailed && !USE_AGENT_LOOP_BUILD) {
          throw new Error(
            `Build validation still failed after correction pass${buildEscalationMode ? " and auto-escalation" : ""}. ` +
              `No files were saved. Try rephrasing your request or switching to a higher agent mode.`,
          );
        }
        if (result.correctionFailed && USE_AGENT_LOOP_BUILD) {
          // Defer final status — the repair loop (after build/refine blocks) will
          // attempt targeted TypeScript fixes before committing with an error status.
          const agentBuildChecks = result.report.agentLoop?.checkResults ?? [];
          _pendingRepairChecks = failedChecksEligibleForRepair(agentBuildChecks).map((c) => ({
            label: c.label,
            output: c.message ?? "",
          }));
          _pendingRepairChangedPaths = (result.files ?? []).map((f) => f.path);
          result.correctionFailed = false;
        }

        // Secrets scan — redact before persisting
        const { files: sanitisedFiles, findings: secretFindings } = scanForSecrets(result.files);
        if (secretFindings.length > 0) {
          logger.warn(
            { taskId, projectId, secretFindings },
            "Secrets detected and redacted in generated build files",
          );
          result.report.warnings = [
            ...(result.report.warnings ?? []),
            ...secretFindings.map(
              (f) => `Secrets Scan: ${f.category} detected in ${f.file} and redacted before saving`,
            ),
          ];
        }
        result = { ...result, files: sanitisedFiles };

        // Cross-file consistency check
        const buildConsistencyWarnings = validateCrossFileConsistency(sanitisedFiles);
        if (buildConsistencyWarnings.length > 0) {
          result.report.warnings = [...(result.report.warnings ?? []), ...buildConsistencyWarnings];
        }

        await emitEvent(
          taskId,
          "generating_code",
          `Blueprint created: ${result.files.length} file(s) planned.`,
        );

        // Guard: if the build was cancelled while the AI was responding, stop before touching files.
        if (signal?.aborted) throw new Error("Build cancelled");

        await emitEvent(
          taskId,
          "narration",
          `${agentIdentity === "task" ? "Staging" : "Writing"} ${result.files.length} file${result.files.length !== 1 ? "s" : ""} ${agentIdentity === "task" ? "to staging for review" : "to the project now"}.`,
        );
        await emitEvent(
          taskId,
          "editing_files",
          agentIdentity === "task"
            ? "Staging generated files for review…"
            : "Writing generated files…",
        );
        for (const f of result.files) {
          await emitEvent(
            taskId,
            "editing_files",
            `${agentIdentity === "task" ? "Staging" : "Writing"} ${f.path}`,
            f.path,
          );
        }
        if (agentIdentity === "task") {
          stagingData = result.files.map((f) => ({
            path: f.path,
            content: f.content,
            mimeType: f.mimeType,
          }));
        } else {
          // Inject health endpoint for server-stack projects before writing to project_files.
          // This ensures the immutable test candidate snapshot always contains a health endpoint.
          const { injectHealthEndpoint } = await import("./health-inject");
          const filesWithHealth = injectHealthEndpoint(result.files, project.stack ?? null);
          await writeFiles(projectId, filesWithHealth, true);
          emitFilesChangedEvent(taskId, projectId, filesWithHealth, [], "build");
          void staleDraftCandidate(projectId, "build").catch(() => {});
        }
        diffSummary = computeBuildDiff(result.files);

        report = result.report;
        assistantSummary = result.assistantSummary;
        nextVersionLabel = isMobileProject
          ? "Initial mobile build"
          : isSlidesProject
            ? "Initial slide deck"
            : isAnimationProject
              ? "Initial animation"
              : isAutomationProject
                ? "Initial automation script"
                : isReactViteProject
                  ? "Initial React + Vite build"
                  : isNextjsProject
                    ? "Initial Next.js build"
                    : isNodeApiProject
                      ? "Initial Node.js API build"
                      : isPythonFlaskProject
                        ? "Initial Flask build"
                        : isPythonFastapiProject
                          ? "Initial FastAPI build"
                          : isGoGinProject
                            ? "Initial Go + Gin build"
                            : "Initial build";
        filesToSmellScan = result.files;
      } else {
        await emitEvent(
          taskId,
          "narration",
          "Let me read the current project files before making any changes.",
        );
        await emitEvent(taskId, "reading_files", "Reading current project files…");
        const existingFiles = await loadFiles(projectId);
        if (agentIdentity === "task") existingFilesSnapshot = existingFiles;
        await emitEvent(
          taskId,
          "reading_files",
          `Loaded ${existingFiles.length} existing file(s).`,
        );

        // Load unchanged-files hint from the last completed task for this project.
        // These paths were declared untouched by the model in the prior refine turn and are
        // passed to makeCompactManifest so they get a path-only stub instead of a full content
        // block, reducing the token count of the file manifest sent to the model.
        let unchangedFilesHint: string[] = [];
        try {
          const [lastTask] = await db
            .select({ report: agentTasksTable.report })
            .from(agentTasksTable)
            .where(
              and(
                eq(agentTasksTable.projectId, projectId),
                eq(agentTasksTable.status, "completed"),
              ),
            )
            .orderBy(desc(agentTasksTable.completedAt))
            .limit(1);
          unchangedFilesHint = lastTask?.report?.filesUnchanged ?? [];
        } catch (err) {
          logger.warn({ err, taskId }, "Failed to load prior unchangedFiles hint (non-fatal)");
        }

        if (unchangedFilesHint.length > 0) {
          logger.info(
            { taskId, projectId, count: unchangedFilesHint.length },
            "Applying unchangedFiles hint to file manifest — skipping full content for these paths",
          );
        }

        await emitEvent(
          taskId,
          "narration",
          isMobileProject
            ? "Applying your changes to the Expo project now."
            : isSlidesProject
              ? "Applying your changes to the slide deck now."
              : isAnimationProject
                ? "Applying your changes to the animation now."
                : isAutomationProject
                  ? "Applying your changes to the automation script now."
                  : isReactViteProject
                    ? "Applying your changes to the React + Vite project now."
                    : isNodeApiProject
                      ? "Applying your changes to the Node.js project now."
                      : isPythonFlaskProject || isPythonFastapiProject
                        ? "Applying your changes to the Python project now."
                        : isGoGinProject
                          ? "Applying your changes to the Go + Gin project now."
                          : "Applying your requested changes to the codebase now.",
        );
        await emitEvent(
          taskId,
          "generating_code",
          isMobileProject
            ? "Applying change to Expo project with AI…"
            : isSlidesProject
              ? "Applying change to slide deck with AI…"
              : isAnimationProject
                ? "Applying change to animation with AI…"
                : isAutomationProject
                  ? "Applying change to automation script with AI…"
                  : isReactViteProject
                    ? "Applying change to React + Vite project with AI…"
                    : isNodeApiProject
                      ? "Applying change to Node.js project with AI…"
                      : isPythonFlaskProject || isPythonFastapiProject
                        ? "Applying change to Python project with AI…"
                        : isGoGinProject
                          ? "Applying change to Go + Gin project with AI…"
                          : "Applying change request with AI…",
        );

        const stackRefineArgs = {
          projectName: project.name,
          projectKind: project.kind,
          userPrompt,
          agentMode,
          existingFiles,
          conversationHistory,
          knowledgeContext: knowledgeContext || undefined,
          unchangedFilesHint: unchangedFilesHint.length > 0 ? unchangedFilesHint : undefined,
          planContext: input.planContext ?? null,
          conversationSummary,
          imageAttachments,
          onEvent: async (type: string, message: string) => emitEvent(taskId, type, message),
          signal,
        };

        // ── Agentic pre-flight gate (refine path) ────────────────────────────
        if (project.containerId || project.builderMode === "agentic") {
          const preflightResult = await runAgenticPreflightGate(
            projectId,
            taskId,
            project.containerId ?? null,
            project.containerUrl ?? null,
            project.builderMode,
          );
          if (!preflightResult.ok) {
            const preflightMsg = preflightResult.message ?? "Pre-flight check failed.";
            await emitEvent(taskId, "preflight_error", preflightMsg);
            await emitEvent(taskId, "failed", preflightMsg);
            await db
              .update(agentTasksTable)
              .set({ status: "failed", completedAt: new Date() })
              .where(eq(agentTasksTable.id, taskId));
            await db
              .update(projectsTable)
              .set({ status: "failed", updatedAt: sql`now()` })
              .where(eq(projectsTable.id, projectId));
            return;
          }
        }
        // ── End agentic pre-flight gate ────────────────────────────────────────

        // Disable Fly autostop on the build machine so it cannot idle-stop during
        // long-running inline execs (npm install, tsc, vite build).  The keepalive
        // loop is a belt-and-suspenders fallback in case the PATCH hasn't propagated.
        if (project.containerId && project.containerUrl) {
          const { patchMachineAutostop, startContainerKeepalive, startContainerHealthServer } =
            await import("./container");
          keepaliveMachineId = project.containerId;
          logger.info(
            { taskId, projectId, machineId: project.containerId },
            "Refine task: disabling autostop + setting min_machines_running=1",
          );
          await patchMachineAutostop(project.containerId, projectId, "off");
          await startContainerHealthServer(project.containerId, projectId);
          stopContainerKeepalive = startContainerKeepalive(project.containerUrl, projectId);
        }

        const USE_AGENT_LOOP_REFINE = process.env.AGENTIC_BUILDER_ENABLED !== "false";
        logger.info(
          { taskId, projectId, pipeline: USE_AGENT_LOOP_REFINE ? "agentic" : "legacy" },
          "Refine pipeline selected",
        );
        let refineResult: Awaited<ReturnType<typeof runRefinePipeline>> =
          USE_AGENT_LOOP_REFINE && !isSpecializedStaticProject
            ? await (async () => {
                const { runAgentLoop, loopResultToRefineResult } = await import("./agent-loop");
                await emitEvent(taskId, "narration", "Agentic builder loop engaged.");
                const loopRes = await runAgentLoop({
                  mode: "refine",
                  projectId,
                  projectName: project.name,
                  projectKind: project.kind,
                  projectFormat: project.projectFormat ?? null,
                  stack: project.stack ?? null,
                  projectMode: project.projectMode ?? null,
                  userPrompt,
                  agentMode,
                  conversationHistory,
                  knowledgeContext: knowledgeContext || undefined,
                  planContext: input.planContext ?? null,
                  existingFiles,
                  containerId: projectHasLiveServer() ? project.containerId : null,
                  liveServerAvailable: projectHasLiveServer(),
                  policyStrictness:
                    (project.policyStrictness as "safe" | "standard" | "permissive" | undefined) ??
                    null,
                  requireCommandApproval: project.requireCommandApproval ?? false,
                  onBeforeRiskyOp: async (reason: string) => {
                    try {
                      const snap = await snapshotFilesForVersion(projectId);
                      await db.insert(projectVersionsTable).values({
                        projectId,
                        label: `Checkpoint: ${reason.slice(0, 60)}`,
                        note: `Auto-checkpoint before: ${reason}`,
                        changelogEntry: `Auto-checkpoint before risky operation: ${reason.slice(0, 80)}`,
                        filesSnapshot: snap,
                      });
                    } catch (err) {
                      logger.warn(
                        { err, projectId },
                        "onBeforeRiskyOp: auto-checkpoint failed (non-fatal)",
                      );
                    }
                  },
                  taskId,
                  wallClockMs: input.wallClockCapMs,
                  previewUrl: project.containerUrl ?? null,
                  e2eEnabled: project.e2eEnabled ?? true,
                  onEvent: async (t, m) => emitEvent(taskId, t, m),
                  signal,
                  onBillableSenseBatch: (credits, total) => {
                    if (!project.ownerId) return;
                    void getOrCreateCredits(project.ownerId)
                      .then((bal) => {
                        if (bal.balance < credits) {
                          logger.warn(
                            { projectId, credits, balance: bal.balance },
                            "credits_exhausted: skipping senses deduction — insufficient balance",
                          );
                          return;
                        }
                        return deductCreditsAtomic(project.ownerId!, credits, {
                          type: "senses",
                          description: `Web senses batch (${total} call${total === 1 ? "" : "s"}) — project ${projectId}`,
                          projectId,
                        }).then((result) => {
                          if ("insufficient" in result) {
                            logger.warn(
                              { projectId, credits },
                              "Sense credit deduction: insufficient balance — work already delivered",
                            );
                          }
                        });
                      })
                      .catch((err) =>
                        logger.warn({ err }, "Sense credit deduction failed (non-fatal)"),
                      );
                  },
                  onBillableCreativeCall: (credits, tool) => {
                    if (!project.ownerId) return;
                    void getOrCreateCredits(project.ownerId)
                      .then((bal) => {
                        if (bal.balance < credits) {
                          logger.warn(
                            { projectId, credits, tool, balance: bal.balance },
                            "credits_exhausted: skipping creative deduction — insufficient balance",
                          );
                          return;
                        }
                        return deductCreditsAtomic(project.ownerId!, credits, {
                          type: "creative",
                          description: `Agent ${tool} — project ${projectId}`,
                          projectId,
                        }).then((result) => {
                          if ("insufficient" in result) {
                            logger.warn(
                              { projectId, credits, tool },
                              "Creative credit deduction: insufficient balance — work already delivered",
                            );
                          }
                        });
                      })
                      .catch((err) =>
                        logger.warn({ err }, "Creative credit deduction failed (non-fatal)"),
                      );
                  },
                });
                return loopResultToRefineResult(loopRes, userPrompt);
              })()
            : isMobileProject
              ? await runMobileRefinePipeline({
                  projectName: project.name,
                  projectKind: project.kind,
                  userPrompt,
                  agentMode,
                  existingFiles,
                  conversationHistory,
                  knowledgeContext: knowledgeContext || undefined,
                  activeModuleIds,
                  configuredSecretNames,
                  imageAttachments,
                  onEvent: async (type, message) => emitEvent(taskId, type, message),
                  signal,
                })
              : isSlidesProject
                ? await runSlidesRefinePipeline(stackRefineArgs)
                : isAnimationProject
                  ? await runAnimationRefinePipeline(stackRefineArgs)
                  : isAutomationProject
                    ? await runAutomationRefinePipeline(stackRefineArgs)
                    : isReactViteProject
                      ? await runReactViteRefinePipeline({
                          projectName: project.name,
                          projectKind: project.kind,
                          userPrompt,
                          agentMode,
                          existingFiles,
                          conversationHistory,
                          knowledgeContext: knowledgeContext || undefined,
                          databaseContext,
                          unchangedFilesHint:
                            unchangedFilesHint.length > 0 ? unchangedFilesHint : undefined,
                          planContext: input.planContext ?? null,
                          conversationSummary,
                          imageAttachments,
                          onEvent: async (type, message) => emitEvent(taskId, type, message),
                          signal,
                        })
                      : isNextjsProject
                        ? await runNextjsRefinePipeline(stackRefineArgs)
                        : isNodeApiProject
                          ? await runNodeApiRefinePipeline(stackRefineArgs)
                          : isPythonFlaskProject
                            ? await runFlaskRefinePipeline(stackRefineArgs)
                            : isPythonFastapiProject
                              ? await runFastapiRefinePipeline(stackRefineArgs)
                              : isGoGinProject
                                ? await runGoGinRefinePipeline(stackRefineArgs)
                                : await runRefinePipeline({
                                    projectName: project.name,
                                    projectKind: project.kind,
                                    userPrompt,
                                    agentMode,
                                    existingFiles,
                                    conversationHistory,
                                    knowledgeContext: knowledgeContext || undefined,
                                    databaseContext,
                                    unchangedFilesHint:
                                      unchangedFilesHint.length > 0
                                        ? unchangedFilesHint
                                        : undefined,
                                    planContext: input.planContext ?? null,
                                    conversationSummary,
                                    imageAttachments,
                                    builderMode: project.builderMode,
                                    onEvent: async (type: string, message: string) =>
                                      emitEvent(taskId, type, message),
                                    onToken: (delta: string) => emitTokenEvent(taskId, delta),
                                    signal,
                                  });

        analyticsCorrectionPasses = refineResult.correctionPasses;
        analyticsErrorCategory = refineResult.primaryErrorCategory;

        // Auto-escalation: if correction pass failed, retry at next model tier.
        // See note on the build path — agent loop owns its own retry semantics.
        const refineEscalationMode = ESCALATION_MAP[agentMode];
        if (
          refineResult.correctionFailed &&
          refineEscalationMode &&
          !isMobileProject &&
          !USE_AGENT_LOOP_REFINE
        ) {
          logger.info(
            { taskId, projectId, from: agentMode, to: refineEscalationMode },
            "Auto-escalating refine to higher model tier",
          );
          await emitEvent(
            taskId,
            "generating_code",
            `Validation failed — escalating to ${refineEscalationMode} mode and retrying…`,
          );
          const escalatedStackRefineArgs = {
            projectName: project.name,
            projectKind: project.kind,
            userPrompt,
            agentMode: refineEscalationMode,
            existingFiles,
            conversationHistory,
            knowledgeContext: knowledgeContext || undefined,
            unchangedFilesHint: unchangedFilesHint.length > 0 ? unchangedFilesHint : undefined,
            planContext: input.planContext ?? null,
            conversationSummary,
            imageAttachments,
            onEvent: async (type: string, message: string) => emitEvent(taskId, type, message),
          };
          const escalatedResult = isSlidesProject
            ? await runSlidesRefinePipeline(escalatedStackRefineArgs)
            : isAnimationProject
              ? await runAnimationRefinePipeline(escalatedStackRefineArgs)
              : isAutomationProject
                ? await runAutomationRefinePipeline(escalatedStackRefineArgs)
                : isReactViteProject
                  ? await runReactViteRefinePipeline({
                      projectName: project.name,
                      projectKind: project.kind,
                      userPrompt,
                      agentMode: refineEscalationMode,
                      existingFiles,
                      conversationHistory,
                      knowledgeContext: knowledgeContext || undefined,
                      databaseContext,
                      unchangedFilesHint:
                        unchangedFilesHint.length > 0 ? unchangedFilesHint : undefined,
                      planContext: input.planContext ?? null,
                      conversationSummary,
                      imageAttachments,
                    })
                  : isNextjsProject
                    ? await runNextjsRefinePipeline(escalatedStackRefineArgs)
                    : isNodeApiProject
                      ? await runNodeApiRefinePipeline(escalatedStackRefineArgs)
                      : isPythonFlaskProject
                        ? await runFlaskRefinePipeline(escalatedStackRefineArgs)
                        : isPythonFastapiProject
                          ? await runFastapiRefinePipeline(escalatedStackRefineArgs)
                          : isGoGinProject
                            ? await runGoGinRefinePipeline(escalatedStackRefineArgs)
                            : await runRefinePipeline({
                                projectName: project.name,
                                projectKind: project.kind,
                                userPrompt,
                                agentMode: refineEscalationMode,
                                existingFiles,
                                conversationHistory,
                                knowledgeContext: knowledgeContext || undefined,
                                databaseContext,
                                unchangedFilesHint:
                                  unchangedFilesHint.length > 0 ? unchangedFilesHint : undefined,
                                planContext: input.planContext ?? null,
                                conversationSummary,
                                imageAttachments,
                                builderMode: project.builderMode,
                                onEvent: async (type: string, message: string) =>
                                  emitEvent(taskId, type, message),
                                onToken: (delta: string) => emitTokenEvent(taskId, delta),
                              });
          wasEscalated = true;
          agentMode = refineEscalationMode;
          refineResult = escalatedResult;
          analyticsCorrectionPasses += escalatedResult.correctionPasses;
          analyticsErrorCategory = escalatedResult.primaryErrorCategory ?? analyticsErrorCategory;
          refineResult.report.warnings = [
            `Auto-escalated from ${input.agentMode} to ${refineEscalationMode} mode after validation failure`,
            ...(refineResult.report.warnings ?? []),
          ];
        }

        // Hard gate (legacy) — refuse to write broken files; throw so runJob marks the task failed.
        // Agentic builder exception: persist with validation_status="failed" (see build path).
        if (refineResult.correctionFailed && !USE_AGENT_LOOP_REFINE) {
          throw new Error(
            `Refine validation still failed after correction pass${refineEscalationMode ? " and auto-escalation" : ""}. ` +
              `No files were saved. Try rephrasing your request or switching to a higher agent mode.`,
          );
        }
        // Always capture all check results for passed_with_warnings detection.
        if (USE_AGENT_LOOP_REFINE) {
          _allAgentCheckResults =
            (refineResult.report.agentLoop?.checkResults as typeof _allAgentCheckResults) ?? [];
        }
        if (refineResult.correctionFailed && USE_AGENT_LOOP_REFINE) {
          // Defer final status — the repair loop (after build/refine blocks) will
          // attempt targeted TypeScript fixes before committing with an error status.
          const agentRefineChecks = refineResult.report.agentLoop?.checkResults ?? [];
          _pendingRepairChecks = failedChecksEligibleForRepair(agentRefineChecks).map((c) => ({
            label: c.label,
            output: c.message ?? "",
          }));
          _pendingRepairChangedPaths = refineResult.changedFiles.map((f) => f.path);
          refineResult.correctionFailed = false;
        }

        // Empty-refine retry guard: if the model returned 0 changed/removed files for a clearly
        // actionable request (contains a build verb), retry once with a stricter user instruction
        // appended. Prevents "explanation only, preview never updates" failure mode.
        const BUILD_VERB_RE =
          /\b(add|remove|delete|create|build|make|generate|change|update|modify|fix|refactor|implement|set\s*up|setup|install|integrate|wire|connect|enable|disable|hide|show|render|style|design|move|rename|replace|swap|upgrade|migrate|extract|split|merge)\b/i;
        // Question exclusion: prompts that are phrased as questions should not trigger a retry —
        // the model is expected to reply with an explanation, not file changes.
        const QUESTION_RE =
          /^\s*(what|how|why|when|where|who|which|can\s+you\s+explain|could\s+you\s+explain|do\s+you|does\s+it|is\s+there|are\s+there|tell\s+me|explain)\b/i;
        const endsWithQuestion = /\?\s*$/.test(userPrompt);
        const isQuestion = endsWithQuestion || QUESTION_RE.test(userPrompt);
        const refineEmpty =
          refineResult.changedFiles.length === 0 && refineResult.removedPaths.length === 0;
        if (refineEmpty && BUILD_VERB_RE.test(userPrompt) && !isQuestion) {
          logger.info(
            { taskId, projectId },
            "Refine returned 0 changes for an action-style prompt — retrying with stricter instruction",
          );
          await emitEvent(
            taskId,
            "generating_code",
            "First pass returned no changes — retrying with stricter instruction…",
          );
          const stricterPrompt = `${userPrompt}\n\n[SYSTEM] The previous attempt returned zero file changes for a request that clearly asks for code modifications. You MUST now return at least one concrete file modification that addresses the request. If the request is genuinely ambiguous, pick the most likely interpretation and ship a minimal change.`;
          try {
            if (USE_AGENT_LOOP_REFINE && !isSpecializedStaticProject) {
              // Retry through the agentic loop for consistency — same parameters as the
              // primary agentic refine path but with the stricter prompt appended.
              const { runAgentLoop, loopResultToRefineResult } = await import("./agent-loop");
              await emitEvent(taskId, "narration", "Agentic retry loop engaged.");
              const retryLoopRes = await runAgentLoop({
                mode: "refine",
                projectId,
                projectName: project.name,
                projectKind: project.kind,
                projectFormat: project.projectFormat ?? null,
                stack: project.stack ?? null,
                projectMode: project.projectMode ?? null,
                userPrompt: stricterPrompt,
                agentMode,
                conversationHistory,
                knowledgeContext: knowledgeContext || undefined,
                planContext: input.planContext ?? null,
                existingFiles,
                containerId: projectHasLiveServer() ? project.containerId : null,
                liveServerAvailable: projectHasLiveServer(),
                policyStrictness:
                  (project.policyStrictness as "safe" | "standard" | "permissive" | undefined) ??
                  null,
                requireCommandApproval: project.requireCommandApproval ?? false,
                onBeforeRiskyOp: async (reason: string) => {
                  try {
                    const snap = await snapshotFilesForVersion(projectId);
                    await db.insert(projectVersionsTable).values({
                      projectId,
                      label: `Checkpoint: ${reason.slice(0, 60)}`,
                      note: `Auto-checkpoint before: ${reason}`,
                      changelogEntry: `Auto-checkpoint before risky operation: ${reason.slice(0, 80)}`,
                      filesSnapshot: snap,
                    });
                  } catch (err) {
                    logger.warn(
                      { err, projectId },
                      "onBeforeRiskyOp: auto-checkpoint failed (non-fatal)",
                    );
                  }
                },
                taskId,
                wallClockMs: input.wallClockCapMs,
                previewUrl: project.containerUrl ?? null,
                e2eEnabled: project.e2eEnabled ?? true,
                onEvent: async (t, m) => emitEvent(taskId, t, m),
                signal,
                onBillableSenseBatch: (credits, total) => {
                  if (!project.ownerId) return;
                  void getOrCreateCredits(project.ownerId)
                    .then((bal) => {
                      if (bal.balance < credits) {
                        logger.warn(
                          { projectId, credits, balance: bal.balance },
                          "credits_exhausted: skipping senses deduction — insufficient balance",
                        );
                        return;
                      }
                      return deductCreditsAtomic(project.ownerId!, credits, {
                        type: "senses",
                        description: `Web senses batch (${total} call${total === 1 ? "" : "s"}) — project ${projectId}`,
                        projectId,
                      });
                    })
                    .catch((err) =>
                      logger.warn({ err }, "Sense credit deduction failed (non-fatal)"),
                    );
                },
                onBillableCreativeCall: (credits, tool) => {
                  if (!project.ownerId) return;
                  void getOrCreateCredits(project.ownerId)
                    .then((bal) => {
                      if (bal.balance < credits) {
                        logger.warn(
                          { projectId, credits, tool, balance: bal.balance },
                          "credits_exhausted: skipping creative deduction — insufficient balance",
                        );
                        return;
                      }
                      return deductCreditsAtomic(project.ownerId!, credits, {
                        type: "creative",
                        description: `Agent ${tool} — project ${projectId}`,
                        projectId,
                      });
                    })
                    .catch((err) =>
                      logger.warn({ err }, "Creative credit deduction failed (non-fatal)"),
                    );
                },
              });
              const retryResult = loopResultToRefineResult(retryLoopRes, stricterPrompt);
              const retryEmpty =
                retryResult.changedFiles.length === 0 && retryResult.removedPaths.length === 0;
              if (!retryResult.correctionFailed) {
                refineResult = retryResult;
                if (retryEmpty) {
                  // Both passes returned 0 changes — surface a clear failure message so the
                  // user knows the request needs clarification rather than silently showing
                  // an unchanged preview.
                  logger.warn(
                    { taskId, projectId },
                    "Agentic retry also returned 0 changes — surfacing double-fail to user",
                  );
                  refineResult.report.warnings = [
                    "Neither the initial pass nor the retry produced any file changes. The request may be ambiguous or describe something already present — try rephrasing with a concrete code change in mind.",
                    ...(refineResult.report.warnings ?? []),
                  ];
                } else {
                  refineResult.report.warnings = [
                    "First pass returned no file changes — retried once with a stricter instruction.",
                    ...(refineResult.report.warnings ?? []),
                  ];
                }
              }
            } else {
              // Specialized static project (mobile, slides, animation, automation, etc.) or
              // agentic loop disabled — fall back to the per-stack legacy retry pipeline.
              const retryStackArgs = { ...stackRefineArgs, userPrompt: stricterPrompt };
              const retryResult = isMobileProject
                ? await runMobileRefinePipeline({
                    projectName: project.name,
                    projectKind: project.kind,
                    userPrompt: stricterPrompt,
                    agentMode,
                    existingFiles,
                    conversationHistory,
                    knowledgeContext: knowledgeContext || undefined,
                    activeModuleIds,
                    configuredSecretNames,
                    imageAttachments,
                    onEvent: async (type, message) => emitEvent(taskId, type, message),
                    signal,
                  })
                : isSlidesProject
                  ? await runSlidesRefinePipeline(retryStackArgs)
                  : isAnimationProject
                    ? await runAnimationRefinePipeline(retryStackArgs)
                    : isAutomationProject
                      ? await runAutomationRefinePipeline(retryStackArgs)
                      : isReactViteProject
                        ? await runReactViteRefinePipeline({
                            projectName: project.name,
                            projectKind: project.kind,
                            userPrompt: stricterPrompt,
                            agentMode,
                            existingFiles,
                            conversationHistory,
                            knowledgeContext: knowledgeContext || undefined,
                            databaseContext,
                            unchangedFilesHint:
                              unchangedFilesHint.length > 0 ? unchangedFilesHint : undefined,
                            planContext: input.planContext ?? null,
                            conversationSummary,
                            imageAttachments,
                            onEvent: async (type, message) => emitEvent(taskId, type, message),
                            signal,
                          })
                        : isNextjsProject
                          ? await runNextjsRefinePipeline(retryStackArgs)
                          : isNodeApiProject
                            ? await runNodeApiRefinePipeline(retryStackArgs)
                            : isPythonFlaskProject
                              ? await runFlaskRefinePipeline(retryStackArgs)
                              : isPythonFastapiProject
                                ? await runFastapiRefinePipeline(retryStackArgs)
                                : isGoGinProject
                                  ? await runGoGinRefinePipeline(retryStackArgs)
                                  : await runRefinePipeline({
                                      projectName: project.name,
                                      projectKind: project.kind,
                                      userPrompt: stricterPrompt,
                                      agentMode,
                                      existingFiles,
                                      conversationHistory,
                                      knowledgeContext: knowledgeContext || undefined,
                                      databaseContext,
                                      unchangedFilesHint:
                                        unchangedFilesHint.length > 0
                                          ? unchangedFilesHint
                                          : undefined,
                                      planContext: input.planContext ?? null,
                                      conversationSummary,
                                      imageAttachments,
                                      builderMode: project.builderMode,
                                      onEvent: async (type: string, message: string) =>
                                        emitEvent(taskId, type, message),
                                      onToken: (delta: string) => emitTokenEvent(taskId, delta),
                                      signal,
                                    });
              if (!retryResult.correctionFailed) {
                refineResult = retryResult;
                refineResult.report.warnings = [
                  "First pass returned no file changes — retried once with a stricter instruction.",
                  ...(refineResult.report.warnings ?? []),
                ];
              }
            }
          } catch (err) {
            logger.warn(
              { err, taskId, projectId },
              "Empty-refine retry pass failed — using original result",
            );
          }
        }

        // Secrets scan — redact before persisting
        const { files: sanitisedChangedFiles, findings: refineSecretFindings } = scanForSecrets(
          refineResult.changedFiles,
        );
        if (refineSecretFindings.length > 0) {
          logger.warn(
            { taskId, projectId, refineSecretFindings },
            "Secrets detected and redacted in refined files",
          );
          refineResult.report.warnings = [
            ...(refineResult.report.warnings ?? []),
            ...refineSecretFindings.map(
              (f) => `Secrets Scan: ${f.category} detected in ${f.file} and redacted before saving`,
            ),
          ];
        }
        refineResult = { ...refineResult, changedFiles: sanitisedChangedFiles };

        // Cross-file consistency check on the merged project file set
        const mergedFilesForConsistency = [...existingFiles];
        for (const cf of refineResult.changedFiles) {
          const idx = mergedFilesForConsistency.findIndex((f) => f.path === cf.path);
          if (idx >= 0) mergedFilesForConsistency[idx] = cf;
          else mergedFilesForConsistency.push(cf);
        }
        const refineConsistencyWarnings = validateCrossFileConsistency(mergedFilesForConsistency);
        if (refineConsistencyWarnings.length > 0) {
          refineResult.report.warnings = [
            ...(refineResult.report.warnings ?? []),
            ...refineConsistencyWarnings,
          ];
        }

        const result = refineResult;

        const changedCount = result.changedFiles.length + result.removedPaths.length;
        await emitEvent(
          taskId,
          "narration",
          changedCount === 0
            ? "I didn't change any files for this request — see the explanation in the report below."
            : `Writing ${changedCount} updated file${changedCount !== 1 ? "s" : ""} to the project.`,
        );
        // Guard: if the build was cancelled while the AI was responding, stop before touching files.
        if (signal?.aborted) throw new Error("Build cancelled");

        await emitEvent(
          taskId,
          "editing_files",
          `AI returned ${result.changedFiles.length} changed file(s).`,
        );

        if (result.changedFiles.length > 0) {
          for (const f of result.changedFiles) {
            await emitEvent(
              taskId,
              "editing_files",
              agentIdentity === "task" ? `Staging ${f.path}` : `Updating ${f.path}`,
              f.path,
            );
          }
          if (agentIdentity !== "task") {
            await writeFiles(projectId, result.changedFiles, false);
          }
        }
        if (result.removedPaths.length > 0) {
          for (const p of result.removedPaths) {
            await emitEvent(taskId, "editing_files", `Removing ${p}`, p);
          }
          if (agentIdentity !== "task") {
            await deleteFiles(projectId, result.removedPaths);
          }
        }
        // Emit project_files_changed after both writeFiles and deleteFiles complete
        // so removedPaths are accurate and the WebContainer FS doesn't drift.
        if (
          agentIdentity !== "task" &&
          (result.changedFiles.length > 0 || result.removedPaths.length > 0)
        ) {
          emitFilesChangedEvent(
            taskId,
            projectId,
            result.changedFiles,
            result.removedPaths,
            "refine",
          );
          void staleDraftCandidate(projectId, "refine").catch(() => {});
        }
        if (agentIdentity === "task") {
          // Build the full merged file set so the staging snapshot is self-contained
          _refineChangedFiles = result.changedFiles;
          _refineRemovedPaths = result.removedPaths;
          const merged = [...existingFilesSnapshot];
          for (const cf of result.changedFiles) {
            const idx = merged.findIndex((f) => f.path === cf.path);
            if (idx >= 0) merged[idx] = cf;
            else merged.push(cf);
          }
          stagingData = merged
            .filter((f) => !result.removedPaths.includes(f.path))
            .map((f) => ({ path: f.path, content: f.content, mimeType: f.mimeType }));
        }
        diffSummary = computeRefineDiff(existingFiles, result.changedFiles, result.removedPaths);

        report = result.report;

        // Surface unchanged-files count in the task report so the report card can display it.
        // Also persists the list for the next refine turn's manifest pruning hint.
        if (result.unchangedFiles.length > 0) {
          report.filesUnchanged = result.unchangedFiles;
          logger.info(
            { taskId, projectId, count: result.unchangedFiles.length },
            "Refine: skipped writeFiles for unchanged paths (already correct in DB)",
          );
        }

        assistantSummary = result.assistantSummary;
        nextVersionLabel = userPrompt.slice(0, 40) || "Refinement";
        filesToSmellScan = result.changedFiles;
      }

      // ── Automatic Repair Loop ─────────────────────────────────────────────────
      // Triggered whenever the build/refine agent loop ends with foundation check
      // failures. Attempts up to N targeted repair passes before committing with
      // "completed_with_errors". Runs for all project types — containerId is passed
      // as null for static projects, which skips container-dependent checks inside
      // the agent loop but still runs syntax and structural repair.
      if (_pendingRepairChecks.length > 0 && agentIdentity !== "task") {
        const maxRepairAttempts = repairLoopMaxAttempts(agentMode);
        const repairAttemptRecords: Array<{
          attempt: number;
          succeeded: boolean;
          filesChanged: string[];
        }> = [];
        let repairSucceeded = false;
        let currentFailedChecks = _pendingRepairChecks;
        let currentChangedPaths = _pendingRepairChangedPaths;

        const { runAgentLoop: runRepairAgentLoop } = await import("./agent-loop");

        for (
          let repairAttempt = 1;
          repairAttempt <= maxRepairAttempts && !repairSucceeded;
          repairAttempt++
        ) {
          await emitEvent(
            taskId,
            "check_result",
            JSON.stringify(
              currentFailedChecks.map((c, i) => ({
                id: `repair-fail-${repairAttempt}-${i}`,
                label: c.label,
                passed: false,
              })),
            ),
          );
          const repairCategoryLabel = detectRepairCategory(currentFailedChecks);
          const repairCategoryDisplay: Record<typeof repairCategoryLabel, string> = {
            "server-start": "Server startup failure",
            install: "Install failure",
            typecheck: "TypeScript errors",
            build: "Build failure",
            preview: "Preview unreachable",
            generic: "Check failure",
          };
          await emitEvent(
            taskId,
            "narration",
            `${repairCategoryDisplay[repairCategoryLabel]} found — attempting targeted repair (${repairAttempt}/${maxRepairAttempts})…`,
          );

          const repairPrompt = buildRepairPrompt(
            currentFailedChecks,
            currentChangedPaths,
            repairAttempt,
            repairAttempt > 1 ? currentFailedChecks : [],
          );
          const filesForRepair = await loadFiles(projectId);

          let repairLoopResult: Awaited<ReturnType<typeof runRepairAgentLoop>> | null = null;
          try {
            repairLoopResult = await runRepairAgentLoop({
              mode: "refine",
              projectId,
              projectName: project.name,
              projectKind: project.kind,
              projectFormat: project.projectFormat ?? null,
              stack: project.stack ?? null,
              projectMode: project.projectMode ?? null,
              userPrompt: repairPrompt,
              agentMode,
              conversationHistory: [],
              knowledgeContext: undefined,
              planContext: null,
              existingFiles: filesForRepair,
              containerId: projectHasLiveServer() ? project.containerId : null,
              liveServerAvailable: projectHasLiveServer(),
              policyStrictness:
                (project.policyStrictness as "safe" | "standard" | "permissive" | undefined) ??
                null,
              requireCommandApproval: false,
              onBeforeRiskyOp: async () => {},
              taskId,
              wallClockMs: 3 * 60_000,
              previewUrl: project.containerUrl ?? null,
              e2eEnabled: false,
              onEvent: async (t: string, m: string) => emitEvent(taskId, t, m),
              signal,
            });
          } catch (repairErr) {
            logger.warn(
              { err: repairErr, taskId, projectId, repairAttempt },
              "Repair loop agent call failed (non-fatal)",
            );
          }

          const repairChangedPaths: string[] = [];

          if (repairLoopResult) {
            if (repairLoopResult.changedFiles.length > 0) {
              await writeFiles(projectId, repairLoopResult.changedFiles, false);
              emitFilesChangedEvent(taskId, projectId, repairLoopResult.changedFiles, [], "refine");
              repairChangedPaths.push(...repairLoopResult.changedFiles.map((f) => f.path));
              filesToSmellScan = repairLoopResult.changedFiles;
              for (const f of repairLoopResult.changedFiles) {
                await emitEvent(taskId, "editing_files", `Repairing ${f.path}`, f.path);
              }
            }

            if (!repairLoopResult.checksFailed) {
              repairSucceeded = true;
              await emitEvent(
                taskId,
                "check_result",
                JSON.stringify([
                  {
                    id: `repair-passed-${repairAttempt}`,
                    label: "TypeScript",
                    passed: true,
                  },
                ]),
              );
              await emitEvent(
                taskId,
                "narration",
                `TypeScript errors repaired on attempt ${repairAttempt}.`,
              );
            } else {
              const newFailed = failedChecksEligibleForRepair(
                repairLoopResult.loopReport.checkResults,
              ).map((c) => ({ label: c.label, output: c.message }));
              if (newFailed.length > 0) currentFailedChecks = newFailed;
              currentChangedPaths =
                repairChangedPaths.length > 0 ? repairChangedPaths : currentChangedPaths;
              if (repairAttempt < maxRepairAttempts) {
                await emitEvent(
                  taskId,
                  "narration",
                  `Repair attempt ${repairAttempt} incomplete — retrying…`,
                );
              }
            }
          }

          repairAttemptRecords.push({
            attempt: repairAttempt,
            succeeded: repairSucceeded,
            filesChanged: repairChangedPaths,
          });
        }

        report.repairLoop = {
          attempts: repairAttemptRecords,
          totalAttempts: repairAttemptRecords.length,
          maxAttempts: maxRepairAttempts,
          finalStatus: repairSucceeded ? "passed" : "exhausted",
        };

        if (!repairSucceeded) {
          await emitEvent(
            taskId,
            "check_result",
            JSON.stringify(
              currentFailedChecks.map((c, i) => ({
                id: `repair-exhausted-${i}`,
                label: c.label,
                passed: false,
              })),
            ),
          );
          await emitEvent(
            taskId,
            "narration",
            `Repair attempts exhausted after ${repairAttemptRecords.length} attempt${repairAttemptRecords.length !== 1 ? "s" : ""} — committing with validation errors. User review needed.`,
          );
          versionValidationStatus = "completed_with_errors";
          report.completedWithErrors = true;
          report.warnings = [
            `TypeScript repair loop exhausted after ${repairAttemptRecords.length} attempt${repairAttemptRecords.length !== 1 ? "s" : ""}. Snapshot saved with completed_with_errors status.`,
            ...(report.warnings ?? []),
          ];
        } else {
          report.completedWithErrors = false;
        }
      }
      // ── End Automatic Repair Loop ──────────────────────────────────────────────

      // ── Detect non-required check failures → passed_with_warnings ─────────────
      // When all required checks passed (no correctionFailed, repair loop didn't
      // trigger) but non-required checks failed, the build is "preview-runnable
      // but not clean". Save as passed_with_warnings so the publish gate and UI
      // can surface an honest warning instead of a misleading green.
      if (versionValidationStatus === "passed" && _allAgentCheckResults.length > 0) {
        const stackId = resolveStackId(
          project.kind,
          project.projectFormat ?? null,
          project.stack ?? null,
        );
        const checkProfile = CHECK_PROFILES[stackId];
        if (checkProfile) {
          const deferredChecks = _allAgentCheckResults.filter(isDeferredCheckResult);
          const nonRequiredFailed = _allAgentCheckResults.filter(
            (c) =>
              !c.passed &&
              !isDeferredCheckResult(c) &&
              checkProfile.checks.some((spec) => spec.id === c.id && spec.required === false),
          );
          validationWasPartial = deferredChecks.length > 0;
          if (validationWasPartial || nonRequiredFailed.length > 0) {
            versionValidationStatus = "passed_with_warnings";
            report.warningChecks = [...nonRequiredFailed, ...deferredChecks].map((c) => ({
              id: c.id,
              label: c.label,
              message: (c.message ?? "").slice(0, 500),
            }));
            const validationWarnings = [...(report.warnings ?? [])];
            if (validationWasPartial && !validationWarnings.includes(PARTIAL_VALIDATION_WARNING)) {
              validationWarnings.unshift(PARTIAL_VALIDATION_WARNING);
            }
            if (nonRequiredFailed.length > 0) {
              validationWarnings.unshift(
                `Non-blocking validation checks failed: ${nonRequiredFailed.map((c) => c.label).join(", ")}. Preview is available but the build is not fully clean.`,
              );
            }
            report.warnings = validationWarnings;
          }
        }
      }
      // ── End passed_with_warnings detection ────────────────────────────────────

      // ── Ensure primary artifact kind matches the specialised pipeline ────────
      // Unconditional upsert so refine passes (and any build that skips the
      // stack-detection branch) also keep the artifact record in sync. Non-fatal.
      if (isSpecializedStaticProject) {
        const targetKind = isSlidesProject
          ? "slides"
          : isAnimationProject
            ? "animation"
            : "automation";
        try {
          const { projectArtifactsTable } = await import("@workspace/db");
          await db
            .update(projectArtifactsTable)
            .set({ kind: targetKind })
            .where(
              and(
                eq(projectArtifactsTable.projectId, projectId),
                eq(projectArtifactsTable.isPrimary, true),
                isNull(projectArtifactsTable.deletedAt),
              ),
            );
        } catch (artifactKindErr) {
          logger.warn(
            { err: artifactKindErr, projectId, taskId, targetKind },
            "Failed to sync primary artifact kind for specialised pipeline (non-fatal)",
          );
        }
      }

      // Attach knowledge lessons that influenced this build
      if (knowledgeApplied.length > 0) {
        report.knowledgeApplied = knowledgeApplied;
      }

      // ── Legacy staged-review gate ──────────────────────────────────────────
      // Legacy compatibility: old rows with agentIdentity="task" write to stagingSnapshot
      // instead of committing directly to project_files.
      // Quality gate (TypeScript, ESLint, smoke test), env-var scan, and a
      // blocking architect review all run here before the final status is set.
      if (agentIdentity === "task") {
        const batchMetaStaging = queueBatchId
          ? {
              queueBatchId,
              queueIndex: queueIndex ?? null,
              queueTotalCount: queueTotalCount ?? null,
            }
          : {};

        // Flush token count once — both paths (needs_fix and needs_review) use it.
        const flushedTokenCount = flushTokenCount(taskId);

        // ── 1. Environment variable static analysis (always runs) ─────────────
        try {
          const secretRows = await db
            .select({ name: secretsTable.name })
            .from(secretsTable)
            .where(eq(secretsTable.projectId, projectId));
          const secretNames = secretRows.map((s) => s.name);
          const { scanUndeclaredEnvVars } = await import("./quality-gate");
          const undeclared = scanUndeclaredEnvVars(stagingData, secretNames);
          if (undeclared.length > 0) {
            report.undeclaredEnvVars = undeclared;
          }
        } catch (envScanErr) {
          logger.warn(
            { err: envScanErr, projectId, taskId },
            "Env-var static scan failed (non-fatal)",
          );
        }

        // ── 2. Quality gate — TypeScript, ESLint, smoke test ─────────────────
        // Only for container-based JS/TS stacks where tooling is available.
        let qualityGatePassed = true;
        const isJsTsStack = ["node-api", "nextjs", "react-vite"].includes(project.stack ?? "");
        const isServerStack = ["node-api", "nextjs"].includes(project.stack ?? "");

        if (project.containerId && isJsTsStack) {
          try {
            await emitEvent(taskId, "narration", "Running quality checks (TypeScript, ESLint)…");
            const { runQualityGate, runSmokeTest } = await import("./quality-gate");
            // For build tasks _refineChangedFiles is empty; fall back to
            // stagingData (the full merged set) so ESLint still runs.
            const changedFilesForGate =
              _refineChangedFiles.length > 0 ? _refineChangedFiles : stagingData;
            const gateResult = await runQualityGate(
              project.containerId,
              projectId,
              changedFilesForGate,
              stagingData,
              stagingData, // full content set for pre-flight re-sync if machine restarted
            );

            // Smoke test — only after TypeScript/ESLint pass, server-side stacks only.
            if (gateResult.passed && isServerStack) {
              await emitEvent(taskId, "narration", "Running server startup smoke test…");
              const smokeCheck = await runSmokeTest(project.containerId, projectId);
              gateResult.checks.push(smokeCheck);
              // Re-derive passed/allPassed after adding the smoke check.
              const executedAfterSmoke = gateResult.checks.filter((c) => !c.skipped);
              gateResult.passed =
                executedAfterSmoke.length > 0 && executedAfterSmoke.every((c) => c.passed);
              gateResult.allPassed =
                gateResult.checks.every((c) => !c.skipped) && gateResult.passed;
            }

            report.qualityGate = gateResult;
            // qualityGatePassed tracks actual failures (not skips) — drives needs_fix.
            qualityGatePassed = gateResult.passed;

            if (!qualityGatePassed) {
              const failedLabels = gateResult.checks
                .filter((c) => !c.skipped && !c.passed)
                .map((c) => c.label)
                .join(", ");
              logger.info(
                { projectId, taskId, failedChecks: failedLabels },
                "Quality gate failed — setting task to needs_fix",
              );
            }
          } catch (gateErr) {
            // Infrastructure error (Fly exec, timeout) — log and proceed to review.
            // We never fail a build because of a quality-gate infrastructure failure.
            logger.warn(
              { err: gateErr, projectId, taskId },
              "Quality gate threw — skipping (non-fatal)",
            );
          }
        }

        // ── 3. Architect review — blocking, 60 s cap ──────────────────────────
        // Promotes the review from fire-and-forget to a required step before the
        // task reaches needs_review. Times out at 60 s and proceeds (non-blocking
        // on timeout only — a review that completes but fails still sets the flag).
        if (qualityGatePassed) {
          const totalFilesTouched =
            (diffSummary?.filesAdded.length ?? 0) +
            (diffSummary?.filesModified.length ?? 0) +
            (diffSummary?.filesRemoved.length ?? 0);
          const isDomainRewrite = (userPrompt ?? "").startsWith(DOMAIN_REWRITE_SENTINEL);
          const shouldReview =
            project.architectReviewEnabled !== false && !isDomainRewrite && totalFilesTouched > 0;

          if (shouldReview) {
            try {
              await emitEvent(taskId, "narration", "Running architect review…");
              const reviewDiff = {
                filesAdded: diffSummary?.filesAdded ?? [],
                filesModified: diffSummary?.filesModified ?? [],
                filesRemoved: diffSummary?.filesRemoved ?? [],
              };
              const commandsRun = (report.agentLoop?.commandsRun ?? []).map((c) => ({
                argv: c.argv,
                exitCode: c.exitCode,
              }));
              const ARCHITECT_TIMEOUT_MS = 60_000;
              const reviewResult = await Promise.race([
                (async () => {
                  const { dispatchReviewerStandalone } = await import("./subagent");
                  const dr = await dispatchReviewerStandalone({
                    input: {
                      mode: "refine",
                      projectId,
                      projectName: project.name,
                      projectKind: project.kind,
                      projectFormat: project.projectFormat ?? null,
                      stack: project.stack ?? null,
                      userPrompt,
                      agentMode,
                      planContext: input.planContext ?? null,
                      existingFiles: [],
                      taskId,
                      onEvent: async () => {},
                      signal: new AbortController().signal,
                    },
                    brief: `Architect review for task #${taskId} (staged review)`,
                    reviewer: {
                      diff: reviewDiff,
                      commandsRun,
                      workspaceFiles: filesToSmellScan.map((file) => ({
                        path: file.path,
                        content: file.content,
                      })),
                      assistantSummary,
                      planContext: input.planContext ?? null,
                      knownWarnings: report.warnings,
                    },
                    skipCredits: true,
                  });
                  return dr.review ?? null;
                })(),
                new Promise<null>((_, reject) =>
                  setTimeout(
                    () => reject(new Error("architect-review-timeout")),
                    ARCHITECT_TIMEOUT_MS,
                  ),
                ),
              ]).catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                if (msg === "architect-review-timeout") {
                  logger.warn(
                    { projectId, taskId },
                    "Architect review timed out after 60 s — proceeding to needs_review",
                  );
                  return null;
                }
                // Non-timeout failure: re-throw so the outer catch can mark the task
                // as needs_fix rather than silently skipping the architect step.
                throw err;
              });

              if (reviewResult) {
                report.architectReview = {
                  ...architectToReportShape(reviewResult, {
                    model: reviewResult.model,
                    autoFixQueued: false,
                    autoFixTaskId: null,
                    creditsCharged: 0,
                  }),
                };
                logger.info(
                  {
                    projectId,
                    taskId,
                    verdict: reviewResult.verdict,
                    findings: reviewResult.findings.length,
                  },
                  "Architect review complete (legacy staged review path)",
                );
              }
            } catch (architectErr) {
              // Architect review failed with a non-timeout error. Per contract, only
              // timeouts are non-blocking — any other failure routes the task to
              // needs_fix with an explicit error in the report rather than silently
              // proceeding to needs_review.
              logger.error(
                { err: architectErr, projectId, taskId },
                "Architect review failed (non-timeout) — routing task to needs_fix",
              );
              report.architectReview = {
                verdict: "fail",
                summary: "Architect review encountered an unexpected error. Please retry the task.",
                findings: [
                  {
                    severity: "critical" as const,
                    title: "Architect review error",
                    detail:
                      architectErr instanceof Error ? architectErr.message : String(architectErr),
                    file: null,
                  },
                ],
                nextActions: [],
                autoFixQueued: false,
                autoFixTaskId: null,
                creditsCharged: 0,
                reviewedAt: new Date().toISOString(),
                model: "",
                skipped: false,
              };
              qualityGatePassed = false;
            }
          } else {
            report.architectReview = {
              verdict: "pass",
              summary: isDomainRewrite
                ? "Architect review skipped — domain rewrite."
                : totalFilesTouched === 0
                  ? "Architect review skipped — no file changes."
                  : "Architect review disabled for this project.",
              findings: [],
              nextActions: [],
              autoFixQueued: false,
              autoFixTaskId: null,
              creditsCharged: 0,
              reviewedAt: new Date().toISOString(),
              model: "",
              skipped: true,
              skipReason: isDomainRewrite
                ? "domain-rewrite"
                : totalFilesTouched === 0
                  ? "no-diff"
                  : "disabled",
            };
          }
        }

        // ── 4. Determine overall gate status ──────────────────────────────────
        const hasCriticalFindings = report.architectReview?.findings.some(
          (f) => f.severity === "critical",
        );
        // allChecksPassed drives the green banner — only true when every check
        // actually ran AND passed (no skips, no failures, no critical findings,
        // and no non-required warnings from the agentic path).
        report.allChecksPassed =
          (report.qualityGate?.allPassed ?? false) &&
          !hasCriticalFindings &&
          !(report.warningChecks as unknown[] | undefined)?.length;

        // ── 5a. Quality gate failed → needs_fix ───────────────────────────────
        if (!qualityGatePassed) {
          await db
            .update(agentTasksTable)
            .set({
              status: "needs_fix",
              result: assistantSummary,
              report,
              stagingSnapshot: stagingData,
              completionKind: report.agentLoop?.completionKind ?? "finalized",
              currentStep: report.agentLoop?.steps ?? null,
              completedAt: sql`now()`,
              tokenCount: flushedTokenCount,
            })
            .where(eq(agentTasksTable.id, taskId));

          await emitEvent(
            taskId,
            "completed",
            "Quality checks failed — review the report and use Auto-fix to address the issues.",
          );

          await db.insert(chatMessagesTable).values({
            projectId,
            role: "system",
            content: assistantSummary,
            agentMode,
            planMode: false,
            origin: jobOrigin,
            plan: {
              kind: "report",
              report,
              taskId,
              agentIdentity: "task",
              needsFix: true,
              ...batchMetaStaging,
            } as unknown as Record<string, unknown>,
          });

          void writeKnowledge({
            title: `Staged review quality gate failed: "${userPrompt.slice(0, 60)}"`,
            content: `Staged review completed "${userPrompt.slice(0, 100)}" but quality checks failed. Status set to needs_fix.`,
            type: kind,
            category: kind === "build" ? "build" : "refinement",
            severity: "warning",
            projectId,
            userId: project.ownerId,
            relatedTaskId: taskId,
            tags: ["staged-review", "needs-fix", "quality-gate"],
          });

          void drainNextBatchTask(taskId).catch((err) =>
            logger.warn(
              { err, taskId },
              "Failed to drain next batch task (staged review needs_fix)",
            ),
          );

          return;
        }

        // ── 5b. Lightweight pre-review checks ────────────────────────────────
        // Run server-side checks (JSON syntax, relative imports, E2E spec
        // detection) on the staging snapshot before transitioning to
        // needs_review. Results are stored in report.preReviewChecks and
        // surfaced as a checklist in the staging review card.
        try {
          const { runPreReviewChecks } = await import("./pre-review-checks");
          const existingFiles = await db
            .select({ path: projectFilesTable.path })
            .from(projectFilesTable)
            .where(eq(projectFilesTable.projectId, projectId));
          const existingPaths = new Set(existingFiles.map((f) => f.path));
          // Removed paths must be excluded from the post-staging file set so
          // the import-resolution check doesn't treat deleted modules as resolvable.
          const deletedPaths = new Set(report.filesRemoved ?? []);
          report.preReviewChecks = runPreReviewChecks(stagingData, existingPaths, deletedPaths);
          logger.info(
            {
              projectId,
              taskId,
              allPassed: report.preReviewChecks.allPassed,
              anyFailed: report.preReviewChecks.anyFailed,
            },
            "Pre-review checks complete",
          );
        } catch (prcErr) {
          logger.warn({ err: prcErr, projectId, taskId }, "Pre-review checks threw (non-fatal)");
        }

        // ── 5c. All checks passed → needs_review ─────────────────────────────
        await db
          .update(agentTasksTable)
          .set({
            status: "needs_review",
            result: assistantSummary,
            report,
            stagingSnapshot: stagingData,
            completionKind: report.agentLoop?.completionKind ?? "finalized",
            currentStep: report.agentLoop?.steps ?? null,
            completedAt: sql`now()`,
            tokenCount: flushedTokenCount,
          })
          .where(eq(agentTasksTable.id, taskId));

        await emitEvent(
          taskId,
          "completed",
          `Staged review: ${stagingData.length} file(s) ready - apply or discard.`,
        );

        await db.insert(chatMessagesTable).values({
          projectId,
          role: "system",
          content: assistantSummary,
          agentMode,
          planMode: false,
          origin: jobOrigin,
          plan: {
            kind: "report",
            report,
            taskId,
            agentIdentity: "task",
            needsReview: true,
            ...batchMetaStaging,
          } as unknown as Record<string, unknown>,
        });

        void writeKnowledge({
          title: `Staged review ready: "${userPrompt.slice(0, 60)}"`,
          content: `Staged review completed "${userPrompt.slice(0, 100)}" with ${stagingData.length} file(s) ready for review.`,
          type: kind,
          category: kind === "build" ? "build" : "refinement",
          severity: "info",
          projectId,
          userId: project.ownerId,
          relatedTaskId: taskId,
          tags: ["staged-review", "staged"],
        });

        // Drain batch tasks but keep project queue blocked until apply/discard
        void drainNextBatchTask(taskId).catch((err) =>
          logger.warn({ err, taskId }, "Failed to drain next batch task (staged review)"),
        );

        return;
      }
      // ── End legacy staged-review gate ──────────────────────────────────────

      // ── Auto-fix ESLint warnings after build ──────────────────────────────
      // When project.autoFixWarningsAfterBuild is enabled, run project-wide
      // ESLint auto-fix BEFORE the version snapshot so the snapshot reflects
      // the post-fix state. Non-fatal — any error is logged and skipped.
      if (project.autoFixWarningsAfterBuild) {
        try {
          await emitEvent(taskId, "narration", "Auto-fixing ESLint warnings…");
          const { applyProjectEslintFixes } = await import("./eslint-fix-all");
          const fix = await applyProjectEslintFixes(projectId);
          report.autoFixSummary = {
            filesScanned: fix.filesScanned,
            filesFixed: fix.filesFixed,
            fixedCount: fix.fixedCount,
            remainingCount: fix.remainingCount,
          };
          if (fix.fixedCount > 0) {
            const msg = `Auto-fixed ${fix.fixedCount} ESLint issue${fix.fixedCount === 1 ? "" : "s"} across ${fix.filesFixed} file${fix.filesFixed === 1 ? "" : "s"}.`;
            await emitEvent(taskId, "narration", msg);
            logger.info(
              { projectId, taskId, ...report.autoFixSummary },
              "Post-build auto-fix complete",
            );
          }
        } catch (autoFixErr) {
          logger.warn(
            { err: autoFixErr, projectId, taskId },
            "Post-build auto-fix failed (non-fatal)",
          );
        }
      }
      // ── End auto-fix ESLint warnings after build ──────────────────────────

      // ── Quality gate - direct Main Agent path ──────────────────────────────
      // Mirrors the quality gate that runs in the legacy staged-review path, but
      // is non-blocking here: files are already persisted, so failures surface
      // as warnings rather than routing the task to needs_fix.
      {
        const _isJsTsStack = ["node-api", "nextjs", "react-vite"].includes(project.stack ?? "");
        const _isServerStack = ["node-api", "nextjs"].includes(project.stack ?? "");
        if (project.containerId && _isJsTsStack && filesToSmellScan.length > 0) {
          try {
            await emitEvent(taskId, "narration", "Running quality checks (TypeScript, ESLint)…");
            const { runQualityGate, runSmokeTest } = await import("./quality-gate");
            // Fetch all project files (paths for config detection, content for re-sync pre-flight).
            const allProjectFileRows = await db
              .select({ path: projectFilesTable.path, content: projectFilesTable.content })
              .from(projectFilesTable)
              .where(eq(projectFilesTable.projectId, projectId));
            const gateResult = await runQualityGate(
              project.containerId,
              projectId,
              filesToSmellScan, // changedFiles — used for ESLint batching
              allProjectFileRows, // allFiles — used for config detection (tsconfig, eslintrc)
              allProjectFileRows, // full content for pre-flight re-sync if machine restarted
            );

            if (gateResult.passed && _isServerStack) {
              await emitEvent(taskId, "narration", "Running server startup smoke test…");
              const smokeCheck = await runSmokeTest(project.containerId, projectId);
              gateResult.checks.push(smokeCheck);
              const executedAfterSmoke = gateResult.checks.filter((c) => !c.skipped);
              gateResult.passed =
                executedAfterSmoke.length > 0 && executedAfterSmoke.every((c) => c.passed);
              gateResult.allPassed =
                gateResult.checks.every((c) => !c.skipped) && gateResult.passed;
            }

            report.qualityGate = gateResult;

            if (!gateResult.passed) {
              const failedLabels = gateResult.checks
                .filter((c) => !c.skipped && !c.passed)
                .map((c) => c.label)
                .join(", ");
              report.warnings = [
                ...(report.warnings ?? []),
                `Quality checks flagged issues after build (${failedLabels}). Review the Quality Checks section for details.`,
              ];
              logger.info(
                { projectId, taskId, failedChecks: failedLabels },
                "Quality gate detected issues on direct Main Agent build (non-blocking)",
              );
            }
          } catch (gateErr) {
            logger.warn(
              { err: gateErr, projectId, taskId },
              "Quality gate threw on direct Main Agent path - skipping (non-fatal)",
            );
          }
        }
      }
      // ── End quality gate - direct Main Agent path ──────────────────────────

      await emitEvent(
        taskId,
        "narration",
        "Saving a rollback checkpoint and refreshing the preview.",
      );
      await emitEvent(taskId, "saving_version", "Saving version rollback point…");
      const snapshot = await snapshotFilesForVersion(projectId);

      // Fetch the most recent plan snapshot to annotate this version
      const planSnapshot = await loadLatestPlanSnapshot(projectId);
      const checkpointCompletionKind = report.agentLoop?.completionKind ?? "finalized";
      const checkpointSummary = builderCompletionMessage(
        checkpointCompletionKind,
        assistantSummary,
      );

      // Build changelog entry: combine action context with diff summary
      const changelogLines: string[] = [];
      changelogLines.push(`**${nextVersionLabel}**`);
      if (kind === "build") {
        changelogLines.push(
          `Initial build — ${(report.filesCreated ?? []).length} file(s) generated.`,
        );
      } else if (diffSummary) {
        if (diffSummary.filesAdded.length > 0)
          changelogLines.push(`Added: ${diffSummary.filesAdded.join(", ")}`);
        if (diffSummary.filesModified.length > 0)
          changelogLines.push(`Modified: ${diffSummary.filesModified.join(", ")}`);
        if (diffSummary.filesRemoved.length > 0)
          changelogLines.push(`Removed: ${diffSummary.filesRemoved.join(", ")}`);
      }
      if (checkpointSummary) changelogLines.push(checkpointSummary.slice(0, 180));
      const changelogEntry = changelogLines.join("\n");

      let version: { id: number } | undefined;
      try {
        const inserted = await db
          .insert(projectVersionsTable)
          .values({
            projectId,
            label: (nextVersionLabel ?? "").slice(0, 200) || "Refinement",
            note: checkpointSummary.slice(0, 200),
            changelogEntry: (changelogEntry ?? "").slice(0, 500),
            filesSnapshot: snapshot,
            planSnapshot: planSnapshot ?? undefined,
            validationStatus: versionValidationStatus,
          })
          .returning({ id: projectVersionsTable.id });
        version = inserted[0];
      } catch (snapErr) {
        // Non-fatal: the actual file writes already landed in project_files.
        // Losing the rollback checkpoint should not fail the whole task —
        // otherwise the user sees "task failed" even though their app updated.
        logger.warn(
          { err: snapErr, projectId, taskId },
          "Failed to save project version snapshot (non-fatal — files already persisted)",
        );
        await emitEvent(
          taskId,
          "narration",
          "Couldn't save rollback checkpoint — your changes are still applied.",
        );
      }
      report.versionId = version?.id ?? null;

      // Task #538 — Unified Checkpoints: capture a database snapshot tied to
      // this version (best-effort, non-fatal). Lets users restore code + DB
      // together from one checkpoint.
      if (version) {
        const versionIdForSnapshot = version.id;
        const snapshotLabel = `Checkpoint: ${nextVersionLabel}`;
        setImmediate(() => {
          void (async () => {
            const { captureProjectDbSnapshot } = await import("./db-snapshot-capture");
            await captureProjectDbSnapshot(projectId, versionIdForSnapshot, snapshotLabel);
          })();
        });
      }

      // ── Preview snapshot — ephemeral per-build URL ────────────────────────
      // Create a preview_snapshots row so the build is immediately reachable at
      // {slug}-preview-{taskId}.{PLATFORM_DOMAIN} for 7 days.  Best-effort; a
      // failure here must not fail the task.
      if (version?.id) {
        setImmediate(() => {
          void (async () => {
            try {
              const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN ?? "mustaflow.app";
              const PREVIEW_EXPIRY_DAYS = Number(process.env.PREVIEW_EXPIRY_DAYS ?? "7");
              const [proj] = await db
                .select({ publicSlug: projectsTable.publicSlug, name: projectsTable.name })
                .from(projectsTable)
                .where(eq(projectsTable.id, projectId));
              const baseSlug =
                proj?.publicSlug ??
                (proj?.name ?? `proj-${projectId}`)
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, "-")
                  .replace(/^-+|-+$/g, "")
                  .slice(0, 24) +
                  "-" +
                  Math.random().toString(36).slice(2, 8);
              const previewSlug = `${baseSlug}-preview-${taskId}`;
              const expiresAt = new Date(Date.now() + PREVIEW_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
              await db
                .insert(previewSnapshotsTable)
                .values({
                  projectId,
                  versionId: version.id,
                  taskId,
                  previewSlug,
                  expiresAt,
                })
                .onConflictDoNothing();
              logger.info(
                { projectId, taskId, previewSlug, platform: PLATFORM_DOMAIN },
                "Preview snapshot created",
              );
            } catch (err) {
              logger.warn(
                { err, projectId, taskId },
                "Failed to create preview snapshot (non-fatal)",
              );
            }
          })();
        });
      }

      // ── Emit project_files_changed before preview refresh ──────────────────
      // Always publish to the project-level preview channel so every open tab
      // receives the FS update regardless of whether the AI Builder panel is open.
      // Also attach the structured payload to the task event so reconnecting
      // clients can replay it from the task event history.
      if (filesToSmellScan.length > 0) {
        try {
          const removedPathsForEvent = diffSummary?.filesRemoved ?? [];
          const filesPayload = publishProjectFilesChanged(
            projectId,
            filesToSmellScan.map((f) => ({ path: f.path, content: f.content })),
            removedPathsForEvent,
            "build",
          );
          // Also store the payload on the task event so SSE replay includes it
          await emitEvent(
            taskId,
            "project_files_changed",
            `${filesToSmellScan.length} file(s) updated`,
            undefined,
            filesPayload as unknown as Record<string, unknown>,
          );
        } catch (previewEmitErr) {
          logger.warn(
            { err: previewEmitErr, projectId, taskId },
            "project_files_changed emit failed (non-fatal)",
          );
        }
      }
      // ── End project_files_changed emit ───────────────────────────────────────

      await emitEvent(taskId, "updating_preview", "Refreshing preview…");

      // ── Preview reachability verification ───────────────────────────────────
      // For container-backed projects, first sync the durable DB file set into
      // /app and restart the runtime; only mark previewUpdated after health passes.
      // Static projects serve from the DB and are always reachable.
      if (project.containerId || project.containerUrl) {
        const allRuntimeFileRows = await db
          .select({ path: projectFilesTable.path, content: projectFilesTable.content })
          .from(projectFilesTable)
          .where(eq(projectFilesTable.projectId, projectId));
        const packageManifestChanged = filesToSmellScan.some((file) =>
          isRuntimeManifestPath(file.path),
        );
        const runtimePreviewResult = await syncAgenticPreviewRuntime({
          projectId,
          taskId,
          containerId: project.containerId,
          containerStatus: project.containerStatus,
          containerUrl: project.containerUrl,
          stack: project.stack,
          signal,
          files: allRuntimeFileRows.map((file) => ({
            path: file.path,
            content: file.content,
          })),
          removedPaths: diffSummary?.filesRemoved ?? [],
          packageManifestChanged,
        });

        report.previewUpdated = runtimePreviewResult.previewUpdated;
        report.previewSyncQueued =
          runtimePreviewResult.previewSyncQueued || report.previewSyncQueued === true;
        report.previewSyncFailed =
          runtimePreviewResult.previewSyncFailed || report.previewSyncFailed === true;
        if (runtimePreviewResult.warnings.length > 0) {
          report.warnings = [...(report.warnings ?? []), ...runtimePreviewResult.warnings];
        }
      } else {
        // Static confirmation: writeFiles has durably updated the DB snapshot that
        // backs the iframe; the task-channel "completed" event triggers reload.
        // We intentionally do NOT emit publishPreviewReady here — that would
        // cause a second setBuildRefreshCount call and a double iframe reload.
        report.previewUpdated = true;
        report.previewSyncQueued = true;
      }
      // ── End preview reachability verification ────────────────────────────────

      // ── Synchronous Drizzle migration (before task completion) ─────────────
      // Delegated to runPostWriteMigrationSync — see function definition below
      // applyTaskAgentStaging. Handles container wake, file sync, npm install,
      // and migration execution for any Drizzle files in this build set.
      {
        const migResult = await runPostWriteMigrationSync(projectId, taskId, filesToSmellScan);
        if (migResult.ok && migResult.info) {
          report.warnings = [...(report.warnings ?? []), migResult.info];
        }
        if (!migResult.ok) {
          logger.warn({ projectId, taskId }, "Drizzle migration failed — marking task as failed");
          await emitEvent(taskId, "failed", migResult.error);
          await db
            .update(agentTasksTable)
            .set({
              status: "failed",
              result: migResult.error,
              report: {
                ...report,
                warnings: [...(report.warnings ?? []), migResult.error],
              },
              completedAt: sql`now()`,
              tokenCount: flushTokenCount(taskId),
            })
            .where(eq(agentTasksTable.id, taskId));
          return;
        }
      }
      // ── End synchronous Drizzle migration ─────────────────────────────────

      // ── Architect review subagent (Task #507) ─────────────────────────────
      // Second-opinion deep review of the build/refine: receives user request +
      // plan + diff + commands, returns structured findings.
      //
      // Lifecycle:
      //   normal build/refine → architect → if fail/critical, queue one auto-fix
      //                                     refine task and chain a re-review.
      //   auto-fix task       → architect re-review (no further auto-fix).
      //                         If still failing, mark completedWithWarnings so
      //                         the unresolved findings surface in the UI.
      //
      // Trigger gating:
      //   - Project opt-out (architectReviewEnabled=false) → skipped:"disabled".
      //   - Empty diff → skipped:"no-diff".
      //   - Trivial edit (≤ARCHITECT_LINE_THRESHOLD lines touched, no sensitive
      //     paths) → skipped:"trivial-edit".
      //
      // Credits: flat ARCHITECT_CREDIT_COST per review (best-effort, non-fatal).
      {
        const isArchitectAutoFix = (input.userPrompt ?? "").startsWith(
          "The Architect Reviewer flagged this build",
        );
        const isDomainRewrite = (input.userPrompt ?? "").startsWith(DOMAIN_REWRITE_SENTINEL);
        const totalFilesTouched =
          (diffSummary?.filesAdded.length ?? 0) +
          (diffSummary?.filesModified.length ?? 0) +
          (diffSummary?.filesRemoved.length ?? 0);
        const linesTouched = (diffSummary?.linesAdded ?? 0) + (diffSummary?.linesRemoved ?? 0);
        // Heuristic: anything that materially affects auth, security, env,
        // database schema, secrets, or build manifests deserves a review even
        // on small diffs.
        const SENSITIVE_PATH_PATTERNS = [
          /(^|\/)auth/i,
          /security/i,
          /(^|\/)\.env/i,
          /secrets?/i,
          /schema/i,
          /migration/i,
          /package(-lock)?\.json$/i,
          /pnpm-lock\.yaml$/i,
          /drizzle/i,
          /server/i,
          /api/i,
        ];
        const touchedPathsList = [
          ...(diffSummary?.filesAdded ?? []),
          ...(diffSummary?.filesModified ?? []),
          ...(diffSummary?.filesRemoved ?? []),
        ];
        const touchesSensitive = touchedPathsList.some((p) =>
          SENSITIVE_PATH_PATTERNS.some((re) => re.test(p)),
        );
        const ARCHITECT_LINE_THRESHOLD = 10;
        const isTrivialEdit =
          totalFilesTouched > 0 && !touchesSensitive && linesTouched <= ARCHITECT_LINE_THRESHOLD;

        // Architect auto-fix follow-up tasks MUST always get a re-review,
        // even if the refine produced no diff or a tiny diff. The whole point
        // of the chained task is to re-assess whether the auto-fix actually
        // resolved the originally flagged critical/fail findings.
        let skipReason: string | null = null;
        if (!project.architectReviewEnabled) skipReason = "disabled";
        else if (isDomainRewrite) skipReason = "domain-rewrite";
        else if (!isArchitectAutoFix && totalFilesTouched === 0) skipReason = "no-diff";
        else if (!isArchitectAutoFix && isTrivialEdit) skipReason = "trivial-edit";

        if (skipReason) {
          report.architectReview = {
            verdict: "pass",
            summary:
              skipReason === "disabled"
                ? "Architect review disabled for this project."
                : skipReason === "no-diff"
                  ? "Architect review skipped — no file changes."
                  : `Architect review skipped — trivial edit (${linesTouched} line${linesTouched === 1 ? "" : "s"}, no sensitive paths).`,
            findings: [],
            nextActions: [],
            autoFixQueued: false,
            autoFixTaskId: null,
            creditsCharged: 0,
            reviewedAt: new Date().toISOString(),
            model: "",
            skipped: true,
            skipReason,
          };
        } else {
          try {
            await emitEvent(taskId, "narration", "Running architect review…");
            const reviewDiff = {
              filesAdded: diffSummary?.filesAdded ?? [],
              filesModified: diffSummary?.filesModified ?? [],
              filesRemoved: diffSummary?.filesRemoved ?? [],
            };
            const commandsRun = (report.agentLoop?.commandsRun ?? []).map((c) => ({
              argv: c.argv,
              exitCode: c.exitCode,
            }));
            const { dispatchReviewerStandalone } = await import("./subagent");
            const dispatchResult = await dispatchReviewerStandalone({
              input: {
                mode: "refine",
                projectId,
                projectName: project.name,
                projectKind: project.kind,
                projectFormat: project.projectFormat ?? null,
                stack: project.stack ?? null,
                userPrompt,
                agentMode,
                planContext: input.planContext ?? null,
                existingFiles: [],
                taskId,
                onEvent: async () => {},
                signal: new AbortController().signal,
              },
              brief: `Architect review for task #${taskId}`,
              reviewer: {
                diff: reviewDiff,
                commandsRun,
                workspaceFiles: filesToSmellScan.map((file) => ({
                  path: file.path,
                  content: file.content,
                })),
                assistantSummary,
                planContext: input.planContext ?? null,
                knownWarnings: report.warnings,
              },
              skipCredits: true,
            });
            if (!dispatchResult.review) {
              throw new Error("dispatchReviewerStandalone returned no review");
            }
            const review = dispatchResult.review;

            // Charge credits (best-effort — never block the build).
            let creditsCharged = 0;
            if (project.ownerId) {
              try {
                const debit = await deductCreditsAtomic(project.ownerId, ARCHITECT_CREDIT_COST, {
                  projectId,
                  type: "architect",
                  description: `Architect review for task #${taskId} (verdict: ${review.verdict}, findings: ${review.findings.length})`,
                });
                if (!("insufficient" in debit)) {
                  creditsCharged = ARCHITECT_CREDIT_COST;
                }
              } catch (creditErr) {
                logger.warn(
                  { err: creditErr, projectId, taskId },
                  "Architect credit deduction failed (non-fatal)",
                );
              }
            }

            // Decide auto-fix.
            //   - Normal task with fail/critical verdict → queue ONE auto-fix
            //     refine task. The follow-up task will run architect again
            //     (re-review) but will NOT trigger another auto-fix.
            //   - Auto-fix task with still-failing verdict → no more fixes;
            //     mark completedWithWarnings so the unresolved findings stay
            //     visible to the user.
            let autoFixQueued = false;
            let autoFixTaskId: number | null = null;
            let completedWithWarnings = false;
            const needsFix = shouldTriggerAutoFix(review);
            if (needsFix && !isArchitectAutoFix) {
              const fixPrompt = buildAutoFixPrompt(review);
              const fixTitle =
                `${ARCHITECT_AUTOFIX_TITLE_PREFIX} ${review.findings[0]?.title ?? review.verdict}`.slice(
                  0,
                  180,
                );
              try {
                const autoFixResult = await pool.query<{ id: number }>(
                  `INSERT INTO agent_tasks (project_id, title, kind, status, prompt, origin)
                   VALUES ($1, $2, 'background', 'queued', $3, $4)
                   ON CONFLICT (project_id, title)
                   WHERE kind = 'background' AND status IN ('queued', 'building', 'planning')
                   DO NOTHING
                   RETURNING id`,
                  [projectId, fixTitle, fixPrompt, jobOrigin],
                );
                const followUp = autoFixResult.rows[0];
                if (followUp) {
                  autoFixQueued = true;
                  autoFixTaskId = followUp.id;
                  await db.insert(chatMessagesTable).values({
                    projectId,
                    role: "assistant",
                    content: `Architect review verdict: **${review.verdict}**. ${review.summary} Queued an auto-fix (Task #${followUp.id}) to address the findings; the architect will re-review afterwards.`,
                    agentMode,
                    planMode: false,
                    origin: jobOrigin,
                    plan: {
                      kind: "task-queued",
                      taskId: followUp.id,
                    } as unknown as Record<string, unknown>,
                  });
                  enqueueJob({
                    taskId: followUp.id,
                    projectId,
                    kind: "refine",
                    userPrompt: fixPrompt,
                    agentMode,
                    origin: jobOrigin,
                  });
                }
              } catch (enqueueErr) {
                logger.warn(
                  { err: enqueueErr, projectId, taskId },
                  "Failed to enqueue architect auto-fix (non-fatal)",
                );
              }
            } else if (needsFix && isArchitectAutoFix) {
              // Re-review after auto-fix still failing — surface as warning,
              // do not loop.
              completedWithWarnings = true;
              report.warnings = [
                ...(report.warnings ?? []),
                `Architect re-review after auto-fix still reports "${review.verdict}". Unresolved findings (${review.findings.length}) require your attention.`,
              ];
              await db.insert(chatMessagesTable).values({
                projectId,
                role: "assistant",
                content: `Architect re-review after auto-fix still reports **${review.verdict}**. ${review.summary} Unresolved findings will need your input — no further auto-fix attempts.`,
                agentMode,
                planMode: false,
                origin: jobOrigin,
              });
            }

            report.architectReview = {
              ...architectToReportShape(review, {
                model: review.model,
                autoFixQueued,
                autoFixTaskId,
                creditsCharged,
              }),
              isReReview: isArchitectAutoFix,
              completedWithWarnings,
            };

            logger.info(
              {
                projectId,
                taskId,
                verdict: review.verdict,
                findings: review.findings.length,
                autoFixQueued,
                creditsCharged,
                isReReview: isArchitectAutoFix,
                completedWithWarnings,
              },
              "Architect review complete",
            );
          } catch (architectErr) {
            logger.warn(
              { err: architectErr, projectId, taskId },
              "Architect review threw — proceeding without (non-fatal)",
            );
          }
        }
      }
      // ── End architect review ──────────────────────────────────────────────

      const completionKind = report.agentLoop?.completionKind ?? "finalized";
      const finalStepCount = report.agentLoop?.steps ?? 0;
      const persistedAssistantSummary = builderPersistedCompletionSummary(
        completionKind,
        assistantSummary,
      );
      await db
        .update(agentTasksTable)
        .set({
          result: persistedAssistantSummary,
          report,
          completionKind,
          currentStep: finalStepCount,
          tokenCount: flushTokenCount(taskId),
        })
        .where(
          and(
            eq(agentTasksTable.id, taskId),
            // Guard against cancel race: if cancel already wrote "canceled", don't overwrite it.
            inArray(agentTasksTable.status, ["building", "planning"]),
          ),
        );

      // Fire-and-forget GitHub auto-commit — push all project files to the
      // connected GitHub repo (if any). Non-blocking; failure adds a warn to
      // the task report but never affects the build status.
      {
        const autoCommitProjectId = projectId;
        const autoCommitProjectName = project.name;
        const autoCommitTaskId = taskId;
        const autoCommitReport = report;
        setImmediate(() => {
          void (async () => {
            try {
              const result = await autoCommitProjectFiles(
                autoCommitProjectId,
                autoCommitProjectName,
              );
              if (!result.ok) {
                logger.warn(
                  { projectId: autoCommitProjectId, taskId: autoCommitTaskId },
                  `GitHub auto-commit warning: ${result.message}`,
                );
                db.update(agentTasksTable)
                  .set({
                    report: {
                      ...autoCommitReport,
                      warnings: [...(autoCommitReport.warnings ?? []), result.message],
                    },
                  })
                  .where(eq(agentTasksTable.id, autoCommitTaskId))
                  .catch((err: unknown) =>
                    logger.warn(
                      { err, taskId: autoCommitTaskId },
                      "Failed to persist GitHub auto-commit warning",
                    ),
                  );
              }
            } catch (err) {
              logger.warn(
                { err, projectId: autoCommitProjectId },
                "GitHub auto-commit threw (non-fatal)",
              );
            }
          })();
        });
      }

      // Fire-and-forget code-smell scan runs after the generation result is
      // persisted, so it never delays pipeline completion or the user-facing response.
      if (filesToSmellScan.length > 0) {
        setImmediate(() => {
          try {
            const smells = scanCodeSmells(filesToSmellScan);
            if (smells.length > 0) {
              db.update(agentTasksTable)
                .set({ report: { ...report, codeSmells: smells } })
                .where(eq(agentTasksTable.id, taskId))
                .catch((err: unknown) =>
                  logger.warn(
                    { err, taskId },
                    "Failed to persist code-smell scan results (non-fatal)",
                  ),
                );
            }
          } catch (err) {
            logger.warn({ err, taskId }, "Code-smell scan error (non-fatal)");
          }
        });
      }

      // Fire-and-forget orchestrated checks — secret-leak, code-quality, SAST,
      // accessibility, SEO, performance, CDN security. The AI selects which checks
      // to run based on what changed. Always-on checks (secret-leak, code-quality)
      // always run. Results are persisted to check_runs and merged into the task report.
      // An AuditReport is also derived for backward-compat with the existing Quality tab.
      if (version && filesToSmellScan.length > 0) {
        const versionIdForChecks = version.id;
        const taskIdForChecks = taskId;
        const diffForOrchestrator: {
          filesAdded: string[];
          filesModified: string[];
          filesRemoved: string[];
        } = {
          filesAdded: diffSummary?.filesAdded ?? [],
          filesModified: diffSummary?.filesModified ?? [],
          filesRemoved: diffSummary?.filesRemoved ?? [],
        };
        const summaryForOrchestrator = assistantSummary;
        const kindForOrchestrator = project.kind;

        setImmediate(() => {
          void (async () => {
            try {
              const allProjectFiles = await db
                .select()
                .from(projectFilesTable)
                .where(eq(projectFilesTable.projectId, projectId));
              const checkFiles = allProjectFiles.map((f) => ({
                path: f.path,
                content: f.content,
                mimeType: f.mimeType,
              }));
              const filesToCheck = checkFiles.length > 0 ? checkFiles : filesToSmellScan;

              const { runs, checkSummary } = await runOrchestration(
                filesToCheck,
                diffForOrchestrator,
                summaryForOrchestrator,
                kindForOrchestrator,
                undefined,
                {
                  hounddog: project.scannerHoundDogEnabled === true,
                  trivy: project.scannerTrivyEnabled === true,
                  semgrep: project.scannerSemgrepEnabled !== false,
                },
              );

              // Persist to check_runs table
              let insertedCheckRunIds: number[] = [];
              if (runs.length > 0) {
                const inserted = await db
                  .insert(checkRunsTable)
                  .values(
                    runs.map((r) => ({
                      projectId,
                      taskId: taskIdForChecks,
                      checkName: r.checkName,
                      status: r.status,
                      findings: r.findings,
                      aiReason: r.aiReason,
                    })),
                  )
                  .returning({ id: checkRunsTable.id });
                insertedCheckRunIds = inserted.map((r) => r.id);
              }

              // Persist security findings (non-fatal — runs after check_runs insert)
              void persistSecurityFindings(
                projectId,
                runs.map((r, i) => ({
                  checkType: r.checkName,
                  checkRunId: insertedCheckRunIds[i] ?? null,
                  findings: r.findings,
                })),
              );

              // Summary stats for the task report
              const checkRunsSummary = {
                passed: runs.filter((r) => r.status === "pass").length,
                warnings: runs.filter((r) => r.status === "warning").length,
                failed: runs.filter((r) => r.status === "fail").length,
                skipped: runs.filter((r) => r.status === "skipped").length,
                failedChecks: runs.filter((r) => r.status === "fail").map((r) => r.checkName),
                warnChecks: runs.filter((r) => r.status === "warning").map((r) => r.checkName),
              };

              // Build backward-compat AuditReport from check results
              const AUDIT_CHECK_MAP: Record<
                string,
                "accessibility" | "seo" | "performance" | "security"
              > = {
                accessibility: "accessibility",
                seo: "seo",
                performance: "performance",
                "cdn-security": "security",
              };
              const auditFindings: Array<{
                category: "accessibility" | "seo" | "performance" | "security";
                severity: "error" | "warning" | "info";
                file: string;
                message: string;
                suggestion: string;
              }> = [];
              for (const run of runs) {
                const category = AUDIT_CHECK_MAP[run.checkName];
                if (!category) continue;
                for (const f of run.findings) {
                  auditFindings.push({
                    category,
                    severity: f.severity,
                    file: f.file,
                    message: f.message,
                    suggestion: f.detail ?? f.message,
                  });
                }
              }

              const auditCategories = ["accessibility", "seo", "performance", "security"] as const;
              const CHECKS_PER_CATEGORY = 6;
              const auditScores = auditCategories.map((cat) => {
                const catFindings = auditFindings.filter((f) => f.category === cat);
                const failures = catFindings.filter((f) => f.severity === "error").length;
                const warnings = catFindings.filter((f) => f.severity === "warning").length;
                const penalty = failures * 2 + warnings;
                const pass = Math.max(0, CHECKS_PER_CATEGORY - Math.ceil(catFindings.length));
                const score = Math.max(0, Math.round(100 - (penalty / CHECKS_PER_CATEGORY) * 100));
                const LABELS = {
                  accessibility: "Accessibility",
                  seo: "SEO",
                  performance: "Performance",
                  security: "Security",
                };
                return { category: cat, label: LABELS[cat], pass, warnings, failures, score };
              });

              const htmlFileCount = filesToCheck.filter(
                (f) => f.mimeType === "text/html" || f.path.endsWith(".html"),
              ).length;

              const auditReport = {
                findings: auditFindings,
                scores: auditScores,
                auditedAt: new Date().toISOString(),
                fileCount: htmlFileCount,
              };

              // Persist AuditReport on the version row (backward compat with GET /api/projects/:id/audit)
              await db
                .update(projectVersionsTable)
                .set({ auditReport })
                .where(eq(projectVersionsTable.id, versionIdForChecks));

              // Read latest task report from DB before merging (avoids clobbering concurrent code-smell scan)
              const [latestTask] = await db
                .select({ report: agentTasksTable.report })
                .from(agentTasksTable)
                .where(eq(agentTasksTable.id, taskIdForChecks))
                .limit(1);
              const latestReport = (latestTask?.report ?? report) as TaskReport;
              const updatedReport: TaskReport = {
                ...latestReport,
                auditReport,
                checkSummary,
                checkRunsSummary,
              };
              await db
                .update(agentTasksTable)
                .set({ report: updatedReport })
                .where(eq(agentTasksTable.id, taskIdForChecks));

              logger.info(
                { projectId, taskId: taskIdForChecks, checkCount: runs.length, checkSummary },
                "Orchestrated checks complete",
              );

              // ── Auto-fix on check failure ─────────────────────────────────
              // When project.autoFixOnCheckFailure is enabled and one or more
              // checks failed, automatically enqueue a single background refine
              // task that addresses each failed check.
              // Guard: skip if the triggering task is itself an auto-fix (title
              // starts with "Auto-fix:") to prevent cascading loops.
              const isAutoFixTask = (input.userPrompt ?? "").startsWith("Auto-fix:");
              if (project.autoFixOnCheckFailure && checkRunsSummary.failed > 0 && !isAutoFixTask) {
                try {
                  const failedRuns = runs.filter((r) => r.status === "fail");
                  const fixParts: string[] = [];
                  for (const run of failedRuns) {
                    const checkDef = getCheckByName(run.checkName);
                    if (checkDef?.fixPrompt) {
                      fixParts.push(checkDef.fixPrompt);
                    }
                  }
                  if (fixParts.length > 0) {
                    const checkNames = failedRuns.map((r) => r.checkName).join(", ");
                    const autoFixPrompt = fixParts.join(" Additionally, ");
                    const autoFixTitle = `Auto-fix: ${checkNames}`;

                    const autoFixResult = await pool.query<{ id: number }>(
                      `INSERT INTO agent_tasks (project_id, title, kind, status, prompt, origin)
                       VALUES ($1, $2, 'background', 'queued', $3, $4)
                       ON CONFLICT (project_id, title)
                       WHERE kind = 'background' AND status IN ('queued', 'building', 'planning')
                       DO NOTHING
                       RETURNING id`,
                      [projectId, autoFixTitle, autoFixPrompt, jobOrigin],
                    );

                    if (autoFixResult.rows.length === 0) {
                      logger.info(
                        { projectId, taskId: taskIdForChecks },
                        "Auto-fix on check failure already queued — skipping duplicate enqueue",
                      );
                    } else {
                      const followUpTask = autoFixResult.rows[0];
                      if (followUpTask) {
                        await db.insert(chatMessagesTable).values([
                          {
                            projectId,
                            role: "user",
                            content: autoFixPrompt,
                            agentMode,
                            planMode: false,
                            origin: jobOrigin,
                          },
                          {
                            projectId,
                            role: "assistant",
                            content: `${failedRuns.length} check${failedRuns.length !== 1 ? "s" : ""} failed (${checkNames}). Auto-fix is enabled — I've queued a targeted fix (Task #${followUpTask.id}) that will run in the background and post a report here when complete.`,
                            agentMode,
                            planMode: false,
                            plan: {
                              kind: "task-queued",
                              taskId: followUpTask.id,
                            } as unknown as Record<string, unknown>,
                            origin: jobOrigin,
                          },
                        ]);
                        enqueueJob({
                          taskId: followUpTask.id,
                          projectId,
                          kind: "refine",
                          userPrompt: autoFixPrompt,
                          agentMode,
                          origin: jobOrigin,
                        });
                        logger.info(
                          {
                            projectId,
                            taskId: taskIdForChecks,
                            followUpTaskId: followUpTask.id,
                            checkNames,
                          },
                          "Auto-fix on check failure enqueued",
                        );
                      }
                    }
                  }
                } catch (autoFixErr) {
                  logger.warn(
                    { err: autoFixErr, projectId, taskId: taskIdForChecks },
                    "Auto-fix on check failure enqueue failed (non-fatal)",
                  );
                }
              }
              // ── End auto-fix on check failure ─────────────────────────────
            } catch (err) {
              logger.warn(
                { err, projectId, versionId: versionIdForChecks },
                "Orchestrated checks failed (non-fatal)",
              );
            }
          })();
        });
      }

      // Update project status and persist the latest summary as the project-level description
      await db
        .update(projectsTable)
        .set({
          status: "testing",
          lastTaskSummary: assistantSummary.slice(0, 140),
          summary: assistantSummary,
          updatedAt: sql`now()`,
        })
        .where(eq(projectsTable.id, projectId));

      // Extract the page map BEFORE emitting "completed" so the
      // "page_map_updated" event is guaranteed to precede the terminal event.
      // This eliminates the race where event consumers stop listening on
      // "completed" and never see the subsequent "page_map_updated".
      try {
        await extractPageMap(projectId);
        await emitEvent(taskId, "page_map_updated", "Page map updated.");
      } catch (err) {
        logger.warn({ err, projectId }, "Page map extraction failed (non-fatal)");
      }

      // ── Autonomous Browser QA — runs BEFORE "completed" so qa_step events
      // arrive at the frontend while the EventSource is still open.
      // Eligible stacks: static-html and react-vite.  Skipped for mobile,
      // node-api, python-*, go-*, and any server-side stack.
      const isQaEligible =
        resolvedProjectStack === "static-html" || resolvedProjectStack === "react-vite";

      if (isQaEligible) {
        try {
          const { runHeadlessQA } = await import("./headless-qa");

          const qaOnEvent = async (type: string, message: string): Promise<void> => {
            await emitEvent(taskId, type, message);
          };

          let qaResult: import("./headless-qa").QAResult | null = null;
          let qaTimedOut = false;

          const qaAbortController = new AbortController();
          const qaTimeoutHandle = setTimeout(() => qaAbortController.abort(), 60_000);

          try {
            qaResult = await Promise.race([
              runHeadlessQA(snapshot, qaOnEvent, qaAbortController.signal),
              new Promise<never>((_, reject) =>
                qaAbortController.signal.addEventListener("abort", () =>
                  reject(new Error("QA_TIMEOUT")),
                ),
              ),
            ]);
          } catch (raceErr) {
            if ((raceErr as Error).message === "QA_TIMEOUT") {
              qaTimedOut = true;
              await emitEvent(taskId, "qa_timeout", "Self-test timed out.");
              // Persist timeout outcome so Checks tab and activity feed are consistent.
              const timeoutEntry = {
                passed: false,
                errors: [] as string[],
                stepsRun: 0,
                timedOut: true,
                ranAt: new Date().toISOString(),
              };
              void db
                .update(agentTasksTable)
                .set({ report: { ...report, qaResult: timeoutEntry } })
                .where(eq(agentTasksTable.id, taskId))
                .catch((err: unknown) =>
                  logger.warn({ err, taskId }, "Failed to patch task report with qa timeout"),
                );
              void db
                .insert(projectActivityTable)
                .values({
                  projectId,
                  eventType: "qa_completed",
                  summary: "Self-test timed out",
                  metadata: {
                    passed: false,
                    errors: [],
                    stepsRun: 0,
                    timedOut: true,
                    taskId,
                    ranAt: timeoutEntry.ranAt,
                  },
                })
                .catch((err: unknown) =>
                  logger.warn(
                    { err, projectId, taskId },
                    "Failed to write qa_completed (timeout) activity",
                  ),
                );
            } else {
              throw raceErr;
            }
          } finally {
            clearTimeout(qaTimeoutHandle);
          }

          if (!qaTimedOut && qaResult) {
            // Auto-fix on failure — one retry cap
            if (!qaResult.passed && qaResult.errors.length > 0) {
              await emitEvent(
                taskId,
                "qa_step",
                `Error detected — auto-fixing ${qaResult.errors.length} issue(s)…`,
              );
              const currentFiles = await loadFiles(projectId);
              const fixPrompt = [
                "Fix the following JavaScript errors detected by the headless browser QA pass:",
                ...qaResult.errors.map((e, i) => `${i + 1}. ${e}`),
              ].join("\n");
              try {
                const fixResult = await runRefinePipeline({
                  projectName: project.name ?? "app",
                  projectKind: project.kind ?? "web",
                  userPrompt: fixPrompt,
                  agentMode,
                  existingFiles: currentFiles,
                  onEvent: qaOnEvent,
                });
                if (fixResult && fixResult.changedFiles.length > 0) {
                  await writeFiles(projectId, fixResult.changedFiles, false);
                  emitFilesChangedEvent(
                    taskId,
                    projectId,
                    fixResult.changedFiles,
                    fixResult.removedPaths,
                    "refine",
                  );
                  if (fixResult.removedPaths.length > 0) {
                    await deleteFiles(projectId, fixResult.removedPaths);
                  }
                  const reloadedFiles = await snapshotFilesForVersion(projectId);
                  const retryResult = await runHeadlessQA(reloadedFiles, qaOnEvent);
                  qaResult = retryResult;
                }
              } catch (fixErr) {
                logger.warn({ err: fixErr, projectId, taskId }, "QA auto-fix failed (non-fatal)");
              }
            }

            const fixedCount = qaResult.errors.length;
            const qaDoneMsg = qaResult.passed
              ? `All tests passed (${qaResult.stepsRun} steps)`
              : fixedCount === 0
                ? "No issues found"
                : `${fixedCount} issue(s) remain after auto-fix`;
            await emitEvent(taskId, "qa_done", qaDoneMsg);

            const qaResultEntry = {
              passed: qaResult.passed,
              errors: qaResult.errors,
              stepsRun: qaResult.stepsRun,
              timedOut: false,
              ranAt: new Date().toISOString(),
            };

            // Patch the task report with qaResult so the Checks tab can read it.
            void db
              .update(agentTasksTable)
              .set({ report: { ...report, qaResult: qaResultEntry } })
              .where(eq(agentTasksTable.id, taskId))
              .catch((err: unknown) =>
                logger.warn({ err, taskId }, "Failed to patch task report with qaResult"),
              );

            void db
              .insert(projectActivityTable)
              .values({
                projectId,
                eventType: "qa_completed",
                summary: qaDoneMsg,
                metadata: {
                  passed: qaResult.passed,
                  errors: qaResult.errors,
                  stepsRun: qaResult.stepsRun,
                  taskId,
                  ranAt: qaResultEntry.ranAt,
                },
              })
              .catch((err: unknown) =>
                logger.warn({ err, projectId, taskId }, "Failed to write qa_completed activity"),
              );
          }
        } catch (qaErr) {
          logger.warn({ err: qaErr, projectId, taskId }, "Browser QA pass failed (non-fatal)");
        }
      }
      // ── End Browser QA ─────────────────────────────────────────────────────

      const finalizedCompletionMessage =
        versionValidationStatus === "completed_with_errors"
          ? "Build complete — TypeScript repair exhausted. Preview may have issues. Review the report for details."
          : validationWasPartial
            ? "Build completed with partial validation — live-server infrastructure was unavailable, so container-dependent checks were deferred."
            : versionValidationStatus === "passed_with_warnings"
              ? "Build completed with warnings — preview is available but validation is not fully clean."
              : "Task completed.";
      const completionMessage = builderCompletionMessage(
        completionKind,
        finalizedCompletionMessage,
      );
      const taskCompleted = await finalizeAgentTaskWithEvent({
        taskId,
        completionKind,
        currentStep: finalStepCount,
        message: completionMessage,
      });
      if (!taskCompleted) {
        logger.info(
          { taskId, projectId },
          "Skipped terminal completion event because task was no longer active",
        );
        return;
      }

      // Notify project owner of build completion (fire-and-forget)
      if (project.ownerId) {
        void db
          .insert(notificationsTable)
          .values({
            recipientId: project.ownerId,
            type: "build_complete",
            title:
              completionKind === "finalized"
                ? `${kind === "build" ? "Build" : "Refine"} completed`
                : builderCompletionMessage(completionKind, "Task completed."),
            body:
              completionKind === "finalized"
                ? `Your ${agentMode} ${kind} on "${project.name}" finished successfully.`
                : `${project.name}: ${completionMessage}`,
            actorId: project.ownerId,
            resourceType: "build",
            resourceId: String(taskId),
            projectId,
            metadata: { taskId, agentMode, durationMs: Date.now() - jobStartTime },
          })
          .catch((err) =>
            logger.warn({ err, taskId }, "Failed to insert build_complete notification"),
          );
      }

      // Drain batch tasks, then any orphaned project-level queued tasks
      void drainNextBatchTask(taskId).catch((err) =>
        logger.warn({ err, taskId }, "Failed to drain next batch task"),
      );
      void drainNextProjectTask(projectId).catch((err) =>
        logger.warn({ err, projectId }, "Failed to drain next project task"),
      );

      // Generate post-build suggestions in the background (non-blocking)
      setImmediate(() => {
        void generatePostBuildSuggestions(
          projectId,
          taskId,
          project.name,
          project.kind,
          project.projectFormat ?? "static-html",
          userPrompt,
          assistantSummary,
          snapshot.map((f) => f.path),
          knowledgeContext ?? "",
        ).catch((err) => logger.warn({ err, taskId }, "Background suggestion generation failed"));
      });

      // Browser QA now runs BEFORE the "completed" event (see above).
      // The old background runAppTestingJob call has been replaced by the
      // in-process headless-qa pass so QA steps appear in the live EventSource.

      // --- Deduct credits after a successful AI build/refine ---
      // Skip when credits were reserved upfront (background jobs — Task #509).
      if (project.ownerId && !creditsAlreadyReserved) {
        void deductCreditsAtomic(project.ownerId, creditCost, {
          type: kind,
          description: `${kind === "build" ? "Build" : "Refine"} (${agentMode}) — project ${projectId}`,
          projectId,
        })
          .then((result) => {
            if ("insufficient" in result) {
              logger.warn(
                { projectId, taskId, creditCost, agentMode },
                "Post-build credit deduction: insufficient balance — build was already delivered",
              );
              void emitEvent(
                taskId,
                "credit_insufficient",
                `Insufficient credits to charge for this ${kind} — balance ${result.balance} < ${creditCost}`,
              );
            }
          })
          .catch((err) => logger.warn({ err }, "Credit deduction failed (non-fatal)"));
      }

      // --- Task #529: web sense credits are now charged in-loop ---
      // See `onBillableSenseBatch` passed to runAgentLoop above. Each completed
      // batch of 5 (web_fetch + web_search + extract_branding) deducts 1 credit
      // at use time so usage is billed even on cancel/failure paths.

      // Fire-and-forget: escalate any recurring warnings, then write a success knowledge entry
      void maybeEscalateWarnings(projectId, report.warnings ?? []);
      const nativeFeaturesNote =
        report.nativeFeatures && report.nativeFeatures.length > 0
          ? ` Native features used: ${report.nativeFeatures.join(", ")} — these require a real device and cannot be previewed in the web iframe.`
          : "";

      // If Moment.js was detected in this build, write a Knowledge Vault lesson so future
      // builds actively avoid it and use Luxon or date-fns instead.
      const hasMomentNotice = (report.securityNotices ?? []).some((n) =>
        n.packageName.toLowerCase().includes("moment"),
      );
      if (hasMomentNotice) {
        void writeKnowledge({
          title: "Avoid Moment.js — use Luxon or date-fns instead",
          content:
            "Moment.js is End of Life and will not receive security fixes. For all date formatting and manipulation in generated apps, use native JavaScript (Intl.DateTimeFormat, Date methods) where possible. When a CDN library is needed, prefer Luxon (https://cdn.jsdelivr.net/npm/luxon@3/build/global/luxon.min.js) or date-fns (https://cdn.jsdelivr.net/npm/date-fns@3/cdn.min.js). Never load moment from any CDN.",
          type: kind,
          category: "lesson",
          severity: "warning",
          projectId,
          userId: project.ownerId,
          relatedTaskId: taskId,
          relatedVersionId: version?.id,
          tags: ["moment", "date", "security", "eol", "luxon", "date-fns"],
          approvedForReuse: true,
        });
        logger.info({ projectId, taskId }, "Moment.js detected — wrote Knowledge Vault lesson");
      }
      void writeKnowledge({
        title: `${kind === "build" ? "Build" : "Refinement"} completed: "${userPrompt.slice(0, 60)}"`,
        content: `${assistantSummary.slice(0, 400)} — Files created: ${report.filesCreated.length}, changed: ${report.filesChanged.length}, removed: ${report.filesRemoved.length}. Warnings: ${report.warnings?.length ?? 0}.${nativeFeaturesNote}`,
        type: kind,
        category: kind === "build" ? "build" : "refinement",
        severity: (report.warnings?.length ?? 0) > 0 ? "warning" : "info",
        projectId,
        userId: project.ownerId,
        relatedTaskId: taskId,
        relatedVersionId: version?.id,
        tags: [
          ...(report.integrationsNeeded?.map((i) => i.name) ?? []),
          ...(report.nativeFeatures ?? []),
        ],
        diffSummary,
      });

      // Mobile-specific: write Knowledge Vault entries capturing which modules were wired
      if (isMobileProject && report.modulesWired && report.modulesWired.length > 0) {
        const moduleNames = report.modulesWired.map((m) => m.name).join(", ");
        const secretsConsumed = [...new Set(report.modulesWired.flatMap((m) => m.secretsConsumed))];
        void writeKnowledge({
          title: `Mobile modules wired: ${moduleNames.slice(0, 60)}`,
          content: `${kind === "build" ? "Build" : "Refine"} for "${userPrompt.slice(0, 80)}" wired ${report.modulesWired.length} power module(s): ${moduleNames}. Secrets consumed: ${secretsConsumed.length > 0 ? secretsConsumed.join(", ") : "none"}. Warnings: ${report.warnings?.length ?? 0}.`,
          type: kind,
          category: "mobile_module",
          severity: "info",
          projectId,
          userId: project.ownerId,
          relatedTaskId: taskId,
          relatedVersionId: version?.id,
          tags: [...report.modulesWired.map((m) => m.id), "mobile", "expo"],
        });
      }

      // Auto-refresh style memory after every successful build/refine (debounced).
      // Fire-and-forget — never block the success path on style inference.
      if (project.ownerId && process.env.KNOWLEDGE_RETRIEVAL_ENABLED !== "false") {
        void (async () => {
          try {
            const recentStyle = await db
              .select({ createdAt: knowledgeEntriesTable.createdAt })
              .from(knowledgeEntriesTable)
              .where(
                and(
                  eq(knowledgeEntriesTable.userId, project.ownerId!),
                  eq(knowledgeEntriesTable.type, "style_memory"),
                  isNull(knowledgeEntriesTable.archivedAt),
                ),
              )
              .orderBy(desc(knowledgeEntriesTable.createdAt))
              .limit(1);
            const lastRefresh = recentStyle[0]?.createdAt;
            if (lastRefresh && Date.now() - new Date(lastRefresh).getTime() < 5 * 60 * 1000) {
              return;
            }
            await inferStyleForUser(project.ownerId!);
          } catch (err) {
            logger.warn({ err }, "Auto style refresh failed — non-fatal");
          }
        })();
      }

      // Append a system message so the chat shows the report was produced
      const batchMeta = queueBatchId
        ? { queueBatchId, queueIndex: queueIndex ?? null, queueTotalCount: queueTotalCount ?? null }
        : {};
      await db.insert(chatMessagesTable).values({
        projectId,
        role: "system",
        content: persistedAssistantSummary,
        agentMode,
        planMode: false,
        origin: jobOrigin,
        plan: { kind: "report", report, taskId, ...batchMeta } as unknown as Record<
          string,
          unknown
        >,
        // Task #538 — anchor this system summary to the new checkpoint so the
        // chat UI can offer "Rewind to here" (restores files + db + truncates chat).
        checkpointId: version?.id ?? null,
      });

      // Also link the *triggering* user message (the prompt that produced this
      // checkpoint) so the unified Checkpoints timeline can render "what prompt
      // produced this state" alongside each checkpoint. We pick the most recent
      // user-role message in this project that doesn't already have a checkpoint
      // anchor — that is, the prompt the user just sent.
      if (version?.id) {
        try {
          await db
            .update(chatMessagesTable)
            .set({ checkpointId: version.id })
            .where(
              sql`id = (
                SELECT id FROM chat_messages
                WHERE project_id = ${projectId}
                  AND role = 'user'
                  AND checkpoint_id IS NULL
                  AND (
                    (${jobOrigin}::text IS NULL AND origin IS NULL)
                    OR origin = ${jobOrigin}
                  )
                ORDER BY created_at DESC
                LIMIT 1
              )`,
            );
        } catch (err) {
          logger.warn(
            { err, projectId, versionId: version.id },
            "Failed to link triggering message to checkpoint",
          );
        }
      }

      // If Moment.js was detected in an initial build, automatically enqueue a follow-up refine
      // that swaps it for Luxon. Only fires on builds (not on refines) to avoid infinite loops.
      // This runs as a fire-and-forget background job — failures never affect the build result.
      if (kind === "build" && hasMomentNotice) {
        void (async () => {
          try {
            const MOMENT_REPLACE_PROMPT =
              "Replace Moment.js with Luxon — remove the Moment.js CDN script tag and rewrite all moment(...) calls using Luxon's DateTime API.";

            // Idempotency guard backed by a DB-enforced partial unique index:
            //   agent_tasks_active_background_title_idx ON agent_tasks(project_id, title)
            //   WHERE kind = 'background' AND status IN ('queued','building','planning')
            // ON CONFLICT DO NOTHING is race-safe — if two concurrent builds both attempt
            // to insert, the second will silently skip rather than creating a duplicate.
            // Once a previous auto-fix resolves (status → done/failed/canceled), the row
            // falls outside the partial index and a new auto-fix can be enqueued.
            const autoFixResult = await pool.query<{ id: number }>(
              `INSERT INTO agent_tasks (project_id, title, kind, status, prompt, origin)
               VALUES ($1, $2, 'background', 'queued', $3, $4)
               ON CONFLICT (project_id, title)
               WHERE kind = 'background' AND status IN ('queued', 'building', 'planning')
               DO NOTHING
               RETURNING id`,
              [
                projectId,
                "Auto-fix: Replace Moment.js with Luxon",
                MOMENT_REPLACE_PROMPT,
                jobOrigin,
              ],
            );
            if (autoFixResult.rows.length === 0) {
              logger.info(
                { projectId, taskId },
                "Moment.js auto-fix already queued — skipping duplicate enqueue",
              );
              return;
            }
            const followUpTask = autoFixResult.rows[0];
            if (!followUpTask) {
              logger.warn(
                { projectId, taskId },
                "Moment.js auto-fix: failed to insert follow-up task row",
              );
              return;
            }
            await db.insert(chatMessagesTable).values([
              {
                projectId,
                role: "user",
                content: MOMENT_REPLACE_PROMPT,
                agentMode,
                planMode: false,
                origin: jobOrigin,
              },
              {
                projectId,
                role: "assistant",
                content: `Moment.js was detected in this build. I've queued an automatic follow-up to replace it with Luxon (Task #${followUpTask.id}). The refine will run in the background and post a report here when complete.`,
                agentMode,
                planMode: false,
                origin: jobOrigin,
                plan: {
                  kind: "task-queued",
                  taskId: followUpTask.id,
                } as unknown as Record<string, unknown>,
              },
            ]);
            enqueueJob({
              taskId: followUpTask.id,
              projectId,
              kind: "refine",
              userPrompt: MOMENT_REPLACE_PROMPT,
              agentMode,
              origin: jobOrigin,
            });
            logger.info(
              { projectId, taskId, followUpTaskId: followUpTask.id },
              "Moment.js auto-fix refine enqueued",
            );
          } catch (err) {
            logger.warn(
              { err, projectId, taskId },
              "Moment.js auto-fix enqueue failed (non-fatal)",
            );
          }
        })();
      }

      void db
        .insert(buildAnalyticsTable)
        .values({
          taskId,
          projectId,
          userId: project.ownerId ?? null,
          model: MODEL_FOR_MODE[agentMode],
          agentMode,
          kind,
          durationMs: Date.now() - jobStartTime,
          correctionPasses: analyticsCorrectionPasses,
          escalated: wasEscalated,
          outcome: "success" as const,
          primaryErrorCategory: analyticsErrorCategory,
        })
        .catch((err) =>
          logger.warn({ err, taskId }, "Failed to record build analytics (non-fatal)"),
        );
    } catch (err) {
      // Handle user-initiated cancellation separately — mark as canceled, don't emit "failed"
      if (
        err instanceof Error &&
        (err.message === "Build cancelled" || abortController.signal.aborted)
      ) {
        await emitEvent(taskId, "cancelled", "Build cancelled by user.");
        // Flush the token counter before entering the transaction so we can
        // persist the partial count even for mid-run cancellations.
        const canceledTokenCount = flushTokenCount(taskId);
        // Atomically transition to canceled and clear reserved credits, capturing
        // the prior reserved amount so we can refund exactly once (Task #509).
        const cancelTx = await db.transaction(async (tx) => {
          const [pre] = await tx
            .select({ creditsReserved: agentTasksTable.creditsReserved })
            .from(agentTasksTable)
            .where(eq(agentTasksTable.id, taskId))
            .limit(1);
          await tx
            .update(agentTasksTable)
            .set({
              status: "canceled",
              completedAt: sql`now()`,
              creditsReserved: null,
              tokenCount: canceledTokenCount,
            })
            .where(eq(agentTasksTable.id, taskId));
          return { reserved: pre?.creditsReserved ?? 0 };
        });
        if (cancelTx.reserved > 0 && project.ownerId) {
          void refundCredits(project.ownerId, cancelTx.reserved, {
            projectId,
            description: `Background task #${taskId} canceled mid-run`,
          }).catch((err) =>
            logger.warn({ err, taskId }, "Credit refund failed on abort (non-fatal)"),
          );
        }
        // Drain queued tasks so the project queue isn't stalled behind this cancelled build.
        void drainNextProjectTask(projectId).catch((err) =>
          logger.warn({ err, projectId, taskId }, "Failed to drain project task after cancel"),
        );
        void drainNextBatchTask(taskId).catch((err) =>
          logger.warn({ err, taskId }, "Failed to drain batch task after cancel"),
        );
        return;
      }
      logger.error({ err, taskId, projectId }, "Builder job failed");
      const message = err instanceof Error ? err.message : "Unknown builder error";
      await emitEvent(taskId, "failed", message);

      // Notify project owner of build failure (fire-and-forget)
      if (project?.ownerId) {
        void db
          .insert(notificationsTable)
          .values({
            recipientId: project.ownerId,
            type: "build_failed",
            title: `${kind === "build" ? "Build" : "Refine"} failed`,
            body: message.slice(0, 200),
            actorId: project.ownerId,
            resourceType: "build",
            resourceId: String(taskId),
            projectId,
            metadata: { taskId, reason: message.slice(0, 500) },
          })
          .catch((notifErr) =>
            logger.warn({ err: notifErr, taskId }, "Failed to insert build_failed notification"),
          );
      }

      // Generate specific fix suggestions via AI (parallel with DB writes)
      const finalTokenCount = flushTokenCount(taskId);
      const [suggestions] = await Promise.all([
        generateFixSuggestions(userPrompt, message),
        db
          .update(agentTasksTable)
          .set({
            status: "failed",
            result: message,
            completedAt: sql`now()`,
            tokenCount: finalTokenCount,
          })
          .where(eq(agentTasksTable.id, taskId)),
        db
          .update(projectsTable)
          .set({ status: "failed", updatedAt: sql`now()` })
          .where(eq(projectsTable.id, projectId)),
      ]);

      // Store fix suggestions on the task record
      await db
        .update(agentTasksTable)
        .set({
          report: {
            userRequest: userPrompt,
            filesCreated: [],
            filesChanged: [],
            filesRemoved: [],
            previewUpdated: false,
            warnings: [],
            suggestions,
            integrationsNeeded: [],
          },
        })
        .where(eq(agentTasksTable.id, taskId));

      // Record build analytics for the failed job (best-effort, non-fatal)
      void db
        .insert(buildAnalyticsTable)
        .values({
          taskId,
          projectId,
          userId: project?.ownerId ?? null,
          model: MODEL_FOR_MODE[agentMode],
          agentMode,
          kind,
          durationMs: Date.now() - jobStartTime,
          correctionPasses: analyticsCorrectionPasses,
          escalated: wasEscalated,
          outcome: "failed",
          primaryErrorCategory: analyticsErrorCategory,
        })
        .catch((analyticsErr) =>
          logger.warn({ analyticsErr, taskId }, "Failed to record failed build analytics"),
        );

      // Fire-and-forget build failure email to the project owner
      if (project.ownerId) {
        void (async () => {
          try {
            const clerkUser = await getClerkUserById(project.ownerId!);
            if (clerkUser?.email) {
              const domain = process.env.PLATFORM_DOMAIN ?? "mustaflow.app";
              await sendBuildFailureEmail({
                to: clerkUser.email,
                projectName: project.name,
                agentMode,
                reason: message,
                projectUrl: `https://${domain}/projects/${projectId}`,
              });
            }
          } catch (emailErr) {
            logger.warn({ emailErr, taskId, projectId }, "Build failure email failed (non-fatal)");
          }
        })();
      }

      // Auto-write a diagnostic lesson to the Knowledge Vault
      void autoWriteFailureLesson(userPrompt, message, projectId, project.ownerId);

      // Cancel remaining queued tasks in the same batch
      void cancelRemainingBatchTasks(taskId).catch((err) =>
        logger.warn({ err, taskId }, "Failed to cancel remaining batch tasks"),
      );

      // Generate post-build suggestions even on failure — gives the user recovery ideas
      setImmediate(() => {
        void generatePostBuildSuggestions(
          projectId,
          taskId,
          project.name,
          project.kind,
          project.projectFormat ?? "static-html",
          userPrompt,
          `Build failed: ${message.slice(0, 200)}`,
          [],
          "",
        ).catch((err) => logger.warn({ err, taskId }, "Failure-path suggestion generation failed"));
      });

      // Post a rich error message with suggestions into the chat
      try {
        const errBatchMeta = queueBatchId
          ? {
              queueBatchId,
              queueIndex: queueIndex ?? null,
              queueTotalCount: queueTotalCount ?? null,
            }
          : {};
        await db.insert(chatMessagesTable).values({
          projectId,
          role: "assistant",
          content: `Build failed: ${message}`,
          agentMode,
          planMode: false,
          origin: jobOrigin,
          plan: { kind: "error", message, suggestions, ...errBatchMeta } as unknown as Record<
            string,
            unknown
          >,
        });
      } catch {
        // best-effort
      }
    }
  } finally {
    // Stop the job-level heartbeat timer.
    if (jobHeartbeatTimer) {
      clearInterval(jobHeartbeatTimer);
    }
    // Stop the keepalive loop and restore autostop on the machine so it can
    // idle-stop normally once the task is done.
    stopContainerKeepalive?.();
    if (keepaliveMachineId) {
      logger.info(
        { taskId, projectId, machineId: keepaliveMachineId },
        "Task complete: restoring autostop + setting min_machines_running=0",
      );
      try {
        const { patchMachineAutostop } = await import("./container");
        await patchMachineAutostop(keepaliveMachineId, projectId, "stop");
      } catch (restoreErr) {
        logger.warn(
          { restoreErr, taskId, projectId, machineId: keepaliveMachineId },
          "Autostop restore failed — machine may remain always-on; manual fix needed",
        );
      }
    }

    // Always release the advisory lock and pool client, and clear the in-memory guard.
    if (lockAcquired) {
      try {
        await lockClient.query("SELECT pg_advisory_unlock($1::bigint)", [projectId]);
      } catch (unlockErr) {
        logger.warn({ unlockErr, projectId }, "Failed to release advisory lock (non-fatal)");
      }
    }
    lockClient.release();
    activeProjectJobs.delete(projectId);
    activeJobControllers.delete(taskId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy staged review: Apply & Discard staging snapshots
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply a staged-review snapshot to the live project files.
 * Called by POST /projects/:id/tasks/:taskId/apply.
 * Fires all post-build hooks: version save, quality audit, knowledge vault,
 * suggestion generation, credit deduction.
 */
/**
 * After project files have been written (either by direct execution or by staged
 * review apply), sync them to the project's container and run any pending Drizzle
 * migrations.
 *
 * Emits task-event narrations so the user sees live progress.  Returns:
 *   { ok: true }          — no Drizzle files in the set, nothing to do.
 *   { ok: true, info }    — non-fatal skip (e.g. no container provisioned yet).
 *   { ok: false, error }  — migration command failed; callers decide severity.
 *
 * Called from:
 *   1. The direct build/refine execution path (fatal on failure — task → "failed").
 *   2. applyTaskAgentStaging (non-fatal — failure surfaced as a report warning).
 */
async function runPostWriteMigrationSync(
  projectId: number,
  taskId: number,
  files: Array<{ path: string; content: string; mimeType?: string }>,
): Promise<{ ok: true; info?: string } | { ok: false; error: string }> {
  const drizzleFiles = files.filter(
    (f) =>
      f.path.startsWith("drizzle/") ||
      f.path === "drizzle.config.ts" ||
      f.path === "drizzle.config.js" ||
      f.path === "drizzle.config.mjs" ||
      f.path === "drizzle.config.cjs",
  );

  if (drizzleFiles.length === 0) return { ok: true };

  const [containerRow] = await db
    .select({
      containerId: projectsTable.containerId,
      containerStatus: projectsTable.containerStatus,
    })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));

  if (!containerRow?.containerId) {
    const info =
      "Drizzle schema files were generated but no container is running. Start a container from the Terminal tab to apply database migrations.";
    logger.warn({ projectId, taskId }, info);
    return { ok: true, info };
  }

  const activeContainerId = containerRow.containerId;
  const {
    syncFilesToContainer,
    execInContainer,
    startContainer,
    getContainerStatus,
    mapFlyErrorToMessage,
    npmInstallInBackground,
  } = await import("./container");

  if (containerRow.containerStatus !== "running") {
    await emitEvent(taskId, "narration", "Waking container for database migrations…");
    await startContainer(activeContainerId, projectId);
    const wakeDeadline = Date.now() + 30_000;
    while (Date.now() < wakeDeadline) {
      const liveStatus = await getContainerStatus(activeContainerId);
      if (liveStatus === "running") break;
      await new Promise<void>((r) => setTimeout(r, 2000));
    }
  }

  const allCurrentFiles = await db
    .select({ path: projectFilesTable.path, content: projectFilesTable.content })
    .from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, projectId));

  try {
    await emitEvent(taskId, "narration", "Syncing files to container for migration…");
    await syncFilesToContainer(activeContainerId, projectId, allCurrentFiles);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const humanMsg = mapFlyErrorToMessage(errMsg);
    logger.warn({ err, projectId, taskId }, "Container sync failed in migration pre-step");
    return { ok: false, error: `Container sync failed: ${humanMsg}` };
  }

  const hasPackageJson = allCurrentFiles.some((f) => f.path === "package.json");
  if (hasPackageJson) {
    await emitEvent(taskId, "narration", "Running npm install before migration…");
    const installResult = await npmInstallInBackground(activeContainerId, projectId, {
      wallClockCapMs: 6 * 60 * 1000,
      onMachineRestarted: async () => {
        await syncFilesToContainer(activeContainerId, projectId, allCurrentFiles);
      },
    });
    if (!installResult.ok) {
      return {
        ok: false,
        error: `npm install before migration failed: ${installResult.output.slice(0, 500)}`,
      };
    }
  }

  let migrationCmd: string[];
  try {
    const pkgFile = allCurrentFiles.find((f) => f.path === "package.json");
    const pkgJson = pkgFile
      ? (JSON.parse(pkgFile.content) as { scripts?: Record<string, string> })
      : null;
    migrationCmd =
      pkgJson?.scripts?.["db:push"] != null
        ? ["npm", "run", "db:push"]
        : ["npx", "drizzle-kit", "migrate"];
  } catch {
    migrationCmd = ["npx", "drizzle-kit", "migrate"];
  }

  await emitEvent(taskId, "narration", `Running database migrations: ${migrationCmd.join(" ")}…`);

  const migrationResult = await execInContainer(activeContainerId, migrationCmd, projectId);

  if (!migrationResult.ok) {
    const errorMsg = `Database migration failed: ${migrationResult.output.slice(0, 400)}`;
    logger.warn({ projectId, taskId, output: migrationResult.output }, "Drizzle migration failed");
    return { ok: false, error: errorMsg };
  }

  await emitEvent(taskId, "narration", "Database migrations completed successfully.");
  logger.info({ projectId, taskId }, "Drizzle migration completed");
  return { ok: true };
}

type AgenticPreviewRuntimeResult = {
  previewUpdated: boolean;
  previewSyncQueued: boolean;
  previewSyncFailed: boolean;
  warnings: string[];
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function startCommandForFiles(
  files: Array<{ path: string; content: string }>,
  stack: string | null | undefined,
): string | null {
  const pkgFile = files.find((f) => f.path === "package.json");
  if (pkgFile) {
    try {
      const pkg = JSON.parse(pkgFile.content) as { scripts?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      if (stack === "react-vite") {
        if (scripts.dev) return "npm run dev -- --host 0.0.0.0 --port 3000";
        if (scripts.preview) return "npm run preview -- --host 0.0.0.0 --port 3000";
        if (scripts.start) return "npm start -- --host 0.0.0.0 --port 3000";
        return "npx vite --host 0.0.0.0 --port 3000";
      }
      if (stack === "nextjs") {
        if (scripts.dev) return "npm run dev -- -H 0.0.0.0 -p 3000";
        if (scripts.start) return "npm start";
        return "npx next dev -H 0.0.0.0 -p 3000";
      }
      if (scripts["dev:server"]) return "npm run dev:server";
      if (scripts.dev) return "npm run dev";
      if (scripts.start) return "npm start";
      return "npm start";
    } catch {
      return "npm start";
    }
  }

  if (stack === "python-flask" || files.some((f) => f.path === "app.py")) return "python app.py";
  if (stack === "python-fastapi" || files.some((f) => f.path === "main.py"))
    return "uvicorn main:app --host 0.0.0.0 --port 3000";
  return null;
}

function isRuntimeManifestPath(path: string): boolean {
  return [
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "requirements.txt",
  ].includes(path);
}

async function syncAgenticPreviewRuntime(opts: {
  projectId: number;
  taskId: number;
  containerId: string | null;
  containerStatus: string | null;
  containerUrl: string | null;
  stack: string | null | undefined;
  signal?: AbortSignal;
  files: Array<{ path: string; content: string }>;
  removedPaths: string[];
  packageManifestChanged: boolean;
}): Promise<AgenticPreviewRuntimeResult> {
  const base: AgenticPreviewRuntimeResult = {
    previewUpdated: false,
    previewSyncQueued: false,
    previewSyncFailed: false,
    warnings: [],
  };

  if (!opts.containerUrl) {
    if (opts.containerId) {
      const warning = "Preview sync failed: this container-backed project has no preview URL.";
      publishPreviewSyncFailed(opts.projectId, warning);
      return { ...base, previewSyncFailed: true, warnings: [warning] };
    }
    return { ...base, previewUpdated: true, previewSyncQueued: true };
  }

  if (!opts.containerId) {
    return {
      ...base,
      previewSyncFailed: true,
      warnings: [
        "Preview sync skipped: this agentic project has a container URL but no container id.",
      ],
    };
  }

  const {
    startContainer,
    getContainerStatus,
    syncFilesToContainer,
    execInContainer,
    npmInstallInBackground,
  } = await import("./container");

  try {
    if (opts.containerStatus !== "running") {
      await emitEvent(opts.taskId, "narration", "Waking preview container…");
      await startContainer(opts.containerId, opts.projectId);
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        const status = await getContainerStatus(opts.containerId);
        if (status === "running") break;
        await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
      }
    }

    await emitEvent(opts.taskId, "narration", "Syncing project files to preview container…");
    await syncFilesToContainer(opts.containerId, opts.projectId, opts.files, true);

    if (opts.removedPaths.length > 0) {
      const rmArgs = opts.removedPaths.map((path) => shellQuote(`/app/${path}`)).join(" ");
      await execInContainer(opts.containerId, ["sh", "-c", `rm -rf -- ${rmArgs}`], opts.projectId);
    }

    const hasPackageJson = opts.files.some((f) => f.path === "package.json");
    let nodeModulesMissing = false;
    if (hasPackageJson) {
      const nodeModulesCheck = await execInContainer(
        opts.containerId,
        ["sh", "-c", "test -d /app/node_modules && echo __PRESENT__ || echo __MISSING__"],
        opts.projectId,
      );
      nodeModulesMissing = !nodeModulesCheck.output.includes("__PRESENT__");
    }

    if (hasPackageJson && (opts.packageManifestChanged || nodeModulesMissing)) {
      await emitEvent(opts.taskId, "narration", "Installing container dependencies…");
      const installResult = await npmInstallInBackground(opts.containerId, opts.projectId, {
        wallClockCapMs: 6 * 60 * 1000,
        onMachineRestarted: async () => {
          await syncFilesToContainer(opts.containerId!, opts.projectId, opts.files, true);
        },
      });
      if (!installResult.ok) {
        const warning = `Preview sync failed: dependency install did not complete (${installResult.output.slice(0, 300)}).`;
        publishPreviewSyncFailed(opts.projectId, warning);
        return { ...base, previewSyncFailed: true, warnings: [warning] };
      }
    }

    const hasRequirements = opts.files.some((f) => f.path === "requirements.txt");
    if (hasRequirements) {
      await emitEvent(opts.taskId, "narration", "Installing Python dependencies…");
      const pipResult = await execInContainer(
        opts.containerId,
        ["sh", "-c", "cd /app && pip install -r requirements.txt"],
        opts.projectId,
      );
      if (!pipResult.ok) {
        const warning = `Preview sync failed: Python dependency install failed (${pipResult.output.slice(0, 300)}).`;
        publishPreviewSyncFailed(opts.projectId, warning);
        return { ...base, previewSyncFailed: true, warnings: [warning] };
      }
    }

    const startCommand = startCommandForFiles(opts.files, opts.stack);
    if (startCommand) {
      await emitEvent(opts.taskId, "narration", "Restarting container app server…");
      await execInContainer(
        opts.containerId,
        [
          "sh",
          "-c",
          [
            "cd /app",
            "pkill -f 'node ' 2>/dev/null || true",
            "pkill -f 'tsx ' 2>/dev/null || true",
            "pkill -f 'vite' 2>/dev/null || true",
            "pkill -f 'next' 2>/dev/null || true",
            "export PORT=3000",
            `nohup ${startCommand} >/tmp/app.log 2>&1 &`,
          ].join(" && "),
        ],
        opts.projectId,
      );
    }

    const previewCheck = await pollPreviewReachability(opts.taskId, opts.containerUrl, {
      healthPath: healthCheckPathForStack(opts.stack),
      signal: opts.signal,
      maxWaitMs: 75_000,
      intervalMs: 5_000,
    });
    if (previewCheck.reachable) {
      publishPreviewReady(opts.projectId);
      // Agentic confirmation: /healthz returned 200 after file sync and server restart.
      return { ...base, previewUpdated: true };
    }

    const warning = `Preview sync failed: container health check did not pass (${previewCheck.httpStatus !== null ? `HTTP ${previewCheck.httpStatus}` : "no response"}).`;
    publishPreviewSyncFailed(opts.projectId, warning);
    return { ...base, previewSyncFailed: true, warnings: [warning] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const warning = `Preview sync failed: ${message.slice(0, 300)}`;
    logger.warn({ err, projectId: opts.projectId, taskId: opts.taskId }, warning);
    publishPreviewSyncFailed(opts.projectId, warning);
    return { ...base, previewSyncFailed: true, warnings: [warning] };
  }
}

/**
 * Apply a task-agent staging snapshot: works entirely against task.stagingSnapshot
 * (the draft array persisted while the job is in "needs_review") and patches
 * project_files exactly as a normal build would, making the staged changes live
 * in one atomic write. Safe to retry — idempotent per path.
 */
export async function applyTaskAgentStaging(taskId: number, projectId: number): Promise<void> {
  const [task] = await db
    .select()
    .from(agentTasksTable)
    .where(and(eq(agentTasksTable.id, taskId), eq(agentTasksTable.projectId, projectId)))
    .limit(1);
  if (!task) throw new Error("Task not found");
  if (task.status !== "needs_review")
    throw new Error(`Task is in state "${task.status}", not needs_review`);
  if (!task.stagingSnapshot || !Array.isArray(task.stagingSnapshot))
    throw new Error("Task has no staging snapshot to apply");

  const stagingFiles = task.stagingSnapshot as Array<{
    path: string;
    content: string;
    mimeType: string;
  }>;
  const builderFiles: BuilderFile[] = stagingFiles.map((f) => ({
    path: f.path,
    content: f.content,
    mimeType: f.mimeType,
  }));

  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
  if (!project) throw new Error("Project not found");

  const report = task.report as TaskReport | null;
  const assistantSummary = task.result ?? `Task #${taskId} applied`;
  const userPrompt = task.prompt ?? "";
  // Use the mode frozen at task-creation time (item 4); fall back to project-level
  // setting for legacy rows that predate the taskAgentMode column.
  const agentMode =
    (task.taskAgentMode as AgentMode | null | undefined) ??
    (project.agentMode as AgentMode) ??
    "power";
  const taskOrigin = typeof task.origin === "string" && task.origin.length > 0 ? task.origin : null;

  // ── SAST gate (before any files are written or synced) ─────────────────
  // Run a static security scan on all JS/HTML files in the staging snapshot.
  // If any critical-severity findings are detected, block the apply and surface
  // the findings so the user can fix them before promoting to project_files.
  {
    const { runSastCheck } = await import("./checks/sast");
    const sastResult = runSastCheck(builderFiles);
    const criticalFindings = sastResult.findings.filter((f) => f.severity === "error");
    if (sastResult.status === "fail" && criticalFindings.length > 0) {
      const summary = criticalFindings
        .slice(0, 5)
        .map((f) => `  • ${f.file}:${f.line ?? "?"} — ${f.message}`)
        .join("\n");
      const humanMessage =
        `Apply blocked by SAST: ${criticalFindings.length} critical security issue(s) found in staged files.\n${summary}\n` +
        `Fix these issues in the Agent's output before applying.`;

      // Store structured findings so the UI can render a "Fix with AI" card
      const structuredFindings: NonNullable<TaskReport["securityFindings"]> = {
        kind: "sast",
        blocked: true,
        message: humanMessage,
        fixPrompt: `Fix the following SAST security issues found in the staged files:\n${summary}`,
        sast: criticalFindings.slice(0, 10).map((f) => ({
          file: f.file,
          line: f.line ?? null,
          message: f.message,
          detail: f.detail ?? null,
          severity: f.severity,
          remediation: f.detail ?? null,
        })),
      };
      const structuredResult = JSON.stringify({
        type: "sast_block",
        findings: structuredFindings.sast,
        message: humanMessage,
        fixPrompt: structuredFindings.fixPrompt,
      });

      const sastMergedReport: TaskReport = {
        ...((report as TaskReport | null) ?? ({} as TaskReport)),
        securityFindings: structuredFindings,
      };

      await db
        .update(agentTasksTable)
        .set({
          status: "failed",
          result: structuredResult.slice(0, 2000),
          report: sastMergedReport,
          completedAt: new Date(),
        })
        .where(eq(agentTasksTable.id, taskId));

      throw new Error(humanMessage);
    }
    if (sastResult.status === "warning" && sastResult.findings.length > 0) {
      // Non-blocking warnings — surface in narration only
      const warnSummary = sastResult.findings
        .slice(0, 3)
        .map((f) => `${f.file}:${f.line ?? "?"}: ${f.message}`)
        .join("; ");
      void emitEvent(taskId, "narration", `SAST warnings (non-blocking): ${warnSummary}`);
    }
  }

  // ── npm audit gate (before writing files, uses staged package.json) ─────
  // When the staging snapshot includes a modified package.json or
  // package-lock.json, run npm audit in the project's container before
  // applying to catch high/critical CVEs introduced by new dependencies.
  {
    const hasPackageChange = builderFiles.some(
      (f) => f.path === "package.json" || f.path === "package-lock.json",
    );
    if (hasPackageChange) {
      const [containerRow] = await db
        .select({
          containerId: projectsTable.containerId,
          containerStatus: projectsTable.containerStatus,
        })
        .from(projectsTable)
        .where(eq(projectsTable.id, projectId));

      if (!containerRow?.containerId) {
        // No container is running for this project — we cannot execute npm audit.
        // Fail closed: block the apply rather than letting unvetted dependencies through.
        const noContainerMsg =
          "Apply blocked: package.json was changed but no container is running to execute npm audit. Start a container from the Terminal tab and retry.";
        const noContainerFindings: NonNullable<TaskReport["securityFindings"]> = {
          kind: "npm_audit",
          blocked: true,
          message: noContainerMsg,
          fixPrompt:
            "A container must be running before package.json changes can be applied. Start the container from the Terminal tab, then retry.",
          npmAudit: {
            critical: 0,
            high: 0,
            parsed: false,
            packages: [],
            remediation:
              "Start the project container from the Terminal tab so the dependency audit can run, then click Apply again.",
          },
        };
        const noContainerResult = JSON.stringify({
          type: "npm_audit_block",
          critical: 0,
          high: 0,
          parsed: false,
          packages: [],
          message: noContainerMsg,
          fixPrompt: noContainerFindings.fixPrompt,
        });
        const noContainerReport: TaskReport = {
          ...((report as TaskReport | null) ?? ({} as TaskReport)),
          securityFindings: noContainerFindings,
        };
        await db
          .update(agentTasksTable)
          .set({
            status: "failed",
            result: noContainerResult.slice(0, 2000),
            report: noContainerReport,
            completedAt: new Date(),
          })
          .where(eq(agentTasksTable.id, taskId));
        throw new Error(noContainerMsg);
      }

      void emitEvent(taskId, "narration", "Running npm audit on staged dependencies…");
      try {
        const { execInContainer, startContainer, getContainerStatus, syncFilesToContainer } =
          await import("./container");

        if (containerRow.containerStatus !== "running") {
          await startContainer(containerRow.containerId, projectId);
          const wakeDeadline = Date.now() + 30_000;
          while (Date.now() < wakeDeadline) {
            const liveStatus = await getContainerStatus(containerRow.containerId);
            if (liveStatus === "running") break;
            await new Promise<void>((r) => setTimeout(r, 2000));
          }
        }

        // Write only the package files to the container for the audit check
        const pkgFiles = builderFiles.filter(
          (f) => f.path === "package.json" || f.path === "package-lock.json",
        );
        await syncFilesToContainer(containerRow.containerId, projectId, pkgFiles);

        const auditResult = await execInContainer(
          containerRow.containerId,
          ["npm", "audit", "--audit-level=high", "--json"],
          projectId,
        );
        if (!auditResult.ok) {
          // npm audit --audit-level=high exits non-zero only when vulnerabilities
          // at or above the specified severity are found. Treat any non-zero exit
          // as a blocking failure (fail-closed). We attempt JSON parse for a richer
          // error message; failure to parse does NOT allow the apply to proceed.
          let highCount: number | null = null;
          let criticalCount: number | null = null;
          const affectedPackages: Array<{ name: string; severity: string }> = [];
          try {
            const auditJson = JSON.parse(auditResult.output) as {
              metadata?: { vulnerabilities?: { high?: number; critical?: number } };
              vulnerabilities?: Record<
                string,
                { name?: string; severity?: string; isDirect?: boolean }
              >;
            };
            highCount = auditJson?.metadata?.vulnerabilities?.high ?? 0;
            criticalCount = auditJson?.metadata?.vulnerabilities?.critical ?? 0;
            // Extract individual affected package names + severities (top 10)
            if (auditJson?.vulnerabilities) {
              for (const [pkgName, vuln] of Object.entries(auditJson.vulnerabilities)) {
                const sev = vuln?.severity ?? "unknown";
                if (sev === "high" || sev === "critical") {
                  affectedPackages.push({ name: vuln?.name ?? pkgName, severity: sev });
                  if (affectedPackages.length >= 10) break;
                }
              }
            }
          } catch {
            // JSON parse failed — output is probably truncated or plain-text npm noise.
            // Fail closed: the exit code is non-zero, so vulnerabilities were found.
          }

          const pkgList =
            affectedPackages.length > 0
              ? affectedPackages.map((p) => `${p.name} (${p.severity})`).join(", ")
              : null;
          const humanMessage =
            highCount !== null && criticalCount !== null
              ? `Apply blocked by npm audit: ${criticalCount} critical and ${highCount} high severity vulnerability(ies) found in staged dependencies${pkgList ? ` (${pkgList})` : ""}. Review and update the affected packages before applying.`
              : `Apply blocked by npm audit: high/critical vulnerabilities detected in staged dependencies (could not parse full report). Review and update the affected packages before applying.`;

          const fixPromptPkgPart =
            affectedPackages.length > 0
              ? `Affected packages: ${affectedPackages.map((p) => p.name).join(", ")}. `
              : "";
          const fixPromptText =
            highCount !== null && criticalCount !== null
              ? `Fix the npm dependency security vulnerabilities (${criticalCount} critical, ${highCount} high) found in package.json. ${fixPromptPkgPart}Update the affected packages to patched versions and re-submit.`
              : `Fix the high/critical npm dependency vulnerabilities in package.json. Run 'npm audit fix' and update affected packages to patched versions.`;
          const auditFindings: NonNullable<TaskReport["securityFindings"]> = {
            kind: "npm_audit",
            blocked: true,
            message: humanMessage,
            fixPrompt: fixPromptText,
            npmAudit: {
              critical: criticalCount ?? 0,
              high: highCount ?? 0,
              parsed: highCount !== null && criticalCount !== null,
              packages: affectedPackages,
              remediation:
                "Run `npm audit fix` locally, or upgrade the affected packages to patched versions in package.json, then retry Apply.",
            },
          };
          const structuredResult = JSON.stringify({
            type: "npm_audit_block",
            critical: criticalCount ?? 0,
            high: highCount ?? 0,
            parsed: highCount !== null && criticalCount !== null,
            packages: affectedPackages,
            message: humanMessage,
            fixPrompt: fixPromptText,
          });
          const auditMergedReport: TaskReport = {
            ...((report as TaskReport | null) ?? ({} as TaskReport)),
            securityFindings: auditFindings,
          };

          await db
            .update(agentTasksTable)
            .set({
              status: "failed",
              result: structuredResult.slice(0, 2000),
              report: auditMergedReport,
              completedAt: new Date(),
            })
            .where(eq(agentTasksTable.id, taskId));
          throw new Error(humanMessage);
        }
      } catch (npmAuditErr) {
        // Re-throw intentional block errors from our own vulnerability check.
        if (npmAuditErr instanceof Error && npmAuditErr.message.startsWith("Apply blocked")) {
          throw npmAuditErr;
        }
        // Any other error (container unreachable, npm not installed, exec timeout, etc.)
        // means we could NOT verify the dependency audit. Fail closed: block the apply
        // rather than silently allow potentially unsafe dependencies through.
        logger.warn(
          { err: npmAuditErr, projectId, taskId },
          "npm audit pre-check failed — blocking apply (fail-closed)",
        );
        const errMsg = `Apply blocked: dependency security audit could not be completed (${
          npmAuditErr instanceof Error ? npmAuditErr.message : String(npmAuditErr)
        }). Verify the container is running and retry.`;
        await db
          .update(agentTasksTable)
          .set({ status: "failed", result: errMsg.slice(0, 500), completedAt: new Date() })
          .where(eq(agentTasksTable.id, taskId));
        throw new Error(errMsg, { cause: npmAuditErr });
      }
    }
  }

  // Staging gate: project_files are NOT modified until this point. Legacy staged
  // output lives in task.stagingSnapshot while the job is in "needs_review".
  // Quick Preview and Full App Preview both read from project_files only, so draft
  // Staged changes are invisible in any preview mode until the user clicks Apply.
  // This guarantees test #10 and #11 in the preview-security test suite.
  void emitEvent(taskId, "narration", `Syncing ${builderFiles.length} file(s) to your project…`);
  const currentFileRows = await db
    .select({ path: projectFilesTable.path, content: projectFilesTable.content })
    .from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, projectId));
  const appliedPathSet = new Set(builderFiles.map((f) => f.path));
  const removedPaths = currentFileRows
    .map((row) => row.path)
    .filter((path) => !appliedPathSet.has(path));
  const previousContentByPath = new Map(
    currentFileRows.map((row) => [row.path, row.content ?? ""] as const),
  );
  const packageManifestChanged = builderFiles.some((file) =>
    isRuntimeManifestPath(file.path)
      ? previousContentByPath.get(file.path) !== file.content
      : false,
  );
  await writeFiles(projectId, builderFiles, true);
  emitFilesChangedEvent(taskId, projectId, builderFiles, removedPaths, "apply");

  // Run container file sync + Drizzle migrations for any schema files in the staging
  // set (item 2). Non-fatal: failure surfaces as a report warning so the apply
  // still completes and files are promoted.
  void emitEvent(taskId, "narration", "Running database migrations…");
  const postWriteWarnings: string[] = [];
  {
    const migResult = await runPostWriteMigrationSync(projectId, taskId, builderFiles);
    if (migResult.ok && migResult.info) postWriteWarnings.push(migResult.info);
    if (!migResult.ok) {
      postWriteWarnings.push(migResult.error);
      logger.warn(
        { projectId, taskId },
        "Migration sync failed after Apply (non-fatal — files already promoted)",
      );
    }
  }

  const applyPreviewResult = await syncAgenticPreviewRuntime({
    projectId,
    taskId,
    containerId: project.containerId,
    containerStatus: project.containerStatus,
    containerUrl: project.containerUrl,
    stack: project.stack,
    files: builderFiles.map((file) => ({ path: file.path, content: file.content })),
    removedPaths,
    packageManifestChanged,
  });

  // Save version snapshot
  void emitEvent(taskId, "narration", "Saving version snapshot…");
  const snapshot = await snapshotFilesForVersion(projectId);
  const planSnapshot = await loadLatestPlanSnapshot(projectId);
  const changelogEntry = `**Staged Review Apply**\n${(assistantSummary ?? "").slice(0, 180)}`;
  let version: { id: number } | undefined;
  try {
    const inserted = await db
      .insert(projectVersionsTable)
      .values({
        projectId,
        label: `Apply Task #${taskId}`.slice(0, 200),
        note: (assistantSummary ?? "").slice(0, 200),
        changelogEntry: changelogEntry.slice(0, 500),
        filesSnapshot: snapshot,
        planSnapshot: planSnapshot ?? undefined,
      })
      .returning({ id: projectVersionsTable.id });
    version = inserted[0];
  } catch (snapErr) {
    logger.warn(
      { err: snapErr, projectId, taskId },
      "Failed to save apply-stage version snapshot (non-fatal — files already persisted)",
    );
  }

  // Task #538 — Unified Checkpoints: capture DB snapshot tied to apply version.
  if (version) {
    const versionIdForSnapshot = version.id;
    setImmediate(() => {
      void (async () => {
        const { captureProjectDbSnapshot } = await import("./db-snapshot-capture");
        await captureProjectDbSnapshot(
          projectId,
          versionIdForSnapshot,
          `Checkpoint: Apply Task #${taskId}`,
        );
      })();
    });
  }

  const finalReport: TaskReport = {
    ...(report ?? {
      userRequest: userPrompt,
      filesCreated: [],
      filesChanged: [],
      filesRemoved: [],
      previewUpdated: false,
      warnings: [],
      integrationsNeeded: [],
    }),
    previewUpdated: applyPreviewResult.previewUpdated,
    previewSyncQueued: applyPreviewResult.previewSyncQueued,
    previewSyncFailed: applyPreviewResult.previewSyncFailed || report?.previewSyncFailed,
    // Merge any post-write migration warnings (item 2) into the report so the
    // user sees them in the task result card even though Apply still succeeded.
    warnings: [
      ...((report?.warnings ?? []) as string[]),
      ...postWriteWarnings,
      ...applyPreviewResult.warnings,
    ],
    versionId: version?.id ?? null,
  };

  // Mark task completed + clear staging snapshot + stamp appliedAt (Task #509).
  // Also clear creditsReserved so refunds on a future no-op cancel don't double-credit.
  await db
    .update(agentTasksTable)
    .set({
      status: "completed",
      report: finalReport,
      stagingSnapshot: null,
      completedAt: sql`now()`,
      appliedAt: sql`now()`,
      creditsReserved: null,
    })
    .where(
      and(
        eq(agentTasksTable.id, taskId),
        // Guard against cancel race: if cancel already wrote "canceled", don't overwrite it.
        inArray(agentTasksTable.status, ["building", "planning", "needs_review"]),
      ),
    );

  await db.insert(chatMessagesTable).values({
    projectId,
    role: "system",
    content: assistantSummary,
    agentMode,
    planMode: false,
    origin: taskOrigin,
    plan: {
      kind: "report",
      report: finalReport,
      taskId,
      agentIdentity: "task",
      applied: true,
    } as unknown as Record<string, unknown>,
    checkpointId: version?.id ?? null,
  });

  if (version?.id) {
    try {
      await db
        .update(chatMessagesTable)
        .set({ checkpointId: version.id })
        .where(
          sql`id = (
            SELECT id FROM chat_messages
            WHERE project_id = ${projectId}
              AND role = 'user'
              AND checkpoint_id IS NULL
              AND (
                (${taskOrigin}::text IS NULL AND origin IS NULL)
                OR origin = ${taskOrigin}
              )
            ORDER BY created_at DESC
            LIMIT 1
          )`,
        );
    } catch (err) {
      logger.warn(
        { err, projectId, versionId: version.id },
        "Failed to link apply triggering message to checkpoint",
      );
    }
  }

  // Update project status
  await db
    .update(projectsTable)
    .set({
      status: "testing",
      lastTaskSummary: assistantSummary.slice(0, 140),
      summary: assistantSummary,
      updatedAt: sql`now()`,
    })
    .where(eq(projectsTable.id, projectId));

  // Extract page map
  try {
    await extractPageMap(projectId);
  } catch (err) {
    logger.warn({ err, projectId }, "Page map extraction failed after apply (non-fatal)");
  }

  // Drain queued tasks (the review gate is now open)
  void drainNextProjectTask(projectId).catch((err) =>
    logger.warn({ err, projectId }, "Failed to drain project task after apply"),
  );
  // Also drain the batch queue if this task belonged to a batch
  if (task.queueBatchId) {
    void drainNextBatchTask(taskId).catch((err) =>
      logger.warn({ err, taskId }, "Failed to drain next batch task after apply"),
    );
  }

  // Post-build hooks — quality audit (fire-and-forget)
  if (version) {
    const versionIdForAudit = version.id;
    const taskIdForAudit = taskId;
    setImmediate(() => {
      void (async () => {
        try {
          const auditReport = runAudit(builderFiles);
          await db
            .update(projectVersionsTable)
            .set({ auditReport })
            .where(eq(projectVersionsTable.id, versionIdForAudit));
          const [latestTask] = await db
            .select({ report: agentTasksTable.report })
            .from(agentTasksTable)
            .where(eq(agentTasksTable.id, taskIdForAudit))
            .limit(1);
          const latestReport = latestTask?.report ?? finalReport;
          await db
            .update(agentTasksTable)
            .set({ report: { ...latestReport, auditReport } })
            .where(eq(agentTasksTable.id, taskIdForAudit));
        } catch (err) {
          logger.warn({ err, projectId }, "Quality audit failed after apply (non-fatal)");
        }
      })();
    });
  }

  // Post-build suggestions
  setImmediate(() => {
    void generatePostBuildSuggestions(
      projectId,
      taskId,
      project.name,
      project.kind,
      project.projectFormat ?? "static-html",
      userPrompt,
      assistantSummary,
      snapshot.map((f) => f.path),
      "",
    ).catch((err) => logger.warn({ err, taskId }, "Post-apply suggestion generation failed"));
  });

  // Knowledge vault entry
  void writeKnowledge({
    title: `Staged review applied: "${userPrompt.slice(0, 60)}"`,
    content: `User approved and applied staged review output for "${userPrompt.slice(0, 100)}". ${stagingFiles.length} file(s) promoted to live.`,
    type: "refine",
    category: "refinement",
    severity: "info",
    projectId,
    userId: project.ownerId,
    relatedTaskId: taskId,
    relatedVersionId: version?.id,
    tags: ["staged-review", "applied"],
  });

  // Credit deduction (post-success, non-fatal).
  // Background jobs (Task #509) reserved credits at enqueue — skip double-charging.
  if (project.ownerId && task.creditsReserved === null) {
    const { creditCostFor, resolveStageProvider } = await import("./ai-providers");
    const { provider: costProvider } = resolveStageProvider("refine", agentMode);
    const creditCost = creditCostFor(agentMode, costProvider);
    void deductCreditsAtomic(project.ownerId, creditCost, {
      type: "refine",
      description: `Staged review apply - Task #${taskId}, project ${projectId}`,
      projectId,
    })
      .then((result) => {
        if ("insufficient" in result) {
          logger.warn(
            { projectId, taskId, creditCost, agentMode },
            "Staged review apply credit deduction: insufficient balance - changes already applied",
          );
          void emitEvent(
            taskId,
            "credit_insufficient",
            `Insufficient credits to charge for staged review apply - balance ${result.balance} < ${creditCost}`,
          );
        }
      })
      .catch((err) => logger.warn({ err }, "Credit deduction failed after apply (non-fatal)"));
  }

  logger.info({ taskId, projectId, fileCount: stagingFiles.length }, "Staged review applied");
}

/**
 * Discard a staged-review snapshot.
 * No project files are changed; the task moves to "discarded" status.
 * Called by POST /projects/:id/tasks/:taskId/discard.
 */
export async function discardTaskAgentStaging(taskId: number, projectId: number): Promise<void> {
  const [task] = await db
    .select({
      status: agentTasksTable.status,
      projectId: agentTasksTable.projectId,
      queueBatchId: agentTasksTable.queueBatchId,
      creditsReserved: agentTasksTable.creditsReserved,
    })
    .from(agentTasksTable)
    .where(and(eq(agentTasksTable.id, taskId), eq(agentTasksTable.projectId, projectId)))
    .limit(1);
  if (!task) throw new Error("Task not found");
  if (task.status !== "needs_review" && task.status !== "needs_fix")
    throw new Error(`Task is in state "${task.status}", expected needs_review or needs_fix`);

  await db
    .update(agentTasksTable)
    .set({
      status: "discarded",
      stagingSnapshot: null,
      completedAt: sql`now()`,
      discardedAt: sql`now()`,
      creditsReserved: null,
    })
    .where(eq(agentTasksTable.id, taskId));

  // Refund reserved credits (Task #509 — background jobs).
  if (task.creditsReserved && task.creditsReserved > 0) {
    const [proj] = await db
      .select({ ownerId: projectsTable.ownerId })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId))
      .limit(1);
    if (proj?.ownerId) {
      void refundCredits(proj.ownerId, task.creditsReserved, {
        projectId,
        description: `Background task #${taskId} discarded`,
      }).catch((err) => logger.warn({ err, taskId }, "Credit refund failed (non-fatal)"));
    }
  }

  // Drain the project queue (discard opens the gate too)
  void drainNextProjectTask(projectId).catch((err) =>
    logger.warn({ err, projectId }, "Failed to drain project task after discard"),
  );
  // Also drain the batch queue if this task belonged to a batch
  if (task.queueBatchId) {
    void drainNextBatchTask(taskId).catch((err) =>
      logger.warn({ err, taskId }, "Failed to drain next batch task after discard"),
    );
  }

  void writeKnowledge({
    title: `Staged review discarded: Task #${taskId}`,
    content: `User discarded staged review output for Task #${taskId}. No files were changed.`,
    type: "refine",
    category: "refinement",
    severity: "info",
    projectId,
    relatedTaskId: taskId,
    tags: ["staged-review", "discarded"],
  });

  logger.info({ taskId, projectId }, "Staged review discarded");
}

// ── Bounded-concurrency background job runner ──────────────────────────────────
// Ensures at most JOB_CONCURRENCY background (non-foreground) AI jobs run at
// once. Jobs submitted beyond the concurrency cap wait in _pendingJobs until
// a slot frees. This provides genuine deferred execution — jobs do not start
// until capacity is available, complementing the HTTP-level queue in
// rateLimit.ts for foreground requests.

const JOB_CONCURRENCY = 3;
let _activeJobs = 0;
const _pendingJobs: Array<JobInput> = [];

function _drainJobs(): void {
  while (_activeJobs < JOB_CONCURRENCY && _pendingJobs.length > 0) {
    const input = _pendingJobs.shift()!;
    _activeJobs++;
    void runJob(input).finally(() => {
      _activeJobs--;
      _drainJobs();
    });
  }
}

/**
 * Serialise a JobInput to a plain JSON-safe record for the durable queue.
 * AbortSignals and functions are excluded — they are recreated by runJob.
 */
function serializeJobInput(input: JobInput): Record<string, unknown> {
  return {
    taskId: input.taskId,
    projectId: input.projectId,
    kind: input.kind,
    userPrompt: input.userPrompt,
    agentMode: input.agentMode,
    agentIdentity: input.agentIdentity ?? null,
    origin: input.origin ?? null,
    planContext: input.planContext ?? null,
    conversationHistory: input.conversationHistory ?? null,
    imageAttachments: input.imageAttachments ?? null,
    queueBatchId: input.queueBatchId ?? null,
    queueIndex: input.queueIndex ?? null,
    queueTotalCount: input.queueTotalCount ?? null,
    runMode: input.runMode ?? null,
    wallClockCapMs: input.wallClockCapMs ?? null,
  };
}

/**
 * Attempt to enqueue the job into the durable (pg-boss) queue.
 * Returns true if the job was accepted by pg-boss, false if it should fall
 * back to the in-memory path.
 */
async function tryDurableEnqueue(input: JobInput): Promise<boolean> {
  const { durableEnqueue, isDurableQueueReady } = await import("./durable-queue");
  if (!isDurableQueueReady()) return false;
  const kind = input.kind === "build" ? "build" : "refine";
  const id = await durableEnqueue(kind, serializeJobInput(input));
  return id !== null;
}

export function enqueueJob(input: JobInput): void {
  // Try durable queue first; fall back to in-memory if unavailable.
  void tryDurableEnqueue(input)
    .then((accepted) => {
      if (accepted) return; // pg-boss will call runJob via worker
      // In-memory fallback path
      if (_activeJobs < JOB_CONCURRENCY) {
        _activeJobs++;
        void runJob(input).finally(() => {
          _activeJobs--;
          _drainJobs();
        });
      } else {
        _pendingJobs.push(input);
      }
    })
    .catch(() => {
      // If tryDurableEnqueue itself throws (import error etc.), fall through
      if (_activeJobs < JOB_CONCURRENCY) {
        _activeJobs++;
        void runJob(input).finally(() => {
          _activeJobs--;
          _drainJobs();
        });
      } else {
        _pendingJobs.push(input);
      }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// EAS Build Job — mobile cloud builds via Expo Application Services
// ─────────────────────────────────────────────────────────────────────────────

export const EAS_BUILD_CREDIT_COST = 5;

export interface EasJobInput {
  deploymentLogId: number;
  projectId: number;
  userId: string;
  platform: EasPlatform;
  accessToken: string;
  appSlug: string;
  appOwner: string;
  /** Extracted from project files — used to log context but not uploaded to EAS */
  appJsonSummary?: string;
}

async function extractAppJsonSummary(projectId: number): Promise<string> {
  try {
    const [row] = await db
      .select({ content: projectFilesTable.content })
      .from(projectFilesTable)
      .where(
        and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.path, "app.json")),
      )
      .limit(1);
    if (!row) return "(no app.json found in project files)";
    // Truncate to avoid bloating the log
    return row.content.slice(0, 500);
  } catch {
    return "";
  }
}

async function runEasBuildJob(input: EasJobInput): Promise<void> {
  const { deploymentLogId, projectId, userId, platform, accessToken, appSlug, appOwner } = input;
  // eslint-disable-next-line no-useless-assignment
  let easBuildId: string | null = null;

  try {
    logger.info({ projectId, platform, appSlug, appOwner }, "EAS build job starting");

    await db
      .update(deploymentLogsTable)
      .set({ status: "building", note: "EAS build triggered — waiting for result…" })
      .where(eq(deploymentLogsTable.id, deploymentLogId));

    const build = await triggerEasBuild({ accessToken, appSlug, appOwner, platform });
    easBuildId = build.id;

    await db
      .update(deploymentLogsTable)
      .set({
        buildId: easBuildId,
        status: "building",
        note: `EAS build in progress (id: ${easBuildId})`,
      })
      .where(eq(deploymentLogsTable.id, deploymentLogId));

    // Poll for completion (max 15 min, every 15 s)
    const maxPollMs = 15 * 60 * 1000;
    const pollIntervalMs = 15_000;
    const startTime = Date.now();
    let finalBuild = build;

    while (Date.now() - startTime < maxPollMs) {
      await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
      finalBuild = await getEasBuildStatus(accessToken, easBuildId);
      const deployStatus = mapEasStatusToDeploymentStatus(finalBuild.status);
      await db
        .update(deploymentLogsTable)
        .set({ status: deployStatus, note: `EAS status: ${finalBuild.status}` })
        .where(eq(deploymentLogsTable.id, deploymentLogId));
      if (["finished", "errored", "canceled", "timed-out"].includes(finalBuild.status)) break;
    }

    if (finalBuild.status === "finished") {
      const downloadUrl =
        finalBuild.artifacts?.applicationArchiveUrl ?? finalBuild.artifacts?.buildUrl ?? null;

      let testflightUrl: string | null = null;
      let submissionNote = "";
      try {
        await db
          .update(deploymentLogsTable)
          .set({
            status: "submitting",
            note: "Build succeeded — submitting to store…",
            downloadUrl: downloadUrl ?? undefined,
          })
          .where(eq(deploymentLogsTable.id, deploymentLogId));

        await triggerEasSubmit({ accessToken, buildId: easBuildId, platform, appOwner });
        testflightUrl =
          platform === "ios"
            ? "https://appstoreconnect.apple.com/apps"
            : "https://play.google.com/console";
        submissionNote =
          platform === "ios"
            ? "Submitted to TestFlight. Check App Store Connect for processing status."
            : "Uploaded to Google Play Internal Testing track.";
      } catch (submitErr) {
        logger.warn({ submitErr, easBuildId }, "EAS submit failed (build still succeeded)");
        submissionNote = `Build succeeded. Auto-submit failed: ${submitErr instanceof Error ? submitErr.message : "unknown error"}`;
      }

      await db
        .update(deploymentLogsTable)
        .set({
          status: "submitted",
          downloadUrl: downloadUrl ?? undefined,
          testflightUrl: testflightUrl ?? undefined,
          note: submissionNote,
        })
        .where(eq(deploymentLogsTable.id, deploymentLogId));

      void writeKnowledge({
        title: `EAS ${platform} build succeeded`,
        content: `Project ${projectId} EAS ${platform} build (id: ${easBuildId}) completed and submitted. ${submissionNote}`,
        type: "build",
        category: "event",
        severity: "info",
        projectId,
        userId,
      });

      void db
        .insert(chatMessagesTable)
        .values({
          projectId,
          role: "system",
          content: `${platform === "ios" ? "iOS" : "Android"} cloud build succeeded and submitted. ${submissionNote}`,
          agentMode: "eco",
          planMode: false,
          plan: {
            kind: "report",
            report: {
              userRequest: `EAS ${platform} build`,
              filesCreated: [],
              filesChanged: [],
              filesRemoved: [],
              previewUpdated: false,
              warnings: [],
            },
          } as unknown as Record<string, unknown>,
        })
        .catch(() => {
          /* best-effort */
        });
    } else {
      const errorMsg = finalBuild.error?.message ?? `EAS build ${finalBuild.status}`;
      await db
        .update(deploymentLogsTable)
        .set({ status: "failed", note: errorMsg })
        .where(eq(deploymentLogsTable.id, deploymentLogId));

      void writeKnowledge({
        title: `EAS ${platform} build failed`,
        content: `Project ${projectId} EAS ${platform} build (id: ${easBuildId}) failed: ${errorMsg}. Check credentials in project Secrets.`,
        type: "build",
        category: "diagnostic",
        severity: "error",
        projectId,
        userId,
      });

      void db
        .insert(chatMessagesTable)
        .values({
          projectId,
          role: "assistant",
          content: `${platform === "ios" ? "iOS" : "Android"} cloud build failed: ${errorMsg}`,
          agentMode: "eco",
          planMode: false,
          plan: {
            kind: "error",
            message: errorMsg,
            suggestions: [
              "Check your Apple/Google credentials in the project Secrets tab.",
              "Verify your app.json has a valid bundleIdentifier / package name.",
              "Review the EAS dashboard for detailed build logs.",
            ],
          } as unknown as Record<string, unknown>,
        })
        .catch(() => {
          /* best-effort */
        });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown EAS error";
    logger.error({ err, deploymentLogId, platform }, "EAS build job failed");
    await db
      .update(deploymentLogsTable)
      .set({ status: "failed", note: `Build error: ${message}` })
      .where(eq(deploymentLogsTable.id, deploymentLogId));
  }
}

export function enqueueEasJob(input: EasJobInput): void {
  void (async () => {
    const { durableEnqueueRaw, isDurableQueueReady, QUEUE_EAS_BUILD } =
      await import("./durable-queue");
    if (isDurableQueueReady()) {
      const key = `eas-${input.deploymentLogId}`;
      const id = await durableEnqueueRaw(
        QUEUE_EAS_BUILD,
        input as unknown as Record<string, unknown>,
        key,
        { retryLimit: 1, retryDelay: 30, retryBackoff: false },
      );
      if (id !== null) {
        logger.info(
          { deploymentLogId: input.deploymentLogId, jobId: id },
          "EAS build enqueued in durable queue",
        );
        return;
      }
    }
    // Fallback: in-memory
    setImmediate(() => {
      void runEasBuildJob(input);
    });
  })();
}

// ─────────────────────────────────────────────────────────────────────────────
// App Testing Job — AI-generated Playwright browser tests
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate and run AI-driven browser tests for a completed build.
 * Finds index.html from DB, generates test steps via AI, runs them in
 * headless Chromium, and persists results into the task report.
 * Entirely non-fatal — exceptions are caught and logged.
 */
export async function runAppTestingJob(
  projectId: number,
  taskId: number,
  projectDescription: string,
  savedTestScript?: string | null,
): Promise<void> {
  logger.info({ projectId, taskId, hasSavedScript: !!savedTestScript }, "App testing job starting");

  // Emit SSE so users see the testing phase in their chat stream
  await emitEvent(taskId, "narration", "Running browser tests in headless Chromium…");

  // Load index.html from DB
  const [indexFile] = await db
    .select({ content: projectFilesTable.content })
    .from(projectFilesTable)
    .where(
      and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.path, "index.html")),
    )
    .limit(1);

  if (!indexFile?.content) {
    logger.info(
      { projectId, taskId },
      "No index.html found — skipping browser tests (non-HTML project)",
    );
    return;
  }

  // ── Phase 1: Smoke pass — JS runtime health via runE2eScenarios ────────────
  // Captures console.error, pageerror, and network failures that step-based
  // tests miss. Uses setContent() (fallbackHtml) so no live server is needed.
  const { runE2eScenarios } = await import("./checks/e2e-runner");
  type E2eFailure = {
    name: string;
    message: string;
    consoleErrors: string[];
    networkFailures: Array<{ url: string; message: string }>;
  };

  const smokeSummary = await runE2eScenarios({
    targetUrl: null,
    fallbackHtml: indexFile.content,
    totalBudgetMs: 20_000,
    scenarios: [
      {
        name: "Page loads without JavaScript errors",
        source: "smoke",
        steps: [{ action: "noConsoleErrors" }],
      },
      {
        name: "Interactive elements respond without errors",
        source: "smoke",
        steps: [{ action: "clickEach", selector: "button, [role='button']", max: 3 }],
      },
    ],
  });

  // Convert E2e smoke failures to the unified TestResult shape stored in app_test_runs
  type TestResult = import("@workspace/db").TestResult;
  const smokeResults: TestResult[] = smokeSummary.scenarios.map((s) => ({
    name: s.name,
    passed: s.passed,
    message: s.passed
      ? s.message
      : [
          s.message,
          ...(s.consoleErrors.length ? [`Console: ${s.consoleErrors.slice(0, 2).join("; ")}`] : []),
          ...(s.networkFailures.length
            ? [
                `Network: ${s.networkFailures
                  .slice(0, 1)
                  .map((n) => n.url)
                  .join(", ")}`,
              ]
            : []),
        ]
          .filter(Boolean)
          .join(" | "),
    screenshotBase64: s.screenshotBase64 ?? null,
    durationMs: s.durationMs,
  }));

  // Collect smoke failures enriched with console/network detail for the fix prompt
  const smokeFailures: E2eFailure[] = smokeSummary.scenarios
    .filter((s) => !s.passed && !smokeSummary.skippedReason)
    .map((s) => ({
      name: s.name,
      message: s.message,
      consoleErrors: s.consoleErrors,
      networkFailures: s.networkFailures.map((n) => ({
        url: n.url,
        message: n.message ?? `HTTP ${n.status ?? "?"}`,
      })),
    }));

  logger.info(
    {
      projectId,
      taskId,
      smokePassed: smokeSummary.passed,
      smokeFailed: smokeSummary.failed,
      skippedReason: smokeSummary.skippedReason,
    },
    "Smoke E2E pass complete",
  );

  // ── Phase 2: AI-generated step tests via runTestPlan ────────────────────────
  let testPlan: Awaited<ReturnType<typeof import("./builder").runTestGenerationPipeline>>;

  if (savedTestScript) {
    try {
      testPlan = JSON.parse(savedTestScript) as typeof testPlan;
      logger.info({ projectId, taskId }, "Using saved custom test script");
    } catch (err) {
      logger.warn(
        { err, projectId, taskId },
        "Failed to parse saved testScript — falling back to AI generation",
      );
      const { runTestGenerationPipeline } = await import("./builder");
      testPlan = await runTestGenerationPipeline(indexFile.content, projectDescription);
    }
  } else {
    const { runTestGenerationPipeline } = await import("./builder");
    testPlan = await runTestGenerationPipeline(indexFile.content, projectDescription);
  }

  let stepResults: TestResult[] = [];
  let testScriptJson = "";

  if (testPlan) {
    logger.info(
      { projectId, taskId, stepCount: testPlan.steps.length },
      "Running Playwright step tests",
    );
    const { runTestPlan } = await import("./checks/playwright-runner");
    stepResults = await runTestPlan(indexFile.content, testPlan, { timeoutMs: 5000 });
    testScriptJson = JSON.stringify(testPlan, null, 2);
  } else {
    logger.warn({ projectId, taskId }, "Test generation returned null — skipping step tests");
  }

  // ── Phase 3: Combine results and decide if auto-fix is needed ───────────────
  let allResults: TestResult[] = [...smokeResults, ...stepResults];
  let autoFixed = false;

  const stepFailures: E2eFailure[] = stepResults
    .filter((r) => !r.passed)
    .map((r) => ({ name: r.name, message: r.message, consoleErrors: [], networkFailures: [] }));

  const combinedFailures: E2eFailure[] = [...smokeFailures, ...stepFailures];

  if (combinedFailures.length > 0) {
    logger.info(
      { projectId, taskId, failureCount: combinedFailures.length },
      "Browser test failures detected — attempting auto-fix",
    );
    await emitEvent(
      taskId,
      "narration",
      `Browser tests found ${combinedFailures.length} issue${combinedFailures.length === 1 ? "" : "s"} — running auto-fix…`,
    );

    // Load all project files for the fix pipeline
    const allFiles = await loadFiles(projectId);

    const { runBrowserTestFixPipeline } = await import("./builder");
    const fixedFiles = await runBrowserTestFixPipeline(
      allFiles,
      combinedFailures,
      projectDescription,
    );

    if (fixedFiles && fixedFiles.length > 0) {
      // Write the patched files to DB (partial update — replaceAll=false)
      await writeFiles(projectId, fixedFiles, false);
      emitFilesChangedEvent(taskId, projectId, fixedFiles, [], "refine");
      autoFixed = true;
      logger.info(
        { projectId, taskId, patchedFiles: fixedFiles.map((f) => f.path) },
        "Browser auto-fix applied — re-running tests",
      );
      await emitEvent(taskId, "narration", "Auto-fix applied — re-running browser tests…");

      // Reload index.html after the fix
      const [reloadedIndex] = await db
        .select({ content: projectFilesTable.content })
        .from(projectFilesTable)
        .where(
          and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.path, "index.html")),
        )
        .limit(1);

      if (reloadedIndex?.content) {
        // Re-run smoke + step tests on the fixed HTML
        const reSmokeSum = await runE2eScenarios({
          targetUrl: null,
          fallbackHtml: reloadedIndex.content,
          totalBudgetMs: 20_000,
          scenarios: [
            {
              name: "Page loads without JavaScript errors",
              source: "smoke",
              steps: [{ action: "noConsoleErrors" }],
            },
            {
              name: "Interactive elements respond without errors",
              source: "smoke",
              steps: [{ action: "clickEach", selector: "button, [role='button']", max: 3 }],
            },
          ],
        });
        const reSmokeResults: TestResult[] = reSmokeSum.scenarios.map((s) => ({
          name: s.name,
          passed: s.passed,
          message: s.passed
            ? s.message
            : [
                s.message,
                ...(s.consoleErrors.length
                  ? [`Console: ${s.consoleErrors.slice(0, 2).join("; ")}`]
                  : []),
              ]
                .filter(Boolean)
                .join(" | "),
          screenshotBase64: s.screenshotBase64 ?? null,
          durationMs: s.durationMs,
        }));

        let reStepResults: TestResult[] = [];
        if (testPlan) {
          const { runTestPlan } = await import("./checks/playwright-runner");
          reStepResults = await runTestPlan(reloadedIndex.content, testPlan, { timeoutMs: 5000 });
        }

        allResults = [...reSmokeResults, ...reStepResults];
        logger.info(
          {
            projectId,
            taskId,
            passed: allResults.filter((r) => r.passed).length,
            failed: allResults.filter((r) => !r.passed).length,
          },
          "Post-fix browser tests complete",
        );
      }
    } else {
      logger.info(
        { projectId, taskId },
        "Browser fix pipeline returned no changes — keeping original results",
      );
    }
  }

  // ── Phase 4: Persist results ─────────────────────────────────────────────────
  const passed = allResults.filter((r) => r.passed).length;
  const failed = allResults.filter((r) => !r.passed).length;
  const ranAt = new Date();

  logger.info({ projectId, taskId, passed, failed, autoFixed }, "Browser tests complete");

  // Emit a user-visible summary
  const summaryMsg =
    failed === 0
      ? `Browser tests passed (${passed}/${allResults.length})${autoFixed ? " — auto-fix was applied" : ""}`
      : `Browser tests: ${passed} passed, ${failed} failed${autoFixed ? " (after auto-fix attempt)" : ""}`;
  await emitEvent(taskId, "narration", summaryMsg);

  await db.insert(appTestRunsTable).values({
    projectId,
    taskId,
    ranAt,
    testScript: testScriptJson || null,
    results: allResults,
    passed,
    failed,
  });

  logger.info({ projectId, taskId, passed, failed }, "Test results saved to app_test_runs");

  // Update the task report so InlineReportCard continues to work
  const [latestTask] = await db
    .select({ report: agentTasksTable.report })
    .from(agentTasksTable)
    .where(eq(agentTasksTable.id, taskId))
    .limit(1);

  if (!latestTask) return;

  const latestReport = (latestTask.report ?? {}) as import("@workspace/db").TaskReport;
  const updatedReport: import("@workspace/db").TaskReport = {
    ...latestReport,
    testResults: allResults,
    testScript: testScriptJson || undefined,
    testRanAt: ranAt.toISOString(),
  };

  await db
    .update(agentTasksTable)
    .set({ report: updatedReport })
    .where(eq(agentTasksTable.id, taskId));

  logger.info({ projectId, taskId, passed, failed }, "Test results saved to task report");
}

export { extractAppJsonSummary };

// ─────────────────────────────────────────────────────────────────────────────
// CVE Auto-Protect Job
// Triggered after a CVE scan finds critical findings.
// Prepares an AI-generated dependency upgrade patch and verifies it.
// ─────────────────────────────────────────────────────────────────────────────

export interface CveAutoProtectInput {
  findingId: number;
  projectId?: number | null;
}

/**
 * Standalone background job for CVE auto-protect.
 * Generates a dependency upgrade patch for the given CVE finding,
 * verifies it by running the platform typecheck, and stores the result.
 * If a projectId is provided, writes a notification into that project's chat.
 */
export async function runCveAutoProtectJob(input: CveAutoProtectInput): Promise<void> {
  const { findingId, projectId } = input;
  logger.info({ findingId, projectId }, "CVE auto-protect job starting");

  // eslint-disable-next-line no-useless-assignment
  let finding: {
    id: number;
    packageName: string;
    currentVersion: string | null;
    patchedVersion: string | null;
    cveId: string | null;
    title: string | null;
    severity: string;
    status: string;
  } | null = null;

  try {
    const [row] = await db
      .select()
      .from(cveFindingsTable)
      .where(eq(cveFindingsTable.id, findingId))
      .limit(1);

    if (!row || row.status === "dismissed" || row.status === "fixed") {
      logger.info(
        { findingId },
        "CVE auto-protect: finding not found or already resolved, skipping",
      );
      return;
    }

    if (row.patchStatus === "ready" || row.patchStatus === "applied") {
      logger.info({ findingId }, "CVE auto-protect: patch already prepared, skipping");
      return;
    }

    finding = row;

    await db
      .update(cveFindingsTable)
      .set({ patchStatus: "preparing" as CvePatchStatus })
      .where(eq(cveFindingsTable.id, findingId));

    let existingFiles: BuilderFile[] = [];
    if (projectId) {
      existingFiles = await loadFiles(projectId);
    }

    if (existingFiles.length === 0) {
      try {
        const { readFile } = await import("fs/promises");
        const pkgContent = await readFile("package.json", "utf-8");
        existingFiles.push({
          path: "package.json",
          content: pkgContent,
          mimeType: "application/json",
        });
      } catch {
        logger.warn(
          { findingId },
          "CVE auto-protect: no project files and no platform package.json found",
        );
      }
      try {
        const { readFile } = await import("fs/promises");
        const wsContent = await readFile("pnpm-workspace.yaml", "utf-8");
        existingFiles.push({
          path: "pnpm-workspace.yaml",
          content: wsContent,
          mimeType: "text/plain",
        });
      } catch {
        // platform pnpm-workspace.yaml not found — that's OK
      }
    }

    const patchResult = await runCvePatchPipeline({
      packageName: finding.packageName,
      currentVersion: finding.currentVersion,
      patchedVersion: finding.patchedVersion,
      cveId: finding.cveId,
      title: finding.title,
      existingFiles,
    });

    if (patchResult.patchedFiles.length === 0 || patchResult.error) {
      await db
        .update(cveFindingsTable)
        .set({
          patchStatus: "failed" as CvePatchStatus,
          patchContent: JSON.stringify({
            error: patchResult.error ?? "No files patched",
            summary: patchResult.summary,
          }),
          patchPreparedAt: new Date(),
        })
        .where(eq(cveFindingsTable.id, findingId));

      logger.warn(
        { findingId, error: patchResult.error },
        "CVE auto-protect: patch generation failed",
      );

      if (projectId) {
        await writeCveNotification(projectId, findingId, finding, false, patchResult.summary);
      }
      return;
    }

    const patchContentJson = JSON.stringify({
      files: patchResult.patchedFiles,
      summary: patchResult.summary,
    });

    let typecheckPassed: boolean | null = null;
    try {
      const { execFile } = await import("child_process");
      const { promisify } = await import("util");
      const execFileAsync = promisify(execFile);
      await execFileAsync("pnpm", ["run", "typecheck"], {
        cwd: process.cwd(),
        timeout: 120_000,
      });
      typecheckPassed = true;
      logger.info({ findingId }, "CVE auto-protect: typecheck passed");
    } catch (tcErr) {
      typecheckPassed = false;
      logger.warn(
        { findingId, tcErr },
        "CVE auto-protect: typecheck failed after patch preparation",
      );
    }

    await db
      .update(cveFindingsTable)
      .set({
        patchStatus: "ready" as CvePatchStatus,
        patchContent: patchContentJson,
        patchTypecheckPassed: typecheckPassed,
        patchPreparedAt: new Date(),
      })
      .where(eq(cveFindingsTable.id, findingId));

    logger.info({ findingId, typecheckPassed }, "CVE auto-protect: patch ready");

    if (projectId) {
      await writeCveNotification(
        projectId,
        findingId,
        finding,
        true,
        patchResult.summary,
        typecheckPassed,
      );
    }
  } catch (err) {
    logger.error({ err, findingId }, "CVE auto-protect job failed");
    try {
      await db
        .update(cveFindingsTable)
        .set({ patchStatus: "failed" as CvePatchStatus, patchPreparedAt: new Date() })
        .where(eq(cveFindingsTable.id, findingId));
    } catch {
      // best-effort
    }
  }
}

async function writeCveNotification(
  projectId: number,
  findingId: number,
  finding: { packageName: string; cveId: string | null; severity: string },
  patchReady: boolean,
  summary: string,
  typecheckPassed?: boolean | null,
): Promise<void> {
  try {
    const cveLabel = finding.cveId ? `${finding.cveId} in` : "CVE in";
    const statusText = !patchReady
      ? "Patch generation failed"
      : typecheckPassed === false
        ? "Patch prepared but needs review — typecheck failed"
        : "CVE patch ready";
    const content = `${statusText} — ${cveLabel} ${finding.packageName}. ${summary}`;

    await db.insert(chatMessagesTable).values({
      projectId,
      role: "assistant",
      content,
      planMode: false,
      plan: {
        kind: "cve-auto-protect",
        findingId,
        packageName: finding.packageName,
        cveId: finding.cveId,
        severity: finding.severity,
        patchReady,
        typecheckPassed: typecheckPassed ?? null,
        summary: content,
      },
    });
  } catch (err) {
    logger.warn({ err, projectId, findingId }, "CVE auto-protect: failed to write notification");
  }
}

/**
 * Enqueue a CVE auto-protect background job via setImmediate.
 * Non-blocking — fires and forgets in the background.
 */
export function enqueueCveAutoProtectJob(input: CveAutoProtectInput): void {
  void (async () => {
    const { durableEnqueueRaw, isDurableQueueReady, QUEUE_CVE_AUTOPROTECT } =
      await import("./durable-queue");
    if (isDurableQueueReady()) {
      // Idempotency key: findingId is the correct canonical dedup key.
      // CveAutoProtectInput has no scan timestamp; one finding → one patch job.
      // pg-boss deduplicates re-enqueues with the same key automatically.
      const key = `cve-${input.findingId}`;
      const id = await durableEnqueueRaw(
        QUEUE_CVE_AUTOPROTECT,
        input as unknown as Record<string, unknown>,
        key,
        { retryLimit: 2, retryDelay: 15, retryBackoff: true },
      );
      if (id !== null) {
        logger.info(
          { findingId: input.findingId, jobId: id },
          "CVE auto-protect enqueued in durable queue",
        );
        return;
      }
    }
    // Fallback: in-memory
    setImmediate(() => {
      void runCveAutoProtectJob(input).catch((err) => {
        logger.error(
          { err, findingId: input.findingId },
          "CVE auto-protect job threw unhandled error",
        );
      });
    });
  })();
}

/**
 * Register durable-queue workers for EAS builds, app testing, and CVE auto-protect.
 * Must be called after startDurableQueue() resolves. No-ops when queue is unavailable.
 */
export async function registerJobWorkers(): Promise<void> {
  const { registerWorker, QUEUE_EAS_BUILD, QUEUE_APP_TESTING, QUEUE_CVE_AUTOPROTECT } =
    await import("./durable-queue");

  await registerWorker(
    QUEUE_EAS_BUILD,
    async (payload) => {
      await runEasBuildJob(payload as unknown as EasJobInput);
    },
    { retryLimit: 1, retryDelay: 30, retryBackoff: false },
  );

  await registerWorker(
    QUEUE_APP_TESTING,
    async (payload) => {
      const { projectId, taskId, projectDescription, savedTestScript } = payload as {
        projectId: number;
        taskId: number;
        projectDescription: string;
        savedTestScript?: string | null;
      };
      await runAppTestingJob(projectId, taskId, projectDescription, savedTestScript);
    },
    { retryLimit: 2, retryDelay: 15, retryBackoff: true },
  );

  await registerWorker(
    QUEUE_CVE_AUTOPROTECT,
    async (payload) => {
      await runCveAutoProtectJob(payload as unknown as CveAutoProtectInput);
    },
    { retryLimit: 2, retryDelay: 15, retryBackoff: true },
  );

  logger.info("Job workers registered for EAS build, app-testing, and CVE auto-protect");
}

/**
 * Boot scan (Task #509): mark stuck building/planning background tasks as failed,
 * refund any reserved credits, and unblock their project queues. Runs once at
 * server startup — any background task that was mid-flight when the process died
 * cannot be resumed, so we surface a clear failure and refund the user.
 */
export async function failStuckBackgroundTasksOnBoot(): Promise<void> {
  try {
    const stuck = await db
      .select({
        id: agentTasksTable.id,
        projectId: agentTasksTable.projectId,
        creditsReserved: agentTasksTable.creditsReserved,
      })
      .from(agentTasksTable)
      .where(
        and(
          eq(agentTasksTable.runMode, "background"),
          inArray(agentTasksTable.status, ["building", "planning"]),
        ),
      );

    for (const t of stuck) {
      const msg = "Interrupted by server restart. Please retry.";
      await db
        .update(agentTasksTable)
        .set({
          status: "failed",
          result: msg,
          completedAt: sql`now()`,
          creditsReserved: null,
        })
        .where(eq(agentTasksTable.id, t.id));

      if (t.creditsReserved && t.creditsReserved > 0) {
        const [proj] = await db
          .select({ ownerId: projectsTable.ownerId })
          .from(projectsTable)
          .where(eq(projectsTable.id, t.projectId))
          .limit(1);
        if (proj?.ownerId) {
          void refundCredits(proj.ownerId, t.creditsReserved, {
            projectId: t.projectId,
            description: `Background task #${t.id} interrupted by server restart`,
          }).catch((err) =>
            logger.warn({ err, taskId: t.id }, "Boot-scan refund failed (non-fatal)"),
          );
        }
      }

      void emitEvent(t.id, "failed", msg).catch(() => undefined);
    }

    // Drain every project that had a stuck background task — this kicks off any
    // queued tasks that were waiting behind the stuck one and never got a chance
    // to run after the prior process died.
    const drainedProjects = new Set<number>();
    for (const t of stuck) {
      if (drainedProjects.has(t.projectId)) continue;
      drainedProjects.add(t.projectId);
      void drainNextProjectTask(t.projectId).catch(() => undefined);
    }

    // Also drain any project that has a queued background task even if no row
    // was building/planning at crash time — covers the case where the prior
    // process died between dequeue-attempts.
    const queued = await db
      .select({ projectId: agentTasksTable.projectId })
      .from(agentTasksTable)
      .where(and(eq(agentTasksTable.runMode, "background"), eq(agentTasksTable.status, "queued")));
    for (const q of queued) {
      if (drainedProjects.has(q.projectId)) continue;
      drainedProjects.add(q.projectId);
      void drainNextProjectTask(q.projectId).catch(() => undefined);
    }

    logger.info(
      { count: stuck.length, drainedProjects: drainedProjects.size },
      "Boot scan: marked stuck background tasks as failed; drained project queues",
    );
  } catch (err) {
    logger.warn({ err }, "Boot scan for stuck background tasks failed (non-fatal)");
  }
}
