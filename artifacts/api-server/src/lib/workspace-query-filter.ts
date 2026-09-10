export type WorkspaceQueryFilter = { ok: true; workspaceId: number | null } | { ok: false };

/** Optional for legacy account-wide callers; malformed scope never means all. */
export function parseWorkspaceQueryFilter(value: unknown): WorkspaceQueryFilter {
  if (value === undefined) return { ok: true, workspaceId: null };
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return { ok: false };
  const workspaceId = Number(value);
  return Number.isSafeInteger(workspaceId) && workspaceId <= 2147483647
    ? { ok: true, workspaceId }
    : { ok: false };
}
