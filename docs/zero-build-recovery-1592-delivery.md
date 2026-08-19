# Zero build recovery 1592 delivery

## Outcome

Plain web projects now route deliberately into the supported sealed production source contract. Existing Node/Express web projects keep their current route. Mobile, non-web, and unsupported web stacks remain closed with typed reasons.

The failure surface is also deterministic and plain: it shows one human sentence and one **Convert and build** action. The action sends a purpose-built recovery instruction that preserves the requested design and content. Generic AI-generated repair suggestions are not used for this failure, so the previous misleading framework advice cannot return.

Zero's sealed-generation guidance now explicitly teaches how a plain website is represented in the supported Node/Express production contract.

The first live Project 52 retry then exposed a narrower contradiction: the guidance said the vendored runtime SDK was required only when a capability was used, while the source validator required an SDK import from every website. The validator is now content-derived: a plain website with no database or payment capability needs no SDK import; a website that uses either capability still fails closed unless the supported SDK is imported. Any remaining source repair is folded into one plain **Repair and build** action instead of framework suggestions.

## Base and branch

- Verified base: `daca3211d9d923ee69d80c98f4cc09993f41c1e3`
- Branch: `codex/zero-build-recovery-1592`
- Manifest and lockfile changes: none

## Changed surfaces

- `artifacts/api-server/src/lib/zero-sealed-project-routing.ts`: central typed routing decision for sealed project kinds and historical website stacks.
- `artifacts/api-server/src/lib/jobs.ts`: applies the routing decision, atomically canonicalizes project and primary-artifact metadata, preserves typed evidence, and emits the deterministic recovery payload.
- `artifacts/api-server/src/lib/zero-sealed-generation.ts`: teaches Zero the plain-website production representation.
- `artifacts/mustaflow/src/pages/projects/components/chat-history.tsx`: carries the recovery action from the durable error plan.
- `artifacts/mustaflow/src/pages/projects/components/inline-builder-error.tsx`: renders the single recovery action.
- Focused regression files alongside those surfaces pin routing, job wiring, Zero knowledge, plain wording, and one-button behavior.

## Verification

All test processes ran serially.

- Frozen/offline dependency proof: PASS against the dependency-owning A2 worktree; its lockfile SHA-256 exactly matches this branch (`B8DA847F2D8C8B30A5A84BFB362AB1176D86FD70DAFE972EDC6FCA9A684BD54E`), resolution was skipped, and zero packages were downloaded.
- API focused regressions: 4 files, 42 tests, all PASS.
- Web focused regression: 1 file, 3 tests, all PASS.
- Full workspace typecheck: PASS.
- Full workspace lint: PASS.
- Changed-file Prettier check: PASS.
- Changed-file credential-pattern scan: zero matches.
- API full-suite failure-set parity:
  - base: 39 failing / 159 passing / 3 skipped files; 41 failing / 2,412 passing / 5 skipped tests.
  - branch: 39 failing / 160 passing / 3 skipped files; 41 failing / 2,425 passing / 5 skipped tests.
  - delta: one new passing file and thirteen new passing tests; no new failing file or test.
- Web full-suite failure-set parity:
  - base: 1 failing / 104 passing files; 1 failing / 1,060 passing tests.
  - branch: 1 failing / 104 passing files; 1 failing / 1,062 passing tests.
  - delta: two new passing tests; the sole pre-existing captured-frame hash failure is identical.

The API baseline failures are the same local-environment/service-binding and known mock failures on both revisions. None touches the changed routing or recovery surfaces.

## Live acceptance

The first ship merged at `9127515e23f6428b56c6a9ff398f0a83adef17b1`, passed the release gate, published as deployment `a6a7faed-a465-45a7-86f4-f28002add3aa` / build `398b445b-1379-4b85-8067-9b6b16703deb`, and closed with marker `c0c59d84cfe5e1c1c7c9acb0e4c15e0183fb3b8f`. Production health was green.

The original Project 52 request then reached the widened Node/Express route, proving the original classification failure was gone, but stopped at `sdk_import`. That live evidence drove the capability-aware validator correction above. Final live acceptance remains: after this corrective ship, Project 52 (`IRQ TEL`) must successfully build `create me an website that have iraqi waving flag in the background the website name is IRQ Tel` through the real product route.

## Incidental findings

1. Windows package linking is unusually slow on this lab machine. A direct offline install was bounded and stopped without downloads; verification reused a fully installed dependency tree with an identical frozen lockfile instead.
2. The repository's generic initial `node-api` scaffold is not the sealed source contract. This slice does not broaden that scaffold; Zero replaces it with the dependency-complete sealed Node/Express source at generation time.
3. Replit development schema had not run the shipped A2 adoption and still held 46 projects with a nullable workspace. Republish correctly stopped before mutation. The development-only A2 migration adopted 17 demo projects, backfilled 29 real-owner projects, reached zero nulls, and produced an empty schema diff on its second run. Production was read-only and already correct.
4. The first safe Republish attempt received HTTP 429 before build or deployment. One bounded retry after cooldown succeeded; no partial deployment or database change existed from the rejected attempt.
5. Project 52's first widened-route run exposed the unconditional `sdk_import` mismatch described above. A follow-up attempt also encountered an unavailable build container and the agent step cap; it persisted no project files. The product correction is deterministic rather than another prompt retry.
