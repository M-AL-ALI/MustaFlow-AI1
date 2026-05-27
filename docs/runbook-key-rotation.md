# Encryption Key Rotation Runbook

This document describes the step-by-step procedure for rotating the AES-256-GCM encryption key used to protect sensitive data in the MustaFlow platform.

## Columns covered by this rotation

| Table                        | Column            |
| ---------------------------- | ----------------- |
| `project_secrets`            | `value_encrypted` |
| `projects`                   | `preview_db_url`  |
| `project_github_connections` | `encrypted_token` |

---

## Prerequisites

- You have shell access to the environment where the API server runs.
- `OLD_ENCRYPTION_KEY`, `NEW_ENCRYPTION_KEY`, and `DATABASE_URL` can all be set as environment variables for the duration of this procedure.
- `pnpm` is available (the monorepo is set up).

---

## Step 1 — Back up the database

Before making any changes, take a full backup:

```bash
pg_dump "$DATABASE_URL" > backup_before_rotation_$(date +%s).sql
```

Store this backup somewhere safe. If anything goes wrong, you can restore with:

```bash
psql "$DATABASE_URL" < backup_before_rotation_<timestamp>.sql
```

---

## Step 2 — Generate the new key

Generate a cryptographically random 32-byte key and base64-encode it:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Keep the output — this is your `NEW_ENCRYPTION_KEY`. Store it immediately in your password manager or cloud secrets vault before proceeding.

---

## Step 3 — Set environment variables

Export the three variables in your shell session. Do **not** commit these to source control.

```bash
export OLD_ENCRYPTION_KEY="<current value of ENCRYPTION_KEY>"
export NEW_ENCRYPTION_KEY="<value generated in step 2>"
export DATABASE_URL="<your database connection string>"
```

---

## Step 4 — Run a dry-run first

The `--dry-run` flag counts rows per table without writing any changes. Use it to confirm connectivity and row counts before proceeding.

```bash
pnpm --filter @workspace/scripts run rotate-encryption-key -- --dry-run
```

Expected output:

```
DRY RUN — no rows will be updated.

[project_secrets.value_encrypted] 42 row(s) to process.
[projects.preview_db_url] 7 row(s) to process.
[project_github_connections.encrypted_token] 3 row(s) to process.

─────────────────────────────────────────────────
DRY RUN complete — no rows were written.
  project_secrets.value_encrypted: 42 row(s) would be rotated
  projects.preview_db_url: 7 row(s) would be rotated
  project_github_connections.encrypted_token: 3 row(s) would be rotated
```

If this fails (e.g. connection refused), resolve the issue before continuing.

---

## Step 5 — Schedule a maintenance window

The rotation script runs each table in batches of 100 rows and updates rows one at a time within each batch, so it is low-impact on the database. However:

- Until the script completes, the API server must continue using the **old** key.
- After the script completes, the API server must switch to the **new** key simultaneously.

Plan a short maintenance window (typically a few minutes) to cover the switchover. For large datasets (tens of thousands of rows), run the script during off-peak hours.

---

## Step 6 — Execute the rotation

```bash
pnpm --filter @workspace/scripts run rotate-encryption-key
```

The script will process each table in batches, logging progress and any rows it cannot decrypt. At the end it prints a summary:

```
Rotation summary: { rotated: 52, skipped: 0, errors: 0, durationMs: 1240 }

All rows rotated successfully.
```

If there are skipped rows, review the warnings:

- **"Malformed v1 encrypted value"** — the column has corrupted data. Inspect the row directly in the database.
- **"Unsupported state or unable to authenticate data"** — the row may already be encrypted with `NEW_ENCRYPTION_KEY` (safe to ignore if you are re-running after a partial failure) or the key is wrong.
- Legacy plaintext values (not starting with `v1:`) are passed through and re-encrypted with the new key automatically — this is expected for rows created before encryption was active.

---

## Step 7 — Update `ENCRYPTION_KEY` and restart the API server

Once the script completes with zero errors:

1. In Replit Secrets (or your secrets manager), update `ENCRYPTION_KEY` to the value of `NEW_ENCRYPTION_KEY`.
2. Restart the API server workflow so the new key is loaded.
3. Remove `OLD_ENCRYPTION_KEY` and `NEW_ENCRYPTION_KEY` from any local shell sessions or CI variables.

---

## Step 8 — Verify

Perform a quick smoke test to confirm the API server can still read encrypted data:

1. Log in to the app and navigate to a project that has secrets — confirm the secrets panel loads without errors.
2. Check a project that has a GitHub connection — confirm the connection status is readable.
3. Check a project with a preview DB — confirm the preview environment can be started.
4. Review API server logs for any `decrypt` errors.

---

## Rollback procedure

If you need to revert:

1. Restore the database backup taken in Step 1:
   ```bash
   psql "$DATABASE_URL" < backup_before_rotation_<timestamp>.sql
   ```
2. Ensure `ENCRYPTION_KEY` is still set to the old value (do not update it in secrets).
3. Restart the API server — it will read the restored rows with the old key as normal.

If you updated `ENCRYPTION_KEY` before noticing an issue, set it back to `OLD_ENCRYPTION_KEY` and restart the server before restoring the backup.

---

## If the encryption key is permanently lost

If `ENCRYPTION_KEY` is lost and you cannot decrypt existing rows:

- Existing secrets **cannot be recovered**. AES-256-GCM authentication will fail on every row.
- Set `ENCRYPTION_KEY` to a fresh key.
- Ask users to re-enter their secrets manually via the Secrets tab.
- For GitHub connections, ask users to reconnect their repositories.
- For preview DB URLs, re-provision preview environments (`POST /api/projects/:id/preview-env/start`).

---

## Reference

- Encryption implementation: `artifacts/api-server/src/lib/encryption.ts`
- Rotation script: `scripts/src/rotate-encryption-key.ts`
- Run command: `pnpm --filter @workspace/scripts run rotate-encryption-key [-- --dry-run]`
