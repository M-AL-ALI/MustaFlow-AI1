# Wall #16 Phase 1 — the health contract is HTTP; the probe is on the wrong side of RPC

Captured: 2026-08-17T19:28:46.794Z

Verified base: `0f4d0bae405af3c21bf4ab758256b8bfc925f950`

Production state: frozen; no reconciliation, runtime, route, deployment, or publish mutation was made.

## Verdict

Preview is not a process-only runtime. A running preview has the same manifest-defined serving
contract as both production slots: the tenant process binds `0.0.0.0`, listens on the manifest
`servicePort` (Project 51: `8080`), and returns HTTP 200–399 at the manifest `healthPath` (Project
51: `/healthz`). Only an **explicitly stopped** preview with no process is a valid non-serving idle
state.

The Wall #16 preview process met that contract during the governed v3 repair. `start()` launched
`tenant-service` with `HOST=0.0.0.0` and `PORT=8080`; its internal `waitForPort(8080, /healthz,
200..399)` passed, and the durable job then recorded `process-started` and `succeeded`. Twenty
seconds later, reconciliation's separate health path failed three times in about 692 ms total.
Those attempts cannot be five-second health timeouts.

The difference is probe placement. Start readiness executes the port watch inside the Sandbox
object. Availability instead constructs an `AbortSignal.timeout(5000)` and `Request` in the outer
Worker, passes that request through the Sandbox RPC stub to `containerFetch`, and receives a
`Response` back across RPC. Cloudflare documents Request, Response, and AbortSignal as RPC-supported,
so the evidence does **not** justify blaming serialization specifically. The process lookup
succeeds first; the following cross-context call throws promptly and is collapsed to the
allowlisted `health_transport` cause. The current trail preserves no raw error class, so it cannot
honestly distinguish connection refused, name resolution, connection loss, response-stream
transfer, cancellation propagation, or another RPC-path failure. What it does prove is narrower
and sufficient: this was a non-timeout exception on the `containerFetch` RPC path after a running
process had been observed.

The fix fork is therefore the serving/probe path, not a laxer preview verdict: run the bounded HTTP
request, consume its response, and create its abort signal inside `NabuflowSandbox`; send only plain
typed request metadata and a sanitized result across RPC. Keep the same HTTP health contract for
preview, blue, and green.
Mint `runtime-reconciliation-v4` because corrected observation semantics must not replay a v3
terminal.

## 1. Actual preview serving contract

The repair-started preview uses the common `CloudflareSandboxBackend.start()` path:

- command: manifest `startCommand` (`node src/index.js` for Project 51);
- working directory: sealed release app root;
- host: `0.0.0.0`;
- port: manifest `servicePort`, `8080` here;
- platform process identity: `tenant-service`;
- readiness: HTTP GET of manifest `healthPath`, `/healthz` here, accepted only at 200–399;
- readiness bound: 30,000 ms.

The product authority makes that contract explicit. Generated Node apps bind `0.0.0.0`, honor
`PORT`, default to 8080, and implement a database-independent `/healthz`. The preview data plane
also refuses to forward unless the descriptor is `running`, then forwards to the manifest port.
There is no separate process-only serving definition for preview.

Availability currently targets the same identity, port, and path for every slot, but builds a GET
request against a placeholder HTTPS origin in the outer Worker and passes the request and resulting
response through `sandbox.containerFetch(request, servicePort)` RPC. The Sandbox/Containers
forwarding implementation ultimately maps a request to the container TCP port; its documented
local form is `http://localhost:<port>`. The corrected path will construct and consume that local
request inside the Sandbox object, returning only its sanitized verdict.

## 2. Transport failure shape

Request `09f16134-1e91-4d37-80b4-df480ee8f949` recorded:

| Attempt | Timestamp                | Process | Health cause       | HTTP status |
| ------: | ------------------------ | ------- | ------------------ | ----------- |
|       1 | 2026-08-17T15:57:14.535Z | running | `health_transport` | null        |
|       2 | 2026-08-17T15:57:14.882Z | running | `health_transport` | null        |
|       3 | 2026-08-17T15:57:15.227Z | running | `health_transport` | null        |

The typed inconclusive terminal was persisted at `15:57:15.382Z`. Attempt spacing was 347 ms and
345 ms, far below the named 5,000 ms health timeout. Request construction did not take the
`health_pre_dispatch` branch. The exact persisted classification is therefore **prompt,
non-timeout `containerFetch` RPC exception**. The shipped sanitization intentionally discarded the
raw class; refused versus unresolvable versus connection-lost is not reconstructable and is not
invented here.

## 3. Designed preview health criterion

The authority and shipped paths agree:

- a `running` preview is a serving runtime and must pass manifest HTTP health;
- an explicitly `stopped` preview may be healthy-idle with no process and no active capability;
- the preview data plane forwards authenticated traffic to the declared service port only for a
  `running` descriptor;
- a damaged/error preview cannot be declared healthy merely because a process identity exists.

Consequently, `runtime-reconciliation-v4` will not introduce a per-slot relaxation. It preserves
the one real role distinction already present: explicit stopped preview = non-serving idle.

## 4. Green contrast

Green does not establish that production structurally serves while preview cannot. It establishes
the same two-stage pattern:

- its durable recovery passed the common start path through `process-started` at
  `2026-08-17T05:14:39.158Z` and persisted success;
- the later availability call produced the same `health_transport` class;
- the public route did not return tenant HTTP 200 in the preserved Wall #12 evidence.

Thus the commissioning contrast hypothesis is falsified: both production and preview can answer
the process-local start readiness check; both are vulnerable to the later outer-Worker RPC probe.
The repair belongs to their shared availability probe.

## Scope selected for Phase 2

1. Add one Sandbox-owned bounded HTTP health RPC returning only typed sanitized fields.
2. Keep `health_pre_dispatch`, `health_timeout`, `health_transport`, and `health_status` distinct.
3. Remove the signal-bearing Request from the outer Worker-to-Sandbox RPC boundary.
4. Exercise the exact Wall #16 trail against the corrected preview verdict and pin blue/green to
   the identical HTTP criterion.
5. Preserve stopped-preview idle semantics, replay/no-duplicate behavior, and trail sanitization.
6. Mint/advertise `runtime-reconciliation-v4` so v3 durable outcomes cannot shadow the repair.

## INCIDENTAL FINDINGS

- The workspace root's `.git` entry is an empty directory rather than a usable repository
  control file. Phase 1 used the clean exact-base checkout at
  `.work-runtime-parity-5a9d7a92-20260817T1840Z`. This is pre-existing and was not altered.
- The prior phrase “green's probe answered 200” is too broad. The evidence proves green's
  **start-time port wait** accepted HTTP 200–399; it does not prove the published route returned
  tenant HTTP 200. This report corrects the record without changing production.

## Durable evidence

- `docs/wall-16-runtime-health-probe-phase1-evidence-20260817T192846Z.json`
- source trigger SHA-256:
  `c236d350d718404457abefd36f5a477bcde7c52e339ec68c13874badd14d12c6`
- Wall #12 source SHA-256:
  `58cc3b3d02df774263004782a21d17550341fd6e038cdbc9cf22a2fa7005dbee`
