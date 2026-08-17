# Wall #15 Phase 1 — reconciliation decision fork

Captured: 2026-08-17  
Base: `ba6656489f77433eb986c6208c9b967c13561799`  
Branch: `codex/runtime-reconciliation-v3`  
Production state: frozen; this diagnosis made no production request or mutation.

## Finding 1 — health transport does not depend on the capability binding

`CloudflareSandboxBackend.availability()` first resolves the fixed platform process identity
`tenant-service` through the Sandbox namespace for the deterministic runtime identity. If that
process reports running, it sends the manifest health request directly with
`sandbox.containerFetch(request, servicePort)`. Neither operation resolves the coordinator's
container-to-runtime capability binding.

The binding is consulted on a different transport path: tenant code calls the allowlisted
`CAPABILITY_DOORMAN_HOST`; `ContainerProxy.fetch()` / the registered outbound handler forwards that
request to `handleCapabilityIntentFromContainer()`, which resolves the caller's platform container
ID through the coordinator before permitting a capability operation.

Therefore Wall #12's unbinding can break the app's database calls, but it cannot itself manufacture
the reconciliation trail's `health_transport`. The exact `e0ecf724` observation means the provider
process lookup succeeded and the subsequent direct port transport did not return an HTTP response.

## Finding 2 — preview idle semantics

The runtime model allows an explicitly stopped preview to exist without a tenant process. That is a
valid, non-serving idle state: it has no active capability binding and does not claim readiness.
It is not a healthy serving runtime. The preview data plane requires the stored descriptor to be
`running` before it forwards the authenticated request, and the forwarding path sends directly to
the declared tenant port. A Project 51 preview stored as `error` after a false transport terminal is
therefore not eligible for an idle verdict; it must be repaired to running or return a typed repair
failure.

The v3 table calls the legitimate explicit `stopped` preview case `healthy-idle` to distinguish it
from both a serving runtime and a broken runtime.

## Finding 3 — one damage class covers preview, blue, and green

Wall #12's preserved provider census recorded all three deterministic Project 51 VMs as provider
`running`. The shipped mutating status-read path then recorded all three descriptors as `error` with
the same `health_transport` class, cleared their platform process identity, and left their
capability bindings inactive. Their artifacts and exact manifest revisions remained durable:

| Target             | Stored status | Process identity | Capability | Manifest revision                                                               |
| ------------------ | ------------- | ---------------- | ---------- | ------------------------------------------------------------------------------- |
| preview / primary  | `error`       | absent           | unbound    | `zero-node-v1-f8dd2e2df3487cc3c3c5e8f008266ef4ce0b61ac8dbb7bb56849389784b7e039` |
| production / blue  | `error`       | absent           | unbound    | `prod-e7060cad1aab9f5764727d28ffc058f186117c80ec77ab5`                          |
| production / green | `error`       | absent           | unbound    | `prod-a8940c976f1cf943d03c5bccd52e3bdb5b1ea51b8d56e228`                         |

The exact Wall #15 preview trail additionally proves that the fixed provider process identity still
reported `running` on three attempts while direct health transport remained unknown. Blue and green
have the same product-state damage signature and the same retained start inputs, so the same v3
repair action applies regardless of slot direction: bounded observation, governed process restart
from the retained artifact, process identity registration, and capability rebinding.

## Decision-table consequence

V3 preserves ambiguity for genuine weather when stored identity is already truthful. For the
captured false-terminal signature (`error` + missing stored identity + retained artifact), three
identical ambiguous health observations become a definite `repair-required` verdict rather than an
inconclusive terminal. A definitely missing/non-running process in the same damaged state is also
repair-required. A ready provider process is re-registered and rebound without restart. An
explicitly stopped preview with no process is `healthy-idle`. No captured Wall #12/#15 signature
remains inconclusive.

## INCIDENTAL FINDINGS

None during Phase 1.
