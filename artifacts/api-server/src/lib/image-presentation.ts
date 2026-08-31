export function presentPrivateImage<T extends { id: number; status: string }>(
  row: T,
): T & { fileUrl: string | null; thumbnailUrl: string | null } {
  const contentUrl = row.status === "completed" ? `/api/images/${row.id}/file` : null;
  return {
    ...row,
    fileUrl: contentUrl,
    thumbnailUrl: contentUrl === null ? null : `${contentUrl}?role=thumbnail`,
  };
}
