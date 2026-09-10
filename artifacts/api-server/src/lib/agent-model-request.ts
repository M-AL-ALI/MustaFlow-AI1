import type { TaskReport } from "@workspace/db";

export const AGENT_MODEL_REQUEST_TIMEOUT_MS = 180_000;
const CLEANUP_RESERVE_MS = 5_000;
const MIN_RECOVERY_REQUEST_MS = 1_000;

export const AGENT_MODEL_RECOVERY_HINT =
  "[MODEL REQUEST TIMEOUT RECOVERY] The previous model request exceeded its deadline. " +
  "Continue from the existing conversation and workspace without dropping any user requirement. " +
  "Return exactly ONE small tool call next: one focused read, write, or patch. " +
  "Split large implementations into small modules and continue incrementally. " +
  "Do not replace requested persistent backend storage with an in-memory store or mockup. " +
  "Keep the existing SDK, provider, eligibility, security, and build constraints. " +
  "Use the existing finalize/check gates; a file write alone is not a successful build.";

type FailureCode =
  | "agent_model_request_timeout"
  | "agent_model_run_budget_exhausted"
  | "agent_model_request_aborted"
  | "agent_model_request_rejected";

type LoopReport = NonNullable<TaskReport["agentLoop"]>;

export type AgentModelRequestDiagnostic = {
  taskId?: number;
  projectId: number;
  stage: "build" | "refine";
  phase: "model-request";
  step: number;
  attempt: number;
  requestTimeoutMs: number;
  elapsedMs: number;
  remainingMs: number;
  classification:
    | "request-timeout"
    | "run-budget-exhausted"
    | "unattributed-abort"
    | "access-rejected";
  recoveryAttempted: boolean;
  recoveryScheduled: boolean;
  httpStatus?: number;
};

const FAILURE_MESSAGES: Record<FailureCode, string> = {
  agent_model_request_timeout:
    "The model request timed out and this run could not finish. Earlier file edits may still be present. Review them before continuing with a smaller step.",
  agent_model_run_budget_exhausted:
    "This run has no time left for another model request. Earlier file edits may still be present. Review them before continuing.",
  agent_model_request_aborted:
    "The model request was interrupted, but no user stop or local deadline was observed. This run could not finish; earlier file edits may still be present.",
  agent_model_request_rejected:
    "The AI service rejected this request with an access error. This run could not finish; earlier file edits may still be present. An administrator should check provider access before retrying.",
};

/** Carries only allowlisted diagnostics, never the original provider error or request. */
export class AgentModelRequestError extends Error {
  readonly retryable = false;
  readonly failureEvidence: NonNullable<TaskReport["failureEvidence"]>;
  loopReport?: LoopReport;

  constructor(
    readonly code: FailureCode,
    diagnostic: AgentModelRequestDiagnostic,
  ) {
    super(FAILURE_MESSAGES[code]);
    this.name = "AgentModelRequestError";
    this.failureEvidence = {
      code,
      message: this.message,
      evidence: {
        taskId: diagnostic.taskId ?? null,
        projectId: diagnostic.projectId,
        stage: diagnostic.stage,
        phase: "model-request",
        step: diagnostic.step,
        attempt: diagnostic.attempt,
        requestTimeoutMs: diagnostic.requestTimeoutMs,
        elapsedMs: diagnostic.elapsedMs,
        remainingMs: diagnostic.remainingMs,
        classification: diagnostic.classification,
        recoveryAttempted: diagnostic.recoveryAttempted,
        recoveryScheduled: diagnostic.recoveryScheduled,
        ...(diagnostic.httpStatus === undefined ? {} : { httpStatus: diagnostic.httpStatus }),
      },
    };
  }

  get completionKind(): LoopReport["completionKind"] {
    return this.code === "agent_model_run_budget_exhausted" ? "wall_clock" : "model_stopped";
  }

  attachLoopReport(report: LoopReport): void {
    // Preserve execution metadata, not generated code, prompts, shell output, or screenshots.
    this.loopReport = {
      stack: report.stack,
      steps: report.steps,
      stepCap: report.stepCap,
      wallClockElapsedMs: report.wallClockElapsedMs,
      wallClockBudgetMs: report.wallClockBudgetMs,
      totalToolCalls: report.totalToolCalls,
      totalTokens: report.totalTokens,
      terminationReason: this.code,
      completionKind: this.completionKind,
      toolCalls: report.toolCalls.map((call) => ({
        step: call.step,
        tool: call.tool,
        args: {},
        ok: call.ok,
        durationMs: call.durationMs,
        preview: call.ok ? "Tool completed; payload omitted." : "Tool failed; payload omitted.",
      })),
      commandsRun: report.commandsRun.map((command) => ({
        step: command.step,
        argv: [],
        exitCode: command.exitCode,
        durationMs: command.durationMs,
        stdoutPreview: "",
        stderrPreview: "",
      })),
      checkResults: report.checkResults.map((check) => ({
        id: check.id,
        label: check.id,
        passed: check.passed,
        durationMs: check.durationMs,
        message: check.passed ? "Previously passed." : "Previously failed.",
      })),
      skillsLoaded: [...(report.skillsLoaded ?? [])],
      ...(report.senseCalls === undefined ? {} : { senseCalls: { ...report.senseCalls } }),
      ...(report.creativeCalls === undefined ? {} : { creativeCalls: { ...report.creativeCalls } }),
    };
  }
}

export function buildAgentModelFailureReport(
  failure: AgentModelRequestError,
  userRequest: string,
): TaskReport {
  return {
    userRequest,
    // These describe committed output, not whether a tool already edited a container.
    filesCreated: [],
    filesChanged: [],
    filesRemoved: [],
    previewUpdated: false,
    warnings: [
      "Run incomplete. Earlier file edits may still be present and have not been accepted as a completed build.",
    ],
    integrationsNeeded: [],
    summary: failure.message,
    failureEvidence: failure.failureEvidence,
    ...(failure.loopReport === undefined ? {} : { agentLoop: failure.loopReport }),
    suggestions:
      failure.code === "agent_model_request_rejected"
        ? ["Ask an administrator to check provider access before retrying."]
        : [
            "Review any earlier file edits before continuing.",
            "Continue with one smaller implementation step while retaining all original requirements.",
          ],
  };
}

export type AgentModelRequestOptions<T> = {
  signal: AbortSignal;
  startedAt: number;
  deadlineAt: number;
  context: Pick<AgentModelRequestDiagnostic, "taskId" | "projectId" | "stage" | "step">;
  /** Shared across every model turn in one run, including successful recovery. */
  recovery: { used: boolean };
  request: (signal: AbortSignal) => Promise<T>;
  onRecovery: (hint: string) => void;
  onDiagnostic?: (diagnostic: AgentModelRequestDiagnostic) => void;
};

function diagnostic(
  input: AgentModelRequestOptions<unknown>,
  attempt: number,
  requestTimeoutMs: number,
  classification: AgentModelRequestDiagnostic["classification"],
  recoveryScheduled = false,
  httpStatus?: number,
): AgentModelRequestDiagnostic {
  return {
    ...input.context,
    phase: "model-request",
    attempt,
    requestTimeoutMs,
    elapsedMs: Math.max(0, Date.now() - input.startedAt),
    remainingMs: Math.max(0, input.deadlineAt - Date.now()),
    classification,
    recoveryAttempted: input.recovery.used,
    recoveryScheduled,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  };
}

function emitDiagnostic(
  input: AgentModelRequestOptions<unknown>,
  value: AgentModelRequestDiagnostic,
): void {
  try {
    input.onDiagnostic?.(value);
  } catch {
    // Telemetry must not replace the primary failure or trigger another request.
  }
}

/** Stop awaiting even if a provider adapter ignores abort; consume any late rejection. */
function requestWithinSignal<T>(
  request: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    void Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return request(signal);
      })
      .then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          if (signal.aborted) reject(signal.reason);
          else resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
  });
}

export async function runAgentModelRequest<T>(input: AgentModelRequestOptions<T>): Promise<T> {
  // Only the timeout branch can continue, and it spends the one run-level recovery token first.
  for (let attempt = 1; ; attempt++) {
    input.signal.throwIfAborted();
    const requestTimeoutMs = Math.max(
      0,
      Math.min(
        AGENT_MODEL_REQUEST_TIMEOUT_MS,
        Math.floor(input.deadlineAt - Date.now() - CLEANUP_RESERVE_MS),
      ),
    );
    if (requestTimeoutMs === 0) {
      const evidence = diagnostic(input, attempt, 0, "run-budget-exhausted");
      emitDiagnostic(input, evidence);
      throw new AgentModelRequestError("agent_model_run_budget_exhausted", evidence);
    }

    const deadline = new AbortController();
    const signal = AbortSignal.any([input.signal, deadline.signal]);
    const timer = setTimeout(
      () => deadline.abort(new DOMException("Model request deadline elapsed", "TimeoutError")),
      requestTimeoutMs,
    );
    let requestError: unknown;
    try {
      const response = await requestWithinSignal(input.request, signal);
      signal.throwIfAborted();
      return response;
    } catch (error) {
      requestError = error;
    } finally {
      clearTimeout(timer);
    }

    // An explicit caller stop always wins, even when it races the local deadline.
    input.signal.throwIfAborted();
    const errorName = requestError instanceof Error ? requestError.name : "";
    const constructorName = requestError instanceof Error ? requestError.constructor.name : "";
    const timedOut =
      deadline.signal.aborted ||
      errorName === "TimeoutError" ||
      errorName === "APIConnectionTimeoutError" ||
      constructorName === "APIConnectionTimeoutError";
    if (timedOut) {
      const enoughTime =
        input.deadlineAt - Date.now() - CLEANUP_RESERVE_MS >= MIN_RECOVERY_REQUEST_MS;
      const recover = !input.recovery.used && enoughTime;
      const evidence = diagnostic(
        input,
        attempt,
        requestTimeoutMs,
        enoughTime ? "request-timeout" : "run-budget-exhausted",
        recover,
      );
      emitDiagnostic(input, evidence);
      if (recover) {
        input.recovery.used = true;
        input.onRecovery(AGENT_MODEL_RECOVERY_HINT);
        continue;
      }
      throw new AgentModelRequestError(
        enoughTime ? "agent_model_request_timeout" : "agent_model_run_budget_exhausted",
        evidence,
      );
    }

    const status =
      typeof requestError === "object" && requestError !== null && "status" in requestError
        ? requestError.status
        : undefined;
    if (status === 401 || status === 403) {
      const evidence = diagnostic(
        input,
        attempt,
        requestTimeoutMs,
        "access-rejected",
        false,
        status,
      );
      emitDiagnostic(input, evidence);
      throw new AgentModelRequestError("agent_model_request_rejected", evidence);
    }
    if (
      errorName === "AbortError" ||
      errorName === "APIUserAbortError" ||
      constructorName === "APIUserAbortError"
    ) {
      const evidence = diagnostic(input, attempt, requestTimeoutMs, "unattributed-abort");
      emitDiagnostic(input, evidence);
      throw new AgentModelRequestError("agent_model_request_aborted", evidence);
    }
    // Preserve existing circuit-breaker, container, rate-limit, and other failure handling.
    throw requestError;
  }
}
