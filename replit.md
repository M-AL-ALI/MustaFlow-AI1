# MustaFlow AI

An AI-powered app builder for non-technical users. Describe an app idea in natural language; MustaFlow plans, builds, and deploys it.

## Scope — Web First

The builder generates **static web apps** (HTML/CSS/JS + Tailwind + Lucide via CDN). Mobile (Expo/React Native) is a future milestone and is intentionally not exposed in the UI. Do not add mobile project kinds or mobile generation prompts until the Phase 4 mobile milestone is approved.

The intended user journey is: Login → create project → build app → preview → export/download → duplicate → publish to testing → promote to production.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — API server (port 8080, proxied at /api)
- `pnpm --filter @workspace/mustaflow run dev` — frontend (Vite, port assigned by workflow)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks + Zod schemas after editing openapi.yaml (run `codegen-drift` validation to confirm generated files are in sync; run `typecheck` validation to catch type errors across all packages; both can be run together in a single validation pass)
- `pnpm --filter @workspace/db run push` — push DB schema (dev)
- `pnpm --filter @workspace/scripts run seed` — seed sample projects (no-op if any exist)
- Required env: `DATABASE_URL`, `AI_INTEGRATIONS_OPENAI_BASE_URL`, `AI_INTEGRATIONS_OPENAI_API_KEY`, `SESSION_SECRET`, `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `VITE_CLERK_PUBLISHABLE_KEY`, `ENCRYPTION_KEY`

## Stack

- pnpm workspaces, Node 24, TypeScript 5.9
- API: Express 5, Drizzle ORM + Postgres, Zod validation, pino logging
- Frontend: React + Vite + Tailwind v4 + shadcn/ui + wouter + TanStack Query
- Auth: Clerk (ClerkAuthAdapter active; `clerkMiddleware` in app.ts; `getAuth(req)` in routes)
- AI: OpenAI Chat Completions via the Replit AI integration (gpt-5-nano/mini/5.4 by agent mode)
- API contract: OpenAPI → Orval (React Query hooks + Zod schemas)

## Where things live

- API contract: `lib/api-spec/openapi.yaml` (regenerate after edits)
- Generated client hooks: `lib/api-client-react/src/generated/api.ts`
- Generated Zod schemas: `lib/api-zod/src/generated/api.ts`
- DB schema: `lib/db/src/schema/*` (projects, messages, tasks, versions, secrets, knowledge)
- AI prompts & model routing: `artifacts/api-server/src/lib/ai.ts`
- Auth adapter: `artifacts/api-server/src/lib/auth.ts` (swap point: ClerkAuthAdapter ↔ DevOnlyAuthAdapter)
- Encryption service: `artifacts/api-server/src/lib/encryption.ts` (AES-256-GCM active; reads ENCRYPTION_KEY env var)
- Knowledge vault helper: `artifacts/api-server/src/lib/knowledge.ts` (writeKnowledge — best-effort, non-fatal)
- API routes: `artifacts/api-server/src/routes/*`
- Frontend pages: `artifacts/mustaflow/src/pages/*`

## Architecture decisions

- AI calls are non-streaming Chat Completions (Orval can't generate SSE hooks; keeps client + server simple).
- Plan Mode uses a separate system prompt and `response_format: json_object` so the structured plan can render as a card.
- Secret values are never returned from the API — only a masked preview (`••••••••XXXX`).
- Auth is cookie-based for web (Clerk session cookie). No bearer tokens needed on the frontend — do NOT add getToken() or Authorization headers to browser API calls.
- Generated apps are static (HTML/CSS/JS + Tailwind/lucide via CDN). They are served from the DB at `GET /api/projects/:id/preview/{*splat}` and iframed in the Preview tab. No npm/build tools run server-side.
- Every successful build/refine snapshots all current files into `project_versions.filesSnapshot` and writes a `TaskReport` onto `agent_tasks.report`. The report card renders in the chat. Rollback restores the snapshot via `POST /api/projects/:id/versions/:versionId/rollback`.
- Frontend artifact is mounted at `/`; API at `/api`. The shared proxy routes most-specific-first.
- Projects are soft-deleted (`deleted_at` column). All project-scoped data is retained server-side. All list/get queries filter `deleted_at IS NULL`.
- Publishing freezes a snapshot into `project_versions` and stores its ID in `projects.published_snapshot_id`. The public URL `/api/p/:id/` serves from the snapshot — draft edits are invisible until next publish. Unpublish clears `published_snapshot_id` and the public URL returns 404.

## Product

- Home: public hero prompt — authenticated users redirect to /projects; unauthenticated see the landing page.
- Sign-in / Sign-up: Clerk-hosted pages at /sign-in and /sign-up, themed to match the dark UI.
- Projects dashboard: summary stats, recent activity, project grid (auth-gated).
- Project workspace: left rail sections, top tab bar (Preview, Canvas, Tools & Files, Publishing, Logs, etc.), fixed bottom AI Builder chat with Plan Mode toggle and Lite/Eco/Power/Pro agent modes.
- Manage tab: Rename/edit project name+description, Export (ZIP download), Duplicate, Delete (2-step confirmation → soft delete → redirect to /projects).
- Publishing tab: web publish pipeline — freezes snapshot, sets publishedSnapshotId, returns truly public `/api/p/:id/` URL. iOS/Android publishing is UI-only placeholder.
- Knowledge Vault: shared learnings across builds. Auto-populated after every build, refine, rollback, publish, duplicate. Entries have projectId, type, severity, approvedForReuse.
- Sidebar: shows signed-in user name/avatar and sign-out button.

## User preferences

- No emojis anywhere in the product UI — use lucide-react icons instead.
- Original branding (not a Replit clone).
- Web-first: do not add mobile generation to the UI until Phase 4 mobile milestone is explicitly approved.

## Builder engine (Phase 2)

- `artifacts/api-server/src/lib/builder.ts` — three pipelines: `runBuildPipeline` (initial generation), `runRefinePipeline` (change requests), `runPlanPipeline` (Plan Mode). All use OpenAI JSON-mode; `power`/`pro` route to gpt-5.4, `lite`/`eco` to gpt-5-mini.
- `artifacts/api-server/src/lib/jobs.ts` — `enqueueJob` uses `setImmediate` for background tasks; `runJob` is shared by main-agent (synchronous) and background-agent paths so background tasks run the same pipeline, not a fake auto-complete.
- Generated apps are static (HTML/CSS/JS + Tailwind/lucide via CDN). No npm/build tools run server-side.

## Auth (Phase 3)

- Clerk is the active auth provider. `ClerkAuthAdapter` reads `getAuth(req).userId` from the Clerk session cookie.
- `DevOnlyAuthAdapter` exists as a swap point (sets userId = "demo-user") for local testing without Clerk. Never active in production.
- `requireProjectOwnership` middleware runs on every project-scoped route: returns 401 if not authenticated, 403 if the project belongs to a different user.
- Health endpoint (`/api/healthz`) and public project route (`/api/p/:id/`) are mounted before `attachUser`.
- Unknown route prefixes return JSON 404 before the auth wall (routes/index.ts prefix guard).
- Frontend: `ClerkProvider` with `publishableKeyFromHost` (supports custom domains), `proxyUrl` from env (empty in dev, auto-set in prod), dark-themed sign-in/sign-up pages.

## Encryption (Phase 3B)

- `AES256GcmEncryptionService` is active — reads `ENCRYPTION_KEY` (32-byte base64 env var).
- Encrypted format: `v1:<base64-iv>:<base64-ciphertext>:<base64-tag>`.
- Migration: values that don't start with `v1:` are treated as legacy plaintext on decrypt (backward compatible).
- In production: missing `ENCRYPTION_KEY` throws at startup. In dev: falls back to passthrough with a warning.
- `ENCRYPTION_KEY` is stored as a shared env var (not a secret — auto-generated, not user-provided).

## Export, Duplicate, Publish (Phase 3)

- `GET /api/projects/:id/export` — ownership-checked, streams a ZIP (fflate) of all project files + README + .env.example (secret names only, no values).
- `POST /api/projects/:id/duplicate` — copies metadata + files; skips secrets; scopes new project to requesting user. Writes a Knowledge Vault entry.
- `POST /api/projects/:id/publish` — snapshots current files into a `project_versions` row, stores the version ID in `projects.published_snapshot_id`, marks status=published, returns `/api/p/:id/` as the public URL. Writes a Knowledge Vault entry.
- `POST /api/projects/:id/unpublish` — clears `publishedSnapshotId`, reverts status to "testing". Public URL returns 404.
- `GET /api/p/:projectId/{*splat}` — public route (no auth); serves from the frozen snapshot. Returns 404 HTML if not published.
- `DELETE /api/projects/:id` — soft-deletes (sets `deleted_at`); returns 200 `{ deleted: true }`.
- `PATCH /api/projects/:id` — updates name, description, agentMode, status.

## Phase 4A — Mobile App Builder Foundation

- **Mobile project creation**: Create Project modal now has a Web / Mobile platform tab. Selecting Mobile creates a `mobile-cross` (Expo iOS + Android) project. The mobile lock in `routes/projects.ts` and `jobs.ts` is removed.
- **Mobile builder pipelines**: `runMobileBuildPipeline` and `runMobileRefinePipeline` in `builder.ts` generate complete Expo SDK 52 / Expo Router v3 / NativeWind v4 codebases. The AI also generates an `index.html` web preview served by the existing preview route.
- **Mobile plan mode**: `runPlanPipeline` detects mobile projects and uses `MOBILE_PLAN_SYSTEM_PROMPT`, which outputs `pages` (screens) and `nativeFeatures` fields compatible with the existing PlanCard.
- **Mobile validation**: `validateMobileFiles()` in `builder.ts` checks for required Expo structure: `app.json` (name/slug/version), `app/_layout.tsx`, `app/index.tsx`, and required packages.
- **QR code panel**: PreviewTab shows an "Expo Go" button for mobile projects. Clicking it opens a panel with a QR code (via qrserver.com) pointing to the web preview URL.
- **Phone frame default**: Mobile projects default to the phone frame view in the Preview tab.
- **6 mobile templates**: Onboarding & Auth, Social Feed, Mobile Store, Mobile Dashboard, Chat Messenger, Subscription SaaS — all `mobile-cross` kind.
- **DB schema**: `platform` column added to `projects` table (`web | ios | android | cross`). Set automatically on project creation from kind.
- **OpenAPI**: `mobile-cross` added to kind enum; `platform` and `mobilePreviewUrl` fields added to Project schema.
- **guessMime**: `.ts` / `.tsx` → `application/typescript` (previously unhandled).
- **Template picker**: `filterPlatform` prop filters web vs. mobile templates in the Create Project modal.
- Env vars: none new.

## Phase 4 — Public Launch Hardening

- **Public slugs**: `projects.publicSlug` column (UUID-based). `/api/p/:slug/` serves the published snapshot by slug; integer ID still accepted for legacy. Slug generated at first publish, preserved on republish.
- **Publish readiness gate**: `GET /api/projects/:id/publish-readiness?env=testing|production` — runs structured checks (required secrets set, at least one file, last build succeeded). Blocking failures prevent publish in the frontend UI.
- **Secret verification**: `POST /api/projects/:id/secrets/:secretId/verify` — server-side connectivity probe per secret category (HTTP ping for API keys, etc.). Status stored as `verificationStatus` on `SecretEntry`.
- **Published site settings**: `projects.siteTitle`, `projects.metaDescription`, `projects.themeColor` columns. `PATCH /api/projects/:id` supports them. Publishing tab exposes a site settings panel.
- **Deployment logs**: `deployment_logs` table + `GET /api/projects/:id/deployments` — records every publish/unpublish/duplicate with env, actor, and notes. Publishing tab shows full deployment history.
- **Rate limits**: `express-rate-limit` on AI (10/min), publish/export (5/min), global (300/15 min). JSON 429 responses.
- **Billing/Credits**: `user_credits` + `credit_transactions` tables. New users auto-provision 100 starter credits. `GET /api/credits`, `GET /api/credits/transactions`. Credit pre-flight check in `runJob` — fails task immediately if balance < cost. Post-success deduction (non-fatal). Costs: lite=1, eco=2, power=5, pro=10.
- **Admin dashboard**: `/admin` page (auth-gated, placeholder — real admin RBAC is a future milestone).
- **Terms / Privacy / Help**: static pages at `/terms`, `/privacy`, `/help`. Sidebar footer links + Help Center in RESOURCES section.
- **Encryption key rotation**: `scripts/src/rotate-encryption-key.ts` — operator runbook + re-encryption script using `pool` from `@workspace/db`.
- **Orval codegen conflict fix**: `GetPublishReadinessParams` was generated in both `lib/api-zod/src/generated/api.ts` (Zod schema) and `types/` (TypeScript type). Resolved by deleting the redundant type file, removing its barrel re-export, and adding an explicit tie-breaker in `lib/api-zod/src/index.ts`.
- **Domain management**: `projects.customDomain` (unique), `projects.domainStatus`, `projects.sslStatus` columns. `GET/PATCH/DELETE /api/projects/:id/domain` + `POST /api/projects/:id/domain/verify` (DNS CNAME check via `dns.promises.resolveCname`). Auto-subdomain: `{publicSlug}.mustaflow.app`. Custom-domain hostname middleware mounted in `app.ts` before `/api` — intercepts GET requests whose `Host` header matches a stored `customDomain` and serves the published snapshot directly (active in production once DNS is configured; no-op in Replit dev). Snapshot serving logic extracted to `artifacts/api-server/src/lib/serveSnapshot.ts` (shared by public route + custom domain middleware). Publishing tab "Domains" section: read-only subdomain display, custom domain input, DNS CNAME instructions table, domain/SSL status badges, "Check DNS" button.
- Env vars: `PLATFORM_DOMAIN` (default `mustaflow.app`), `PLATFORM_CNAME_TARGET` (default `hosted.mustaflow.app`) — set these in production to match real infrastructure.

## Known limitations (honest status)

- **Mobile generation**: Intentionally absent from the UI. The builder only produces static HTML/CSS/JS. Expo/React Native support is a future milestone.
- **Preview iframe**: `allow-same-origin` removed (Phase 2.1). Preview is sandboxed with `allow-scripts allow-forms allow-popups`. Safe for multi-user.
- **Clerk dev keys**: The "Development mode" banner on the sign-in page is expected in development. Production keys are auto-provisioned by Replit on deploy.
- **Publishing v1 (no CDN)**: The public URL `/api/p/:slug/` is served by the API server from DB-stored snapshot content. It is truly public (no auth). A real CDN/static-hosting push is Phase 5.
- **Project hard-delete recovery**: Soft-deleted projects are invisible in the UI and cannot be self-served recovered. An admin SQL query is needed to restore them.
- **Credits billing**: Credits are enforced in the builder but top-up/purchase flow is a future milestone (Stripe). Users who run out must be manually granted credits via the `grantCredits` helper or a direct SQL update.
- **Admin dashboard**: The `/admin` page is a placeholder. Real admin RBAC (role column, server-side guard) is a future milestone.

## Phase C — Server-Side Containers Per Project

- **Container provider**: Fly.io Machines API. Each project can have a dedicated Node.js 20 Alpine machine (`node:20-alpine`). Graceful degradation: when `FLY_API_TOKEN` is not set, all container operations are no-ops and the rest of the app works normally.
- **Container lifecycle**: `POST /api/projects/:id/container/start` → provision + start machine, sync project files to container disk. `POST /api/projects/:id/container/stop` → stop machine. `GET /api/projects/:id/container/status` → poll current status. `DELETE /api/projects/:id/container/destroy` → permanently delete machine.
- **File sync**: On container start, all `project_files` rows are written to container disk via Fly exec API. On file save (`PATCH /api/projects/:id/files/:fileId`), the change is forwarded to the live container (best-effort, non-fatal). After every AI build, `npm install` runs inside the container.
- **Preview routing**: Preview tab shows the container's proxy URL in the address bar when `containerStatus === "running"` and `containerUrl` is set. Shows a "Waking up…" banner when `containerStatus` is "starting" or "hibernated".
- **Terminal**: `/api/projects/:id/terminal` WebSocket endpoint (WS upgrade on HTTP server). Browser-side: custom input-buffered terminal in `terminal-tab.tsx`. Server-side PTY bridge: `terminal.ts` using Fly exec API to run `/bin/sh`.
- **Hibernation**: Fly machines auto-stop after 10 minutes of inactivity (`auto_destroy: false, auto_start: true` + `min_machines_running: 0`). Container wakes on next start call.
- **DB columns added (Phase C migration)**: `projects.container_id`, `projects.container_status`, `projects.container_url`; `container_logs` table.
- **Container migration script**: `pnpm --filter @workspace/scripts run migrate-containers` — applies the container columns to the DB (already run; safe to re-run — uses `IF NOT EXISTS`).
- **Required env (container features)**: `FLY_API_TOKEN`, `FLY_APP_NAME` (default: `mustaflow-containers`), `FLY_ORG_SLUG` (default: `personal`), `FLY_REGION` (default: `iad`). Without these, containers are disabled; everything else works normally.
- **Key files**: `artifacts/api-server/src/lib/container.ts` (Fly.io provider), `artifacts/api-server/src/lib/terminal.ts` (WS PTY bridge), `artifacts/api-server/src/routes/containers.ts` (lifecycle routes), `artifacts/mustaflow/src/pages/projects/components/terminal-tab.tsx` (Terminal tab UI).

## Gotchas

- After editing `lib/api-spec/openapi.yaml`, run `pnpm --filter @workspace/api-spec run codegen`. It also runs `typecheck:libs`, which will fail if generated types break consumers — fix consumers, don't suppress. The `codegen-drift` validation check (`pnpm --filter @workspace/api-spec run codegen && git diff --exit-code lib/api-client-react/src/generated lib/api-zod/src/generated`) catches any drift between the spec and committed generated files — run it (or let CI run it) after every spec edit.
- Orval mutation hooks take `{ id, data }` at the top level for parameterized routes — never just `{ data }`.
- Query options always require `queryKey` — pair `useX(id, { query: { enabled, queryKey: getXQueryKey(id) } })`.
- Never `console.log` in server code — use `req.log` or the singleton `logger`.
- Auth is cookie-based for web. Do NOT add `getToken()`, `setAuthTokenGetter`, or `Authorization: Bearer` to browser fetch calls — Clerk's session cookie handles it automatically.
- `tailwindcss({ optimize: false })` is required in vite.config.ts for Clerk themes to render correctly in production builds (Tailwind v4 + @clerk/themes nested @layer import issue).
- The `or` import from drizzle-orm is used in `jobs.ts` `loadKnowledgeContext` — do not remove it.
- All project queries must include `isNull(projectsTable.deletedAt)` (or use the `activeProjects` const in projects.ts). Never query projects without this filter.

## Pointers

- See the `pnpm-workspace` skill for monorepo structure, TS references, and codegen
- See the `ai-integrations-openai` skill for AI integration details
- See the `clerk-auth` skill for Clerk wiring details
