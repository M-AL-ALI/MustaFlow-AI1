export const WORKSPACE_TOOL_CATEGORIES = ["Build", "Connect", "Configure", "Protect"] as const;

export type WorkspaceToolCategory = (typeof WORKSPACE_TOOL_CATEGORIES)[number];

export type WorkspaceTool = {
  id: string;
  name: string;
  description: string;
  category: WorkspaceToolCategory;
  open: {
    kind: "workspace-tab";
    tabId: string;
    subview?: string;
  };
  placement: "primary" | "tools" | "launcher";
  availability: "always" | "published";
};

export const WORKSPACE_TOOLS = [
  {
    id: "preview",
    name: "Preview",
    description: "See and use the app while Zero builds it.",
    category: "Build",
    open: { kind: "workspace-tab", tabId: "preview" },
    placement: "primary",
    availability: "always",
  },
  {
    id: "page-map",
    name: "Page map",
    description: "Browse every page in the app and open it in Preview.",
    category: "Build",
    open: { kind: "workspace-tab", tabId: "page-map" },
    placement: "primary",
    availability: "always",
  },
  {
    id: "plan",
    name: "Plan",
    description: "Review the build plan and start individual steps.",
    category: "Build",
    open: { kind: "workspace-tab", tabId: "plan" },
    placement: "primary",
    availability: "always",
  },
  {
    id: "images",
    name: "Images",
    description: "View, regenerate, and add project images to the app.",
    category: "Build",
    open: { kind: "workspace-tab", tabId: "images" },
    placement: "tools",
    availability: "always",
  },
  {
    id: "code",
    name: "Code",
    description: "Inspect and edit the files that make up the app.",
    category: "Build",
    open: { kind: "workspace-tab", tabId: "code" },
    placement: "tools",
    availability: "always",
  },
  {
    id: "recipes",
    name: "Recipes",
    description: "Use reusable project patterns and guided setup steps.",
    category: "Build",
    open: { kind: "workspace-tab", tabId: "recipes" },
    placement: "tools",
    availability: "always",
  },
  {
    id: "workflows",
    name: "Workflows",
    description: "Run repeatable project commands inside the app's container.",
    category: "Build",
    open: { kind: "workspace-tab", tabId: "tools-files", subview: "shell" },
    placement: "launcher",
    availability: "always",
  },
  {
    id: "publishing",
    name: "Publishing",
    description: "Put the app online and manage its published version.",
    category: "Build",
    open: { kind: "workspace-tab", tabId: "publishing" },
    placement: "tools",
    availability: "always",
  },
  {
    id: "terminal",
    name: "Terminal",
    description: "Run commands one at a time inside this project's container.",
    category: "Build",
    open: { kind: "workspace-tab", tabId: "terminal" },
    placement: "tools",
    availability: "always",
  },
  {
    id: "logs",
    name: "Console output",
    description: "Follow the running app's latest server messages.",
    category: "Build",
    open: { kind: "workspace-tab", tabId: "logs" },
    placement: "tools",
    availability: "always",
  },
  {
    id: "canvas",
    name: "Canvas",
    description: "Sketch screens and ideas beside the working app.",
    category: "Build",
    open: { kind: "workspace-tab", tabId: "canvas" },
    placement: "tools",
    availability: "always",
  },
  {
    id: "activity-log",
    name: "Activity",
    description: "Review the project's recent build and workspace activity.",
    category: "Build",
    open: { kind: "workspace-tab", tabId: "activity-log" },
    placement: "tools",
    availability: "always",
  },
  {
    id: "integrations",
    name: "Integrations",
    description: "Connect outside services that your app needs.",
    category: "Connect",
    open: { kind: "workspace-tab", tabId: "integrations" },
    placement: "tools",
    availability: "always",
  },
  {
    id: "git",
    name: "GitHub",
    description: "Connect a repository and keep the project in sync.",
    category: "Connect",
    open: { kind: "workspace-tab", tabId: "git" },
    placement: "tools",
    availability: "always",
  },
  {
    id: "database",
    name: "Database",
    description: "Connect and inspect the data used by this project.",
    category: "Connect",
    open: { kind: "workspace-tab", tabId: "database" },
    placement: "tools",
    availability: "always",
  },
  {
    id: "comments",
    name: "Comments",
    description: "Collect and review feedback attached to the project.",
    category: "Connect",
    open: { kind: "workspace-tab", tabId: "comments" },
    placement: "tools",
    availability: "always",
  },
  {
    id: "manage",
    name: "Manage project",
    description: "Change the project's name and other basic settings.",
    category: "Configure",
    open: { kind: "workspace-tab", tabId: "manage" },
    placement: "tools",
    availability: "always",
  },
  {
    id: "secrets",
    name: "Secrets",
    description: "Safely store private keys and settings for this project.",
    category: "Configure",
    open: { kind: "workspace-tab", tabId: "secrets" },
    placement: "tools",
    availability: "always",
  },
  {
    id: "tools-files",
    name: "Project setup",
    description: "Choose project features, workflows, and inspect the setup files.",
    category: "Configure",
    open: { kind: "workspace-tab", tabId: "tools-files", subview: "files" },
    placement: "tools",
    availability: "always",
  },
  {
    id: "knowledge",
    name: "Saved context",
    description: "Review the preferences and lessons Zero can reuse.",
    category: "Configure",
    open: { kind: "workspace-tab", tabId: "knowledge" },
    placement: "tools",
    availability: "always",
  },
  {
    id: "runtime",
    name: "Server",
    description: "Start, stop, and inspect the project's app server.",
    category: "Configure",
    open: { kind: "workspace-tab", tabId: "runtime" },
    placement: "tools",
    availability: "always",
  },
  {
    id: "resources",
    name: "Resources",
    description: "Review the limits and resources available to this project.",
    category: "Configure",
    open: { kind: "workspace-tab", tabId: "resources" },
    placement: "tools",
    availability: "always",
  },
  {
    id: "checkpoints",
    name: "Version history",
    description: "Restore an earlier version without losing today's work.",
    category: "Configure",
    open: { kind: "workspace-tab", tabId: "checkpoints" },
    placement: "tools",
    availability: "always",
  },
  {
    id: "checks",
    name: "Checks",
    description: "See whether the app passes its automated quality checks.",
    category: "Protect",
    open: { kind: "workspace-tab", tabId: "checks" },
    placement: "tools",
    availability: "always",
  },
  {
    id: "security",
    name: "Security",
    description: "Review security findings and recommended fixes.",
    category: "Protect",
    open: { kind: "workspace-tab", tabId: "security" },
    placement: "tools",
    availability: "always",
  },
  {
    id: "health",
    name: "Health",
    description: "Check whether the app and its services are healthy.",
    category: "Protect",
    open: { kind: "workspace-tab", tabId: "health" },
    placement: "tools",
    availability: "always",
  },
  {
    id: "analytics",
    name: "Analytics",
    description: "Understand visits and usage after the app is published.",
    category: "Protect",
    open: { kind: "workspace-tab", tabId: "analytics" },
    placement: "tools",
    availability: "published",
  },
] as const satisfies readonly WorkspaceTool[];

export type WorkspaceToolId = (typeof WORKSPACE_TOOLS)[number]["id"];
export type WorkspaceTabId = (typeof WORKSPACE_TOOLS)[number]["open"]["tabId"];
export type WorkspaceToolOpen = WorkspaceTool["open"];

export function formatWorkspaceToolsForAgent(): string {
  const lines = WORKSPACE_TOOLS.map(
    (tool) =>
      `- ${tool.category} / ${tool.name}: ${tool.description} Open Tools and pick ${tool.name} under ${tool.category}.`,
  );
  return [
    "NABUFLOW WORKSPACE TOOLS (guide the user to these exact locations; do not invent tools):",
    ...lines,
  ].join("\n");
}
