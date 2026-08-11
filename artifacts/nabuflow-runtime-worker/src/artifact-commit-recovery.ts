export const ARTIFACT_COMMIT_ABORT_BEFORE_PREFIX = "staging-commit-abort-before-";
export const ARTIFACT_COMMIT_ABORT_MID_PREFIX = "staging-commit-abort-mid-";
export const ARTIFACT_COMMIT_ABORT_CHECKPOINT_PREFIX = "staging-commit-abort-checkpoint-";
export const ARTIFACT_COMMIT_ABORT_ALWAYS_PREFIX = "staging-commit-abort-always-";
export const RUNTIME_START_ABORT_CHECKPOINT_PREFIX = "staging-start-abort-checkpoint-";
export const RUNTIME_START_ABORT_ALWAYS_PREFIX = "staging-start-abort-always-";
export const RUNTIME_MANIFEST_RESTART_ABORT_CHECKPOINT_PREFIX =
  "staging-manifest-restart-abort-checkpoint-";
export const RUNTIME_MANIFEST_RESTART_ABORT_ALWAYS_PREFIX =
  "staging-manifest-restart-abort-always-";

export class StagingDurableOperationOwnerLossError extends Error {
  constructor(readonly stage: string) {
    super("Staging durable operation owner-loss probe");
    this.name = "StagingDurableOperationOwnerLossError";
  }
}

export class StagingArtifactCommitOwnerLossError extends StagingDurableOperationOwnerLossError {
  constructor(
    readonly stage:
      | "before-materializer"
      | "mid-materialization"
      | `checkpoint-${ArtifactCommitCheckpoint}`,
  ) {
    super(stage);
    this.name = "StagingArtifactCommitOwnerLossError";
  }
}
import type { ArtifactCommitCheckpoint } from "@workspace/tenant-runtime-contracts";
