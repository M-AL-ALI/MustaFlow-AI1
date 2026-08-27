import { and, eq, isNull, or } from "drizzle-orm";
import { db, projectArtifactsTable, projectFilesTable, type ProjectArtifact } from "@workspace/db";
import { selectPrimaryArtifactFiles, type PrimaryArtifactFile } from "./primary-artifact-files";

/**
 * Resolve which artifact a file write/read should be scoped to (Task #544).
 *
 * Caller priority:
 *   1. explicit hint (validated to belong to the same project)
 *   2. the project's is_primary=true artifact
 *
 * Returns null only if the project has no active artifacts (which should never
 * happen post-migration). Callers may treat null as "skip stamping" for
 * backward compatibility with the nullable column.
 */
export async function resolvePrimaryArtifactId(projectId: number): Promise<number | null> {
  const [primary] = await db
    .select({ id: projectArtifactsTable.id })
    .from(projectArtifactsTable)
    .where(
      and(
        eq(projectArtifactsTable.projectId, projectId),
        eq(projectArtifactsTable.isPrimary, true),
        isNull(projectArtifactsTable.deletedAt),
      ),
    )
    .limit(1);
  return primary?.id ?? null;
}

export async function resolveArtifactId(
  projectId: number,
  hint: number | null | undefined,
): Promise<number | null> {
  if (hint && Number.isFinite(hint)) {
    const [row] = await db
      .select({ id: projectArtifactsTable.id })
      .from(projectArtifactsTable)
      .where(
        and(
          eq(projectArtifactsTable.id, hint),
          eq(projectArtifactsTable.projectId, projectId),
          isNull(projectArtifactsTable.deletedAt),
        ),
      )
      .limit(1);
    if (row) return row.id;
  }
  return resolvePrimaryArtifactId(projectId);
}

/**
 * Load the complete file set for the project's primary artifact.
 *
 * Legacy unscoped rows are the base layer for projects created during the
 * artifact migration. Scoped primary rows override matching base paths.
 * Sibling artifact rows never cross this boundary. The pure selector repeats
 * that boundary in memory and applies the exact UTF-8 ordering required by
 * the trusted-build contract.
 */
export async function loadPrimaryArtifactFiles(projectId: number): Promise<PrimaryArtifactFile[]> {
  const primaryArtifactId = await resolvePrimaryArtifactId(projectId);
  const artifactScope =
    primaryArtifactId === null
      ? isNull(projectFilesTable.artifactId)
      : or(
          isNull(projectFilesTable.artifactId),
          eq(projectFilesTable.artifactId, primaryArtifactId),
        );
  const rows = await db
    .select({
      projectId: projectFilesTable.projectId,
      artifactId: projectFilesTable.artifactId,
      path: projectFilesTable.path,
      content: projectFilesTable.content,
      mimeType: projectFilesTable.mimeType,
    })
    .from(projectFilesTable)
    .where(and(eq(projectFilesTable.projectId, projectId), artifactScope));

  return selectPrimaryArtifactFiles(rows, projectId, primaryArtifactId);
}

export async function listProjectArtifacts(projectId: number): Promise<ProjectArtifact[]> {
  return db
    .select()
    .from(projectArtifactsTable)
    .where(
      and(eq(projectArtifactsTable.projectId, projectId), isNull(projectArtifactsTable.deletedAt)),
    );
}

/**
 * Builds a short, human-readable summary of the project's sibling artifacts
 * (kind, name, slug + first 8 file paths) for injection into builder system
 * prompts so the agent can reason cross-artifact.
 */
export async function buildSiblingArtifactContext(
  projectId: number,
  activeArtifactId: number | null,
): Promise<string | null> {
  const artifacts = await listProjectArtifacts(projectId);
  const siblings = artifacts.filter((a) => a.id !== activeArtifactId);
  if (siblings.length === 0) return null;

  // Lazy import to avoid circular deps
  const { projectFilesTable } = await import("@workspace/db");
  const lines: string[] = [
    "Sibling artifacts in this project (cross-artifact reasoning is allowed; mention them when relevant):",
  ];
  for (const sib of siblings) {
    const files = await db
      .select({ path: projectFilesTable.path })
      .from(projectFilesTable)
      .where(eq(projectFilesTable.artifactId, sib.id))
      .limit(8);
    const paths = files.map((f) => f.path).join(", ");
    lines.push(
      `- "${sib.name}" (kind=${sib.kind}, slug=${sib.slug})${paths ? ` — files: ${paths}` : " — no files yet"}`,
    );
  }
  return lines.join("\n");
}
