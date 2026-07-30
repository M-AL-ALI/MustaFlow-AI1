import type { TaskReport } from "@workspace/db";

type ArchitectReview = NonNullable<TaskReport["architectReview"]>;

export type ReportLinkQuery = (text: string, values: unknown[]) => Promise<unknown>;

export const PERSIST_ARCHITECT_AUTO_FIX_LINK_SQL = `
  UPDATE agent_tasks
  SET report = jsonb_set(
    COALESCE(report, '{}'::jsonb),
    '{architectReview}',
    $2::jsonb,
    true
  )
  WHERE id = $1
`;

/**
 * Persist the parent -> recovery-task association without replacing any other
 * top-level report fields. This remains safe when the recovery task is queued
 * after an earlier report write: jsonb_set updates only architectReview.
 */
export async function persistArchitectAutoFixLink({
  taskId,
  architectReview,
  query,
}: {
  taskId: number;
  architectReview: ArchitectReview;
  query: ReportLinkQuery;
}): Promise<boolean> {
  const autoFixTaskId = architectReview.autoFixTaskId;
  if (!architectReview.autoFixQueued || !Number.isInteger(autoFixTaskId)) {
    return false;
  }

  await query(PERSIST_ARCHITECT_AUTO_FIX_LINK_SQL, [taskId, JSON.stringify(architectReview)]);
  return true;
}
