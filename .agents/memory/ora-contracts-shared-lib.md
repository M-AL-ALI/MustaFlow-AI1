---
name: Ora shared contracts lib
description: Why the Ora chat wire contract lives in @workspace/ora-contracts and how mobile/server consume it
---

The canonical Ora chat message wire contract (the zod message schema, its
sub-schemas, and the inferred TS types/scalar unions) lives in one shared lib,
`@workspace/ora-contracts`. Both server route validators and the mobile client
consume it instead of re-declaring the shapes.

**Why:** the schema was previously duplicated between the two server route files
and re-described by hand on the mobile client. Drift between them is silent — a
field missing from one copy is just dropped on save with no error. A single
source of truth removes that failure mode, and the mobile rebuild requires the
app to mirror the website message model exactly.

**How to apply:**
- Add any new persisted message field to the schema (and its inferred type) in
  the lib, then run `pnpm run typecheck:libs` before the leaf typechecks. Never
  add it to the route files directly.
- Storage/enforcement caps (max stored messages, payload bytes, title/name
  lengths) intentionally stay local to each route — they are policy, not wire
  shape, and must not move into the shared lib.
- Mobile must consume the lib **type-only** (`export type`/`import type`), never
  a value import. Metro runs the bare default config (no monorepo
  `watchFolders`), so it cannot bundle a workspace package's source; type-only
  imports are erased before Metro sees them. Keep zod a server/lib runtime dep
  only — it must never reach the RN bundle.
