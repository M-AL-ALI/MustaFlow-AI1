import type { TaskReport } from "@workspace/db";

type SavedFile = Readonly<{ path: string; content: string; mimeType: string }>;
type FileValue = Readonly<{ content: string; mimeType: string }>;
type FileReport = Pick<TaskReport, "filesCreated" | "filesChanged" | "filesRemoved" | "warnings">;

/** Tracks acknowledged database writes, never generated drafts or runtime-only edits. */
export class CommittedBuildFileReport {
  private readonly before: Map<string, FileValue>;
  private readonly current: Map<string, FileValue>;

  constructor(files: readonly SavedFile[]) {
    this.before = new Map(
      files.map((file) => [file.path, { content: file.content, mimeType: file.mimeType }]),
    );
    this.current = new Map(this.before);
  }

  /** Call only after writeProjectFilesAtomically resolves successfully. */
  record(input: {
    files: readonly SavedFile[];
    replaceAll: boolean;
    removedPaths?: readonly string[];
  }): void {
    if (input.replaceAll) this.current.clear();
    for (const path of input.removedPaths ?? []) this.current.delete(path);
    // The database writer inserts supplied files after removing affected paths.
    for (const file of input.files) {
      this.current.set(file.path, { content: file.content, mimeType: file.mimeType });
    }
  }

  toReport(): FileReport {
    const filesCreated: string[] = [];
    const filesChanged: string[] = [];
    const filesRemoved: string[] = [];
    for (const [path, file] of this.current) {
      const previous = this.before.get(path);
      if (!previous) filesCreated.push(path);
      else if (previous.content !== file.content || previous.mimeType !== file.mimeType)
        filesChanged.push(path);
    }
    for (const path of this.before.keys()) {
      if (!this.current.has(path)) filesRemoved.push(path);
    }
    return {
      filesCreated: filesCreated.sort(),
      filesChanged: filesChanged.sort(),
      filesRemoved: filesRemoved.sort(),
      warnings:
        filesCreated.length + filesChanged.length + filesRemoved.length > 0
          ? [
              "Project file changes were saved before this run failed. This does not mean the app was built, previewed, or published successfully.",
            ]
          : [],
    };
  }
}
