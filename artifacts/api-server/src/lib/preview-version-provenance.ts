import { createHash } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db, projectFilesTable, projectVersionsTable, projectsTable } from "@workspace/db";
import { tenantRuntimeProvider } from "./tenant-runtime";
import { supportsZeroGeneration } from "./tenant-runtime-provider";
import { canonicalSealedSnapshot, resolveSealedTestingCandidate } from "./sealed-testing-candidate";

export type PreviewVersionWitness = {
  projectId: number;
  versionId: number;
  sourceSha256: string;
  runtimeIdentity: string;
  manifestRevision: string;
  sealedArtifactSha256: string;
};

export type PreviewVersionProvenance =
  | { state: "unverified"; reason: "no-stable-sealed-version" }
  | ({ state: "verified"; basis: "accepted-sealed-runtime" } & PreviewVersionWitness);

/**
 * Recency is not evidence: two independently obtained witnesses must identify
 * the same project, source snapshot, accepted artifact and running manifest.
 * The caller must retain its project lifecycle session across both reads,
 * capture and persistence. No user-supplied version tag is accepted.
 */
export function bindPreviewVersion(
  projectId: number,
  before: PreviewVersionWitness | null,
  after: PreviewVersionWitness | null,
): PreviewVersionProvenance {
  const unverified = { state: "unverified", reason: "no-stable-sealed-version" } as const;
  if (!before || !after || !Number.isSafeInteger(projectId) || projectId < 1) return unverified;
  if (
    before.projectId !== projectId ||
    after.projectId !== projectId ||
    !Number.isSafeInteger(before.versionId) ||
    before.versionId < 1 ||
    before.versionId !== after.versionId ||
    before.sourceSha256 !== after.sourceSha256 ||
    before.runtimeIdentity !== after.runtimeIdentity ||
    before.manifestRevision !== after.manifestRevision ||
    before.sealedArtifactSha256 !== after.sealedArtifactSha256 ||
    !/^[a-f0-9]{64}$/u.test(before.sourceSha256) ||
    !/^[a-f0-9]{64}$/u.test(before.sealedArtifactSha256) ||
    !before.runtimeIdentity.trim() ||
    !before.manifestRevision.trim()
  )
    return unverified;
  return {
    state: "verified",
    basis: "accepted-sealed-runtime",
    projectId,
    versionId: before.versionId,
    sourceSha256: before.sourceSha256,
    runtimeIdentity: before.runtimeIdentity,
    manifestRevision: before.manifestRevision,
    sealedArtifactSha256: before.sealedArtifactSha256,
  };
}

/** Metadata-only inspection. Never starts, provisions, writes, or resumes a runtime. */
export async function readPreviewVersionWitness(input: {
  id: number;
  ownerId: string;
}): Promise<PreviewVersionWitness | null> {
  if (!supportsZeroGeneration(tenantRuntimeProvider)) return null;
  try {
    const source = await db.transaction(
      async (tx) => {
        const [project] = await tx
          .select({
            id: projectsTable.id,
            runtimeId: projectsTable.containerId,
            runtimeStatus: projectsTable.containerStatus,
          })
          .from(projectsTable)
          .where(
            and(
              eq(projectsTable.id, input.id),
              eq(projectsTable.ownerId, input.ownerId),
              isNull(projectsTable.deletedAt),
            ),
          )
          .limit(1);
        if (!project?.runtimeId || project.runtimeStatus !== "running") return null;
        const [version] = await tx
          .select({
            id: projectVersionsTable.id,
            filesSnapshot: projectVersionsTable.filesSnapshot,
            sealedRelease: projectVersionsTable.sealedRelease,
          })
          .from(projectVersionsTable)
          .where(eq(projectVersionsTable.projectId, project.id))
          .orderBy(desc(projectVersionsTable.id))
          .limit(1);
        if (!version) return null;
        const files = await tx
          .select({
            path: projectFilesTable.path,
            content: projectFilesTable.content,
            mimeType: projectFilesTable.mimeType,
          })
          .from(projectFilesTable)
          .where(eq(projectFilesTable.projectId, project.id));
        return { project, version, files };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    if (!source) return null;
    const runtime = await tenantRuntimeProvider.zeroGenerationRuntimeDescriptor(
      source.project.runtimeId!,
      input.id,
    );
    const candidate = resolveSealedTestingCandidate({
      versionId: source.version.id,
      versionSnapshot: source.version.filesSnapshot,
      currentFiles: source.files,
      sealedRelease: source.version.sealedRelease,
      runtime,
    });
    return {
      projectId: input.id,
      versionId: candidate.versionId,
      sourceSha256: createHash("sha256")
        .update(canonicalSealedSnapshot(source.files))
        .digest("hex"),
      runtimeIdentity: runtime.identity,
      manifestRevision: runtime.manifestRevision,
      sealedArtifactSha256: candidate.release.sealedArtifactSha256,
    };
  } catch {
    // A metadata/provider failure cannot turn an observation into version proof.
    return null;
  }
}
