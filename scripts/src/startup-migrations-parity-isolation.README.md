# Startup-migrations parity isolation

This runner replaces any temptation to execute the retired broad stability profile for a migration-parity check.

## Two-phase law

- Phase 1 is lab-only. Unit tests inject fake connectors and never open a database.
- Phase 2's first live run happens only under an explicit desk block, against the desk-named scratch database on the development host.

Run Phase 2 only by setting `PARITY_TEST_DATABASE_URL` to a PostgreSQL URL whose database name matches `parity_scratch` or `parity_scratch_<lowercase-alphanumeric>`, then invoke:

```text
pnpm --filter @workspace/scripts exec node --import tsx src/startup-migrations-parity-isolation.ts
```

Ambient `DATABASE_URL` does not enable the runner and is not forwarded. The validated scratch URL is passed to one isolated child that owns the complete bootstrap-first check. The broad stability profile and its legacy populated-schema assumption are never invoked.

## Three-layer bootstrap law

- Layer 0 owns the allowlisted PostgreSQL extensions required by the canonical schema source.
- Layer 1 owns creation from canonical Drizzle schema source.
- Layer 2 owns additive evolution through `runStartupMigrations()`.
- The harness proves layer 2 atop canonical layers 0 and 1; it never clones or dumps a live database.

The schema inventory uses one extension-backed type family: `vector` in `knowledge.ts`,
`project-embeddings.ts`, and `vault-embeddings.ts`. The exact layer-0 allowlist is therefore
`["vector"]`; no `citext`, `uuid-ossp`, `pgcrypto`, `postgis`, or custom extension type is present.
Each allowlisted extension is installed with `CREATE EXTENSION IF NOT EXISTS` only after the
scratch-name guard has passed, and each receipt names the validated host, database, and extension.

This repository has no checked-in Drizzle migration journal. Its canonical layer-1 source is `lib/db/src/schema/index.ts`, selected by `lib/db/drizzle.config.ts`. The harness therefore uses the source fallback exactly as the package declares it:

```text
pnpm --filter @workspace/db push-force
```

That command expands to `drizzle-kit push --force --config ./drizzle.config.ts`. It receives only the already-validated scratch `DATABASE_URL`, and its stdout and stderr pass through verbatim. A zero
exit is not sufficient: the complete streams must contain no PostgreSQL error lines,
`public.knowledge_entries` must exist afterward, and the observed object count must match the
named pin. Phase 2.4 will replace `TODO_PHASE_2_4` with the first honest live object count; numeric
pins are enforced on every later run.

Layer 2 succeeds only at 147 attempted migrations with the exact typed tolerated set
`migrate-workspace-tenancy: legacy_adoption_owner_id_missing` (144 passed, 1 tolerated). Any
other count, failure, or superset fails the proof.

The child proves three things, in order:

1. Layer 0 provisions the exact extension allowlist. Layer 1 materializes the canonical Drizzle
   base into the empty scratch and proves its output, sentinel, and object count; layer 2 then
   applies the exact typed startup-migration outcome.
2. Layer 1 and layer 2 are both reapplied. The resulting normalized `pg_catalog` snapshot of relations, columns, constraints, and indexes across `public`, `pgboss`, and `_system` must have `diff_count=0`.
3. The child drops `knowledge_entries.source_message_start_id`, reruns layer 2, and proves the column was restored.

Child stdout and stderr are relayed verbatim through the parent, including an underlying error stack on failure. Connection-related receipts name only the host and database name; they never print credentials. The child closes its connection pool, and the desk-owned ceremony drops the scratch database even after a failed check.
