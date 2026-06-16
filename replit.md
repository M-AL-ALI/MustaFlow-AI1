# MustaFlow AI

MustaFlow is an AI-powered app builder for non-technical users. A user describes an app idea in natural language; MustaFlow plans, builds, previews, and publishes it.

Full historical implementation notes belong in `docs/changelog.md`. Keep this file as working memory only: current architecture, commands, active product surfaces, known limitations, and decisions that affect future work.

## Current Status

- Main product flow: landing page -> account -> describe idea -> AI build/refine -> preview -> test -> publish.
- Supported app stacks: static web apps, React SPAs, full-stack Node.js apps, and Expo/React Native mobile apps. Stack is auto-detected from the prompt.
- Ora is the public AI assistant and is intentionally separate from Builder/ORAX project agents.
- Ora Phase 6 validation is complete through automated coverage; live signed-in browser validation remains limited by Clerk dev-key/programmatic-auth throttling in dev.
- Ora response quality has been hardened: direct answers first, cleaner ChatGPT-style formatting, fewer raw Markdown symbols, QA checks for formatting clutter, and frontend rendering for headings/bold/lists/tables.
- Support Center wiring and protected routes are covered by automated tests; signed-in browser validation should be repeated when Clerk test auth is available.

## Run And Verify

- API server: `pnpm --filter @workspace/api-server run dev` (port 8080, proxied at `/api`)
- Frontend: `pnpm --filter @workspace/mustaflow run dev`
- Full typecheck: `pnpm run typecheck`
- Quality gate: `pnpm run quality-gate`
- API codegen after OpenAPI edits: `pnpm --filter @workspace/api-spec run codegen`
- DB schema push in dev: `pnpm --filter @workspace/db run push`
- Seed sample projects: `pnpm --filter @workspace/scripts run seed`

On Windows checkouts, Vitest can fail if the optional `@esbuild/win32-x64` package is missing. Replit/Linux remains the canonical test environment for the full gate.

## Required Env

Core:

- `DATABASE_URL`
- `AI_INTEGRATIONS_OPENAI_BASE_URL`
- `AI_INTEGRATIONS_OPENAI_API_KEY`
- `CLERK_SECRET_KEY`
- `CLERK_PUBLISHABLE_KEY`
- `VITE_CLERK_PUBLISHABLE_KEY`
- `ENCRYPTION_KEY`
- `ORA_SESSION_SECRET`

Important optional env:

- Ora voice TTS: `OPENAI_API_KEY`
- Anthropic/Gemini/DeepSeek routing: provider keys as configured in `artifacts/api-server/src/lib/public-ai/model-router.ts`
- Disable DeepSeek temporarily: `DEEPSEEK_DISABLED=true`
- GitHub OAuth: `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `GITHUB_OAUTH_REDIRECT_URL`
- Cloudflare/R2 edge hosting: `CF_ACCOUNT_ID`, `CF_R2_ACCESS_KEY_ID`, `CF_R2_SECRET_ACCESS_KEY`, `CF_R2_BUCKET`, `CF_KV_NAMESPACE_ID`, `EDGE_SERVING_ENABLED`
- Ora asset R2 offload: `ORA_ASSETS_R2_ENABLED=true` plus Cloudflare/R2 credentials
- Upstash rate limiting: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
- Fly.io containers: `FLY_API_TOKEN`, `FLY_APP_NAME`, `FLY_ORG_SLUG`, `FLY_REGION`
- Neon auto-provisioning: `NEON_API_KEY`, optional `NEON_ORG_ID`
- Platform domain: `PLATFORM_DOMAIN`, `PLATFORM_CNAME_TARGET`
- Admin bootstrap: `ADMIN_USER_IDS`

## Migrations

Migration scripts live in `scripts/src/migrate-*.ts` and are registered in `scripts/package.json`.

Use the specific migration for the feature being deployed, or use the catch-up helper on a fresh/stale dev DB:

- `pnpm --filter @workspace/scripts run migrate-all-outstanding`
- `pnpm --filter @workspace/db run push`

Current high-signal migration areas:

- Ora usage windows and legacy `ora_daily_usage` removal
- Ora asset R2 storage (`ora_assets.storage_key`, nullable `data`, XOR constraint)
- Ora project descriptions
- Testing/publishing workflow columns and preview sessions
- Agentic provisioning columns and tool-call tracking
- Image Studio tables and image-edit lineage
- Knowledge usage events
- Personal access tokens and rotation columns
- Credit and billing support columns

If `pnpm db push` prompts for a constraint in a non-interactive shell, run it manually in an interactive terminal.

## Stack

- pnpm workspaces, Node 24, TypeScript 5.9
- API: Express 5, Drizzle ORM, Postgres, Zod, pino
- Frontend: React, Vite, Tailwind v4, shadcn/ui, wouter, TanStack Query
- Auth: Clerk cookie plus fresh bearer token on API calls
- AI: OpenAI-compatible chat completions, plus provider routing for Ora specialists
- API contract: OpenAPI -> Orval React Query hooks + Zod schemas

## Important Paths

- API contract: `lib/api-spec/openapi.yaml`
- Generated client hooks: `lib/api-client-react/src/generated/api.ts`
- Generated Zod schemas: `lib/api-zod/src/generated/api.ts`
- DB schema: `lib/db/src/schema/*`
- API routes: `artifacts/api-server/src/routes/*`
- Builder pipeline: `artifacts/api-server/src/lib/builder.ts`
- Builder/agent jobs: `artifacts/api-server/src/lib/jobs.ts`
- Auth adapter: `artifacts/api-server/src/lib/auth.ts`
- Encryption: `artifacts/api-server/src/lib/encryption.ts`
- Snapshot serving: `artifacts/api-server/src/lib/serveSnapshot.ts`
- Frontend pages: `artifacts/mustaflow/src/pages/*`
- Layout/sidebar: `artifacts/mustaflow/src/components/layout/app-layout.tsx`
- Theme system: `artifacts/mustaflow/src/lib/theme.ts`, `components/theme-toggle.tsx`
- Ora backend: `artifacts/api-server/src/routes/public-ai/*`, `artifacts/api-server/src/lib/public-ai/*`
- Ora frontend: `artifacts/mustaflow/src/components/ora-panel.tsx`, `artifacts/mustaflow/src/components/ora/*`
- Support Center: `artifacts/mustaflow/src/pages/support*`, `artifacts/api-server/src/routes/help*`

## Hard Rules

These are permanent, non-negotiable product constraints. Any code, test, or feature that violates them must be rejected.

- **Ora isolation:** Ora must never offer, route to, or mention the AI Builder. Forbidden in any active Ora code path: `handoffCta`, `builder_handoff`, `MustaFlow Builder`, `Continue in Builder`, `ready to build`, any call to `/api/public-ai/handoff/create` or `/api/builder/handoff/exchange`. Enforced by `__tests__/ora-isolation.test.ts` (11 tests).

## Architecture Decisions

- AI calls are non-streaming Chat Completions. Orval does not generate SSE hooks, so non-streaming keeps server/client contracts simple.
- Plan Mode uses JSON response formatting so structured plans render reliably.
- Secrets are encrypted at rest and never returned raw; APIs return masked previews only.
- Raw frontend `fetch("/api/...")` calls must use `authFetch` so Clerk bearer tokens and cookies are attached consistently.
- Generated static apps are served from DB snapshots and iframed. No npm/build tools run server-side for static app preview.
- Every successful build/refine snapshots files into `project_versions.filesSnapshot` and writes a `TaskReport`.
- Projects use soft delete via `deleted_at`; admin SQL is required for recovery.
- Publishing freezes a snapshot into `project_versions` and exposes `/api/p/:slug/`; draft changes remain invisible until republished.
- Public API routes must mount before auth middleware.

## Ora Model And Routing

- Main router: `artifacts/api-server/src/lib/public-ai/model-router.ts`
- Ora routes are plan-aware across anonymous/free/core/wave tiers.
- OpenAI remains terminal fallback where needed.
- Specialist surfaces include chat, deep thinking, memory extraction/recall, file handling, image generation/editing, image analysis, search/media search, dataset/file analysis, expertise profiles, and response quality scoring.
- DeepSeek has no vision support and is filtered out for vision/image-analysis routes.
- If DeepSeek balance is unavailable, set `DEEPSEEK_DISABLED=true` to avoid retry latency.
- Ora must not inject Builder/project knowledge unless the user is in a proper Builder/ORAX context.
- Ora usage is metered by Ora quotas, not Builder credits.

## Ora Response Quality Rules

- Answer the user's actual prompt first.
- For pasted Replit/Codex/GitHub/ChatGPT output, analyze it as reference text, identify the actor, and give the shortest useful reply or next step.
- Do not route pasted status reports to file generation just because they mention files, commits, tests, or workflows.
- Avoid raw Markdown clutter in ordinary chat: no unnecessary tables, pipe separators, decorative dividers, raw `##` headings, excessive `**bold**`, or `$math$` notation.
- Prefer short paragraphs, simple labels, and compact numbered/bulleted steps.
- Frontend rendering should make common Markdown readable if it appears anyway.

## Product Surface

- Landing page: public, sidebar-free, with its own header. Signed-in users redirect to `/projects`.
- Projects dashboard: summary stats, recent activity, project grid.
- Workspace: Preview, Canvas, Tools & Files, Publishing, Comments, Activity, Terminal, Logs, plus Builder chat.
- Canvas variants: 2-8 parallel UI variants with Graduate/Delete controls.
- Manage: rename, ZIP export, duplicate, soft delete, share links.
- Publishing: readiness checks, snapshot publish, deployment history, site settings, DNS/custom domain.
- Knowledge Vault: auto-populated after build/refine/rollback/publish/duplicate and injected into future prompts.
- Billing/Credits: starter credits and per-mode costs. Keep superuser bypasses in credit/admin/plan gates.
- Admin: `/admin`, gated by `requireAdmin` and `user_roles`; bootstrap via `ADMIN_USER_IDS`.
- Image Studio: `/image-studio`, async image generation and edit lineage.
- Support Center: help articles are public where intended; support chat/tickets are auth-gated.

## User Preferences

- No emojis in product UI. Use `lucide-react` icons.
- Original branding only. Do not mention Replit or other third-party brands in user-facing product copy.
- Landing page remains sidebar-free for visitors.
- Dark mode is default; light mode is opt-in.
- Keep all app stacks enabled. Do not hard-code one stack on new projects.

## Known Limitations

- Clerk dev-key warnings are expected in dev. Programmatic signed-in browser tests can be blocked by Clerk throttling/redirects; rerun those manually or in a fresh authenticated session.
- Publishing v1 serves DB snapshots through the API server unless `EDGE_SERVING_ENABLED` and Cloudflare Worker/R2 are configured.
- Soft-deleted projects are not self-recoverable from the UI.
- Self-serve Stripe top-up is not complete; use helper/admin paths for manual credits.
- Preview secrets default to not preview-safe until explicitly toggled.
- Agentic provisioning degrades gracefully when Fly/Neon env vars are missing.

## Git And Sync Notes

- Replit/Linux is the canonical verification environment.
- Avoid force-pushing over Windows/Replit work. Pull or fetch/merge first.
- If a stale local Git ref blocks fetch, remove only the malformed ref file and fetch again.
- Keep this file concise. Put detailed task-by-task history in `docs/changelog.md`.
