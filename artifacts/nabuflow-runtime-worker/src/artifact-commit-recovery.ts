export const ARTIFACT_COMMIT_ABORT_BEFORE_PREFIX = "staging-commit-abort-before-";
export const ARTIFACT_COMMIT_ABORT_MID_PREFIX = "staging-commit-abort-mid-";

export class StagingArtifactCommitOwnerLossError extends Error {
  constructor(readonly stage: "before-materializer" | "mid-materialization") {
    super("Staging artifact commit owner-loss probe");
    this.name = "StagingArtifactCommitOwnerLossError";
  }
}
