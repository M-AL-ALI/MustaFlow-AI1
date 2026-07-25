import {
  ORA_REALTIME_TOOL_ACTIVITY,
  ORA_REALTIME_TOOL_NAMES,
  oraRealtimeToolActivity,
  type OraActivityTool,
  type OraRealtimeToolName,
} from "@workspace/ora-contracts";

export interface RealtimeToolDefinition {
  type: "function";
  name: OraRealtimeToolName;
  description: string;
  parameters: Record<string, unknown>;
}

export const REALTIME_TOOL_ACTIVITY = ORA_REALTIME_TOOL_ACTIVITY;

function toolDescription(name: OraRealtimeToolName, description: string): string {
  const activity = oraRealtimeToolActivity(name);
  return `${description} The client narrates ${activity} activity automatically; call the function without adding a separate status preamble.`;
}

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: "object",
  additionalProperties: false,
  properties,
  ...(required.length > 0 ? { required } : {}),
});

const repoProperty = {
  type: "string",
  description:
    "Optional connected repository name or owner/name. Omit to use the already selected repository. Never require a pasted URL.",
  maxLength: 250,
};

/** Exact function surface minted into every Ora realtime session. */
export const ORA_REALTIME_TOOL_DEFINITIONS: readonly RealtimeToolDefinition[] = [
  {
    type: "function",
    name: "web_search",
    description: toolDescription(
      "web_search",
      "Search the live web for current or verifiable information and return a grounded answer with sources.",
    ),
    parameters: objectSchema(
      {
        query: { type: "string", description: "The complete search question.", maxLength: 4000 },
      },
      ["query"],
    ),
  },
  {
    type: "function",
    name: "list_files",
    description: toolDescription(
      "list_files",
      "List files and directories in the user's connected GitHub repository. Read-only.",
    ),
    parameters: objectSchema({
      repo: repoProperty,
      path: { type: "string", description: "Repo-relative directory path.", maxLength: 500 },
    }),
  },
  {
    type: "function",
    name: "read_file",
    description: toolDescription(
      "read_file",
      "Read a bounded line range from a file in the connected GitHub repository. Read-only.",
    ),
    parameters: objectSchema(
      {
        repo: repoProperty,
        path: { type: "string", description: "Repo-relative file path.", maxLength: 500 },
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
      },
      ["path"],
    ),
  },
  {
    type: "function",
    name: "search_repo",
    description: toolDescription(
      "search_repo",
      "Search text in the user's connected GitHub repository. Read-only.",
    ),
    parameters: objectSchema(
      {
        repo: repoProperty,
        query: { type: "string", description: "Text to find.", maxLength: 200 },
      },
      ["query"],
    ),
  },
  {
    type: "function",
    name: "read_commits",
    description: toolDescription(
      "read_commits",
      "Read recent commit history from the connected GitHub repository. Read-only.",
    ),
    parameters: objectSchema({
      repo: repoProperty,
      limit: { type: "integer", minimum: 1, maximum: 30 },
    }),
  },
  {
    type: "function",
    name: "diff",
    description: toolDescription(
      "diff",
      "Read the diff for one commit in the connected GitHub repository. Read-only.",
    ),
    parameters: objectSchema(
      {
        repo: repoProperty,
        sha: { type: "string", description: "Commit SHA to inspect.", maxLength: 100 },
      },
      ["sha"],
    ),
  },
  {
    type: "function",
    name: "generate_file",
    description: toolDescription(
      "generate_file",
      "Create or revise a professional Ora file using the same file builder and attached-file context as text chat.",
    ),
    parameters: objectSchema(
      {
        prompt: {
          type: "string",
          description: "Complete file creation or revision instruction.",
          maxLength: 8000,
        },
        format: { type: "string", enum: ["csv", "xlsx", "docx", "pdf", "pptx"] },
      },
      ["prompt", "format"],
    ),
  },
  {
    type: "function",
    name: "generate_image",
    description: toolDescription(
      "generate_image",
      "Generate an image with Ora's existing image engine.",
    ),
    parameters: objectSchema(
      {
        prompt: { type: "string", description: "Complete image brief.", maxLength: 4000 },
      },
      ["prompt"],
    ),
  },
  {
    type: "function",
    name: "analyze_repo",
    description: toolDescription(
      "analyze_repo",
      "Run Ora's full multi-step read-only repository analyst to find bugs, verify behavior, or produce a guidance report.",
    ),
    parameters: objectSchema(
      {
        question: {
          type: "string",
          description: "The repository investigation request.",
          maxLength: 8000,
        },
        repo: repoProperty,
      },
      ["question"],
    ),
  },
] as const;

export function realtimeToolActivity(name: OraRealtimeToolName): OraActivityTool {
  return REALTIME_TOOL_ACTIVITY[name];
}

export function assertRealtimeToolSurface(): void {
  const names = ORA_REALTIME_TOOL_DEFINITIONS.map((tool) => tool.name);
  if (
    names.length !== ORA_REALTIME_TOOL_NAMES.length ||
    names.some((name, index) => name !== ORA_REALTIME_TOOL_NAMES[index])
  ) {
    throw new Error("Ora realtime tool declarations drifted from the shared contract.");
  }
}
