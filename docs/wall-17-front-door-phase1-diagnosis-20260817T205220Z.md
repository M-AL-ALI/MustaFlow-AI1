# Wall #17 — front-door phase 1 diagnosis

Captured: 2026-08-17T20:52:20Z (lab clock; provider timestamps remain event-order authority)

Production baseline: `ad8f3d02e5c8fdce67f065215eeea1e9be0cd22e`
Production state: frozen throughout. No reconciliation, publish, rollback, restart, route mutation,
deployment, new surface, Fly action, or new spend occurred.

## Verdict

The two captured 503s are the **same RPC-boundary disease at a second call site**. Wall #16/ship
14 moved the reconciliation health probe into `NabuflowSandbox.probeRuntimeHealth`, where the
`Request`, `AbortSignal`, `containerFetch`, response consumption, and timeout classification all
live in the Sandbox Durable Object and only a sanitized value crosses RPC. The public serving path
did not adopt that boundary. It still created an abort-bearing `Request` in the outer Worker and
called `sandbox.containerFetch(request, port)` directly across Workers RPC.

After that forwarding call threw, the route called the corrected v4 availability judge. Green
answered `ready` with HTTP 200. Recovery therefore correctly refused to heal a runtime that was
already healthy and returned `unavailable`; the public handler converted that outcome into
`published_runtime_unavailable`. The application was healthy behind the boundary, but the front
door could not transport the request across its old boundary.

This was not a stale availability snapshot: no such snapshot exists in the route record. It was
not a slot mis-target: the successful v158 publication bound the route to production green, and
every frozen post-publish read identifies green as the published runtime. The exact current Durable
Object route value cannot be read through a metadata-only operator surface; Cloudflare Data Studio
rejects `_cf_KV` reads with `SQLITE_AUTH`. That observability gap does not alter the deterministic
code-path verdict.

## End-to-end serving path

1. `handlePublishedDataPlaneRequest` resolves the public hostname and reads the route.
2. It validates namespace, project, production role, and `activeSlot` against the route identity.
3. It reads the runtime and validates manifest revision and service port against the route.
4. The route has no health snapshot. Its strict record has only `hostname`, `projectId`, `role`,
   `activeSlot`, `manifestRevision`, `servicePort`, and `sandboxIdentity`.
5. A stored non-running descriptor schedules governed recovery; a running descriptor continues.
6. `requireRuntimeProcess` asks `CloudflareSandboxBackend.status` for process state only.
7. The outer Worker sanitizes headers, creates a request with a 10,000 ms abort signal, then calls
   `sandbox.containerFetch` directly across RPC.
8. A non-timeout throw records generic `request` / `transport` evidence and calls
   `recoverIfRuntimeUnavailable`.
9. That helper invokes the v4 judge. Green returns `ready`, `health`, HTTP 200.
10. Because healing a ready runtime would be dishonest, the helper returns `unavailable`, which is
    mapped to typed 503 `published_runtime_unavailable`.

The route and reconciler disagreed only because the route had a second, pre-v4 transport
thermometer before consulting the shared judge.

## Captured requests and judgment inputs

| Path       | Request ID                             |              HTTP Date |   Wall time | Result                              | Deterministic branch                                                               |
| ---------- | -------------------------------------- | ---------------------: | ----------: | ----------------------------------- | ---------------------------------------------------------------------------------- |
| `/`        | `7db94653-907b-4625-bfa7-4b921c3ec446` | `2026-08-17T17:23:11Z` | 1.5798454 s | 503 `published_runtime_unavailable` | pre-10s forwarding exception; `request` / `transport`; v4 `ready` / `health` / 200 |
| `/healthz` | `ea59ce09-d0f5-4073-92f8-0b50faadf4b3` | `2026-08-17T17:23:11Z` | 1.9245001 s | 503 `published_runtime_unavailable` | pre-10s forwarding exception; `request` / `transport`; v4 `ready` / `health` / 200 |

Shared state: hostname `platform-canary.apps.mustaflow.com`; project 51; published v158; slot
`green`; identity `nrf-ab8e18ef4ebebedd-p51-production-green`; port 8080; runtime `running`;
process identity present; capability `bound`; manifest
`prod-a8940c976f1cf943d03c5bccd52e3bdb5b1ea51b8d56e228`; v4 health 200 at
`2026-08-17T17:22:20.735Z`.

The precise thrown class cannot be attached to either request ID from shipped evidence. The generic
system log lacked the public request ID and the 503 carried no route trail. Timing pins the
`request` / `transport` branch; prior captures make `TypeError` consistent, but asserting it here
would be inference. This missing correlation is itself a finding.

## Route state provenance

The last authoritative route mutation was the successful v158 publication at provider time
`2026-08-16T17:54:51-08:00`. It adopted deterministic production green and completed activation.
No later publish, rollback, reconciliation, or manual route mutation occurred while frozen.

The v4 repairs did not refresh a route-side health record because none exists. They corrected only
runtime descriptors and capability bindings: preview unchanged/healthy/bound; blue restored and
rebound/healthy; green unchanged/healthy/bound. That separation is correct under **READS NEVER
WRITE**.

## Phase-2 consequence

The route must use the same v4 availability judge and an in-context forwarding boundary rather
than a custom RPC `containerFetch` request. Availability remains read-only; recovery remains a
governed durable mutation. Route terminals need bounded sanitized evidence correlated to the public
request ID. Reconciliation terminal identities are untouched, so no semantics revision is needed.

## INCIDENTAL FINDINGS

1. Durable route records lack a metadata-only operator read. Data Studio rejected both
   `PRAGMA table_info('_cf_KV')` and `SELECT ... FROM _cf_KV` with `SQLITE_AUTH`.
2. Published failure logs were not request-correlated, preventing exact per-503 class recovery.
3. The inherited Cloudflare Data Studio tab timed out; a clean authenticated tab reproduced the
   authorization restriction. No mutation occurred.
