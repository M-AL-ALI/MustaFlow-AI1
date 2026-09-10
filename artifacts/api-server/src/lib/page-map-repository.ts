import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { db, projectsTable, projectFilesTable } from "@workspace/db";
import type { BuilderFile } from "./builder";
import type { PageMapData } from "./page-map";

export type PageMapSnapshot = { pageMapData: unknown };
export interface PageMapRepository {
  read(projectId: number): Promise<PageMapSnapshot | null>;
  readFiles(projectId: number): Promise<{ files: BuilderFile[]; revision: string }>;
  write(
    projectId: number,
    data: PageMapData,
    expectedMap: unknown,
    sourceRevision?: string,
  ): Promise<boolean>;
}

// A concurrency fingerprint, not a cryptographic proof of ownership. Reads and
// writes calculate it in the same SQL statement snapshot as the files they use.
export function pageMapFilesRevision(projectId: number): SQL<string> {
  return sql<string>`(select md5(coalesce(string_agg(length(${projectFilesTable.path})::text || ':' || ${projectFilesTable.path} || ':' || md5(${projectFilesTable.content}), '|' order by ${projectFilesTable.path} collate "C"), '')) from ${projectFilesTable} where ${projectFilesTable.projectId} = ${projectId})`;
}
export function pageMapSnapshotPredicate(expectedMap: unknown): SQL {
  // Both SQL NULL and JSONB null are empty maps in the read contract.
  return sql`coalesce(${projectsTable.pageMapData}, 'null'::jsonb) = ${JSON.stringify(expectedMap ?? null)}::jsonb`;
}
export const pageMapRepository: PageMapRepository = {
  async read(projectId) {
    const [project] = await db
      .select({ pageMapData: projectsTable.pageMapData })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));
    return project ?? null;
  },
  async readFiles(projectId) {
    const rows = await db
      .select({
        path: projectFilesTable.path,
        content: projectFilesTable.content,
        mimeType: projectFilesTable.mimeType,
        revision: pageMapFilesRevision(projectId),
      })
      .from(projectFilesTable)
      .where(eq(projectFilesTable.projectId, projectId));
    return {
      files: rows.map(({ path, content, mimeType }) => ({
        path,
        content,
        mimeType: mimeType ?? "text/plain",
      })),
      revision: rows[0]?.revision ?? "d41d8cd98f00b204e9800998ecf8427e",
    };
  },
  async write(projectId, data, expectedMap, sourceRevision) {
    const snapshotMatches = pageMapSnapshotPredicate(expectedMap);
    const changed = await db
      .update(projectsTable)
      .set({ pageMapData: data as unknown as Record<string, unknown>, updatedAt: sql`now()` })
      .where(
        and(
          eq(projectsTable.id, projectId),
          isNull(projectsTable.deletedAt),
          snapshotMatches,
          sourceRevision === undefined
            ? undefined
            : sql`${pageMapFilesRevision(projectId)} = ${sourceRevision}`,
        ),
      )
      .returning({ id: projectsTable.id });
    return changed.length === 1;
  },
};
