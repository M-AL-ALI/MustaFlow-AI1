export const ZERO_MEMORY_VERSION_LINEAGE_LIMIT = 2_000;

export type ProjectVersionNode = {
  id: number;
  parentVersionId: number | null;
};

export type ProjectMemoryVersionLineage = {
  currentVersionId: number | null;
  activeVersionIds: ReadonlySet<number>;
  coverage: "complete" | "limited" | "empty";
};

/** Pure, fail-closed traversal of one explicitly declared version head. */
export function deriveProjectMemoryVersionLineage(input: {
  currentVersionId: number | null;
  versions: readonly ProjectVersionNode[];
  limited?: boolean;
}): ProjectMemoryVersionLineage {
  if (input.currentVersionId === null) {
    return { currentVersionId: null, activeVersionIds: new Set(), coverage: "empty" };
  }

  const byId = new Map(input.versions.map((version) => [version.id, version]));
  const activeVersionIds = new Set<number>();
  let cursor: number | null = input.currentVersionId;
  let complete = !input.limited;

  while (cursor !== null) {
    if (activeVersionIds.has(cursor)) {
      complete = false;
      break;
    }
    const node = byId.get(cursor);
    if (!node) {
      complete = false;
      break;
    }
    activeVersionIds.add(cursor);
    cursor = node.parentVersionId;
  }

  return {
    currentVersionId: input.currentVersionId,
    activeVersionIds,
    coverage: complete ? "complete" : "limited",
  };
}
