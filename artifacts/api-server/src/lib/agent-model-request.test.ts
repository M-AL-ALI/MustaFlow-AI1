import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_MODEL_RECOVERY_HINT,
  AGENT_MODEL_REQUEST_TIMEOUT_MS,
  AgentModelRequestError,
  runAgentModelRequest,
  type AgentModelRequestOptions,
} from "./agent-model-request";

function options(
  request: AgentModelRequestOptions<string>["request"],
  overrides: Partial<AgentModelRequestOptions<string>> = {},
): AgentModelRequestOptions<string> {
  return {
    signal: new AbortController().signal,
    startedAt: Date.now(),
    deadlineAt: Date.now() + 600_000,
    context: { taskId: 316, projectId: 61, stage: "refine", step: 9 },
    recovery: { used: false },
    request,
    onRecovery: vi.fn(),
    onDiagnostic: vi.fn(),
    ...overrides,
  };
}

describe("bounded agent model-request recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T17:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("returns a normal response without recovery and clears its timer", async () => {
    const input = options(vi.fn().mockResolvedValue("ok"));
    await expect(runAgentModelRequest(input)).resolves.toBe("ok");
    expect(input.request).toHaveBeenCalledTimes(1);
    expect(input.onRecovery).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("changes only recovery guidance, retaining the original requirements and request closure", async () => {
    const brief = "Build the connected frontend and backend; notes must persist after refresh.";
    const messages = [brief];
    const seen: string[][] = [];
    const signals: AbortSignal[] = [];
    const request = vi.fn((signal: AbortSignal) => {
      seen.push([...messages]);
      signals.push(signal);
      return seen.length === 1 ? new Promise<string>(() => {}) : Promise.resolve("recovered");
    });
    const input = options(request, {
      onRecovery: vi.fn((hint: string) => {
        messages.push(hint);
      }),
    });
    const result = runAgentModelRequest(input);
    await vi.advanceTimersByTimeAsync(AGENT_MODEL_REQUEST_TIMEOUT_MS);
    await expect(result).resolves.toBe("recovered");
    expect(request).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([[brief], [brief, AGENT_MODEL_RECOVERY_HINT]]);
    expect(input.onRecovery).toHaveBeenCalledTimes(1);
    expect(AGENT_MODEL_RECOVERY_HINT).toContain("exactly ONE small tool call");
    expect(AGENT_MODEL_RECOVERY_HINT).toContain("without dropping any user requirement");
    expect(AGENT_MODEL_RECOVERY_HINT).toContain("persistent backend storage");
    expect(AGENT_MODEL_RECOVERY_HINT).toContain("SDK, provider, eligibility, security, and build");
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops after two timed-out calls, not three identical 180-second requests", async () => {
    const input = options(vi.fn(() => new Promise<string>(() => {})));
    const result = runAgentModelRequest(input).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2 * AGENT_MODEL_REQUEST_TIMEOUT_MS);
    const failure = await result;
    expect(failure).toBeInstanceOf(AgentModelRequestError);
    expect(failure).toMatchObject({
      code: "agent_model_request_timeout",
      retryable: false,
      failureEvidence: {
        evidence: {
          taskId: 316,
          projectId: 61,
          stage: "refine",
          phase: "model-request",
          attempt: 2,
          requestTimeoutMs: 180_000,
          recoveryAttempted: true,
          recoveryScheduled: false,
        },
      },
    });
    expect(input.request).toHaveBeenCalledTimes(2);
    expect(input.onRecovery).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("spends the recovery only once across later model turns", async () => {
    const recovery = { used: false };
    const request = vi
      .fn<AgentModelRequestOptions<string>["request"]>()
      .mockImplementationOnce(() => new Promise<string>(() => {}))
      .mockResolvedValueOnce("recovered")
      .mockImplementation(() => new Promise<string>(() => {}));
    const input = options(request, { recovery });
    const first = runAgentModelRequest(input);
    await vi.advanceTimersByTimeAsync(AGENT_MODEL_REQUEST_TIMEOUT_MS);
    await expect(first).resolves.toBe("recovered");
    const later = runAgentModelRequest(input).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(AGENT_MODEL_REQUEST_TIMEOUT_MS);
    expect(await later).toMatchObject({ code: "agent_model_request_timeout" });
    expect(request).toHaveBeenCalledTimes(3);
    expect(input.onRecovery).toHaveBeenCalledTimes(1);
  });

  it("caps a call by the remaining run budget and leaves time for failure persistence", async () => {
    const input = options(
      vi.fn(() => new Promise<string>(() => {})),
      {
        deadlineAt: Date.now() + 60_000,
      },
    );
    const result = runAgentModelRequest(input).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(55_000);
    expect(await result).toMatchObject({
      code: "agent_model_run_budget_exhausted",
      failureEvidence: { evidence: { requestTimeoutMs: 55_000, remainingMs: 5_000 } },
    });
    expect(input.request).toHaveBeenCalledTimes(1);
    expect(input.onRecovery).not.toHaveBeenCalled();
  });

  it("does not call the provider when no request budget remains", async () => {
    const input = options(vi.fn().mockResolvedValue("unexpected"), {
      deadlineAt: Date.now(),
    });
    await expect(runAgentModelRequest(input)).rejects.toMatchObject({
      code: "agent_model_run_budget_exhausted",
    });
    expect(input.request).not.toHaveBeenCalled();
  });

  it("recovers an incomplete response without returning its partial tool instructions", async () => {
    const input = options(
      vi.fn().mockResolvedValueOnce("partial").mockResolvedValueOnce("complete"),
      {
        isResponseComplete: (response) => response === "complete",
      },
    );
    await expect(runAgentModelRequest(input)).resolves.toBe("complete");
    expect(input.request).toHaveBeenCalledTimes(2);
    expect(input.onRecovery).toHaveBeenCalledWith(AGENT_MODEL_RECOVERY_HINT, "response-incomplete");
    expect(input.onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ classification: "response-incomplete", recoveryScheduled: true }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares one recovery allowance between truncated responses and timeouts", async () => {
    const input = options(
      vi
        .fn()
        .mockResolvedValueOnce("partial")
        .mockImplementation(() => new Promise<string>(() => {})),
      {
        isResponseComplete: () => false,
      },
    );
    const result = runAgentModelRequest(input).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(AGENT_MODEL_REQUEST_TIMEOUT_MS);
    expect(await result).toMatchObject({ code: "agent_model_request_timeout" });
    expect(input.request).toHaveBeenCalledTimes(2);
    expect(input.onRecovery).toHaveBeenCalledTimes(1);
  });

  it("fails closed after a second incomplete response and keeps routed diagnostics", async () => {
    const input = options(vi.fn().mockResolvedValue("partial"), {
      isResponseComplete: () => false,
      context: {
        projectId: 61,
        taskId: 317,
        stage: "refine",
        step: 13,
        provider: "openai",
        model: "selected-model",
      },
    });
    await expect(runAgentModelRequest(input)).rejects.toMatchObject({
      code: "agent_model_response_incomplete",
      failureEvidence: {
        evidence: {
          classification: "response-incomplete",
          provider: "openai",
          model: "selected-model",
          recoveryScheduled: false,
        },
      },
    });
    expect(input.request).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves an in-flight caller abort without retry or timeout attribution", async () => {
    const controller = new AbortController();
    const reason = new DOMException("User stopped the run", "AbortError");
    const input = options(
      vi.fn(() => new Promise<string>(() => {})),
      {
        signal: controller.signal,
      },
    );
    const result = runAgentModelRequest(input).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1);
    controller.abort(reason);
    expect(await result).toBe(reason);
    expect(input.request).toHaveBeenCalledTimes(1);
    expect(input.onRecovery).not.toHaveBeenCalled();
    expect(input.onDiagnostic).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start a request for an already stopped run", async () => {
    const controller = new AbortController();
    const reason = new DOMException("User stopped the run", "AbortError");
    controller.abort(reason);
    const input = options(vi.fn().mockResolvedValue("unexpected"), { signal: controller.signal });
    await expect(runAgentModelRequest(input)).rejects.toBe(reason);
    expect(input.request).not.toHaveBeenCalled();
  });

  it("classifies an explicit SDK timeout without relying on raw error text", async () => {
    const timeout = new Error("PRIVATE_PROVIDER_DETAIL");
    timeout.name = "APIConnectionTimeoutError";
    const input = options(vi.fn().mockRejectedValue(timeout));
    const failure = await runAgentModelRequest(input).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "agent_model_request_timeout" });
    expect(input.request).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(failure)).not.toContain("PRIVATE_PROVIDER_DETAIL");
  });

  it("does not equate an unattributed provider abort with a user stop or local timeout", async () => {
    const input = options(
      vi.fn().mockRejectedValue(new DOMException("PRIVATE_PROVIDER_DETAIL", "AbortError")),
    );
    const failure = await runAgentModelRequest(input).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "agent_model_request_aborted",
      failureEvidence: { evidence: { classification: "unattributed-abort" } },
    });
    expect(input.request).toHaveBeenCalledTimes(1);
    expect(input.onRecovery).not.toHaveBeenCalled();
    expect(JSON.stringify(failure)).not.toContain("PRIVATE_PROVIDER_DETAIL");
  });

  it.each([401, 403])("does not recover an access rejection (%s) as a timeout", async (status) => {
    const rejection = Object.assign(new Error("PRIVATE_PROVIDER_DETAIL"), { status });
    const input = options(vi.fn().mockRejectedValue(rejection));
    const failure = await runAgentModelRequest(input).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "agent_model_request_rejected",
      failureEvidence: { evidence: { httpStatus: status, classification: "access-rejected" } },
    });
    expect(input.request).toHaveBeenCalledTimes(1);
    expect(input.onRecovery).not.toHaveBeenCalled();
    expect(JSON.stringify(failure)).not.toContain("PRIVATE_PROVIDER_DETAIL");
  });

  it("leaves unrelated circuit-breaker and other errors to existing handling", async () => {
    const original = new Error("Existing circuit-breaker failure");
    original.name = "CircuitOpenError";
    const input = options(vi.fn().mockRejectedValue(original));
    await expect(runAgentModelRequest(input)).rejects.toBe(original);
    expect(input.request).toHaveBeenCalledTimes(1);
    expect(input.onRecovery).not.toHaveBeenCalled();
  });

  it("discards a late result from the timed-out attempt", async () => {
    let completeFirst!: (value: string) => void;
    const request = vi
      .fn<AgentModelRequestOptions<string>["request"]>()
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            completeFirst = resolve;
          }),
      )
      .mockResolvedValueOnce("recovered");
    const result = runAgentModelRequest(options(request));
    await vi.advanceTimersByTimeAsync(AGENT_MODEL_REQUEST_TIMEOUT_MS);
    await expect(result).resolves.toBe("recovered");
    completeFirst("late incomplete candidate");
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
  });
});
