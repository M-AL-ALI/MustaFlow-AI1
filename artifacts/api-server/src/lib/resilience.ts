/**
 * Reliability utilities — retry with exponential back-off and circuit breaker.
 *
 * Usage:
 *   // Wrap any async function with retries
 *   const result = await withRetry(() => openai.chat.completions.create(...), {
 *     maxAttempts: 3,
 *     baseDelayMs: 500,
 *     shouldRetry: isTransientError,
 *     label: "openai-chat",
 *   });
 *
 *   // Wrap with a circuit breaker
 *   const breaker = new CircuitBreaker("openai", { failureThreshold: 5 });
 *   const result = await breaker.call(() => openai.chat.completions.create(...));
 */

import { logger } from "./logger";

// ─────────────────────────────────────────────────────────────────────────────
// Retry with exponential back-off
// ─────────────────────────────────────────────────────────────────────────────

export interface RetryOptions {
  /** Maximum number of attempts (default 3). */
  maxAttempts?: number;
  /** Initial delay in ms before the first retry (default 500). Doubled on each retry. */
  baseDelayMs?: number;
  /** Maximum delay cap in ms (default 15 000). */
  maxDelayMs?: number;
  /** Jitter factor 0–1 applied to each delay (default 0.2). Prevents thundering herd. */
  jitter?: number;
  /** Return true if the error is retryable. Defaults to isTransientError. */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  /** Human-readable label for log lines. */
  label?: string;
  /** AbortSignal — if aborted, retries stop immediately. */
  signal?: AbortSignal;
}

/**
 * Returns true for errors that are likely transient and safe to retry:
 * - Network errors (ECONNRESET, ETIMEDOUT, ENOTFOUND, ECONNREFUSED)
 * - HTTP 429 (rate limited) and 5xx (server errors)
 * - OpenAI APIConnectionError / RateLimitError
 */
export function isTransientError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;

  // Node.js system errors
  const code = typeof e.code === "string" ? e.code : "";
  if (["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "ECONNREFUSED", "EPIPE"].includes(code)) {
    return true;
  }

  // HTTP status codes
  const status = typeof e.status === "number" ? e.status : 0;
  if (status === 429 || (status >= 500 && status < 600)) return true;

  // OpenAI SDK error names
  const name = typeof e.name === "string" ? e.name : "";
  if (["APIConnectionError", "RateLimitError", "InternalServerError"].includes(name)) return true;

  // Generic timeout
  const message = typeof e.message === "string" ? e.message.toLowerCase() : "";
  if (
    message.includes("timeout") ||
    message.includes("network") ||
    message.includes("econnreset")
  ) {
    return true;
  }

  return false;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    });
  });
}

/**
 * Execute fn with automatic retries on transient errors.
 * Throws after maxAttempts are exhausted.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 500,
    maxDelayMs = 15_000,
    jitter = 0.2,
    shouldRetry = isTransientError,
    label = "unknown",
    signal,
  } = opts;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) throw new Error("Aborted before attempt " + attempt);

    try {
      return await fn();
    } catch (err) {
      lastError = err;

      const isLast = attempt >= maxAttempts;
      const retryable = shouldRetry(err, attempt);

      if (isLast || !retryable) {
        if (!retryable) {
          logger.debug({ label, attempt, err }, "Non-retryable error — giving up");
        } else {
          logger.warn({ label, attempts: attempt }, "All retry attempts exhausted");
        }
        throw err;
      }

      const baseDelay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      const jitterMs = baseDelay * jitter * Math.random();
      const delay = Math.round(baseDelay + jitterMs);

      logger.warn({ label, attempt, maxAttempts, delayMs: delay, err }, "Retrying after error");
      await sleep(delay, signal);
    }
  }

  throw lastError;
}

// ─────────────────────────────────────────────────────────────────────────────
// Circuit Breaker
// ─────────────────────────────────────────────────────────────────────────────

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before opening (default 5). */
  failureThreshold?: number;
  /** Success count in half-open state to close again (default 2). */
  successThreshold?: number;
  /** How long the circuit stays open before switching to half-open (ms, default 30 s). */
  cooldownMs?: number;
  /** Called when the circuit transitions state. */
  onStateChange?: (from: CircuitState, to: CircuitState, name: string) => void;
}

/**
 * Circuit breaker protecting a downstream dependency.
 *
 * States:
 *   closed    → normal operation, failures counted
 *   open      → calls fail fast without invoking the function
 *   half-open → one probe call allowed; success → closed, failure → open
 */
export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures = 0;
  private successes = 0;
  private openedAt: number | null = null;

  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly cooldownMs: number;
  private readonly onStateChange?: CircuitBreakerOptions["onStateChange"];

  constructor(
    public readonly name: string,
    opts: CircuitBreakerOptions = {},
  ) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.successThreshold = opts.successThreshold ?? 2;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.onStateChange = opts.onStateChange;
  }

  get currentState(): CircuitState {
    return this.state;
  }

  /** True when the circuit is open and calls will fail-fast. */
  get isDegraded(): boolean {
    return this.state === "open";
  }

  private transition(to: CircuitState): void {
    const from = this.state;
    if (from === to) return;
    this.state = to;
    logger.warn({ circuit: this.name, from, to }, "Circuit breaker state transition");
    this.onStateChange?.(from, to, this.name);
  }

  private checkCooldown(): void {
    if (this.state === "open" && this.openedAt !== null) {
      if (Date.now() - this.openedAt >= this.cooldownMs) {
        this.successes = 0;
        this.transition("half-open");
      }
    }
  }

  /**
   * Call fn through the circuit breaker.
   * Throws CircuitOpenError when the circuit is open.
   */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    this.checkCooldown();

    if (this.state === "open") {
      throw new CircuitOpenError(this.name);
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    if (this.state === "half-open") {
      this.successes++;
      if (this.successes >= this.successThreshold) {
        this.transition("closed");
      }
    }
  }

  private onFailure(): void {
    this.failures++;
    if (this.state === "half-open" || this.failures >= this.failureThreshold) {
      this.openedAt = Date.now();
      this.transition("open");
      this.failures = 0;
    }
  }

  /** Force-reset the circuit to closed (useful in tests / admin actions). */
  reset(): void {
    this.failures = 0;
    this.successes = 0;
    this.openedAt = null;
    this.transition("closed");
  }

  toJSON() {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      openedAt: this.openedAt,
    };
  }
}

export class CircuitOpenError extends Error {
  readonly circuitName: string;
  constructor(name: string) {
    super(`Circuit breaker '${name}' is open — service degraded`);
    this.name = "CircuitOpenError";
    this.circuitName = name;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared circuit breakers (one per downstream dependency)
// ─────────────────────────────────────────────────────────────────────────────

export const openaiCircuit = new CircuitBreaker("openai", {
  failureThreshold: 5,
  cooldownMs: 30_000,
});

export const anthropicCircuit = new CircuitBreaker("anthropic", {
  failureThreshold: 5,
  cooldownMs: 30_000,
});

export const geminiCircuit = new CircuitBreaker("gemini", {
  failureThreshold: 5,
  cooldownMs: 30_000,
});

export const deepseekCircuit = new CircuitBreaker("deepseek", {
  failureThreshold: 5,
  cooldownMs: 30_000,
});

export const containerCircuit = new CircuitBreaker("fly-containers", {
  failureThreshold: 8,
  cooldownMs: 60_000,
});

export const stripeCircuit = new CircuitBreaker("stripe", {
  failureThreshold: 5,
  cooldownMs: 30_000,
});

/**
 * All active circuit breakers — used by the status endpoint to report
 * component-level health.
 */
export const ALL_BREAKERS = [
  openaiCircuit,
  anthropicCircuit,
  geminiCircuit,
  deepseekCircuit,
  containerCircuit,
  stripeCircuit,
];
