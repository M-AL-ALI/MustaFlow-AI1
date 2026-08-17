# Wall #17 — front-door delivery report

Status: **branch-only delivery; stop at Replit ship boundary**

Branch: `codex/published-route-front-door`

Verified base: `ad8f3d02e5c8fdce67f065215eeea1e9be0cd22e`
Final remote tip: reported in the handoff because a commit cannot contain its own SHA.

Production remained frozen for the entire commission. No reconciliation, second publish, rollback,
runtime restart, route mutation, Worker deployment, new public surface, Fly action, secret read, or
new spend occurred.

## Outcome

Wall #17 was the Wall #16 RPC-boundary defect at the public route's second call site. The v4
reconciler already judged green healthy from inside the Sandbox Durable Object. The public route
still built an abort-bearing `Request` in the outer Worker and called `sandbox.containerFetch`
across custom Workers RPC. That transport failed before the 10-second bound; the corrected v4
judge then truthfully returned healthy, leaving the old route to mislabel the boundary failure as
`published_runtime_unavailable`.

The branch removes the second thermometer:

- the public route uses `CloudflareSandboxBackend.availability`, the same v4 process-plus-health
  judge as reconciliation, before serving;
- the real app request crosses the Durable Object's native Fetch boundary, preserving streamed
  request bodies, streamed responses, and SSE;
- the Sandbox constructs the tenant request, `AbortSignal`, timeout, and `containerFetch` call in
  its own execution context;
- only the v4 availability value envelope crosses custom RPC;
- forwarding failures cross the native Fetch boundary as a bounded allowlisted classification,
  never as exception text, a response body, or raw transport detail;
- a failed forwarding attempt is re-judged by the same v4 judge. Only a genuinely unhealthy
  runtime reaches the existing governed durable recovery mutation;
- a healthy runtime with a forwarding-boundary failure now returns typed
  `published_upstream_transport_unavailable`, not a misleading runtime terminal;
- deterministic pre-dispatch failures are typed `published_upstream_pre_dispatch_failed`, are
  non-retryable, and dispatch zero container requests;
- timeout remains typed `published_upstream_timeout`;
- published typed errors now carry a bounded sanitized `evidence` object (`stage`, `cause`, numeric
  status or null, allowlisted error class or null) plus their existing request ID;
- sanitized system evidence is now request-correlated. Messages, stacks, bodies, and raw transport
  detail remain absent.

The route's availability observation remains side-effect-free. A read does not repair state.
Durable recovery is still the single existing idempotent governed mutation, so replay/coalescing and
the bounded recovery cap are unchanged.

## Phase-1 findings

The full reconstruction is in:

- `docs/wall-17-front-door-phase1-diagnosis-20260817T205220Z.md`
- `docs/wall-17-front-door-phase1-evidence-20260817T205220Z.json`

The decisive captured inputs were:

| Path       | Request ID                             |    Duration | Old terminal                    | Correct v4 input                  |
| ---------- | -------------------------------------- | ----------: | ------------------------------- | --------------------------------- |
| `/`        | `7db94653-907b-4625-bfa7-4b921c3ec446` | 1.5798454 s | `published_runtime_unavailable` | green process running; health 200 |
| `/healthz` | `ea59ce09-d0f5-4073-92f8-0b50faadf4b3` | 1.9245001 s | `published_runtime_unavailable` | green process running; health 200 |

Both durations were well inside the 10-second timeout and therefore pin the old `request` /
`transport` branch. The exact exception class was not recoverable per request because shipped logs
were not request-correlated; the report does not promote the consistent `TypeError` hypothesis to
an observation.

The successful v158 publication at `2026-08-16T17:54:51-08:00` is the last authoritative route
mutation. It targeted production green. Route records contain no availability snapshot or
last-modified field, so this was neither stale availability state nor a slot mis-target. Governed
v4 repairs correctly changed runtime descriptors/capability bindings without touching the route.

## Regression coverage

- The exact two Wall #17 request IDs and paths now return real streamed bytes through the native
  Fetch boundary under a `ready` v4 verdict.
- Blue and green routes both use the shared judge and serve through the new boundary.
- Preview primary remains invalid on the published production route and fails closed before
  availability or forwarding.
- A private transport exception produces only the allowlisted class `TypeError`, is correlated to
  the request ID, does not expose its message, creates no recovery job while v4 says healthy, and is
  never called `published_runtime_unavailable`.
- A malformed/zero forwarding budget is a non-retryable pre-dispatch terminal with zero container
  dispatches and no retry storm.
- The existing large streamed request, SSE response, all HTTP methods, header/cookie sanitization,
  WebSocket fail-closed posture, blue/green switching, recovery coalescing, active-job attach, and
  three-generation cap remain green.
- Existing runtime-availability tests continue to pin in-context health construction, timeout,
  transport sanitization, status classification, and all-slot v4 behavior.
- The full Worker suite preserves replay/no-duplicate behavior.

## Changed files

### Worker source

- `artifacts/nabuflow-runtime-worker/src/runtime-backend.ts` — adds the private native-Fetch
  forwarding boundary, Sandbox-local request/timeout construction, allowlisted forwarding failure
  taxonomy, and parser.
- `artifacts/nabuflow-runtime-worker/src/published-data-plane.ts` — adopts the shared v4 judge,
  sends app traffic through native Fetch, preserves governed recovery semantics, correlates
  evidence, and adds bounded terminal evidence.

### Regressions

- `artifacts/nabuflow-runtime-worker/test/published-data-plane.test.ts` — exact Wall #17 fixtures,
  blue/green/preview route coverage, native boundary streaming, sanitization, truthful transport
  classification, and zero-dispatch pre-dispatch coverage.

### Durable authority

- `docs/wall-17-front-door-phase1-diagnosis-20260817T205220Z.md`
- `docs/wall-17-front-door-phase1-evidence-20260817T205220Z.json`
- `docs/wall-17-front-door-delivery-report.md`
- `docs/wall-17-front-door-delivery-evidence-20260817T211722Z.json`
- `docs/wall-17-front-door-delivery-20260817T211722Z.sha256`

## Verification

| Gate                                 | Result                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------- |
| Exact base and clean branch creation | PASS — `ad8f3d02e5c8fdce67f065215eeea1e9be0cd22e`                           |
| Frozen offline install               | PASS — 21 projects; 1,899 resolved; 1,870 reused; **0 downloaded**; 6m32.1s |
| Focused route + availability battery | PASS — 2 files / 31 tests                                                   |
| Tenant runtime contracts             | PASS — 20 files / 187 tests                                                 |
| Runtime Worker                       | PASS — 36 files / 278 tests                                                 |
| Runtime Worker typecheck + lint      | PASS                                                                        |
| Repository-wide typecheck            | PASS                                                                        |
| Repository-wide lint                 | PASS                                                                        |
| Production Worker bundle dry-run     | PASS — 1,453.62 KiB / 295.54 KiB gzip; expected bindings only               |
| Changed-file Prettier                | PASS                                                                        |
| `git diff --check`                   | PASS                                                                        |
| Manifest / lockfile diff             | NONE                                                                        |

The repository-wide Prettier command has the inherited failure documented under incidental
findings. None of its three files is changed by this branch.

Free space after the frozen install and verification: 74,991,353,856 bytes (69.84 GiB).

## Change declarations

- Manifest changes: **none**.
- `pnpm-lock.yaml`: **unchanged**; SHA-256
  `B8DA847F2D8C8B30A5A84BFB362AB1176D86FD70DAFE972EDC6FCA9A684BD54E`.
- Frozen-lockfile proof: PASS with zero downloads.
- Additive published data-plane wire change: typed error responses may now carry the bounded
  sanitized `evidence` object. Existing fields and codes remain intact.
- Reconciliation semantics identities: **unchanged**; v4 remains authoritative.
- Control endpoint and durable-job wire formats: unchanged.
- Artifact v1 and layers: unchanged.
- Tenant egress: unchanged.
- Fly: byte-untouched and operationally untouched.

## Ship boundary and remaining finale

This delivery stops before merge, Replit publish, production Worker parity deploy, marker, ladder,
public canary proof, database proof, smoke-target rewire, or scratch-worktree cleanup. After Replit
ships, Worker source has changed, so the standing parity deploy and marker ritual applies before the
truthful probe. Only then may the previously commissioned finale proceed.

## INCIDENTAL FINDINGS

1. **No metadata-only route-record read surface.** The route contract has mutation methods but no
   signed read lookup. Cloudflare Data Studio rejects `_cf_KV` inspection with `SQLITE_AUTH`, so a
   verbatim current route record cannot be captured under READS NEVER WRITE. A future signed
   metadata-only route read would close this observability gap; it is reported, not built here.
2. **Inherited request-correlation gap.** Prior published failure logs omitted the public request
   ID. This branch fixes new records, but historical Wall #17 error classes cannot be recovered.
3. **Inherited repository format drift.** Repository-wide `pnpm run format:check` still reports
   `wrangler.build.production.jsonc`, `wrangler.pantry.production.jsonc`, and
   `wrangler.runtime.production.jsonc`. All three are byte-unchanged from the verified base. This is
   the same inherited finding recorded in Walls #15 and #16; it remains out of scope.
4. **Dry-run cleanup safety interception.** The command guard rejected two attempts to recursively
   remove the validated dry-run directory. The three generated files were instead removed through
   the approved patch mechanism; the empty ignored directory contains zero files and no evidence.
5. **Cloudflare dashboard session weather.** The inherited Data Studio tab timed out once. A clean
   authenticated tab loaded and reproduced the `_cf_KV` authorization restriction without a
   mutation.
