export type ProductionPublishSnapshotReferences = {
  publishedSnapshotId: number | null | undefined;
  stagingPublishedSnapshotId: number | null | undefined;
  testedSnapshotId: number | null | undefined;
};

export function shouldRemoveUncommittedProductionSnapshot(input: {
  snapshotVersionId: number;
  committed: boolean;
  needsReconciliation: boolean;
  references: ProductionPublishSnapshotReferences | undefined;
}): boolean {
  if (input.committed || input.needsReconciliation) return false;
  return ![
    input.references?.publishedSnapshotId,
    input.references?.stagingPublishedSnapshotId,
    input.references?.testedSnapshotId,
  ].includes(input.snapshotVersionId);
}

export async function removeUncommittedProductionSnapshot(input: {
  snapshotVersionId: number;
  committed: boolean;
  needsReconciliation: boolean;
  loadReferences: () => Promise<ProductionPublishSnapshotReferences | undefined>;
  removeSnapshot: (snapshotVersionId: number) => Promise<void>;
}): Promise<boolean> {
  if (input.committed || input.needsReconciliation) return false;
  const references = await input.loadReferences();
  if (!shouldRemoveUncommittedProductionSnapshot({ ...input, references })) return false;
  await input.removeSnapshot(input.snapshotVersionId);
  return true;
}
