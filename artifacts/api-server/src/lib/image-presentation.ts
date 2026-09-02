export function presentPrivateImage<
  T extends { id: number; status: string; assetId?: number | null; storageKey?: unknown },
>(row: T): Omit<T, "storageKey"> & { fileUrl: string | null; thumbnailUrl: string | null } {
  const { storageKey: privateStorageKey, ...presented } = row;
  void privateStorageKey;
  const contentUrl =
    row.status !== "completed"
      ? null
      : typeof row.assetId === "number" && Number.isSafeInteger(row.assetId) && row.assetId > 0
        ? `/api/assets/${row.assetId}/content`
        : `/api/images/${row.id}/file`;
  return {
    ...presented,
    fileUrl: contentUrl,
    thumbnailUrl:
      contentUrl === null
        ? null
        : contentUrl.startsWith("/api/images/")
          ? `${contentUrl}?role=thumbnail`
          : contentUrl,
  };
}
