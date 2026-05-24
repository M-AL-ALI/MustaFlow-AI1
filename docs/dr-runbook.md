# Disaster Recovery Runbook — MustaFlow CDN

This runbook documents how to recover from edge CDN failures, repopulate R2, and validate the recovery.

---

## Overview

Published sites are served through two independent layers:
1. **Primary path** — Cloudflare Worker reads from R2 object storage (sub-100ms TTFB globally).
2. **Fallback path** — API server (`/api/p/:slug/`) reads from the Postgres DB snapshot (higher latency but always available).

The fallback path is always active. If the edge layer is down, users continue receiving responses from the API server automatically — no manual intervention needed for most incidents.

---

## Incident Scenarios

### 1. Cloudflare Worker unreachable / zone-wide outage

**Symptoms**: `5xx` errors or timeouts on `slug.mustaflow.app` from multiple regions; `/api/p/:slug/` continues to work.

**Response**:
1. Verify the fallback is healthy: `curl -I https://<host>/api/p/<slug>/`
2. No code changes needed — the API server is the automatic fallback.
3. Open a Cloudflare status page incident if widespread (https://www.cloudflarestatus.com).
4. When the Worker recovers, traffic automatically resumes through the edge.

**Recovery validation**: `curl -I https://<slug>.mustaflow.app/` should return `200` with `CF-Cache-Status` header.

---

### 2. R2 bucket unavailable / corrupted

**Symptoms**: Worker returns `503` or serves stale content indefinitely; KV routing table is intact.

**When R2 is unavailable**, the Worker falls back to `versionHistory` in KV (serving the last-cached response from edge cache). The `X-Mustaflow-Origin: api-fallback` header is set when the API serves the request.

**Full R2 repopulation from DB snapshots**:

```bash
# Set environment vars
export CF_ACCOUNT_ID=<your_account_id>
export CF_R2_ACCESS_KEY_ID=<key_id>
export CF_R2_SECRET_ACCESS_KEY=<secret>
export CF_R2_BUCKET=mustaflow-snapshots
export DATABASE_URL=<your_db_url>

# Run the R2 repopulation script
pnpm --filter @workspace/scripts run repopulate-r2
```

The repopulation script queries all `project_versions` rows that are referenced by `projects.published_snapshot_id` or `projects.staging_published_snapshot_id` and re-uploads each file to R2 under `{projectId}/{versionId}/{path}`.

**Per-project manual repopulation** (when only one project is affected):

```sql
-- Get the snapshot details for a specific project
SELECT p.id, p.public_slug, p.published_snapshot_id, pv.files_snapshot
FROM projects p
JOIN project_versions pv ON pv.id = p.published_snapshot_id
WHERE p.public_slug = '<slug>';
```

Then use the admin API to trigger a re-publish:
```bash
curl -X POST https://api.mustaflow.app/api/admin/projects/<id>/repopulate-r2 \
  -H "Authorization: Bearer <admin_token>"
```

**Recovery validation**:
```bash
# Verify R2 has the file
curl -I "https://<account_id>.r2.cloudflarestorage.com/mustaflow-snapshots/<projectId>/<versionId>/index.html"

# Verify edge serves it
curl -I "https://<slug>.mustaflow.app/"
# Expect: CF-Cache-Status: HIT or MISS (not error)
```

---

### 3. KV routing table corrupted / missing entries

**Symptoms**: Worker returns `404` for a published project even though R2 objects exist.

**Diagnosis**:
```bash
# Check the KV entry for a hostname
curl -X GET "https://api.cloudflare.com/client/v4/accounts/<account_id>/storage/kv/namespaces/<namespace_id>/values/<slug>.mustaflow.app" \
  -H "Authorization: Bearer <CF_API_TOKEN>"
```

**Fix**: Trigger a re-publish from the MustaFlow admin panel or via the API:
```bash
curl -X POST https://<host>/api/admin/projects/<id>/resync-kv \
  -H "Authorization: Bearer <admin_token>"
```

This re-runs `syncAllHostnamesKV` with the current `publishedSnapshotId`.

**Recovery validation**: Re-fetch the KV value and verify `versionId` matches `projects.published_snapshot_id`.

---

### 4. Cache purge failed after republish

**Symptoms**: Users see stale content after republishing; KV routing was updated correctly.

**Manual cache purge**:
```bash
curl -X POST "https://api.cloudflare.com/client/v4/zones/<CF_ZONE_ID>/purge_cache" \
  -H "Authorization: Bearer <CF_API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"files": ["https://<slug>.mustaflow.app/", "https://<slug>.mustaflow.app/index.html"]}'
```

**Purge everything for a zone** (use sparingly — affects all tenants):
```bash
curl -X POST "https://api.cloudflare.com/client/v4/zones/<CF_ZONE_ID>/purge_cache" \
  -H "Authorization: Bearer <CF_API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"purge_everything": true}'
```

**Recovery validation**: `curl -I https://<slug>.mustaflow.app/` and check `CF-Cache-Status: MISS` on first request after purge, `HIT` on subsequent.

---

### 5. Bandwidth hard-cap reached (API fallback only)

**Symptoms**: Published site starts returning `429 Too Many Requests` from origin when the project exceeds its monthly bandwidth allowance.

**Response**:
1. The API fallback continues to serve the site (no CDN is involved).
2. Soft-cap (80%) — a warning banner appears in the Publishing tab for the project owner.
3. Hard-cap (100%) — the API serves with `X-Mustaflow-Cap: hard-cap` header (informational only; serving continues for now — actual hard-stop is a future billing milestone).

**To reset bandwidth for a project** (admin only):
```sql
UPDATE project_bandwidth SET bytes_served = 0, request_count = 0
WHERE project_id = <id> AND month = '<YYYY-MM>';
```

---

## Health Check Commands

```bash
# Check API server status
curl https://<host>/api/healthz

# Check a specific published project via API fallback
curl -I https://<host>/api/p/<slug>/

# Check edge serving
curl -I https://<slug>.mustaflow.app/

# Check Cloudflare origin tag
curl -sI https://<slug>.mustaflow.app/ | grep X-Mustaflow
```

---

## Contacts & Escalation

- Cloudflare dashboard: https://dash.cloudflare.com
- Cloudflare status: https://www.cloudflarestatus.com
- R2 status: included in Cloudflare status page
- Internal escalation: check `#infrastructure` Slack channel

---

## See Also

- `artifacts/api-server/src/lib/cloudflare.ts` — all CF API methods
- `artifacts/api-server/src/lib/serveSnapshot.ts` — fallback serving logic
- `artifacts/api-server/src/routes/publish.ts` — publish/unpublish/promote flows
- `replit.md` — full environment variable reference
