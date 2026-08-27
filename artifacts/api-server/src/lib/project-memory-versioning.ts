import { db, projectVersionsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import {
  deriveProjectMemoryVersionLineage,
  ZERO_MEMORY_VERSION_LINEAGE_LIMIT,
  type ProjectMemoryVersionLineage,
} from "./project-memory-versioning-contract";

export type { ProjectMemoryVersionLineage } from "./project-memory-versioning-contract";

type VersionSelectClient = Pick<typeof db, "select">;

export async function readProjectMemoryVersionLineage(
  projectId: number,
  client: VersionSelectClient = db,
): Promise<ProjectMemoryVersionLineage> {
  const rows = await client
    .select({
      id: projectVersionsTable.id,
      parentVersionId: projectVersionsTable.parentVersionId,
    })
    .from(projectVersionsTable)
    .where(eq(projectVersionsTable.projectId, projectId))
    .orderBy(desc(projectVersionsTable.createdAt), desc(projectVersionsTable.id))
    .limit(ZERO_MEMORY_VERSION_LINEAGE_LIMIT + 1);

  const currentVersionId = rows[0]?.id ?? null;
  return deriveProjectMemoryVersionLineage({
    currentVersionId,
    versions: rows.slice(0, ZERO_MEMORY_VERSION_LINEAGE_LIMIT),
    limited: rows.length > ZERO_MEMORY_VERSION_LINEAGE_LIMIT,
  });
}

export async function readCurrentProjectVersionId(
  projectId: number,
  client: VersionSelectClient = db,
): Promise<number | null> {
  const [head] = await client
    .select({ id: projectVersionsTable.id })
    .from(projectVersionsTable)
    .where(eq(projectVersionsTable.projectId, projectId))
    .orderBy(desc(projectVersionsTable.createdAt), desc(projectVersionsTable.id))
    .limit(1);
  return head?.id ?? null;
}
