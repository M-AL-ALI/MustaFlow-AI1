# Wall #10 — persisted route truth and activation replay repair

## Delivery

- Branch: `codex/published-route-real-state`
- Verified base: `5bce65eb8a9553ca20cba2e7f4e17686d9ef44c7`
- Base note: `5bce65eb` is an empty late “Published your App” commit on `7d9a3a03`; the
  trees are identical.
- Delivery tip: recorded in the final branch handoff because a commit cannot contain its own hash.
- Phase 1 evidence:
  `docs/wall-10-published-route-real-state-evidence-20260817T035832Z.json`
- Verification evidence:
  `docs/wall-10-published-route-real-state-verification-20260817T041737Z.json`
- Live mutation from this branch: none
- Fly action: none
- New public surface or spend: none

## Outcome

Wall #10 is an idempotency-semantics defect, not a second slot-validation defect and not Worker
source drift. Wall #9 proved the production Worker was exact source `7d9a3a03`, but the repaired
activation function never ran. The Worker's request-bound idempotency layer replayed the 400
terminal stored by the older literal-blue implementation for the identical v158 activation body.

The branch gives route activation a named execution-semantics revision in its idempotency identity.
The revision is stable across ordinary retries and deployments, so replay remains strict. It changes
only when route-activation meaning changes, allowing corrected semantics to execute once instead of
being permanently shadowed by an old deterministic terminal. The same revision is applied to route
rollback, preventing a cached pre-fix rollback conflict from being mistaken for current route
authority.

No contract, request body, response body, artifact, layer, or manifest format changes. The route
test fixture now mirrors the exact captured production v149 record and proves blue→green and
green→blue activation under the production namespace.

## Phase 1 — evidence captured before code

The full record was appended first to `docs/cloudflare-production-cutover-plan.md`.

### Exact raiser and compared values

On Worker version `5a494b01-7712-48e9-bc71-3432f415a3e5`, the response was emitted by
`handleControlRequest` at the `lookup.state === "replay"` boundary before `executeEndpoint`.
The stored terminal originated in the pre-Wall #8 `activatePublishedRoute` code path:

- presented project/role: `51` / `production`
- presented active slot: `green`
- presented runtime identity: `nrf-ab8e18ef4ebebedd-p51-production-green`
- old hard-coded expected slot: `blue`
- typed response: `invalid_route_identity` / `Published route identity is invalid for this
deployment`

The current endpoint expects `route.activeSlot`; it was not invoked by the Wall #9 retry.

### Persisted production state

The read-only production database record is unchanged:

- Project 51 published snapshot: `149`
- staged/tested/approved snapshot: `158`
- v158 `production_release`: `null`
- current release format/state: `nabuflow.production-artifact-release/v1` / `active`
- current slot/identity: `blue` /
  `nrf-ab8e18ef4ebebedd-p51-production-blue`
- manifest revision: `prod-e7e60acd1aab9f576472f7d28ffc058f186117c80ec77ab5`
- promoted/activated: `2026-08-15T23:11:58.905Z`
- service port: `8080`

The corresponding Control Durable Object value is an unversioned strict `RouteRecord`:

```json
{
  "hostname": "platform-canary.apps.mustaflow.com",
  "projectId": 51,
  "role": "production",
  "activeSlot": "blue",
  "manifestRevision": "prod-e7e60acd1aab9f576472f7d28ffc058f186117c80ec77ab5",
  "servicePort": 8080,
  "sandboxIdentity": "nrf-ab8e18ef4ebebedd-p51-production-blue"
}
```

The stored object has no `format`, `updatedAt`, or last-modified member. Its last authoritative
write evidence is the release's `activatedAt`. Direct `_cf_KV` value reads remain prohibited by
Cloudflare Data Studio (`SQLITE_AUTH`), so no timestamp was invented.

### Current hostname and runtime truth

Read-only probes of `/` and `/healthz` both returned typed HTTP 503
`published_runtime_recovering`. The canary hostname is not serving the running green/v158
candidate. The stored route targets blue, and the public reads idempotently nudged its repaired
recovery path. Cloudflare then showed all three Project 51 identities running (`3/5`): preview,
blue, and green.

Blue's stop was historical, not caused by this publish attempt. Wall #8 captured four blue
`VMStopped` events beginning `2026-08-16T03:18:29Z` from the old observation/keepAlive defect.
Wall #9's activation cleanup targets green; it contains no operation that stops the prior blue.
The successful blue recovery after the read is consistent with that timeline.

The deterministic green v158 candidate is adoptable: it is running, its accepted sealed release is
unchanged, and neither the route nor project ledger claims it. The corrected retry will re-run
ensure/promote/start idempotently and then execute activation under the revised semantics key. Any
new activation failure remains guarded by reconciliation-before-delete cleanup.

## Phase 2 — branch repair

### Named activation semantics

`PRODUCTION_ROUTE_ACTIVATION_SEMANTICS_REVISION = "active-slot-v2"` is incorporated into the
activation and rollback base idempotency keys before the existing request hash is appended:

```text
production-publish:<promotion>:activate:semantics-active-slot-v2:request-<sha256>
production-publish:<promotion>:rollback:semantics-active-slot-v2:request-<sha256>
```

Ordinary retries retain identical keys. The old pre-fix activation and rollback records occupy
different keys and cannot replay over the current endpoint. The revision is deliberately not tied
to deployment version; routine deploys do not create new operations.

### Production-shaped bidirectional regression

The Runtime Worker route lifecycle regression now uses:

- namespace `production`
- Project `51`
- hostname `platform-canary.apps.mustaflow.com`
- exact v149 blue identity and manifest revision
- `node-api`, port `8080`, `/healthz`, production profile

It first persists/activates the captured blue record, then CAS-activates green over blue, then
CAS-activates blue over green. Signature, malformed/tampered/replay, missing-runtime, route-delete,
and typed-error posture remain covered in the same test.

The provider regression asserts the exact revised activation and rollback key shapes, preserving
one-operation replay semantics while proving the old unrevisioned key cannot shadow the request.

## Files changed

- `artifacts/api-server/src/lib/cloudflare-runtime-provider.ts` — named route-activation semantics
  revision used for activation and rollback idempotency identities.
- `artifacts/api-server/src/lib/cloudflare-runtime-provider.test.ts` — exact activation/rollback key
  regressions.
- `artifacts/nabuflow-runtime-worker/test/control-worker.test.ts` — captured production route fixture
  and bidirectional CAS proof.
- `docs/cloudflare-production-cutover-plan.md` — Phase 1 authority record written before code.
- `docs/wall-10-published-route-real-state-evidence-20260817T035832Z.json` — unique pre-code
  production evidence.
- `docs/wall-10-published-route-real-state-verification-20260817T041737Z.json` — unique final
  verification evidence.
- `docs/wall-10-published-route-real-state-report.md` — this delivery report.

## Verification

- Frozen offline install: passed; lockfile current; `2,259` packages linked, zero downloaded.
- Focused API provider: 1 file, 36/36 tests passed.
- Focused Worker route/control: 2 files, 20/20 tests passed.
- Complete Runtime Worker: 34 files, 254/254 tests passed.
- Complete tenant-runtime-contracts: 20 files, 187/187 tests passed.
- Workspace typecheck: passed.
- Workspace lint: passed.
- Every changed source, test, report, and evidence file: Prettier passed.
- `git diff --check`: passed.

The initial standalone API typecheck in the fresh worktree reported only TS6305 missing referenced
declaration outputs. `pnpm typecheck:libs` built those repository outputs without source changes;
the standalone API typecheck and full workspace typecheck then passed.

No package manifest, lockfile, dependency, Artifact v1, layer format, control request/response
schema, or tenant egress change was made. `pnpm-lock.yaml` SHA-256 remains
`B8DA847F2D8C8B30A5A84BFB362AB1176D86FD70DAFE972EDC6FCA9A684BD54E`.

## INCIDENTIAL FINDINGS

1. **Route-store forensic metadata remains absent.** The raw route has no last-modified field and
   no signed metadata-only read surface; Cloudflare blocks direct `_cf_KV` reads with
   `SQLITE_AUTH`. Reported only; no new surface was opened.
2. **Public reads can change runtime liveness.** A 503 `published_runtime_recovering` response also
   schedules the durable recovery that restarted blue. Read-only forensics must record this causal
   effect. Reported; this is intended repaired behavior.
3. **Three production Wrangler JSONC files fail repository-wide Prettier at the base.** Build,
   Pantry, and Runtime configs are byte-unchanged from `5bce65eb` (base diff exit 0). Their SHA-256
   values are `5E157E9C…`, `6AFDBC74…`, and `ED9D186F…`. Per the incidental-findings rule they were
   not reformatted. Every Wall #10-owned file passes Prettier.
4. **Fresh Windows linking is slow but observable.** The frozen offline install took 10m32.6s,
   continuously advanced, downloaded zero packages, and completed successfully. This was not the
   prior silent disk-saturation failure; free C: space after verification was about 11.6 GiB.

## Ship boundary and deployed-surface parity

This branch performs no live cleanup, route mutation, or publish retry. After Replit verifies and
ships it, the ship must also redeploy `nabuflow-runtime-production` from the exact merged SHA under
the standing DEPLOYED-SURFACE PARITY ritual: capture the before version, deploy from a fresh clean
checkout, stamp/read back the full Git SHA at 100% traffic, and capture the after version. Only then
may approved v158 be retried.
