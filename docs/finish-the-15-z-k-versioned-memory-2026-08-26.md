# Finish the 15 — Z-K Versioned Memory Delivery

Date: 2026-08-26  
Capability: Z-K — memory is version-bound and rolls back with the app  
Branch: `codex/finish15-z-k-versioned-memory`  
Base: `01908f3d6f994cccb9e92ac548b45e10c3178243`  
Database: none in the lab; the new startup migration and database-backed regression run in the governed Replit gate before publish.

## Plain-language outcome

Project memory now follows the same history as the app. A normal new version continues the current memory line. Restoring an older version starts from that older version's memory line, so decisions learned only on the abandoned branch stop influencing Zero. Nothing is destroyed: historical memories remain visible and are labeled clearly.

The AI Memory screen uses three honest labels:

- **Current app version** — Zero may use it now.
- **Saved with another version** — visible history, excluded from the current build context after a rollback.
- **Version not verified** — fail-closed when the app or memory lacks a trustworthy version binding.

## Architecture

1. `project_versions.parent_version_id` records the app-history edge.
2. A single startup-owned trigger assigns the previous head to every ordinary version insert. This covers all existing writers without duplicating parent logic in more than twenty call sites.
3. Both governed restore paths deliberately set the restored version as the new revision's parent.
4. Project memory writes bind to the current version inside the same transaction that validates provenance and writes the memory.
5. Project-level deduplication is limited to the same version, preventing a new branch from rewriting an older branch's memory bytes.
6. The builder reads only project memories on the declared current lineage. Global and user-scope memory keep their existing separate policy.
7. Historical rows remain queryable and receive a content-free version-state projection for user eyes.
8. Legacy project memories are idempotently bound to the closest version at or before their creation, falling back to the project's first version when they predate it. A first-version trigger covers future pre-version memories.

## Preventatives

- The lineage walker is pure, bounded to 2,000 versions, deterministic, and fail-closed on a missing parent or cycle.
- A self-FK and project/parent index make malformed or slow lineage state harder to create.
- Startup SQL is idempotent and deletes no version or memory rows.
- A rollback must name its parent explicitly; tests pin both restore call sites.
- Build-context filtering and user-visible labeling share the same lineage reader.
- Raw memory content is never included in version-state evidence.

## Verification completed in the lab

- API focused contracts: **4 files / 21 tests passed**.
- Web focused contracts, clean per-file retry after Windows worker-start weather: **3 files / 9 tests passed**.
- API typecheck: passed.
- Web typecheck: passed.
- API lint: passed.
- Web lint: passed.
- OpenAPI clients regenerated and library declaration build passed.
- Full API suite on the exact base: **224 files / 2,954 tests passed; 41 files / 41 tests failed; 3 files / 5 tests skipped**.
- Full API suite on Z-K: **226 files / 2,964 tests passed; 41 files / 41 tests failed; 3 files / 5 tests skipped**.
- API normalized failure delta: **0**; Z-K adds **10 passing tests**.
- Full web suite on the exact base: **126 files / 1,191 tests passed**.
- Full web suite on Z-K: **127 files / 1,195 tests passed**.
- Web normalized failure delta: **0**; Z-K adds **4 passing tests**.
- Complete repository typecheck, lint, changed-file Prettier check, diff check, and secret-pattern scan: passed.

The database-backed rollback regression is included and intentionally deferred to the governed Replit environment because the lab carries no `DATABASE_URL`.

## Existing-test changes

- Startup migration count advances from 145 to 146 for `migrate-zero-memory-version-lineage`.
- The migration contract now separately permits and pins the narrow Z-K backfill while preserving the Z-J no-provenance-backfill law.
- Ora/Builder isolation gains a version-one → version-two → rollback regression proving the version-two memory is excluded from Zero context but remains visible as historical.

## Incidental findings

1. **Windows test-worker startup weather.** One combined web run timed out before an unchanged worker started. The single permitted clean retry ran each file serially; all nine tests passed. No product defect was found.
2. **Historical versions had no parent edge.** This was the structural reason Z-K could not be completed through query filtering alone. It is fixed in scope with the idempotent backfill, self-FK, trigger, and restore-path assertions.

## For Zero

Zero must say: “This memory belongs to the current app,” “This memory belongs to another version and will not guide this build,” or “I cannot verify which version this belongs to.” After a rollback, Zero must not silently use decisions learned only on the abandoned branch. It may explain that those memories remain in history and become current again only if that version line is restored.

## Live closure still required

Before Z-K is declared live: run the full Replit release gate on the exact branch/main tree, boot migration 146 successfully, publish once, verify `/api/version` and `/api/healthz`, then capture the signed-in AI Memory labels and a governed rollback/context proof.
