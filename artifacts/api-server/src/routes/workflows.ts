/**
 * Project workflows (Task #538) — list and run.
 *
 *   GET  /api/projects/:id/workflows                — list parsed workflows.yaml + per-stack defaults
 *   POST /api/projects/:id/workflows/:name/run     — execute the named workflow in the project container
 */
import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, projectsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { loadProjectWorkflows, findWorkflow } from "../lib/workflows";

const router: IRouter = Router();

router.get("/projects/:id/workflows", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }
  const { source, entries } = await loadProjectWorkflows(projectId);
  res.json({ source, workflows: entries });
});

router.post(
  "/projects/:id/workflows/:name/run",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const name = String(req.params.name ?? "");
    if (!Number.isInteger(projectId) || !name) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    const wf = await findWorkflow(projectId, name);
    if (!wf) {
      res.status(404).json({ error: `Workflow "${name}" not found` });
      return;
    }

    const [proj] = await db
      .select({
        containerId: projectsTable.containerId,
        containerStatus: projectsTable.containerStatus,
      })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId));

    if (!proj?.containerId || proj.containerStatus !== "running") {
      res.status(409).json({
        error: "Project container is not running. Start the container before running a workflow.",
        containerStatus: proj?.containerStatus ?? "missing",
      });
      return;
    }

    try {
      const { execInContainer } = await import("../lib/tenant-runtime");
      const cwd = wf.cwd ?? ".";
      const envPrefix = wf.env
        ? Object.entries(wf.env)
            .map(([k, v]) => `${k}=${shellEscape(v)}`)
            .join(" ") + " "
        : "";
      const cmd = `cd ${shellEscape(cwd)} && ${envPrefix}${wf.command}`;
      const result = await execInContainer(proj.containerId, ["sh", "-lc", cmd], projectId);
      res.json({
        name: wf.name,
        ok: result.ok,
        output: result.output.slice(0, 100_000),
        command: wf.command,
        cwd,
      });
    } catch (err) {
      req.log.error({ err, projectId, name }, "Workflow run failed");
      res.status(500).json({
        error: `Failed to run workflow: ${err instanceof Error ? err.message : "Unknown error"}`,
      });
    }
  },
);

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export default router;
