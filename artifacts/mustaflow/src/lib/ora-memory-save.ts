import { createOraMemory } from "@/lib/ora-memories";

// Shared persistence for Ora-detected memories. Both the inline save chip and
// the opt-in auto-save path go through here so the stored shape stays identical.
//
// ISOLATION: Ora memories MUST be written through the Ora endpoint
// (POST /api/ora/memories, origin="ora") — never POST /api/knowledge, which
// hardcodes origin="builder" and would misfile the save into the AI Builder
// Knowledge Vault (invisible to Ora and the Memory Center).

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

  // The Ora endpoint stores title + content; derive a short title from the fact
  // and keep the full fact as the content so nothing is lost.
  await createOraMemory({ title: deriveTitle(content), content });
}
