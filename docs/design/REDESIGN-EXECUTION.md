# NabuFlow redesign execution

Status: implementation started. Not published or accepted as complete.

## Authority and boundaries

- The founder's September 8 "Start" authorizes the agreed end-to-end redesign.
- Sole reusable worktree: A:/NabuFlowLab/work.
- Branch: codex/nabuflow-redesign. No additional worktree.
- Preserve Project 51, existing application data, Ora isolation, allowlisted staff access, and governed deletion.
- Compare the existing separate Replit benchmark; do not continue building it.
- Evidence root: A:/NabuFlowLab/evidence/redesign-2026-09-08.
- Tests must name database, environment, store, and kind. No install: the lockfile is unchanged.
- Safe C cleanup only when needed, with literal verified targets. No personal data or active app state cleanup.

## Section acceptance

Every section requires comparison, implementation, focused design/code refactoring, tests, exact-head release verification, and live interaction evidence. A screenshot alone proves appearance, not working behavior. An unpublished implementation is not a completed section.

| Section                                | Current status                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------- |
| Arrival and onboarding                 | Pending; public MustaFlow/Ora identity intentionally unchanged                   |
| Dashboard and navigation               | First implementation wave; tests and live acceptance pending                     |
| Brainstorming and planning             | Existing panel retained; composer presentation improved, deeper workflow pending |
| Workspace and agent execution          | Pending                                                                          |
| Modes, advertised languages, and voice | Pending; text preservation is not agent language proof                           |
| Page Map                               | Initial code study completed; implementation pending                             |
| Preview and design tools               | Pending; dashboard previews are on-demand, not stored verified thumbnails        |
| Files and developer tools              | Pending                                                                          |
| Inline images and Image Studio         | Pending; no asset routing changes in this wave                                   |
| Database, authentication, integrations | Pending                                                                          |
| Testing and security                   | Per-wave regression coverage; whole-platform acceptance pending                  |
| Publishing and release identity        | Pending                                                                          |
| Domains: purchase and connection       | Pending                                                                          |
| Live management                        | Pending                                                                          |
| Billing, usage, settings               | Pending                                                                          |
| Trash, deletion, privacy               | Existing safeguards preserved; outstanding deletion acceptance not closed        |
| Whole-journey polish and accessibility | Pending                                                                          |

## Initial Page Map study

Files studied: API lib/page-map.ts and routes/page-map.ts; UI page-map-tab.tsx, page-map-card-model.ts, page-node.tsx, page-edge.tsx, page-detail-panel.tsx, and workspace integration.

1. Extraction only feeds HTML files to the model. It does not establish a reliable React/TSX route graph.
2. AI node metadata and heuristic edges are not evidence that a page or transition was exercised.
3. Manual Link/Unlink controls persist diagram edges; they do not modify the application navigation.
4. There is no revision/provenance/transition-condition contract or current-preview-route input.
5. Reanalysis writes a previously read map without a compare-and-swap fence, so concurrent layout edits need protection.
6. Planned-page matching strips non-ASCII letters from labels, creating an Arabic-label collision risk.
7. Canvas cards embed a file preview; content view cards have no real thumbnails. A file URL is not necessarily an SPA route.
8. Wiring warnings can describe an inferred missing edge as a definite broken app journey.
9. Sync completion follows a fetch, not proof that the latest generation was analyzed.
10. Platforms without extraction are explicitly unavailable and must remain honestly labeled.

Required direction: a source-backed route inventory; separate planned/built/verified states; labeled actions/conditions/roles on edges; validated per-page captures; contextual preview/edit navigation; stale-revision detection; account/project-scoped captures; and agent integration that preserves manual layout and notes. Research comparable products before any uniqueness claim.

## First-wave implementation and incidental findings

| Finding                                                                           | Change or preventive measure                                                                              | Acceptance                |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------- |
| Drawer links remain in the accessibility tree when visually off-screen            | Use a focus-managed modal Sheet with unmounted closed content; interaction test                           | Pending run               |
| Admin flag can survive an account change in component state                       | Shared account-scoped server evidence; abort and reject stale responses; fail closed and refresh on focus | Pending run               |
| Trash is hidden when no recent projects exist or summary fails                    | Permanent regular-user entry plus dashboard link in every state; tests                                    | Pending run               |
| Plan toggle changes appearance but not submission behavior                        | Remove inert toggle; retain an explicit brainstorming action; tests                                       | Pending run               |
| Attachment button and several category chips imply behavior they do not implement | Remove inert attachment affordance; expose actual web/mobile handoff and working example prompts          | Pending run               |
| Enter can submit a multiline/IME draft prematurely                                | Plain Enter remains multiline; explicit Continue or Ctrl/Cmd+Enter; tests                                 | Pending run               |
| Undefined health is displayed as zero                                             | Render health only when a finite numeric score exists; tests                                              | Pending run               |
| Cards nest action buttons inside a button-like card                               | Separate real navigation links, preview controls, and Trash action                                        | Pending run               |
| Activity errors look like an empty history                                        | Distinguish loading, unavailable, and empty history                                                       | Pending run               |
| Large hero and verbose activity push projects down the page                       | Compact composer, full-width project grid, collapsible activity, restrained scoped design tokens          | Visual comparison pending |

On-demand preview is an interim implementation, not completion of the automatic project-thumbnail requirement. It mounts at most one sandboxed frame after explicit intent and never treats iframe load as health evidence. Production access and failure states still require live acceptance. A durable capture pipeline with build revision, capture time, route, authenticated-page policy, and safe invalidation remains open.

The local design-preview.html uses the same dashboard/composer components with conspicuously labeled illustrative fixtures. Its sample app is not the UB Ride benchmark and does not prove that benchmark builds.
