import {
  acceptedSealedReleaseSchema,
  type AcceptedSealedRelease,
} from "@workspace/tenant-runtime-contracts";

type SnapshotFile = {
  path: string;
  content: string | null;
  mimeType: string | null;
};

type RuntimeDescriptor = {
  identity: string;
  manifestRevision: string;
  status: string;
};

export type SealedVersionCandidate = {
  id: number;
  filesSnapshot: readonly SnapshotFile[] | null;
  sealedRelease: unknown;
};

export type AcceptedSealedReleaseSelection = {
  sourceVersionId: number;
  release: AcceptedSealedRelease;
};

export class SealedTestingCandidateError extends Error {
  constructor(
    readonly code:
      | "sealed_test_release_invalid"
      | "sealed_test_source_changed"
      | "sealed_test_runtime_not_ready"
      | "sealed_test_runtime_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "SealedTestingCandidateError";
  }
}

export function canonicalSealedSnapshot(files: readonly SnapshotFile[]): string {
  return JSON.stringify(
    files
      .map((file) => ({
        path: file.path,
        content: file.content ?? "",
        mimeType: file.mimeType ?? "text/plain",
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  );
}

/**
 * Find an accepted release whose immutable source snapshot is byte-for-byte
 * equivalent to the target snapshot. Callers pass candidates newest-first, but
 * recency is only a tie-breaker after exact source identity has been proven.
 */
export function selectAcceptedSealedReleaseForSnapshot(input: {
  targetSnapshot: readonly SnapshotFile[] | null;
  candidates: readonly SealedVersionCandidate[];
}): AcceptedSealedReleaseSelection {
  if (input.targetSnapshot === null) {
    throw new SealedTestingCandidateError(
      "sealed_test_release_invalid",
      "The target snapshot is missing",
    );
  }
  const targetIdentity = canonicalSealedSnapshot(input.targetSnapshot);
  for (const candidate of input.candidates) {
    const release = acceptedSealedReleaseSchema.safeParse(candidate.sealedRelease);
    if (!release.success || candidate.filesSnapshot === null) continue;
    if (canonicalSealedSnapshot(candidate.filesSnapshot) !== targetIdentity) continue;
    return { sourceVersionId: candidate.id, release: release.data };
  }
  throw new SealedTestingCandidateError(
    "sealed_test_release_invalid",
    "No accepted sealed release matches the exact target snapshot",
  );
}

/**
 * Bind testing to the exact version that promotion will ship. A legacy staging
 * snapshot may inherit an accepted release only when its full canonical source
 * snapshot matches the release's source version; the returned target version
 * remains the staging version, never a lookalike source version.
 */
export function resolveSealedTestingHandoff(input: {
  targetVersion: SealedVersionCandidate;
  candidates: readonly SealedVersionCandidate[];
  currentFiles: readonly SnapshotFile[];
  runtime: RuntimeDescriptor | null;
}): {
  versionId: number;
  sourceVersionId: number;
  release: AcceptedSealedRelease;
} {
  const selection = selectSealedTestingHandoff({
    targetVersion: input.targetVersion,
    candidates: input.candidates,
    currentFiles: input.currentFiles,
  });
  resolveSealedTestingCandidate({
    versionId: input.targetVersion.id,
    versionSnapshot: input.targetVersion.filesSnapshot,
    currentFiles: input.currentFiles,
    sealedRelease: selection.release,
    runtime: input.runtime,
  });
  return {
    versionId: input.targetVersion.id,
    sourceVersionId: selection.sourceVersionId,
    release: selection.release,
  };
}

/**
 * Resolve the immutable source/release binding before touching runtime state.
 * A stopped accepted runtime can then be resumed with this exact release and
 * independently reverified by resolveSealedTestingCandidate afterwards.
 */
export function selectSealedTestingHandoff(input: {
  targetVersion: SealedVersionCandidate;
  candidates: readonly SealedVersionCandidate[];
  currentFiles: readonly SnapshotFile[];
}): {
  versionId: number;
  sourceVersionId: number;
  release: AcceptedSealedRelease;
} {
  const selection = selectAcceptedSealedReleaseForSnapshot({
    targetSnapshot: input.targetVersion.filesSnapshot,
    candidates: [
      input.targetVersion,
      ...input.candidates.filter((v) => v.id !== input.targetVersion.id),
    ],
  });
  if (
    input.targetVersion.filesSnapshot === null ||
    canonicalSealedSnapshot(input.targetVersion.filesSnapshot) !==
      canonicalSealedSnapshot(input.currentFiles)
  ) {
    throw new SealedTestingCandidateError(
      "sealed_test_source_changed",
      "The accepted sealed release does not match the current source snapshot",
    );
  }
  return {
    versionId: input.targetVersion.id,
    sourceVersionId: selection.sourceVersionId,
    release: selection.release,
  };
}

/**
 * The sealed Cloudflare preview is already the immutable test environment.
 * Approving it must bind the exact accepted release, exact source snapshot,
 * and exact healthy runtime instead of replaying source into a mutable cell.
 */
export function resolveSealedTestingCandidate(input: {
  versionId: number;
  versionSnapshot: readonly SnapshotFile[] | null;
  currentFiles: readonly SnapshotFile[];
  sealedRelease: unknown;
  runtime: RuntimeDescriptor | null;
}): { versionId: number; release: AcceptedSealedRelease } {
  const release = acceptedSealedReleaseSchema.safeParse(input.sealedRelease);
  if (!release.success || input.versionSnapshot === null) {
    throw new SealedTestingCandidateError(
      "sealed_test_release_invalid",
      "The latest version has no accepted sealed release",
    );
  }
  if (
    canonicalSealedSnapshot(input.versionSnapshot) !== canonicalSealedSnapshot(input.currentFiles)
  ) {
    throw new SealedTestingCandidateError(
      "sealed_test_source_changed",
      "The accepted sealed release does not match the current source snapshot",
    );
  }
  if (input.runtime === null || input.runtime.status !== "running") {
    throw new SealedTestingCandidateError(
      "sealed_test_runtime_not_ready",
      "The sealed preview runtime is not running",
    );
  }
  if (
    input.runtime.identity !== release.data.sourceRuntimeIdentity ||
    input.runtime.manifestRevision !== release.data.manifest.revision
  ) {
    throw new SealedTestingCandidateError(
      "sealed_test_runtime_mismatch",
      "The running sealed preview does not match the accepted release",
    );
  }
  return { versionId: input.versionId, release: release.data };
}
