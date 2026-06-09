---
name: ORAX surface (isolation + repo add)
description: How the ORAX coding-agent surface is isolated from Ora/AI-Builder, and what adding a repo actually requires.
---

# ORAX surface

ORAX (`/orax`, `artifacts/mustaflow/src/pages/orax.tsx`, backend `routes/orax.ts`)
is a separate coding-agent surface from normal Ora chat and the AI Builder.

- **Isolation invariant**: every ORAX call must be `/api/orax/*`. It must NEVER
  touch `/api/public-ai/*` (normal Ora chat), `ora-conversations`, or AI-Builder
  `/api/projects/*` build routes. The page also has no Ora history/sidebar.
  **Why:** ORAX is intentionally walled off from Ora/Builder; a leak would cross
  surfaces. **How to apply:** when editing orax.tsx, grep that no non-orax API
  prefix appears; the orax-wiring test guards the failure-recovery strings.

- **Adding a repo needs no GitHub OAuth.** `POST /api/orax/repositories` inserts a
  row with `connectionStatus: "metadata_only"` from just a URL/owner/name. Only the
  *optional* `POST /api/orax/repositories/:id/github/connect` (read-only token) needs
  a token. So `GITHUB_OAUTH_*` being unset does NOT block add/select repo or starting
  a task — it only blocks the read-only GitHub connect/scan step.

- **Live UI testing of authed ORAX flows is blocked in this env.** The testing
  tool's `testClerkAuth: true` programmatic sign-in fails (browser redirects to
  `/sign-in`, 401 on `/api/me`); the only viable auth is the Google OAuth UI, which
  the tool can't drive. Verify authed ORAX behavior via unit tests (orax-wiring) +
  route/auth curl checks + architect code review instead of live Playwright.
