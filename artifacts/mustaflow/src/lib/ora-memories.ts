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
  createdAt: string;
}

export async function fetchOraMemories(): Promise<OraMemory[]> {
  const res = await authFetch(`${BASE}/api/ora/memories`);
  if (!res.ok) throw new Error(`Failed to load memories (${res.status})`);
  const data = (await res.json()) as { memories: OraMemory[] };
  return data.memories;
}

export async function createOraMemory(patch: {
  title: string;
  content?: string;
  category?: OraMemoryCategory;
}): Promise<OraMemory> {
  const res = await authFetch(`${BASE}/api/ora/memories`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Failed to create memory (${res.status})`);
  const data = (await res.json()) as { memory: OraMemory };
  return data.memory;
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
 * caller re-invokes with confirmSensitive=true.
 */
export async function rememberDocument(
  fileRef: string,
  confirmSensitive = false,
): Promise<RememberDocumentResult> {
  const res = await fetch(`${BASE}/api/public-ai/remember-document`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileRef, ...(confirmSensitive ? { confirmSensitive: true } : {}) }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Failed to save document to memory (${res.status})`);
  }
  return (await res.json()) as RememberDocumentResult;
}
