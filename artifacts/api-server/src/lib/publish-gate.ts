// ── publish-gate.ts ───────────────────────────────────────────────────────────
// Pure, stateless security gate for all production publish decisions.
//
// No DB imports, no Express — callers fetch data first, then pass it in.
// This keeps the file unit-testable without mocking the database layer.
//
// Security invariant
// ------------------
// For env = "production" an ok result ALWAYS carries a non-empty approvedSnapshot
// sourced from an immutable, tested-and-approved project_versions row.
// The mutable project_files table is NEVER consulted for production.
// ─────────────────────────────────────────────────────────────────────────────

// Local minimal shape matching FileSnapshotEntry from @workspace/db.
// Using a local definition avoids a DB dependency so tests run without mocking.
export type GateSnapshotFile = {
  path: string;
  content: string;
  mimeType: string;
};

export type GateProject = {
  builderMode: string | null;
  testedSnapshotId: number | null;
  testingStatus: string;
  containerId: string | null;
};

export type GateSpecVersion = {
  testingApprovedAt: Date | null;
  filesSnapshot: GateSnapshotFile[] | null;
};

export type GateTestedVersion = {
  filesSnapshot: GateSnapshotFile[] | null;
};

export type PublishGateAllow = {
  ok: true;
  approvedSnapshot: GateSnapshotFile[];
};

export type PublishGateBlock = {
  ok: false;
  status: number;
  error: string;
  code: string;
  extra?: Record<string, unknown>;
};

export type PublishGateResult = PublishGateAllow | PublishGateBlock;

/**
 * Decide whether a production publish is allowed and which snapshot files to use.
 *
 * @param publishVersionId  Explicit version ID from the request body, or null for auto-resolve.
 * @param project           Project row (only gate-relevant fields required).
 * @param specVersion       Already-fetched version row when publishVersionId != null, else null.
 * @param testedVersion     Already-fetched version row for project.testedSnapshotId, else null.
 */
export function evaluatePublishGate(
  publishVersionId: number | null,
  project: GateProject,
  specVersion: GateSpecVersion | null,
  testedVersion: GateTestedVersion | null,
): PublishGateResult {
  // ── Explicit versionId path ────────────────────────────────────────────────
  if (publishVersionId !== null) {
    if (!specVersion) {
      return {
        ok: false,
        status: 404,
        error: "Version not found for this project",
        code: "version_not_found",
      };
    }

    // ALL project types require testingApprovedAt — not just agentic.
    // A static project that bypasses testing can publish untested code.
    if (!specVersion.testingApprovedAt) {
      return {
        ok: false,
        status: 422,
        error: "Version must pass Testing Approval before publishing to production.",
        code: "testing_approval_required",
        extra: { versionId: publishVersionId },
      };
    }

    // Approved snapshot must be non-empty — never fall back to mutable draft.
    if (!specVersion.filesSnapshot || specVersion.filesSnapshot.length === 0) {
      return {
        ok: false,
        status: 422,
        error:
          "The approved snapshot for this version is missing or empty. " +
          "Re-run Testing before publishing to production.",
        code: "approved_snapshot_empty",
        extra: { versionId: publishVersionId },
      };
    }

    return { ok: true, approvedSnapshot: specVersion.filesSnapshot };
  }

  // ── Auto-resolve from project.testedSnapshotId ────────────────────────────
  if (!project.testedSnapshotId) {
    const hasContainer = !!project.containerId;
    return {
      ok: false,
      status: 422,
      error: hasContainer
        ? "Full-stack projects must pass a test preview before publishing to production. " +
          "Open the Test Environment tab, start a test build, verify the app, then approve it."
        : "Projects must pass a test preview before publishing to production. " +
          "Open the Test Environment tab, start a test preview, verify the app, then approve it.",
      code: "testing_required",
    };
  }

  // testingStatus must be 'passed' — defense-in-depth against status/ID desync.
  // The approve endpoint sets both fields atomically, but an external SQL update
  // could clear testingStatus while leaving testedSnapshotId set.
  if (project.testingStatus !== "passed") {
    return {
      ok: false,
      status: 422,
      error:
        "The testing stage has not passed. Run Testing and approve it before publishing to production.",
      code: "testing_not_passed",
      extra: { testingStatus: project.testingStatus },
    };
  }

  // The testedVersion row must exist with a non-empty filesSnapshot.
  // If the row was deleted or the snapshot is empty, block rather than silently
  // falling back to the mutable project_files draft.
  if (!testedVersion?.filesSnapshot || testedVersion.filesSnapshot.length === 0) {
    return {
      ok: false,
      status: 422,
      error:
        "The approved test snapshot could not be loaded (missing or empty). " +
        "Re-run Testing before publishing to production.",
      code: "tested_snapshot_invalid",
      extra: { testedSnapshotId: project.testedSnapshotId },
    };
  }

  return { ok: true, approvedSnapshot: testedVersion.filesSnapshot };
}
