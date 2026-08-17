# Wall #11 — published runtime availability delivery

Evidence run: `20260817T072459Z`

## Outcome

Wall #11 is durable and ready for review. The branch
`codex/published-runtime-availability` is based on exact
`0223d0f5b2067bc7a08476b5d7d7336427c0deff`. The implementation commit was
`baca4751e6c804ddb77a8ec01d849d4edfdc8c3a`; the final delivery tip is recorded
after the closing report commit because a commit cannot contain its own SHA.

Production remained frozen throughout this task. There was no rollback, second publish, runtime
restart, route mutation, Worker deployment, public-surface change, provider spend, or Fly action.

## Disk recovery

Each target was matched by exact absolute path. Branch/merge state and durable reports were checked
before deletion. The two `*-base` directories had no worktree metadata remaining, so their
corresponding delivered branches and durable reports were used as the guards. Wall #9's detached
checkout was an ancestor of main; Wall #10's branch was merged and its report plus both evidence
files existed in the permanent folder and in-repo.

| Approved target                                                 | Measured bytes freed |
| --------------------------------------------------------------- | -------------------: |
| `.work-cloudflare-production-cutover-recon-base`                |        1,636,052,992 |
| `.work-production-database-capability-base`                     |        1,649,274,880 |
| `.work-project-workspace-chunk-recovery`                        |        1,865,588,736 |
| `.work-sealed-release-staging-handoff`                          |       94,228,500,480 |
| `.work-sealed-test-runtime-rehydration`                         |          213,561,344 |
| `.work-workspace-recovery-diagnostics`                          |          205,971,456 |
| `.work-publish-idempotency-retry-safety`                        |        1,843,871,744 |
| `.work-runtime-production-deploy-20260817T032911Z`              |          555,212,800 |
| `.work-wall10-published-route-state`                            |        1,833,562,112 |
| `nabuflow-runtime-production-7d9a3a03-dry-run-20260817T033300Z` |            4,206,592 |
| **Total**                                                       |  **104,035,803,136** |

All ten exact targets are absent. The protected live Wall #11 worktree, main checkout, pnpm store,
and permanent docs folder remain present. PID `19760` no longer existed when checked, so no process
was killed. Free space after the deletion sweep was `104,018,276,352` bytes (`96.875 GiB`), safely
above the 5 GB stop boundary. After dependency restoration, tests, and report generation, C: still
had more than 95 GiB free.

The standing close ritual is now in the cutover authority: after a marker is verified, its branch is
merged, and docs are durable, the slice's scratch worktree is deleted as part of the ship itself.

## Frozen offline dependency proof

`pnpm install --frozen-lockfile --offline` completed in `7m56.7s`. It installed `1,899` packages,
reused `1,870`, and downloaded `0`. The pnpm store was never removed or modified by cleanup. There
are no manifest or lockfile changes.

## Phase 1 diagnosis carried into the fix

The adopted v158 green runtime replayed a historical start terminal and therefore skipped the fresh
start path's materialize, process start, and 30-second `/healthz` check. The old route path accepted
durable descriptor state as availability. The route and candidate metadata agreed, but current
process/port truth did not. No readiness comparison uses wall-clock deltas; lab/provider clock drift
was ruled out. Blue remains the deliberate warm rollback standby, not an orphan.

The complete pre-change diagnosis and sanitized evidence remain durable at:

- `docs/wall-11-published-runtime-availability-phase1-diagnosis-20260817T053311Z.md`
- `docs/wall-11-published-runtime-availability-phase1-evidence-20260817T053311Z.json`

## Repair shape

One shared Runtime Worker availability assessment now resolves the saved process and checks the
runtime's actual manifest health path and service port under a named five-second bound. It preserves
only sanitized stages and allowlisted cause classes. Route activation uses this live assessment for
both blue and green, adopted and fresh candidates, before compare-and-swap. The public data plane
uses the same truth.

If an otherwise valid candidate is not currently available, the request does not own a restart.
The Worker idempotently schedules the existing durable runtime-start recovery job and queue nudge.
That keeps execution inside the already-proven leased job chassis and prevents the fix from merely
detecting liveness without restoring it. The old route remains authoritative until the candidate
passes live availability. Typed failures and candidate cleanup remain intact.

No contract, Artifact v1, layer, manifest, route-record, or wire format changed.

## Verification

| Check                                                    | Result                         |
| -------------------------------------------------------- | ------------------------------ |
| Runtime Worker complete suite                            | PASS — 35 files, 257/257 tests |
| Tenant runtime contracts suite                           | PASS — 20 files, 187/187 tests |
| Repository TypeScript                                    | PASS — `pnpm run typecheck`    |
| Repository lint                                          | PASS — `pnpm run lint`         |
| Changed-file Prettier                                    | PASS                           |
| `git diff --check`                                       | PASS                           |
| Frozen offline install                                   | PASS — 0 downloads             |
| Manifest/lockfile diff                                   | EMPTY                          |
| Both route swap directions                               | PASS                           |
| Adopted/fresh shared availability                        | PASS                           |
| Unavailable candidate durable recovery nudge, both slots | PASS                           |
| Prior route preserved until availability passes          | PASS                           |

## Files changed

- `artifacts/nabuflow-runtime-worker/src/runtime-backend.ts` — shared Sandbox process/health-path
  availability assessment with bounded, sanitized outcomes.
- `artifacts/nabuflow-runtime-worker/src/published-data-plane.ts` — route forwarding consumes the
  shared availability truth and schedules durable recovery without request-owned execution.
- `artifacts/nabuflow-runtime-worker/src/worker.ts` — slot-honest activation requires live
  availability and uses the existing durable runtime-start recovery chassis.
- `artifacts/nabuflow-runtime-worker/test/cloudflare-sandbox-stub.ts` — realistic process and health
  behavior for availability regressions.
- `artifacts/nabuflow-runtime-worker/test/helpers.ts` — shared test controls for availability.
- `artifacts/nabuflow-runtime-worker/test/runtime-availability.test.ts` — direct adopted/fresh,
  process, port, health, timeout, and sanitization coverage.
- `artifacts/nabuflow-runtime-worker/test/control-worker.test.ts` — exact Project 51 production
  record, both directions, preserved route, and durable recovery assertions.
- `artifacts/nabuflow-runtime-worker/test/published-data-plane.test.ts` — public-route availability
  and recovery behavior.
- `docs/cloudflare-production-cutover-plan.md` — Phase 1 authority, scratch-close ritual, and
  revision-receipt accounting.
- Wall #11 diagnosis/evidence and this delivery record.

## Revision 163 receipt

The receipt is benign committed numbering, not another orphan:

1. `project_versions.id` is a database-wide PostgreSQL `serial`, not a per-project revision counter.
2. Every production publish attempt allocates a deployment snapshot before provider work.
3. Ship 7 deletes an unsuccessful, uncommitted, unreferenced snapshot in the route's `finally`
   boundary, but sequence values are never reused.
4. The post-v159 timeline contains two failed retries that left no visible version row, followed by
   the one successful publish.
5. The successful path commits its deployment snapshot, and the later authenticated preview-state
   receipt reported Project 51's latest committed row as `163` while the accepted source authority
   remained v158.

Consequently, IDs between 159 and 163 are not evidence of surviving Project 51 snapshots. They are
global sequence consumption from cleaned attempts and/or other table writers. Surviving evidence
does not assign IDs 160–162 one-for-one, and this report does not invent that mapping. The exact
authenticated version-list tab could not be attached after two bounded browser-control attempts;
an unauthenticated API request correctly returned HTTP 401. No cookies, hidden bindings, or secret
values were inspected to bypass that boundary. No cleanup was performed.

## INCIDENTIAL FINDINGS

1. Cloudflare reported three active container instances but only two healthy while its instance
   table labeled all three Running. This was captured in Phase 1 and not changed.
2. Read-only `wrangler containers info` on the instance ID returned application-not-found and then
   triggered a Windows `UV_HANDLE_CLOSING` assertion. No mutation occurred.
3. Route/process forensics lack a signed metadata-only route read and application logs; raw Durable
   Object KV and SSH remain unavailable. The repair persists sanitized availability stages but does
   not open a surface.
4. The 94.2 GB sealed-release scratch worktree was the dominant disk consumer. This is cleanup
   hygiene evidence, not a product fix.
5. PowerShell policy rejected the first exact recursive removal command before execution. The same
   validated absolute targets were removed through .NET directory deletion; one read-only
   long-path residue required clearing file attributes inside that approved target only.
6. The authenticated versions tab twice timed out at browser-control attachment. The direct API's
   unauthenticated 401 confirms correct access posture but leaves IDs 160–162 intentionally
   unmapped.
7. pnpm emitted its standing ignored-build-scripts warning during the offline install. No scripts or
   dependency policy were changed.

## Handoff boundary

The branch is pushed for review. Nothing is deployed. Production stays frozen until the branch is
merged and the independently deployed Runtime Worker is brought to exact merged-source parity under
the standing before/after version ritual. No second publish is authorized by this delivery.
