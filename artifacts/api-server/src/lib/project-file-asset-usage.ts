import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { assetsTable, assetUsageTable, db } from "@workspace/db";
import {
  parseProjectFileAssetReference,
  PROJECT_FILE_ASSET_HISTORY_CONSUMER,
} from "./project-file-asset-reference";

export const PROJECT_FILE_ASSET_USAGE_CONSUMER = "project-file";

type ProjectFileAssetUsageTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const PROJECT_ASSET_CONTENT_URL_PATTERN =
  /\/api\/assets\/([1-9][0-9]*)\/content(?=$|[?#[\]{}()<>"'`\s,;:])/gu;

export function extractProjectFileAssetIds(content: string): number[] {
  const assetIds = new Set<number>();
  const directReference = parseProjectFileAssetReference(content);
  if (directReference) assetIds.add(directReference.assetId);
  for (const match of content.matchAll(PROJECT_ASSET_CONTENT_URL_PATTERN)) {
    const assetId = Number(match[1]);
    if (Number.isSafeInteger(assetId)) assetIds.add(assetId);
  }
  return [...assetIds];
}

/**
 * Rebuild one project-file consumer set from the content that will exist after
 * the caller's mutation. The caller must pass the transaction that performs
 * the file write so a failed usage update rolls the file mutation back too.
 */
export async function reconcileProjectFileAssetUsage(
  tx: ProjectFileAssetUsageTransaction,
  input: {
    projectId: number;
    artifactId: number | null;
    filePath: string;
    nextContent: string | null;
    /**
     * A trusted copy operation may retain references owned by the source
     * project while recording the new consumer against projectId.
     */
    referenceProjectId?: number;
  },
): Promise<void> {
  await tx.delete(assetUsageTable).where(
    and(
      eq(assetUsageTable.projectId, input.projectId),
      input.artifactId === null
        ? isNull(assetUsageTable.artifactId)
        : eq(assetUsageTable.artifactId, input.artifactId),
      eq(assetUsageTable.filePath, input.filePath),
      or(
        eq(assetUsageTable.consumer, PROJECT_FILE_ASSET_USAGE_CONSUMER),
        // Generated-image writes historically encoded the path in consumer.
        // Retire only that exact legacy identity while converging on the
        // canonical project-file consumer.
        eq(assetUsageTable.consumer, `${PROJECT_FILE_ASSET_USAGE_CONSUMER}:${input.filePath}`),
      ),
    ),
  );

  if (input.nextContent === null) return;
  const referencedAssetIds = extractProjectFileAssetIds(input.nextContent);
  if (referencedAssetIds.length === 0) return;

  const referenceProjectId = input.referenceProjectId ?? input.projectId;
  const readyAssets = await tx
    .select({ id: assetsTable.id, projectId: assetsTable.projectId })
    .from(assetsTable)
    .where(and(eq(assetsTable.state, "ready"), inArray(assetsTable.id, referencedAssetIds)));
  const historyPermissions = await tx
    .select({ assetId: assetUsageTable.assetId })
    .from(assetUsageTable)
    .where(
      and(
        eq(assetUsageTable.projectId, referenceProjectId),
        eq(assetUsageTable.consumer, PROJECT_FILE_ASSET_HISTORY_CONSUMER),
        inArray(assetUsageTable.assetId, referencedAssetIds),
      ),
    );
  const permittedAssetIds = new Set(historyPermissions.map((usage) => usage.assetId));
  const readyProjectAssets = readyAssets.filter(
    (asset) => asset.projectId === referenceProjectId || permittedAssetIds.has(asset.id),
  );
  const allowedAssetIds = new Set(readyProjectAssets.map((asset) => asset.id));
  if (referencedAssetIds.some((assetId) => !allowedAssetIds.has(assetId))) {
    throw new Error("project_file_asset_reference_unavailable");
  }

  await tx
    .insert(assetUsageTable)
    .values(
      readyProjectAssets.flatMap((asset) => [
        {
          assetId: asset.id,
          projectId: input.projectId,
          artifactId: input.artifactId,
          filePath: input.filePath,
          consumer: PROJECT_FILE_ASSET_USAGE_CONSUMER,
        },
        {
          assetId: asset.id,
          projectId: input.projectId,
          artifactId: null,
          filePath: null,
          consumer: PROJECT_FILE_ASSET_HISTORY_CONSUMER,
        },
      ]),
    )
    .onConflictDoNothing();
}
