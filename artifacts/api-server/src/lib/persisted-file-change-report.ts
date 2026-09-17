export interface PersistedFileDiff {
  filesAdded: readonly string[];
  filesModified: readonly string[];
  filesRemoved: readonly string[];
}

/** Match the build report to persisted changes, not the model's proposed operations. */
export function persistedFileChangeReport(diff: PersistedFileDiff): {
  filesCreated: string[];
  filesChanged: string[];
  filesRemoved: string[];
} {
  return {
    filesCreated: [...diff.filesAdded],
    filesChanged: [...diff.filesModified],
    filesRemoved: [...diff.filesRemoved],
  };
}
