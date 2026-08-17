# Wall #16 delivery — Sandbox-local runtime health probing

Branch: `codex/runtime-health-probe-rpc-boundary`

Base: `0f4d0bae405af3c21bf4ab758256b8bfc925f950`

Implementation commit: `4f9af0cefa351c498ee30f837ee29bc75b17789f`

Production remained frozen throughout this commission. No reconciliation was invoked, no runtime
or route was mutated, no Worker was deployed, no publish was retried, and no new surface or spend
was created.

## Outcome

The fork resolved to a shared health-probe defect, not a preview-specific health contract.

A running preview is designed to serve HTTP exactly like both production slots: its process binds
`0.0.0.0`, listens on manifest `servicePort`, and must return HTTP 200–399 at manifest `healthPath`.
Only an explicitly stopped preview with no process is a valid non-serving healthy-idle state.

Project 51's v3 preview repair proved that contract at start: `tenant-service` passed the Sandbox
SDK's internal `waitForPort(8080, /healthz, 200..399)` and the durable start job succeeded. The
subsequent reconciliation call observed the same process as running, then recorded three
`health_transport` failures only 347 ms and 345 ms apart—far inside the named 5,000 ms timeout.
The shipped sanitized trail did not retain a lower-level exception class, so “refused,”
“unresolvable,” “connection lost,” response-stream transfer, and cancellation propagation cannot
be distinguished honestly after the fact.

The source boundary was nevertheless decisive. Start readiness performs its port watch inside the
Sandbox object. Availability sent a `Request` into `containerFetch` over RPC and received a
`Response` back over RPC. Cloudflare documents Request, Response, and AbortSignal as supported RPC
types, so this report does not make the stronger—and unsupported—claim that serialization alone
failed. Instead, the repair removes the entire observed cross-context HTTP-primitive path: the
outer Worker sends a small plain input envelope, and `NabuflowSandbox` constructs, dispatches,
consumes, and classifies the bounded local health request before returning a plain sanitized result.

The exact local target is now `http://localhost:<servicePort><healthPath>`; for Project 51 that is
`http://localhost:8080/healthz`. Preview, blue, and green retain the same HTTP criterion.

Primary provider references consulted:

- Cloudflare Workers RPC, including Request/Response and AbortSignal serialization:
  https://developers.cloudflare.com/workers/runtime-apis/rpc/
- Cloudflare Containers/Sandbox container interface:
  https://developers.cloudflare.com/containers/container-class/

## Phase 1 findings

The durable diagnosis is in:

- `docs/wall-16-runtime-health-probe-phase1.md`
- `docs/wall-16-runtime-health-probe-phase1-evidence-20260817T192846Z.json`

### Preview contract

`CloudflareSandboxBackend.start()` is common to preview, blue, and green. It starts the exact
manifest command under the fixed process identity `tenant-service`, sets `HOST=0.0.0.0` and
`PORT=<manifest servicePort>`, then waits for the manifest health path. Preview's data plane also
requires a `running` descriptor and forwards to the declared port. A running preview therefore
cannot be declared healthy merely at process/identity level.

### Precise failure shape

The strongest supported classification for request
`09f16134-1e91-4d37-80b4-df480ee8f949` is: **prompt, non-timeout exception on the
cross-context `containerFetch` health path after process lookup succeeded**. No HTTP status was
returned. The raw class is irrecoverable from the deliberately allowlisted trail, and this report
does not invent it.

### Production contrast

The premise that green had proven production HTTP while preview structurally could not is false.
Green's durable start also passed its process-local port watch and later hit the same
`health_transport` class. The preserved Wall #12 public probes did not return tenant HTTP 200.
Both roles can pass local start readiness; both used the faulty later probe boundary.

## Implementation

### Sandbox-owned probe

`NabuflowSandbox.probeRuntimeHealth()` now owns:

- integer flooring and positive validation of the named timeout;
- service-port and health-path validation;
- `AbortSignal` and `Request` construction inside the Sandbox Durable Object;
- local `http://localhost:<port>` dispatch through `containerFetch`;
- response-body disposal;
- the existing typed result taxonomy: `ready`, `health_status`, `health_pre_dispatch`,
  `health_timeout`, or `health_transport`;
- omission of messages, bodies, exception text, stack data, and raw transport detail.

`CloudflareSandboxBackend.availability()` performs the process check, then calls this method with a
plain `{ servicePort, healthPath, timeoutMs }` envelope. An outer RPC failure remains a sanitized
`health_transport`; an HTTP response—including a 503—is a definite `health_status` with only its
numeric status retained.

### Reconciliation v4 identity

The control contract now advertises `runtime-reconciliation-v4` and requires that semantics
literal for new reconciliation requests. V1–v3 remain advertised as historical capability
markers. The control endpoint continues to namespace its idempotency key by the current semantics
version, so the v3 inconclusive terminal cannot shadow the corrected observation. Request and
response shapes are unchanged.

The replay regression plants both v2 and v3 terminal recordings, invokes the same caller key under
v4, then replays it. V4 proceeds once and exactly one durable repair job exists.

## Regression coverage

- The outer health call receives a JSON-round-trippable value envelope, never a Request.
- The Sandbox-local request is exactly `http://localhost:8080/healthz` and owns its abort signal.
- A sub-minimum/floored timeout produces `health_pre_dispatch` with zero dispatches.
- A thrown private transport message yields only `{ cause: "health_transport", status: null }`.
- HTTP 503 remains `{ cause: "health_status", status: 503 }`.
- The exact Wall #16 running/process-identity-present signature resolves in one ready observation
  for preview, production blue, and production green.
- Explicit stopped-preview healthy-idle behavior remains green.
- The v3 false-terminal repair cases, both production slots, durable trail persistence,
  read-only audit surface, sanitization, reschedule caps, and replay/no-duplicate tests remain green.

## Verification

| Gate                                             | Result                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------ |
| `pnpm install --offline --frozen-lockfile`       | PASS; all 21 projects, 1,899 resolved, 1,870 reused, **0 downloaded**, 7m 8.9s |
| Contract typecheck                               | PASS                                                                           |
| Contract lint                                    | PASS                                                                           |
| Contract suite                                   | PASS; 20 files / 187 tests                                                     |
| Runtime Worker typecheck                         | PASS                                                                           |
| Runtime Worker lint                              | PASS                                                                           |
| Runtime Worker suite                             | PASS; 36 files / 274 tests                                                     |
| Focused availability suite after final additions | PASS; 1 file / 12 tests                                                        |
| Repository-wide typecheck                        | PASS                                                                           |
| Repository-wide lint                             | PASS                                                                           |
| Prettier on every changed source/evidence file   | PASS                                                                           |
| `git diff --check`                               | PASS                                                                           |

The full offline install exceeded five minutes but advanced continuously, completed without a
download, and showed no disk-saturation behavior. Free space after verification was 78,393,794,560
bytes.

## Changed files

### Worker source

- `artifacts/nabuflow-runtime-worker/src/runtime-backend.ts` — adds the Sandbox-local bounded
  health RPC and replaces outer Request/Response RPC probing with a plain value envelope.

### Worker regressions

- `artifacts/nabuflow-runtime-worker/test/runtime-availability.test.ts` — local-dispatch,
  pre-dispatch, transport sanitization, definite-status, exact captured signature, and all-slot
  coverage.
- `artifacts/nabuflow-runtime-worker/test/control-worker.test.ts` — v2/v3 shadow isolation and v4
  receipt expectation.
- `artifacts/nabuflow-runtime-worker/test/artifact-layers-control.test.ts` — v4 feature
  advertisement.

### Contract source

- `lib/tenant-runtime-contracts/src/control-schemas.ts` — current semantics literal becomes v4.
- `lib/tenant-runtime-contracts/src/constants.ts` — v4 added to advertised control features.

### Durable authority

- `docs/wall-16-runtime-health-probe-phase1.md`
- `docs/wall-16-runtime-health-probe-phase1-evidence-20260817T192846Z.json`
- `docs/wall-16-runtime-health-probe-delivery-report.md`
- `docs/wall-16-runtime-health-probe-delivery-evidence-20260817T194641Z.json`

## Change declarations

- Manifest changes: **none**.
- `pnpm-lock.yaml`: **unchanged**.
- Frozen-lockfile proof: PASS with zero downloads.
- Control wire shape: **unchanged**.
- Control semantic literal/feature: **declared** addition of `runtime-reconciliation-v4`.
- Artifact v1/layers: unchanged.
- Tenant egress: unchanged.
- Fly: byte-untouched.
- Secret values: none read, written, logged, or included in evidence.
- Production: frozen; zero deploys, reconciliations, runtime mutations, publishes, or route probes.

## Post-ship ladder (not run in this branch delivery)

Replit ships platform-side first. Worker source changed, so deployed-surface parity plus the named
marker remain required before any mutation. Only then may the v4 ladder resume: preview, blue,
green, truthful route probe, page/health/database proofs, smoke rewire, scratch-worktree hygiene,
flip-day addendum, and Phase 1 closure.

## INCIDENTAL FINDINGS

1. The workspace root's `.git` entry is an empty directory, not a usable repository control file.
   The commission used a fresh exact-base worktree and did not alter the root stub.
2. The earlier wording “green's probe answered 200” conflated the start-time port check with the
   published route. Green's start check passed HTTP 200–399; preserved public-route evidence did
   not show tenant HTTP 200. The Phase 1 authority note corrects that record.
3. The full offline install took 7m 8.9s, longer than the earlier five-minute expectation, but it
   was continuously advancing, downloaded zero packages, completed cleanly, and left 78.39 GB free.
   No machine choke or disk saturation was observed.
4. A whole-tree at-rest scan found three pre-existing synthetic payment-secret-pattern literals in
   the verified base, at `artifacts/api-server/src/tests/preview-security.test.ts` (two) and
   `artifacts/nabuflow-runtime-worker/scripts/trusted-build-staging-smoke.ts` (one). This branch
   introduces zero matching lines/blobs, and no matched text is repeated in this report. The base
   fixtures should be reconstructed at runtime under the standing synthetic-secrets rule in a
   separately scoped cleanup.

## Handoff boundary

This report is the final tracked documentation change on the branch. The exact final remote tip is
verified after push and reported in the handoff; the implementation commit above is the immutable
code/evidence anchor. No merge, deploy, marker, reconciliation, probe, or publish is part of this
delivery.
