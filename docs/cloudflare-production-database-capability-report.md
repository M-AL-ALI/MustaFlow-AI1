# Cloudflare production database capability delivery report

Date: 2026-08-15

Branch: `codex/production-database-capability`

Verified base: `e73e8096ad1472733789895a016f7d80cd41c28c`

Implementation commit: `d5f1864ad8a1525c7c1cc2656cfef3242d15b083`

Authority: `docs/cloudflare-production-cutover-plan.md`, Cutover Slice B.

## Scope restatement

This slice gives a database-declaring sealed production project one durable, project-owned Neon
allocation at publish time. Provider management custody stays in the trusted Runtime Worker; the
connection URI is encrypted into that project's Capability Vault and is usable by tenant code only
through the existing doorman `neon-postgres/database` capability. The allocation identity is stable
across versions, restarts, and blue/green flips. Soft deletion retains it; hard GDPR erasure deletes
the provider project, verifies it absent, and only then removes vault ownership. The entire path is
shipped inert. No production resource, route, credential, or provider call belongs to this slice.

## Delivered behavior

### Publish and durable identity

The accepted sealed-release record now carries an additive `declaredCapabilities` field with an
empty default for all already stored v1 records. The kitchen derives that list from the generated
source. Before production artifact promotion, publish invokes the allocator only when the accepted
release declares `database`; the absence of a capable production provider fails typed as
`production_database_unavailable`.

The canonical allocation envelope contains exactly:

```json
{
  "format": "nabuflow.production-database-allocation/v1",
  "deploymentNamespace": "production",
  "projectId": 42
}
```

Its canonical JSON SHA-256 is the allocation identity. No release, version, manifest, runtime slot,
timestamp, request attempt, or provider-generated field participates. The same project therefore
attaches to the same live operation, adopts it after a dead consumer, or receives the same committed
allocation on every publish and blue/green transition.

### Shared durable execution

`production-database` is a new parameterization of the shipped durable-operation chassis, not a
second coordinator. Requests claim/observe/nudge; queue consumers execute with renewable leases,
generation fencing, redelivery adoption, alarms, the shared hard deadline, and a bounded sanitized
event trail. Its checkpoints are:

1. `initialized`
2. `ownership-verified`
3. `provider-complete`
4. `provider-verified`
5. `vault-complete`
6. `finalized`

The provider follows the operation under the named five-minute database operation bound. The signed
metadata-only diagnostic route is:

`GET /_nabuflow/control/v1/capabilities/:projectId/neon-postgres/database/production-allocation/:allocationIdentity/diagnostics`

It returns job identity, action, state, checkpoint, attempts, lease/deadline timestamps, typed
terminal metadata, and the bounded event trail. It returns no connection URI, provider management
credential, vault ciphertext, or other payload.

### Trusted provider allocation

The allocator is deliberately separate from the staging Acceptance Provisioner. It permits only
the official Neon management API origin and uses bounded response bodies, a named per-request
timeout, a named retry limit/backoff, typed pre-dispatch/provider/weather/integrity outcomes, and
exact-operation retries.

Before a create it verifies all locks/configuration and lists the dedicated organization's owned
project namespace. A configured maximum project count is a fail-closed cost ceiling. The project
name is deterministic from the allocation identity. An ambiguous body-bearing create is never sent
blindly twice: the allocator first discovers the deterministic object and accepts it only after
identity checks. Concurrent misses therefore converge on one provider object.

Every create and warm reuse independently reads the project, repairs the configured
`history_retention_seconds` if required, reads it again, and rejects a mismatch. Region mismatch,
duplicate deterministic objects, malformed provider data, non-Neon connection origins, and
cross-organization release all fail typed. These calls follow the current official Neon project
contracts:

- <https://api-docs.neon.tech/reference/createproject>
- <https://api-docs.neon.tech/reference/getproject>
- <https://api-docs.neon.tech/reference/updateproject>

### Vault handoff and runtime boundary

The allocator receives the database connection URI only in trusted Worker memory and hands it
directly to the per-project Capability Vault. The vault encrypts it with the existing active KEK and
atomically stores the encrypted capability plus the nonsecret provider ownership record. The API
response contains only the allocation identity, revision, provider project ID, and reuse state.

Tenant source, manifest, environment, runtime descriptor, API logs, durable event trail, diagnostic
surface, and evidence never receive a raw provider key or connection URI. Runtime database calls
continue through the existing doorman binding. While a hard release is in progress, calls fail typed
as `database_unavailable` rather than racing deletion.

### Lifetime and deletion

Normal project deletion is still the existing recoverable soft delete and does not call the
allocator. The allocation therefore survives the 30-day recovery window. The GDPR hard-erasure
worker is the true deletion fence:

1. mark the vault allocation `releasing`;
2. delete the provider project idempotently;
3. read the provider project and require authoritative 404;
4. atomically remove the encrypted capability and ownership record; and
5. only then continue with product-row hard deletion.

A provider error or incomplete verify-gone stops row deletion, preserving the ownership record for
safe retry. Fly and every provider without the additive production-database interface retain their
legacy behavior.

## Inert locks and founder ceremony

The new provider secret binding required for production is:

- `NABUFLOW_PRODUCTION_NEON_MANAGEMENT_KEY`

The production Worker also needs these nonsecret, founder-approved settings:

- `NABUFLOW_PRODUCTION_DATABASE_ALLOCATION_ENABLED=enabled`
- `NABUFLOW_PRODUCTION_NEON_ORGANIZATION_ID`
- `NABUFLOW_PRODUCTION_NEON_REGION_ID`
- `NABUFLOW_PRODUCTION_NEON_HISTORY_RETENTION_SECONDS`
- `NABUFLOW_PRODUCTION_DATABASE_MAX_PROJECTS`

The existing Capability Vault bindings remain required:

- `CLOUDFLARE_CAPABILITY_VAULT_KEK_V1`
- `NABUFLOW_CAPABILITY_VAULT_ACTIVE_KEY_ID`

No value was requested, captured, generated, installed, or recorded. The management key, dedicated
production Neon organization, region, retention policy, and project ceiling are a later founder
ceremony. Feature advertisement requires the complete configuration, the allocation gate, the
durable queue, and production namespace. Tests may exercise the same code only under the separate
staging namespace plus `NABUFLOW_STAGING_PRODUCTION_DATABASE_REHEARSAL=enabled`; that rehearsal lock
must be absent from production.

## Staging rehearsal

The in-process staging-shaped rehearsal uses signed control requests, the real shared coordinator,
queue drain, Capability Vault contract, response validators, and the real provider adapter contract
with an injected credential-free fake Neon transport. It proved the entire state flow without a live
provider call or resource:

| Rehearsal row                                                                      | Result |
| ---------------------------------------------------------------------------------- | ------ |
| Production feature remains hidden without all locks                                | PASS   |
| Signed ensure creates one durable job and one provider allocation                  | PASS   |
| Provider connection material reaches the vault but not the response or event trail | PASS   |
| A new release/idempotency key reuses the exact project-owned allocation            | PASS   |
| Vault restart decrypts the same capability envelope                                | PASS   |
| Canonical-identity mismatch fails before provider or vault mutation                | PASS   |
| Ambiguous create discovers the winner before any second body-bearing put           | PASS   |
| Cost, org, region, retention, response, and URI checks fail closed                 | PASS   |
| Hard release deletes, authoritatively verifies gone, then clears vault ownership   | PASS   |
| Signed diagnostic surface returns metadata-only terminal evidence                  | PASS   |
| Shared adoption/deadline/checkpoint tests include the new job kind                 | PASS   |

The live provider ceremony is intentionally deferred: it needs the founder-installed production
management binding and creates a billable production resource. This branch opened no surface and
incurred no cost.

## Acceptance evidence

| Check                                              | Result                                               |
| -------------------------------------------------- | ---------------------------------------------------- |
| Frozen offline install                             | PASS; lock current, zero downloads, final proof 3.2s |
| Workspace typecheck                                | PASS; all libraries/artifacts/scripts, 30.5s         |
| Workspace lint                                     | PASS; all 20 participating packages, 18.4s           |
| Workspace format check                             | PASS                                                 |
| Contracts full suite                               | PASS; 20 files, 187/187                              |
| Runtime Worker full suite                          | PASS; 32 files, 244/244                              |
| Focused API/provider/publish-lifecycle/eligibility | PASS; 3 files, 56/56                                 |
| API full suite exact-base parity                   | PASS; identical 39-failure fingerprint               |
| Clean release-profile exact-base parity            | PASS; identical three PostgreSQL-dependent rows      |
| `git diff --check`                                 | PASS                                                 |
| Changed-file credential-pattern scan               | PASS; zero findings                                  |
| Manifest and lockfile check                        | PASS; no changes                                     |
| Fly named-file check                               | PASS; zero files                                     |
| Artifact v1/layer wire-file check                  | PASS; zero files                                     |
| Tenant egress/config check                         | PASS; zero files                                     |
| Live deploy/provider/resource/cost check           | PASS; none                                           |

The full API branch run completed 2,300 passed, 39 failed, and 5 skipped of 2,344. Exact base
completed 2,296 passed, 39 failed, and 5 skipped of 2,340. The sorted failure-name set is byte-for-byte
identical with SHA-256
`1097110a875f3e55a0c2381f3a72b7e8a8923b5cca1ad988aea869ed765190aa`.

The clean release profile on both branch and exact base completed 18 pass, 0 warn, 3 fail. The three
rows are the documented missing-local-PostgreSQL baseline: `api-release-extended`,
`api-account-billing-history`, and `web-build` dynamic prerender, all rooted in
`ECONNREFUSED 127.0.0.1:5432`. No production-database assertion failed. Replit's DB-backed merge gate
remains authoritative.

## Compatibility and manifest declaration

No `package.json`, `pnpm-lock.yaml`, Wrangler configuration, `.replit`, or provider manifest changed.
The final frozen offline install passed against the unchanged lock.

Artifact v1 and dependency-layer wire contracts are byte-untouched. The accepted kitchen-result
record gains only the backward-compatible defaulted capability declaration used to decide whether
publish needs a database. Tenant egress settings and Fly files are byte-untouched. Production and
staging deployments are untouched.

## File inventory

### Contracts

- `lib/tenant-runtime-contracts/src/production-database.ts` — typed identity, requests, responses,
  ownership record, binding names, capability policy, and checkpoints.
- `lib/tenant-runtime-contracts/src/artifact-commit.ts` — shared durable job/diagnostic union.
- `lib/tenant-runtime-contracts/src/production-artifact.ts` — additive defaulted capability stamp.
- `lib/tenant-runtime-contracts/src/constants.ts` and `src/index.ts` — feature/export registration.
- `lib/tenant-runtime-contracts/test/production-database.test.ts` — identity, strict schemas,
  retention ownership, and old-record compatibility.

### Runtime Worker and vault

- `artifacts/nabuflow-runtime-worker/src/production-database-allocator.ts` — guarded Neon adapter.
- `src/bindings.ts` — typed bindings only.
- `src/capability-vault-durable-object.ts` — atomic encrypted handoff and release fence.
- `src/control-durable-object.ts`, `src/model.ts`, and `src/worker.ts` — shared job kind, routes,
  execution, diagnostics, and feature lock.
- `test/production-database-allocator.test.ts` and `test/production-database-control.test.ts` —
  provider and end-to-end staging rehearsal.
- `test/capability-vault.test.ts`, `test/artifact-commit-coordinator.test.ts`, and `test/helpers.ts` —
  vault restart/replay and shared-chassis regressions.

### API and publish lifecycle

- `artifacts/api-server/src/lib/tenant-runtime-provider.ts` — additive capable-provider interface.
- `src/lib/cloudflare-runtime-provider.ts` and its test — stable signed ensure/release follower.
- `src/lib/production-database-lifecycle.ts` and its test — publish preparation and hard-delete
  fence.
- `src/lib/zero-generation-kitchen.ts` — persists generated capability declarations.
- `src/routes/publish.ts` — allocate before production promotion.
- `src/lib/gdpr-erasure-worker.ts` — release/verify-gone before hard deletion.

### Authority

- `docs/cloudflare-production-cutover-plan.md` — Slice B implementation record, binding inventory,
  reality correction, and PG-3 update.
- `docs/cloudflare-production-database-capability-report.md` — this report.
- `docs/cloudflare-production-database-capability-evidence-20260815T094503Z.json` — uniquely named
  machine-readable evidence.

## Outcome

Slice B is complete as branch-only, inert product work. The permanent database supply line is
implemented and staging-rehearsed; the production credential/resource ceremony remains deliberately
unperformed. Replit owns merge and publish.
