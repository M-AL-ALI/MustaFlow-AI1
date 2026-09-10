import { WORKSPACE_TOOLS, type WorkspaceToolId } from "@workspace/nabuflow-workspace-tools";

type RegisteredTool = (typeof WORKSPACE_TOOLS)[number];
// Synonyms resolve to existing destinations. They do not create tools, grant
// access, or change the registry's published-only availability.
const SEARCH_ALIASES = {
  terminal: "shell command line cli",
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

export function projectToolSearchText(tool: RegisteredTool): string {
  const aliases = SEARCH_ALIASES[tool.id as keyof typeof SEARCH_ALIASES] ?? "";
  return [tool.name, tool.description, tool.category, tool.id, aliases].join(" ");
}
export function findProjectTools(query: string, isPublished: boolean): RegisteredTool[] {
  const normalized = query.trim().toLowerCase();
  return WORKSPACE_TOOLS.filter(
    (tool) =>
      (tool.availability === "always" || isPublished) &&
      (!normalized || projectToolSearchText(tool).toLowerCase().includes(normalized)),
  );
}
