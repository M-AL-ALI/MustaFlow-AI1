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

| Phase | Scope                                                      | State                    |
| ----- | ---------------------------------------------------------- | ------------------------ |
| P0    | Read-only survey and owed identity decisions               | Accepted                 |
| P1    | Shell, navigation and KEEP-panel hierarchy                 | Authorized / in progress |
| P2    | Panel declarations and developer-tool exile                | Not authorized           |
| P3    | Drill-in for every number                                  | Not authorized           |
| P4    | One Admin authority source                                 | Planned only             |
| P5    | In-product and email consent delivery                      | Not authorized           |
| P6    | Ticket identity, ownership and resolution                  | Not authorized           |
| P7    | Per-project invitations, members, roles and presence       | Not authorized           |
| P8    | Ticket-to-Zero and completed triage                        | Not authorized           |
| P9    | Serving-tree operator walkthrough and documentation parity | Not authorized           |

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

## P4 authority amendment — planning only

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

This amendment is recorded here but must not be implemented before P4 authorization.

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

| Finding                                          | Preventive measure                                                                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Wrong-framework support proposal                 | Primary-artifact/format/stack binding, architecture validation, one bounded retry, and refusal instead of an unsafe proposal |
| Expired grant displayed active                   | One canonical clock-aware effective-status reader with contract tests                                                        |
| Control-character regex failed lint              | Codepoint sanitizer, regression test and release-gate lint                                                                   |
| In-progress publish treated as potential failure | Never retry or classify without a terminal deployment receipt                                                                |
| Three competing Admin authority sources          | P4 single typed resolver and cross-panel consistency tests                                                                   |
| Superuser source mislabeled as environment       | Remove competing authority rather than relabel it                                                                            |
| Customer project-state contradiction             | Parked; proposed single derived state contract and one presenter                                                             |
| Unreceipted A-drive reduction                    | Pair every phase with free-space receipts; account by metadata before any cleanup                                            |

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
