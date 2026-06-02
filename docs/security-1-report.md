# Phase Security-1 — Publish/Preview Bypass Closure Report

**Date:** 2026-06-02  
**Status:** COMPLETE  
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

**Regression tests:** S2-A, S2-B, S2-C / T15 in `tests/preview-security.test.ts` and `tests/security-1-closeout.test.ts`

---

## Fix 3 — Static projects bypassed the testing-approval gate

**File:** `artifacts/api-server/src/routes/publish.ts`  
**Section:** Test-then-publish gate

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

**Regression tests:** S3-A through S3-F / T16–T17 in `tests/preview-security.test.ts` and `tests/security-1-closeout.test.ts`

---

## Fix 4 — WebSocket upgrades on preview subdomain had no session validation

**Files:**  
- `artifacts/api-server/src/middlewares/previewSubdomainGateway.ts` (new exports)  
- `artifacts/api-server/src/index.ts` (upgrade handler)

**Before:** The `server.on('upgrade', ...)` handler in `index.ts` only routed upgrades based on pathname. It had no branch checking if the `Host` header matched a preview subdomain. WebSocket upgrades to `{sessionId}.preview.mustaflow.app` fell through without session checks.

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
**Section:** Container env-var assembly

**Before:** When publishing a full-stack project, the production container deployment queried `project_secrets` with only `eq(secretsTable.projectId, projectId)` — no `environment` filter. Development and testing secrets were injected into production container env vars alongside production secrets.

**After:** The query now filters with `and(eq(secretsTable.projectId, projectId), eq(secretsTable.environment, 'production'))`. Only secrets explicitly marked for the production environment are injected.

**Complementary isolation:**
- Preview containers (in `preview-env.ts`) already filter by `isPreviewSafe = true`
- This fix adds the production-environment filter for production container deployments
- The two filters are intentionally orthogonal: `isPreviewSafe` controls which secrets are safe for the shared test container; `environment` controls which secrets belong to which deployment stage

**Regression tests:** S5-A through S5-E in `tests/preview-security.test.ts`

---

## Route Inventory Matrix

| Route | File | Public / Private | Auth Required | Approved Snapshot Required | Secrets Allowed | Bridge Injected | WebSocket |
|---|---|---|---|---|---|---|---|
| `GET /api/p/:slug/{*splat}` | `lib/serveSnapshot.ts` | Public | None | N/A (frozen snapshot) | No | No | No |
| `GET /api/projects/:id/preview/{*splat}` | `routes/files.ts` | Private | Clerk session + member | No | Preview-safe only | Yes | No |
| `GET /api/projects/:id/preview-env/status` | `routes/preview-env.ts` | Private | Clerk session + owner | No | No | No | No |
| `POST /api/projects/:id/preview-env/start` | `routes/preview-env.ts` | Private | Clerk session + owner | No | Preview-safe only | No | No |
| `POST /api/projects/:id/preview-env/approve` | `routes/preview-env.ts` | Private | Clerk session + owner | No | No | No | No |
| `POST /api/projects/:id/publish?env=production` | `routes/publish.ts` | Private | Clerk session + owner | Yes — all project types | No | No | No |
| `POST /api/projects/:id/publish?env=staging` | `routes/publish.ts` | Private | Clerk session + owner | No (staging only) | No | No | No |
| `POST /api/projects/:id/deploy` *(removed)* | `routes/deploy.ts` | Private | Clerk session + owner | N/A — 410 Gone | N/A | N/A | N/A |
| `POST /api/projects/:id/unpublish` | `routes/publish.ts` | Private | Clerk session + owner | No | No | No | No |
| `POST /api/projects/:id/promote` | `routes/publish.ts` | Private | Clerk session + owner | No (from staging snapshot) | No | No | No |
| `GET /__preview-launch?t=...` | `middlewares/previewSubdomainGateway.ts` | Private | One-time launch token | N/A | No | No | No |
| `* {sessionId}.preview.*` (HTTP) | `middlewares/previewSubdomainGateway.ts` | Private | HMAC cookie + DB session | No | Preview-safe only | No | No |
| `* {sessionId}.preview.*` (WS upgrade) | `middlewares/previewSubdomainGateway.ts` | Private | HMAC cookie + DB session | No | No | No | Yes |
| `GET /api/projects/:id/canvas/share/:token` | `routes/canvas.ts` | Public | Share token | N/A | No | No | No |

---

## Files Changed

| File | Change |
|------|--------|
| `artifacts/api-server/src/lib/serveSnapshot.ts` | Remove `injectBridge` call + import from `serveSnapshotById()` |
| `artifacts/api-server/src/routes/deploy.ts` | Replaced entire route body with 410 Gone handler |
| `artifacts/api-server/src/routes/publish.ts` | Extended testing gate to all project types; production secrets filtered by `environment='production'` |
| `artifacts/api-server/src/middlewares/previewSubdomainGateway.ts` | Added `validatePreviewWebSocketUpgrade()` and `isPreviewSubdomainHost()` exports |
| `artifacts/api-server/src/index.ts` | Added preview-subdomain branch to `server.on('upgrade', ...)` |
| `artifacts/api-server/src/tests/preview-security.test.ts` | Added 25 regression tests (S1–S5) |
| `artifacts/api-server/src/tests/security-1-closeout.test.ts` | Added T15–T17 closeout regression tests |

---

## Regression Test Summary

All new tests + 14 original tests pass.

| Group | Test IDs | Count | Coverage |
|-------|----------|-------|----------|
| Original | T01–T14 | 14 | Auth gate, bridge isolation, container fallback, staging gate, secret isolation |
| S1 | T01–T05 overlap + S1-A/B/C | 3 | consoleBridge absent from public/staging/snapshot paths |
| S2 | T15 | 3 | deploy route 410 Gone, no file access |
| S3 | T16–T17 + coverage | 6 | testing gate blocks static, SPA, full-stack; approved snapshot used as source |
| S4 | S4-A–S4-G | 7 | WS: valid, expired, revoked, no-cookie, tampered-HMAC, wrong-host, container-stopped |
| S5 | T12–T13 overlap + S5-A–S5-E | 5 | preview isolation, production isolation, no secret decryption in public path |

---

## Residual Risks

The following risks are **out of scope** for Security-1 and remain open:

| Risk | Severity | Notes |
|---|---|---|
| **CDN / Cloudflare edge layer not hardened** | Medium | R2 upload + KV routing sync are best-effort; a CDN misconfiguration could serve stale or wrong snapshot bytes. Cloudflare WAF rules not reviewed. |
| **Browser-only DNS not validated** | Low | Custom domain DNS verification relies on Cloudflare CNAME checks, not server-side re-validation per request. A domain can be hijacked if the registrar record is changed after verification. |
| **Mobile deploy pipeline not in scope** | Low | EAS builds (`routes/eas.ts`) and mobile signing (`routes/signing.ts`) are not gated by the testing-approval pipeline. Mobile builds bypass `publish.ts` entirely. |
| **Promote path not gated** | Low | `POST /projects/:id/promote` copies the staging snapshot to production without re-checking `testedSnapshotId`. The assumption is that staging was already reviewed, but there is no approval gate on the promote path itself. |
| **Staging publish path** | Low | `POST /publish?env=staging` does not require a tested snapshot (intentional). If staging and production share infrastructure (e.g. a database) there is risk of contamination. |
| **Rate limiting on /publish** | Low | `publishLimiter` exists but thresholds have not been tuned relative to the new gate. |
| **WebSocket in custom-domain middleware** | Low | Prod container WebSocket upgrades through `customDomainMiddleware` have no additional session check — acceptable for production since the user is authenticated via the app itself. |

---

## Verification Checklist

- [x] `POST /deploy` returns `410 Gone` for all callers (authenticated or not, with or without approved snapshot)
- [x] `POST /publish?env=production` on a static project without `testedSnapshotId` returns `422 testing_required`
- [x] `POST /publish?env=production` on a static project with `testedSnapshotId` set proceeds and uses frozen approved snapshot
- [x] `POST /publish?env=production` on a full-stack project without `testedSnapshotId` still blocked (pre-existing gate unchanged)
- [x] `POST /publish?env=staging` is unaffected (no testing gate on staging publishes)
- [x] consoleBridge absent from all public/staging/snapshot HTML responses
- [x] WebSocket upgrades to preview subdomains validated against HMAC cookie + DB session
- [x] Production container deployments only receive `environment='production'` secrets
- [x] All 14 original tests in `preview-security.test.ts` pass
- [x] All new Security-1 tests (S1–S5, T15–T17) pass
- [x] TypeScript typechecks clean across all packages
