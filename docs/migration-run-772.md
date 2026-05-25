# Migration Run Log — Task #772

**Date:** 2026-05-25  
**Task:** Run the two new database migrations in production before next deploy

## Migrations Executed

### 1. migrate-testing-approval

```
$ pnpm --filter @workspace/scripts run migrate-testing-approval

> @workspace/scripts@0.0.0 migrate-testing-approval
> tsx ./src/migrate-testing-approval.ts

Testing-approval migration complete.
```

**Columns added to `project_versions`:**

| Column | Type | Nullable | Default |
|---|---|---|---|
| migration_log | text | YES | — |
| migration_status | text | YES | — |
| testing_approved_at | timestamptz | YES | — |
| testing_approved_by | text | YES | — |
| testing_skipped | boolean | NO | false |

### 2. migrate-preview-db

```
$ pnpm --filter @workspace/scripts run migrate-preview-db

> @workspace/scripts@0.0.0 migrate-preview-db
> tsx ./src/migrate-preview-db.ts

Preview-db migration complete.
```

**Columns added to `projects`:**

| Column | Type | Nullable | Default |
|---|---|---|---|
| preview_db_status | text | NO | 'none' |
| preview_db_url | text | YES | — |

## Schema Verification

Both sets of columns confirmed present via:

```sql
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name IN ('project_versions', 'projects')
  AND column_name IN (
    'testing_approved_at','testing_approved_by','migration_status',
    'migration_log','testing_skipped','preview_db_url','preview_db_status'
  )
```

All 7 expected columns returned.

## API Server Restart & Endpoint Verification

API server restarted after migrations. Endpoint smoke tests:

```
GET  /api/healthz                                                    → 200 OK
POST /api/projects/test-id/versions/test-ver/approve-testing         → 401 (auth-gated, registered)
POST /api/projects/test-id/preview-db/provision                      → 401 (auth-gated, registered)
```

Both new endpoints return 401 (not 404), confirming they are registered and protected by auth middleware.
