# Slice 2b-ix-b6 — dual-mode tenant runtime SDK

- Date: 2026-08-09
- Branch: `codex/gateway-dual-mode-sdk`
- Audited base: `3910c784569eea3ae35445888d0b8df849d45a4f`
- Staging only; not merged or published

## Scope, restated

This slice adds the source-vendored database SDK that later Zero generator work can place inside generated Node applications. It establishes one explicit, fail-closed interface with two modes: the existing Fly/direct world lazily delegates unchanged SQL and parameters to a direct database driver using `DATABASE_URL`, while sealed Cloudflare runtimes send a bounded, unsigned database intent to the doorman's virtual capability host and never possess a credential or caller authority. The slice also centralizes the already-shipped database limits and virtual-host constants in `tenant-runtime-contracts`, provides a Drizzle proxy adapter, and locks the generated SDK bytes with a compatibility vector. It does not wire the generator, switch a provider, migrate an application, add transactions/cursors/migrations, or add a Stripe SDK surface.

## Outcome

The SDK foundation is complete and inert on this branch. The vendored source exposes parameterized `query`, atomic `batch`, bounded timeout/cancellation, stable statement results, sanitized typed errors, and a Drizzle proxy callback. Its two modes are explicit and have no fallback between them.

Current Fly applications are untouched: no existing application import, template, runtime selection, Fly provider, Fly configuration, or generator output changed. Cloudflare capability mode carries no credential, signature, cookie, database URL, project ID, runtime identity, container ID, or vault address. Live staging verification exercised only the pre-existing Worker surfaces after a same-value contract-literal refactor; production configuration and traffic were untouched.

## Implementation

### Contracts are authoritative

`lib/tenant-runtime-contracts` now owns:

- explicit runtime modes `fly-direct-v1` and `cloudflare-capability-v1`;
- the mode and direct-URL environment names;
- the doorman protocol, virtual host, intent path, and URL;
- the database capability provider/name/action tuple;
- SQL, parameter, batch, result-size, row-count, and timeout bounds;
- the runtime database intent/response schemas;
- the stable SDK error taxonomy and provider-error translation;
- canonical intent construction and serialization.

The Worker imports those values rather than maintaining duplicate literals. All values are byte-for-byte the previously shipped values; this refactor does not change a route, limit, timeout, or response.

### Vendored SDK source

`getVendoredRuntimeSdkFiles()` deterministically emits two LF-normalized source files:

| Path                         | Purpose                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| `.nabuflow/runtime/db.ts`    | Database client, direct/capability transports, validation, errors, timeout/cancellation, Drizzle proxy |
| `.nabuflow/runtime/index.ts` | Stable public re-export                                                                                |

The combined golden SHA-256 is `b6d08e22a3edf637d4cb240eec7e2f0b126027ad30c52b6a554f39fc671947b7`.

The emitted source is dependency-free. Its only direct-mode integration point is an injected `DirectDatabaseDriverFactory`; slice 7 can supply the generator-facing direct adapter without coupling this contract slice to a particular SQL package.

### Mode detection and tamper resistance

The trusted platform supplies exactly one non-secret marker, `NABUFLOW_RUNTIME_MODE`. The module parses that marker during static initialization and retains the resolved value for the module lifetime. Missing or unknown values fail closed with `configuration`. A database call cannot override mode, and mutation of process environment after initialization cannot switch an existing module or cause direct/capability fallback.

This is deterministic and tamper-resistant at the SDK boundary: request data and application call options are not mode authority. An application that alters the marker before loading can at most select a path that then fails closed or denies itself service. It gains no credential or cross-tenant authority: capability mode has neither, and the gateway independently binds the platform-supplied container ID to the active `nrf-` identity.

### Fly/direct posture

- Existing Fly code and configuration are not modified or imported by this slice.
- Direct mode does not read `DATABASE_URL` until the first database operation.
- SQL and parameters are handed to the injected direct driver unchanged.
- Direct mode never invokes the doorman fetch path.
- A missing direct URL or driver produces the stable sanitized `configuration` error; it does not switch modes.

Because generator integration is deferred, the bytes and observable behavior of every currently live Fly application remain unchanged.

### Cloudflare/capability posture

- The only destination is `http://doorman.staging.nabuflow.internal/v1/invoke`, already intercepted by the trusted runtime proxy.
- The request contains only the bounded database intent: protocol version, fixed capability tuple, random request token, SQL operation, and parameters.
- Headers are limited to content negotiation. No authorization, cookie, signature, or platform identity is emitted.
- `DATABASE_URL` is never read and the direct-driver factory is never called.
- Caller-supplied project/runtime/container fields are ignored; the SDK exposes no cross-tenant authority input.
- Provider failures map to stable sanitized categories: `invalid_query`, `conflict`, `timeout`, `cancelled`, `unavailable`, `policy_rejected`, or `internal`.

## Acceptance evidence

### Contract and SDK tests

| Proof                                            | Result                                                          |
| ------------------------------------------------ | --------------------------------------------------------------- |
| Full tenant-runtime-contracts suite              | 14 files, 158 tests passed                                      |
| SDK compatibility-vector and contract tests      | 13 tests included in the full contracts result                  |
| Vendored SDK execution suite                     | 1 file, 10 tests passed                                         |
| Full runtime Worker suite                        | 22 files, 150 tests passed                                      |
| Focused capability/database/runtime Worker tests | 3 files, 19 tests passed                                        |
| Vendored source semantic compile                 | Strict TypeScript compile passed against ES2022 + DOM libraries |
| Root typecheck                                   | Passed                                                          |
| API package typecheck                            | Passed                                                          |
| Worker package typecheck                         | Passed                                                          |
| Root lint                                        | Passed                                                          |
| Focused SDK/Worker lint                          | Passed                                                          |
| `git diff --check`                               | Passed                                                          |

The SDK execution suite compiles and runs the actual emitted source, not a parallel mock. It proves:

- deterministic golden files with no credential or generated identity;
- missing/unknown mode rejection during module evaluation;
- direct-mode lazy initialization, exact parameter forwarding, zero capability fetches, and frozen mode after initialization;
- capability-mode bounded intent bytes, zero auth headers, zero direct-driver calls, and no caller authority;
- query, batch, timeout, cancellation, malformed-response, and sanitized-error behavior;
- Drizzle proxy parameter preservation;
- equivalent application-level query/result semantics across separately loaded direct and capability modules.

### Fly byte-identity regression

The base-to-branch path audit contains no existing Fly provider/configuration file, no `tenant-runtime.ts`, no `runtime-manifest.ts`, and no existing generated application/template file. There is no import of the new SDK from a shipped application path. Direct-mode tests prove the legacy operation boundary—SQL, parameters, lazy `DATABASE_URL`, and injected direct driver—without any capability call. Therefore the current Fly runtime remains byte-identical and behaviorally untouched.

### Four-surface staging gate

The staging Worker was deployed with the contract-owned constants only. Code deployment version was `941a8a99-9679-4597-9e19-9c2fc095b24b`; the subsequent atomic secret deployment observed by the gate was `711d0d98-db6f-4e53-a57f-08eb76b4ad7e`.

One atomic, session-only rotation generated the complete staging Worker secret set in Base64URL-without-padding form, self-checked it before write, and erased all values at process exit. The run measured a fresh lab clock offset of `-11,812,203 ms`.

| Independently consumed surface | Required | Observed |  First green | 20th consecutive green |        Final status |
| ------------------------------ | -------: | -------: | -----------: | ---------------------: | ------------------: |
| Control HMAC                   |       20 |       20 |   174.534 ms |          41,959.559 ms |                 200 |
| Preview grant verification     |       20 |       20 |   246.921 ms |          42,019.498 ms |                 302 |
| Vault KEK encrypt/decrypt      |       20 |       20 |   971.506 ms |          42,692.418 ms |                 200 |
| Preview redeem + replay pair   |       20 |       20 | 1,344.718 ms |          42,859.649 ms | 409 replay detected |

The gate completed 120 signed requests in `42,859.685 ms`, within the five-minute / 600-probe bound. Unique evidence files were preserved before cleanup:

- `tmp/gateway-dual-mode-sdk/four-surface-20260809T224225462Z-eae012ba1348425baa80fefbf26b2fb2-pre-cleanup.json`
- `tmp/gateway-dual-mode-sdk/four-surface-20260809T224225462Z-eae012ba1348425baa80fefbf26b2fb2-final.json`

The first harness invocation used the obsolete namespace `gateway-staging`. The Worker correctly returned `preview_grant_scope_mismatch`; control and vault surfaces were green. This was a harness-only defect, corrected under the standing self-correction rule to the configured `staging` namespace, followed by a fresh atomic rotation and the clean run above. Its uniquely named failure evidence remains preserved beside the clean evidence.

No scratch runtime, container, artifact, Pantry object, or R2 object was created for this slice. Each vault-readiness record was revoked immediately, session values were erased, and the final gate transcript shows no residual readiness record.

### Ora stability gates and exact-base parity

| Gate            | Branch result                                  | Exact base `3910c784`        | Verdict                    |
| --------------- | ---------------------------------------------- | ---------------------------- | -------------------------- |
| Fast profile    | 14 pass, 1 expected dirty-tree warning, 0 fail | Not needed                   | Green                      |
| Release profile | 18 pass, 0 warn, 3 fail                        | 18 pass, 0 warn, same 3 fail | Exact environmental parity |

The three release failures are identical on branch and clean base:

1. `api-release-extended`: `ora-realtime-usage.test.ts` cannot connect to `127.0.0.1:5432`.
2. `api-account-billing-history`: `ora-memory-consolidation.test.ts` receives API 500 because the same local PostgreSQL endpoint is unavailable.
3. `web-build`: dynamic prerender fails with `ECONNREFUSED 127.0.0.1:5432`.

Every other release row passed on both. The clean-base report was preserved as `tmp/gateway-dual-mode-sdk/ora-release-base-20260809.md` (SHA-256 `99257671111a717875135f65c5bb583d5a3e16cbdd48182df986d822ec288b9f`). Replit's database-equipped merge gate remains authoritative.

The final branch release profile ran after the slice commit with `--require-clean`; `git-commit`, `git-clean`, and all non-database rows passed. Its evidence is `tmp/gateway-dual-mode-sdk/ora-release-clean-branch-20260809.md` (SHA-256 `f7b3a0c0bcb281291e3b2e394b2e774596d7fa826dc80d3e6563c363201dcd29`).

## Manifest, dependency, and production-safety declaration

- `package.json` changes: **none**.
- `pnpm-lock.yaml` changes: **none**.
- Wrangler/deployment manifest changes: **none**.
- Runtime manifest changes: **none**.
- Frozen-lockfile proof trigger: **not triggered** by this diff. As worktree setup evidence, the branch nevertheless completed `pnpm install --frozen-lockfile --prefer-offline` with pnpm 10.26.1, 2,227 packages reused and zero downloaded.
- New dependencies: **none**; no build step fetched outside the Pantry.
- Tenant `enableInternet` / `allowedHosts`: **unchanged**.
- Fly provider/configuration: **unchanged**.
- Provider default and production `TENANT_RUNTIME_PROVIDER`: **unchanged**.
- Production Worker, secrets, DNS, and traffic: **untouched**.

## Optional lab cleanup

The two empty slice-3 proof stubs `.empty-pantry-catalog-proof` and `.verify-pantry-catalog-base` were removed. No `.wrangler-*-dry-run` directories remained when swept. The orphaned, unregistered slice-5 exact-base directory was reduced but Windows retained a read-only long-path `client-s3` subtree; it was not broadened into a risky cleanup operation. This slice's exact-base parity worktree was unregistered after its report was preserved, but Windows likewise retained its disposable long-path dependency directory. Neither residual path is a Git worktree or part of this branch.

## Recommendations

1. Slice 7 should provide the concrete direct/Fly driver adapter and generated-app integration without changing this explicit mode contract.
2. The trusted runtime/generator must inject `NABUFLOW_RUNTIME_MODE`; application request data must never select it.
3. Direct adapters must translate provider errors into `NabuFlowDirectDriverError` categories so raw connection and driver details remain sanitized.
4. Keep interactive transactions, cursors, migrations/DDL, Stripe SDK support, and generated-project migration in their planned later slices and gates.
5. Preserve the no-fallback rule. Automatic capability-to-direct fallback would turn a deployment/configuration error into a credential-boundary ambiguity.

No new pre-production gate conflict was found. PG-3 remains the hard database gate for persistent user data, limits, policy, rotation, migrations/DDL, and observability. PG-1 key rotation and PG-2 WebSocket hygiene are unchanged by this SDK-only slice.
