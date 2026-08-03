# Task 1 — Project open performance

## Method

- Production baseline: cold navigation to project 45 in the signed-in production Chrome profile with the browser cache disabled.
- Controlled before/after: the production baseline build and the Task 1 build were served from separate local ports with the same captured, read-only project 45 responses.
- Both controlled runs used a fresh page, disabled cache, 40 ms request latency, 10 Mbps download, and 5 Mbps upload.
- Time to interactive (TTI) is the later of: the chat composer becoming usable and the preview frame becoming visible.

The local harness only substitutes captured project 45 GET responses and authentication state. It does not modify source, production data, or the measured bundles.

## Results

| Measurement               |          Before |           After |                 Change |
| ------------------------- | --------------: | --------------: | ---------------------: |
| Chat usable               |        4,423 ms |        2,246 ms |                 -49.2% |
| Preview visible           |        4,479 ms |        2,246 ms |                 -49.9% |
| Chat + preview TTI        |        4,479 ms |        2,246 ms | **-2,233 ms (-49.9%)** |
| Critical-window resources |             158 |             111 |                 -29.7% |
| Critical transfer         | 4,797,492 bytes | 3,324,186 bytes |                 -30.7% |
| Project route bundle      |     2,174.29 kB |       807.41 kB |                 -62.9% |
| Project route gzip        |       554.73 kB |       221.21 kB |                 -60.1% |

The signed-in production cold baseline was independently measured at 1,995 ms TTI. Its raw waterfall is retained as the production reference.

## Startup blockers found

1. The unsplit project route shipped page map, images, versions/checkpoints, history, analytics, security, publishing, database, and other advanced surfaces before chat could render.
2. Inactive surfaces eagerly issued versions, images, check-runs, CVE, suggestions, and task-event history requests.
3. Idle message and task polling ran more aggressively than the workspace needed.
4. Image history fetched every completed task event stream even while the Images surface was closed.

## Changes

- Heavy workspace surfaces now load as separate chunks and mount only when their tab, drawer, or dialog is opened.
- Versions/checkpoints, images, check-runs, CVE data, and saved suggestions are deferred until their owning surface is opened or active work requires them.
- Image event history is capped to six recent tasks at first, with an explicit **Load more image history** action.
- Idle message polling is 60 seconds and idle task polling is 30 seconds; active-build polling behavior is unchanged.
- The preview and composer remain eager so the two primary workspace surfaces render first.
- No endpoint, event name, payload, streaming contract, charge point, or completion wording changed.

## Network proof

Requests removed from the critical startup window include:

- `/api/projects/45/versions`
- `/api/projects/45/images`
- `/api/projects/45/check-runs`
- `/api/projects/45/security/cve`
- `/api/projects/45/security/cve/scan/status`
- completed-task event-history requests

Raw captures:

- `task-1-before-waterfall.json` — signed-in production cold open
- `task-1-comparison-before-waterfall.json` — fixed-profile production baseline bundle
- `task-1-comparison-after-waterfall.json` — fixed-profile Task 1 bundle
- `task-1-project-45-before.png`
- `task-1-project-45-after.png`

## Verification

- Mustaflow TypeScript: pass
- Targeted performance tests: 3 passed
- ESLint on changed TypeScript/TSX files: pass
- Production Vite build: pass
- Full Mustaflow suite: 851 tests passed; the untouched
  `ora-sidebar-nav.test.ts` suite fails during import because Vitest receives
  `file:///logo.png`. The identical failure reproduces on the clean D.1 baseline,
  so Task 1 did not introduce it. Ora was not changed.
