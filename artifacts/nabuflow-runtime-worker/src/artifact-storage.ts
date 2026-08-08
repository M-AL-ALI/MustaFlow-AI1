import type { StoredRuntimeArtifact } from "./model";

export function artifactPrefix(identity: string, sealedArtifactSha256: string): string {
  return `artifacts/v1/${identity}/${sealedArtifactSha256}`;
}

export function artifactChunkKey(
  identity: string,
  sealedArtifactSha256: string,
  chunkIndex: number,
): string {
  return `${artifactPrefix(identity, sealedArtifactSha256)}/chunks/${chunkIndex
    .toString()
    .padStart(6, "0")}`;
}

export async function deleteArtifactObjects(
  bucket: R2Bucket,
  artifact: StoredRuntimeArtifact,
): Promise<void> {
  // Delete the complete sealed keyspace, not only chunks acknowledged in DO metadata. An R2 put
  // may succeed just before a metadata write fails; deleting all expected keys closes that orphan
  // window, and R2 deletion is idempotent for keys that were never uploaded.
  const keys = artifact.envelope.content.chunks.map((_chunk, index) =>
    artifactChunkKey(artifact.runtimeIdentity, artifact.envelope.sealedArtifactSha256, index),
  );
  if (keys.length > 0) await bucket.delete(keys);
}
