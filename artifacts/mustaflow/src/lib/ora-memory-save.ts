import { authFetch } from "@/lib/api-fetch";

// Shared persistence for Ora-detected memories. Both the inline save chip and
// the opt-in auto-save path go through here so the stored shape stays identical:
// a user-scoped knowledge "note" — the same store the Memory page reads/writes.

function deriveTitle(fact: string): string {
  const firstLine = fact.split(/[.\n]/)[0]?.trim() || fact.trim();
  return firstLine.length > 60 ? `${firstLine.slice(0, 57).trimEnd()}…` : firstLine;
}

/**
 * Persist a durable fact to the signed-in user's Ora memory. Throws on any
 * non-2xx response so callers can surface an error and avoid marking the
 * candidate as saved.
 */
export async function saveOraMemory(fact: string): Promise<void> {
  const content = fact.trim();
  if (!content) throw new Error("Cannot save an empty memory");

  const res = await authFetch("/api/knowledge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: deriveTitle(content),
      content,
      type: "note",
      category: "note",
      scope: "user",
    }),
  });

  if (!res.ok) throw new Error(`Failed to save memory (HTTP ${res.status})`);
}
