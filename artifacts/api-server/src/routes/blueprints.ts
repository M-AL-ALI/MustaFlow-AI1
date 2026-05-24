/**
 * Task #542 — Integration blueprints + MCP server registry routes.
 *
 * Public catalog:                GET    /api/blueprints
 * Per-project installs:          GET    /api/projects/:id/blueprints
 *                                POST   /api/projects/:id/blueprints/install   { id }
 *                                DELETE /api/projects/:id/blueprints/:bid
 *
 * MCP server admin (requireAdmin enforced in routes/admin.ts mount):
 *                                GET    /api/admin/mcp-servers
 *                                POST   /api/admin/mcp-servers
 *                                PATCH  /api/admin/mcp-servers/:id
 *                                DELETE /api/admin/mcp-servers/:id
 *                                POST   /api/admin/mcp-servers/:id/refresh-tools
 */
import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, mcpServersTable, projectBlueprintsTable, projectsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { requireAdmin } from "../lib/adminAuth";
import { findBlueprint, installBlueprint, loadBlueprints } from "../lib/blueprints";
import { discoverMcpTools, assertSafeMcpEndpoint } from "../lib/mcp";
import { logger } from "../lib/logger";
import { z } from "zod";

const router: IRouter = Router();

// ─── Public catalog ──────────────────────────────────────────────────────────
router.get("/blueprints", async (_req, res): Promise<void> => {
  const manifests = await loadBlueprints();
  // Trim heavy fields for the list view; UI fetches single blueprint for details.
  res.json(
    manifests.map((b) => ({
      id: b.id,
      name: b.name,
      category: b.category,
      description: b.description,
      version: b.version,
      url: b.url,
      mobileOnly: !!b.mobileOnly,
      webOnly: !!b.webOnly,
      requiredSecrets: b.requiredSecrets.map((s) => s.name),
      packageCount: b.packages.length,
      fileCount: b.files.length,
    })),
  );
});

router.get("/blueprints/:id", async (req, res): Promise<void> => {
  const bp = await findBlueprint(req.params.id ?? "");
  if (!bp) {
    res.status(404).json({ error: "Blueprint not found" });
    return;
  }
  res.json(bp);
});

// ─── Per-project installs ────────────────────────────────────────────────────
router.get("/projects/:id/blueprints", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  const rows = await db
    .select()
    .from(projectBlueprintsTable)
    .where(eq(projectBlueprintsTable.projectId, projectId));
  res.json(rows);
});

const installSchema = z.object({
  id: z.string().min(1).max(120),
});

router.post(
  "/projects/:id/blueprints/install",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const parsed = installSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
      return;
    }
    const bp = await findBlueprint(parsed.data.id);
    if (!bp) {
      res.status(404).json({ error: "Blueprint not found" });
      return;
    }
    const [project] = await db
      .select({ id: projectsTable.id, projectFormat: projectsTable.projectFormat })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId))
      .limit(1);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (bp.mobileOnly && project.projectFormat !== "mobile-cross") {
      res.status(400).json({ error: "This blueprint is for mobile projects only" });
      return;
    }
    if (bp.webOnly && project.projectFormat === "mobile-cross") {
      res.status(400).json({ error: "This blueprint is for web projects only" });
      return;
    }
    const actor = req.userId ?? null;
    try {
      // HTTP install: no package install (will be picked up by the next build's
      // container `npm install`), no secret request UI (the UI lists required
      // secrets so the user knows what to add manually).
      const result = await installBlueprint(bp, { projectId, actor });
      res.json({ installed: true, ...result });
    } catch (err) {
      req.log.error({ err, blueprintId: bp.id }, "blueprint install failed");
      res.status(500).json({ error: "Install failed", detail: (err as Error).message });
    }
  },
);

router.delete(
  "/projects/:id/blueprints/:bid",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const rawBid = req.params.bid;
    const blueprintId = Array.isArray(rawBid) ? (rawBid[0] ?? "") : (rawBid ?? "");
    await db
      .delete(projectBlueprintsTable)
      .where(
        and(
          eq(projectBlueprintsTable.projectId, projectId),
          eq(projectBlueprintsTable.blueprintId, blueprintId),
        ),
      );
    res.json({ removed: true });
  },
);

// ─── MCP admin (mounted under /api by index.ts; requireAdmin via admin path) ─
const mcpRouter: IRouter = Router();
mcpRouter.use(requireAdmin);

mcpRouter.get("/mcp-servers", async (_req, res): Promise<void> => {
  const rows = await db.select().from(mcpServersTable);
  res.json(rows);
});

const mcpCreateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  endpoint: z.string().url(),
  authHeader: z.string().max(500).optional(),
  enabled: z.boolean().optional(),
});

mcpRouter.post("/mcp-servers", async (req, res): Promise<void> => {
  const parsed = mcpCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
    return;
  }
  try {
    await assertSafeMcpEndpoint(parsed.data.endpoint);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }
  const actor = req.userId ?? null;
  const [row] = await db
    .insert(mcpServersTable)
    .values({
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      endpoint: parsed.data.endpoint,
      authHeader: parsed.data.authHeader ?? null,
      enabled: parsed.data.enabled ?? true,
      createdBy: actor,
    })
    .returning();
  res.json(row);
});

const mcpPatchSchema = mcpCreateSchema.partial();

mcpRouter.patch("/mcp-servers/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const parsed = mcpPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
    return;
  }
  if (parsed.data.endpoint) {
    try {
      await assertSafeMcpEndpoint(parsed.data.endpoint);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
  }
  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v !== undefined) updateData[k] = v;
  }
  const [row] = await db
    .update(mcpServersTable)
    .set(updateData)
    .where(eq(mcpServersTable.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(row);
});

mcpRouter.delete("/mcp-servers/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  await db.delete(mcpServersTable).where(eq(mcpServersTable.id, id));
  res.json({ removed: true });
});

mcpRouter.post("/mcp-servers/:id/refresh-tools", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [row] = await db.select().from(mcpServersTable).where(eq(mcpServersTable.id, id)).limit(1);
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  try {
    const tools = await discoverMcpTools();
    const mine = tools.filter((t) => t.serverId === id);
    res.json({ ok: true, toolsFound: mine.length });
  } catch (err) {
    logger.warn({ err }, "mcp refresh failed");
    res.status(500).json({ error: "Refresh failed", detail: (err as Error).message });
  }
});

router.use("/admin", mcpRouter);

export default router;
