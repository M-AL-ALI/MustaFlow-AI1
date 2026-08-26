# Ora Stability Gate

The Ora Stability Gate is the required release checkpoint for every Ora fix, feature, website publish, and TestFlight/App Store submission.

Simple rule:

> Do not publish or submit TestFlight just because the new feature works. Publish only when the new feature works and all old critical Ora behavior still passes.

## Commands

Run from the repository root.

```bash
pnpm run ora:stability-gate
```

Use this after ordinary Ora fixes. It runs the fast automated gate across API, website, and mobile.

```bash
pnpm run ora:stability-gate:release
```

Use this before website publish or TestFlight/App Store submission. It requires a clean working tree and adds broader release/build coverage.

```bash
pnpm run ora:stability-gate:mobile
```

Use this after mobile-only changes. It still includes the fast shared checks because mobile depends on the shared Ora API contracts.

Optional report file:

```bash
pnpm --filter @workspace/scripts run ora-stability-gate -- --profile=release --require-clean --report=tmp/ora-stability-gate-report.md
```

When an automation host has a shorter execution window than the complete release gate, use a checkpoint outside the repository and run a bounded number of checks per invocation:

```bash
pnpm --filter @workspace/scripts run ora-stability-gate -- --profile=release --require-clean --checkpoint=/tmp/ora-release-gate.json --max-checks=4
```

Repeat the exact same command until it emits the normal `Complete` and `PASSED` lines. Intermediate invocations emit `CHECKPOINTED` and never claim the release passed. The checkpoint is bound to the exact commit, tree, profile, clean-tree policy, changed-file impact, and ordered check prefix; a mismatch fails closed instead of reusing stale evidence.

## What The Automated Gate Covers

The executable gate lives at `scripts/src/ora-stability-gate.ts`.

It runs:

- API server typecheck
- Website typecheck
- Mobile typecheck
- API routing, identity, date/time, response-quality, and model-router tests
- API live-search/current-info tests
- API file/image/export/chart tests
- API realtime voice/session/metering tests
- Website Talk to Ora focus, settle-window, reconnect, multi-turn, and watchdog tests
- Website Ora UI/account/billing/file-card tests
- Mobile parity, file-generation, billing, account-sync, safe-url, and voice privacy tests
- Mobile realtime reconnect hook tests

The release profile adds:

- Extended API memory, streaming, kill-switch, production-safety, account, billing, assets, and history tests
- Extended website Ora UI, source-card, upload, memory-manager, routing diagnostics, and analyst-export tests
- API production build
- Website production build
- Workspace lint

## Automatic Feature Registry

The gate owns a feature registry in `scripts/src/ora-stability-gate.ts`.

Every new Ora feature must be added to that registry in the same commit that adds the feature. This is not optional and should not wait for the user to remind Replit or Codex.

The registry entry must include:

- The feature name.
- Which surfaces own it: API, website, mobile.
- File hints that let the gate detect future changes.
- Website validation notes.
- Mobile validation notes.

When the gate runs, it automatically prints:

- The full registered Ora feature list.
- Which feature areas were touched by the current commit or dirty changes.
- Any changed Ora files that do not match a registered feature.

Release profile rule:

> If an Ora file changed but does not map to a registered feature area, do not publish or submit TestFlight until the registry and the related web/mobile validation notes are updated.

Live provider tests and physical-device checks are intentionally not automated because they depend on external services, real Apple/TestFlight state, or real microphones.

## Manual Checks Required Before Publish/TestFlight

Automation passing is necessary but not enough. A human must complete the changed-surface checks below.

### Website Chat

- Ask a normal Instant question and confirm a complete answer.
- Ask a Deep question on a paid account and confirm streaming begins quickly and finishes.
- Ask `What is today's date?` and confirm the exact current date/time.

### Search / Current Info

- Ask `What is the news today?` and confirm live sources appear, or the honest retryable search error appears.
- Tap Retry live search and confirm it re-runs search instead of printing another stale fallback.
- Ask a sports schedule question and confirm Ora searches for teams, times, competition, and sources.

### Talk To Ora

- Run at least 10 consecutive web voice turns without stuck thinking, silent text-only replies, or disconnect.
- Run at least 10 consecutive TestFlight voice turns on iPhone after any mobile voice change.
- Interrupt Ora mid-reply and confirm barge-in works without killing the session.
- Confirm the session ends by tier time budget, not by number of exchanges.

### Images

- Generate an inline image from a plain request.
- Edit/refine the previous image and confirm it remains an image flow.
- Ask for an image lookup and confirm it routes to search, not generation.

### Files / Advanced File Agent

- Upload PDF, DOCX, PPTX, XLSX, CSV, TXT, and ZIP samples and ask Ora to analyze each.
- Generate PDF, DOCX, PPTX, XLSX, and CSV files and confirm real file cards appear.
- Confirm PDF has separate View and Download controls.
- Ask for charts/histograms/dashboard from tabular data and confirm real visuals appear in exported files.
- Ask for a revision to a generated file and confirm a new complete replacement file is returned.

### Account / Billing / Compliance

- Confirm website and mobile show the same plan/tier/usage for the same user.
- Confirm paid users are not blocked by anonymous session limits.
- On iOS, confirm no external checkout/pricing links are visible.
- Confirm Sign in with Apple is visible on iOS sign-in/sign-up.
- Confirm Delete account flow is present and works on TestFlight before App Store resubmission.

### Conversation History

- Create, rename, pin, archive, restore, and search conversations on website.
- Open mobile and confirm history, last-active conversation, badges, pinned items, and archived items match website behavior.

### Production

- Record the exact commit SHA being published/submitted.
- After website publish, confirm `/api/healthz` returns 200 and the website loads.
- Watch logs for 401, 429, 500, and 502 spikes.
- If mobile code changed, cut a fresh TestFlight build and run mobile manual checks before App Store submission.
- Record rollback SHA.

## Release Decision Rules

Use these rules every time:

- Any failed critical automated check means **do not publish** and **do not submit TestFlight**.
- Any failed manual check on a changed surface means **do not publish** or **do not submit TestFlight**.
- Dirty working tree is acceptable during development, but release reports must use `--require-clean`.
- Live provider outages can be marked as external only if Ora shows the correct honest retry/error path.
- If mobile code changed, backend publish is not enough; a new TestFlight build is required.
- If only backend file/search/routing logic changed, existing mobile builds pick it up through the shared API after website/API publish.

## Standard Report Template

Replit and Codex should paste a report in this shape after every release gate:

```text
Ora Stability Gate Report

Commit tested:
Profile:
Website publish needed:
TestFlight needed:

Automated checks:
- API typecheck:
- Website typecheck:
- Mobile typecheck:
- API Ora tests:
- Website Ora tests:
- Mobile Ora tests:
- Build/lint:

Manual website checks:
- Chat:
- Search/current:
- Talk to Ora:
- Images:
- Files:
- History:
- Billing/account:

Manual mobile checks:
- Auth / Sign in with Apple:
- Plan sync:
- Talk to Ora:
- Search/current:
- Images:
- Files:
- History:
- Settings/delete account:

Findings:
- Critical:
- Medium:
- Minor:

Decision:
SAFE TO PUBLISH / NOT SAFE TO PUBLISH
SAFE TO SUBMIT TESTFLIGHT / NOT SAFE TO SUBMIT TESTFLIGHT
```

## Golden Prompt Matrix

Use these prompts during manual smoke testing and when adding new automated tests.

### Core Chat

- `What does Ora mean?`
- `Who made you?`
- `What is today's date and time?`
- `Explain the difference between Postgres and MongoDB in a short table.`

### Search / Current Info

- `What is the news today?`
- `Latest AI news today with sources.`
- `Who is playing in the World Cup today?`
- `Current stock market news today.`

### Images

- `Generate a clean logo for a bakery called Sunrise Crumbs.`
- `Create a photorealistic product shot of a white sneaker on a gray background.`
- `Edit the image and make the background blue.`
- `Find official logo images for Apple.` expected: search, not image generation.

### Files

- `Create an Excel dashboard with charts and a histogram from this data: Region,Revenue,Orders...`
- `Create a PDF analyst report with charts, risks, recommendations, and repeatable calculations.`
- `Create a PowerPoint executive report with charts from this KPI data.`
- `Create a Word SOP document for customer onboarding.`
- `Revise the file and add a risk register section.`

### Uploads

- Upload a PDF and ask: `Summarize the risks and action items.`
- Upload a PPTX and ask: `Delete the slide about pricing and return a revised deck.`
- Upload XLSX/CSV and ask: `Create charts and identify outliers.`
- Upload ZIP and ask: `Analyze this project and tell me how to run it and what might fail.`

### Talk To Ora

- `How are you?`
- `Let me explain the whole issue before you answer...` then pause mid-sentence and continue.
- Interrupt Ora mid-answer and ask a follow-up.
- Continue for 10+ turns.

## How Replit And Codex Must Use This

For every Ora task:

1. Pull latest `main`.
2. Make the fix.
3. Add or update regression tests for the fixed bug.
4. If the work adds or changes an Ora feature, update the feature registry in `scripts/src/ora-stability-gate.ts` with both website and mobile validation notes.
5. Run `pnpm run ora:stability-gate`.
6. If preparing publish/TestFlight, run `pnpm run ora:stability-gate:release`.
7. Complete the manual checklist for changed surfaces.
8. Paste the report with the exact commit SHA.
9. Only publish or submit TestFlight if the automated gate and required manual checks pass.
