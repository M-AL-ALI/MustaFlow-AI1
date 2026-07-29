import type { BuilderAgentMode } from "@/components/builder-mode-icon";

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

function storageFor(preferred?: PreferenceStorage): PreferenceStorage | null {
  if (preferred) return preferred;
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

export function builderDeepReasoningStorageKey(projectId: number): string {
  return `mustaflow_builder_deep_reasoning_${projectId}`;
}

export function loadBuilderDeepReasoning(
  projectId: number,
  mode: BuilderAgentMode,
  preferredStorage?: PreferenceStorage,
): boolean {
  if (mode === "lite") return false;
  try {
    return storageFor(preferredStorage)?.getItem(builderDeepReasoningStorageKey(projectId)) === "1";
  } catch {
    return false;
  }
}

export function saveBuilderDeepReasoning(
  projectId: number,
  mode: BuilderAgentMode,
  enabled: boolean,
  preferredStorage?: PreferenceStorage,
): boolean {
  const persisted = mode !== "lite" && enabled;
  try {
    storageFor(preferredStorage)?.setItem(
      builderDeepReasoningStorageKey(projectId),
      persisted ? "1" : "0",
    );
  } catch {
    // Browser privacy settings may disable localStorage; the live selection
    // still works for the current session.
  }
  return persisted;
}
