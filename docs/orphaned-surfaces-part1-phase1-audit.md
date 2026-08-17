# Orphaned Surfaces, Part 1 — Phase 1 Audit

Audit time: 2026-08-17T15:22:33-08:00

Verified base: `4ccc4230b35f7ed77b0fbf2df024b4ba257a9e42`

Scope: read-only web reachability audit before the Help & Support wiring change.

## Executive finding

Help & Support is an implemented, working, dual-audience surface. `/help` is registered in both
the authenticated application and the lightweight public application. The signed-out experience
offers Help Center content and `support@mustaflow.com`; the signed-in experience offers Ora
Support, escalation to a tracked support ticket, and the same guides/FAQs. The production route
returned HTTP 200 anonymously and rendered correctly in an existing signed-in Chrome session.

The defect is reachability, not Help functionality: the active Builder `SlideOutNav` has no Help
entry. The older, now-unmounted `Sidebar` still contains `Help Center` under its Resources group,
and `docs/changelog.md` explicitly records “Sidebar footer links + Help Center in RESOURCES
section.” Ora and the public header retained their Help links when the Builder changed navigation
shells; the Builder did not. Phase 2 therefore adds one `/help` entry to the active Builder drawer.

No other orphan is changed in this slice.

## Route registry

`App.tsx` registers 59 paths (including the catch-all separately); `PublicApp.tsx` registers 19
public paths. The 59 explicit full-app paths are:

```text
/
/sign-in/*?
/sign-up/*?
/login
/mode-select
/ora/library
/ora/settings
/ora/memory
/ora/projects/new
/ora/projects/:projectId
/ora
/orax
/orax-product
/orax/devices
/orax/desktop-auth/approve
/orax/workspace/:projectId
/orax/workspace
/projects
/projects/new
/projects/:id
/knowledge
/vault
/memory
/library
/settings
/admin/support
/admin
/trash
/billing/:section?
/image-studio
/published
/integrations
/security
/learn
/workspaces/:id/usage
/workspaces/:id/domains
/workspaces/:id/audit
/account/domains
/orgs/invites/:token
/orgs/new
/orgs/:orgId
/gallery/:slug
/gallery
/extensions
/community
/u/:username
/pricing
/terms
/privacy
/billing-refunds
/acceptable-use
/help
/help/domains-api
/support/tickets/:id
/support/tickets
/status
/trust
/developers/changelog
/developers
```

The 19 public-app paths are `/`, `/gallery/:slug`, `/gallery`, `/pricing`, `/community`,
`/u/:username`, `/trust`, `/extensions`, `/developers/changelog`, `/developers`,
`/help/domains-api`, `/help`, `/status`, `/privacy`, `/terms`, `/billing-refunds`,
`/acceptable-use`, `/sign-in`, and `/sign-up`.

## Page/component census

There are 174 non-test `.tsx` files under `src/pages/`:

- 54 direct route page modules imported by `App.tsx` and/or `PublicApp.tsx`.
- 8 routed Billing & Usage child modules under `pages/billing-usage/`.
- 87 routed project-workspace child components under `pages/projects/components/`.
- 20 Developer Mode child components under `pages/dev-workspace/components/`.
- 5 page roots with no registered route: `billing.tsx`, `dev-home.tsx`,
  `dev-deployments.tsx`, `dev-workspace/index.tsx`, and `docs-developer-mode.tsx`.

The exact 174-file census and category for every file is preserved in
`docs/evidence/orphaned-surfaces-part1/page-component-inventory.txt`.

The 54 routed page modules are:

```text
acceptable-use; account/domains; admin; billing-refunds; billing-usage; community;
developers; developers-changelog; extensions; gallery; gallery-detail; help;
help-domains-api; home; image-studio; integrations; knowledge; learn; library; memory;
mode-select; not-found; ora; ora-library; ora-memory; ora-new-project; ora-settings; orax;
orax-desktop-auth-approve; orax-devices; orax-product; orax-workspace; org-invite-accept;
org-new; org-settings; pricing; privacy; projects; projects/[id]; projects/new; published;
security; settings; status; support-inbox; support-tickets; terms; trash; trust; u; vault;
workspace-audit; workspace-domains; workspace-usage
```

## Navigation surfaces

| Surface                                             | Current Help reachability                                                                        | Design evidence                                                                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Active authenticated Builder drawer (`SlideOutNav`) | **Missing**                                                                                      | It replaced the old Builder sidebar but dropped the old Resources/Help entry. This is the defect fixed in Part 1.               |
| Ora sidebar                                         | `Help Center`, `Report Issue`, and `My Support Tickets` are present                              | Existing tests pin all three destinations.                                                                                      |
| Signed-out public header                            | `Help` links to `/help`                                                                          | Live anonymous route and `PublicApp` both support it.                                                                           |
| Signed-out home header                              | `Help` links to `/help`                                                                          | Same public destination.                                                                                                        |
| Help/support chrome                                 | Signed-out gets `PublicHeader`; signed-in gets a neutral `Help & Support` header and Back to Ora | Deliberately not Builder-branded; support-ticket pages use the same chrome.                                                     |
| Legal footer                                        | Legal links plus `Contact` mailto                                                                | This already provides contact routing. Adding a second Help link is not required by the evidence and is out of the minimal fix. |
| Legacy `Sidebar`                                    | `Help Center` and `Domains & API` under Resources                                                | Component is unmounted; it is historical design evidence, not a live entry point.                                               |

## Orphan inventory

Severity is launch severity, not implementation quality.

| Surface                                        | Location                                                                                                             | Route?                                     | Live entry point?                                                                                        | Apparently intended?                                             | Severity | Disposition              |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------- | ------------------------ |
| Help & Support                                 | `pages/help.tsx`                                                                                                     | `/help` in full and public apps            | Public header and Ora only; **missing from Builder drawer**                                              | Yes; changelog and legacy Resources nav are explicit             | **High** | Fix in Part 1            |
| Published Projects                             | `pages/published.tsx`                                                                                                | `/published`                               | Only the unmounted legacy Sidebar                                                                        | Yes; complete user-facing page                                   | High     | Finding only             |
| Trash                                          | `pages/trash.tsx`                                                                                                    | `/trash`                                   | No live inbound UI link found                                                                            | Yes; complete restore/delete surface                             | Medium   | Finding only             |
| Learn                                          | `pages/learn.tsx`                                                                                                    | `/learn`                                   | Only the unmounted legacy Sidebar                                                                        | Yes; complete learning hub                                       | Medium   | Finding only             |
| Community + Gallery cluster                    | `pages/community.tsx`, `gallery.tsx`, `gallery-detail.tsx`                                                           | `/community`, `/gallery`, `/gallery/:slug` | Pages cross-link, but no current global nav seeds the cluster; Learn would, but Learn is itself orphaned | Yes; public ecosystem surfaces                                   | Medium   | Finding only             |
| Extensions marketplace                         | `pages/extensions.tsx`                                                                                               | `/extensions` in full and public apps      | No live inbound UI link found                                                                            | Yes; complete marketplace/install surface                        | Medium   | Finding only             |
| Account Domains                                | `pages/account/domains.tsx`                                                                                          | `/account/domains`                         | No live inbound UI link; only its own payment return URLs refer back                                     | Yes; paid domain portfolio surface                               | High     | Finding only             |
| Workspace Usage                                | `pages/workspace-usage.tsx`                                                                                          | `/workspaces/:id/usage`                    | No live inbound UI link found                                                                            | Yes                                                              | Medium   | Finding only             |
| Workspace Domains                              | `pages/workspace-domains.tsx`                                                                                        | `/workspaces/:id/domains`                  | No live inbound UI link found                                                                            | Yes                                                              | High     | Finding only             |
| Workspace Audit                                | `pages/workspace-audit.tsx`                                                                                          | `/workspaces/:id/audit`                    | Reachable only from the otherwise-orphaned Workspace Domains page                                        | Yes                                                              | Medium   | Finding only             |
| ORAX workspace                                 | `pages/orax-workspace.tsx`                                                                                           | `/orax/workspace` and `/:projectId`        | No inbound ORAX/menu link found; only self-navigation after direct arrival                               | Appears intended                                                 | Medium   | Finding only             |
| Legacy billing page                            | `pages/billing.tsx`                                                                                                  | No                                         | No import or entry point                                                                                 | Apparently superseded by routed `billing-usage/index.tsx`        | Low      | Finding only             |
| Developer Mode home/deployments/workspace/docs | `dev-home.tsx`, `dev-deployments.tsx`, `dev-workspace/index.tsx`, `docs-developer-mode.tsx` plus 20 child components | No                                         | No                                                                                                       | Previously intended, but **PARKED by standing founder decision** | Parked   | Record only; do not wire |

### Contextual and callback routes that are not counted as orphans

Project detail, Knowledge, Memory, Library, admin support, support tickets, Domains & API,
organization settings, invite acceptance, gallery detail, user profiles, Trust/Status,
developer changelog, and ORAX desktop authorization all have contextual, workflow, or callback
entry paths appropriate to their purpose. They do not all belong in a global menu.

## Help surface verification

### Signed in (live production, read-only)

An existing authenticated Chrome session navigated directly to
`https://www.mustaflow.com/help/` and rendered:

- title `Help Center | MustaFlow AI`;
- neutral banner `Help & Support` with `Back to Ora`;
- searchable guides and FAQs;
- `Ask Ora — Support` with a report textbox and escalation wording;
- no Builder drawer inside the Help surface, as designed.

### Signed out (live production plus source contract, read-only)

An anonymous HTTP GET to `https://www.mustaflow.com/help` returned HTTP 200, redirected
canonically to `/help/`, content type `text/html; charset=utf-8`, and 9,424 bytes. The
lightweight `PublicApp` registers `/help` without Clerk. In the signed-out branch,
`help.tsx` renders Help Center articles and a contact panel linking
`mailto:support@mustaflow.com` plus Sign in. Ticket creation and ticket-list routes remain
signed-in-only.

## Phase 1 verdict

The design evidence supports one change only: add `Help & Support` → `/help` to the active
Builder drawer, inheriting the drawer's existing styling and signed-in permission boundary.
Public, Ora, legal/contact, and Help's own neutral chrome already satisfy their intended roles.

## Incidental findings

1. **Workspace back links point at an unregistered route.** All three workspace subpages link
   back to `/workspaces/:id`, but `App.tsx` registers only `/workspaces/:id/usage`, `/domains`,
   and `/audit`. Evidence: `workspace-usage.tsx:122`, `workspace-domains.tsx:310`, and
   `workspace-audit.tsx:130`. Out of scope; not fixed.
2. **The legacy Builder `Sidebar` is dead navigation code.** It contains several destinations
   absent from the mounted `SlideOutNav`, which explains multiple reachability regressions and
   makes future edits easy to apply to the wrong component. Out of scope; not fixed.
3. **A synthetic OpenAI-shaped secret literal appears committed.** `scripts/src/ora-stability-gate.ts`
   contains a contiguous `sk-...` test fallback despite the standing runtime-assembly rule for
   synthetic secret fixtures. It was encountered during audit only; not fixed.
4. **The full web suite has a stale evidence hash pin.** The checked-in
   `docs/evidence/wave-d33/production-task-140-inventory.json` hashes to
   `abe274dad9fc997a659f81cd78b8a6deb500b38adf9c76539f7f8d4d3b23cae6`, while
   `preview-reconciliation.test.ts` expects
   `ec751002f7eda3e8c4d1439ae2d2593886513bcbd3517508b6387d2c444d987f`. Both files are
   byte-unchanged from the verified base. Out of scope; not fixed.
5. **One Help API integration test mock predates confirmation mail.** The real route now invokes
   `supportTicketConfirmationTemplate` and sends a second email, while
   `help-escalation-integration.test.ts` mocks only the older template and asserts exactly one send.
   Three assertions fail on the unchanged base. Out of scope; not fixed.
6. **Three Help API isolation suites are not self-contained.** They import the database before
   installing a test database value and fail immediately when `DATABASE_URL` is absent. No
   founder secret was requested or read to make a source-only navigation change pass them. Out of
   scope; not fixed.
