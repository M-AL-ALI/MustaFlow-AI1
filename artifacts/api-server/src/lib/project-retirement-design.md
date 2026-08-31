# Governed project retirement coordinator

Project deletion is a recoverable Trash operation for source and user data, but
it is a terminal cost boundary for running infrastructure.

## Durable authority

`project_retirement_operations` is the durable receipt. In one database
transaction the shared retirement mutation acquires the project lifecycle
advisory lock, writes `projects.deleted_at`, inserts the accepted operation,
disables deployment schedules, and records activity provenance. The owner
DELETE route and bounded admin-only exact-ID batch both use this mutation. They
return HTTP 202 and operation ids; neither claims provider cleanup completed
synchronously. Project 51 has no code-level exception: retaining it is a caller
selection, not a hidden policy.

The pg-boss worker is bounded to four total attempts. Accepted and retryable
failed rows are re-enqueued after startup and once per minute, so an enqueue
transport failure cannot strand a tombstone. A ten-minute renewable lease and
monotonic fencing version allow a crashed `running` operation to be reclaimed
without allowing the previous worker to complete database cleanup. Progress is
persisted after every step. The typed status route is a pure read.

At boot, a bounded idempotent adoption pass creates deterministic receipts for
legacy soft-deleted projects that predate this table. Repeated boots create zero
duplicates. This means the first production boot after the migration may enqueue
cleanup for existing Trash projects; it does not restore or wake them.

## Ordered idempotent cleanup

1. Re-read the tombstone. A restored project cancels an operation before work.
2. Cancel every resumable/executing/staged task state with awaited telemetry,
   idempotent credit refunds, and an interrupted terminal. Abort local preview
   provisioning and disable deployment schedules. All worker starts,
   cross-replica job claims and heartbeats, queue drains, and atomic file writes
   independently deny a tombstoned project.
3. Strict-delete and authoritative-read the production slug, staging slug,
   legacy custom domain, and every `project_domains` hostname, then deactivate
   the exact sealed production route when a release receipt exists. Purge the
   corresponding edge cache fail-closed. Per-hostname and cache outcomes are
   durable evidence; transport ambiguity is never absence. Preview, share, and
   custom-domain reads independently reject a tombstoned project immediately.
4. Strict-delete and authoritative-read every Cloudflare custom-hostname
   certificate. Only after absence is proven is its provider id cleared and SSL
   marked pending; hostname/DNS configuration and purchased-domain assignment
   remain in Trash for restore. Purchased-domain registration and billing also
   continue during the recovery window.
5. Derive, destroy, and status-verify absence for preview/primary.
6. Derive, destroy, and status-verify absence for production/blue.
7. Derive, destroy, and status-verify absence for production/green.
8. Classify stored runtime pointers against provider, deployment namespace,
   project, role, and slot. Current valid pointers correspond to the derived
   targets above. Malformed, cross-namespace, cross-project, wrong-role, or
   legacy-provider pointers are retained verbatim as typed partial-terminal
   evidence; they are never passed to Fly or falsely cleared.
9. Clear each current runtime pointer and published-route pointers only after
   its absence proof.
10. Persist the completed receipt, or the explicit
    `project_retirement_legacy_runtime_retained` partial terminal.

Source files, versions, assets, secrets, database data, and all other project
rows remain for Trash recovery. Restore refuses while cleanup is accepted or
running. After completed cleanup it only clears the tombstone; it never republishes,
recreates, wakes, or starts infrastructure.

## Failure contract

Every failure carries one of the closed `PROJECT_RETIREMENT_FAILURE_CODES` and
the exact runtime target where relevant. A provider status response after
destroy is not absence and produces
`project_retirement_runtime_destroy_unverified`. The legacy Snapshot-Worker KV
surface is explicitly `not_configured` when edge serving is disabled and no KV
namespace exists; current production routes are still inventoried and retired
through the runtime Control Durable Object. A configured, required, or partial
legacy KV surface remains strict: missing bindings produce
`project_retirement_operation_unavailable`, and ambiguous inventory or deletion
never counts as absence.
