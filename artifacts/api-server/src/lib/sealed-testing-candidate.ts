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

function canonicalSnapshot(files: readonly SnapshotFile[]): string {
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
  if (canonicalSnapshot(input.versionSnapshot) !== canonicalSnapshot(input.currentFiles)) {
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
