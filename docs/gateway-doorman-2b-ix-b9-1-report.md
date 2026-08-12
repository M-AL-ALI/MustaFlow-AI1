# Micro-slice 2b-ix-b9.1 — Acceptance Provisioner readiness route

- Date: 2026-08-12
- Branch: `codex/acceptance-provisioner-readyz`
- Verified base: `689183d198849cad56656832b4a1a4d450cdbbb6`
- Implementation commit: `1a299f1befef29fd44f39ac424168bdf5a0628a6`
- Delivery status: branch-only; no merge, publish, deployment, secret mutation, credential use, or live provider call

## Scope restatement

This micro-slice adds one narrowly scoped, pre-authentication readiness probe to the staging Acceptance Provisioner. It proves that the Provisioner service and routing are alive, reports whether the staging gate is enabled, and categorizes the Acceptance Vault KEK as absent, malformed, or valid. It does not expose binding material, authorize work, alter the lease contract, weaken the triple lock, or activate any production behavior.

The route is the bootstrap ceremony's Window A baseline and Window B binding-visibility target. It is also the standing operational readiness signal for slices 10 and 11.

## Base discipline

`git ls-remote origin refs/heads/main` returned exactly:

`689183d198849cad56656832b4a1a4d450cdbbb6`

The branch was created directly from that commit. No moved-base conflict was present.

## Route contract

- Method: `GET`
- Path: `/_nabuflow/acceptance/v1/readyz`
- Authentication: none
- Status: `200`
- Content type: `application/json; charset=utf-8`

The response is schema-closed and contains exactly three fields:

```json
{
  "ready": true,
  "gate": "enabled",
  "kek": "valid"
}
```

`ready` means that the service and route answered. It does not claim that provider credentials, workload authentication, or a lease are available. `gate` reflects only `ACCEPTANCE_STAGING_ENABLED`. `kek` is one of `absent`, `malformed`, or `valid`.

The route is available with the gate either enabled or disabled. Only the reported gate category changes. Every non-`GET` request, every other path, and the existing lease behavior continue through the original service path unchanged.

## KEK validation and disclosure posture

The existing Acceptance Vault validator was exported under the descriptive name `readAcceptanceVaultKek` and reused directly by the readiness route. There is no second parser or weaker check. A value is `valid` only when it passes the existing Base64URL-without-padding syntax check and decodes to exactly 32 bytes.

The temporary decoded byte array used for categorization is zeroed in a `finally` block. The response never returns a binding value, fragment, hash, length, derived fingerprint, or the name or state of any binding other than the three approved categories. Malformed input is collapsed to the single `malformed` category.

## Files changed

### Product code

- `artifacts/nabuflow-runtime-worker/src/acceptance-vault-durable-object.ts`
  - exports the existing KEK parser/validator without changing its validation or import behavior.
- `artifacts/nabuflow-runtime-worker/src/acceptance-provisioner-index.ts`
  - defines the readiness path;
  - handles exact `GET` requests before the gate/auth/lease service;
  - returns the exact three-field response;
  - zeroes the temporary decoded KEK bytes.

### Tests

- `artifacts/nabuflow-runtime-worker/test/acceptance-readyz.test.ts`
  - covers the six gate-by-KEK matrix cases;
  - asserts the exact response fields and categories;
  - asserts binding names and values are absent;
  - proves disabled lease and non-`GET` behavior remains typed `404 acceptance_lease_not_found`;
  - proves enabled unauthenticated lease and non-`GET` behavior remains typed `401 acceptance_unauthorized`.

No contract, provider adapter, durable job, queue, route other than the additive readiness route, Fly surface, or Artifact v1/layer code was changed.

## Acceptance evidence

| Gate     | KEK input | Expected category | Result |
| -------- | --------- | ----------------- | ------ |
| disabled | absent    | `absent`          | PASS   |
| disabled | malformed | `malformed`       | PASS   |
| disabled | valid     | `valid`           | PASS   |
| enabled  | absent    | `absent`          | PASS   |
| enabled  | malformed | `malformed`       | PASS   |
| enabled  | valid     | `valid`           | PASS   |

Additional contract results:

- focused readiness suite: 8/8 PASS;
- response binding-name/value leak matches: 0;
- disabled lease path: byte-stable typed `404 acceptance_lease_not_found`;
- enabled unauthenticated lease path: byte-stable typed `401 acceptance_unauthorized`;
- non-`GET` requests to the readiness pathname retain the corresponding original service behavior.

## Standing gates

| Gate                                                  | Result                                      |
| ----------------------------------------------------- | ------------------------------------------- |
| Frozen install with `--prefer-offline`                | PASS; 765.2 seconds, zero downloads         |
| Worker focused readiness suite                        | PASS, 8/8                                   |
| Complete Worker suite                                 | PASS, 28 files / 219 tests                  |
| Worker typecheck                                      | PASS                                        |
| Worker lint                                           | PASS                                        |
| Root typecheck                                        | PASS                                        |
| Root lint                                             | PASS                                        |
| Format check                                          | PASS                                        |
| `git diff --check`                                    | PASS                                        |
| Fast stability profile on clean implementation commit | PASS, 15 pass / 0 warn / 0 fail             |
| Release stability profile                             | 18 pass / 0 warn / 3 environmental failures |
| Exact-base parity for the three failed release rows   | PASS                                        |

The release profile's only failures were:

1. `api-release-extended`;
2. `api-account-billing-history`;
3. `web-build` during dynamic prerender, after the bundle and static prerender completed.

A fresh detached worktree at the exact base reproduced those same three database-dependent failure rows with local PostgreSQL unavailable at `127.0.0.1:5432`. No additional row failed and no readiness assertion failed. Replit's database-backed merge gate remains authoritative.

The disposable exact-base worktree and its dependency tree were removed after the evidence was captured.

## Manifest and production declaration

No `package.json`, lockfile, Wrangler manifest, binding declaration, hostname, route, or provider configuration changed. The pristine frozen install succeeded with zero downloads and left the lockfile unchanged.

Nothing was deployed. Production remains inert. The staging triple lock and every existing authenticated lease surface are untouched.

## Evidence artifact

- Branch evidence: `docs/gateway-doorman-2b-ix-b9-1-evidence-20260812T090115Z-run01.json`
- Durable authority copy: `C:/Users/mus_1/Documents/Mustaflow AI/docs/gateway-doorman-2b-ix-b9-1-evidence-20260812T090115Z-run01.json`
- Evidence SHA-256: `6a871c8ae38b85329efa3c840c4781ec6095889130036fd5bb515870ba0e2326`

No credential was requested, created, read, written, or used during this micro-slice.
