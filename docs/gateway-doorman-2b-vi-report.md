# Gateway Doorman slice 2b-vi — Capability Vault foundation

Status: **staging acceptance passed; branch intentionally unpushed pending review**

- Branch: `codex/gateway-capability-vault`
- Audited base: `ddea7ada1ca4ea242b1f041c233cd41718c19b37`
- Staging Worker: `nabuflow-runtime-staging`
- Accepted Worker version: `69c694a6-d6c5-4326-acb7-102bffe4ec3e`
- Accepted scratch: `nrf-e919a75364398a44-p808522657-production-blue`
- Tenant port: `8080`
- Final evidence SHA-256: `9ff8b651f90aead7557fc8a65cbad31d5dd2a58018f79f5b4d6f8b69515b5947`

No production configuration, production secret, DNS, Fly resource, project 27, provider selection, Stripe integration, database broker, or real tenant credential was touched. `TENANT_RUNTIME_PROVIDER` remains unset in production, so production retains the existing Fly behavior. The deployed changes and all acceptance traffic were confined to the workers.dev staging Worker and scratch identities.

## Pre-flight and isolation

The branch and its dedicated worktree were created directly from the verified remote main tip `ddea7ada`. Existing merged and stale Ora worktrees were left untouched. No Ora source file is changed by this slice. The source diff is limited to `lib/tenant-runtime-contracts` and `artifacts/nabuflow-runtime-worker`, plus this report.

## Approved design and implementation

### Vault storage and key handling

Each project has a distinct `CapabilityVaultDurableObject`, addressed by the trusted Worker as `project:<projectId>`. The Worker binding is not exposed to tenant code or the public data plane. Cloudflare Durable Object encryption at rest is supplemented with an application envelope:

- AES-256-GCM;
- a fresh random 96-bit nonce for every envelope;
- AAD binding the ciphertext to envelope version, project, provider, capability name, revision, and key ID;
- a versioned KEK (`v1`) held only in the Worker secret `CLOUDFLARE_CAPABILITY_VAULT_KEK_V1`;
- an explicit non-secret active key ID, `NABUFLOW_CAPABILITY_VAULT_ACTIVE_KEY_ID=v1`;
- plaintext working bytes zeroed after encryption/decryption use.

The `v2` Wrangler Durable Object migration adds `CapabilityVaultDurableObject` without altering the existing sandbox or control objects. This is PG-1 groundwork, not a claim that rotation is complete: dual-key decrypt, rewrap, cutover, rollback, and old-key retirement remain future work.

### Capability-request contract

The tenant-facing path is an unsigned, bounded intent sent to the virtual host:

```text
POST https://doorman.staging.nabuflow.internal/v1/invoke
```

Its strict payload contains version, capability `{provider,name}`, action, request ID, optional requested project, and at most 32 KiB of JSON input. It cannot contain a credential, runtime identity, container ID, or signing authority.

The sandbox outbound handler is the trust transition. Cloudflare supplies the platform `containerId`; the trusted Worker reverse-resolves that ID to the active `nrf-...` runtime, adds the caller binding, serializes a strict invocation, and signs it with the existing control-plane HMAC format. The signed form is accepted only at:

```text
POST /_nabuflow/capability/v1/invoke
```

The public endpoint requires the timestamp, nonce, body hash, signature, and matching idempotency key. It applies existing nonce replay protection and clock-skew limits. A valid request asks the vault to act; neither the credential nor the vault address is returned. The only implementation in this foundation is `nabuflow-harness/echo`, which decrypts a benign per-project canary and returns a one-way proof that the doorman acted.

Provision and revoke are signed, audited control mutations:

```text
PUT    /_nabuflow/control/v1/capabilities/:projectId/:provider/:name
DELETE /_nabuflow/control/v1/capabilities/:projectId/:provider/:name
```

They retain HMAC authentication, nonce replay protection, idempotency, strict bodies, revision checks, and the Worker-level typed-error boundary.

### Tenant-isolation wall

`containerId` is the sole caller-security root. Before vault invocation, the trusted layer verifies all of the following:

1. the platform-supplied container ID has an active reverse binding;
2. that binding equals the invocation's `nrf-` runtime identity;
3. the identity parses under the configured staging namespace and regenerates the same sandbox container ID;
4. the corresponding runtime record exists, is running, and matches identity, project, role, and slot;
5. any requested project equals the verified caller project.

The per-project vault independently parses the bound runtime identity and checks both invocation ownership and stored-record ownership before decrypting. Cross-tenant responses deliberately collapse to the same `403 capability_tenant_mismatch`, whether the foreign capability exists or not.

Bindings are created only after a successful runtime start and are removed on stop, destroy, failure cleanup, and inactive status reconciliation. A stopped runtime therefore cannot retain capability authority.

### Design limits and open gates

- PG-1 remains open. The versioned envelope/key ID is the foundation for rotation, not a complete rotation protocol.
- PG-2 is untouched and remains a hard gate before preview or published WebSockets face production traffic.
- Project is the isolation boundary. Organization-shared capability policy is deferred.
- The echo capability proves the machinery without introducing any downstream provider or real credential.
- No production publish lifecycle, Fly path, provider switch, or blue/green switch is part of this slice.

## Standing deployment and retry rules exercised

The staging control token, preview public key, and new vault KEK were updated together with one atomic `wrangler secret bulk`. Values existed only in process/session memory and were neither printed nor persisted. Acceptance waited for a sustained window rather than the first success:

| Signal                                       | Result                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| Required window                              | 20 consecutive signed `200` probes                                     |
| Total probes                                 | 68                                                                     |
| Sustained-green elapsed time                 | 73,180.77 ms                                                           |
| Active Worker version                        | `69c694a6-d6c5-4326-acb7-102bffe4ec3e`                                 |
| Lab/Worker clock offset                      | `-11,811,814 ms` (known Windows lab drift; derived from Worker `Date`) |
| Signed retry events after green in final run | 0                                                                      |

The harness permanently applies an eight-attempt bounded exponential backoff to every expected-valid signed staging operation: control, cleanup, ordinary harness probes, and staging host overrides. It retries only transient/retryable status classes and unexpected authentication failures such as `invalid_signature` or `invalid_staging_host_override`. Negative tests that intentionally expect authentication failure never use this recovery path.

## Capability acceptance matrix

### Provision and valid invocation

| Probe                                       | HTTP | Result                                                               |
| ------------------------------------------- | ---: | -------------------------------------------------------------------- |
| Active runtime/container binding            |  200 | correct production-blue identity; active platform container ID       |
| Provision caller project's echo capability  |  200 | revision stored under key ID `v1`                                    |
| Provision foreign project's echo capability |  200 | separate project vault, key ID `v1`                                  |
| Tenant unsigned intent through virtual host |  200 | Worker bound and signed it; `actedBy: capability-vault`              |
| Echo payload                                |  200 | `{message: "doorman-acted", projectId: 808522657}` plus 64-hex proof |

### Signed capability endpoint authentication

| Probe                     | HTTP | Code/result                        |
| ------------------------- | ---: | ---------------------------------- |
| Unsigned                  |  401 | `unauthorized`                     |
| Tampered body/signature   |  401 | `invalid_signature`                |
| Expired timestamp         |  401 | `expired_signature`                |
| Valid signed request      |  200 | echo capability acted successfully |
| Exact signed replay       |  409 | `replay_detected`                  |
| WebSocket/upgrade request |  426 | `capability_upgrade_not_supported` |

## Isolation failure-mode matrix

| Failure mode                                          |      HTTP | Evidence/result                                                                    |
| ----------------------------------------------------- | --------: | ---------------------------------------------------------------------------------- |
| Tenant A requests tenant B's existing capability      |       403 | `capability_tenant_mismatch`                                                       |
| Tenant A requests an absent capability under tenant B |       403 | byte-identical response to the existing-capability case, using the same request ID |
| Missing container binding                             |       403 | `capability_runtime_unbound`                                                       |
| Binding points at a non-running runtime               |       403 | `capability_runtime_inactive` in unit coverage                                     |
| Stale invocation after runtime stop                   |       403 | `capability_runtime_unbound`                                                       |
| Tenant attempts to reach the vault directly           |       520 | sandbox response `Origin is disallowed`; no Durable Object surface reachable       |
| Capability/action policy mismatch                     |       403 | vault-side `policy_rejected` coverage                                              |
| AAD changed to another project or revision            | rejection | AES-GCM decryption fails in vault tests                                            |
| Vault reconstructed over the same DO storage          |   success | encrypted record survives restart; ownership checks remain active                  |

The existing and absent foreign-project responses were identical in the live staging run:

```json
{
  "ok": false,
  "code": "capability_tenant_mismatch",
  "message": "The requested capability scope does not match the caller",
  "retryable": false,
  "requestId": "capability-cross-project-8071fb17-5749-48f9-ae0c-5391a288a52c"
}
```

## Preview regression

The same one-use grant and session behavior shipped in 2b-iv remains intact:

| Probe                                                         | HTTP | Code/result                                                                                           |
| ------------------------------------------------------------- | ---: | ----------------------------------------------------------------------------------------------------- |
| Missing grant/session                                         |  401 | `preview_auth_required`                                                                               |
| Tampered grant                                                |  401 | `invalid_preview_grant`                                                                               |
| Expired grant                                                 |  401 | `preview_grant_expired`                                                                               |
| Wrong-key forged grant                                        |  401 | `invalid_preview_grant`                                                                               |
| Valid one-use ES256 grant                                     |  302 | Secure session cookie minted; grant removed from redirect                                             |
| Grant replay                                                  |  409 | `preview_grant_replayed`                                                                              |
| Redeemed session against intentionally absent preview runtime |  503 | `preview_runtime_unavailable`, demonstrating successful session auth without weakening preview access |

## Published regression

The accepted scratch used `production-blue` at port 8080. The virtual published host was `slice-2b-vi-808522657.apps.mustaflow.com`; the exact workers.dev self-registration used by the harness was also removed afterward.

### Route-control regression

| Probe                                        | HTTP | Code/result                              |
| -------------------------------------------- | ---: | ---------------------------------------- |
| Activate unsigned                            |  401 | `unauthorized`                           |
| Activate tampered                            |  401 | `invalid_signature`                      |
| Activate expired                             |  401 | `expired_signature`                      |
| Attempt production-green                     |  400 | `production_blue_required`               |
| Activate valid production-blue               |  200 | route stored                             |
| Activate replay                              |  409 | `replay_detected`                        |
| Deactivate unsigned                          |  401 | `unauthorized`                           |
| Deactivate tampered                          |  401 | `invalid_signature`                      |
| Deactivate expired                           |  401 | `expired_signature`                      |
| Deactivate valid CAS body                    |  200 | route removed                            |
| Deactivate replay                            |  409 | `replay_detected`                        |
| Immediate request after removal              |  404 | `published_route_not_found` in 91.53 ms  |
| workers.dev request after self-route removal |  404 | `published_route_not_found` in 106.40 ms |

### Anonymous data plane

| Probe               | HTTP | Concrete result                                                                                                   |
| ------------------- | ---: | ----------------------------------------------------------------------------------------------------------------- |
| Unknown hostname    |  404 | `published_route_not_found`                                                                                       |
| GET `/echo`         |  200 | 0 bytes; SHA-256 `e3b0c442...b855`                                                                                |
| POST `/echo`        |  200 | 9 bytes; SHA-256 `a77b4988...e13e`                                                                                |
| PUT `/echo`         |  200 | 8 bytes; SHA-256 `c57dcd98...2a75`                                                                                |
| DELETE `/echo`      |  200 | 11 bytes; SHA-256 `61de7372...84bd`                                                                               |
| Large POST `/large` |  200 | 2,818,048 bytes; expected and returned SHA-256 `85270f60908672771be82fbae91fd354f9545129c0913f1978a4b18844faa05a` |
| SSE `/sse`          |  200 | first event at 75.75 ms; second at 1,577.02 ms, proving unbuffered delivery                                       |
| WebSocket `/socket` |  101 | `anonymous-published-websocket` → `echo:anonymous-published-websocket`                                            |

## Hygiene and redaction inspection

| Assertion                                            | Result                                                                                                           |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Container credential-like environment names          | `none`                                                                                                           |
| Vault direct reachability from tenant                | blocked with `Origin is disallowed`                                                                              |
| Platform/control/override headers on HTTP data plane | stripped                                                                                                         |
| Caller-supplied `X-Forwarded-*`                      | stripped and rebuilt from trusted metadata                                                                       |
| App `Authorization`                                  | `Bearer tenant-app-token` preserved                                                                              |
| App cookie                                           | only `theme=dark` observed upstream; platform cookies absent                                                     |
| Tenant `Set-Cookie: Domain=.mustaflow.com`           | suppressed; response exposed no `Set-Cookie`                                                                     |
| Vault ciphertext                                     | does not contain the benign canary; unique nonce per envelope                                                    |
| Audit schema                                         | request/time/method/endpoint/stage/outcome/project/role/slot/status only; never body, key, envelope, or material |
| Worker unexpected-error logs                         | request ID, stage, and error class only                                                                          |

Permanent tests serialize the DO record and audit collection and reject matches for the KEK, test canary, container ID, ciphertext/envelope terms, credential, and secret. Source inspection found no logging call that receives envelope plaintext, KEK material, ciphertext, a request body, or a capability proof. The top-level boundary logs only the error type, not the error message or object.

## Cleanup and billing

| Cleanup check                      | Result                                  |
| ---------------------------------- | --------------------------------------- |
| Simulated published route removed  | 200; immediate structured 404           |
| workers.dev self-route removed     | 200; immediate structured 404           |
| Scratch stop                       | 200; runtime `stopped`                  |
| Binding after stop                 | 200; `active:false`, `containerId:null` |
| Invocation after stop              | 403 `capability_runtime_unbound`        |
| Caller-project echo vault revoked  | 200                                     |
| Foreign-project echo vault revoked | 200                                     |
| Scratch destroy                    | 200                                     |
| Status after destroy               | 404 `runtime_not_found`                 |
| Final Cloudflare instance record   | `inactive`; location `-`; version `-`   |

`wrangler containers list` still labels configured capacity as `LIVE INSTANCES = 5`; the per-instance listing is authoritative for runtime state and shows every record inactive. The accepted scratch tombstone `nrf-e919a75364398a44-p808522657-production-blue` has neither a location nor a running version.

The authenticated Cloudflare billable-usage view for August 2026 showed total cost, projected cycle cost, and average daily cost all at **$0.00**. Current account-wide container rows were 63 vCPU-seconds, 1 GB egress, 509 on the memory row, and 4.08k on the disk row; every row showed `$0.00` and “No usage cost in this billing period.” These are cumulative account readings, not attribution to this one scratch. Zero ongoing cost is established by the destroyed runtime, inactive/no-location/no-version record, and zero current container charges.

## Stops and operational findings

1. **Expected-valid staging host override hit a propagation straggler.** The first acceptance run had already passed its sustained-green start window, then the immediate post-unregister probe returned `401 invalid_staging_host_override` instead of the expected 404. The run stopped and performed full bounded cleanup: route removal recovered, stop 200, binding inactive, stale call 403, both vaults revoked, destroy 200, and post-destroy 404. Evidence SHA-256: `425fb2eaf1f0d54f773d87e83d8678de994c5326b960a097f632050d1fa9292d`. The approved permanent amendment extended bounded retry to **all** expected-valid signed staging requests, including signed host overrides. The fresh final run then passed from the beginning.
2. **Ora gate reported the documented Windows-only import baseline.** The fast gate collected `ora-fresh-start.test.tsx` through `OraSidebar`, whose root-absolute `/logo.png` import reaches Vitest as `file:///logo.png`; Windows path conversion rejects it before that file registers tests. The focused reproduction produced the identical TypeError. Vitest 4.1.6 was physically present and ran immediately before and after; pnpm's trailing `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "vitest" not found` is therefore the recursive wrapper's misleading report of the same nonzero child, not a second missing-binary failure. Prior repository reports record the identical Windows-only baseline, while Linux passes. No Ora source was changed.

## Verification

| Check                         | Result                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Tenant runtime contracts      | 8 files, 92 tests passed                                                                                                 |
| Runtime Worker                | 8 files, 51 tests passed                                                                                                 |
| Repository typecheck          | passed                                                                                                                   |
| Repository lint               | passed                                                                                                                   |
| Ora fast stability gate       | 13 groups passed; one dirty-tree warning before commit; only the known Windows `file:///logo.png` import baseline failed |
| Focused baseline reproduction | identical `ora-fresh-start.test.tsx` TypeError; Vitest 4.1.6 present and runnable before/after                           |

No `package.json` or `pnpm-lock.yaml` changed. The permanent clean frozen-lockfile proof rule is therefore not triggered for this branch.

## Recommendation

The project-scoped vault, trusted container binding, signed internal invocation, replay protection, independent vault-side ownership checks, stale-binding invalidation, direct-vault denial, redacted auditing, and credential-free container all work as designed in staging. The foundation does not need redesign before the next staging capability slice, but it is not ready for real credentials yet.

Before real users or downstream credentials:

1. **Close PG-1 with an explicit rotation protocol.** Add dual-key decrypt, background rewrap, cutover/rollback state, key retirement evidence, loss recovery, and an operator runbook. Never overwrite the only working KEK.
2. **Use a capability-specific internal signing key or scoped signing primitive before broadening the surface.** Reusing the control-plane HMAC is safe within this staging trust model but gives the trusted Worker broad authority; narrower blast radius is preferable once real providers exist.
3. **Add provider-specific policy and SSRF defenses before any broker.** Each provider must have strict methods, paths, input/response bounds, timeout, concurrency/rate limits, response redaction, and egress allowlists. Do not add a generic arbitrary-URL capability.
4. **Keep container ID as the only caller-security root.** Never accept runtime identity, project, vault address, or a bearer capability from tenant-controlled input without verifying it against the active platform binding.
5. **Preserve anti-enumeration and redaction as release gates.** Add live audit-query checks once an operator read surface exists; current proof is schema/source inspection plus serialized-record tests.
6. **Track the custom `ContainerProxy` dispatch workaround.** It is needed because the pinned sandbox/container SDK registry path does not provide the required handler context reliably. Re-evaluate it on SDK upgrades and keep the integration regression.
7. **Keep atomic secret bulk, active-version verification, 20-probe sustained green, and bounded retry for every expected-valid signed staging operation.** A single authentication straggler remains platform weather; a persistent bounded-window failure remains a real stop.
8. **PG-2 remains a hard production gate.** This slice does not change the original-request WebSocket cookie/forwarding exception from preview and published data planes.
