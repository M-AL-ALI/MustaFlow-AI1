# Orphaned Surfaces, Part 1 — Help & Support Delivery Report

Date: 2026-08-17

Branch: `codex/help-support-reachability`

Verified base: `4ccc4230b35f7ed77b0fbf2df024b4ba257a9e42`

Production changes: none

## Outcome

Help & Support is now a first-class destination in the active authenticated Builder drawer. The
new item is labeled `Help & Support`, links to the already-existing `/help` route, uses the same
Lucide icon and mapped-item styling as its peers, and inherits the drawer's existing signed-in
boundary. The Help route, Help layout, support APIs, Ora navigation, public navigation, footer,
and Worker sources are untouched.

The complete read-only route/page audit and launch-severity inventory are in
`docs/orphaned-surfaces-part1-phase1-audit.md`; the exact 174-file page/component census is in
`docs/evidence/orphaned-surfaces-part1/page-component-inventory.txt`.

## Changed files

### Product

- `artifacts/mustaflow/src/components/layout/slide-out-nav.tsx` — exports the existing navigation
  registry for regression testing and appends `Help & Support` → `/help` with `LifeBuoy`.

### Tests

- `artifacts/mustaflow/src/components/layout/__tests__/slide-out-nav-help.test.ts` — pins one
  Builder entry, both full/public route registrations, and both signed-in/signed-out Help states.
- `artifacts/mustaflow/src/components/layout/__tests__/help-not-builder-feature.test.ts` — clarifies
  that Builder links to neutral Help but still never exposes the private support-ticket index.

### Documentation/evidence

- `docs/orphaned-surfaces-part1-phase1-audit.md` — durable Phase 1 audit, route registry,
  navigation analysis, orphan inventory, live route evidence, and incidental findings.
- `docs/evidence/orphaned-surfaces-part1/page-component-inventory.txt` — exact classification of
  every non-test `.tsx` page/component under `src/pages/`.
- `docs/orphaned-surfaces-part1-help-support-delivery-report.md` — this report.

## Why only the Builder drawer changed

- The original navigation design records Help in the Resources section.
- The old, unmounted Builder Sidebar still contains that entry.
- Ora already exposes Help Center, Report Issue, and My Support Tickets.
- Signed-out users already reach Help from both the public header and home header.
- The legal footer already provides direct `support@mustaflow.com` contact routing.
- Help deliberately uses neutral Help chrome for both products; adding Builder chrome inside Help
  would violate the existing isolation contract.

## Acceptance evidence

### Reachability and behavior

- Anonymous production `GET https://www.mustaflow.com/help` → HTTP 200, canonical `/help/`,
  `text/html; charset=utf-8`, 9,424 bytes.
- Authenticated Chrome direct navigation → `Help Center | MustaFlow AI`, `Help & Support` header,
  searchable FAQ/guides, Ora Support, escalation wording, and Back to Ora.
- Source contracts confirm signed-out contact through `mailto:support@mustaflow.com`, signed-in
  tracked ticket escalation, and `/help` registration in both app entries.

### Dependency proof

- `pnpm install --frozen-lockfile --offline` → exit 0; 2,259 packages linked; **0 downloaded**;
  lockfile resolution skipped; completed in 11m 4.8s.
- `pnpm run typecheck:libs` → exit 0.

### Green gates

- Focused Help/navigation web suite: **4 files, 22 tests passed**.
- Web typecheck after library build: exit 0.
- Web lint (`--max-warnings 0`): exit 0.
- Prettier check for every changed source/test/report file: exit 0.
- Vite production compilation: **4,075 modules transformed**, exit 0 for bundling; static
  prerender produced 13 routes including `/help`; public initial JS 320.3 kB / 2,048 kB budget.
- Help API selection: **6 files, 41 tests passed, 1 skipped** before the unchanged baseline faults
  below were reported.

### Baseline/environment failures (not caused or changed by this slice)

- Full web suite: **104/105 files and 1,060/1,061 tests passed**. The only failure is the stale
  `preview-reconciliation` evidence hash pin documented in Incidental Finding 4. The test and
  captured evidence are byte-unchanged from base.
- Help API selection: 3 suites fail during import because `DATABASE_URL` is intentionally absent;
  `help-escalation-integration` has 3 stale one-email assertions and a missing confirmation-template
  mock. All relevant sources are byte-unchanged from base.
- The Vite bundle and static prerender pass. The final dynamic-prerender postbuild step stops at
  the same explicit `DATABASE_URL must be set` environment guard. No credential was requested,
  read, synthesized, or written for this navigation-only slice.

These are recorded rather than repaired under the standing INCIDENTAL FINDINGS rule.

## Manifest and surface declaration

- `package.json` changes: none.
- `pnpm-lock.yaml` changes: none.
- Frozen-lockfile proof: green, offline, zero downloads.
- API contract/wire changes: none.
- Worker source changes: none.
- Fly changes: none.
- Live deploys, resources, routes, leases, spend: none.

## Orphan sequencing recommendation

After Help ships, sequence the remaining launch-significant surfaces independently:

1. Account Domains and Workspace Domains/Usage/Audit (including the broken `/workspaces/:id`
   return target).
2. Published Projects and Trash.
3. Learn → Community/Gallery ecosystem cluster.
4. Extensions marketplace.
5. ORAX workspace reachability.
6. Remove or formally archive the superseded billing page and unmounted Sidebar.

Developer Mode remains PARKED and must not enter that sequence without a new founder decision.

## Incidental findings

1. Workspace subpage back links target an unregistered `/workspaces/:id` route.
2. The unmounted legacy Sidebar is dead navigation code and a recurring wrong-edit hazard.
3. A committed stability-gate fallback contains a contiguous OpenAI-shaped synthetic secret
   literal, contrary to the standing runtime-assembly-at-test rule.
4. The full web suite's production-capture SHA pin does not match the byte-unchanged evidence file.
5. The Help escalation integration mock/assertions predate the second confirmation email.
6. Three Help API isolation suites require an external `DATABASE_URL` before test setup.

All six are evidence-backed in the Phase 1 audit. None was fixed in this Help-only slice.

## Handoff identity

The exact remote branch tip is recorded after push in the final handoff; the implementation and
documents in this report are delivered together on `codex/help-support-reachability`.
