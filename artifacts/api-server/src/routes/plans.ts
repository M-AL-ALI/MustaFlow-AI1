/**
 * Plan Mode Leadership routes (Task #635):
 *  - GET  /plan-templates              — list system plan templates
 *  - GET  /projects/:id/plan-history   — all plan versions for a project
 *  - POST /projects/:id/plans/decompose — decompose a plan into ordered build steps
 *  - POST /projects/:id/plans/clarify  — get AI clarifying questions for an ambiguous prompt
 */
import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, planTemplatesTable, chatMessagesTable, projectsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { runPlanDecomposePipeline, runGuidedRefinementPipeline } from "../lib/builder";
import type { AgentMode } from "../lib/ai";
import { logger } from "../lib/logger";
import { z } from "zod";

const router: IRouter = Router();

// ── GET /plan-templates ───────────────────────────────────────────────────────
// Public (post-auth) — returns all system plan templates ordered by sort_order.
router.get("/plan-templates", async (_req, res): Promise<void> => {
  try {
    const rows = await db.select().from(planTemplatesTable).orderBy(planTemplatesTable.sortOrder);
    res.json(rows);
  } catch (err) {
    logger.error({ err }, "Failed to list plan templates");
    res.status(500).json({ error: "Failed to load templates" });
  }
});

// ── GET /projects/:id/plan-history ────────────────────────────────────────────
// Returns all assistant messages that carry a plan object, newest first.
router.get(
  "/projects/:id/plan-history",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (isNaN(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }
    try {
      const rows = await db
        .select({
          id: chatMessagesTable.id,
          content: chatMessagesTable.content,
          plan: chatMessagesTable.plan,
          createdAt: chatMessagesTable.createdAt,
          agentMode: chatMessagesTable.agentMode,
        })
        .from(chatMessagesTable)
        .where(eq(chatMessagesTable.projectId, projectId))
        .orderBy(desc(chatMessagesTable.createdAt));

      // Filter to only messages that have a plan
      const planMessages = rows.filter((r) => r.plan !== null && r.plan !== undefined);
      res.json(planMessages);
    } catch (err) {
      logger.error({ err, projectId }, "Failed to fetch plan history");
      res.status(500).json({ error: "Failed to load plan history" });
    }
  },
);

// ── POST /projects/:id/plans/decompose ────────────────────────────────────────
// Accepts a plan JSON and returns an ordered list of build steps.
const DecomposeBody = z.object({
  plan: z.record(z.unknown()),
  agentMode: z.enum(["lite", "eco", "power", "pro"]).default("eco"),
});

router.post(
  "/projects/:id/plans/decompose",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (isNaN(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }
    const parsed = DecomposeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { plan, agentMode } = parsed.data;

    const [project] = await db
      .select({ name: projectsTable.name, kind: projectsTable.kind })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    try {
      const result = await runPlanDecomposePipeline({
        projectName: project.name,
        projectKind: project.kind,
        plan,
        agentMode: agentMode as AgentMode,
      });
      res.json(result);
    } catch (err) {
      logger.error({ err, projectId }, "Plan decompose failed");
      res.status(500).json({ error: "Decomposition failed. Please try again." });
    }
  },
);

// ── POST /projects/:id/plans/clarify ─────────────────────────────────────────
// Returns AI clarifying questions for an ambiguous user prompt.
const ClarifyBody = z.object({
  prompt: z.string().min(1).max(4000),
  agentMode: z.enum(["lite", "eco", "power", "pro"]).default("eco"),
});

router.post(
  "/projects/:id/plans/clarify",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (isNaN(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }
    const parsed = ClarifyBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { prompt, agentMode } = parsed.data;

    const [project] = await db
      .select({ name: projectsTable.name, kind: projectsTable.kind })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    try {
      const result = await runGuidedRefinementPipeline({
        projectName: project.name,
        projectKind: project.kind,
        userPrompt: prompt,
        agentMode: agentMode as AgentMode,
      });
      res.json(result);
    } catch (err) {
      logger.error({ err, projectId }, "Guided refinement failed");
      res.status(500).json({ error: "Could not generate clarifying questions. Please try again." });
    }
  },
);

export default router;
