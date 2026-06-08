import { DEFAULT_ORA_MEMORY_CATEGORY, type OraMemoryCategory } from "@workspace/db";

/**
 * Heuristic, dependency-free classifier for Ora memories. Runs on save to pick
 * a sensible default category (the user can always re-categorize from the Memory
 * Center). Deliberately cheap and deterministic — no AI call — so saving stays
 * fast and predictable.
 *
 * Scoring: count keyword hits per category on the lowercased title+content and
 * take the highest. Ties and zero-hit cases fall back to the default ("other").
 */
const KEYWORDS: Record<Exclude<OraMemoryCategory, "other" | "document">, string[]> = {
  preference: [
    "prefer",
    "favorite",
    "favourite",
    "i like",
    "i love",
    "always use",
    "never use",
    "avoid",
    "don't",
    "do not",
    "tone",
    "style",
    "concise",
    "verbose",
    "formal",
    "casual",
    "dark mode",
    "light mode",
    "default to",
    "color",
    "colour",
    "theme",
    "font",
    "format",
  ],
  personal: [
    "my name",
    "name is",
    "i am ",
    "i'm ",
    "i live",
    "i work",
    "based in",
    "located in",
    "email is",
    "phone",
    "birthday",
    "i was born",
    "pronoun",
    "my job",
    "my role",
    "my title",
    "my company",
    "i have a",
    "family",
    "married",
    "speak ",
    "native",
  ],
  project: [
    "project",
    "app called",
    "building",
    "website for",
    "feature",
    "deadline",
    "tech stack",
    "stack",
    "database",
    "deploy",
    "client",
    "customer",
    "product",
    "launch",
    "repo",
    "codebase",
    "endpoint",
    "integration",
  ],
};

export function classifyOraMemoryCategory(title: string, content: string): OraMemoryCategory {
  const text = `${title} ${content}`.toLowerCase();
  if (text.trim().length === 0) return DEFAULT_ORA_MEMORY_CATEGORY;

  let best: OraMemoryCategory = DEFAULT_ORA_MEMORY_CATEGORY;
  let bestScore = 0;
  for (const category of Object.keys(KEYWORDS) as Array<keyof typeof KEYWORDS>) {
    let score = 0;
    for (const kw of KEYWORDS[category]) {
      if (text.includes(kw)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = category;
    }
  }
  return best;
}
