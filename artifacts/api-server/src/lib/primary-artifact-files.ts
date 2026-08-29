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
 * Canonicalize an in-memory primary-artifact snapshot before it crosses the
 * trusted-build boundary. Staged agent reviews may contain the same path more
 * than once while a draft is assembled; the final occurrence is the accepted
 * draft value. Trusted builds require one UTF-8-sorted entry per path.
 */
export function canonicalizePrimaryArtifactFiles(
  files: readonly PrimaryArtifactFile[],
): PrimaryArtifactFile[] {
  const filesByPath = new Map<string, PrimaryArtifactFile>();
  for (const file of files) filesByPath.set(file.path, { ...file });
  return [...filesByPath.values()].sort((left, right) => compareUtf8(left.path, right.path));
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
  return canonicalizePrimaryArtifactFiles([...filesByPath.values()]);
}
