# Project workspace recovery diagnostics — flashlight delivery

Date: 2026-08-16  
Branch: `codex/workspace-recovery-diagnostics`  
Verified base: `4c86789a6184a73b4e3e8c39c7f5acbcaeb025b9`

## Scope

Permanently preserve a sanitized terminal workspace-load specimen before any reload or cleanup can erase it, then use the surviving production evidence to classify wall #6. This delivery intentionally stops at the Replit ship boundary. It does not promote Project 51, mutate production, change a provider, open a surface, spend money, or touch Fly.

## Production reconstruction

The authenticated Project 51 tab retained three terminal failures at 19:29:08Z, 19:29:30Z, and 19:29:40Z. Each was the same mechanism:

- `BuilderChunkRecoveryError` after the recovery retry;
- retry error class `TypeError`;
- browser message class `Failed to fetch dynamically imported module`;
- failing immutable route module `/assets/_id_-CqHj69aa.js`.

A controlled clean reload later loaded the workspace completely. The exact same route module returned HTTP 200 as `text/javascript`, did not come from disk cache, did not come from a service worker, and executed successfully. Both the immutable path and a cache-busted HEAD request currently return HTTP 200 with the same 844,580-byte representation.

This establishes the product mechanism: the terminal screen was caused by repeated transport failure while loading the shared project-workspace module, not by Project 51 data and not by module evaluation. It does **not** establish the lower-level historical network cause (for example reset versus an HTTP response), because the old boundary discarded that request trail and the transport has recovered. Claiming a narrower cause would be a guess.

## Scope determination

The failing module is the common `/projects/:id` workspace route. Any project workspace could hit this class; it is not Project 51-specific. The project list and unrelated routes are separate lazy modules.

Ship 4's preview-tab controls are exonerated by the evidence: the browser now executes the unchanged route-module bytes successfully. A source or initialization defect would reproduce when those same bytes execute; the observed error was a fetch failure before evaluation.

## Permanent flashlight

Terminal Builder failures now persist a bounded, versioned record in tab-scoped session storage **before** reload or the final fallback:

- UTC capture time;
- normalized route class (`project-workspace`, never the project identifier);
- failure stage (`retry` or `global`);
- sanitized error class;
- canonical message class;
- same-origin hashed asset path without query or fragment;
- a bounded three-second same-origin HEAD probe result: HTTP status plus media category, transport-error class, or unavailable.

The probe is diagnostic only and never changes the recovery decision. It sends no request body, strips every query and fragment before dispatch, and reads no response body. The persisted record never contains a stack, arbitrary error text, project ID, URL query, user text, file path, credential value, response body, hash of private content, or binding name.

The collapsed recovery details render error class, canonical message, asset path, and transport classification. Tampered or structurally invalid records are ignored. A manual reload preserves the corpse; the first successful lazy import authoritatively clears both the failure record and stale recovery guard.

## Why this is a flashlight-first ship

Wall #6 cleared before a request-level trace was attached. The new evidence can distinguish the missing historical cases on first recurrence:

- `HTTP 200 javascript`: delivery exists; investigate browser policy or module evaluation;
- `HTTP 404/5xx` or wrong media category: static-deployment delivery defect;
- `transport-error <class>`: browser-to-origin transport failure;
- `unavailable`: no trustworthy same-origin hashed asset was extractable.

Retry timing and reload policy are unchanged in this branch. Retuning them without the preserved transport specimen would violate diagnosis-before-fix. After this permanent flashlight ships, the next reproducible terminal supplies the evidence for a narrowly scoped second fix. Two clean ships are preferable to a guessed behavioral change.

## Verification

- Focused recovery and boundary suites: 19/19 green.
- Production read-only reproduction: prior terminal exception recovered from browser logs; clean reload now renders the full Project 51 workspace.
- Production request trace: failing module identity later returned HTTP 200 JavaScript, non-cache, non-service-worker, and executed.
- Local production Vite compilation: 4,075 modules transformed; the workspace route bundle linked successfully.
- Local browser startup stopped at Clerk's localhost-derived frontend endpoint, an environment artifact unrelated to the workspace module.
- Full MustaFlow suite: 1,057/1,058 green. The sole red is the pre-existing stale expected SHA in `preview-reconciliation.test.ts`: both the base blob and worktree fixture hash to `abe274da…`, while the test still expects `ec751002…`. Neither the test nor fixture differs from base.
- TypeScript, focused ESLint, Prettier, and final production compilation: recorded in the accompanying evidence after the final gate.
- Manifests and lockfiles: unchanged.

## Incidental findings

- The workspace currently renders and shows the sealed-test controls; no publish or promotion control was invoked.
- One unrelated preview iframe document reports `net::ERR_BLOCKED_BY_RESPONSE` because the embedded production preview refuses framing. It did not block the workspace route and is not classified as wall #6.
- The full-suite SHA-pin failure remains the already-queued stale preview-reconciliation fixture errand; this branch does not fold that unrelated repair into the flashlight.

## Delivery boundary

Branch-only. Replit is the ship authority. No merge, publish, promotion, production mutation, new public surface, provider write, cost, or Fly action occurred.
