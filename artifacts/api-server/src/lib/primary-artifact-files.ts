import { compareUtf8 } from "@workspace/tenant-runtime-contracts";

export interface ProjectArtifactFileCandidate {
  projectId: number;
  artifactId: number | null;
  path: string;
  content: string;
  mimeType: string;
}

export interface PrimaryArtifactFile {
  path: string;
  content: string;
  mimeType: string;
}

/**
 * Keep an app's executable file set inside one artifact boundary.
 *
 * A project may contain several artifacts with legitimate overlapping paths
 * (for example, each artifact can own its own package.json). Combining sibling
 * rows produces a source archive that is neither artifact and violates the
 * trusted-build uniqueness contract. Legacy null rows form the migration-era
 * base layer; scoped rows from the primary artifact override matching paths.
 * Null never means "all artifacts".
 */
export function selectPrimaryArtifactFiles(
  rows: readonly ProjectArtifactFileCandidate[],
  projectId: number,
  primaryArtifactId: number | null,
): PrimaryArtifactFile[] {
  const filesByPath = new Map<string, PrimaryArtifactFile>();
  for (const row of rows) {
    if (row.projectId !== projectId) continue;
    if (row.artifactId !== null && row.artifactId !== primaryArtifactId) continue;
    if (primaryArtifactId === null && row.artifactId !== null) continue;
    if (row.artifactId === null && filesByPath.has(row.path)) continue;
    filesByPath.set(row.path, {
      path: row.path,
      content: row.content,
      mimeType: row.mimeType,
    });
  }
  return [...filesByPath.values()].sort((left, right) => compareUtf8(left.path, right.path));
}
