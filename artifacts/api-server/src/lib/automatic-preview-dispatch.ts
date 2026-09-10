import { pool } from "@workspace/db";
import { assetR2Configured } from "./asset-r2";
import {
  durableEnqueueRawResult,
  getDurableWorkerReadiness,
  registerRequiredWorker,
  type DurableWorkerRegistrationReceipt,
} from "./durable-queue";
import { logger } from "./logger";
import {
  automaticPreviewKey,
  AUTOMATIC_PREVIEW_MAX_ATTEMPTS,
  AUTOMATIC_PREVIEW_SOURCE,
  type AutomaticPreviewTarget,
} from "./automatic-preview-capture";
import { automaticPreviewRollout } from "./automatic-preview-admission";
import { runAutomaticProjectPreview } from "./automatic-preview-storage";

export { automaticPreviewRollout } from "./automatic-preview-admission";
export const QUEUE_AUTOMATIC_PROJECT_PREVIEW = "mustaflow.automatic-project-preview";
const PAGE_SIZE = 20;
type Scan = { after: number; through: number | null };
type Candidate = { project_id: number; version_id: number; scan_id: number; scan_end: number };
const captureScan: Scan = { after: 0, through: null };
const cleanupScan: Scan = { after: 0, through: null };

/** Each sweep freezes its upper bound so new arrivals cannot postpone wrapping. */
function advance(scan: Scan, rows: Candidate[]): void {
  const last = rows.at(-1);
  const through = scan.through ?? rows[0]?.scan_end ?? null;
  if (!last || rows.length < PAGE_SIZE || (through !== null && last.scan_id >= through)) {
    scan.after = 0;
    scan.through = null;
  } else {
    scan.after = last.scan_id;
    scan.through = through;
  }
}

const captureSql = `
  SELECT p.id AS project_id, v.id AS version_id, v.id AS scan_id,
         MAX(v.id) OVER () AS scan_end
    FROM projects p JOIN project_versions v ON v.project_id=p.id
   WHERE p.deleted_at IS NULL AND p.container_status='running'
     AND v.created_at >= $1 AND v.sealed_release->>'state'='accepted'
     AND v.id > $5 AND ($6::integer IS NULL OR v.id <= $6)
     AND v.id=(SELECT MAX(current.id) FROM project_versions current WHERE current.project_id=p.id)
     AND EXISTS (
       SELECT 1 FROM agent_tasks task WHERE task.project_id=p.id
         AND task.terminal->>'schema'='zero-terminal-v1'
         AND task.terminal->>'outcome'='mutation_succeeded'
         AND task.terminal->'evidence'->>'versionId'=v.id::text
         AND ($2::integer IS NULL OR task.id=$2)
     )
     AND NOT EXISTS (
       SELECT 1 FROM assets a WHERE a.project_id=p.id AND a.version_id=v.id
        AND a.product_scope='nabuflow' AND a.scope='project' AND a.kind='snapshot'
        AND a.owner_user_id=p.owner_id AND a.actor_user_id=p.owner_id
        AND a.source=$3 AND a.state IN ('ready','deleted','deleting')
     )
     AND (SELECT COUNT(*) FROM assets a WHERE a.project_id=p.id AND a.version_id=v.id
       AND a.product_scope='nabuflow' AND a.scope='project' AND a.kind='snapshot'
       AND a.owner_user_id=p.owner_id AND a.actor_user_id=p.owner_id AND a.source=$3) < $4
   ORDER BY v.id LIMIT 20
`;

// Cleanup is independent of capture rollout, latest version, running runtime and
// attempt budget. Retired projects remain the governed purge coordinator's job.
const cleanupSql = `
  SELECT p.id AS project_id, a.version_id, a.id AS scan_id,
         MAX(a.id) OVER () AS scan_end
    FROM assets a JOIN projects p ON p.id=a.project_id
   WHERE p.deleted_at IS NULL AND a.version_id IS NOT NULL
     AND a.product_scope='nabuflow' AND a.scope='project' AND a.kind='snapshot'
     AND a.owner_user_id=p.owner_id AND a.actor_user_id=p.owner_id AND a.source=$1
     AND a.id > $2 AND ($3::integer IS NULL OR a.id <= $3)
     AND (a.state IN ('reserved','uploading') OR
       (a.state='rejected' AND EXISTS (
         SELECT 1 FROM asset_storage_objects o WHERE o.asset_id=a.id AND o.state='deleting'
       )))
   ORDER BY a.id LIMIT 20
`;

function canDispatch(): boolean {
  return (
    assetR2Configured() &&
    getDurableWorkerReadiness(QUEUE_AUTOMATIC_PROJECT_PREVIEW).status === "ready"
  );
}

async function enqueueRows(rows: Candidate[], cleanupOnly: boolean): Promise<number> {
  let count = 0;
  for (const row of rows) {
    const target: AutomaticPreviewTarget = {
      projectId: row.project_id,
      versionId: row.version_id,
      ...(cleanupOnly ? { cleanupOnly: true } : {}),
    };
    const result = await durableEnqueueRawResult(
      QUEUE_AUTOMATIC_PROJECT_PREVIEW,
      target,
      automaticPreviewKey(target) + (cleanupOnly ? ":cleanup" : ""),
      { retryLimit: 3, retryDelay: 60, retryBackoff: true, dedupeMode: "active" },
    );
    if (result.status === "enqueued") count += 1;
  }
  return count;
}

async function enqueueCaptures(taskId: number | null): Promise<number> {
  const since = automaticPreviewRollout();
  if (!since || !canDispatch()) return 0;
  const scan = taskId === null ? captureScan : { after: 0, through: null };
  const result = await pool.query<Candidate>(captureSql, [
    since,
    taskId,
    AUTOMATIC_PREVIEW_SOURCE,
    AUTOMATIC_PREVIEW_MAX_ATTEMPTS,
    scan.after,
    scan.through,
  ]);
  const count = await enqueueRows(result.rows, false);
  if (taskId === null) advance(captureScan, result.rows);
  return count;
}

/** Optional latency optimization only; terminal rows remain the durable source. */
export function notifyAutomaticPreviewForTask(taskId: number): void {
  if (!automaticPreviewRollout() || !Number.isSafeInteger(taskId) || taskId < 1) return;
  void enqueueCaptures(taskId).catch(() => {
    logger.warn(
      { taskId, code: "automatic_preview_dispatch_deferred" },
      "Preview dispatch deferred; the durable terminal remains available",
    );
  });
}

export async function reconcileAutomaticProjectPreviews(): Promise<number> {
  if (!canDispatch()) return 0;
  const result = await pool.query<Candidate>(cleanupSql, [
    AUTOMATIC_PREVIEW_SOURCE,
    cleanupScan.after,
    cleanupScan.through,
  ]);
  const cleaned = await enqueueRows(result.rows, true);
  advance(cleanupScan, result.rows);
  return cleaned + (await enqueueCaptures(null));
}

let registration: Promise<DurableWorkerRegistrationReceipt> | null = null;
let cycle: Promise<DurableWorkerRegistrationReceipt | null> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let generation = 0;

async function ensureRegistration(): Promise<DurableWorkerRegistrationReceipt> {
  if (registration) return registration;
  const current = getDurableWorkerReadiness(QUEUE_AUTOMATIC_PROJECT_PREVIEW);
  if (current.status === "ready" || current.status === "registering") return current;
  registration = registerRequiredWorker(
    QUEUE_AUTOMATIC_PROJECT_PREVIEW,
    async (payload) => {
      const result = await runAutomaticProjectPreview({
        projectId: payload.projectId as number,
        versionId: payload.versionId as number,
        ...(payload.cleanupOnly === true ? { cleanupOnly: true } : {}),
      });
      logger.info(
        { projectId: payload.projectId, versionId: payload.versionId, result },
        "Automatic project preview receipt",
      );
    },
    {
      retryLimit: 3,
      retryDelay: 60,
      retryBackoff: true,
      queuePolicy: "exclusive",
      registrationAttempts: 3,
      registrationDelayMs: 250,
    },
  );
  try {
    return await registration;
  } finally {
    registration = null;
  }
}

function recover(): Promise<DurableWorkerRegistrationReceipt | null> {
  if (cycle) return cycle;
  if (!assetR2Configured()) return Promise.resolve(null);
  const startedGeneration = generation;
  cycle = (async () => {
    try {
      const receipt = await ensureRegistration();
      if (receipt.status === "ready" && timer && generation === startedGeneration) {
        await reconcileAutomaticProjectPreviews();
      }
      return receipt;
    } catch {
      logger.warn(
        { code: "automatic_preview_recovery_deferred" },
        "Preview registration and reconciliation will retry",
      );
      return null;
    } finally {
      cycle = null;
    }
  })();
  return cycle;
}

/** Start after migrations; cleanup recovery remains available with capture off. */
export function startAutomaticPreviewWorkerAfterMigrations(): Promise<DurableWorkerRegistrationReceipt | null> {
  if (!timer) {
    timer = setInterval(() => {
      void recover();
    }, 60_000);
    timer.unref?.();
  }
  return recover();
}

export function stopAutomaticPreviewReconciliation(): void {
  if (timer) clearInterval(timer);
  timer = null;
  generation += 1;
  captureScan.after = cleanupScan.after = 0;
  captureScan.through = cleanupScan.through = null;
}
