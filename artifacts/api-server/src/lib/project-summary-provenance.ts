import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { ProjectSummaryProvenance, ProjectSummarySourceKind } from "@workspace/db";

export interface ProjectSummaryProvenanceInput {
  sourceKind: ProjectSummarySourceKind;
  sourceIdentity: string;
  content: string;
  taskId?: number | null;
  versionId?: number | null;
  messageId?: number | null;
  sourceProjectId?: number | null;
  actorUserId?: string | null;
}

/**
 * Build provenance beside a project summary write. The database supplies the
 * receipt clock so app-host clock drift cannot change provenance ordering.
 */
export function projectSummaryProvenance(
  input: ProjectSummaryProvenanceInput,
): SQL<ProjectSummaryProvenance> {
  if (!input.sourceIdentity.trim()) {
    throw new Error("Project summary provenance requires a source identity");
  }
  const value = JSON.stringify({
    semantics: "project-summary-provenance-v1",
    sourceKind: input.sourceKind,
    sourceIdentity: input.sourceIdentity,
    taskId: input.taskId ?? null,
    versionId: input.versionId ?? null,
    messageId: input.messageId ?? null,
    sourceProjectId: input.sourceProjectId ?? null,
    actorUserId: input.actorUserId ?? null,
    contentSha256: createHash("sha256").update(input.content).digest("hex"),
  });
  return sql<ProjectSummaryProvenance>`${value}::jsonb || jsonb_build_object(
    'recordedAt', to_jsonb(CURRENT_TIMESTAMP)
  )`;
}
