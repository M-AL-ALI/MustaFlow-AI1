import { WORKSPACE_TOOLS, type WorkspaceToolId } from "@workspace/nabuflow-workspace-tools";

type RegisteredTool = (typeof WORKSPACE_TOOLS)[number];
// Synonyms resolve to existing destinations. They do not create tools, grant
// access, or change the registry's published-only availability.
const SEARCH_ALIASES = {
  terminal: "shell command line cli",
  database: "sql postgres neon tables data schema queries",
  logs: "logs console output server messages",
  runtime: "runtime environment hosting",
  checkpoints: "checkpoints restore rollback",
  knowledge: "knowledge memory saved context",
  images: "image studio library pictures",
  integrations: "connections connectors external services",
  publishing: "publish deploy deployment domains",
  code: "files source editor",
  "page-map": "pages routes routing sitemap navigation connections",
  "tools-files": "project configuration setup",
} satisfies Partial<Record<WorkspaceToolId, string>>;

const ARABIC_SEARCH_ALIASES = {
  preview:
    "\u0645\u0639\u0627\u064a\u0646\u0629 \u0639\u0631\u0636 \u0627\u0644\u062a\u0637\u0628\u064a\u0642",
  "page-map":
    "\u062e\u0631\u064a\u0637\u0629 \u0627\u0644\u0635\u0641\u062d\u0627\u062a \u0645\u0633\u0627\u0631\u0627\u062a \u0631\u0628\u0637 \u0627\u0644\u0635\u0641\u062d\u0627\u062a",
  plan: "\u062e\u0637\u0629 \u062a\u062e\u0637\u064a\u0637 \u0645\u0647\u0627\u0645",
  images:
    "\u0635\u0648\u0631 \u0627\u0644\u0635\u0648\u0631 \u0645\u0643\u062a\u0628\u0629 \u0627\u0644\u0635\u0648\u0631 \u0627\u0633\u062a\u0648\u062f\u064a\u0648 \u0627\u0644\u0635\u0648\u0631",
  code: "\u0645\u0644\u0641\u0627\u062a \u0643\u0648\u062f \u0634\u064a\u0641\u0631\u0629 \u0645\u062d\u0631\u0631 \u0627\u0644\u0645\u0644\u0641\u0627\u062a",
  recipes:
    "\u0648\u0635\u0641\u0627\u062a \u0642\u0648\u0627\u0644\u0628 \u0648\u062d\u062f\u0627\u062a",
  workflows:
    "\u0633\u064a\u0631 \u0627\u0644\u0639\u0645\u0644 \u062a\u062f\u0641\u0642\u0627\u062a \u0627\u0644\u0639\u0645\u0644 \u062a\u0634\u063a\u064a\u0644 \u0627\u0644\u0645\u0647\u0627\u0645",
  publishing:
    "\u0646\u0634\u0631 \u0627\u0644\u062a\u0637\u0628\u064a\u0642 \u0646\u0637\u0627\u0642\u0627\u062a \u0627\u0644\u062f\u0648\u0645\u064a\u0646",
  manage:
    "\u0625\u062f\u0627\u0631\u0629 \u0627\u0644\u0645\u0634\u0631\u0648\u0639 \u0625\u0639\u062f\u0627\u062f\u0627\u062a \u0627\u0644\u0645\u0634\u0631\u0648\u0639",
  terminal:
    "\u0637\u0631\u0641\u064a\u0629 \u0623\u0648\u0627\u0645\u0631 \u0633\u0637\u0631 \u0627\u0644\u0623\u0648\u0627\u0645\u0631 \u0634\u0644",
  canvas:
    "\u062a\u0635\u0645\u064a\u0645 \u0644\u0648\u062d\u0629 \u0627\u0644\u0631\u0633\u0645 \u0644\u0648\u062d\u0629 \u0627\u0644\u062a\u0635\u0645\u064a\u0645",
  secrets:
    "\u0627\u0644\u0623\u0633\u0631\u0627\u0631 \u0623\u0633\u0631\u0627\u0631 \u0627\u0644\u0645\u0641\u0627\u062a\u064a\u062d \u0645\u0641\u0627\u062a\u064a\u062d \u0645\u062a\u063a\u064a\u0631\u0627\u062a \u0627\u0644\u0628\u064a\u0626\u0629",
  "tools-files":
    "\u0625\u0639\u062f\u0627\u062f \u0627\u0644\u0645\u0634\u0631\u0648\u0639 \u062a\u0647\u064a\u0626\u0629 \u0627\u0644\u0645\u0634\u0631\u0648\u0639",
  integrations:
    "\u062a\u0643\u0627\u0645\u0644 \u062a\u0643\u0627\u0645\u0644\u0627\u062a \u0631\u0628\u0637 \u062e\u062f\u0645\u0627\u062a \u0627\u062a\u0635\u0627\u0644\u0627\u062a",
  checks:
    "\u0641\u062d\u0648\u0635 \u0627\u062e\u062a\u0628\u0627\u0631\u0627\u062a \u0627\u062e\u062a\u0628\u0627\u0631 \u062a\u062d\u0642\u0642",
  security:
    "\u0623\u0645\u0627\u0646 \u0623\u0645\u0646 \u062d\u0645\u0627\u064a\u0629 \u062b\u063a\u0631\u0627\u062a",
  knowledge:
    "\u0645\u0639\u0631\u0641\u0629 \u0630\u0627\u0643\u0631\u0629 \u0633\u064a\u0627\u0642 \u0645\u062d\u0641\u0648\u0638",
  database:
    "\u0642\u0627\u0639\u062f\u0629 \u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a \u0642\u0648\u0627\u0639\u062f \u0628\u064a\u0627\u0646\u0627\u062a \u062c\u062f\u0627\u0648\u0644 \u0627\u0633\u062a\u0639\u0644\u0627\u0645\u0627\u062a",
  runtime:
    "\u062e\u0627\u062f\u0645 \u0627\u0644\u062e\u0627\u062f\u0645 \u0627\u0644\u0633\u064a\u0631\u0641\u0631 \u0627\u0633\u062a\u0636\u0627\u0641\u0629 \u0628\u064a\u0626\u0629 \u0627\u0644\u062a\u0634\u063a\u064a\u0644",
  git: "\u062c\u064a\u062a \u0625\u0635\u062f\u0627\u0631\u0627\u062a \u0645\u0633\u062a\u0648\u062f\u0639 \u0645\u0632\u0627\u0645\u0646\u0629",
  logs: "\u0633\u062c\u0644\u0627\u062a \u0633\u062c\u0644 \u0645\u062e\u0631\u062c\u0627\u062a \u0648\u062d\u062f\u0629 \u0627\u0644\u062a\u062d\u0643\u0645",
  resources:
    "\u0645\u0648\u0627\u0631\u062f \u062a\u0648\u062b\u064a\u0642 \u062f\u0644\u064a\u0644",
  analytics:
    "\u062a\u062d\u0644\u064a\u0644\u0627\u062a \u0625\u062d\u0635\u0627\u0626\u064a\u0627\u062a \u0632\u064a\u0627\u0631\u0627\u062a",
  health: "\u0635\u062d\u0629 \u0627\u0644\u0645\u0634\u0631\u0648\u0639 \u062c\u0648\u062f\u0629",
  comments: "\u062a\u0639\u0644\u064a\u0642\u0627\u062a \u0645\u0644\u0627\u062d\u0638\u0627\u062a",
  "activity-log":
    "\u0633\u062c\u0644 \u0627\u0644\u0646\u0634\u0627\u0637 \u062a\u0627\u0631\u064a\u062e \u0627\u0644\u0646\u0634\u0627\u0637",
  checkpoints:
    "\u0646\u0642\u0627\u0637 \u0627\u0644\u062d\u0641\u0638 \u062d\u0641\u0638 \u0627\u0633\u062a\u0639\u0627\u062f\u0629 \u0631\u062c\u0648\u0639",
} satisfies Record<WorkspaceToolId, string>;

/** Normalize search only; names, destinations and access policy stay unchanged. */
function normalizeToolSearch(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u0610-\u061a\u0640\u064b-\u065f\u0670\u06d6-\u06ed]/gu, "")
    .replace(/[\u0622\u0623\u0625\u0671]/gu, "\u0627")
    .replace(/\u0649/gu, "\u064a")
    .trim();
}
export function projectToolSearchText(tool: RegisteredTool): string {
  const aliases = SEARCH_ALIASES[tool.id as keyof typeof SEARCH_ALIASES] ?? "";
  return [
    tool.name,
    tool.description,
    tool.category,
    tool.id,
    aliases,
    ARABIC_SEARCH_ALIASES[tool.id],
  ].join(" ");
}
export function findProjectTools(query: string, isPublished: boolean): RegisteredTool[] {
  const terms = normalizeToolSearch(query).split(/\s+/u).filter(Boolean);
  const normalizedQuery = terms.join(" ");
  const matches = WORKSPACE_TOOLS.filter((tool) => {
    if (tool.availability !== "always" && !isPublished) return false;
    const text = normalizeToolSearch(projectToolSearchText(tool));
    return terms.every((term) => text.includes(term));
  });
  if (!normalizedQuery) return matches;
  const rank = (tool: RegisteredTool): number => {
    const name = normalizeToolSearch(tool.name);
    const id = normalizeToolSearch(tool.id);
    if (name === normalizedQuery) return 0;
    if (id === normalizedQuery) return 1;
    if (name.startsWith(normalizedQuery)) return 2;
    if (id.startsWith(normalizedQuery)) return 3;
    return 4;
  };
  // Keep registry order for equal scores, but never let an alias outrank a
  // tool explicitly requested by its displayed name or registered ID.
  return matches.sort((left, right) => rank(left) - rank(right));
}
