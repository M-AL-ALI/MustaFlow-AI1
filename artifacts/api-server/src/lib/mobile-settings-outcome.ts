export type MobileSettingsMetadataStage = "task_completion" | "project_touch" | "completion_event";

export type MobileSettingsMetadataFailure = {
  stage: MobileSettingsMetadataStage;
  errorClass: string;
};

function errorClass(error: unknown): string {
  return error instanceof Error ? error.constructor.name : "UnknownError";
}

function recordFailureSafely(
  recordFailure: (failure: MobileSettingsMetadataFailure) => void,
  failure: MobileSettingsMetadataFailure,
): void {
  try {
    recordFailure(failure);
  } catch {
    // Diagnostics may never turn committed user work into a reported failure.
  }
}

/** Commit the user's files first, then record secondary metadata without changing that outcome. */
export async function saveMobileSettingsWithMetadata<T>(input: {
  commitFilesAndVersion: () => Promise<T>;
  metadata: ReadonlyArray<{
    stage: MobileSettingsMetadataStage;
    write: () => Promise<unknown>;
  }>;
  recordFailure: (failure: MobileSettingsMetadataFailure) => void;
}): Promise<T> {
  const committed = await input.commitFilesAndVersion();

  for (const entry of input.metadata) {
    try {
      await entry.write();
    } catch (error) {
      recordFailureSafely(input.recordFailure, {
        stage: entry.stage,
        errorClass: errorClass(error),
      });
    }
  }

  return committed;
}
