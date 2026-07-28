/**
 * Public status endpoint — GET /api/status
 *
 * Returns component-level health for API, Builder, Containers, Preview,
 * Publishing, and Auth. Auto-updated from live circuit-breaker state plus
 * lightweight DB and AI probes.
 *
 * Designed to power the public status page at /status.
 * No auth required — intentionally public.
 */

import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { ALL_BREAKERS } from "../lib/resilience";
import { getQueueStats } from "../lib/durable-queue";
import { logger } from "../lib/logger";

const router: IRouter = Router();

type ComponentStatus = "operational" | "degraded" | "outage" | "unknown";

interface ComponentHealth {
  name: string;
  status: ComponentStatus;
  latencyMs?: number;
  message?: string;
}

interface StatusResponse {
  status: "operational" | "degraded" | "outage";
  checkedAt: string;
  components: ComponentHealth[];
  slos: {
    availability: { target: number; description: string };
    aiJobFailureRate: { target: number; description: string };
    p95ChatResponse: { targetMs: number; description: string };
  };
}

async function checkDatabase(): Promise<ComponentHealth> {
  const start = Date.now();
  try {
    const client = await pool.connect();
    await client.query("SELECT 1");
    client.release();
    return { name: "Database", status: "operational", latencyMs: Date.now() - start };
  } catch (err) {
    logger.warn({ err }, "Status check: database probe failed");
    return {
      name: "Database",
      status: "outage",
      message: "DB probe failed",
      latencyMs: Date.now() - start,
    };
  }
}

function componentFromBreaker(displayName: string, breakerName: string): ComponentHealth {
  const breaker = ALL_BREAKERS.find((b) => b.name === breakerName);
  if (!breaker) return { name: displayName, status: "unknown" };
  const state = breaker.currentState;
  return {
    name: displayName,
    status: state === "closed" ? "operational" : state === "half-open" ? "degraded" : "outage",
    message: state !== "closed" ? `Circuit breaker: ${state}` : undefined,
  };
}

router.get("/status", async (_req, res): Promise<void> => {
  const [dbHealth, queueStats] = await Promise.allSettled([checkDatabase(), getQueueStats()]);

  const db =
    dbHealth.status === "fulfilled"
      ? dbHealth.value
      : { name: "Database", status: "outage" as ComponentStatus };

  const queueDepth =
    queueStats.status === "fulfilled"
      ? (queueStats.value.build?.active ?? 0) + (queueStats.value.refine?.active ?? 0)
      : 0;

  const components: ComponentHealth[] = [
    { name: "API", status: "operational" },
    db,
    componentFromBreaker("Nabuflow", "openai"),
    componentFromBreaker("Containers", "fly-containers"),
    {
      // Preview serving is tied to DB health (snapshots are DB-stored)
      name: "Preview",
      status: db.status === "operational" ? "operational" : "degraded",
      message: db.status !== "operational" ? "Depends on database" : undefined,
    },
    {
      // Publishing also depends on DB + AI builder circuit
      name: "Publishing",
      status:
        db.status === "outage"
          ? "outage"
          : componentFromBreaker("Nabuflow", "openai").status === "outage"
            ? "degraded"
            : "operational",
    },
    componentFromBreaker("Payments", "stripe"),
    {
      name: "Queue",
      status: "operational",
      message: `${queueDepth} active`,
    },
    {
      name: "Auth",
      status: process.env.CLERK_PUBLISHABLE_KEY ? "operational" : "unknown",
    },
  ];

  const hasOutage = components.some((c) => c.status === "outage");
  const hasDegraded = components.some((c) => c.status === "degraded");
  const overallStatus = hasOutage ? "outage" : hasDegraded ? "degraded" : "operational";

  const payload: StatusResponse = {
    status: overallStatus,
    checkedAt: new Date().toISOString(),
    components,
    slos: {
      availability: {
        target: 99.5,
        description: "API availability over 30-day rolling window (%)",
      },
      aiJobFailureRate: {
        target: 1,
        description: "AI builder job failure rate — target < 1%",
      },
      p95ChatResponse: {
        targetMs: 5000,
        description: "p95 chat-to-first-token latency — target < 5 s",
      },
    },
  };

  res.json(payload);
});

export default router;
