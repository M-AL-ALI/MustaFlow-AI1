# Wave D.3.2 - production asset comparison and recovery lab

Date: 2026-07-29
Branch base: `de05e550387f8e9326ed7b175c9b48643192591d`

## Root-cause confirmation

The failed production document reported:

- Entry bundle: `/assets/index-97PEYwdT.js`
- Failed lazy chunk: `/assets/_id_-C9c46yz6.js`
- Failure: `TypeError: Failed to fetch dynamically imported module`
- Observed: `2026-07-29T17:00:51.220Z`

The current production document at both `/` and `/projects/44` serves:

- Entry bundle: `/assets/index-Dx5Qb07z.js`
- Current entry status: `200`
- Current entry size: `64,954` bytes
- Current project chunk: `/assets/_id_-C9c46yz6.js`
- Current project chunk status: `200`
- Current project chunk size: `826,417` bytes

The old entry remains fetchable at `200` (`328,030` bytes), but it is no longer
the entry referenced by current production HTML. The failed tab therefore was a
stale document across a deployment boundary. It was **not** requesting a removed
or mismatched project-chunk hash: the current entry still requests the same
`_id_-C9c46yz6.js` asset, and that asset is healthy now. The observed failure is
best classified as a transient fetch failure from a stale page during the
deployment boundary.

## Deterministic browser lab

The lab used the real `retryBuilderChunkImport` and
`BuilderChunkErrorBoundary` implementation. A temporary service worker returned
HTTP 404 for the lazy module's normal URL and allowed or rejected the
cache-busted URL according to the scenario. The temporary harness and worker
were removed after evidence capture; only this evidence is committed.

### Transient failure

1. Normal lazy-module request returned 404.
2. The shared loader retried with `mustaflow_chunk_retry=<token>`.
3. The cache-busted request succeeded.
4. React rendered the recovered module without a document reload.
5. The lab's visible counter remained `app loads 1`.

Evidence:

- `transient-retry-light.png`
- `transient-retry-dark.png`
- `transient-retry-light-logs.json`

### Persistent failure

1. Normal lazy-module request returned 404.
2. Cache-busted retry also returned 404.
3. The UI rendered `NabuFlow was updated - refreshing...`.
4. A session-scoped guard allowed exactly one automatic document reload.
5. The second document repeated the forced failures and rendered the calm
   fallback with its real **Reload** button.
6. The visible counter stopped at `app loads 2`, demonstrating that no automatic
   reload loop occurred.

Evidence:

- `guarded-refresh-light.png`
- `guarded-refresh-dark.png`
- `final-fallback-light.png`
- `final-fallback-dark.png`
- `persistent-light-logs.json`
- `persistent-dark-logs.json`

## Focused automated acceptance

The focused Vitest suite covers:

- transient cache-busted retry succeeds with no reload;
- persistent failure requests exactly one reload;
- a second persistent failure produces the final recovery error;
- the production error text extracts the expected chunk URL;
- non-builder/Ora routes do not engage this recovery;
- cross-origin chunk retry URLs are rejected;
- the refresh message is non-blank and announced as a status;
- the final fallback renders and its Reload action clears the guard first.

Result: `13 passed` across the recovery, error-boundary, and builder lazy-load
regression suites.

## Verification

- Frontend TypeScript: passed.
- ESLint on changed frontend files: passed.
- Production Vite build: passed (`4,051` modules transformed).
- Focused Vitest: `13 passed`.
- Full frontend Vitest: all in-scope tests passed. The pre-existing
  `ora-sidebar-nav.test.ts` Windows file-URL import failure reproduces unchanged
  at the branch base and was not modified because Ora is outside this hotfix.
- `git diff --check`: passed.
