/**
 * Task #746 — Real-time container log tailer.
 *
 * Polls the Fly.io GraphQL logs API for each agentic project's machine,
 * persists new lines into `container_logs`, and publishes them onto the
 * in-process event bus so SSE subscribers (the workspace Logs tab) get
 * a live feed.
 *
 * One tailer per project, tracked in an in-process Map so calling
 * `ensureContainerLogTailer` multiple times is a no-op once a tailer is
 * already running.
 *
 * Graceful degradation:
 *   - When FLY_API_TOKEN is missing, `ensureContainerLogTailer` no-ops.
 *   - When the GraphQL call fails transiently, the poll just sleeps and
 *     retries — no error propagation.
 */

import { db, projectsTable, containerLogsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { publishContainerLog } from "./event-bus";

const FLY_GRAPHQL_URL = "https://api.fly.io/graphql";
const FLY_TOKEN = process.env.FLY_API_TOKEN ?? "";
const FLY_APP = process.env.FLY_APP_NAME ?? "mustaflow-containers";
const POLL_INTERVAL_MS = 3000;

interface TailerHandle {
  projectId: number;
  machineId: string;
  timer: ReturnType<typeof setInterval>;
  nextToken: string | null;
  seenIds: Set<string>;
}

const tailers = new Map<number, TailerHandle>();

interface FlyLogNode {
  timestamp: string;
  message: string;
  level?: string;
  instance?: string;
}

interface FlyLogQueryResult {
  data?: {
    app?: {
      logs?: {
        nodes?: FlyLogNode[];
        nextToken?: string | null;
      };
    };
  };
  errors?: Array<{ message: string }>;
}

async function fetchFlyLogs(
  machineId: string,
  token: string | null,
): Promise<{ nodes: FlyLogNode[]; nextToken: string | null } | null> {
  if (!FLY_TOKEN) return null;
  try {
    const query = `
      query GetMachineLogs($appName: String!, $token: String, $vm: String) {
        app(name: $appName) {
          logs(token: $token, vm: $vm) {
            nodes { timestamp message level instance }
            nextToken
          }
        }
      }
    `;
    const res = await fetch(FLY_GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${FLY_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: { appName: FLY_APP, token, vm: machineId },
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as FlyLogQueryResult;
    const logs = data.data?.app?.logs;
    if (!logs) return null;
    return {
      nodes: logs.nodes ?? [],
      nextToken: logs.nextToken ?? null,
    };
  } catch (err) {
    logger.debug({ err, machineId }, "Fly logs fetch failed");
    return null;
  }
}

/**
 * Persist a single log line into `container_logs` and publish it on the
 * in-process bus so live SSE subscribers see it immediately.
 */
export async function recordContainerLog(
  projectId: number,
  level: "stdout" | "stderr" | "system",
  message: string,
): Promise<void> {
  try {
    const [row] = await db
      .insert(containerLogsTable)
      .values({ projectId, level, message })
      .returning({ id: containerLogsTable.id, createdAt: containerLogsTable.createdAt });
    if (row) {
      publishContainerLog({
        id: row.id,
        projectId,
        level,
        message,
        createdAt: row.createdAt,
      });
    }
  } catch (err) {
    logger.debug({ err, projectId }, "recordContainerLog failed (non-fatal)");
  }
}

async function pollOnce(handle: TailerHandle): Promise<void> {
  const result = await fetchFlyLogs(handle.machineId, handle.nextToken);
  if (!result) return;

  // Track recent line ids to suppress duplicates across overlapping polls.
  // Fly's nextToken does most of the de-duping, but a token reset (e.g.
  // first call after restart) can return overlapping rows.
  for (const node of result.nodes) {
    const key = `${node.timestamp}|${node.message.slice(0, 80)}`;
    if (handle.seenIds.has(key)) continue;
    handle.seenIds.add(key);
    const level: "stdout" | "stderr" | "system" =
      node.level === "stderr" || node.level === "error" ? "stderr" : "stdout";
    await recordContainerLog(handle.projectId, level, node.message);
  }
  // Cap the seen-set so it doesn't grow unbounded across hours of polling.
  if (handle.seenIds.size > 500) {
    handle.seenIds = new Set(Array.from(handle.seenIds).slice(-250));
  }
  handle.nextToken = result.nextToken;
}

/**
 * Start a tailer for `projectId`'s machine. Idempotent: if a tailer is
 * already running for this project, the call is a no-op. If the machine id
 * changes (rare — e.g. container destroy + recreate), call
 * `stopContainerLogTailer` first.
 */
export function ensureContainerLogTailer(projectId: number, machineId: string): void {
  if (!FLY_TOKEN) return;
  const existing = tailers.get(projectId);
  if (existing && existing.machineId === machineId) return;
  if (existing) {
    clearInterval(existing.timer);
    tailers.delete(projectId);
  }
  const handle: TailerHandle = {
    projectId,
    machineId,
    timer: setInterval(() => {
      void pollOnce(handle).catch(() => {
        /* swallow — best-effort */
      });
    }, POLL_INTERVAL_MS),
    nextToken: null,
    seenIds: new Set(),
  };
  tailers.set(projectId, handle);
  // Kick off an immediate poll so the first lines show up without waiting
  // for the first interval tick.
  void pollOnce(handle).catch(() => {});
  logger.info({ projectId, machineId }, "Container log tailer started");
}

export function stopContainerLogTailer(projectId: number): void {
  const existing = tailers.get(projectId);
  if (!existing) return;
  clearInterval(existing.timer);
  tailers.delete(projectId);
  logger.info({ projectId }, "Container log tailer stopped");
}

/**
 * Boot recovery: start a tailer for every agentic project that has a
 * containerId. Safe to call multiple times; only starts missing tailers.
 */
export async function resumeContainerLogTailersOnBoot(): Promise<void> {
  if (!FLY_TOKEN) return;
  try {
    const rows = await db
      .select({ id: projectsTable.id, containerId: projectsTable.containerId })
      .from(projectsTable)
      .where(eq(projectsTable.builderMode, "agentic"));
    let started = 0;
    for (const row of rows) {
      if (!row.containerId) continue;
      ensureContainerLogTailer(row.id, row.containerId);
      started++;
    }
    if (started > 0) {
      logger.info({ count: started }, "Resumed container log tailers on boot");
    }
  } catch (err) {
    logger.warn({ err }, "resumeContainerLogTailersOnBoot failed (non-fatal)");
  }
}
