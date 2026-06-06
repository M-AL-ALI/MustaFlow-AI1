import { authFetch } from "@/lib/api-fetch";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export interface OraMemory {
  id: number;
  title: string;
  content: string;
  enabled: boolean;
  sourceConversationId: number | null;
  createdAt: string;
}

export async function fetchOraMemories(): Promise<OraMemory[]> {
  const res = await authFetch(`${BASE}/api/ora/memories`);
  if (!res.ok) throw new Error(`Failed to load memories (${res.status})`);
  const data = (await res.json()) as { memories: OraMemory[] };
  return data.memories;
}

export async function updateOraMemory(
  id: number,
  patch: { title?: string; content?: string; enabled?: boolean },
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
