# Finish the 15 — Z-J Memory Provenance Delivery

Date: 2026-08-26  
Capability: Z-J — durable memory provenance and user-visible source labels  
Environment: LAB  
Database: NONE  
Store: `A:/NabuFlowLab/.pnpm-store/v10`  
Kind: branch delivery; production publication pending

## Plain-language result

Zero's saved project knowledge can now explain where it came from without exposing private actor identifiers. New facts are classified as something a person stated, something Zero observed, or something Zero inferred. Historical facts without a trustworthy receipt are shown as unverified rather than guessed. Inferred and unverified facts are also marked inside Zero's build context so it knows to verify them before relying on them.

Pre-live score: **9.6/10**. The implementation, contracts, migration, UI, focused tests, exact-base full-suite parity, and bounded Ruflo review are complete. The score remains pre-live until the Replit gate, production boot receipt, API identity, and user-eyes screenshot are captured.

## Architecture

- One closed `zero-memory-provenance-v1` contract defines claim kinds, source classes, privacy-safe labels, parsing, and presentation.
- One canonical server writer records provenance atomically with knowledge mutations.
- Automated memories default to `observed`; conversation summaries and style inferences are `inferred`; direct human edits/imports are `stated`.
- The public API returns the latest authorized receipt only. Raw actor identifiers never leave the server.
- Source identifiers are present only when the request already has access to the source project.
- Legacy or malformed evidence fails closed to `Source unverified`.
- Project knowledge cards render `You said`, `A teammate said`, `Zero observed`, `Zero inferred`, or `Source unverified`.
- Zero's build context distinguishes stated, observed, inferred, and unverified facts; inferred and unverified facts carry an explicit verify-before-use instruction.

## Schema and migration safety

The existing idempotent `migrate-knowledge-provenance` startup step adds nullable `claim_kind` and `actor_user_id` columns plus a closed-value check. It does not rewrite historical rows, does not invent authorship, and safely skips already-applied changes. The startup migration count remains 145; no new migration step, manifest, package, or lockfile change was introduced.

## Verification receipts

- Library build: PASS.
- API typecheck: PASS.
- Web typecheck: PASS.
- API lint: PASS.
- Web lint: PASS.
- Changed-file Prettier: PASS.
- Secret-pattern scan: zero matches.
- Focused API: 3 files, 20 tests passed.
- Focused web: 1 file, 2 tests passed.
- Exact-base API: 2,989 total; 2,943 passed; 41 failed because database/provider fixtures are absent in the lab.
- Branch API: 3,000 total; 2,954 passed; the same 41 failed.
- API normalized failure hash, base and branch: `ac3a26947d7439762cd9e894bb64d2dd1a388ca3138e0318d5f22f1496cfd654`.
- API failure-set delta: 0; new passing tests: 11.
- Exact-base web: 1,189/1,189 passed.
- Branch web: 1,191/1,191 passed.
- Web failure-set delta: 0; new passing tests: 2.
- Release gate: 19 stages passed. Three database-bound stages failed only at `ECONNREFUSED 127.0.0.1:5432` in the declared database-free lab. The production-capable Replit gate is therefore mandatory before publication.
- Ruflo bounded read-only pilot: PASS in 725 ms; policy `nabuflow-ruflo-readonly-v1`; provider 3.38.20; no mutation authority; unauthorized `system_reset` blocked; clean tree preserved.

## Incidentals resolved and preventatives

1. **Unbounded provenance reads.** Early implementation loaded complete reinforcement history. Fixed with PostgreSQL `DISTINCT ON` latest-receipt queries in both API presentation and Zero context assembly. Preventative: tests and the single-receipt public contract bound the result per knowledge entry.
2. **Import result-order assumption.** Early code correlated inserted rows by return order. Fixed by returning the stored content and hashing that exact value. Preventative: correlation no longer depends on database row order.
3. **Manual knowledge creation accepted an unvalidated body and caller-selected scope.** Fixed with a strict bounded Zod schema and server-owned project scope. Preventative: invalid input is rejected before persistence and scope cannot be broadened by the caller.
4. **Multiple provenance write paths could drift.** Consolidated to one canonical application insert path. Preventative: the code census asserts one non-test insert site and integration tests cover the mutation families.
5. **Replit rejected the first publish before production changed.** Its schema-diff layer rendered the new unvalidated claim-kind check with malformed closing syntax. Fixed by making this new closed-value check validated and idempotently validating a pre-existing development copy. Preventative: a named regression test now forbids this constraint from returning to the `NOT VALID` shape, while preserving the no-backfill rule. The first publish attempt changed neither the live build nor production data.

## First publish-attempt receipt

The production-capable Replit gate passed all 22 stages on commit `63e9be4932c16869c4f15cfae9668aec0bf23687`, tree `289a51c4535e716973c150670c8c9ee95985c745`. The first publish then stopped during Replit's pre-production migration validation. The failure was isolated to the generated claim-kind check statement; the prior build remained live. The repair is a two-file follow-up with focused tests, typecheck, lint, formatting, and the same declared database-free lab failure set. Production publication remains pending until the repaired exact head passes the Replit gate and live closure below.

## Remaining live closure

Before this row is marked LIVE: run the production-capable release gate, publish once, verify boot migration count 145, confirm `/api/version` commit/tree identity, probe health three times, and capture user-eyes evidence of provenance labels in the signed-in Knowledge surface. The slice branch must then be deleted locally and remotely, and the permanent A: worktree returned to clean main.

## ZERO knowledge

Zero must explain saved knowledge in plain language: “You said this,” “A teammate said this,” “I observed this,” “I inferred this,” or “I cannot verify the source.” It must verify inferred or unverified facts before using them to change a project. It must never expose internal actor IDs, receipt codes, or inaccessible project identifiers.

## Incidental findings

No unresolved Z-J-related incidental remains. The database-free lab cannot execute production-bound release stages; this is an environment boundary, not silently treated as a pass, and the Replit gate remains a mandatory publish prerequisite.
