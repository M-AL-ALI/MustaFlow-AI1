# Sealed-release staging handoff delivery report

## Scope

This branch closes the artifact-native handoff between staging, sealed testing, and production
promotion. An artifact-native staging snapshot now retains the accepted sealed-release record that
matches its exact source bytes; sealed-test selection targets that staging snapshot and can recover a
legacy record only from an exact canonical source match; the workspace exposes authenticated test
start, rebuild/status, and approval controls; and staging promotion now drives the production
artifact provider with the same sealed artifact identity that was tested. A newer or visually similar
version can never substitute for the staged artifact.

## Delivery identity

- Verified base: `044cd6df05c91033b73d050b92629fb6172d5b5a`
- Branch: `codex/sealed-release-staging-handoff`
- Evidence: `docs/evidence/sealed-release-staging-handoff-20260816T180226Z.json`
- Delivery posture: branch only; no merge, Replit publish, Cloudflare deploy, live mutation, new
  surface, provider lease, or cost.

## Root cause

Three individually valid paths were not joined:

1. Artifact-native staging created a fresh version row without copying the accepted sealed-release
   record from the matching trusted-build version.
2. Sealed test startup selected the newest version, rather than the staging snapshot that production
   promotion was required to ship.
3. The legacy staging `promote` endpoint advanced database/KV state but did not invoke the
   artifact-native production promotion provider. The workspace also had no direct controls for the
   existing test-environment routes.

The combined effect was a fail-closed promotion gate with no product path that could prove and ship
one immutable artifact identity end to end.

## Implemented invariant

### Staging preservation

For an artifact-native staging publish, the API canonicalizes the complete source snapshot as sorted
`path`, `content`, and `mimeType` records. It selects only an accepted release whose stored source
snapshot is exactly equal, then writes that accepted release onto the new staging version. No match
returns typed `sealed_release_required` before a staging snapshot is written.

### Sealed test binding

Test start and rebuild target `stagingPublishedSnapshotId`. A legacy staging row lacking its release
may be repaired only from a recent accepted-release version with the exact same canonical source;
that release is then durably copied to the staging row. The existing sealed-candidate verifier still
independently checks current source, preview runtime identity, manifest revision, and running status.
The candidate ID remains the staging version ID even when a legacy matching release came from an
earlier row.

### Production promotion

Both direct production publish and staging promotion now share `promoteAcceptedArtifact`. The helper
allocates any declared production database capability, derives the blue/green identity, and asks the
artifact-native provider to promote, start, and activate the accepted sealed artifact. The staging
route persists that release and runtime state and uses the existing provider rollback if database
persistence fails after activation. Legacy/static behavior remains on its existing path.

### Workspace controls

The Preview workspace now reads the authenticated test status and exposes start/rebuild and approve
actions using the existing product routes. It polls while building, displays typed failures, and
refreshes the authoritative project record after state changes. The publishing flow's existing
navigation to Preview therefore lands on usable controls rather than an unwired banner.

## Regression coverage

- Exact-match selection chooses the compatible accepted release instead of a newer divergent
  version.
- A legacy staging snapshot binds to an earlier accepted release only when every canonical source
  byte matches.
- A source lookalike with one changed byte fails typed and cannot become a candidate.
- The full pure path carries one sealed artifact hash through staging preservation, sealed testing,
  approval gating, and production promotion identity.
- Route wiring asserts that staging persists the accepted release and `/promote` invokes the shared
  artifact provider with rollback support.
- Workspace wiring asserts authenticated status/start/rebuild/approve controls and authoritative
  refresh.

## Acceptance evidence

| Check                      | Result                                                                         |
| -------------------------- | ------------------------------------------------------------------------------ |
| Frozen offline install     | PASS; lockfile unchanged, zero downloads, 12m23s on this slow-disk machine     |
| Focused API handoff suite  | PASS; 2 files, 10/10                                                           |
| Focused workspace controls | PASS; 1 file, 2/2                                                              |
| Workspace typecheck        | PASS; libraries and all participating artifacts/scripts                        |
| Workspace lint             | PASS; all 20 participating packages                                            |
| Changed-file format check  | PASS                                                                           |
| Contracts full suite       | PASS; 20 files, 187/187                                                        |
| Runtime Worker full suite  | PASS; 34 files, 251/251                                                        |
| API full suite             | 2,328 pass, 39 fail, 5 skip; no failure in a changed file or handoff test      |
| Workspace full suite       | 1,051 pass, 1 fail; only the previously recorded stale preview-capture SHA pin |
| `git diff --check`         | PASS                                                                           |

The API full-run failures are the established lab/base profile (missing database/integration
configuration plus its dependent assertions). The workspace failure is
`preview-reconciliation.test.ts`'s already-recorded capture SHA-pin errand: expected
`ec751002...`, observed `abe274da...`. This branch neither changes that test nor its capture.

The repository-wide Prettier check also reports the same three untouched production Wrangler JSONC
files (`wrangler.build.production.jsonc`, `wrangler.pantry.production.jsonc`, and
`wrangler.runtime.production.jsonc`). All branch files pass the changed-file formatter check; the
unrelated production configs were preserved.

## Compatibility and frozen surfaces

- No manifest or lockfile changes.
- No Artifact v1, layer-format, runtime-contract, or Worker changes.
- No Fly provider or configuration changes; provider capability detection keeps Fly/static
  promotion on the existing behavior.
- No tenant egress change.
- No new credential, binding, route, hostname, or public surface.
- Production remains unchanged until Replit merges and publishes this branch.

## Ship boundary

The branch is ready for the normal Replit ship ritual. No live promotion or canary action was taken.
After the ship, the remaining founder-authorized sequence is the real product-route staging test and
approval, production promotion of that exact sealed identity, published-route page/database/health
proof, and post-publish smoke rewiring.
