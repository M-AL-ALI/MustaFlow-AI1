/**
 * Workflows-as-data (Task #538)
 *
 * A project may define a `workflows.yaml` file at its root listing named
 * commands that can be executed in its container. The agent can call
 * `run_workflow({ name })` and users can click Run buttons in the UI.
 *
 * Schema (top-level `workflows:` key, list of entries):
 *
 *   workflows:
 *     - name: dev
 *       command: npm run dev
 *       cwd: .
 *     - name: test
 *       command: npm test -- --run
 *       env:
 *         NODE_ENV: test
 *
 * We intentionally only support a small subset of YAML so we don't need a
 * full parser as a dependency. Unknown fields are ignored.
 */
import { db, projectFilesTable, projectsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

export interface WorkflowEntry {
  name: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  description?: string;
}

const WORKFLOWS_PATH_CANDIDATES = ["workflows.yaml", "workflows.yml", ".replit/workflows.yaml"];

/** Tiny YAML reader for the supported workflow schema. Not a general parser. */
export function parseWorkflowsYaml(source: string): WorkflowEntry[] {
  const lines = source.split(/\r?\n/);
  let inWorkflows = false;
  const entries: WorkflowEntry[] = [];
  let current: Partial<WorkflowEntry> | null = null;
  let envIndent: number | null = null;

  const pushCurrent = () => {
    if (current && typeof current.name === "string" && typeof current.command === "string") {
      entries.push(current as WorkflowEntry);
    }
    current = null;
    envIndent = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;

    if (!inWorkflows) {
      if (/^workflows\s*:\s*$/.test(line.trim())) inWorkflows = true;
      continue;
    }

    // A new list item starts a new workflow entry.
    const itemMatch = line.match(/^(\s*)-\s*(.*)$/);
    if (itemMatch && indent <= 2) {
      pushCurrent();
      current = {};
      const rest = itemMatch[2]?.trim() ?? "";
      const kv = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
      if (kv) assignField(current, kv[1]!, kv[2]!);
      continue;
    }

    if (!current) continue;

    // Inside env: block (indented key: value pairs)
    if (envIndent != null && indent >= envIndent) {
      const kv = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
      if (kv) {
        current.env = current.env ?? {};
        current.env[kv[1]!] = stripQuotes(kv[2]!);
        continue;
      }
    }

    // Regular field on the current entry.
    const fieldMatch = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (fieldMatch) {
      const [, key, valRaw] = fieldMatch;
      const val = valRaw!.trim();
      if (key === "env" && val === "") {
        envIndent = indent + 2;
        current.env = current.env ?? {};
      } else {
        envIndent = null;
        assignField(current, key!, val);
      }
    }
  }
  pushCurrent();

  // Deduplicate by name (later entries win).
  const byName = new Map<string, WorkflowEntry>();
  for (const e of entries) byName.set(e.name, e);
  return Array.from(byName.values());
}

function assignField(target: Partial<WorkflowEntry>, key: string, valRaw: string) {
  const val = stripQuotes(valRaw.trim());
  if (!val) return;
  if (key === "name" || key === "command" || key === "cwd" || key === "description") {
    (target as Record<string, string>)[key] = val;
  }
}

function stripQuotes(s: string): string {
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/** Per-stack defaults when no workflows.yaml exists. */
export function defaultWorkflowsForStack(stack: string | null | undefined): WorkflowEntry[] {
  switch (stack) {
    case "react-vite":
      return [
        { name: "dev", command: "npm run dev", description: "Start the Vite dev server" },
        { name: "build", command: "npm run build", description: "Production build" },
        { name: "typecheck", command: "npx tsc --noEmit" },
      ];
    case "node-api":
      return [
        { name: "start", command: "npm start" },
        { name: "dev", command: "npm run dev" },
        { name: "test", command: "npm test -- --run" },
      ];
    case "nextjs":
      return [
        { name: "dev", command: "npm run dev" },
        { name: "build", command: "npm run build" },
        { name: "start", command: "npm start" },
      ];
    case "python-flask":
    case "python-fastapi":
      return [{ name: "dev", command: "python main.py" }];
    default:
      return [];
  }
}

export async function loadProjectWorkflows(projectId: number): Promise<{
  source: "yaml" | "defaults";
  entries: WorkflowEntry[];
}> {
  for (const path of WORKFLOWS_PATH_CANDIDATES) {
    const [file] = await db
      .select({ content: projectFilesTable.content })
      .from(projectFilesTable)
      .where(and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.path, path)));
    if (file?.content) {
      const entries = parseWorkflowsYaml(file.content);
      if (entries.length > 0) return { source: "yaml", entries };
    }
  }
  const [proj] = await db
    .select({ stack: projectsTable.stack })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));
  return { source: "defaults", entries: defaultWorkflowsForStack(proj?.stack) };
}

export async function findWorkflow(projectId: number, name: string): Promise<WorkflowEntry | null> {
  const { entries } = await loadProjectWorkflows(projectId);
  return entries.find((e) => e.name === name) ?? null;
}
