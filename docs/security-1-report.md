# Phase Security-1 — Publish/Preview Bypass Closure Report

**Date:** 2026-06-02  
**Scope:** Five bypass paths in the publish/preview pipeline that could allow unauthorized content publication, editor instrumentation injection, or WebSocket proxy access without session validation.

---

## Executive Summary

Five distinct bypass paths were identified and closed:

| # | Fix | Severity | Status |
|---|-----|----------|--------|
| 1 | Remove consoleBridge injection from public snapshots | Medium | Fixed |
| 2 | Retire legacy `deploy.ts` route with 410 Gone | High | Fixed |
| 3 | Enforce testing approval for ALL project types in `publish.ts` | High | Fixed |
| 4 | WebSocket upgrade validation for preview subdomain gateway | High | Fixed |
| 5 | Production secrets isolation (environment=production filter) | High | Fixed |

---

## Fix 1 — consoleBridge injection in public snapshots

**File:** `artifacts/api-server/src/lib/serveSnapshot.ts`  
**Function:** `serveSnapshotById()`

**Before:** `serveSnapshotById` called `injectBridge(body)` for every HTML file served through the shared snapshot helper. This function is called from:
- Staging snapshot serve (`serveSnapshotByProjectEnv env=staging`)
- Preview snapshot serve (`servePreviewSnapshot`)
- Production custom-domain serve (`serveSnapshotByProjectEnv env=production`)

All of these are user-facing endpoints — the consoleBridge script (`window.parent.postMessage`) is editor instrumentation that has no business appearing in staging, preview-snapshot, or production responses.

**After:** Removed the `injectBridge(body)` call and the unused `injectBridge` import. The file content is served as-is. Bridge injection remains only in the authenticated editor preview route (`routes/files.ts`).

**Regression tests:** S1-A, S1-B, S1-C in `tests/preview-security.test.ts`

---

## Fix 2 — Legacy deploy route bypassed all gates

**File:** `artifacts/api-server/src/routes/deploy.ts`

**Before:** `POST /api/projects/:id/deploy` published live `project_files` directly to production. It read the current working copy of project files, created a snapshot from them, and marked the project as published — with no `testingApprovedAt` check, no `testedSnapshotId` requirement, and no migration safety gate. This was a complete bypass of the entire test-then-publish workflow.

**After:** The route returns `410 Gone` for all callers with a migration message pointing to `POST /api/projects/:id/publish?env=production`. No file access, no snapshot creation, no DB writes beyond the 410 response.

**Regression tests:** S2-A, S2-B, S2-C in `tests/preview-security.test.ts`

---

## Fix 3 — Static projects bypassed the testing-approval gate

**File:** `artifacts/api-server/src/routes/publish.ts`  
**Section:** Test-then-publish gate (line ~163)

**Before:** The `testing_required` hard block was wrapped in `else if (hasContainer)` — so it only fired for projects with a Fly.io container. Static HTML and React SPA projects had no `testedSnapshotId` and could publish to production by navigating directly to the publish endpoint without ever creating a test preview or getting approval.

**Before (pseudocode):**
```
if (project.testedSnapshotId) { use approved snapshot }
else if (hasContainer) { hard block — testing required }
// static projects: silently fell through to publishing draft files
```

**After:** The block applies to ALL project types. Any project without a `testedSnapshotId` is rejected with 422 `testing_required` regardless of its `builderMode` or whether it has a container.

**After (pseudocode):**
```
if (project.testedSnapshotId) { use approved snapshot }
else { hard block for ALL types — testing required }
```

**Regression tests:** S3-A through S3-F in `tests/preview-security.test.ts`

---

## Fix 4 — WebSocket upgrades on preview subdomain had no session validation

**Files:**  
- `artifacts/api-server/src/middlewares/previewSubdomainGateway.ts` (new exports)  
- `artifacts/api-server/src/index.ts` (upgrade handler)

**Before:** The `server.on('upgrade', ...)` handler in `index.ts` only routed upgrades based on pathname (multiplayer, terminal, debug, live-preview). It had no branch checking if the `Host` header matched a preview subdomain. Any WebSocket connection attempt to `{sessionId}.preview.mustaflow.app` would fall through to `socket.destroy()` (upgrade not handled) — but this was a latent attack surface gap: if anyone added a catch-all or if the routing order changed, WebSocket upgrades could be proxied without session checks.

**After:** A new branch at the top of the upgrade handler checks `isPreviewSubdomainHost(host)`. If it matches:
1. `validatePreviewWebSocketUpgrade(host, cookieHeader)` is called — same HMAC + DB + expiry + revocation checks as the HTTP middleware
2. On failure: socket is destroyed with a warning log
3. On success: WebSocket upgrade is proxied to the test container via raw TCP pipe with `HTTP/1.1 101 Switching Protocols`

Two new exports added to `previewSubdomainGateway.ts`:
- `isPreviewSubdomainHost(host)` — fast check before any async work
- `validatePreviewWebSocketUpgrade(host, cookie)` — full HMAC + DB validation

**Security invariants verified:**
- `Host` must match `{16-hex-chars}.preview.mustaflow.app`
- `__prs` cookie must be present and HMAC-verified
- Cookie session ID must match the Host session ID
- DB session must exist, not be revoked, and not be expired
- Test container must be in `running` status

**Regression tests:** S4-A through S4-G in `tests/preview-security.test.ts`

---

## Fix 5 — Production container received all secrets (no environment filter)

**File:** `artifacts/api-server/src/routes/publish.ts`  
**Section:** Container env-var assembly (line ~558)

**Before:** When publishing a full-stack project, the production container deployment queried `project_secrets` with only `eq(secretsTable.projectId, projectId)` — no `environment` filter. This meant development secrets (`environment = 'development'`) and testing secrets (`environment = 'testing'`) were injected into production container env vars alongside production secrets.

**After:** The query now filters with `and(eq(secretsTable.projectId, projectId), eq(secretsTable.environment, 'production'))`. Only secrets explicitly marked for the production environment are injected.

**Complementary isolation:**
- Preview containers (in `preview-env.ts`) already filter by `isPreviewSafe = true`
- This fix adds the production-environment filter for production container deployments
- The two filters are intentionally orthogonal: `isPreviewSafe` controls which secrets are safe for the shared test container; `environment` controls which secrets belong to which deployment stage

**Regression tests:** S5-A through S5-E in `tests/preview-security.test.ts`

---

## Route inventory matrix

| Route | Auth required | Gate | Notes |
|-------|--------------|------|-------|
| `GET /api/p/:slug/{*splat}` | None | Published snapshot only | Public; no bridge injection; no secret decryption |
| `GET /api/projects/:id/preview/{*splat}` | Clerk session + project membership | Editor only | Bridge injected; authenticated |
| `POST /api/projects/:id/publish?env=production` | Clerk session + project ownership | testedSnapshotId required (all types) | Uses approved snapshot as source |
| `POST /api/projects/:id/publish?env=staging` | Clerk session + project ownership | No approval gate (staging) | Staging is testing-only |
| `POST /api/projects/:id/deploy` | Clerk session + project ownership | 410 Gone | Retired; migrate to /publish |
| `GET /__preview-launch?t=...` | Launch token (single-use) | HMAC hash match, single-use | Issues __prs cookie |
| `{sessionId}.preview.*` (HTTP) | __prs cookie | HMAC + DB session + expiry + revocation | Per-request validation |
| `{sessionId}.preview.*` (WS upgrade) | __prs cookie | HMAC + DB session + expiry + revocation | New: same checks as HTTP |
| `POST /api/projects/:id/preview-env/start` | Clerk session + project ownership | isPreviewSafe filter on secrets | Only preview-safe secrets injected |
| `POST /api/projects/:id/preview-env/approve` | Clerk session + project ownership | 3 preconditions (healthy, matching snapshot, version exists) | Sets testedSnapshotId |

---

## Files changed

| File | Change |
|------|--------|
| `artifacts/api-server/src/lib/serveSnapshot.ts` | Remove `injectBridge` call + import from `serveSnapshotById()` |
| `artifacts/api-server/src/routes/deploy.ts` | Replaced entire route with 410 Gone handler |
| `artifacts/api-server/src/routes/publish.ts` | Extended testing gate to all project types; production secrets now filtered by `environment='production'` |
| `artifacts/api-server/src/middlewares/previewSubdomainGateway.ts` | Added `validatePreviewWebSocketUpgrade()` and `isPreviewSubdomainHost()` exports |
| `artifacts/api-server/src/index.ts` | Added preview-subdomain branch to `server.on('upgrade', ...)` |
| `artifacts/api-server/src/tests/preview-security.test.ts` | Added 25 regression tests (S1–S5) |

---

## Regression test summary

All 25 new tests + 14 original tests in `tests/preview-security.test.ts` pass.

| Group | Tests | Coverage |
|-------|-------|----------|
| S1 | 3 | consoleBridge absent from public/staging/snapshot paths |
| S2 | 3 | deploy route 410 Gone, no file access |
| S3 | 6 | testing gate blocks static, SPA, full-stack; approved snapshot used as source |
| S4 | 7 | WS: valid, expired, revoked, no-cookie, tampered-HMAC, wrong-host, container-stopped |
| S5 | 5 | preview isolation, production isolation, no secret decryption in public path, no secret logging |
