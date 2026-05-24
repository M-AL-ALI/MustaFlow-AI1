/**
 * Prometheus-style metrics using prom-client.
 *
 * Exposes: HTTP request duration, AI call latency, queue depth, circuit breaker
 * states, credit deductions, and container exec latency.
 *
 * The /api/metrics endpoint serves the Prometheus text format.
 * Grafana / Prometheus scrapes this endpoint every 15s.
 *
 * All metrics are registered on the default registry.
 */

import { Registry, collectDefaultMetrics, Counter, Histogram, Gauge } from "prom-client";

export const registry = new Registry();

// Node.js default metrics (event loop lag, GC, memory, file descriptors, etc.)
collectDefaultMetrics({ register: registry });

// ─────────────────────────────────────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────────────────────────────────────

export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status_code"] as const,
  registers: [registry],
});

// ─────────────────────────────────────────────────────────────────────────────
// AI builder
// ─────────────────────────────────────────────────────────────────────────────

export const aiCallDuration = new Histogram({
  name: "ai_call_duration_seconds",
  help: "Duration of OpenAI chat completion calls",
  labelNames: ["agent_mode", "pipeline", "status"] as const,
  buckets: [0.5, 1, 2, 5, 10, 20, 40, 80, 120, 240],
  registers: [registry],
});

export const aiCallsTotal = new Counter({
  name: "ai_calls_total",
  help: "Total AI builder calls",
  labelNames: ["agent_mode", "pipeline", "status"] as const,
  registers: [registry],
});

export const agentLoopStepsTotal = new Counter({
  name: "agent_loop_steps_total",
  help: "Total agentic loop tool-call steps",
  labelNames: ["agent_mode", "tool"] as const,
  registers: [registry],
});

// ─────────────────────────────────────────────────────────────────────────────
// Job queue
// ─────────────────────────────────────────────────────────────────────────────

export const jobQueueDepth = new Gauge({
  name: "job_queue_depth",
  help: "Number of jobs currently in the queue (pending + active)",
  registers: [registry],
});

export const jobsTotal = new Counter({
  name: "jobs_total",
  help: "Total jobs processed",
  labelNames: ["kind", "status", "agent_mode", "pipeline"] as const,
  registers: [registry],
});

export const jobDuration = new Histogram({
  name: "job_duration_seconds",
  help: "Duration of builder jobs from queue to completion",
  labelNames: ["kind", "agent_mode", "pipeline"] as const,
  buckets: [1, 5, 10, 20, 40, 80, 120, 240, 480],
  registers: [registry],
});

// ─────────────────────────────────────────────────────────────────────────────
// Circuit breakers
// ─────────────────────────────────────────────────────────────────────────────

export const circuitBreakerState = new Gauge({
  name: "circuit_breaker_state",
  help: "Circuit breaker state: 0=closed, 1=half-open, 2=open",
  labelNames: ["circuit"] as const,
  registers: [registry],
});

function circuitStateToNum(state: "closed" | "half-open" | "open"): number {
  return state === "closed" ? 0 : state === "half-open" ? 1 : 2;
}

/** Update all circuit breaker gauges from the ALL_BREAKERS registry. */
export function updateCircuitBreakerMetrics(): void {
  try {
    // Dynamic import to avoid circular dep (resilience imports logger, metrics is standalone)
    void import("./resilience").then(({ ALL_BREAKERS }) => {
      for (const b of ALL_BREAKERS) {
        circuitBreakerState.set({ circuit: b.name }, circuitStateToNum(b.currentState));
      }
    });
  } catch {
    // non-fatal
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Credits / billing
// ─────────────────────────────────────────────────────────────────────────────

export const creditsDeductedTotal = new Counter({
  name: "credits_deducted_total",
  help: "Total credits deducted across all builds",
  labelNames: ["agent_mode", "type"] as const,
  registers: [registry],
});

// ─────────────────────────────────────────────────────────────────────────────
// Container exec
// ─────────────────────────────────────────────────────────────────────────────

export const containerExecDuration = new Histogram({
  name: "container_exec_duration_seconds",
  help: "Duration of Fly.io container exec calls",
  labelNames: ["ok"] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300],
  registers: [registry],
});

// ─────────────────────────────────────────────────────────────────────────────
// SLO helpers — expose derived metrics for alerting rules
// ─────────────────────────────────────────────────────────────────────────────

export const sloViolationsTotal = new Counter({
  name: "slo_violations_total",
  help: "Number of SLO violations detected (latency > p95 target, error budget burns, etc.)",
  labelNames: ["slo", "reason"] as const,
  registers: [registry],
});
