# Project workspace chunk recovery — delivery report

Date: 2026-08-16  
Branch: `codex/project-workspace-chunk-recovery`  
Base: `d80d9267ce811e7a4f0388fdd263c03d0c14d1ee`

## Scope

Repair the authenticated Builder workspace's stale-deployment recovery path after Project 51 failed to load in a freshly restarted Chrome session. This slice changes only the client-side lazy-chunk recovery implementation and its focused tests. It does not promote Project 51, change a production switch, alter Cloudflare or Fly, or change any manifest.

## Diagnosis

The production browser reproduced `BuilderChunkRecoveryError` for the Project 51 route. Sanitized network evidence established:

- the named project-route JavaScript chunk returned HTTP 200 with the complete 841,897-character module body;
- the named route stylesheet returned HTTP 200 with the complete 1,065-character body;
- the document was cross-origin isolated and controlled by `builder-coi-sw.js`;
- the recovery error for the stylesheet attempted a dynamic JavaScript import of the `.css` URL.

The defect was in `retryBuilderChunkImport`: any extracted asset URL, including a CSS preload URL, was sent to `import()`. A transient Vite stylesheet-preload race therefore became a deterministic module-type failure. In addition, the route-scoped one-shot reload marker was left in session storage after later successful imports, so a prior deployment failure could suppress future recovery for the rest of the restored browser session.

After the forensic import primed the already-valid asset graph, an ordinary reload loaded Project 51 completely. That confirms the source chunks and deployment storage were valid and confines the repair to recovery orchestration.

## Change

- JavaScript chunk failures still retry through a same-origin cache-busted dynamic import.
- CSS preload failures now load a same-origin cache-busted stylesheet, then rerun the original lazy importer. CSS is never treated as JavaScript.
- A named 250 ms delay gives a newly published static deployment a bounded propagation interval before the retry.
- Every successful initial or recovered lazy import clears the route's stale one-shot reload guard.
- Existing one-reload fail-closed behavior remains unchanged when the bounded retry still fails.

## Acceptance

- Focused recovery and boundary suites: 13/13 green across 2 files.
- New regression: CSS preload recovery uses the stylesheet path, never `import()`.
- New regression: successful route import clears the stale reload guard.
- Existing regressions remain green for JavaScript cache-busting, one guarded reload, cross-origin rejection, diagnostic redaction, route scoping, and the user-facing fallback.
- Prettier check: green for both changed files.
- TypeScript: `typecheck:libs` green, then `@workspace/mustaflow` typecheck green.
- ESLint: green for both changed files.
- Production Vite compilation, static prerender, and bundle-size gate: green; the subsequent pre-existing dynamic-prerender step stopped only because this credential-free worktree has no `DATABASE_URL`.
- Manifest/lockfile changes: none.

## Delivery state

No live deployment or production mutation was performed from this branch. Replit remains the ship authority. Project 51 production promotion and the flip-day acceptance matrix remain pending until this branch is merged and published.
