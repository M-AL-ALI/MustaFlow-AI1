import { authFetch } from "@/lib/api-fetch";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export const ORA_MEMORY_CATEGORIES = [
  "preference",
  "personal",
  "project",
  "document",
  "other",
] as const;
export type OraMemoryCategory = (typeof ORA_MEMORY_CATEGORIES)[number];

export const ORA_MEMORY_CATEGORY_LABELS: Record<OraMemoryCategory, string> = {
  preference: "Preference",
  personal: "Personal",
  project: "Project",
  document: "Document",
  other: "Other",
};

export function normalizeOraMemoryCategory(v: string | null | undefined): OraMemoryCategory {
  return (ORA_MEMORY_CATEGORIES as readonly string[]).includes(v ?? "")
    ? (v as OraMemoryCategory)
    : "other";
}

// Shared React Query key for the signed-in user's saved Ora memories. Used by
// the Memory Center list query and by every save/edit/delete path that needs to
// invalidate it so the dialog reflects the latest state immediately.
export const ORA_MEMORIES_QUERY_KEY = ["ora-memories"] as const;

export interface OraMemory {
  id: number;
  title: string;
  content: string;
  category: OraMemoryCategory;
  enabled: boolean;
  /**
   * When set, the id of a newer memory that superseded this one (a contradicting
   * update like "dark mode" → "light mode"). Superseded memories are kept and
   * still listed, but excluded from Ora's context until restored. Null = active.
   */
  supersededBy: number | null;
  sourceConversationId: number | null;
  oraProjectId: number | null;
  createdAt: string;
}

/**
 * List Ora memories. With no argument, returns user-level memories (those not
 * anchored to any project). Pass an `oraProjectId` to list that project's
 * persistent memories instead, or `"all"` to list every memory across scopes
 * (each row carries `oraProjectId` for scope badges/filters).
 */
export async function fetchOraMemories(scope?: number | "all" | null): Promise<OraMemory[]> {
  const url =
    scope === "all"
      ? `${BASE}/api/ora/memories?scope=all`
      : typeof scope === "number"
        ? `${BASE}/api/ora/memories?oraProjectId=${scope}`
        : `${BASE}/api/ora/memories`;
  const res = await authFetch(url);
  if (!res.ok) throw new Error(`Failed to load memories (${res.status})`);
  const data = (await res.json()) as { memories: OraMemory[] };
  return data.memories;
}

/** A pre-existing memory that a newly-saved one replaced (contradicting update). */
export interface SupersededMemory {
  id: number;
  title: string;
}

export interface CreateOraMemoryResult {
  memory: OraMemory;
  /** Earlier memories this save superseded (empty when nothing was replaced). */
  superseded: SupersededMemory[];
}

/** Thrown when a save is rejected because the user is at their memory cap. */
export class MemoryFullError extends Error {
  readonly code = "memory_full";
  readonly limit?: number;
  constructor(message: string, limit?: number) {
    super(message);
    this.name = "MemoryFullError";
    this.limit = limit;
  }
}

export async function createOraMemory(patch: {
  title: string;
  content?: string;
  category?: OraMemoryCategory;
  oraProjectId?: number | null;
}): Promise<CreateOraMemoryResult> {
  const res = await authFetch(`${BASE}/api/ora/memories`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    // Surface the capacity limit as a typed error so callers can show a clear
    // "memory full" message instead of a generic failure.
    if (res.status === 409) {
      const data = (await res.json().catch(() => ({}))) as { error?: string; limit?: number };
      throw new MemoryFullError(
        data.error ?? "You've reached your saved-memory limit.",
        data.limit,
      );
    }
    throw new Error(`Failed to create memory (${res.status})`);
  }
  const data = (await res.json()) as { memory: OraMemory; superseded?: SupersededMemory[] };
  return { memory: data.memory, superseded: data.superseded ?? [] };
}

export interface OraMemoryUsage {
  count: number;
  limit: number;
}

/** Shared React Query key for the memory capacity meter. */
export const ORA_MEMORY_USAGE_QUERY_KEY = ["ora-memory-usage"] as const;

/** Fetch how many memories the user has saved against their cap. */
export async function fetchOraMemoryUsage(): Promise<OraMemoryUsage> {
  const res = await authFetch(`${BASE}/api/ora/memories/usage`);
  if (!res.ok) throw new Error(`Failed to load memory usage (${res.status})`);
  return (await res.json()) as OraMemoryUsage;
}

export async function updateOraMemory(
  id: number,
  patch: { title?: string; content?: string; enabled?: boolean; category?: OraMemoryCategory },
): Promise<OraMemory> {
  const res = await authFetch(`${BASE}/api/ora/memories/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Failed to update memory (${res.status})`);
  const data = (await res.json()) as { memory: OraMemory };
  return data.memory;
}

export async function restoreOraMemory(id: number): Promise<OraMemory> {
  const res = await authFetch(`${BASE}/api/ora/memories/${id}/restore`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`Failed to restore memory (${res.status})`);
  const data = (await res.json()) as { memory: OraMemory };
  return data.memory;
}

export async function deleteOraMemory(id: number): Promise<void> {
  const res = await authFetch(`${BASE}/api/ora/memories/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to delete memory (${res.status})`);
}

export async function clearOraMemories(): Promise<void> {
  const res = await authFetch(`${BASE}/api/ora/memories`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to clear memories (${res.status})`);
}

export async function clearOraConversations(): Promise<void> {
  const res = await authFetch(`${BASE}/api/ora/conversations`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to clear conversations (${res.status})`);
}

export interface RememberDocumentResult {
  saved: boolean;
  /** When true the summary looked sensitive — re-call with confirmSensitive. */
  requiresConfirmation?: boolean;
  sensitive?: boolean;
  /** The concise summary that was (or would be) saved. */
  summary?: string;
}

/**
 * Persist a concise summary of an analyzed document into Ora's memory (opt-in,
 * Task #1372). The backend summarizes the still-cached file by its ref — the
 * raw bytes are never stored. A summary flagged sensitive is NOT saved until the
 * caller re-invokes with confirmSensitive=true. When `oraProjectId` is set the
 * memory is anchored to that project (ownership-validated server-side).
 */
export async function rememberDocument(
  fileRef: string,
  confirmSensitive = false,
  oraProjectId?: number | null,
): Promise<RememberDocumentResult> {
  const res = await authFetch(`${BASE}/api/public-ai/remember-document`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fileRef,
      ...(confirmSensitive ? { confirmSensitive: true } : {}),
      ...(typeof oraProjectId === "number" ? { oraProjectId } : {}),
    }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Failed to save document to memory (${res.status})`);
  }
  return (await res.json()) as RememberDocumentResult;
}
