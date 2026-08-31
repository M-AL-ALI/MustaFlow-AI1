export interface CachedCustomDomainServingState {
  id: number;
  prodContainerUrl: string | null;
  prodContainerStatus: string;
  environment: string;
  suspendedAt: Date | null;
  suspensionReason: string | null;
  publishedSnapshotId: number | null;
}

export interface CurrentCustomDomainServingState {
  id: number;
  status: string;
  prodContainerUrl: string | null;
  prodContainerStatus: string;
  publishedSnapshotId: number | null;
}

/**
 * Retain only cached domain metadata. Every serving pointer comes from the
 * current project row, and production domains are eligible only while the
 * project is currently published.
 */
export function revalidateCustomDomainServingState(
  cached: CachedCustomDomainServingState,
  current: CurrentCustomDomainServingState,
): CachedCustomDomainServingState | null {
  if (current.id !== cached.id) return null;
  if (cached.environment === "production" && current.status !== "published") return null;
  return {
    ...cached,
    prodContainerUrl: current.prodContainerUrl,
    prodContainerStatus: current.prodContainerStatus,
    publishedSnapshotId: current.publishedSnapshotId,
  };
}
