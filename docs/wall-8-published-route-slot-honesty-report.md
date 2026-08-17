# Wall #8 — published route slot honesty and liveness repair

## Delivery

- Branch: `codex/published-route-slot-honesty`
- Verified base: `bc3070ca48bf683ac037c40d85cd5affbbaa4416`
- Delivery tip: recorded in the final branch handoff (a commit cannot truthfully contain its own
  hash)
- Evidence: `docs/wall-8-published-route-slot-honesty-evidence-20260817T025045Z.json`
- Live mutation from this branch: none
- Fly action: none
- New public surface or spend: none

## Outcome

Wall #8 is a product-defect pair, not a DNS fault and not a failed initial publish. The v149 blue
release completed route activation and served two persisted HTTP 200 health checks, but later
Sandbox reads disabled keepalive on the live cell. After Cloudflare stopped/restarted that VM, the
durable runtime descriptor still said `running` while the tenant process was gone. The published
data plane trusted the stale descriptor and waited without a response-header deadline, producing
the observed zero-byte hangs.

Independently, production route activation accepted a blue-or-green contract and then hard-coded
its identity and runtime checks to blue. That made every blue-to-green publication fail before the
route compare-and-swap. The provider had already promoted and started green, so the failed v158
attempt also left a live, unreferenced candidate.

The branch repairs both mechanisms: activation validates the route's actual slot in either
direction; live reads preserve keepalive; published requests verify the tenant process, schedule
idempotent recovery on the existing durable runtime-start chassis, and use a named 10-second
response-header bound; and failed activation reconciles route authority before destroying the
non-authoritative candidate. Wire formats and public contracts remain unchanged.

## Phase 1 — production findings recorded before code

The authoritative record was appended first to
`docs/cloudflare-production-cutover-plan.md` in the permanent authority folder and then carried
into this branch.

### Route and publication

- `platform-canary.apps.mustaflow.com` resolves, but `/` and `/healthz` each timed out after
  15.011 seconds with zero bytes.
- Project 51 still publishes v149. Its release is active on blue, with runtime identity
  `nrf-ab8e18ef4ebebedd-p51-production-blue`.
- `promotedAt` and `activatedAt` are both `2026-08-15T23:11:58.905Z`.
- Persisted post-publish health returned 200 at `23:12:37Z` (629 ms) and `23:17:37Z` (628 ms).
  Therefore v149's original publication did complete routing and did serve.
- The failed v158 promotion has no `productionRelease`, and activation rejects green before route
  CAS. It did not mutate the application database or route authority.

### Runtime state and residue

- Cloudflare lists production-blue as `Running`, with 244 MiB memory, 625.5 MB disk, and four
  `VMStopped` events under deployment `d0345428` beginning `2026-08-16T03:18:29Z`.
- The started-but-unreferenced candidate is
  `nrf-ab8e18ef4ebebedd-p51-production-green`, listed `Running` with 347.6 MiB memory and no
  traffic. v158, Project 51, and the active route do not reference it.
- The current route record is held in the `control-v1` Durable Object's internal `_cf_KV`, not a
  Workers KV namespace. Direct Data Studio reads are rejected with `SQLITE_AUTH`. Typed data-plane
  guards and the zero-byte forwarding hang establish that the stored record remains internally
  valid and targets old blue; otherwise an immediate typed response would have occurred.

### Exact mechanism

1. `activatePublishedRoute` checked `parsedIdentity.slot !== "blue"` and
   `runtime.descriptor.slot !== "blue"`, contradicting its own `activeSlot: blue|green` contract.
2. `CloudflareSandboxBackend.start()` enabled keepalive, but later `status()` and `logs()` calls
   reopened the same Sandbox with `keepAlive:false`. The installed Sandbox SDK persists that
   configuration; the runtime then reaches its activity timeout and stops.
3. A VM restart loses the tenant process while the coordinator's durable descriptor can still say
   `running`.
4. The published data plane did not check the process and gave `containerFetch` no response-header
   deadline, so the route became dark instead of producing a typed recoverable state.
5. The API provider started the candidate before activation and had no activation-failure reclaim
   path, leaving green live after the deterministic slot rejection.

## Phase 2 — branch repair

### Slot-honest activation

`artifacts/nabuflow-runtime-worker/src/worker.ts` now binds both identity and runtime-descriptor
validation to `route.activeSlot`. Tests activate blue→green and then green→blue, proving the same
contract in both directions.

### Published liveness and durable recovery

`artifacts/nabuflow-runtime-worker/src/runtime-backend.ts` preserves Sandbox keepalive for reads of
`starting` and `running` runtimes while retaining the non-keepalive behavior for stopped/error
cleanup states.

`artifacts/nabuflow-runtime-worker/src/published-data-plane.ts` now:

- verifies the actual tenant process before forwarding;
- coalesces recovery under a deterministic runtime/artifact identity;
- nudges the existing durable `runtime-start` job queue and leaves redelivery to its watchdog if
  the immediate queue send encounters weather;
- returns typed retryable `published_runtime_recovering` while restart is owned durably;
- bounds upstream response-header acquisition at named constant
  `PUBLISHED_UPSTREAM_HEADER_TIMEOUT_MS = 10_000`; and
- distinguishes stopped-process recovery from typed `published_upstream_timeout` and
  `published_runtime_unavailable` outcomes.

Peak execution ownership remains with the shared durable job chassis: a public request can nudge
recovery but is never required to survive for it to finish.

### No orphaned runtimes after activation failure

The publish route passes the prior release into
`CloudflareRuntimeProvider.promoteProductionArtifact`. On readiness or activation failure, the
provider first reconciles whether candidate activation committed using the existing CAS rollback.
If it did not commit, conflict/not-found is accepted as proof that the old route still owns
authority. If it did commit, the previous release is restored. Only then does the provider delete
the target runtime and discard its local deployed-artifact record. An ambiguous rollback fails
closed as typed `production_candidate_cleanup_failed`; it never guesses and destroys a possibly
authoritative runtime.

The existing activation terminal is preserved when cleanup succeeds. A regression reproduces the
green identity rejection, proves rollback reconciliation, verifies one DELETE of green, and
asserts the original `invalid_route_identity` terminal survives.

## Files changed

### Runtime Worker

- `artifacts/nabuflow-runtime-worker/src/worker.ts` — slot-honest route activation.
- `artifacts/nabuflow-runtime-worker/src/runtime-backend.ts` — live-read keepalive preservation.
- `artifacts/nabuflow-runtime-worker/src/published-data-plane.ts` — process verification, durable
  recovery, and bounded typed forwarding.
- `artifacts/nabuflow-runtime-worker/test/control-worker.test.ts` — blue→green and green→blue route
  regressions.
- `artifacts/nabuflow-runtime-worker/test/sandbox-policy.test.ts` — read/keepalive posture.
- `artifacts/nabuflow-runtime-worker/test/published-data-plane.test.ts` — coalesced durable recovery
  and bounded upstream failure regressions.

### API provider

- `artifacts/api-server/src/lib/tenant-runtime-provider.ts` — internal prior-release handoff.
- `artifacts/api-server/src/routes/publish.ts` — passes authoritative prior release to promotion.
- `artifacts/api-server/src/lib/cloudflare-runtime-provider.ts` — CAS-aware failed-candidate
  rollback and destruction.
- `artifacts/api-server/src/lib/cloudflare-runtime-provider.test.ts` — full failed-activation
  reclaim sequence and typed-terminal preservation.

### Authority and evidence

- `docs/cloudflare-production-cutover-plan.md` — pre-code Wall #8 forensic record.
- `docs/wall-8-published-route-slot-honesty-report.md` — this delivery report.
- `docs/wall-8-published-route-slot-honesty-evidence-20260817T025045Z.json` — unique sanitized
  evidence record.

## Verification

- Focused Runtime Worker: 3 files, 33 tests passed.
- API Cloudflare provider: 1 file, 36 tests passed.
- Complete Runtime Worker suite: 34 files, 254 tests passed.
- Complete tenant-runtime-contracts suite: 20 files, 187 tests passed.
- Workspace typecheck: passed.
- Workspace lint: passed.
- Every slice-owned source, test, report, and evidence file: Prettier passed.
- Frozen offline install: passed; lockfile already current; zero downloads.
- `git diff --check`: passed.

No manifest, lockfile, dependency, Artifact v1, layer, or other wire-format change was made.

## INCIDENTIAL FINDINGS

1. **Route-store forensic surface is missing.** The route is in the Control Durable Object's
   opaque storage, and Data Studio rejects direct reads with `SQLITE_AUTH`. There is no signed,
   metadata-only route read endpoint. Evidence: object
   `e57de76559a30d3ba40c8aa34f307e1d9b7ef9a6a5d258ec499336b20be9b691`. Reported only.
2. **Container observability is disabled.** Cloudflare's production container Logs surface reports
   Workers Observability disabled, preventing application-log correlation. Reported only; enabling
   it could affect cost.
3. **Three production Wrangler JSONC files fail the repository formatter at the base.** Build,
   Pantry, and runtime production configs are byte-unchanged from `bc3070ca`; their SHA-256 values
   are preserved in evidence. Per the incidental-finding rule, they were not reformatted here.
4. **The complete API test command is not a credential-free standalone gate.** An extra diagnostic
   run (not required by this commission) produced 39 failed / 140 passed / 3 skipped files, mostly
   because `DATABASE_URL`, encryption/session, and integration bindings are absent; it also exposed
   unrelated shared-suite assertion failures in billing, support-email, and memory-confidence
   tests. The scoped provider tests and all required gates are green. Reported only; no unrelated
   test or product behavior was changed.

## Ship boundary

This branch does not deploy or clean the live green candidate. After Replit verifies and ships it,
the standing approved v158 retry can activate green with slot-honest validation; future activation
failures will reclaim non-authoritative candidates. The existing blue dark route will also recover
through a durable runtime-start job instead of hanging indefinitely. Production promotion remains
paused until that ship.
