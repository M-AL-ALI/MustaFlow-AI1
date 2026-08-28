# Admin Page rebuild mission

Issued and opened: 2026-08-27  
Mission tag: `ADMIN-PAGE-REBUILD-2026-08-27`  
Acceptance identity: Git tree, never commit alone  
Production baseline at P0 acceptance: tree `0e0f987335506deb9ad6d2ec745377118dc8d687`

## Goal

Make the Admin Page an operator console that a trusted owner can use at three in the
morning: operational truth is ranked, every retained panel explains itself, numbers
lead to their records, support actions reach users, and no ticket claims resolution
without evidence.

## Root causes accepted for the rebuild

1. **Shell context was incomplete.** The stale founder walkthrough lacked usable
   navigation. P0 and a later founder-eyes check proved that the current serving tree
   does render the NabuFlow sidebar on both `/admin` and `/admin/support`, and Support
   Inbox can reach Admin. The remaining defect is narrower: no breadcrumbs, no
   ticket-to-project contextual link, no back-to-Admin control inside ticket content,
   and no captured browser-back-free walkthrough.
2. **Counts are dead ends.** Project, published-project, account-credit and transaction
   totals do not open the underlying records.
3. **Panels do not declare their purpose.** Operational and developer diagnostics are
   mixed together without a consistent truth/action/freshness contract.
4. **Actions lack visible consequences.** Consent and proposal requests can persist an
   honest waiting state without reaching the project owner in product or by email.
5. **Tickets lack operational identity and closure.** Ticket number, assignee, age,
   priority, complete statuses and evidence-bearing resolution are incomplete.

## Binding phase sequence

| Phase | Scope                                                      | State           |
| ----- | ---------------------------------------------------------- | --------------- |
| P0    | Read-only survey and owed identity decisions               | Accepted        |
| P1    | Shell, navigation and KEEP-panel hierarchy                 | Complete / live |
| P2    | Panel declarations and developer-tool exile                | Complete / live |
| P3    | Drill-in for every number                                  | Complete / live |
| P4    | One Admin authority source                                 | In progress     |
| P5    | In-product and email consent delivery                      | Not authorized  |
| P6    | Ticket identity, ownership and resolution                  | Not authorized  |
| P7    | Per-project invitations, members, roles and presence       | Not authorized  |
| P8    | Ticket-to-Zero and completed triage                        | Not authorized  |
| P9    | Serving-tree operator walkthrough and documentation parity | Not authorized  |

## P0 acceptance record

- Report tag: `ADMIN-PAGE-REBUILD-P0-2026-08-27`.
- Production `/api/version` returned commit
  `8a49f7e9e17768eaa303a451b76680cf4f538202` and tree
  `0e0f987335506deb9ad6d2ec745377118dc8d687`.
- The served tree matched the commissioned tree exactly.
- No repository or production mutation occurred during P0.
- Founder-eyes ruling closed the stale shell conflict: both Admin routes have the
  product sidebar on the serving tree. P1 strengthens that shell rather than replacing
  it.
- The KEEP/EXILE/REBUILD panel census from P0 is binding for P2.

## P4 authority amendment — authorized 2026-08-28

The current resolver has three competing Admin sources: hard-coded superuser email
resolution, `ADMIN_USER_IDS`, and `user_roles`, in that order. P4 must produce this
lockout-safe end state:

1. Prove the founder's Owner row exists in `user_roles`, with a receipt.
2. Migrate every environment-derived and superuser-derived Admin identity into
   `user_roles`, one receipt per identity.
3. Make `user_roles` the sole Admin authority.
4. Remove all Admin meaning from `SUPERUSER_EMAILS`; any billing exemption becomes a
   separately named and receipted mechanism.
5. Reduce `ADMIN_USER_IDS` to a break-glass bootstrap that may seat the first Owner only
   when the table is empty, and receipts that action.
6. Preserve last-Owner protection throughout.
7. Use one typed resolver and cross-panel tests so Admin Me, Security and Launch
   Readiness cannot disagree.

The founder authorized P4 as part of the remaining Admin Page sequence on 2026-08-28.
Implementation is constrained to the lockout-safe order above and is accepted only
after the serving tree, boot reconciliation receipts and all three Admin surfaces agree.

## Decisions and refusal paths

- P1 ranks only the KEEP set. Developer panels designated for P2 exile remain intact
  and are moved below operational content without investing in their presentation.
- P1 does not implement drill-ins, consent delivery, ticket resolution, collaboration
  or authority migration; those belong to P3–P8.
- The customer project header that can show `failed`, `Unauthorized` and `Running`
  together is parked for separate authorization and is not changed by this mission.
- Publication is never initiated by Codex in this mission. Each phase stops at its
  report gate; the founder chooses publish cadence through the desk and Replit.

## Incidental findings and permanent preventives

| Finding                                                        | Preventive measure                                                                                                           |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Wrong-framework support proposal                               | Primary-artifact/format/stack binding, architecture validation, one bounded retry, and refusal instead of an unsafe proposal |
| Expired grant displayed active                                 | One canonical clock-aware effective-status reader with contract tests                                                        |
| Control-character regex failed lint                            | Codepoint sanitizer, regression test and release-gate lint                                                                   |
| In-progress publish treated as potential failure               | Never retry or classify without a terminal deployment receipt                                                                |
| Three competing Admin authority sources                        | P4 single typed resolver and cross-panel consistency tests                                                                   |
| Superuser source mislabeled as environment                     | Remove competing authority rather than relabel it                                                                            |
| Customer project-state contradiction                           | Parked; proposed single derived state contract and one presenter                                                             |
| Unreceipted A-drive reduction                                  | Pair every phase with free-space receipts; account by metadata before any cleanup                                            |
| Operational read failures could resemble zero or healthy state | Explicit unknown/unavailable states plus focused regression guards; no failed read renders a zero-success claim              |

## A-drive accounting before P1

The difference between the earlier free-space receipt `78,770,307,072` and P0 opening
`74,526,736,384` bytes is associated with the Ruflo installation on A:

- `.tools/ruflo-3.38.20`: 48,462 files, 1,397,729,446 apparent bytes, all written on
  2026-08-26.
- `.npm-cache` files written since 2026-08-26: 100,535 files and 3,714,900,463
  apparent bytes, led by `_npx` and `_cacache`.

Their combined apparent growth is 5,112,629,909 bytes. Filesystem allocation,
compression and cache overlap account for the smaller free-space delta. The Ruflo
installation and its A-drive cache are retained; no deletion is authorized by P1.

## Evidence ledger

Every phase appends its exact changed-file hashes, Git tree, gate receipts, preview or
serving evidence, drive readings, branch lifecycle and refusal paths here before the
mission can close.

### P1 implementation record

- One shared `AdminBreadcrumbs` component gives `/admin` and `/admin/support` an
  accessible, consistent path back to Projects and Admin.
- A selected support ticket now carries two content-level exits: Back to Admin Page,
  and a project-bound link generated only from that ticket's own `projectId`. Tickets
  without a project state that fact and never invent a destination.
- Launch readiness, production errors and the job queue now precede informational
  cards in DOM order. The KEEP set remains ahead of all P2 EXILE panels; the five EXILE
  panels are grouped at the bottom without changing their internal behavior.
- The Admin header now names only the surfaces actually present in this phase.
- Failed reads for readiness, production errors, queue state and summary statistics
  render an explicit unknown/unavailable state. A failed read cannot be mistaken for
  zero errors, an empty queue, or a passing launch state.
- P1 deliberately does not change ticket status semantics, project access grants,
  Admin authority, or any panel assigned to P2–P8.

### P1 honest completion matrix

| Requirement                           | State in the P1 candidate                                                           | Refusal / boundary                                                                                               |
| ------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Breadcrumbs on every Admin route      | Complete for the complete registered Admin route set: `/admin` and `/admin/support` | The current page is text, not a false link; every ancestor is one click                                          |
| Ticket to reporting project           | Complete when the ticket carries `projectId`                                        | A ticket without `projectId` says `No project linked` and never invents a destination                            |
| Back to Admin inside ticket content   | Complete for a selected ticket                                                      | The control remains inside ticket content; the product sidebar is not treated as a substitute                    |
| KEEP-set information hierarchy        | Complete in DOM order                                                               | Blocking/degraded operational readers precede informational content; P2 EXILE panels remain unchanged below them |
| Header truth                          | Complete because P1 touched hierarchy copy                                          | It names only the surfaces actually present and does not claim end-to-end control                                |
| Browser-back-free preview walkthrough | Pending the clean-head preview gate                                                 | P1 cannot claim completion from unit tests alone                                                                 |
| P2 panel cull                         | Not built                                                                           | P2 is not authorized                                                                                             |
| P4 authority consolidation            | Not built                                                                           | Amendment is planning-only until P4 authorization                                                                |

## P2 candidate — panel declarations and developer-tool exile

Tag: `ADMIN-PAGE-REBUILD-P2-2026-08-28`

- Every retained operator-panel family now renders one visible, consistently labelled
  declaration: **Purpose**, **Operator action**, and **Freshness**. Shared card and section
  components carry the contract so newly added instances cannot silently omit it.
- Prompt Eval, Ora Routing Inspector, Architect Review, Top skills used, and Builder Skills
  no longer render in the day-to-day Admin Page. They render together at
  `/admin/developer-tools`, linked only for an Owner and guarded by the server-backed Admin
  identity response plus an explicit Owner-role check.
- The developer panels were moved, not deleted or duplicated. Their existing controls and
  data sources are unchanged.
- A non-Owner reaching the route directly is refused and returned to the Admin Page with a
  plain Owner-access message. A user without Admin access remains subject to the existing
  Admin guard and never reaches the Owner check.
- No API route, schema, migration, manifest, lockfile, provider, or production resource changed.

### P2 preventive guards

- `admin-panel-declarations.test.tsx` pins the three visible declaration labels across every
  retained panel family, all five developer-panel placements, the Owner-only guard, and the
  complete breadcrumb path.
- `admin-navigation-hierarchy.test.tsx` now pins the operational ordering followed by the
  owner-only developer-tools entry rather than preserving the obsolete main-page exile group.
- The first focused run exposed an over-specific test assumption: it searched the parent for
  text owned by `TopSkillsPanel`. The guard now checks the component placement and the helper's
  user-visible label independently, preventing a refactor from producing a false failure.

### P2 honest completion matrix

| Requirement                       | Candidate state | Refusal / boundary                                                                           |
| --------------------------------- | --------------- | -------------------------------------------------------------------------------------------- |
| Purpose, action and freshness     | Built           | Developer-only panels use a page-level warning because they are not retained operator panels |
| Five-panel exile from Admin Page  | Built           | Owner-only internal route; no new public or unauthenticated surface                          |
| Owner-only route enforcement      | Built           | Non-Owner Admins return to `/admin`; non-Admins remain denied by `AdminGuard`                |
| Existing developer-tool behavior  | Preserved       | No tool API or mutation semantics changed                                                    |
| Focused regressions and typecheck | Passing         | Live and merged-head evidence still required                                                 |
| Live production visual proof      | Complete        | Exact served tree, health receipt, live assertions and durable screenshots captured          |

### P2 serving closure

- Replit release gate on the detached, exact GitHub tree: `22 pass`, `0 warn`,
  `0 fail`.
- Replit deployment receipt: `af142308`; bundle log timestamps began at
  `2026-08-28T09:45:20Z`, the Autoscale service creation began at
  `2026-08-28T09:47:55Z`, and the deployment reached the terminal `Published`
  state before the production probes below.
- Production identity at `2026-08-28T09:50:20Z`: commit
  `e97467734f9337b2c30e434e729de1d1061a1ba1`, tree
  `f7f6e7e4ff96833755444df96795126d1350231a`, built at
  `2026-08-28T09:43:19.957Z`.
- Production `/api/healthz` returned HTTP 200, status `ok`, container subsystem
  `ok`, encryption key `ok`, startup migrations `ok`, queue schema contract
  `ok`, and the exact P2 build commit.
- Live Admin assertions: one Developer tools link; zero Prompt Eval, routing
  inspector, Architect Review, Top skills used, or Builder Skills panels on the
  operator page; fifteen visible Purpose, Operator action, and Freshness
  declarations.
- Live Developer tools assertions: all five exiled panels present on the
  owner-only route, complete breadcrumb path, and Back to Admin Page returned to
  `/admin` without browser back.
- Durable screenshots:
  `A:/NabuFlowLab/evidence/admin-p2-live-2026-08-28/admin-main-live.png` and
  `A:/NabuFlowLab/evidence/admin-p2-live-2026-08-28/developer-tools-live.png`.
- The feature branch was deleted locally and remotely after live proof; both
  absence queries were empty. The permanent tree remained clean on main.
- Closing free-space receipt: A `74,516,172,800` bytes; C `3,986,956,288`
  bytes. No additional worktree or install was created.

### P3 candidate — coherent drill-ins

Tag: `ADMIN-PAGE-REBUILD-P3-2026-08-28`

- All four previously dead summary cards are now real links: projects,
  published projects, accounts with credits, and credit transactions.
- One governed, bounded read route serves the four record families. Lists are
  capped at 50 rows per request; the UI asks for 25, offers Previous/Next, and
  project filters are capped at 120 characters.
- Account identifiers are pseudonymized on the server with a stable SHA-256
  label. Raw Clerk IDs and their fragments never cross the route. Receipt URLs
  are not returned. The UI states that masking is active and that unmasking is
  not available in this phase.
- Project records open to a useful detail card with owner label, workspace,
  stack, status, update time, and project entry. Published records additionally
  name the exact serving version and public route. Opening a record does not
  grant workspace access; that boundary remains consent-gated.
- Account records open to balance, active-project count, transaction count and
  balance freshness. Transaction records open to type, signed amount, balance
  after, timestamp, description, account record and linked project.
- An invalid drill-in, overlong project filter, or unreadable record store has a
  typed, plain refusal. A failed read never renders an empty-success state.
- Analysts receive read-only drill-in access through the existing central role
  predicate. Support remains denied; Owner and Operator behavior remains
  unchanged.

### P3 preventive guards and refusal paths

- API tests pin the row cap, deterministic masking, absence of raw identity and
  receipt URL material, account and transaction details, invalid-kind refusal,
  overlong-filter refusal and sanitized unavailable terminal.
- Web tests pin every card destination, the Admin guard, the masking notice,
  the detail surfaces, project consent boundary, list bound and pagination.
- Existing Admin-access tests pin Analyst allow and Support deny for the new
  read surface. The shared predicate remains the only role decision.
- Project workspaces that belong to another account remain inaccessible without
  consent. The read-only Admin record is useful by itself and plainly states the
  boundary rather than weakening project isolation.
- AP-6 unmasking is not invented in P3. Masked views ship; the unavailable
  unmask workflow is visible and remains a later governed capability.

### P3 honest completion matrix

| Requirement                            | Candidate state | Refusal / boundary                                                                    |
| -------------------------------------- | --------------- | ------------------------------------------------------------------------------------- |
| Project count opens filterable records | Built           | Bounded to 50 server-side; no unbounded estate read                                   |
| Each project row opens useful detail   | Built           | Cross-account workspace entry remains consent-gated                                   |
| Published rows name serving version    | Built           | Public route appears only when a persisted slug exists                                |
| Credit accounts open account views     | Built           | Raw identity is never returned; unmasking remains unavailable                         |
| Transactions open individual details   | Built           | Provider receipt URL is deliberately omitted from the masked operator view            |
| Role masking                           | Built           | P3 does not create an unmask workflow                                                 |
| Focused tests and typechecks           | Passing         | Full exact-base parity, merged-head gate, live drill-in proof, and cleanup still owed |
| Live production proof                  | Pending         | Candidate cannot close from source and focused tests alone                            |

### P1 exact-base verification receipt

All suites ran serially in the one permanent worktree. The existing worktree was
temporarily detached at the exact base for the baseline run and then returned to the
P1 branch; no second worktree was created and no install ran.

- Exact base: `8a49f7e9e17768eaa303a451b76680cf4f538202`.
- Candidate before this evidence update:
  `e897f944d26c5c6fbe46007bfb09ce83e4a29a73`, tree
  `e7b9457fe212d2bac79514ef1894579d9a1631db`.
- Focused P1 tests: 2 files, 6 tests, all passed (four new P1 guards plus two
  existing Admin access guards).
- Test-inclusive web typecheck: passed.
- Changed-file ESLint: passed.
- Changed-file Prettier check: passed.
- Base API: 41 failed / 3,027 passed / 5 skipped tests; 41 failed / 238 passed /
  3 skipped files.
- Candidate API: 41 failed / 3,027 passed / 5 skipped tests; 41 failed / 238 passed /
  3 skipped files.
- Normalized API failure-line set: 71 lines on each side; SHA-256
  `ecb5943cdddb5699afbd0dd8cd33feb233363e26dc9781aa0747a15e0e114919` on
  each side; base-only 0, candidate-only 0.
- Base web: 129 files and 1,204 tests passed.
- Candidate web: 130 files and 1,208 tests passed. The delta is the one new file and
  four passing P1 regression guards; failures remain zero.
- No manifest, lockfile, migration, schema, route or provider change.
- Database named by these lab receipts: none. The API baseline failures are the exact
  environment-gated base set, not a P1 regression.

### P1 drive and production-probe receipt

- P1 opening, `2026-08-27T20:41:39Z`: A free `74,526,621,696` bytes; C free
  approximately `4.21` GB.
- Full-suite opening, `2026-08-27T20:55:10Z`: A free `74,526,892,032` bytes; C
  free `4,043,587,584` bytes.
- Between base suites, `2026-08-27T21:01:41Z`: A free `74,525,257,728` bytes; C
  free `3,907,489,792` bytes.
- After candidate suites, `2026-08-27T21:06:15Z`: A free `74,510,737,408` bytes;
  C free `3,873,587,200` bytes. C remained above the standing 3 GiB stop floor;
  P1 intentionally wrote no project or evidence bytes there.
- The exact production identity endpoint used by P0 was
  `https://www.mustaflow.com/api/version`.

The final clean-head gate, preview navigation capture, branch absence proofs and
closing drive readings are phase-gate evidence and are not pre-claimed by this
candidate record.

### P3 exact-base verification receipt

Tag: `ADMIN-PAGE-REBUILD-P3-GATE-2026-08-28`

Database: none. Environment: lab. Store: `A:/NabuFlowLab/.pnpm-store/v10`.
Kind: serial test and static verification. All runs used the one permanent
`A:/NabuFlowLab/work` tree; no install and no additional worktree were created.

- Exact base: `e97467734f9337b2c30e434e729de1d1061a1ba1`, tree
  `f7f6e7e4ff96833755444df96795126d1350231a`.
- Candidate before this evidence-only document update:
  `6d09c745d3d8d6a857ec6fed60a1e3857791b5c1`, tree
  `7f91dd92dd877adaf90c10491f8eb3453e1b6193`.
- Focused API verification: 2 files, 11 tests, all passed.
- Focused web verification: 3 files, 15 tests, all passed.
- Shared-library, API, web, and test-inclusive web typechecks: passed.
- Changed-file ESLint: passed. Changed-file Prettier: passed.
- Secret-pattern scan: zero matches. Manifest and lockfile delta: zero.
- Base API: 41 failed, 3,027 passed, 5 pending tests across 282 files.
- Candidate API: 41 failed, 3,032 passed, 5 pending tests across 283 files.
- Normalized API failure identity: 41 entries on each side; SHA-256
  `9b019f950c203d9cf6e9e59e7a03cafb3e607ef68442a71949cb3ddbd8f8a118`
  on each side; base-only 0, candidate-only 0. Candidate adds five passing
  API guards and no failure.
- Base web: 131 files, 1,211 tests passed, zero failed.
- Candidate web: 132 files, 1,219 tests passed, zero failed. Candidate adds
  one file and eight passing web guards.
- Opening free-space receipt at `2026-08-28T13:09:33.8719214Z`: A free
  `74,516,172,800` bytes; C free `3,985,035,264` bytes.
- Post-suite receipt at `2026-08-28T13:38:36.9395461Z`: A free
  `74,507,186,176` bytes; C free `3,980,894,208` bytes. C remained above the
  standing `3,221,225,472`-byte stop floor.

### P3 incidental finding and prevention

The full API suite intentionally exits nonzero because the exact base contains
41 known environment-gated failures. `pnpm --dir ... exec vitest` nevertheless
wrote a complete JSON report and then printed an additional misleading
`Command "vitest" not found` wrapper message. A clean retry reproduced the exact
same 41-entry failure set and fingerprint, proving that the post-report message
belongs to the pnpm command wrapper rather than to a missing Vitest binary or a
new product failure. Prevention: exact-base comparisons consume the complete
JSON receipt, require a stable normalized failure fingerprint across base and
candidate, and never treat the wrapper exit or prose alone as suite truth.

P3 is source- and suite-complete but not yet live-complete. The remaining gate
is the exact merged-head release gate, production tree-identity proof, live
four-card drill-in walkthrough, screenshots, and branch cleanup.

### P3 live closure

P3 closed live on production on 2026-08-28. The merged-head 22-check gate passed
22/22 in the development workspace. Production `/api/version` returned commit
`1f8b6999f659c998d8b151c61c895741f0947df1` and tree
`e21ce8e5a8f14160af052e994082c1189d666f2b`; `/api/healthz` returned HTTP 200
with every subsystem `ok` on three consecutive probes. The Projects, Published,
Credit accounts and Transactions cards each opened their bounded record surface;
the IRQ TEL filter resolved Project 52 in workspace 5; identities remained masked;
and project entry remained consent-gated. The local and remote P3 branches were
deleted and proven absent, and the permanent A-drive tree returned clean to main.

### P3 lab release-gate boundary

The release profile ran on the exact merged candidate tree with database
`none`. It completed 22 checks with `pass=19`, `warn=0`, `fail=3`. Every
failure was database-bound and named the same unavailable lab endpoint,
`ECONNREFUSED 127.0.0.1:5432`:

- `api-release-extended`: environment-gated realtime usage tests.
- `api-account-billing-history`: environment-gated memory/account tests.
- `web-build`: the static bundle and public entry budget passed, then dynamic
  route prerendering required the unavailable database.

This is consistent with the exact-base API failure set already proven equal;
it is not promoted to a pass. The publish remains blocked until the same
22-check gate passes on the exact GitHub head inside Replit's development
workspace, where the development test database is present. Prevention: a lab
release-gate receipt always names its database and cannot authorize publish
when a database-bound check did not execute successfully.

## P4 — one Admin authority source

P4 replaces three request-time authority paths with one typed resolver over
`user_roles`. The former billing/account allowlist no longer imports into Admin
authorization and is named `billing-privileges`; its API and UI fields likewise
describe billing privilege rather than a platform-wide superuser. `ADMIN_USER_IDS`
is read only by the guarded boot reconciliation. It may create the first Owner only
when the role ledger is empty, then migrates each resolved legacy identity into the
ledger with one durable receipt. Every existing Owner receives an idempotent
presence-proof receipt. The reconciliation is serialized by a transaction-scoped
advisory lock, verifies at least one final Owner, rolls back on failure, and never
reopens a request-time fallback.

Admin Me now returns `authoritySource: user_roles`; Launch Readiness passes only on
live staff rows; and the Admin and Trust surfaces name the same ledger. Last-Owner
protection remains unchanged. No schema or migration-count change is introduced;
the existing `user_roles` and `admin_access_receipts` tables carry the transition.

### P4 lab verification

Database: none. Environment: lab. Store: `A:/NabuFlowLab/.pnpm-store/v10`.
Kind: serial test and static verification in the one permanent A-drive tree.

- New and related focused API tests: 9 files, 123 tests passed.
- P4 authority tests: 5 files, 15 tests passed, including the dormant-export gate.
- Admin UI focused tests: 1 file, 3 tests passed.
- Root typecheck and root lint passed.
- API exact-base parity against the live P3 source: base 41 failed / 3,032 passed /
  5 pending; candidate 41 failed / 3,037 passed / 5 pending; normalized added
  failures 0 and removed failures 0. Failure fingerprint:
  `8618bbc6a1ea44f0a4cf949012a04452563f71bb4bb647a83342e8512e0ee77f`.
- Web exact-base parity: base 1,219 passed / 0 failed; candidate 1,220 passed /
  0 failed.
- Full-suite opening at `2026-08-28T14:29:55.9987449Z`: C free
  `3,968,466,944` bytes; A free `74,502,230,016` bytes. Closing at
  `2026-08-28T14:35:25.1023497Z`: C free `3,966,398,464` bytes; A free
  `74,499,145,728` bytes. C remained above the standing floor.

P4 is source- and lab-gate complete. Live closure still requires a pre-publish
receipt proving an Owner already exists in production, the exact merged-head gate,
boot reconciliation receipts, production tree identity, and an Owner/nonstaff
cross-panel walkthrough.

### P4 incidental finding and prevention

The first candidate full API run exposed one new dormant-export failure:
`isBillingPrivilegedSync` had been renamed but was not consumed by production code.
It was removed rather than declared dormant. The dedicated reachability guard then
passed, and the full suite returned to exact-base failure parity. This is the
preventive: new runtime exports must have a production consumer or be explicitly
declared dormant; an unused privilege predicate cannot quietly become a second
authority surface.

The first exact merged-head release gate then rejected the two Ora account-
consistency files changed by the billing-privilege rename because the feature
registry's billing-plan declaration did not name that route family. The registry
now explicitly owns `ora-account-consistency`, so every future change to that
cross-product billing view is routed through the account/billing manual checklist
instead of passing as an unmatched Ora change.
