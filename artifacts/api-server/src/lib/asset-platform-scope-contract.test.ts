import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const migration = source("./startup-migrations.ts");
const registry = source("./asset-registry.ts");
const helper = source("./asset-platform-scope.ts");
const projectUse = source("./asset-project-use.ts");
const assets = source("../routes/assets.ts");
const images = source("../routes/image-gen.ts");
const purge = source("./project-purge.ts");
describe("product isolation SQL and route contracts", () => {
  it("keeps product/URL policy database-free without a grant barrel", () => {
    expect(helper).toContain('import type { ProductScope } from "@workspace/db"');
    expect(helper).not.toContain('from "drizzle-orm"');
    expect(helper).not.toContain("asset-project-use");
    expect(helper).not.toMatch(/import\s*\(/u);
    expect(helper).not.toMatch(/import\s+(?!type\b)[\s\S]*?from\s*["']@workspace\/db["']/u);
    expect(projectUse).toContain('from "./asset-platform-scope"');
    expect(assets).toContain('from "../lib/asset-project-use"');
  });
  it("narrows an untrusted jobId before the job lookup", () => {
    const status = images.slice(
      images.indexOf("const imageStatusHandler"),
      images.indexOf('router.get("/images/status/:jobId"'),
    );
    const guard = status.indexOf('if (typeof jobId !== "string" || jobId.length === 0)');
    const lookup = status.indexOf("const job = getJob(jobId)");
    expect(guard).toBeGreaterThan(-1);
    expect(lookup).toBeGreaterThan(guard);
    expect(status.slice(guard, lookup)).toContain("return;");
    expect(status.slice(guard, lookup)).toContain("res.status(400)");
  });
  it("deduplicates physical keys before binary ordering and retains global claim locks", () => {
    const start = migration.indexOf(
      "CREATE OR REPLACE FUNCTION require_attachable_assets_in_durable_reference",
    );
    const guard = migration.slice(start);
    const loopStart = guard.indexOf("FOR durable_key IN");
    const loopEnd = guard.indexOf("END LOOP;", loopStart);
    const loop = guard.slice(loopStart, loopEnd).replace(/\s+/gu, " ");
    expect(loop).toContain(
      'SELECT deduplicated.storage_key FROM ( SELECT DISTINCT resolved.storage_key FROM public.resolve_durable_storage_keys(row_json) resolved(storage_key) ) AS deduplicated ORDER BY deduplicated.storage_key COLLATE "C"',
    );
    expect(loop).toContain("pg_advisory_xact_lock_shared(");
    expect(loop).toContain("hashtextextended('nabuflow:durable-object:' || durable_key, 0)");
    expect(loop).toContain("claim.storage_key=durable_key");
    expect(loop).toContain("RAISE EXCEPTION 'asset_reference_unavailable'");
  });
  it("range-checks unambiguous upload-route variables before integer lookup casts", () => {
    const start = migration.indexOf("CREATE OR REPLACE FUNCTION resolve_durable_asset_ids");
    const end = migration.indexOf("CREATE OR REPLACE FUNCTION resolve_durable_storage_keys", start);
    const resolver = migration.slice(start, end);
    expect(resolver).toContain("route_project_id BIGINT;");
    expect(resolver).toContain("route_upload_id BIGINT;");
    expect(resolver).not.toMatch(/^\s*(?:project_id|upload_id)\s+BIGINT;/mu);
    expect(resolver).toContain("route_project_id NOT BETWEEN 1 AND 2147483647");
    expect(resolver).toContain("route_upload_id NOT BETWEEN 1 AND 2147483647");
    expect(resolver.indexOf("route_upload_id NOT BETWEEN")).toBeLessThan(
      resolver.indexOf("WHERE upload.project_id = route_project_id::integer"),
    );
    expect(resolver).toContain("AND upload.id = route_upload_id::integer");
    expect(resolver).toContain("IF candidate_id IS NULL THEN");
    expect(resolver).toContain("RAISE EXCEPTION 'asset_reference_unavailable'");
  });
  it.each(["storage_key", "file_url", "thumbnail_url"])(
    "retains alias-only %s metadata globally without adding delivery authority",
    (field) => {
      const start = migration.indexOf("CREATE OR REPLACE FUNCTION durable_asset_reference_exists");
      const end = migration.indexOf("$$ LANGUAGE SQL STABLE SECURITY INVOKER", start);
      const proof = migration.slice(start, end);
      const aliases = proof.slice(
        proof.indexOf("candidate_image_aliases AS ("),
        proof.indexOf("candidate_raw_keys AS ("),
      );
      const keys = proof.slice(
        proof.indexOf("candidate_raw_keys AS ("),
        proof.indexOf("legacy_aliases AS ("),
      );
      expect(aliases).toContain("image.asset_id = candidate_asset_id");
      expect(aliases).toContain("image." + field);
      expect(aliases).not.toContain("product_scope");
      expect(aliases).not.toContain("deleted_at");
      expect(keys).toContain("image_alias." + field);
      expect(keys).toContain("public.resolve_durable_storage_keys(");
      expect(keys).toContain("FROM candidate_raw_keys raw_key");
      expect(keys).toContain("'/thumb.webp'");
      expect(keys).toContain("raw_key.storage_key LIKE '%/full.webp'");
      expect(keys).not.toContain("explicit-project-use:v1");
      expect(keys).not.toContain("product_scope");
      expect(proof).toContain("position(candidate_key.storage_key in durable.row_json::text) > 0");
      expect(proof).toContain("FROM public.agent_tool_calls tool_call");
      expect(proof).toContain("FROM public.generated_images image");
    },
  );
  it("permits only verified historical NabuFlow product-scope backfills", () => {
    expect(migration.match(/name: "migrate-asset-product-scope-v1"/g)).toHaveLength(1);
    expect(migration).toContain("assets_product_scope_check");
    expect(migration).toContain("generated_images_product_scope_check");
    expect(migration).toContain("OLD.product_scope IS DISTINCT FROM NEW.product_scope");
    expect(migration.match(/SET product_scope = 'nabuflow'/g)).toHaveLength(3);
    expect(migration).toContain("AND image.asset_id = asset.id");
    expect(migration).toContain("AND asset.product_scope = 'nabuflow'");
    expect(migration).toContain("AND asset.owner_user_id = image.user_id");
    expect(migration).toContain("AND asset.project_id IS NOT DISTINCT FROM image.project_id");
    expect(migration).toContain("AND public.asset_has_verified_nabuflow_provenance(asset.id)");
    expect(migration).toContain("AND image.product_scope IS NOT NULL");
    expect(migration).not.toMatch(
      /UPDATE\s+generated_images\s+SET\s+product_scope\s*=\s*'nabuflow'[\s\S]*?project_id\s+IS\s+NOT\s+NULL/iu,
    );
    const generatedProof = migration.slice(
      migration.indexOf(
        "CREATE OR REPLACE FUNCTION generated_image_has_verified_nabuflow_provenance",
      ),
      migration.indexOf("CREATE OR REPLACE FUNCTION prevent_asset_product_scope_change"),
    );
    expect(generatedProof).not.toContain("image.project_id IS NOT NULL");
  });
  it("revalidates upload alias identity after key waits", () => {
    const guard = migration.slice(
      migration.indexOf(
        "CREATE OR REPLACE FUNCTION require_attachable_assets_in_durable_reference",
      ),
    );
    expect(guard.indexOf("SELECT asset.id, upload.object_path")).toBeGreaterThan(
      guard.indexOf("pg_advisory_xact_lock_shared"),
    );
    expect(guard).toContain("rechecked_asset_id=ANY(locked_asset_ids)");
    expect(guard).toContain("rechecked_storage_key=ANY(locked_storage_keys)");
    expect(guard).toContain("FOR SHARE OF upload");
    expect(migration).toContain("/api/(?:assets|ora/canonical-assets)/");
  });
  it("uses exact explicit target consumers, never automatic history as a grant", () => {
    expect(projectUse).toContain(
      "eq(assetUsageTable.consumer, EXPLICIT_PROJECT_ASSET_USE_CONSUMER)",
    );
    expect(projectUse).toContain(
      'checkProjectAccess(input.actorUserId, input.targetProjectId, "member")',
    );
    expect(migration).toContain("usage_row.consumer='explicit-project-use:v1'");
    expect(assets).toContain("EXPLICIT_MATERIALIZE_ACTION");
    expect(assets).toContain("assertExistingProjectAssetUse");
  });
  it("binds status/edit/delivery to server-selected products", () => {
    expect(images).toContain('imageStatusHandler("nabuflow")');
    expect(images).toContain('imageStatusHandler("ora")');
    expect(images).toContain('imageEditHandler("nabuflow")');
    expect(images).toContain('imageEditHandler("ora")');
    expect(images).toContain("job.productScope !== productScope");
    expect(images).toContain('const isOraEdit = productScope === "ora"');
    expect(assets).toContain('assetContentHandler("ora")');
    expect(assets).toContain("asset.productScope !== productScope");
    expect(images).toContain('const fileUrl = ""');
    expect(images).toContain("const storageKey = trackedObject?.storageKey ?? null");
  });
  it("keeps origin uncertainty nonretryable and preserves the specific sanitized cause", () => {
    expect(purge).toContain('causeCode === "project_purge_asset_origin_unresolved"');
    expect(purge).toContain(
      'new ProjectPurgeStepError(stage, "project_purge_asset_release_failed", false, causeCode)',
    );
  });
  it("keeps exact upload self-alias exclusion separate from the compatible three-argument predicate", () => {
    const start = migration.indexOf(
      "CREATE OR REPLACE FUNCTION durable_asset_reference_exists_excluding_upload(",
    );
    const end = migration.indexOf("$ LANGUAGE SQL STABLE SECURITY INVOKER", start);
    const implementation = migration.slice(start, end);
    expect(implementation).toContain("excluded_project_upload_id INTEGER");
    expect(implementation).toContain("upload.id IS DISTINCT FROM excluded_project_upload_id");
    expect(implementation).toContain("candidate.source = 'legacy-project-upload'");
    expect(implementation).toContain("candidate.project_id = upload.project_id");
    expect(implementation).toContain("candidate.storage_key = upload.object_path");
    expect(implementation).toContain("FROM legacy_aliases alias_row");
    expect(implementation).not.toContain("DEFAULT");
    const wrapper = migration.slice(
      migration.indexOf("CREATE OR REPLACE FUNCTION durable_asset_reference_exists("),
    );
    expect(wrapper).toMatch(
      /SELECT public\.durable_asset_reference_exists_excluding_upload\(\s*candidate_asset_id, excluded_project_id, excluded_generated_image_id, NULL\s*\)/u,
    );
    expect(migration).toContain(
      "'public.durable_asset_reference_exists_excluding_upload(integer,integer,integer,integer)'",
    );
  });

  it("checks physical absence authority after the final lock before deletion claims", () => {
    const claim = registry.slice(registry.indexOf("export async function deleteReadyAsset"));
    expect(claim.indexOf("const finalReferences")).toBeGreaterThan(
      claim.indexOf("for (const storageKey of storageKeys)"),
    );
    expect(claim.indexOf("INSERT INTO durable_asset_deletion_claims")).toBeGreaterThan(
      claim.indexOf("const finalReferences"),
    );
  });
});
