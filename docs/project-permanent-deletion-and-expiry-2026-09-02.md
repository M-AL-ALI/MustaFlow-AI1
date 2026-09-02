# Governed project permanent deletion and expiry

Date: 2026-09-02
Status: branch candidate validation in progress; publication and live acceptance are not yet claimed
Database: none for isolated tests; the release-gate and production database identities are recorded only after they run
Environment: `A:/NabuFlowLab/work`
Store: `A:/NabuFlowLab/.pnpm-store`
Kind: project lifecycle, durable deletion coordination, provider reconciliation, notifications, and owner UI

## User contract

Every NabuFlow project owner receives the same two lifecycle choices. Neither choice is an admin-only capability.

- **Move to Trash** is recoverable for 30 days. It retires serving routes and paid runtime resources, blocks all new project work, and preserves restorable project material.
- **Delete permanently** is irreversible. It is available only from Trash after retirement has completed, requires the exact project name and a recent Clerk first-factor verification, and removes all NabuFlow-owned content and infrastructure.

Purchased domain registrations and external GitHub repositories are never destroyed by project deletion. Their NabuFlow bindings, credentials, tokens, and local metadata are removed; the externally owned resource remains with its owner.

The same durable coordinator executes both an owner-requested deletion and automatic deletion at the end of the recovery window. A project cannot be reported permanently deleted until relational and provider absence evidence has been validated and committed to a privacy-minimal terminal receipt.

## Owner flow

1. The owner moves an active project to Trash.
2. The existing retirement coordinator fences new work, removes serving state and runtimes, and proves retirement completion.
3. A durable purge operation records the database-clock due time. The owner sees a live countdown, retirement state, purge state, and the operation stage.
4. The platform creates in-product and email receipts when the project enters Trash, seven days before deletion, one day before deletion, and after permanent deletion.
5. The owner may restore only while the purge operation is still `scheduled`. Restore atomically cancels that schedule under the shared project-lifecycle lock.
6. The owner may choose **Delete permanently** once retirement is complete. The impact dialog distinguishes resources that will be deleted from resources that will only be detached.
7. The owner types the exact project name. Clerk performs recent first-factor reverification; the API independently validates the signed session age.
8. A bounded idempotent request admits one durable deletion identity. Refreshing the page recovers the same operation and its stage from the server.
9. The UI never calls a dismiss button “Cancel” after deletion has been admitted. Closing the dialog truthfully leaves deletion running in the background.
10. Success copy is reachable only after the status endpoint returns parsed terminal absence evidence.

## Durable receipt and state machine

`project_purge_operations` is an additive table with no foreign key to `projects`, because the receipt must survive deletion of the row it proves was removed. It stores identifiers and hashes, not source, secrets, a project name, provider response bodies, or other project content.

The closed states are:

- `scheduled`
- `accepted`
- `running`
- `failed`
- `completed`
- `canceled`

The closed stages are:

- `verify`
- `inventory`
- `assets`
- `snapshots`
- `database`
- `addons`
- `runtime`
- `relational`
- `absence`

Each worker claim has an attempt count, lease version, lease expiry, bounded retry time, and terminal evidence rules enforced by database constraints and a parser. Manual idempotency keys and requester identities are SHA-256 hashes scoped to the user and project. Automatic expiry derives a stable hash from the retirement identity. Scheduled and manual paths converge on the same operation runner.

## Admission and lifecycle authority

- Owner predicates are evaluated in the database. A collaborator, staff member without ownership, or hostile project identifier receives the same non-revealing not-found result.
- The exact project name comparison is server-side.
- The server reads Clerk's authenticated actor, session identifier, first-factor verification timestamp, and current session age. UI state, PATs, test headers, and caller-supplied timestamps cannot satisfy reverification.
- The project must be tombstoned and its newest retirement receipt must carry current completion evidence.
- Manual and scheduled deletion, Trash, Restore, deployment, task, file-write, provider-allocation, and purge workers share one project lifecycle advisory-lock namespace.
- Restore is allowed only while the newest purge operation remains `scheduled`. `accepted`, `running`, `failed`, and `completed` operations make restoration unavailable.

## Inventory and deletion policy

Before provider mutation, the coordinator reads the live PostgreSQL catalog for every public `project_id` and `source_project_id` column. Each non-cascading reference must be declared in the project-reference policy. An unknown table or delete action stops deletion before provider work.

The policy distinguishes:

- project-owned rows that are deleted directly;
- child rows deleted through an owning parent;
- account or product records whose project link is set to null;
- the purge receipt that must remain;
- unrelated product-local identifiers that happen to use the same column name.

Provider work is bounded and lease-fenced. A worker checkpoints progress, renews its lease between bounded pages, and carries the expected lease version into the final relational transaction. A stale worker cannot delete rows or terminalize after another worker has acquired the operation.

### Assets and object storage

- Project-owned unified assets are inventoried with their durable usage references.
- An R2 object is physically removed only when no durable reference outside the project survives. The final-reference path locks the asset row, rechecks after acquiring the lock, and changes the asset to the non-attachable `deleting` state before provider deletion. A competing reference either commits first and is preserved or arrives afterward and is rejected by the database trigger.
- Legacy upload paths mirrored into the unified asset registry receive the same shared-reference check; they cannot bypass reference-count protection through the legacy deletion loop.
- Legacy generated-image, upload, and database-snapshot keys receive an immediate cross-store reference check before physical deletion. Provider absence is then proved after deletion.
- Incomplete `reserved`, `uploading`, or `rejected` assets use the same guarded deletion claim, so an abandoned upload cannot trap a project in Trash.
- Filesystem-backed development objects are removed only in the development backend; production R2 paths use governed provider helpers.

### Databases, add-ons, and runtimes

- Project-owned production and preview Neon databases are listed, deleted, and queried again for absence. Exact bounded fallback discovery covers both stable names, `mf-project-{id}` and `mf-preview-{id}`, when a stored pointer is missing or stale.
- A missing or incompatible production-database capability is a typed failure, never a silent success.
- Managed add-on bindings, credentials, and project ownership are reconciled idempotently; an unknown provider fails closed.
- SQLite projects first receive the governed recovery material needed for Trash restoration before runtime retirement, so choosing SQLite does not remove the owner's lifecycle rights.
- Retirement evidence remains authoritative for preview, blue, green, route, certificate, cache, and runtime absence.

### External ownership boundaries

- Purchased-domain rows retain the registration and account ownership while their project binding is detached.
- The local GitHub connection, encrypted token, webhook, and NabuFlow metadata are removed. No API call deletes the external repository.
- Project support evidence, invitations, share links, secrets, source, versions, tasks, logs, and NabuFlow integration credentials are deleted.

## Notifications

The existing notifications table is the durable in-product channel. A partial unique index gives each operation/milestone/recipient one receipt. Email is an independent bounded delivery channel:

- three attempts maximum;
- a database-clock claim lease prevents concurrent duplicate sends;
- a stable provider idempotency key makes crash-after-send recovery safe;
- a 90-second send timeout prevents a mail provider from blocking the scheduler;
- failure to send email does not falsify project deletion state.

The recipient path is preserved before project-owned rows are removed. After deletion, the completion notice contains no project name or content.

## Preventive controls

1. A real-app route-prefix regression proves the operation-status endpoint survives the pre-auth 404 guard before the authenticated router mount.
2. Schema-derived catalog tests cover the actual public project-shaped columns, including unrelated Orax identifiers.
3. Shared-object tests prove a legacy upload mirror cannot delete bytes retained by another project.
4. Lease-version compare-and-set tests prove an expired worker cannot finalize after a successor claim.
5. Provider capability and absence tests make missing configuration fail closed.
6. UI tests cover refresh recovery, live countdown, exact-name confirmation, Clerk reverification, truthful Close semantics, retryable versus exhausted failure copy, mobile long-name wrapping, and accessible async state.
7. Migration tests run the additive DDL twice and verify the deployment runtime schema contract.
8. A release test fails if the Trash UI promises automatic deletion without the scheduler and worker registration.
9. Full API and web suites are run serially and judged by normalized failure-set parity against the exact base.
10. Every route that can move a project to Trash requires both the retirement worker and the purge scheduler/worker before mutation, so the 30-day promise cannot be made while automatic deletion is unavailable.
11. The deployment-readiness contract requires all 21 purge-receipt columns, including `resource_progress`; a resumability-incomplete deployment cannot report ready.
12. The live catalog records the foreign-key count and referenced schema, table, and column. A same-named cascade is accepted only when it is the sole foreign key and targets `public.projects(id)`.
13. The Trash countdown anchors to database time and advances with a monotonic browser timer. A wrong device clock cannot falsify the recovery window.
14. The impact preview queries purchased-domain and GitHub bindings and lists only detachment categories that actually exist for that project.
15. Exact-name stable Neon discovery tests prove both production and preview resources are included even when ownership pointers are absent.
16. A dedicated race regression inserts a surviving reference after inventory and proves no R2 delete call can occur.

## Incidental findings

The related findings below are closed in the branch candidate; live closure is recorded separately after publication.

- **Operation status route hidden by the pre-auth guard:** the real `/api/project-purge-operations/` prefix is admitted, with an app-level route regression.
- **Incomplete project-reference census:** the policy covers the production catalog and treats Orax project-shaped columns as another product. The catalog now also verifies the exact foreign-key target and count.
- **Shared legacy object bypass:** uploads, generated images, snapshots, and unified assets receive final-reference checks. Unified assets additionally use the row-lock/state-transition barrier described above.
- **Fail-open provider capability:** database and runtime release paths require a supported destructive capability and provider absence proof.
- **Unbounded work and stale workers:** provider work is paged, progress is durable, leases heartbeat between pages, and the final transaction compares the lease version.
- **Refresh lost destructive progress:** Trash reloads the durable operation and stage; accepted work remains visible after a refresh.
- **False Cancel wording:** an admitted deletion can only be closed from view; the UI never implies the background operation was canceled.
- **SQLite and managed add-on lifecycle inequality:** SQLite receives recovery material before retirement, while add-ons are detached and absence-proved instead of being refused categorically.
- **Automatic deletion could be promised with no purge worker:** both owner and admin Trash admissions now require retirement and purge worker readiness before mutation.
- **Production Neon fallback omitted:** exact discovery now covers both production and preview stable names.
- **Deployment readiness omitted resumable progress:** `resource_progress` is now required by the 21-column readiness contract.
- **Browser-clock countdown:** the display is anchored to the database clock and advanced monotonically.
- **Generic external-detachment copy:** the impact endpoint now derives domain and GitHub categories from actual bindings.
- **Incomplete upload could block deletion:** all non-deleted asset states are claimable under the same attachment-excluding lock.

## Verification and live evidence

No publication, migration, provider mutation, production database mutation, or live owner deletion is claimed by this in-progress record.

Candidate receipts earned so far, all with `DATABASE=NONE`, `ENVIRONMENT=lab`, and store `A:/NabuFlowLab/.pnpm-store`:

- exact base and current remote `main`: `cdef9640afedd92b1e559cddefe39f2f2efc41f9`, tree `125ff0e57a8d3319ce006f69b3ddd49740ac3831`;
- generated OpenAPI clients plus shared-library typecheck: pass;
- touched API family: 20 files, 288 tests passed, zero failed, serial;
- Trash UI family: 1 file, 12 tests passed, zero failed, serial;
- API typecheck: pass;
- web typecheck: pass;
- manifest and lockfile delta: zero.

Exact candidate tip/tree, per-file SHA-256, full serial parity, merged-head gate, production boot count, named production database receipts, provider absence receipts, live screenshots, and branch cleanup evidence are written only after they exist.
