# Sealed test runtime rehydration delivery report

## Outcome

The first live use of the newly wired sealed-test control failed before approval or promotion with the typed result `sealed_test_runtime_not_ready`: the accepted sealed preview runtime was stopped after an API-process restart, while the API provider's in-memory artifact cache was empty. The durable accepted sealed release remained intact. This branch repairs that restart boundary by resuming the exact accepted release before re-verifying the test candidate.

No production promotion, approval, publish, public-route change, database mutation, or Fly action occurred during the failed start. The operation stopped before a runtime start was dispatched, so it created no new running resource or cost.

## Scope

Base: `084f53c1f0ab9fa12ee63c24d1a999d3b774bc5e`

Branch: `codex/sealed-test-runtime-rehydration`

The repair preserves the sealed-release handoff contract:

- Selection first binds the exact accepted release to the current canonical source snapshot.
- A stopped preview is resumed only from that durable release's runtime identity, manifest revision, artifact revision, and sealed artifact SHA-256.
- The provider seeds its process-local deployment cache from the validated durable release; it neither rebuilds nor uploads artifact bytes.
- Runtime state is independently read and the exact release is reverified after the start.
- A different project, runtime role, manifest revision, artifact revision, source snapshot, or sealed hash fails closed with a typed error.
- Artifact v1 and layered-artifact wire formats are unchanged. Fly is untouched.

## Root cause

`CloudflareRuntimeProvider` keeps a process-local `deployedArtifacts` map as a guard for ordinary start calls. The accepted sealed release itself is durable in project-version state, but the map is intentionally not durable. After an API-process restart, the UI's new `Start test` action selected the correct release and observed its runtime as stopped, then rejected it before any mechanism could rehydrate the local guard. The result was a permanent liveness gap: a valid durable accepted release could no longer enter testing unless it happened to still be running in the same API-process lifetime.

The Worker, release identity, sealer, and promotion contract were not implicated. The live typed refusal was correct for the code as shipped; the missing orchestration was in the API provider boundary.

## Changed files

- `artifacts/api-server/src/lib/sealed-testing-candidate.ts` — separates immutable release/source selection from post-start runtime verification.
- `artifacts/api-server/src/routes/preview-env.ts` — selects the exact release, resumes a stopped runtime, then re-verifies it.
- `artifacts/api-server/src/lib/tenant-runtime-provider.ts` — adds the explicit accepted-release restart capability to the sealed-native provider contract.
- `artifacts/api-server/src/lib/cloudflare-runtime-provider.ts` — implements exact, fail-closed accepted-release rehydration without transfer or rebuild.
- `artifacts/api-server/src/lib/sealed-testing-candidate.test.ts` — covers pre-start exact selection and source-change rejection.
- `artifacts/api-server/src/lib/cloudflare-runtime-provider.test.ts` — proves exact restart with zero layer transfers and fail-closed manifest mismatch.
- `artifacts/api-server/src/lib/sealed-release-handoff-path.test.ts` — proves the orchestration order: select, exact restart, verify.
- `artifacts/api-server/src/lib/tenant-runtime-provider.test.ts` — covers provider capability detection.

No manifest or lockfile changed.

## Verification

- Focused API regressions: **55/55 passed** across four files.
- Tenant runtime contracts: **187/187 passed**.
- Runtime Worker: **251/251 passed**.
- TypeScript: `typecheck:libs` and API server typecheck passed.
- ESLint on every changed TypeScript file passed.
- Prettier on every changed file passed.
- `git diff --check` passed.
- Full API suite: **2,331 passed, 41 failed, 5 skipped**. Every changed-path test passed. The remaining failures are outside this change and are the checkout's environment/base set: unavailable database/AI-integration configuration plus two unrelated public-AI confidence assertions. No failure names a modified file or the sealed-test handoff path.

The live acceptance is intentionally paused at the ship boundary. After this branch is shipped, the remaining sequence is: start the exact sealed test, observe it healthy, approve that exact artifact, promote it, prove the published canary page/database/health routes, and replace `towing-co` in the post-publish smoke target.
