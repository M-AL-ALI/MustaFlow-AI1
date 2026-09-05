import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { productionDatabaseAllocationIdentity } from "@workspace/tenant-runtime-contracts";

type CaseId =
  | "writer-first-image"
  | "writer-first-upload"
  | "writer-first-foreign-image"
  | "purge-first-image"
  | "purge-first-upload"
  | "retention-nabuflow"
  | "retention-ora"
  | "unknown-image"
  | "unknown-upload"
  | "alias-only-full"
  | "alias-only-thumb"
  | "admission-upload"
  | "remapped-upload"
  | "claim-unshared-image"
  | "quoted-writer-image"
  | "delete-unshared-upload"
  | "unknown-unbound-image"
  | "known-unbound-image"
  | "scope-same-owner-upload"
  | "scope-cross-owner-upload"
  | "raw-taskless-same-owner-upload"
  | "raw-taskless-cross-owner-upload"
  | "soft-deleted-image"
  | "retained-legacy-upload";

type SeededFixture = {
  tag: string;
  sourceId: number;
  targetId: number;
  assetId: number;
  assetProjectId: number | null;
  aliasId: number;
  kind: "image" | "upload";
  storageKey: string;
  aliasStorageKey: string;
  operationId: string;
  retirementId: string;
  owner: string;
  productScope: "nabuflow" | "ora" | null;
  explicitGrant: boolean;
  historicalFileId: number | null;
  historicalContent: string | null;
};

type FixtureManifest = {
  version: 1;
  database: string;
  expectedTestCount: 27;
  epoch: string;
  fixtures: Record<CaseId, SeededFixture>;
};

const CASES: readonly CaseId[] = [
  "writer-first-image",
  "writer-first-upload",
  "writer-first-foreign-image",
  "purge-first-image",
  "purge-first-upload",
  "retention-nabuflow",
  "retention-ora",
  "unknown-image",
  "unknown-upload",
  "alias-only-full",
  "alias-only-thumb",
  "admission-upload",
  "remapped-upload",
  "claim-unshared-image",
  "quoted-writer-image",
  "delete-unshared-upload",
  "unknown-unbound-image",
  "known-unbound-image",
  "scope-same-owner-upload",
  "scope-cross-owner-upload",
  "raw-taskless-same-owner-upload",
  "raw-taskless-cross-owner-upload",
  "soft-deleted-image",
  "retained-legacy-upload",
];

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * Test-only supervisor entry point. Call inside the PARENT'S BEGIN/COMMIT,
 * after raw Drizzle bootstrap and before the FIRST startup migration.
 * Never imports the app pool, runs DDL, disables guards, or activates an epoch.
 */
export async function seedProjectPurgeAssetPostgresFixtures(
  client: PoolClient,
): Promise<FixtureManifest> {
  const identity = await client.query<{
    database: string;
    host: string;
    outer_transaction: boolean;
  }>(
    "SELECT current_database() AS database, host(inet_server_addr()) AS host, " +
      "transaction_timestamp() < statement_timestamp() AS outer_transaction",
  );
  const connection = identity.rows[0];
  if (
    identity.rows.length !== 1 ||
    connection?.host !== "127.0.0.1" ||
    !/^mustaflow_parity_disposable_[a-f0-9]{16}$/u.test(connection.database) ||
    connection.outer_transaction !== true
  ) {
    throw new Error("purge_fixture_parent_disposable_transaction_required");
  }
  const guards = await client.query(
    "SELECT relation.relname, trigger_row.tgname FROM pg_trigger trigger_row " +
      "JOIN pg_class relation ON relation.oid=trigger_row.tgrelid " +
      "JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace " +
      "WHERE namespace.nspname='public' AND NOT trigger_row.tgisinternal " +
      "AND relation.relname=ANY($1::text[])",
    [
      [
        "projects",
        "assets",
        "asset_storage_objects",
        "generated_images",
        "project_uploads",
        "project_files",
        "asset_usage",
        "production_database_admission_receipts",
      ],
    ],
  );
  if (guards.rows.length !== 0) throw new Error("purge_fixture_must_precede_admission_guards");
  const active = await client.query(
    "SELECT epoch FROM production_database_admission_epochs WHERE namespace='production' AND state='active'",
  );
  if (active.rows.length !== 0) throw new Error("purge_fixture_active_epoch_forbidden");

  const epoch = randomUUID();
  await client.query(
    "INSERT INTO production_database_admission_epochs " +
      "(epoch,namespace,state,worker_deployment_version,evidence_sha256,observed_at,project_id_floor) " +
      "VALUES ($1,'production','prepared','disposable-purge-fixture',$2,NOW(),0)",
    [epoch, hash("disposable-purge-fixture:" + epoch)],
  );
  const fixtures = {} as Record<CaseId, SeededFixture>;
  const reserveProjectId = async (): Promise<number> => {
    for (;;) {
      const row = await client.query<{ id: number }>(
        "SELECT nextval(pg_get_serial_sequence('public.projects','id'))::integer AS id",
      );
      const id = row.rows[0]?.id;
      if (id === 51) continue;
      if (!Number.isSafeInteger(id) || Number(id) <= 0)
        throw new Error("purge_fixture_invalid_project_id");
      return id!;
    }
  };

  for (const caseId of CASES) {
    const tag = "purge-pg:" + epoch + ":" + caseId;
    const owner = tag;
    const kind = caseId.endsWith("upload") ? "upload" : "image";
    const unknown = caseId.startsWith("unknown-");
    const ora = caseId === "retention-ora";
    const aliasOnly = caseId.startsWith("alias-only-");
    const foreign = caseId === "writer-first-foreign-image";
    const unbound = caseId.endsWith("unbound-image");
    const legacy = caseId === "retained-legacy-upload" || caseId.startsWith("scope-");
    const storageBackend = legacy ? "legacy-object" : "r2";
    const productScope = unknown ? null : ora ? "ora" : "nabuflow";
    const explicitGrant =
      caseId.startsWith("writer-first-") ||
      caseId.startsWith("purge-first-") ||
      caseId === "admission-upload" ||
      caseId === "remapped-upload";
    const workspace = await client.query<{ id: number }>(
      "INSERT INTO workspaces (owner_user_id,name) VALUES ($1,$1) RETURNING id",
      [tag],
    );
    const workspaceId = workspace.rows[0]!.id;
    await client.query(
      "INSERT INTO workspace_members (workspace_id,user_id,role,invited_by) VALUES ($1,$2,'owner',$2)",
      [workspaceId, owner],
    );
    const sourceId = await reserveProjectId();
    await client.query(
      "INSERT INTO projects (id,owner_id,workspace_id,name) VALUES ($1,$2,$3,$4)",
      [sourceId, owner, workspaceId, tag + ":source"],
    );
    const targetId = await reserveProjectId();
    await client.query(
      "INSERT INTO projects (id,owner_id,workspace_id,name) VALUES ($1,$2,$3,$4)",
      [targetId, owner, workspaceId, tag + ":target"],
    );
    // Ora provenance is namespace-valid. Only the old Nabu carrier is cross-product.
    const assetProjectId = ora ? null : foreign ? targetId : sourceId;
    const storageKey = legacy
      ? "/objects/uploads/" + randomUUID()
      : unbound
        ? "generated-images/" + epoch + "/" + caseId + "/full.webp"
        : "assets/" +
          hash(owner).slice(0, 24) +
          "/" +
          (ora ? "account" : "project-" + assetProjectId) +
          "/" +
          epoch +
          "/" +
          caseId +
          ".webp";
    const aliasStorageKey = aliasOnly
      ? "generated-images/" + epoch + "/" + caseId + "/full.webp"
      : storageKey;
    const asset = await client.query<{ id: number }>(
      "INSERT INTO assets (owner_user_id,actor_user_id,project_id,scope,product_scope,kind,source," +
        "filename,mime_type,size_bytes,storage_key,state,scan_state,thread_key,storage_backend) " +
        "VALUES ($1,$1,$2,$3,$4,'image',$5,$6,'image/webp',1,$7,'ready','not-required',$8,$9) RETURNING id",
      [
        owner,
        assetProjectId,
        ora ? "account" : "project",
        productScope,
        kind === "upload" ? "legacy-project-upload" : "isolation-proof",
        tag + ".webp",
        storageKey,
        ora ? null : tag,
        storageBackend,
      ],
    );
    const assetId = asset.rows[0]!.id;
    await client.query(
      "INSERT INTO asset_storage_objects (asset_id,storage_backend,storage_key,role,state,size_bytes) " +
        "VALUES ($1,$3,$2,'primary','ready',1)",
      [assetId, storageKey, storageBackend],
    );
    let aliasId: number;
    if (kind === "image") {
      const image = await client.query<{ id: number }>(
        "INSERT INTO generated_images (user_id,project_id,asset_id,product_scope,prompt,status,storage_key) " +
          "VALUES ($1,$2,$3,$4,$5,'completed',$6) RETURNING id",
        [
          owner,
          sourceId,
          unbound ? null : assetId,
          unknown ? null : "nabuflow",
          tag,
          aliasStorageKey,
        ],
      );
      aliasId = image.rows[0]!.id;
    } else {
      const upload = await client.query<{ id: number }>(
        "INSERT INTO project_uploads (project_id,filename,object_path) VALUES ($1,$2,$3) RETURNING id",
        [sourceId, tag + ".webp", aliasStorageKey],
      );
      aliasId = upload.rows[0]!.id;
    }
    const alias =
      kind === "image"
        ? "/api/images/" + aliasId + "/file"
        : "/api/projects/" + sourceId + "/uploads/" + aliasId + "/content";
    if (
      !aliasOnly &&
      !["claim-unshared-image", "quoted-writer-image", "delete-unshared-upload"].includes(caseId)
    ) {
      await client.query(
        "INSERT INTO asset_usage (asset_id,project_id,consumer) VALUES ($1,$2,$3)",
        [
          assetId,
          targetId,
          explicitGrant ? "explicit-project-use:v1" : "isolation-proof-automatic",
        ],
      );
    }
    let historicalFileId: number | null = null;
    let historicalContent: string | null = null;
    if (
      !explicitGrant &&
      !["claim-unshared-image", "quoted-writer-image", "delete-unshared-upload"].includes(caseId)
    ) {
      historicalContent = aliasOnly
        ? aliasStorageKey.replace(
            /\/full\.webp$/u,
            caseId === "alias-only-thumb" ? "/thumb.webp" : "/full.webp",
          )
        : alias;
      const file = await client.query<{ id: number }>(
        "INSERT INTO project_files (project_id,path,content) VALUES ($1,$2,$3) RETURNING id",
        [targetId, tag + ".html", historicalContent],
      );
      historicalFileId = file.rows[0]!.id;
    }

    // Synthetic disposable evidence only. The live proof checks the real current
    // completion predicate before using it; this is not a production release claim.
    const progress = {
      semantics: "project-retirement-v2",
      route: {
        state: "verified_absent",
        failureCode: null,
        legacyHostnameKv: { state: "not_configured", failureCode: null },
        hostnames: [],
        runtimeRoutes: [],
        cache: { state: "purged" },
      },
      tasks: {
        state: "canceled",
        count: 0,
        terminalized: 0,
        creditsRefunded: 0,
        telemetryFlushed: 0,
      },
      access: {
        state: "revoked",
        shareLinksRevoked: 0,
        previewSessionsRevoked: 0,
        supportGrantsRevoked: 0,
        supportSessionsInterrupted: 0,
        canvasShareTokensCleared: 0,
        canvasAbTestsEnded: 0,
      },
      legacyR2: { state: "not_configured", discoveredCount: 0, deletedCount: 0, failureCode: null },
      managedAddons: {
        state: "verified_detached",
        discoveredCount: 0,
        detachedCount: 0,
        secretsRemoved: 0,
        bindingsRemaining: 0,
        failureCode: null,
      },
      sqliteRecovery: {
        state: "not_applicable",
        snapshotId: null,
        sizeBytes: 0,
        storage: null,
        failureCode: null,
      },
      domains: [],
      hostnameCertificates: [],
      securityResources: [],
      purchasedDomains: [],
      retainedLegacyRuntimePointers: [],
      legacyRuntimeResolutions: [],
      runtimes: [
        {
          role: "preview",
          slot: "primary",
          state: "verified_absent",
          attempts: 0,
          failureCode: null,
        },
        {
          role: "production",
          slot: "blue",
          state: "verified_absent",
          attempts: 0,
          failureCode: null,
        },
        {
          role: "production",
          slot: "green",
          state: "verified_absent",
          attempts: 0,
          failureCode: null,
        },
      ],
    };
    await client.query("UPDATE projects SET deleted_at=NOW() WHERE id=$1", [sourceId]);
    const retirementId = tag + ":retirement";
    const operationId = tag + ":purge";
    await client.query(
      "INSERT INTO project_retirement_operations (id,project_id,requested_by,state,progress,completed_at) " +
        "VALUES ($1,$2,$3,'completed',$4::jsonb,NOW())",
      [retirementId, sourceId, owner, JSON.stringify(progress)],
    );
    await client.query(
      "INSERT INTO project_purge_operations " +
        "(id,project_id,retirement_operation_id_hash,trigger,state,stage,idempotency_key_hash," +
        "requested_by_hash,lease_version,lease_expires_at,resource_progress) " +
        "VALUES ($1,$2,$3,'manual','running','relational',$4,$5,1,NOW()+interval '30 minutes',$6::jsonb)",
      [
        operationId,
        sourceId,
        hash(retirementId),
        hash(operationId),
        hash(owner),
        JSON.stringify({ databaseComplete: true }),
      ],
    );
    const allocationIdentity = await productionDatabaseAllocationIdentity({
      format: "nabuflow.production-database-allocation/v1",
      deploymentNamespace: "production",
      projectId: sourceId,
    });
    await client.query(
      "INSERT INTO production_database_admission_receipts " +
        "(project_id,registration_epoch,birth_token,birth_registered,allocation_identity,state,seal_id) " +
        "VALUES ($1,$2,$3,false,$4,'sealed',$5)",
      [sourceId, epoch, randomUUID(), allocationIdentity, randomUUID()],
    );
    if (caseId === "scope-same-owner-upload" || caseId === "scope-cross-owner-upload") {
      await client.query("UPDATE assets SET product_scope=NULL WHERE id=$1", [assetId]);
    }
    if (caseId === "scope-cross-owner-upload") {
      await client.query(
        "INSERT INTO project_uploads (project_id,filename,object_path) VALUES ($1,$2,$3)",
        [fixtures["writer-first-image"].targetId, tag + "-foreign.webp", storageKey],
      );
    }
    if (
      caseId === "raw-taskless-same-owner-upload" ||
      caseId === "raw-taskless-cross-owner-upload"
    ) {
      const rawAlias = "/objects/uploads/" + randomUUID();
      await client.query(
        "INSERT INTO asset_storage_objects " +
          "(asset_id,storage_backend,storage_key,role,state,size_bytes) " +
          "VALUES ($1,'legacy-object',$2,'historical-upload-alias','ready',1)",
        [assetId, rawAlias],
      );
      await client.query(
        "INSERT INTO agent_tool_calls (project_id,task_id,tool_name,args_summary,stdout_preview) " +
          "VALUES ($1,NULL,$2,$3,NULL)",
        [
          caseId === "raw-taskless-cross-owner-upload"
            ? fixtures["writer-first-image"].targetId
            : targetId,
          tag,
          rawAlias,
        ],
      );
    }
    if (caseId === "soft-deleted-image") {
      await client.query(
        "UPDATE generated_images SET deleted_at=NOW(),file_url=$2,thumbnail_url=$3 WHERE id=$1",
        [aliasId, "/api/images/" + aliasId + "/file", "/api/images/" + aliasId + "/thumbnail"],
      );
    }
    fixtures[caseId] = {
      tag,
      sourceId,
      targetId,
      assetId,
      assetProjectId,
      aliasId,
      kind,
      storageKey,
      aliasStorageKey,
      operationId,
      retirementId,
      owner,
      productScope: caseId === "scope-cross-owner-upload" ? null : productScope,
      explicitGrant,
      historicalFileId,
      historicalContent,
    };
  }
  const manifest: FixtureManifest = {
    version: 1,
    database: connection.database,
    expectedTestCount: 27,
    epoch,
    fixtures,
  };
  if (Buffer.byteLength(JSON.stringify(manifest), "utf8") > 24 * 1024) {
    throw new Error("purge_fixture_manifest_too_large");
  }
  return manifest;
}
