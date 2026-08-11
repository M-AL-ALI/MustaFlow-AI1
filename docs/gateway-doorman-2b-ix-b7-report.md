# Slice 2b-ix-b7 — Zero generator integration

- Date: 2026-08-11
- Branch: `codex/gateway-zero-generator`
- Audited base: `26132f4809f56754fd7ec36e3851563404738855`
- Staging only; not merged or published
- Final branch tip: reported with delivery because a Git commit cannot contain its own hash

## Scope, restated

This slice adds an inert, staging-only Zero generation target that produces a credential-free,
sealed-native Node application. The product generator emits a canonical runtime manifest, Pantry
dependency intents, and the vendored dual-mode SDK under `nabuflow/runtime/`; the trusted kitchen
stocks dependencies through Pantry, builds a dependency-complete output, seals it through the
unchanged Artifact v1/layer formats, delivers it through the dock, and follows the runtime to
`started` and healthy on port 8080 at `/healthz`.

The existing generation target remains the default and its prompt/template/emitted bytes remain
unchanged. The new target is triple-locked to explicit staging configuration and cannot be selected
by a production user or an existing project. No provider default changes, no production traffic,
no Fly changes, no credentials, and no tenant egress were introduced.

The live staging work exposed request-lifetime liveness defects in shipped Pantry, dock-commit, and
runtime-start orchestration. Their approved repairs are included on this branch, remain inert in
production, and preserve every wire format.

## Outcome

The first sealed-native Zero application completed the real product path from generation through a
cold Pantry stock, two-pass trusted build, seal, dock commit, runtime start, and health. A source-only
rebuild reused its dependency closure, and a dependency-change rebuild produced a new verified
closure and also reached a started, healthy runtime. The generated application carried zero
credential assumptions and tenant access to the public npm registry was blocked with the expected
platform `520`.

The final product acceptance contains 45/45 high-level checks. The preceding durable-operation
battery contains 1,419 checks, and the selective observation-blackout proof contains 47 checks.
All scratch state was destroyed: runtime `stop 200`, `destroy 200`, subsequent `404`; build R2 and
Pantry R2 both `0 objects / 0 bytes`; build active cells `0`.

## New Slice 7 behavior

### Generator and sealed source

- `cloudflare-sealed-staging-v1` is an explicit, inert generation target; `legacy-v1` stays the
  product default.
- The sealed target emits a canonical Node manifest, dependency plan, and vendored runtime SDK.
- Vendored source lives at the non-hidden, generated-code path `nabuflow/runtime/*`; the trusted
  build path-security contract still rejects dot-prefixed source paths.
- Generated sealed source has no `DATABASE_URL`, `STRIPE_*`, private key, platform identity,
  registry URL, `npm install`, or tenant-side package-fetch assumption.
- The SDK's sealed mode uses the capability channel; the existing direct/Fly mode remains unchanged.
- The generated app binds `0.0.0.0:8080` and serves `/healthz`.

### Kitchen orchestration

- Pantry waiting follows canonical stock identity and explicit durable progress instead of a private
  300-second timer.
- The outer kitchen owns its 1,800,000 ms deadline and named reserves: assembly 1,140,000 ms,
  commit 300,000 ms, start 300,000 ms, observation 60,000 ms. Regressions assert the reserves fit
  and no child operation receives less than its reserve.
- Pantry terminal errors propagate immediately; outer timeout retains error authority and includes
  the inner follower state and last assembly progress.
- Cancellation disposes the wait/follower resources cleanly.
- The provider uses one shared durable-operation follower across applicable Pantry, artifact commit,
  ensure/start, and lifecycle paths. Stable idempotency keys create exactly one operation.
- Transport timeouts are floored positive integers. A sub-minimum remaining budget skips dispatch;
  deterministic pre-dispatch exceptions are typed, non-retryable, and cannot masquerade as weather.

### Canonical stock identity

One contracts-owned, content-addressed stock envelope excludes timestamps and transient fields.
Transport idempotency and Pantry pending-assembly equivalence both use it. An identical request may
attach, adopt, or return the warm committed result; a semantically distinct request is a typed
conflict. Cleanup discovery is read-only and cannot create or extend an assembly.

## Shipped-path repairs

### Pantry assembly execution

- Renewable leases heartbeat through long stages; atomic generation adoption has one winner.
- Alarm/queue execution owns re-enqueue. Polls observe or idempotently nudge but never enqueue.
- Durable assembly trails preserve progress, claims, adoption, lease, staging, typed failure,
  reclamation, and terminal events.
- Failed uncommitted CAS writes are reclaimed; a guarded orphan sweep cannot touch a ledger-referenced
  committed shelf.
- Per-completed-object resume re-reads and hash-verifies prior objects, then resumes at the first
  incomplete object.
- Immutable CAS existence is established by read plus full hash verification. A body-bearing
  conditional put occurs only on verified absence and is independently reverified. Concurrent
  misses verify the winner; corrupt existing bytes fail closed.
- Warm dependency-change replays therefore add verification reads while avoiding all redundant
  body-bearing puts.
- Transient R2 failures are typed and retried at the exact operation with durable evidence. A focused
  probe disproved a per-invocation ceiling: one successful cold generation used 168 registry calls,
  812 Durable Object calls, 1,544 R2 calls, approximately 2,550 subrequests, and 494.6 seconds.

### Dock and durable operation coordinator

- Artifact commit, runtime start, and manifest restart share one queue-driven job chassis: claim,
  observe/nudge, durable checkpoints, renewable lease, adoption, alarm re-enqueue, hard-deadline
  terminalization, and a bounded sanitized event trail.
- Requests no longer own execution. An aborted request, killed consumer, ambiguous transport, or
  absent retry cannot orphan a job.
- Signed discovery lists bounded recent job metadata; signed per-job diagnostics recover the full
  checkpoint/lease/event trail.
- Durable terminal observation blackout is distinct from job failure. `artifact_commit_terminal_unknown`
  reports attempt/cause counts and both bounds, stays retryable, and an identical later call recovers
  the actual durable terminal.
- The provider normalizes client-abort, connection-reset, fetch-exception, and genuinely
  indistinguishable transport causes. Pre-dispatch errors have a separate typed taxonomy.

### Runtime lifecycle audit

| Operation                 | Execution posture                                            | Result  |
| ------------------------- | ------------------------------------------------------------ | ------- |
| `runtime.ensure`          | Bounded idempotent request/follower; no long container start | Covered |
| Artifact v1 commit        | Queue-driven durable job + shared follower                   | Covered |
| Layered artifact commit   | Queue-driven durable job + shared follower                   | Covered |
| `runtime.start`           | Queue-driven durable job + shared follower                   | Covered |
| Manifest explicit restart | Queue-driven durable job + shared follower                   | Covered |
| `runtime.stop`            | Measured bounded, idempotent lifecycle request               | Covered |
| `runtime.destroy`         | Measured bounded, idempotent terminal delete                 | Covered |
| Pantry assembly           | Alarm/queue-owned checkpointed execution + progress follower | Covered |

The live kill/abort/ambiguous/no-retry battery showed exactly one ledger operation per idempotency
identity, terminal state without manual intervention, and zero undisposed-RPC warnings.

## Terminal-unknown blackout proof

The selective proxy passes begin, chunks/layers, and the commit initiation. It drops only subsequent
commit observation/follow requests. The signed Worker-side discovery and diagnostic routes proved:

| Assertion                     | Result                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------- |
| Pre-commit requests passed    | 100%                                                                              |
| Commit initiation observed    | Exactly once                                                                      |
| Durable job during blackout   | `succeeded`                                                                       |
| Provider observations dropped | 25                                                                                |
| Provider outcome              | `503 artifact_commit_terminal_unknown`, retryable                                 |
| Evidence                      | 26 attempts, 25 `fetch_exception`, 30,000 ms passed bound, 300,000 ms named bound |
| Identical call after blackout | Recovered the durable success                                                     |
| Durable operations in ledger  | Exactly one                                                                       |

The earlier begin-stage `unreachable ×30` stop is restated honestly: it was not proxy scoping. A
fractional monotonic-clock remainder reached `AbortSignal.timeout` before fetch dispatch. The shared
follower now floors the value, enforces a named minimum viable dispatch window, and types all
pre-dispatch exceptions. The selective proxy remains valuable because it exposed that defect.

## Full live acceptance

### Four-surface gate for the full product run

Fresh measured lab clock offset: `-11,812,409 ms`.

| Independently consumed secret surface | Consecutive greens | Probes |  First green |    Completion | Terminal expectation |
| ------------------------------------- | -----------------: | -----: | -----------: | ------------: | -------------------- |
| Control HMAC                          |                 20 |     20 |   514.801 ms | 50,690.862 ms | 200                  |
| Preview grant verification            |                 20 |     20 |   586.270 ms | 50,758.400 ms | 302                  |
| Vault KEK                             |                 20 |     20 | 1,330.728 ms | 51,448.981 ms | 200                  |
| Preview redeem + replay pair          |                 20 |     20 | 1,732.713 ms | 51,624.507 ms | 302 then 409         |

Gate total: 120 signed requests, 51,624.536 ms, within five minutes / 600 probes.

### Generated application matrix

| Row                       | Live result                                                                  |
| ------------------------- | ---------------------------------------------------------------------------- |
| Product generation path   | 5 generated files, 5 initial dependency intents, zero credential assumptions |
| Initial provision         | `react-vite`, port 5173, stopped, then signed manifest transition            |
| Cold Pantry/build         | New shelf and closure, dependency-complete artifact                          |
| Cold sealed delivery      | Layered commit durable success                                               |
| Cold runtime              | Started, healthy on `8080 /healthz`                                          |
| Tenant registry egress    | Blocked, platform status 520                                                 |
| Source-only rebuild       | Closure reused, artifact changed, started healthy                            |
| Dependency-change rebuild | 6 intents, closure changed, artifact changed, started healthy                |
| Artifact formats          | Artifact v1 and layer wire bytes unchanged                                   |
| Runtime credentials       | Zero generated or container-held credentials                                 |

Cold artifact SHA-256:
`61546b05a236613848845dcdc041334d9a4a9560561c35fd5462b67d08aac420`.
Source-change artifact SHA-256:
`9499bbaf6ee08492810f76796fbe7d80f22e6573eac88342b33afaecc87fb2fb`.
Dependency-change artifact SHA-256:
`3075a81bf41742c09daee37ba2fc393490d7dc6587a7f30d0ba212d2c0ab132e`.

### Existing-mode byte identity

- The default target remains `legacy-v1`.
- Existing prompt, template, file ordering, generated code, and runtime assumptions retain golden-byte
  coverage.
- The new target requires explicit staging configuration and is not reachable through live product
  selection.
- Fly provider/configuration files are absent from the base-to-branch diff.
- Direct/Fly SDK tests preserve exact SQL/parameter forwarding and zero capability requests.

### Durable repair battery

- 1,419 acceptance checks passed.
- Commit, start, and manifest jobs survived owner death at every checkpoint.
- Initiating HTTP aborts, repeated ambiguous failures, and alarm-only/no-retry paths reached a durable
  typed terminal with one ledger operation.
- The deliberately failed manifest-restart path returned typed `502 runtime_restart_failed` 10/10;
  zero `503 unexpected_worker_error` escapes.
- Scanner and sealer both used only trusted-ledger shelf provenance. Public shelf-identical bytes were
  exempted; modified/divergent files stayed scanned and planted markers were rejected.
- Zero undisposed-RPC warnings and zero untyped application errors were observed in the acceptance
  window.

## Vendor alarm classification

### Diagnosis

The one observed non-application exception was inside `@cloudflare/containers@0.3.7`, not NabuFlow
code. Wrangler recorded a `NabuflowSandbox` Durable Object alarm with:

```text
Error: internal error; reference = vaadbgp8ggo6u9fositr92kq
at ContainerState.update
at ContainerState.setStatusAndupdate
at ContainerState.setStopped
at the package alarm callback
```

It occurred 9.383 seconds after a successful stop request. The runtime descriptor nevertheless read
`stopped`, with `endpoint`, `readyAt`, and `lastError` all null. The same runtime subsequently started
successfully, then stopped, destroyed, and returned 404. Storage and active-cell counts were zero.
No response exposed the exception or reference.

Six lifecycle variants plus the original sequence established timing dependence. The controlled
study reproduced the package exception once across eight stop cycles. Destroy-only did not trigger
it. Version 0.3.7 is the latest official release; its own release fixed an earlier alarm/start-stop
race, and official post-0.3.7 history contains no later lifecycle fix. This branch does not fork or
patch the package.

### Acceptance-only typed classification

`known_vendor_alarm_signature` matches only all of the following:

- Worker `nabuflow-runtime-staging`;
- Durable Object entrypoint `NabuflowSandbox`;
- `outcome=exception`;
- the exact internal-reference message shape;
- the exact four-symbol stack chain above.

One Wrangler event is one occurrence even when Wrangler duplicates the exception array. Each
occurrence is accepted only after a per-occurrence checklist proves: consistent stopped state;
destroy 200; subsequent 404; zero active runtime; build and Pantry storage zero; no accruing compute
cost. Missing or failed evidence hard-fails. More than two occurrences per acceptance run hard-fails.
Any changed message, stack, entrypoint, class, or state remains an unclassified hard failure.

The classification exists only in acceptance tail evaluation. Deployment-reset events are retained
as propagation evidence before the acceptance window and are never classified or counted. A code
comment requires removing the classification at the first `@cloudflare/containers` release that
fixes this alarm signature.

### Closing tail-sensitive rerun

Deployment code version: `15ca6399-bc4d-424f-b829-e72f3a09dfcc`; post-rotation active runtime
deployment version: `bc9224da-f806-4fb3-b2ce-9d1dfab2b886`.

The tail began only after atomic rotation and the four-surface gate. The focused lifecycle performed
two start/stop cycles, two 45-second alarm-settle windows, consistent stopped-state reads, destroy
200, subsequent 404, and zero-state diagnostics.

| Tail result                                      | Count |
| ------------------------------------------------ | ----: |
| Unclassified exceptions                          |     0 |
| `known_vendor_alarm_signature`                   |     0 |
| Deployment-reset events inside acceptance window |     0 |
| Allowed classified budget                        |     2 |
| Orphan tail processes/raw tail files             |     0 |

The closing gate required 50 probes per surface because the newly rotated set converged after about
37 seconds; all four then accumulated 20 consecutive greens. Gate total was 82,164.210 ms / 300
signed HTTP requests. Fresh measured lab clock offset was `-11,811,904 ms`.

## Founder-ready Cloudflare support report

The following block is sanitized and ready for the founder to submit through Cloudflare support.
Nothing has been submitted by Codex.

```text
Subject: Intermittent @cloudflare/containers 0.3.7 setStopped alarm exception with consistent terminal state

Product: Cloudflare Containers / Durable Objects
Package versions: @cloudflare/containers 0.3.7, @cloudflare/sandbox 0.12.4,
Wrangler 4.118.0
Worker: staging only

Reference: vaadbgp8ggo6u9fositr92kq

At 2026-08-11T00:35:20.337Z a sandbox stop request completed successfully. At
2026-08-11T00:35:29.720Z, 9.383 seconds later, the NabuflowSandbox alarm emitted:

  Error: internal error; reference = vaadbgp8ggo6u9fositr92kq
  at ContainerState.update
  at ContainerState.setStatusAndupdate
  at ContainerState.setStopped
  at the package alarm callback

The runtime descriptor after the event was internally consistent: status=stopped and endpoint,
readyAt, lastError were null. The same runtime later started successfully, then stopped, destroyed,
and returned 404. There were zero active runtimes/cells, zero residual R2 objects/bytes, and no
ongoing compute cost. No exception detail reached a client response.

Controlled staging reproduction: 1 occurrence in 8 stop cycles across immediate stop/destroy,
30-second settle, 120-second settle, and repeated start/stop variants. Destroy-only did not reproduce.
The failure is timing-dependent. Deployment code-reset alarm events were analyzed separately and are
not included in that statistic.

Please confirm whether ContainerState.update/setStopped has a known alarm race in 0.3.7 and whether
a fix is planned for a subsequent @cloudflare/containers release. Sanitized Wrangler event and
lifecycle/zero-state evidence can be supplied on request.
```

## Verification

| Verification                         | Result                                         |
| ------------------------------------ | ---------------------------------------------- |
| Tenant-runtime-contracts             | 16 files / 171 tests passed                    |
| Runtime Worker                       | 24 files / 194 tests passed                    |
| Tail-classifier focused suite        | 10 tests passed                                |
| API/provider/generator focused suite | 8 files / 79 tests passed                      |
| Root typecheck                       | Passed                                         |
| Worker typecheck                     | Passed                                         |
| Root lint                            | Passed                                         |
| Worker lint                          | Passed                                         |
| Prettier check                       | Passed                                         |
| Copy guard                           | 1 file / 3 tests passed                        |
| `git diff --check`                   | Passed                                         |
| Ora fast profile                     | 14 pass, 1 expected dirty-tree warning, 0 fail |

### Three-database-suite exact-base parity

The clean exact base `26132f48` passed 18 release rows and failed exactly the same three
database-dependent rows as the branch on this Windows lab:

1. `api-release-extended` / `ora-realtime-usage`: `ECONNREFUSED 127.0.0.1:5432`.
2. `api-account-billing-history` / `ora-memory-consolidation`: API 500 from the same missing local
   PostgreSQL endpoint.
3. `web-build`: dynamic prerender fails on the same PostgreSQL connection refusal.

Everything else passed on base and branch. Replit's database-equipped ship gate remains
authoritative. The final clean-tree branch release profile is recorded after commit.

## Evidence index

| Evidence                                                     | SHA-256                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------ |
| Full product pre-cleanup, `...032420339...-pre-cleanup.json` | `133ad72e7971a1d24f22e041e6b20edbaebd40ad901f7855a596ef621eed9bb4` |
| Full product final, `...032420339...-final.json`             | `5aca629ca202ea9d1536cc1e3ea6482780e0c9f337fa9466b5d83ac888680691` |
| Durable battery final, `...012858440...-final.json`          | `0ed85cb09da059ed0a6378d2b48c573023fe23dadc6316bc8cb9c568da3770ae` |
| Selective blackout final, `...012553451...-final.json`       | `a35a9912ff3ae157d9307025feea5e3d0aa930a71738e07ca59d8dde10678a4`  |
| Original redacted full tail                                  | `c53be0f081ead4d64ec2e52b43348bcecc6664938fbf135e186705ba748178c1` |
| Vendor state-capture final, `...045416314...-final.json`     | `cd407b8d8455cf27a30a924ef67c3c6baee0df99da66ab6144339f6aff8c97c9` |
| Vendor state-capture sanitized tail                          | `f5ab8d7726ff0bcee51cffaddbab640d0fab510a8d8a642253aad6e7ee50a6c2` |
| Closing tail pre-cleanup, `...052204512...-pre-cleanup.json` | `86fcb85996311c11ba7835ebc1c18a42bd5c0c07562cfd9971e101b180369056` |
| Closing tail final, `...052204512...-final.json`             | `b4ccf8267dc0a8280afdfbfee8fce8f855a6718f2651be98e23d4b7ef95fdb7b` |

Evidence files are uniquely named and preserved outside Git. No raw secret, private key, connection
string, or provider credential appears in them. The closing tail was parsed in process; no raw tail
file was written.

## Complete changed-path enumeration

### New Slice 7 feature paths

| File                                                                      | Rationale                                                                                                 |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `artifacts/api-server/src/lib/agent-loop.ts`                              | Carry the explicit sealed generation target through agent completion without altering the default target. |
| `artifacts/api-server/src/lib/agent-loop.container-tool-deferral.test.ts` | Existing-mode bytes/flow and sealed-target propagation regression.                                        |
| `artifacts/api-server/src/lib/builder.ts`                                 | Emit canonical sealed metadata and vendored SDK only for the explicit staging target.                     |
| `artifacts/api-server/src/lib/builder-zero-generation.test.ts`            | Real builder output, path posture, credential absence, and legacy golden regressions.                     |
| `artifacts/api-server/src/lib/jobs.ts`                                    | Preserve the explicit target in durable build-job inputs.                                                 |
| `artifacts/api-server/src/lib/zero-generation-job-wiring.test.ts`         | Job wiring, default inertness, and target persistence.                                                    |
| `artifacts/api-server/src/lib/zero-sealed-generation.ts`                  | Canonical sealed source preparation, manifest, Pantry intent extraction, SDK placement.                   |
| `artifacts/api-server/src/lib/zero-sealed-generation.test.ts`             | Canonical/golden generation, path validation, credential scan, and dependency-change regressions.         |
| `artifacts/api-server/src/lib/zero-generation-kitchen.ts`                 | Progress-aware Pantry/build/seal/deliver/start orchestration with named outer reserves.                   |
| `artifacts/api-server/src/lib/zero-generation-kitchen-wait.test.ts`       | Cold >300s progress, terminal error, cancellation, outer-timeout authority.                               |
| `artifacts/api-server/src/lib/tenant-runtime-provider.ts`                 | Capability-checked sealed-generation provider seam; Fly implementation unchanged.                         |
| `artifacts/api-server/src/lib/tenant-runtime-provider.test.ts`            | Inert/default capability regression.                                                                      |
| `artifacts/api-server/src/lib/zero-runtime-sdk.ts`                        | Move sealed-only vendored SDK output to `nabuflow/runtime/*`.                                             |
| `artifacts/api-server/src/lib/zero-runtime-sdk.test.ts`                   | New path golden/import resolution and no old-path references.                                             |
| `artifacts/nabuflow-runtime-worker/test/zero-generation-kitchen.test.ts`  | Live-facing kitchen contract and inert routing coverage.                                                  |
| `lib/tenant-runtime-contracts/src/zero-generation.ts`                     | Authoritative generation target, canonical stock identity, manifests, bounds, and typed outcomes.         |
| `lib/tenant-runtime-contracts/test/zero-generation.test.ts`               | Identity, reserves, schemas, and legacy-default regressions.                                              |

### Pantry-era shipped paths repaired on this branch

| File                                                                     | Rationale                                                                                                   |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `artifacts/nabuflow-runtime-worker/src/pantry-catalog-durable-object.ts` | Renewable assembly lease, atomic adoption, monotonic progress, event trail, terminal/reclamation ownership. |
| `artifacts/nabuflow-runtime-worker/src/pantry-catalog-model.ts`          | Durable assembly diagnostics, generation, resource, and orphan-reclamation model.                           |
| `artifacts/nabuflow-runtime-worker/src/pantry-ingest.ts`                 | Typed transient taxonomy and verified resume inputs.                                                        |
| `artifacts/nabuflow-runtime-worker/src/pantry-worker.ts`                 | Alarm/queue-owned execution, CAS read-verify-create, exact-op retry, diagnostic surfaces, orphan sweep.     |
| `artifacts/nabuflow-runtime-worker/test/pantry-catalog.test.ts`          | Canonical identity, coalescing, adoption, no poll amplification, lease, progress, and sweep posture.        |
| `artifacts/nabuflow-runtime-worker/test/pantry-gateway.test.ts`          | Signed progress/diagnostic routes, typed failures, CAS integrity, read-only cleanup.                        |
| `lib/tenant-runtime-contracts/src/pantry-catalog.ts`                     | Canonical stock envelope/identity, progress/trail schemas, resource budgets, typed taxonomy.                |
| `lib/tenant-runtime-contracts/src/pantry.ts`                             | Contracts export needed by canonical identity/build handoff.                                                |
| `lib/tenant-runtime-contracts/test/pantry-catalog.test.ts`               | Canonical sameness/conflict and new diagnostics/resource invariants.                                        |

### Dock/slice-5-era and runtime-lifecycle shipped paths repaired

| File                                                                         | Rationale                                                                                                                |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `artifacts/api-server/src/lib/cloudflare-runtime-provider.ts`                | Shared operation follower, stable idempotency, outer bounds, terminal-unknown recovery, transport/pre-dispatch taxonomy. |
| `artifacts/api-server/src/lib/cloudflare-runtime-provider.test.ts`           | Provider-wide follower audit, >30s operations, blackout/recovery, fractional timer, cancellation, bounds.                |
| `artifacts/nabuflow-runtime-worker/src/artifact-commit-recovery.ts`          | Staging-only checkpoint-kill probes for commit/start/manifest batteries.                                                 |
| `artifacts/nabuflow-runtime-worker/src/bindings.ts`                          | Durable operation queue and approved staging probe bindings.                                                             |
| `artifacts/nabuflow-runtime-worker/src/control-durable-object.ts`            | Generalized queue job state, checkpoint/lease/adoption/fencing, trail, discovery, terminalizer.                          |
| `artifacts/nabuflow-runtime-worker/src/index.ts`                             | Export queue consumer and Durable Object surfaces.                                                                       |
| `artifacts/nabuflow-runtime-worker/src/model.ts`                             | Durable job, checkpoint, terminal, transport-cause, and diagnostic types.                                                |
| `artifacts/nabuflow-runtime-worker/src/runtime-backend.ts`                   | Runtime lifecycle recovery probe integration; normal backend policy unchanged.                                           |
| `artifacts/nabuflow-runtime-worker/src/worker.ts`                            | Signed commit/start/manifest job drivers, discovery/per-job routes, provenance read, typed boundaries.                   |
| `artifacts/nabuflow-runtime-worker/test/artifact-commit-coordinator.test.ts` | Kill/adoption/fencing/alarm/deadline/event-trail class regressions.                                                      |
| `artifacts/nabuflow-runtime-worker/test/artifact-control.test.ts`            | V1/layer commit, start, manifest, interruption, recovery, diagnostics, provenance, typed error coverage.                 |
| `artifacts/nabuflow-runtime-worker/test/artifact-layers-control.test.ts`     | Layered commit/provenance/secret-scan and wire-format posture.                                                           |
| `artifacts/nabuflow-runtime-worker/test/control-worker.test.ts`              | Top-level typed boundary and signed diagnostic authorization.                                                            |
| `artifacts/nabuflow-runtime-worker/test/helpers.ts`                          | Queue/job/binding test doubles and deterministic recovery controls.                                                      |
| `lib/tenant-runtime-contracts/src/artifact-commit.ts`                        | Named provider/server deadlines, margins, diagnostics, discovery, typed terminal contracts.                              |
| `lib/tenant-runtime-contracts/src/constants.ts`                              | Shared route/feature constants.                                                                                          |
| `lib/tenant-runtime-contracts/src/control-schemas.ts`                        | Version feature advertisement for inert staging surfaces.                                                                |
| `lib/tenant-runtime-contracts/src/index.ts`                                  | Export new authoritative contracts.                                                                                      |
| `lib/tenant-runtime-contracts/test/artifact-commit.test.ts`                  | Deadline arithmetic, schemas, and diagnostic identity coverage.                                                          |
| `lib/tenant-runtime-contracts/test/trusted-build.test.ts`                    | Trusted build/provenance boundary compatibility.                                                                         |
| `artifacts/nabuflow-runtime-worker/wrangler.jsonc`                           | Staging durable-operation queue producer/consumer and recovery-probe flags only.                                         |

### Acceptance-only paths

| File                                                                       | Rationale                                                                                                                             |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `artifacts/nabuflow-runtime-worker/scripts/trusted-build-staging-smoke.ts` | Full cold/dependency acceptance, identifier-complete evidence, durable batteries, cleanup, four-surface gate, closing tail lifecycle. |
| `artifacts/nabuflow-runtime-worker/scripts/staging-tail-evaluation.ts`     | Exact acceptance-only vendor signature classifier and consequence/budget enforcement.                                                 |
| `artifacts/nabuflow-runtime-worker/test/staging-tail-evaluation.test.ts`   | Exact-fingerprint, drift, consequence, occurrence-budget, and propagation separation tests.                                           |

All 50 changed paths are listed above. Fly provider/configuration is not among them.

## Manifest, dependency, and production-safety declaration

- `package.json` changes: **none**.
- `pnpm-lock.yaml` changes: **none**.
- Runtime application manifest format changes: **none**.
- Artifact v1 format changes: **none**.
- Artifact layer format changes: **none**.
- Frozen-lockfile proof trigger: **not triggered**.
- Wrangler deployment configuration: **changed, staging only**, to bind the approved durable-operation
  queue producer/consumer and recovery probes. No production deployment/configuration was touched.
- New dependencies: **none**.
- Tenant `enableInternet` / `allowedHosts`: **byte-identical**; live blocked-520 proof passed.
- Fly provider and Fly configuration: **byte-identical and untouched**.
- Production provider selection, secrets, DNS, and traffic: **untouched**.

## Permanent-rule ledger added during this slice

1. Pantry waits follow explicit progress inside the product bound; progress is never abandoned by a
   private adapter timeout.
2. One contracts-owned canonical identity defines semantic request sameness across transport and
   Pantry; timestamps/transient fields do not.
3. Cleanup/state discovery is read-only and cannot create, mutate, or extend operations.
4. One shared operation follower owns stable idempotency, terminal propagation, cancellation, and
   evidence-rich bounds across every applicable provider call site.
5. No operation's state **or execution** may depend on one request or consumer surviving.
6. Server deadlines and provider bounds use named observation margins; outer owners retain error
   authority.
7. Progress and terminal evidence survive every error path and include all diagnostic identifiers,
   stages, attempts, causes, and actual/named bounds before cleanup.
8. No orphaned bytes: every failed assembly reclaims pre-ledger writes, with guarded crash-gap sweep.
9. Long consumers use named bounded-invocation resource budgets with explicit headroom.
10. Weather is first-class: exact-operation retry, bounded backoff, durable cause evidence, no
    misleading typed terminal; observation blackout is not job failure.
11. Content-addressed existence is checked by read plus hash verification, never probed with a
    payload; corrupt immutable bytes fail closed.
12. Any timeout passed to a timer is a positive integer; sub-minimum budget means zero dispatch and
    a typed budget outcome.
13. Pre-dispatch exceptions are never transport/weather and never trigger retry storms.
14. Acceptance tail windows start only after deployment/secret readiness; propagation resets remain
    separate evidence.
15. A known-vendor tail classification must be typed, exact, consequence-proven per occurrence,
    tightly budgeted, acceptance-only, and carry a removal trigger.

## Recommendations and open gates

1. Submit the support report and remove `known_vendor_alarm_signature` as soon as Cloudflare ships a
   Containers release that fixes the `setStopped` alarm failure.
2. Keep the Pantry per-completed-object checkpoint and CAS read-verify-create metrics visible; warm
   dependency rebuilds should show verification reads and near-zero redundant writes.
3. Preserve the explicit sealed target lock until the later provider-cutover slice. Existing projects
   stay on the live legacy/Fly path.
4. PG-1 key-overlap work, PG-2 WebSocket hygiene, PG-3 database policy, PG-4 payments, and PG-5
   artifact provenance/portability remain gates. This slice closes generator-to-substrate plumbing;
   it does not waive any of them.
5. The retained unregistered exact-base dependency residue on the Windows lab is a housekeeping item,
   not a Git worktree or branch artifact; do not broaden deletion scope during delivery.
