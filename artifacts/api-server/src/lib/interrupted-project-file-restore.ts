import type { BuilderFile } from "./builder";
import { writeProjectFilesAtomically } from "./project-file-writer";

export type InterruptedProjectFileRestoreResult =
  | { restored: true; remainingChangedPaths: [] }
  | { restored: false; remainingChangedPaths: string[]; errorClass?: string };

/**
 * Restore the exact pre-run artifact snapshot after a user interruption. The
 * same bounded atomic writer used for normal commits owns the restore, so a
 * failed restore leaves the post-write state intact and reports its paths
 * honestly in the interrupted terminal.
 */
export async function restoreInterruptedProjectFiles(
  input: {
    projectId: number;
    preRunFiles: readonly BuilderFile[] | null;
    databaseCommitted: boolean;
    runtimeMayHaveMutated: boolean;
    changedPaths: readonly string[];
  },
  dependencies: {
    writeFiles?: typeof writeProjectFilesAtomically;
    restoreRuntime?: (input: {
      files: readonly BuilderFile[];
      removedPaths: readonly string[];
    }) => Promise<void>;
  } = {},
): Promise<InterruptedProjectFileRestoreResult> {
  const remainingChangedPaths = [...new Set(input.changedPaths)].sort();
  if (!input.databaseCommitted && !input.runtimeMayHaveMutated) {
    return { restored: false, remainingChangedPaths: [] };
  }
  if (input.preRunFiles === null) {
    return { restored: false, remainingChangedPaths };
  }

  try {
    const preRunFiles = input.preRunFiles.map((file) => ({ ...file }));
    if (input.databaseCommitted) {
      await (dependencies.writeFiles ?? writeProjectFilesAtomically)({
        projectId: input.projectId,
        scope: { kind: "artifact" },
        files: preRunFiles,
        replaceAll: true,
      });
    }
    const preRunPaths = new Set(preRunFiles.map((file) => file.path));
    if (input.runtimeMayHaveMutated) {
      if (!dependencies.restoreRuntime) throw new Error("RuntimeRestoreUnavailable");
      await dependencies.restoreRuntime({
        files: preRunFiles,
        removedPaths: remainingChangedPaths.filter((path) => !preRunPaths.has(path)),
      });
    }
    return { restored: true, remainingChangedPaths: [] };
  } catch (error) {
    return {
      restored: false,
      remainingChangedPaths,
      errorClass: error instanceof Error ? error.constructor.name : "UnknownError",
    };
  }
}
