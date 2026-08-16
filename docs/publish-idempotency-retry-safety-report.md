# Wall #7 — publish idempotency retry safety

## Outcome

Branch `codex/publish-idempotency-retry-safety` fixes the production publish false-conflict class and the failed-snapshot residue it exposed. The branch is based on `c7fbe70f5003f0c29e5728f686f0fb9a00e7a9a4`.

No production publish was retried, nothing was deployed, no public surface was opened, no provider resource was created, and no Fly operation occurred. Approved sealed candidate `v158` remains waiting at the Replit ship boundary.

## Mechanism

### Entry path and key ownership

The rejected attempt used the real production UI. `handlePublish()` in `publishing-tab.tsx` issues `POST /api/projects/51/publish` without an idempotency header or a persisted client key. The browser therefore did not mint or retain the rejected key.

The API server's `CloudflareRuntimeProvider` minted the control-plane key. The first control mutation for this database-capable sealed publish was production database allocation:

- business key: `production-database:<allocationIdentity>:ensure`
- `allocationIdentity`: content-derived from the production namespace and project identity, so it is intentionally stable for Project 51
- signed request body: `action`, `projectId`, `allocationIdentity`, and `expectedDeploymentVersion`

The Runtime Worker independently fingerprints the full request as SHA-256 of `method + path-and-query + signed body hash`. Its durable coordinator correctly rejects a stored key paired with a different fingerprint as typed `idempotency_conflict`.

The earlier failed v157-era production attempt persisted the project-stable business key under the then-current Runtime Worker deployment precondition. The current attempt reused that business key after the Runtime Worker version changed, so `expectedDeploymentVersion` changed and the Worker saw the same key attached to a different signed request. The exact UI message—`The idempotency key was used for a different request`—comes from that Worker conflict branch.

This was a server-owned durable-key collision, not a persisted client key.

### Honest blast radius

It does **not** bite every ordinary second publish. An exact retry with the same method, path, body, and control deployment remains the same request and can replay safely.

It does affect DB-capable publishes across a control-Worker deployment-version change. The same latent class also existed on artifact begin/transfer/commit, production promotion, route activation, and rollback because those signed requests carry request preconditions such as `expectedDeploymentVersion` or `expectedPreviousManifestRevision` while their business keys remain stable. That makes this a core-loop blocker after control-plane rotation, not merely a Project 51 annoyance.

## Fix

The provider now derives the transmitted key once, centrally, as:

`<stable business key>:request-<SHA-256(method + path + SHA-256(body))>`

This preserves all desired semantics:

- identical request identity produces byte-identical keys and harmless replay;
- a changed request precondition produces a fresh wire key instead of a false conflict;
- stable business identity remains visible as the prefix for diagnosis;
- the Worker remains the authoritative fingerprint and durable-CAS enforcement point;
- no client, route, artifact, or wire-format contract changed.

Both JSON and binary control mutations use the shared derivation. Hash/serialization failures retain the existing typed pre-dispatch taxonomy and never masquerade as transport weather.

## Failed-attempt residue

The pre-fix attempt did **not** leave zero state. A read-only Version Snapshots refresh showed:

- `v158 — Staged`, approved and still the intended sealed candidate;
- `v159 — Republished`, unapproved, created at the failed attempt.

`v159` is an unreferenced database snapshot row created before the first control mutation, and its `filesSnapshot` contains copied source bytes. The zero-orphan requirement therefore failed at the database layer. The conflict occurred during production database `ensure`, before artifact promotion, route activation, R2 snapshot upload, KV routing, or project publication persistence. No R2/CAS production object, half-registered route, adopted runtime, or activated artifact was produced by this attempt. A public-route probe returned no bytes within its bound, which is not used as proof of route health or mutation; the ordering and conflict-before-execution evidence are the authoritative no-activation proof.

The route now owns cleanup of a newly inserted production snapshot on every unsuccessful pre-commit exit. Immediately before deletion it re-reads the project references. It deletes only when the snapshot is uncommitted, unreferenced by published/staging/tested state, and not retained as a reconciliation anchor. Cleanup errors are metadata-only logs and never mask the primary typed publish result. If activation rollback itself fails, the snapshot is preserved deliberately as recovery evidence.

The already-existing `v159` row and its copied snapshot bytes were not deleted live from this branch-only task. They are the sole identified cleanup item to remove authoritatively after this branch ships and before `v158` is retried.

## Regression coverage

- Same production database prerequisite, same Runtime Worker version: identical body and identical transmitted key.
- Same project allocation, changed Runtime Worker version: changed body and a fresh transmitted key; the fake Worker would return `idempotency_conflict` under the old implementation.
- Failed unreferenced `v159`-shaped snapshot: removed through the cleanup boundary.
- Committed, referenced, or rollback-reconciliation snapshot: never queried/deleted incorrectly.
- Existing sealed-release handoff coverage remains green.

Verification:

- frozen/offline install: passed; 2,259 packages reused, zero downloaded, 13m25.7s;
- focused and adjacent suites: 46/48, with all 46 relevant tests green; the two unrelated `production-database-lifecycle` hard-delete tests reproduce as existing fixture-shape failures because their fake provider omits `zeroGenerationStartAcceptedSealedRelease` and is therefore not capability-detected;
- strict focused-plus-handoff suite after final patch: 43/43 passed;
- API server TypeScript check: passed after the required workspace declaration build;
- changed-file ESLint: passed;
- `git diff --check`: passed;
- complete API suite: 2,334 passed, 5 skipped, 41 failed across 39 files. Failures are environment/baseline categories including absent `DATABASE_URL`, `ORA_SESSION_SECRET`, `ENCRYPTION_KEY`, AI integration configuration, and unrelated pre-existing assertions; no focused change test failed.

## Files changed

- `artifacts/api-server/src/lib/cloudflare-runtime-provider.ts` — shared request-identity-bound wire-key derivation for all governed JSON and binary mutations.
- `artifacts/api-server/src/lib/cloudflare-runtime-provider.test.ts` — replay, control-version rotation, and key-shape regressions.
- `artifacts/api-server/src/lib/production-publish-retry-safety.ts` — fail-closed snapshot cleanup predicate and orchestration boundary.
- `artifacts/api-server/src/lib/production-publish-retry-safety.test.ts` — deletion and preservation regressions.
- `artifacts/api-server/src/routes/publish.ts` — publish commit/reconciliation ownership and pre-commit failure cleanup.
- this report and its uniquely named evidence record.

## Manifest and live-state declaration

No manifest or lockfile changed. No production configuration, credential, deployment, route, Worker, bucket, database, or runtime changed. No cost was incurred. The task stops here for Replit to ship the branch before any cleanup or publish retry.
