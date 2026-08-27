export const ZERO_MEMORY_VERSION_SEMANTICS = "zero-memory-version-v1" as const;

export const ZERO_MEMORY_VERSION_STATES = ["active", "historical", "unbound"] as const;
export type ZeroMemoryVersionStateKind = (typeof ZERO_MEMORY_VERSION_STATES)[number];

export type ZeroMemoryVersionState = {
  semantics: typeof ZERO_MEMORY_VERSION_SEMANTICS;
  state: ZeroMemoryVersionStateKind;
  label: "Current app version" | "Saved with another version" | "Version not verified";
  versionId: number | null;
  currentVersionId: number | null;
};

function validId(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value > 0;
}

/**
 * Content-free, deterministic presentation contract for version-bound project memory.
 * The caller supplies a declared current-version lineage; this function never infers one.
 */
export function presentZeroMemoryVersion(input: {
  versionId: number | null;
  currentVersionId: number | null;
  activeVersionIds: ReadonlySet<number>;
}): ZeroMemoryVersionState {
  const currentVersionId = validId(input.currentVersionId) ? input.currentVersionId : null;
  const versionId = validId(input.versionId) ? input.versionId : null;

  if (versionId === null || currentVersionId === null) {
    return {
      semantics: ZERO_MEMORY_VERSION_SEMANTICS,
      state: "unbound",
      label: "Version not verified",
      versionId,
      currentVersionId,
    };
  }

  if (input.activeVersionIds.has(versionId)) {
    return {
      semantics: ZERO_MEMORY_VERSION_SEMANTICS,
      state: "active",
      label: "Current app version",
      versionId,
      currentVersionId,
    };
  }

  return {
    semantics: ZERO_MEMORY_VERSION_SEMANTICS,
    state: "historical",
    label: "Saved with another version",
    versionId,
    currentVersionId,
  };
}
