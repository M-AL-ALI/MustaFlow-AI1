import { pool } from "@workspace/db";
import type { AutomaticPreviewTarget } from "./automatic-preview-capture";

/** No default epoch: existing or protected projects are never silently backfilled. */
export function automaticPreviewRollout(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): Date | null {
  if (env.NABUFLOW_AUTOMATIC_PREVIEWS_ENABLED !== "true") return null;
  const value = env.NABUFLOW_AUTOMATIC_PREVIEWS_SINCE;
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) return null;
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || epoch > now) return null;
  // Date.parse normalizes impossible dates; configuration must be literal UTC.
  const canonical = value.length === 20 ? value.replace("Z", ".000Z") : value;
  return new Date(epoch).toISOString() === canonical ? new Date(epoch) : null;
}

/** Evaluate again inside the lifecycle session, not just when a job was queued. */
export async function automaticPreviewAdmitted(target: AutomaticPreviewTarget): Promise<boolean> {
  const since = automaticPreviewRollout();
  if (!since || target.cleanupOnly) return false;
  const result = await pool.query<{ id: number }>(
    `SELECT v.id FROM projects p JOIN project_versions v ON v.project_id=p.id
      WHERE p.id=$2 AND v.id=$3 AND p.deleted_at IS NULL
        AND p.container_status='running' AND v.created_at >= $1
        AND v.sealed_release->>'state'='accepted'
        AND v.id=(SELECT MAX(current.id) FROM project_versions current WHERE current.project_id=p.id)
        AND EXISTS (SELECT 1 FROM agent_tasks task WHERE task.project_id=p.id
          AND task.terminal->>'schema'='zero-terminal-v1'
          AND task.terminal->>'outcome'='mutation_succeeded'
          AND task.terminal->'evidence'->>'versionId'=v.id::text)`,
    [since, target.projectId, target.versionId],
  );
  return result.rows.length === 1 && result.rows[0]!.id === target.versionId;
}
