import { and, eq, isNull, sql } from "drizzle-orm";
import {
  assetsTable,
  assetStorageObjectsTable,
  assetUsageTable,
  db,
  projectsTable,
  type ProductScope,
} from "@workspace/db";
import { PROJECT_LIFECYCLE_LOCK_NAMESPACE } from "./project-retirement-contract";
import {
  AssetProductScopeError,
  EXPLICIT_PROJECT_ASSET_USE_CONSUMER,
} from "./asset-platform-scope";

type AssetScopeTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type ProjectUseInput = {
  actorUserId: string;
  assetId: number;
  targetProjectId: number;
  productScope: ProductScope;
};

/** Uses the caller's file-mutation transaction; automatic histories never grant reuse. */
async function admitProjectAssetUse(
  tx: AssetScopeTransaction,
  input: ProjectUseInput,
  explicit: boolean,
): Promise<void> {
  if (
    input.productScope !== "nabuflow" ||
    !input.actorUserId ||
    !Number.isSafeInteger(input.assetId) ||
    input.assetId < 1 ||
    !Number.isSafeInteger(input.targetProjectId) ||
    input.targetProjectId < 1
  ) {
    throw new AssetProductScopeError();
  }
  const [candidate] = await tx
    .select({ projectId: assetsTable.projectId })
    .from(assetsTable)
    .where(eq(assetsTable.id, input.assetId));
  if (!candidate) throw new AssetProductScopeError();
  const projectIds = [
    ...new Set([
      input.targetProjectId,
      ...(candidate.projectId === null ? [] : [candidate.projectId]),
    ]),
  ].sort((a, b) => a - b);
  // Lifecycle/project locks precede assets, storage rows and physical key locks.
  for (const projectId of projectIds) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(
      ${PROJECT_LIFECYCLE_LOCK_NAMESPACE}, ${projectId})`);
    const [project] = await tx
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)))
      .for("share");
    if (!project) throw new AssetProductScopeError();
  }
  const { checkProjectAccess } = await import("./auth");
  if (
    (await checkProjectAccess(input.actorUserId, input.targetProjectId, "member")) !== "granted"
  ) {
    throw new AssetProductScopeError();
  }
  const [asset] = await tx
    .select()
    .from(assetsTable)
    .where(
      and(
        eq(assetsTable.id, input.assetId),
        eq(assetsTable.productScope, input.productScope),
        eq(assetsTable.state, "ready"),
      ),
    )
    .for("share");
  if (!asset || (asset.projectId !== null && !projectIds.includes(asset.projectId))) {
    throw new AssetProductScopeError();
  }
  const objects = await tx
    .select({ storageKey: assetStorageObjectsTable.storageKey })
    .from(assetStorageObjectsTable)
    .where(eq(assetStorageObjectsTable.assetId, asset.id))
    .orderBy(sql`${assetStorageObjectsTable.storageKey} COLLATE "C"`)
    .for("share");
  const keys = [...new Set([asset.storageKey, ...objects.map((row) => row.storageKey)])].sort(
    (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)),
  );
  for (const key of keys) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(
      hashtextextended('nabuflow:durable-object:' || ${key}, 0))`);
  }
  const claims = await tx.execute(sql`SELECT EXISTS (
    SELECT 1 FROM durable_asset_deletion_claims
    WHERE storage_key IN (${sql.join(
      keys.map((key) => sql`${key}`),
      sql`, `,
    )})
  ) AS claimed`);
  if (claims.rows[0]?.claimed !== false) throw new AssetProductScopeError();
  const [grant] = await tx
    .select({ id: assetUsageTable.id })
    .from(assetUsageTable)
    .where(
      and(
        eq(assetUsageTable.assetId, asset.id),
        eq(assetUsageTable.projectId, input.targetProjectId),
        eq(assetUsageTable.consumer, EXPLICIT_PROJECT_ASSET_USE_CONSUMER),
        isNull(assetUsageTable.artifactId),
        isNull(assetUsageTable.versionId),
        isNull(assetUsageTable.filePath),
      ),
    );
  const alreadyPermitted = asset.projectId === input.targetProjectId || grant !== undefined;
  if (!alreadyPermitted && (!explicit || asset.ownerUserId !== input.actorUserId)) {
    throw new AssetProductScopeError();
  }
  // Membership is rechecked after lock waits, before inserting the explicit grant.
  if (
    (await checkProjectAccess(input.actorUserId, input.targetProjectId, "member")) !== "granted"
  ) {
    throw new AssetProductScopeError();
  }
  if (explicit) {
    await tx
      .insert(assetUsageTable)
      .values({
        assetId: asset.id,
        projectId: input.targetProjectId,
        artifactId: null,
        versionId: null,
        filePath: null,
        consumer: EXPLICIT_PROJECT_ASSET_USE_CONSUMER,
      })
      .onConflictDoNothing();
  }
}
export async function grantExplicitProjectAssetUse(
  tx: AssetScopeTransaction,
  input: ProjectUseInput,
): Promise<void> {
  await admitProjectAssetUse(tx, input, true);
}
export async function assertExistingProjectAssetUse(
  tx: AssetScopeTransaction,
  input: ProjectUseInput,
): Promise<void> {
  await admitProjectAssetUse(tx, input, false);
}
