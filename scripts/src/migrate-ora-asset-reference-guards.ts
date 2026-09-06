import { pool } from "@workspace/db";

async function migrateOraAssetReferenceGuards() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE OR REPLACE FUNCTION require_live_owned_ora_asset_reference()
      RETURNS TRIGGER AS $$
      DECLARE
        row_json JSONB;
        candidate_ora_asset_id INTEGER;
      BEGIN
        row_json := to_jsonb(NEW);
        IF TG_NARGS > 1
           AND NULLIF(row_json ->> TG_ARGV[1], '') IS NOT NULL THEN
          RETURN NEW;
        END IF;
        candidate_ora_asset_id := NULLIF(row_json ->> TG_ARGV[0], '')::integer;
        IF candidate_ora_asset_id IS NULL THEN
          RETURN NEW;
        END IF;
        PERFORM 1
          FROM public.ora_assets ora
         WHERE ora.id = candidate_ora_asset_id
           AND ora.user_id = row_json ->> 'user_id'
           AND ora.deleted_at IS NULL
         FOR SHARE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'ora_asset_reference_unavailable' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql SECURITY INVOKER
         SET search_path = pg_catalog, public
    `);
    const repaired = await client.query<{
      file_contexts_repaired: string;
      brand_kits_repaired: string;
    }>(`
      WITH repaired_file_contexts AS (
        UPDATE public.ora_file_contexts context_row
           SET asset_id = NULL
         WHERE context_row.asset_id IS NOT NULL
           AND context_row.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1
               FROM public.ora_assets ora
              WHERE ora.id = context_row.asset_id
                AND ora.user_id = context_row.user_id
                AND ora.deleted_at IS NULL
           )
        RETURNING 1
      ), repaired_brand_kits AS (
        UPDATE public.brand_kits kit
           SET logo_asset_id = NULL,
               updated_at = NOW()
         WHERE kit.logo_asset_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
               FROM public.ora_assets ora
              WHERE ora.id = kit.logo_asset_id
                AND ora.user_id = kit.user_id
                AND ora.deleted_at IS NULL
           )
        RETURNING 1
      )
      SELECT (SELECT COUNT(*)::text FROM repaired_file_contexts) AS file_contexts_repaired,
             (SELECT COUNT(*)::text FROM repaired_brand_kits) AS brand_kits_repaired
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS ora_asset_reference_guard_ora_file_contexts
        ON ora_file_contexts;
      CREATE TRIGGER ora_asset_reference_guard_ora_file_contexts
        BEFORE INSERT OR UPDATE OF user_id, asset_id, deleted_at
        ON ora_file_contexts
        FOR EACH ROW EXECUTE FUNCTION require_live_owned_ora_asset_reference('asset_id', 'deleted_at')
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS ora_asset_reference_guard_brand_kits
        ON brand_kits;
      CREATE TRIGGER ora_asset_reference_guard_brand_kits
        BEFORE INSERT OR UPDATE OF user_id, logo_asset_id
        ON brand_kits
        FOR EACH ROW EXECUTE FUNCTION require_live_owned_ora_asset_reference('logo_asset_id')
    `);
    const readiness = await client.query<{ ready: boolean }>(`
      SELECT (
        (SELECT COUNT(*) = 2
           AND bool_and(NOT trigger_row.tgisinternal)
           AND bool_and(trigger_row.tgenabled = ANY(ARRAY['O', 'A']::"char"[]))
           AND bool_and(trigger_row.tgtype = 23)
           AND bool_and(trigger_row.tgqual IS NULL)
           AND bool_and(trigger_row.tgnargs = expected.argument_count)
           AND bool_and(encode(trigger_row.tgargs, 'escape') = expected.argument_bytes)
           AND bool_and(
             trigger_row.tgfoid =
               to_regprocedure('public.require_live_owned_ora_asset_reference()')
           )
          FROM (VALUES
            ('ora_file_contexts', 'ora_asset_reference_guard_ora_file_contexts', 2, 'asset_id\\000deleted_at\\000'),
            ('brand_kits', 'ora_asset_reference_guard_brand_kits', 1, 'logo_asset_id\\000')
          ) AS expected(table_name, trigger_name, argument_count, argument_bytes)
          JOIN pg_catalog.pg_class relation ON relation.relname = expected.table_name
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
          JOIN pg_catalog.pg_trigger trigger_row ON trigger_row.tgrelid = relation.oid
         WHERE namespace.nspname = 'public'
           AND trigger_row.tgname = expected.trigger_name)
        AND NOT EXISTS (
          SELECT 1
            FROM public.ora_file_contexts context_row
            LEFT JOIN public.ora_assets ora
              ON ora.id = context_row.asset_id
             AND ora.user_id = context_row.user_id
             AND ora.deleted_at IS NULL
           WHERE context_row.asset_id IS NOT NULL
             AND context_row.deleted_at IS NULL
             AND ora.id IS NULL
        )
        AND NOT EXISTS (
          SELECT 1
            FROM public.brand_kits kit
            LEFT JOIN public.ora_assets ora
              ON ora.id = kit.logo_asset_id
             AND ora.user_id = kit.user_id
             AND ora.deleted_at IS NULL
           WHERE kit.logo_asset_id IS NOT NULL
             AND ora.id IS NULL
        )
      ) AS ready
    `);
    if (readiness.rows[0]?.ready !== true) {
      throw new Error("ora_asset_reference_guards_missing");
    }
    await client.query("COMMIT");
    console.log(
      "[migrate-ora-asset-reference-guards] Done.",
      JSON.stringify({
        fileContextsRepaired: Number(repaired.rows[0]?.file_contexts_repaired ?? 0),
        brandKitsRepaired: Number(repaired.rows[0]?.brand_kits_repaired ?? 0),
      }),
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  try {
    await migrateOraAssetReferenceGuards();
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("[migrate-ora-asset-reference-guards] FAILED:", error);
  process.exit(1);
});
