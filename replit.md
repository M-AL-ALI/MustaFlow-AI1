# MustaFlow AI

An AI-powered app builder for non-technical users. Describe an app idea in natural language; MustaFlow plans, builds, and (eventually) deploys it.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — API server (port 8080, proxied at /api)
- `pnpm --filter @workspace/mustaflow run dev` — frontend (Vite, port assigned by workflow)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks + Zod schemas
- `pnpm --filter @workspace/db run push` — push DB schema (dev)
- `pnpm --filter @workspace/scripts run seed` — seed sample projects (no-op if any exist)
- Required env: `DATABASE_URL`, `AI_INTEGRATIONS_OPENAI_BASE_URL`, `AI_INTEGRATIONS_OPENAI_API_KEY`, `SESSION_SECRET`

## Stack

- pnpm workspaces, Node 24, TypeScript 5.9
- API: Express 5, Drizzle ORM + Postgres, Zod validation, pino logging
- Frontend: React + Vite + Tailwind + shadcn/ui + wouter + TanStack Query
- AI: OpenAI Chat Completions via the Replit AI integration (gpt-5-nano/mini/5.4 by agent mode)
- API contract: OpenAPI → Orval (React Query hooks + Zod schemas)

## Where things live

- API contract: `lib/api-spec/openapi.yaml` (regenerate after edits)
- Generated client hooks: `lib/api-client-react/src/generated/api.ts`
- Generated Zod schemas: `lib/api-zod/src/generated/api.ts`
- DB schema: `lib/db/src/schema/*` (projects, messages, tasks, versions, secrets, knowledge)
- AI prompts & model routing: `artifacts/api-server/src/lib/ai.ts`
- API routes: `artifacts/api-server/src/routes/*`
- Frontend pages: `artifacts/mustaflow/src/pages/*`

## Architecture decisions

- AI calls are non-streaming Chat Completions (Orval can't generate SSE hooks; keeps client + server simple).
- Plan Mode uses a separate system prompt and `response_format: json_object` so the structured plan can render as a card.
- Secret values are never returned from the API — only a masked preview (`••••••••XXXX`).
- Tasks are simulated (status flips to `completed` after a short delay) — the live build engine is a placeholder for a later milestone.
- Frontend artifact is mounted at `/`; API at `/api`. The shared proxy routes most-specific-first.

## Product

- Home: hero prompt that creates a project from natural language.
- Projects dashboard: summary stats, recent activity, project grid.
- Project workspace: left rail sections, top tab bar (Preview, Canvas, Tools & Files, Publishing, Logs, etc.), fixed bottom AI Builder chat with Plan Mode toggle and Lite/Eco/Power/Pro agent modes.
- Knowledge Vault: shared learnings across builds.

## User preferences

- No emojis anywhere in the product UI — use lucide-react icons instead.
- Original branding (not a Replit clone).

## Known limitations

- No authentication/authorization yet — all project endpoints are open. This is intentional for the current single-user prototype milestone; before opening to multiple users, add an auth layer (Clerk or Replit Auth), a `userId` foreign key on `projects`, and an ownership check in every project-scoped route handler.
- Secrets are stored plaintext in `project_secrets.value_encrypted` (column name is aspirational). Values are masked in API responses, but encrypt at rest before allowing real secrets in.
- The "build engine" that actually generates app code is a placeholder — tasks auto-complete after a short delay so the UI shows movement.

## Gotchas

- After editing `lib/api-spec/openapi.yaml`, run `pnpm --filter @workspace/api-spec run codegen`. It also runs `typecheck:libs`, which will fail if generated types break consumers — fix consumers, don't suppress.
- Orval mutation hooks take `{ id, data }` at the top level for parameterized routes — never just `{ data }`.
- Query options always require `queryKey` — pair `useX(id, { query: { enabled, queryKey: getXQueryKey(id) } })`.
- Never `console.log` in server code — use `req.log` or the singleton `logger`.

## Pointers

- See the `pnpm-workspace` skill for monorepo structure, TS references, and codegen
- See the `ai-integrations-openai` skill for AI integration details
