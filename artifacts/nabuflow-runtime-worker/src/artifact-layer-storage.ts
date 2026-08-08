import type { StoredRuntimeLayer, StoredRuntimeLayeredArtifact } from "./model";

export function layeredArtifactPrefix(identity: string, sealedArtifactSha256: string): string {
  return `artifacts/layers-v1/${identity}/${sealedArtifactSha256}`;
}

export function layeredArtifactAppChunkKey(
  identity: string,
  sealedArtifactSha256: string,
  chunkIndex: number,
): string {
  return `${layeredArtifactPrefix(identity, sealedArtifactSha256)}/app/chunks/${chunkIndex
    .toString()
    .padStart(6, "0")}`;
}

export function dependencyLayerPrefix(contentSha256: string): string {
  return `dependency-layers/v1/${contentSha256}`;
}

export function dependencyLayerChunkKey(contentSha256: string, chunkIndex: number): string {
  return `${dependencyLayerPrefix(contentSha256)}/chunks/${chunkIndex.toString().padStart(6, "0")}`;
}

export async function deleteLayeredArtifactAppObjects(
  bucket: R2Bucket,
  artifact: StoredRuntimeLayeredArtifact,
): Promise<void> {
  const keys = artifact.envelope.content.appArtifact.content.chunks.map((_chunk, index) =>
    layeredArtifactAppChunkKey(
      artifact.runtimeIdentity,
      artifact.envelope.sealedArtifactSha256,
      index,
    ),
  );
  if (keys.length > 0) await bucket.delete(keys);
}

export async function deleteDependencyLayerObjects(
  bucket: R2Bucket,
  layer: StoredRuntimeLayer,
): Promise<void> {
  const keys = layer.content.chunks.map((_chunk, index) =>
    dependencyLayerChunkKey(layer.content.descriptor.contentSha256, index),
  );
  if (keys.length > 0) await bucket.delete(keys);
}
