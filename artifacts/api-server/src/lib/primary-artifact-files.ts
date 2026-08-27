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
 * (for example, each artifact can own its own package.json).  Combining those
 * rows produces a source archive that is neither artifact and violates the
 * trusted-build uniqueness contract.  Null identifies the legacy unscoped
 * artifact only; it never means "all artifacts".
 */
export function selectPrimaryArtifactFiles(
  rows: readonly ProjectArtifactFileCandidate[],
  projectId: number,
  primaryArtifactId: number | null,
): PrimaryArtifactFile[] {
  return rows
    .filter((row) => row.projectId === projectId && row.artifactId === primaryArtifactId)
    .map(({ path, content, mimeType }) => ({ path, content, mimeType }))
    .sort((left, right) => compareUtf8(left.path, right.path));
}
