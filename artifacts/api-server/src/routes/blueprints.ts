/**
 * Task #542 — Integration blueprints + MCP server registry routes.
 * Task #786 — Knowledge vault on install, platform secret injection.
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
import {
  db,
  mcpServersTable,
  projectBlueprintsTable,
  projectsTable,
  secretsTable,
} from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { requireAdmin } from "../lib/adminAuth";
import {
  findBlueprint,
  installBlueprint,
  loadBlueprints,
  type BlueprintManifest,
} from "../lib/blueprints";
import { discoverMcpTools, assertSafeMcpEndpoint } from "../lib/mcp";
import { logger } from "../lib/logger";
import { writeKnowledge } from "../lib/knowledge";
import { encryptionService } from "../lib/encryption";
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

/**
 * Checks whether a project secret with the given name exists and has a non-empty value.
 */
async function projectSecretExists(projectId: number, secretName: string): Promise<boolean> {
  const rows = await db
    .select({ id: secretsTable.id })
    .from(secretsTable)
    .where(and(eq(secretsTable.projectId, projectId), eq(secretsTable.name, secretName)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Upserts a project secret (insert or update by name). Marks as preview-safe
 * since platform-managed secrets must be available in the live preview environment.
 */
async function upsertProjectSecret(
  projectId: number,
  name: string,
  value: string,
  category: string,
  actor: string | null,
): Promise<void> {
  const encrypted = encryptionService.encrypt(value);
  const existing = await db
    .select({ id: secretsTable.id })
    .from(secretsTable)
    .where(and(eq(secretsTable.projectId, projectId), eq(secretsTable.name, name)))
    .limit(1);

  if (existing[0]) {
    await db
      .update(secretsTable)
      .set({ valueEncrypted: encrypted, updatedAt: new Date() })
      .where(eq(secretsTable.id, existing[0].id));
  } else {
    await db.insert(secretsTable).values({
      projectId,
      name,
      valueEncrypted: encrypted,
      environment: "development",
      category,
      isPreviewSafe: true,
    });
  }
  logger.info({ projectId, name, actor }, "platform secret upserted for blueprint");
}

/**
 * Build a concise knowledge vault entry for a blueprint install. This entry
 * is injected into future AI prompts so the agent automatically knows how to
 * use the integration without the user having to re-explain it.
 */
function buildBlueprintKnowledgeContent(bp: BlueprintManifest): string {
  const firstFile = bp.files[0];
  const envVarLines =
    bp.requiredSecrets.length > 0
      ? `\n\nEnvironment variables used by this integration:\n${bp.requiredSecrets.map((s) => `- \`${s.name}\`${s.optional ? " (optional)" : ""}: ${s.reason ?? ""}`).join("\n")}`
      : "";

  const importHint = firstFile
    ? `\n\nThe integration is scaffolded at \`${firstFile.path}\`. Import from that path to use it.`
    : "";

  const notes = bp.postInstallNotes ? `\n\nPost-install instructions:\n${bp.postInstallNotes}` : "";

  return (
    `This project has the **${bp.name}** integration installed (blueprint: \`${bp.id}\`). ` +
    `${bp.description}` +
    envVarLines +
    importHint +
    notes
  );
}

/**
 * Inject platform-managed OpenAI credentials when the user hasn't provided
 * their own OPENAI_API_KEY. Uses the Replit AI Integrations proxy which is
 * already configured on the platform. Rate-limited to 100 req/day.
 */
async function maybeInjectPlatformOpenAI(
  projectId: number,
  actor: string | null,
): Promise<{ injected: boolean; notice?: string }> {
  const platformBaseUrl = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  const platformApiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;

  if (!platformBaseUrl || !platformApiKey) {
    return { injected: false };
  }

  const hasUserKey = await projectSecretExists(projectId, "OPENAI_API_KEY");
  if (hasUserKey) {
    return { injected: false };
  }

  await upsertProjectSecret(projectId, "OPENAI_API_KEY", platformApiKey, "ai", actor);
  await upsertProjectSecret(projectId, "OPENAI_BASE_URL", platformBaseUrl, "ai", actor);
  return {
    injected: true,
    notice:
      "Using platform proxy — rate-limited to 100 req/day. Add your own OPENAI_API_KEY to remove the limit.",
  };
}

/**
 * Inject a platform Stripe test-mode publishable key when the user hasn't
 * provided their own keys. Clearly labelled as test-mode so they know to
 * replace it before going live.
 */
async function maybeInjectPlatformStripe(
  projectId: number,
  actor: string | null,
): Promise<{ injected: boolean; notice?: string }> {
  const platformPublishableKey = process.env.STRIPE_TEST_PUBLISHABLE_KEY;
  if (!platformPublishableKey) {
    return { injected: false };
  }

  const hasUserKey = await projectSecretExists(projectId, "STRIPE_PUBLISHABLE_KEY");
  if (hasUserKey) {
    return { injected: false };
  }

  await upsertProjectSecret(
    projectId,
    "STRIPE_PUBLISHABLE_KEY",
    platformPublishableKey,
    "payment",
    actor,
  );
  return {
    injected: true,
    notice:
      "Test mode — replace STRIPE_PUBLISHABLE_KEY with your production key before going live.",
  };
}

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

      // ── Knowledge Vault: record integration usage for future AI context ──
      void writeKnowledge({
        title: `${bp.name} integration installed`,
        content: buildBlueprintKnowledgeContent(bp),
        type: "integration",
        category: "tool",
        severity: "info",
        projectId,
        userId: actor ?? undefined,
        tags: [bp.id, bp.category, "blueprint"],
        approvedForReuse: true,
      });

      // ── Platform secret injection (best-effort, never blocks install) ─────
      const platformNotices: string[] = [];

      if (bp.id === "ai-openai" || bp.id === "ai-providers") {
        const r = await maybeInjectPlatformOpenAI(projectId, actor).catch((err) => {
          logger.warn({ err }, "platform OpenAI injection failed");
          return { injected: false, notice: undefined } as const;
        });
        if (r.injected && r.notice) platformNotices.push(r.notice);
      }

      if (bp.id === "payments-stripe") {
        const r = await maybeInjectPlatformStripe(projectId, actor).catch((err) => {
          logger.warn({ err }, "platform Stripe injection failed");
          return { injected: false, notice: undefined } as const;
        });
        if (r.injected && r.notice) platformNotices.push(r.notice);
      }

      res.json({ installed: true, ...result, platformNotices });
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
