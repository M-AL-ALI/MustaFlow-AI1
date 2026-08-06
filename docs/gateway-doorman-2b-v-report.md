# Gateway Doorman slice 2b-v — published-app routing

Status: **staging acceptance passed; branch intentionally unpushed pending review**

- Branch: `codex/gateway-published-routing`
- Audited base: `f5c24ca1c204b5eed196ef891c284b9a302e6249`
- Original expected main: `cbb98ff41ff7b0b3812a159c5cd24e16117ce7fe`
- Staging Worker: `nabuflow-runtime-staging`
- Accepted runtime: `nrf-e919a75364398a44-p801935457-production-blue`
- Tenant port: `8080`
- Final evidence SHA-256: `b54beaa888d416a96447bc3035e3b2e29680cb67069eba582218c4d3362cd9bc`

No production configuration, production secrets, DNS, Fly resource, project 27, or tenant-runtime provider selection was changed. `TENANT_RUNTIME_PROVIDER` remains unset in production. No application or route from this slice serves production traffic.

## Pre-flight and branch isolation

Fresh remote inspection found main at `f5c24ca1`, one commit beyond the expected `cbb98ff4`:

| Commit     | Date                 | Author    | Classification                                   |
| ---------- | -------------------- | --------- | ------------------------------------------------ |
| `f5c24ca1` | 2026-08-06 17:12:39Z | MustaFlow | `Trigger Ora Stability Gate`; gate ceremony only |

`cbb98ff4` is an ancestor of `f5c24ca1`, and both commits have the identical tree `489ef2325fdb7af2ed287430e30416ab50816d26`. The movement therefore contained no source change. The dedicated worktree was clean, cut directly from `f5c24ca1`, and did not use or edit an Ora branch/worktree. The audited pre-flight was accepted before Phase B.

## Design implemented

### Authoritative routing registry

`ControlDurableObject` is authoritative. Each mapping is stored durably under `route:<hostname>` as a strict `RouteRecord`. The signed control plane exposes:

- `POST /_nabuflow/control/v1/routes/:hostname/activate`
- `DELETE /_nabuflow/control/v1/routes/:hostname`

Both endpoints use the existing HMAC envelope, nonce replay protection, idempotency handling, strict request bodies, audit records, and compare-and-swap guards. Activation validates that the referenced runtime is currently running and matches project, revision, port, role, and slot. Deactivation requires the expected manifest revision and sandbox identity. Storage-persistence tests reconstruct the Durable Object against the same storage and prove the route survives, then prove deletion is immediately visible to another instance.

This slice deliberately performs an authoritative Durable Object lookup for every published request and has no isolate cache. Registry miss returns structured `404 published_route_not_found` without runtime or registry details. Deactivation updates the Durable Object's local read-through state synchronously, so invalidation is immediate.

### Production-blue invariant

The original task's `production-primary` wording conflicted with the 2b-i contract. Work stopped until the corrected direction arrived. This slice accepts only:

```text
role=production, activeSlot=blue, identity=...-production-blue
```

`green`, `primary`, and every other role/slot combination are rejected. No 2b-i identity constant, role/slot invariant, or invariant test was changed. Blue/green switching remains a later slice.

### Staging hostname simulation

Two staging-only paths were used without DNS changes:

1. The exact workers.dev hostname was registered temporarily so real browsers and an independent founder device could load anonymously.
2. Harness-only virtual hostnames used a detached signed override. It is triple-locked by the exact enabled flag, deployment namespace `staging`, and exact workers.dev host. The signature binds method, path/query, actual host, override host, timestamp, and a replay-protected nonce. Override headers are stripped before tenant forwarding, no new secret was introduced, and WebSocket use with an override is rejected.

Production configuration is inert by default because the enable flag and staging host are absent outside this staging Worker configuration.

### Published data plane

Anonymous requests for a registered hostname resolve to the `production-blue` runtime and use the same streaming data plane as preview:

- every HTTP method and streamed request/response bodies;
- SSE passed through without buffering;
- WebSocket via the original inbound upgrade request;
- tenant service port `8080`, not 3000;
- no grant, preview session, login, or per-asset database lookup.

HTTP hygiene removes platform cookies, control/override headers, hop-by-hop headers, Cloudflare-internal forwarding headers, and caller-supplied `X-Forwarded-*`, then rebuilds trusted forwarding metadata. Application `Authorization` and non-platform application cookies remain available. Tenant `Set-Cookie` targeting `.mustaflow.com` or `.mustaflow.app` is suppressed.

## Standing operational rules adopted

Two propagation controls are now permanent acceptance rules and are encoded in the staging harness:

1. After any Worker deploy or secret rotation, acceptance waits for at least **20 consecutive successful signed probes against one active Worker version**. A first successful probe is insufficient.
2. Expected-valid staging control and cleanup operations use an eight-attempt bounded exponential backoff (500 ms up to 5 seconds) for `invalid_signature` propagation stragglers and retryable 502/503/504 responses. Replay probes resend the exact signed request and nonce. Persistent failures still fail the run and trigger cleanup.

Secret changes used one atomic `wrangler secret bulk` containing both the control token and preview public key. Secrets were generated in process memory, supplied over stdin, kept only in the process environment, and never printed, persisted, or committed.

Final propagation measurement:

| Signal                  | Result                                       |
| ----------------------- | -------------------------------------------- |
| First probe             | `401 invalid_signature`; green counter reset |
| Sustained window        | 20 consecutive `200` responses               |
| Total probes            | 21                                           |
| Window duration         | 21,906 ms                                    |
| Stable Worker version   | `1c7bf959-d92b-45b5-ad38-4acf0f18ba55`       |
| Lab/Worker clock offset | `-11,811,572 ms` (known lab clock drift)     |

## Control-plane acceptance

### Route activation

| Probe                              | HTTP | Code/result                |
| ---------------------------------- | ---: | -------------------------- |
| Unsigned                           |  401 | `unauthorized`             |
| Tampered signature                 |  401 | `invalid_signature`        |
| Expired signature                  |  401 | `expired_signature`        |
| Production-green registration      |  400 | `production_blue_required` |
| Valid production-blue registration |  200 | route stored               |
| Exact signed replay                |  409 | `replay_detected`          |

### Route removal

| Probe                             | HTTP | Code/result                             |
| --------------------------------- | ---: | --------------------------------------- |
| Unsigned                          |  401 | `unauthorized`                          |
| Tampered signature                |  401 | `invalid_signature`                     |
| Expired signature                 |  401 | `expired_signature`                     |
| Valid strict-body CAS removal     |  200 | route removed                           |
| Exact signed replay               |  409 | `replay_detected`                       |
| Request immediately after removal |  404 | `published_route_not_found` in 79.38 ms |

The temporary workers.dev self-registration was also removed with `200`; its immediate anonymous request returned structured `404 published_route_not_found` in 61.93 ms.

## Preview-lock regression

The preview handler itself is byte-for-byte unchanged. Its focused local suite remains 12/12 green, and the live Worker auth regression produced:

| Preview probe                                                 | HTTP | Code/result                                                                                        |
| ------------------------------------------------------------- | ---: | -------------------------------------------------------------------------------------------------- |
| Missing grant/session                                         |  401 | `preview_auth_required`                                                                            |
| Tampered grant                                                |  401 | `invalid_preview_grant`                                                                            |
| Expired grant                                                 |  401 | `preview_grant_expired`                                                                            |
| Wrong-key forged grant                                        |  401 | `invalid_preview_grant`                                                                            |
| Valid one-use ES256 grant                                     |  302 | Secure session cookie minted; grant removed from redirect                                          |
| Grant replay                                                  |  409 | `preview_grant_replayed`                                                                           |
| Redeemed session against intentionally absent preview runtime |  503 | `preview_runtime_unavailable`, proving session auth succeeded rather than opening anonymous access |

Published routing does not weaken or bypass the preview prefix; control routing also retains precedence over both data planes.

## Published request/response matrix

All published probes were anonymous. The tenant received no NabuFlow credential.

| Probe               | HTTP | Body/result                                                                                                       | Observed end-to-end time |
| ------------------- | ---: | ----------------------------------------------------------------------------------------------------------------- | -----------------------: |
| Unknown hostname    |  404 | `published_route_not_found`                                                                                       |                        — |
| GET `/echo`         |  200 | 0 bytes; SHA-256 `e3b0c442…b855`                                                                                  |                 75.49 ms |
| POST `/echo`        |  200 | 9 bytes; SHA-256 `a77b4988…e13e`                                                                                  |                 95.20 ms |
| PUT `/echo`         |  200 | 8 bytes; SHA-256 `c57dcd98…2a75`                                                                                  |                 71.55 ms |
| DELETE `/echo`      |  200 | 11 bytes; SHA-256 `61de7372…84bd`                                                                                 |                 71.01 ms |
| Large POST `/large` |  200 | 2,818,048 bytes; expected and returned SHA-256 `85270f60908672771be82fbae91fd354f9545129c0913f1978a4b18844faa05a` |                        — |
| SSE `/sse`          |  200 | first event at 58.34 ms; second at 1,559.12 ms; 1,500.78 ms separation proves unbuffered delivery                 |                        — |
| WebSocket `/socket` |  101 | echo round-trip                                                                                                   |                        — |

Captured harness WebSocket transcript:

```text
upgrade: 101 Switching Protocols
sent:     anonymous-published-websocket
received: echo:anonymous-published-websocket
```

Captured real-browser transcript on both lab Chrome and founder phone:

```text
WebSocket echo: echo:browser-anonymous-published-echo
```

The 71–95 ms figures include the network, authoritative registry lookup, sandbox dispatch, and tenant response; they are not pure Durable Object RPC timings. This per-request authoritative lookup is intentionally the likely bottleneck for this slice. Before adding a read-through isolate cache, instrument pure lookup latency and retain explicit activation/deactivation invalidation.

## Header, cookie, and credential hygiene

| Assertion                                   | Result                                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Platform cookies                            | `__session` and `mustaflow_auth` removed; tenant saw only application cookie `theme=dark` |
| Caller `X-Forwarded-*`                      | injected values removed                                                                   |
| Trusted forwarding                          | rebuilt with gateway-observed client, `https`, and simulated published hostname           |
| App `Authorization`                         | `Bearer tenant-app-token` preserved                                                       |
| Control/idempotency/override headers        | absent upstream                                                                           |
| Tenant `Set-Cookie: Domain=.mustaflow.com`  | suppressed; response exposed no `Set-Cookie`                                              |
| Container credential-like environment names | `none`                                                                                    |
| Browser page HTTP cookie                    | `none` on lab Chrome and independent founder phone                                        |

### WebSocket PG-2 exception

Workerd requires the original upgrade request for `sandbox.wsConnect()`. Mutating or rebuilding it loses upgrade internals. Authentication/routing occurs before connection, but the original handshake can carry platform cookies or caller forwarding headers to the tenant. This staging-only exception remains a **hard production gate** for preview and published traffic.

The production risk is greater on `*.apps.mustaflow.com` because it shares the `mustaflow.com` registrable cookie scope. PG-2 must evaluate a separate registrable apex for published apps, as well as platform changes or a proven upgrade-preserving sanitization mechanism. No production traffic should be authorized before that is resolved.

## Browser evidence index

1. [`docs/evidence/gateway-doorman-2b-v/published-anonymous-page.png`](evidence/gateway-doorman-2b-v/published-anonymous-page.png) — controlled lab Chrome checkpoint. It visibly shows anonymous access, browser-native WebSocket echo, production-blue identity, port 8080, and `HTTP cookie received: none`. Chrome's controlled screenshot excludes browser chrome.
2. [`docs/evidence/gateway-doorman-2b-v/founder-phone-anonymous-published.jpg`](evidence/gateway-doorman-2b-v/founder-phone-anonymous-published.jpg) — accepted independent founder-device evidence with the workers.dev hostname visible. Served at `2026-08-06T18:20:16.371Z` and matched scratch identity `nrf-e919a75364398a44-p801935457-production-blue`.

The founder device had no lab state and required no grant, session, login, or credential. It satisfies the fresh independent browser-evidence requirement in place of the lab Incognito capture.

## Cleanup and billing

| Cleanup check                              | Result                                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| Simulated hostname unregister              | 200; immediate 404                                                                  |
| workers.dev self-host unregister           | 200; immediate structured 404                                                       |
| Scratch stop                               | 200                                                                                 |
| Scratch destroy                            | 200                                                                                 |
| Signed status after destroy                | 404 `runtime_not_found`                                                             |
| Cloudflare instance record                 | `inactive`; location `-`; version `-`                                               |
| Aggregate health immediately after cleanup | transient `active: 1`, `assigned: 0` reporting lag                                  |
| Aggregate health settled                   | `active: 0`, `assigned: 0`, `healthy: 5`; eight consecutive samples over 85 seconds |
| Current workers.dev root                   | 404 `published_route_not_found`                                                     |

`wrangler containers list`/application metadata reports `instances: 5` and `max_instances: 5`; this is configured capacity/tombstone accounting, not five running tenants. The instance listing is authoritative for identity state and shows every record inactive.

The authenticated Cloudflare billable-usage view showed these current account-wide Container rows:

| Billing row                              |         Current usage | Charge |
| ---------------------------------------- | --------------------: | -----: |
| Container vCPU                           |       63 vCPU-seconds |  $0.00 |
| Container egress, North America + Europe |                  1 GB |  $0.00 |
| Container memory                         |  509 (GiB-second row) |  $0.00 |
| Container disk                           | 4.08k (GB-second row) |  $0.00 |

Each row states `No usage cost in this billing period`. These are account-wide cumulative readings, not attribution to only this scratch. Zero ongoing cost is established by the destroyed runtime, inactive/no-location/no-version record, settled `active: 0`/`assigned: 0`, and zero current Container charges.

## Stops and operational findings

1. **Contract conflict:** the original `production-primary` requirement contradicted the immutable role/slot invariant. Work stopped. The approved correction made production-blue the sole active slot and preserved the contract.
2. **Secret-version propagation:** an early run authenticated with the new atomic-bulk secret, then later hit an old version and returned `401 invalid_signature`; cleanup initially hit the same response. Work stopped after safe recovery. This produced the permanent sustained-green and bounded-retry rules above.
3. **Replay straggler after a green window:** a later run passed 20/20 probes but one exact replay still reached a stale version. Bounded cleanup already recovered; exact-request replay was then added to the same bounded policy. The final run passed after one initial reset plus 20 consecutive successes.
4. **Browser capture boundary:** controlled Chrome could prove the page and WebSocket but could not capture its address bar or attach to the Incognito window. Work paused with the scratch held. Accepted independent founder-phone evidence closed the requirement.

## Verification

| Check                      | Result                                                                                                                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts                  | 7 files, 86 tests passed                                                                                                                                                                                        |
| Worker                     | 5 files, 39 tests passed                                                                                                                                                                                        |
| Focused preview regression | 12 tests passed                                                                                                                                                                                                 |
| Worker typecheck           | passed                                                                                                                                                                                                          |
| Worker lint                | passed                                                                                                                                                                                                          |
| Repository typecheck       | passed                                                                                                                                                                                                          |
| Repository lint            | passed                                                                                                                                                                                                          |
| Ora fast stability gate    | 14 groups passed, 1 known Windows baseline import failure; the failing `ora-fresh-start.test.tsx` loads `file:///logo.png`, while all 122 assertions in that group pass. No Ora file is touched by this branch. |

No `package.json` or `pnpm-lock.yaml` changed, so the mandatory clean frozen-lockfile proof rule is not triggered. The worktree's initial `pnpm install --frozen-lockfile` completed successfully with pinned pnpm 10.26.1.

## Recommendation

The published-host routing design works as intended in staging: anonymous hostname routing, full HTTP methods, streaming, SSE, original-request WebSockets, persistent CAS registry, immediate invalidation, preview isolation, and tenant credential isolation all passed on a real production-blue scratch.

Before any real users or production routing:

1. **PG-2 must be resolved.** Treat it as a hard launch blocker, especially because a mustaflow.com published hostname shares cookie scope with the platform. A separate registrable apex is the strongest candidate to evaluate.
2. **Instrument pure registry RPC latency** before choosing cache TTLs. If a read-through isolate cache is later introduced, activation/deactivation must carry explicit invalidation and preserve the immediate-404 guarantee.
3. **Build publish-lifecycle wiring and blue/green switching** in their dedicated slices. Keep green rejected until switching is transactional and observable.
4. **Keep atomic secret bulk, 20-probe sustained green, active-version verification, and bounded control retry as non-optional deployment procedure.** A first successful request is not propagation proof.
5. **Retain the staging override's triple lock** and ensure its enabling variables never enter a production Worker configuration.

No foundational redesign is needed before the next staging slice. Production authorization must nevertheless remain blocked on PG-2, real hostname/DNS planning, lifecycle wiring, and blue/green switching.
