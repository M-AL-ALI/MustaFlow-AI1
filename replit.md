# MustaFlow AI

An AI-powered app builder for non-technical users. Describe an app idea in natural language; MustaFlow plans, builds, and deploys it.

> Full per-phase / per-task implementation history lives in `docs/changelog.md`. This file is the working memory: project overview, how to run, where things live, preferences, and known limitations.

## Scope

- **Web-first by default, mobile when the prompt calls for it**: the builder generates static web apps (HTML/CSS/JS + Tailwind + Lucide via CDN), React SPAs, full-stack Node.js apps, or native mobile apps (Expo/React Native) — the stack is auto-detected from the user's prompt. Mobile generation is fully enabled; no UI changes needed to surface it.
- **User journey**: visit landing → create account → describe idea → AI builds → preview → publish to testing → promote to production.

## Run & operate

- `pnpm --filter @workspace/api-server run dev` — API server (port 8080, proxied at /api)
- `pnpm --filter @workspace/mustaflow run dev` — frontend (Vite)
- `pnpm run typecheck` — full typecheck across all packages (canonical check)
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks + Zod schemas after editing openapi.yaml
- `pnpm --filter @workspace/db run push` — push DB schema (dev). Custom migration scripts live in `scripts/src/migrate-*.ts` and are registered in `scripts/package.json`.
- `pnpm --filter @workspace/scripts run seed` — seed sample projects (no-op if any exist)

### Required env

`DATABASE_URL`, `AI_INTEGRATIONS_OPENAI_BASE_URL`, `AI_INTEGRATIONS_OPENAI_API_KEY`, `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `VITE_CLERK_PUBLISHABLE_KEY`, `ENCRYPTION_KEY`, `ORA_SESSION_SECRET`

### Optional env (features gracefully no-op when missing)

- **GitHub OAuth**: `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `GITHUB_OAUTH_REDIRECT_URL`
- **Namecheap (domain purchase)**: `NAMECHEAP_API_USER`, `NAMECHEAP_API_KEY`, `NAMECHEAP_USERNAME`, `NAMECHEAP_CLIENT_IP`, `NAMECHEAP_SANDBOX`, `NS1_HOSTNAME`, `NS2_HOSTNAME`, `DOMAIN_MARKUP_PERCENT`
- **Cloudflare edge CDN**: `CF_ACCOUNT_ID`, `CF_R2_ACCESS_KEY_ID`, `CF_R2_SECRET_ACCESS_KEY`, `CF_R2_BUCKET`, `CF_KV_NAMESPACE_ID`, `EDGE_SERVING_ENABLED`
- **Managed Redis**: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
- **Knowledge Vault tuning**: `KNOWLEDGE_RETRIEVAL_ENABLED` (default `true`), `KNOWLEDGE_TOKEN_BUDGET` (default `2400`)
- **Containers (Fly.io)**: `FLY_API_TOKEN`, `FLY_APP_NAME`, `FLY_ORG_SLUG`, `FLY_REGION`
- **Neon Postgres (agentic auto-provisioning)**: `NEON_API_KEY` (required), `NEON_ORG_ID` (optional — required only for org-scoped API keys; auto-detected via `/users/me/organizations` when missing, cached for the process lifetime)
- **Container log retention** (Task #750): `CONTAINER_LOG_RETENTION_DAYS` (default `14`), `CONTAINER_LOG_MAX_ROWS_PER_PROJECT` (default `10000`). A scheduler in `artifacts/api-server/src/lib/container-log-retention.ts` runs ~1 min after boot and every 6 h, deleting `container_logs` rows older than the retention window and trimming each project to the row cap so long-lived agentic projects don't grow the table forever.
- **Platform domain**: `PLATFORM_DOMAIN` (default `mustaflow.app`), `PLATFORM_CNAME_TARGET` (default `hosted.mustaflow.app`)
- **Admin bootstrap**: `ADMIN_USER_IDS` (comma-separated Clerk user IDs)

### Migrations

- `pnpm --filter @workspace/scripts run migrate-preferred-region` — adds `preferred_region` to `projects` (edge CDN geo-routing)
- `pnpm --filter @workspace/scripts run migrate-runtime-breadth` — creates `scheduled_job_runs`, `managed_addons`, `project_environments`, `environment_promotions`, `usage_events` tables (Task #628)
- `pnpm --filter @workspace/scripts run migrate-secret-scoping` — adds `min_role` column + check constraint to `project_secrets` (Task #632; run before deploy)
- `pnpm --filter @workspace/scripts run migrate-agentic-provisioning` — adds `builder_mode`, `neon_project_id`, `provisioning_status`, `provisioning_error` to `projects` (Task #738; run before deploy)
- `pnpm --filter @workspace/scripts run migrate-task-agent-mode` — adds `task_agent_mode` to `agent_tasks` (correctness fix: freeze mode at enqueue time; run before deploy)
- `pnpm --filter @workspace/scripts run migrate-preview-secrets` — adds `is_preview_safe` to `project_secrets` (Task #766; run before deploy)
- `pnpm --filter @workspace/scripts run migrate-testing-approval` — adds `testing_approved_at`, `testing_approved_by`, `migration_status`, `migration_log`, `testing_skipped` to `project_versions` (Task #767; run before deploy)
- `pnpm --filter @workspace/scripts run migrate-preview-db` — adds `preview_db_url`, `preview_db_status` to `projects` (Task #767; run before deploy)
- `pnpm --filter @workspace/scripts run migrate-mobile-deployment-columns` — adds `build_id`, `platform`, `download_url`, `testflight_url` to `deployment_logs` (Task #776; run before deploy)
- `pnpm --filter @workspace/scripts run migrate-chip-label` — adds `chip_label` to `projects` (Task #794; run before deploy)
- `pnpm --filter @workspace/scripts run migrate-personal-access-tokens` — creates `personal_access_tokens` table (Task #845; run before deploy)
- `pnpm --filter @workspace/scripts run migrate-pat-rotation` — adds `rotated_at` to `personal_access_tokens` (Task #864; run before deploy)
- `pnpm --filter @workspace/scripts run migrate-canvas-state` — adds `canvas_state` JSONB to `projects` (Task #904; run before deploy)
- `pnpm --filter @workspace/scripts run migrate-low-credit-email` — adds `last_low_credit_email_at` to `user_credits` (Task #1003; run before deploy)
- `pnpm --filter @workspace/scripts run migrate-provisioning-steps` — adds `provisioning_step` and `provisioning_started_at` to `projects` (Task #988; run before deploy)
- `pnpm --filter @workspace/scripts run migrate-agent-tool-calls` — creates `agent_tool_calls` table and adds `tool_call_rate_cap_per_hour` to `projects` (Task #993; run before deploy)
- `pnpm --filter @workspace/scripts run migrate-knowledge-usage-events` — creates `knowledge_usage_events` table (Phase 8B-3A; run before deploy)
- `pnpm --filter @workspace/scripts run migrate-image-studio` — creates `generated_images` table (Task #1178 Phase 9A-1; run before deploy)
- `pnpm --filter @workspace/scripts run migrate-image-studio-v2` — adds negativePrompt, purpose, providerName, modelName, thumbnailUrl columns to `generated_images` (Phase 9A-1 completion; run before deploy)
- `pnpm --filter @workspace/scripts run migrate-image-edit-lineage` — adds parentImageId, sourceType, editInstruction columns to `generated_images` (Phase 9A-2 image editing; run before deploy)

## Stack

- pnpm workspaces, Node 24, TypeScript 5.9
- **API**: Express 5, Drizzle ORM + Postgres, Zod, pino
- **Frontend**: React + Vite + Tailwind v4 + shadcn/ui + wouter + TanStack Query
- **Auth**: Clerk session cookie + a fresh bearer token on every API call. The backend `getAuth(req)` accepts both; the bearer token guards against the dev-mode JWT cookie (60s lifetime) going stale inside the embedded preview iframe.
- **AI**: OpenAI Chat Completions via the Replit AI integration. Models route by agent mode: `lite`/`eco` → gpt-5-mini, `power`/`pro` → gpt-5.4.
- **API contract**: OpenAPI → Orval (React Query hooks + Zod schemas)

## Where things live

- API contract: `lib/api-spec/openapi.yaml` (regenerate after edits via `codegen`)
- Generated client hooks: `lib/api-client-react/src/generated/api.ts`
- Generated Zod schemas: `lib/api-zod/src/generated/api.ts`
- DB schema: `lib/db/src/schema/*`
- API routes: `artifacts/api-server/src/routes/*`
- AI prompts & model routing: `artifacts/api-server/src/lib/ai.ts`
- Builder pipelines: `artifacts/api-server/src/lib/builder.ts` (`runBuildPipeline`, `runRefinePipeline`, `runPlanPipeline`, mobile variants)
- Job runner: `artifacts/api-server/src/lib/jobs.ts`
- Auth adapter: `artifacts/api-server/src/lib/auth.ts` (ClerkAuthAdapter active; DevOnlyAuthAdapter is a swap point)
- Encryption: `artifacts/api-server/src/lib/encryption.ts` (AES-256-GCM, format `v1:<iv>:<ct>:<tag>`)
- Snapshot serving: `artifacts/api-server/src/lib/serveSnapshot.ts`
- Frontend pages: `artifacts/mustaflow/src/pages/*`
- Frontend layout: `artifacts/mustaflow/src/components/layout/app-layout.tsx` (sidebar; intentionally NOT wrapping the public landing page)
- Theme system: `artifacts/mustaflow/src/lib/theme.ts` + `components/theme-toggle.tsx` (dark default, light opt-in)

## Architecture decisions (load-bearing)

- **AI calls are non-streaming** Chat Completions — Orval can't generate SSE hooks; keeps server + client simple.
- **Plan Mode** uses `response_format: json_object` so the structured plan can render as a card.
- **Secrets** are never returned from the API — only a masked preview (`••••••••XXXX`). Encrypted at rest.
- **Auth** is cookie + bearer. The Orval `customFetch` attaches a fresh `Authorization: Bearer <token>` via the registered token getter (App.tsx `ClerkTokenProvider`). Raw `fetch("/api/...")` calls that bypass Orval MUST go through `authFetch` (`artifacts/mustaflow/src/lib/api-fetch.ts`) — it adds the bearer token and `credentials: "include"`. Cookie-only requests intermittently 401 ("Session expired") in the preview iframe because the dev-mode JWT cookie expires every ~60s.
- **Generated apps are static** (HTML/CSS/JS + Tailwind/lucide via CDN). They are served from the DB at `GET /api/projects/:id/preview/{*splat}` and iframed. No npm/build tools run server-side. Iframe sandbox: `allow-scripts allow-forms allow-popups` (no `allow-same-origin`).
- **Versions**: every successful build/refine snapshots all files into `project_versions.filesSnapshot` and writes a `TaskReport`. Rollback restores via `POST /api/projects/:id/versions/:versionId/rollback`.
- **Soft delete**: projects use `deleted_at` and all list/get queries filter `IS NULL`. Hard-delete recovery requires admin SQL.
- **Publishing**: freezes a snapshot into `project_versions`, stores ID on `projects.published_snapshot_id`, exposes `/api/p/:slug/`. Draft edits invisible until next publish. Custom-domain hostname middleware in `app.ts` serves the snapshot directly when `Host` matches a stored `customDomain`.
- **Path routing**: frontend mounted at `/`; API at `/api`. Shared proxy routes most-specific-first.
- **Public routes** mounted before the auth wall: `/api/healthz`, `/api/p/:slug/{*splat}`, `/share/:token`, `/api/gallery-templates`, `/api/extensions`, `/api/profiles/:username`. Unknown prefixes return JSON 404 before auth.

## Product surface

- **Landing page** (`pages/home.tsx`): public, sidebar-free, has its own sticky header with logo + theme toggle + Log in / Create account. Signed-in visitors auto-redirect to `/projects`.
- **Sign-in / Sign-up**: Clerk-hosted at `/sign-in` and `/sign-up`, dark-themed.
- **Projects dashboard**: summary stats, recent activity, project grid (auth-gated).
- **Project workspace**: left rail + top tab bar (Preview, Canvas, Tools & Files, Publishing, Comments, Activity, Terminal, Logs, etc.) + fixed bottom AI Builder chat with Plan Mode toggle and Lite/Eco/Power/Pro modes.
- **Canvas tab**: includes a Variants mode that generates 2-8 parallel UI variants from one prompt, each in its own iframe tile with Graduate / Delete controls (`routes/canvas.ts`).
- **Manage tab**: rename, export ZIP, duplicate, soft-delete, share links.
- **Publishing tab**: readiness checks, snapshot publish, deployment history, site settings (title/meta/theme), custom domain + DNS instructions.
- **Knowledge Vault**: auto-populated after every build/refine/rollback/publish/duplicate. Injected into future prompts (token-budgeted).
- **Billing/Credits**: starter 100 credits per new user. Costs: lite=1, eco=2, power=5, pro=10. Pre-flight check fails task if balance < cost.
- **Admin**: `/admin` page gated by `requireAdmin` middleware + `user_roles` table. Bootstrap via `ADMIN_USER_IDS` env.
- **Ecosystem**: `/gallery` (template gallery), `/extensions` (marketplace), `/community` + `/u/:username` (public profiles).
- **Image Studio** (`pages/image-studio.tsx`): standalone `/image-studio` page for async AI image generation (draft/standard/high quality, 1:1/16:9/9:16 aspect ratios, vivid/natural styles). Images stored as WebP base64 data URIs in `generated_images`. Sidebar link added. Ora chat also detects image generation intents via `IMAGE_GENERATE_PATTERNS` and generates inline via the same provider, rendering an `InlineImageResultCard` in the chat bubble. Credit costs: draft=1, standard=3, high=6.
- **Collaboration** (orgs): personal org auto-created per user; team orgs with `owner|admin|editor|viewer` roles; threaded comments; share links; notifications inbox; activity log.

## User preferences

- **No emojis anywhere in the product UI** — use lucide-react icons.
- **Original branding** — never reference Replit or other third-party brands in user-facing copy or imagery.
- **Landing page**: sidebar-free for visitors; sidebar appears only after login.
- **Dark mode is default**; light mode is an opt-in toggle.
- **All stacks enabled**: static HTML, React SPA, full-stack Node.js, and native mobile (Expo/React Native) are all live. Stack is auto-detected; do not hard-code kind on new projects.

## Theme J — Enterprise, Compliance & Polish (Task #632)

- **GDPR data export**: `GET /api/me/export` — authenticated user downloads a ZIP of all their projects, generated files, AI chat history, and knowledge vault entries. Secret values are never included. `DELETE /api/me` — soft-deletes all user-owned projects (Clerk account deletion handled separately via Clerk UI).
- **Per-secret min_role scoping**: `project_secrets.min_role` column (`viewer|member|admin|owner`, default `viewer`). The Secrets tab shows an "Access Role" dropdown per secret; PATCH /api/projects/:id/secrets/:secretId accepts `minRole`. DB migration: `migrate-secret-scoping`. OpenAPI `SecretEntry` schema updated; codegen re-run.
- **Org audit log API**: `GET /api/orgs/:orgId/activity` — paginated activity feed across all org projects (filtered by membership). `?format=csv` exports as CSV (admin/owner only). Activity tab added to org-settings page.
- **Trust & Security page**: `/trust` — public page documenting certifications (SOC 2 in progress, GDPR ready, HIPAA enterprise tier), encryption posture, sub-processors, vulnerability disclosure, and compliance contacts. Route registered in App.tsx; sidebar footer link added.
- **Onboarding tour**: `OnboardingTour` component — 5-step guided overlay for first-time users (localStorage flag `mustaflow_tour_seen`). Shown after 1.2s delay on first authenticated visit. Automatically skipped for returning users.
- **Offline indicator**: `OfflineIndicator` component — mounts globally; listens to `online/offline` browser events; shows a dismissible banner when the browser loses connectivity.
- **Privacy & Data settings tab**: New "Privacy & Data" tab in Settings — GDPR data export button, Privacy Policy + Trust page + DPA request links, account data deletion form (requires typing "DELETE" to confirm).
- **Key files**: `artifacts/api-server/src/routes/gdpr.ts`, `scripts/src/migrate-secret-scoping.ts`, `artifacts/mustaflow/src/pages/trust.tsx`, `artifacts/mustaflow/src/components/onboarding-tour.tsx`, `artifacts/mustaflow/src/components/offline-indicator.tsx`.

## Task #738 — Agentic auto-provisioning (Fly + Neon)

- New projects are stamped `builder_mode = 'agentic'` and `provisioning_status = 'provisioning'` at creation; a background job (`enqueueProvisionProjectJob` in `artifacts/api-server/src/lib/provisioning.ts`) creates a Fly.io machine + a Neon Postgres project, then stores the connection string as the `DATABASE_URL` project secret (encrypted via `encryptionService`).
- The pipeline is idempotent: container creation is skipped when `containerId` is set, Neon creation when `neonProjectId` is set. Safe to re-run via `POST /api/projects/:id/provision/retry`.
- Required env for full auto-provisioning: `FLY_API_TOKEN` (+ `FLY_APP_NAME`, `FLY_ORG_SLUG`, `FLY_REGION`) and `NEON_API_KEY`. When missing, the corresponding step no-ops and the project still settles into `ready` (matches dev-mode degradation elsewhere).
- The workspace top bar shows a provisioning badge (`provisioning → ready → hibernated → error`) with a "Retry" link when the last attempt failed (`artifacts/mustaflow/src/pages/projects/[id].tsx`).
- Existing projects are untouched — they keep `builder_mode = 'static-legacy'` and `provisioning_status = 'idle'` so the badge stays hidden.
- **Verification status (Task #763, 2026-05-25): PASS end-to-end.** `createNeonProject` in `provisioning.ts` now includes `org_id` in the POST body. The value is resolved by `resolveNeonOrgId` — explicit `NEON_ORG_ID` env var wins, otherwise we auto-detect via `GET /api/v2/users/me/organizations` and cache for the process lifetime (a null cache means "personal API key, no org needed" so we don't keep re-checking). Re-running `pnpm --filter @workspace/api-server exec tsx src/verify-agentic-provisioning.ts` now reports PASS on both Fly and Neon, including a real `SELECT 1` against the newly created Neon DB.

## Known limitations (honest status)

- **Mobile generation**: fully enabled — `mobile-cross` Expo SDK pipeline runs automatically when the prompt describes a mobile app.
- **Clerk dev keys** banner is expected in dev. Production keys auto-provisioned by Replit on deploy.
- **Publishing v1**: `/api/p/:slug/` is served by the API server from DB snapshots, not a real CDN. Cloudflare R2/Worker is wired but `EDGE_SERVING_ENABLED` must be set when the Worker is deployed.
- **Soft-deleted projects**: not self-recoverable from the UI — needs an admin SQL update.
- **Credits**: enforced but no self-serve Stripe top-up flow yet. Use the `grantCredits` helper or direct SQL.
- **Post-merge `pnpm db push`**: occasionally requires TTY confirmation for the `projects_custom_domain_unique` constraint — falls back to a non-fatal stderr warning. Apply manually with `pnpm --filter @workspace/db run push` in an interactive shell if needed.
- **Schema drift catch-up (Task #776)**: all outstanding migration scripts have been applied to the dev DB (notifications, knowledge_entries.scope, project_secrets.exposure_type, project_secrets.min_role, project_secrets.is_preview_safe, preview_sessions, testing workflow columns, and more). Use `pnpm --filter @workspace/scripts run migrate-all-outstanding` to apply all migrations in one shot on a fresh DB.
- **Preview secrets default is_preview_safe=false**: newly added secrets require the user to explicitly toggle "Preview safe" in the Secrets tab before they are injected into the live preview container. Run `migrate-preview-secrets` before deploy.
- **Agentic provisioning dev-mode (Task #776)**: when `FLY_API_TOKEN` or `NEON_API_KEY` are absent, provisioning now degrades gracefully to `provisioningStatus = 'idle'` (no red badge, no error toast) instead of marking the project as `'error'`. The project can be provisioned later via Retry once secrets are added.

## Test-then-publish workflow (Task #768)

Full architecture spec lives in `docs/changelog.md`. Key implementation files:

- **Schema**: `lib/db/src/schema/projects.ts` (10 testing columns), `lib/db/src/schema/versions.ts` (`testingApprovedAt`, `testingApprovedBy`, `migrationStatus`, `testingSkipped`), `lib/db/src/schema/secrets.ts` (`exposureType`), `lib/db/src/schema/preview-sessions.ts` (new table)
- **Migration**: `scripts/src/migrate-testing-workflow.ts` (run with `pnpm --filter @workspace/scripts run migrate-testing-workflow`)
- **Preview env routes**: `artifacts/api-server/src/routes/preview-env.ts` — start/rebuild/stop/status/approve/session endpoints at `/api/projects/:id/preview-env/*`
- **Gateway middleware**: `artifacts/api-server/src/middlewares/previewSubdomainGateway.ts` — intercepts `{sessionId}.preview.{PLATFORM_DOMAIN}`, validates HMAC cookie, proxies to test container
- **Invalidation helpers**: `artifacts/api-server/src/lib/testing-invalidation.ts` — `staleDraftCandidate` (marks `testingStatus=stale` after draft edit), `revokePreviewForSecurityChange` (stops container on secret change)
- **Health injection**: `artifacts/api-server/src/lib/health-inject.ts` — injects `GET /healthz` into server-stack builds before writing to `project_files`
- **Publish gates**: `artifacts/api-server/src/routes/publish.ts` — auto-resolves `testedSnapshotId` as snapshot source; blocks full-stack projects without tested snapshot; blocks schema-changing SQL (`ALTER TABLE`, `DROP TABLE`, etc.); blue/green abort if container deploy fails
- **Approve preconditions**: `artifacts/api-server/src/routes/versions.ts` — 3 preconditions added to `approve-testing` endpoint; also sets `project.testedSnapshotId` + `testingStatus=passed`

### Env / deployment notes

- `PLATFORM_DOMAIN` (default `mustaflow.app`) — used by gateway to identify preview subdomains
- The migration adds columns to `projects`, `project_versions`, and `project_secrets`, and creates `preview_sessions`. Run it before deploying.
- Full-stack projects (`containerId` set) now **require** a tested snapshot before publishing to production. Static projects continue to publish directly.
