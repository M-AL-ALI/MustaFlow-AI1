import { createHash } from "node:crypto";
import type { TaskReport } from "@workspace/db";

interface SavedFile {
  readonly path: string;
  readonly content: string;
  readonly mimeType: string;
}

export interface EffectiveFileChange {
  readonly path: string;
  readonly before: string | null;
  readonly after: string | null;
}

type FileReport = Pick<TaskReport, "filesCreated" | "filesChanged" | "filesRemoved" | "warnings">;

/** Compare actual effective snapshots, not requested removals or generated drafts. */
export function describeCommittedFileChanges(
  before: readonly SavedFile[],
  after: readonly SavedFile[],
): EffectiveFileChange[] {
  const fingerprints = (files: readonly SavedFile[]) =>
    new Map(
      files.map((file) => [
        file.path,
        createHash("sha256")
          .update(JSON.stringify([file.content, file.mimeType]))
          .digest("hex"),
      ]),
    );
  const previous = fingerprints(before);
  const current = fingerprints(after);
  const changes: EffectiveFileChange[] = [];
  const paths = new Set([...previous.keys(), ...current.keys()]);
  for (const path of [...paths].sort()) {
    const oldValue = previous.get(path) ?? null;
    const newValue = current.get(path) ?? null;
    if (oldValue !== newValue) changes.push({ path, before: oldValue, after: newValue });
  }
  return changes;
}

/** Retains only acknowledged changes from the writer's transaction-bound snapshots. */
export class CommittedBuildFileReport {
  private readonly changes = new Map<string, { before: string | null; after: string | null }>();

  record(changes: readonly EffectiveFileChange[]): void {
    for (const change of changes) {
      const previous = this.changes.get(change.path);
      this.changes.set(change.path, {
        before: previous ? previous.before : change.before,
        after: change.after,
      });
    }
  }

  toReport(): FileReport {
    const filesCreated: string[] = [];
    const filesChanged: string[] = [];
    const filesRemoved: string[] = [];
    for (const [path, change] of this.changes) {
      if (change.before === change.after) continue;
      if (change.before === null) filesCreated.push(path);
      else if (change.after === null) filesRemoved.push(path);
      else filesChanged.push(path);
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
