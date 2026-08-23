---
name: Parity harness first clean pass
description: Records the first full parity_check_pass (all three layers + idempotency + restore probe), pinned values, and invocation pattern.
---

## First clean pass

Achieved at HEAD `8ab1d25d` / tree `cca6f107` (commit: "Define intent receipt constraints").

## Pinned values (as of first clean pass)

- `EXPECTED_LAYER1_OBJECT_COUNT`: harness source still reads `"TODO_PHASE_2_4"` — the live measured pin is **252** (confirmed in two independent runs at BLOCK GGGGGGGG and BLOCK JJJJJJJJ). Must be updated to `252` before enforcement mode is enabled.
- `EXPECTED_MIGRATION_COUNT`: **145** (144 pass + 1 tolerated).
- `TOLERATED_MIGRATION_FAILURE`: `{ name: "migrate-workspace-tenancy", message: "legacy_adoption_owner_id_missing" }` — only accepted singleton.
- `PARITY_EXTENSION_ALLOWLIST`: `["vector"]`.
- `LAYER1_SENTINEL_TABLE`: `"knowledge_entries"`.
- `RESTORE_PROBE_COLUMN`: `"source_message_start_id"`.
- `SCHEMA_DIFF_MECHANISM`: `"pg_catalog_relations_columns_constraints_indexes"` — diff_count must be 0.

## Invocation pattern

```
PARITY_TEST_DATABASE_URL="postgresql://postgres:password@helium/parity_scratch_<name>?sslmode=disable" \
  pnpm --filter @workspace/scripts exec node --import tsx src/startup-migrations-parity-isolation.ts
```

`DATABASE_URL` (the app DB) is NOT forwarded and does NOT enable the runner.

## CREATE DATABASE pattern

Connect to the `postgres` admin DB on helium (replace the dbname segment):

```
ADMIN_URL="postgresql://postgres:password@helium/postgres?sslmode=disable"
psql "$ADMIN_URL" -c "CREATE DATABASE parity_scratch_<name>;"
```

## What was needed to unblock

- `pgvector` extension: Layer-0 `provisionExtensions` (`CREATE EXTENSION IF NOT EXISTS "vector"`) resolves PG 42704.
- `content_tsv` generated column: added proper definition in `lib/db/src/schema/messages.ts` (resolves `ComputeIndexAttrs` failure).
- `zero_intent_receipts` schema: added to `lib/db/src/schema/zero-intent-receipts.ts` (resolves `zero_intent_receipt_schema_incomplete` in layer-2).

**Why:** These three schema gaps caused cascading layer failures in prior runs (BLOCK CCCCCCCC → EEEEEEEE → GGGGGGGG). Correct source definitions are required so drizzle-kit push-force materialises the full schema before layer-2 migrations run.

## Full three-proof verdicts at first clean pass

1. Layer 0: `parity_layer0_extension_pass extension=vector`
2. Layer 1: `parity_layer1_materialize_pass object_count=252 expected_object_count=TODO_PHASE_2_4 sentinel=knowledge_entries`
3. Layer 2: `parity_layer2_migrations_pass migration_count=145` (passed=144, failed=1 tolerated)
4. Construction: `parity_construction_pass schema_entry_count=3638`
5. Idempotency: `parity_idempotency_diff diff_count=0` → `parity_idempotency_pass`
6. Restore probe: `parity_restore_probe_pass migration_count=145`
7. Overall: `parity_check_pass` — exit 0
