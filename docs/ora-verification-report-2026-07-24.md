# Ora Website + Mobile Verification Report — 2026-07-24

Verification of all Ora work currently landed on `main` / `claude/ora-mobile-website-verify-3217e1`, covering the website (`artifacts/mustaflow`), mobile app (`artifacts/ora-mobile`), and shared API (`artifacts/api-server`).

## Result

**AUTOMATED RELEASE GATE PASSED — 20/20 checks, 0 warnings, 0 failures.**

- Commit SHA verified: `021da9fd2417a16bc5b5a0d76a09fc5496c86f71` (branch at parity with `main`, clean tree)
- Gate command: `pnpm --filter @workspace/scripts run ora-stability-gate -- --profile=release --require-clean --report=tmp/ora-stability-gate-report.md`
- Pass/fail: pass=20 warn=0 fail=0 (release profile)
- Manual checklist (`docs/ora-stability-gate.md`): **not run** — requires a live signed-in browser/TestFlight session; still required before website publish or TestFlight submission
- Known warnings/skips: none from the gate itself; see environment notes below

## Work verified

All recent Ora waves are on `main` and covered by this gate run:

- Brand Kit (`d6d725b`, `77c96e7`, `021da9f`) — DB schema, CRUD API, file-builder branding for DOCX/XLSX/PPTX/PDF, website Settings section, mobile Settings link
- Phase 10 True Artifact Revision Engine (`ef82ef9`, `2b67be7`)
- Release-gate smoke test fixes (`82b598a`)
- Phase 9C–9G file agent work (preview cards, cancel-edit, format regression pack, mobile file card parity)

## Check breakdown

| Area           | Checks                                                                                                             | Result |
| -------------- | ------------------------------------------------------------------------------------------------------------------ | ------ |
| Preflight      | git-commit, git-clean, feature-registry                                                                            | PASS   |
| Build          | api-typecheck, web-typecheck, mobile-typecheck                                                                     | PASS   |
| API            | core routing/quality, search/current-info, files/images, realtime voice, release-extended, account/billing/history | PASS   |
| Website        | Talk to Ora realtime, UI/account/billing wiring, release-extended UI/file/source/history                           | PASS   |
| Mobile         | parity + wiring tests, Talk to Ora reconnect hook                                                                  | PASS   |
| Release builds | api-build, web-build (prerender + bundle budget), lint                                                             | PASS   |

Website production build prerendered 13 routes; public entry initial JS 500.7 kB against a 2048 kB budget.

## Environment notes (first gate run failures, all environment-caused)

An initial gate run in the fresh CI container failed 6 checks. None were code defects; all were reproduced-environment gaps:

1. **Workspace lib `dist` outputs missing** — the three typecheck checks fail (TS6305) in a fresh checkout until `pnpm run typecheck:libs` (`tsc --build`) has run once. The gate invokes per-package typechecks directly and does not build `lib/*` first.
2. **No Postgres** — `api-release-extended` (`ora-realtime-usage.test.ts`), `api-account-billing-history` (`ora-memory-consolidation.test.ts`), and the web build's `prerender-dynamic-routes` step all need a live `DATABASE_URL`. Fixed by provisioning local Postgres 16 + pgvector, `drizzle-kit push`, and `migrate-all-outstanding`.
3. **Fresh-DB migration quirks** (pre-existing, not introduced by recent work):
   - `drizzle-kit push` fails on `chat_messages_content_tsv_idx` until `migrate-agent-inbox` has added the `content_tsv` column (push cannot create it).
   - `migrate-orax-desktop` fails on a fresh DB with `column "host_id" does not exist` (expects a pre-push table shape). Orax desktop only — does not affect Ora website/mobile. 82/83 outstanding migrations succeeded.

## Outstanding before publish/TestFlight

- Run the manual checklist in `docs/ora-stability-gate.md` (multi-turn voice web+mobile, search/current info, image gen/edit, file upload/analysis/chart/export, billing/account sync, conversation history, App Store compliance, website/mobile parity).
- Brand Kit manual validation per the feature registry: website Settings → Brand Kit end-to-end (colors/fonts/logo into generated DOCX/XLSX/PPTX/PDF); mobile Settings → Brand Kit link opens website settings in the in-app browser.
