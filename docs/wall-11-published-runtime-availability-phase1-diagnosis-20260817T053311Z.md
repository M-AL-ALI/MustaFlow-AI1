# Wall #11 Phase 1 — published runtime availability diagnosis

## Frozen-state result

Phase 1 remained read-only. Repository main and the clean source checkout are exact
`0223d0f5b2067bc7a08476b5d7d7336427c0deff`. There was no rollback, second publish,
runtime restart, route mutation, new surface, spend, or Fly action.

The durable evidence is
`docs/wall-11-published-runtime-availability-phase1-evidence-20260817T053311Z.json`.

## Exact shipped route path

`handlePublishedDataPlaneRequest` resolves the hostname, loads its route record, and targets the
deterministic Sandbox Durable Object named by `route.sandboxIdentity`. It does not dial a stored IP
address: the container application assigns neither IPv4 nor IPv6. For Project 51 the target is
`nrf-ab8e18ef4ebebedd-p51-production-green`, instance
`13b17870f2689a1764da0742b5da883e8dba084fec666fa53c21408768dda286`, private port
`8080`.

Before forwarding, the route requires all of the following:

1. identity namespace, Project 51, production role, and blue/green slot match the route;
2. route role is production and `activeSlot` matches the parsed identity slot;
3. the durable runtime exists and its descriptor says `running`;
4. descriptor and manifest revisions match the route revision;
5. descriptor and manifest ports equal route port `8080`;
6. the saved process ID resolves and the Sandbox process reports `running` or `starting`.

The request is then sent through `sandbox.containerFetch(request, 8080)`. Response headers must
arrive inside `PUBLISHED_UPSTREAM_HEADER_TIMEOUT_MS = 10_000`. A timeout becomes typed
`published_upstream_timeout` unless a stopped-process recovery was scheduled. A non-timeout
exception is caught without its class, message, or stage being persisted and is collapsed to
`published_runtime_unavailable`.

The green failure is after the durable route/runtime metadata boundary. Activation itself read the
same runtime record and accepted its identity, slot, revision, status, and port. No later operation
changed them. The repeated public result is not `published_route_not_found`, identity conflict, or
`published_upstream_timeout`; it is the generic non-availability class at the process/port hop.

The shipped code has one forensic defect that prevents a stronger claim: process-not-running with
an already terminal/unavailable recovery claim and a non-timeout `containerFetch` exception both
produce the identical code, and the latter discards the exception entirely. Raw DO state, app logs,
and SSH are unavailable without changing the frozen system. Therefore the exact exception class
cannot be recovered after the fact. That information was destroyed by the production catch block;
this is an evidence-backed observability finding, not an invented diagnosis.

## Adoption versus fresh start

The v158 promotion used the deterministic green identity and deterministic production-publish
operation keys from the earlier failed attempt. Ensure/promote/start attached to their existing
operations. The start operation replayed its prior successful terminal. The unchanged green
identity and underlying Cloudflare instance before and after publish prove adoption; this publish
did not run materialization, process creation, or `waitForPort` again.

That differs materially from a fresh start:

- a fresh start persists `starting` and clears readiness;
- materializes the exact committed sealed artifact;
- kills old tenant processes;
- starts the fixed `nabuflow-tenant` process with `HOST=0.0.0.0` and `PORT=8080`;
- waits up to 30 seconds, polling every 250 ms, for the manifest health path to return HTTP
  `200..399` on port 8080;
- only then persists a new process ID, `running`, and a new `readyAt`.

Adoption retained the earlier process ID, `readyAt`, and durable `running` descriptor without a
new port-readiness observation. Route activation validated that durable descriptor but did not
validate the actual process or health port. This is the handoff gap.

## What green is doing

Cloudflare reports the green VM `Running` in `iad22`. At capture it used 340.52 MiB memory,
1.41% one-minute CPU (1.3% five-minute; 1.2% fifteen-minute), received 531.1 Kbps, transmitted
8.6 Kbps, and used 678.53 MB disk. It also reports three `VMStopped` errors at provider timestamp
`2026-08-16T04:09:42`. The application summary reports three active instances but only two
healthy, even though its instance table labels preview, blue, and green all `Running`.

Those metrics prove the VM is active and exchanging private traffic. They do not prove the tenant
process is listening on 8080. The only governed product-path evidence for that listener is the
failed `containerFetch` boundary above. Direct confirmation is blocked because:

- Container Observability is disabled, so there is no application stdout/stderr trail;
- SSH is disabled; enabling it requires a Worker config change and redeploy;
- Cloudflare Data Studio rejects raw Control DO `_cf_KV` reads with `SQLITE_AUTH`;
- the existing signed control status route reconciles and writes stopped/error truth, so invoking
  it would not be a read-only forensic action.

None of those controls was weakened or enabled during Phase 1.

## Clock drift ruled out

No route-availability decision subtracts `readyAt`, provider time, or lab time. `readyAt` is used
only as opaque input to the recovery-operation identity. The ten-second header deadline is a
duration signal. Provider operation followers use a monotonic clock. Wall-clock timestamps are
used for evidence, audit display, retention, and durable lease/deadline ownership outside the
request's readiness decision. The observed lab/provider clock drift cannot cause this failure.

## Blue is rollback standby, not an orphan

The production blue/green authority explicitly preserves the prior release while the inactive
slot is promoted and activated. The staging rehearsal asserts “Previously active blue runtime
remains intact,” and rollback reactivates that exact release without rebuilding. Successful
promotion code never stops or destroys `previousRelease`; cleanup targets only a failed candidate.

Blue is therefore deliberate warm rollback standby. It is currently `Running` in `iad10` at
244.84 MiB, 0.24% one-minute CPU, 33.06 Kbps receive, 0.82 Kbps transmit, and 625.27 MB disk. Its
continued resource use is designed behavior and must not be cleaned as an orphan.

## Phase 2 repair shape

One shared availability assessment must replace the split meanings of “running.” It must verify
the saved process and the real manifest health path/port under named bounds, be used by route
activation and public forwarding, and preserve a sanitized stage/cause when it fails. Adopted and
fresh candidates, blue and green, must pass the identical live readiness contract. A stale
adopted terminal may attach only after the current candidate passes that contract; otherwise the
existing durable runtime-start recovery chassis owns rehydration. No request owns restart
execution.

The public terminal remains typed and truthful: recovering while a durable restart owns progress,
timeout only when the health/forwarding bound expires, unavailable only for a classified
non-timeout failure. User-facing responses disclose no raw provider exception.

## INCIDENTAL FINDINGS

1. **Application health and instance labels disagree.** Wrangler reports `active: 3` and
   `healthy: 2`, while both CLI and dashboard rows label all three instances `Running`. This is
   exactly why VM lifecycle cannot stand in for app readiness. Reported; not changed.
2. **Wrangler instance-info failure crashes noisily on Windows.** Passing the green instance ID to
   `wrangler containers info` returned application-not-found, then emitted a libuv
   `UV_HANDLE_CLOSING` assertion. The command was read-only and made no change. Reported; not fixed.
3. **A later project stream revision appeared.** The browser diagnostic stream recorded revision
   `163` while visible production/test authority remains v158. No action was taken because it is
   unrelated to the frozen published runtime.
4. **Route/process forensics remain structurally incomplete.** Route values lack a signed
   metadata-only read surface, raw DO KV is blocked, and container application logs are disabled.
   The repair will persist sanitized availability stages; it will not open SSH or public surfaces.
