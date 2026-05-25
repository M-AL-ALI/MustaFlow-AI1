/**
 * Task #631 — Extensions API routes.
 *
 *   GET  /extensions                       — public catalog
 *   GET  /extensions/:slug                 — single extension
 *   POST /extensions                       — submit extension (auth)
 *   GET  /projects/:id/extensions          — installed extensions (auth)
 *   POST /projects/:id/extensions/install  — install extension (auth)
 *   PATCH /projects/:id/extensions/:extId  — enable/disable/configure (auth)
 *   DELETE /projects/:id/extensions/:extId — uninstall (auth)
 *
 *   Admin:
 *   PATCH /admin/extensions/:id            — vet / feature (admin)
 */
import crypto from "crypto";
import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  extensionsTable,
  projectExtensionsTable,
  projectsTable,
  secretsTable,
  type ExtensionScope,
} from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { requireAdmin } from "../lib/adminAuth";
import { logger } from "../lib/logger";
import { encryptionService } from "../lib/encryption";
import { z } from "zod";

const router: IRouter = Router();

// Public sub-router — mounted BEFORE attachUser
export const publicExtensionsRouter: IRouter = Router();

// ── GET /extensions ───────────────────────────────────────────────────────────
publicExtensionsRouter.get("/extensions", async (req, res): Promise<void> => {
  try {
    const { category, search } = req.query as Record<string, string>;
    const conditions = [eq(extensionsTable.status, "published")];
    if (category && category !== "all") {
      conditions.push(eq(extensionsTable.category, category));
    }

    const rows = await db
      .select({
        id: extensionsTable.id,
        slug: extensionsTable.slug,
        name: extensionsTable.name,
        description: extensionsTable.description,
        version: extensionsTable.version,
        authorName: extensionsTable.authorName,
        category: extensionsTable.category,
        tags: extensionsTable.tags,
        scopes: extensionsTable.scopes,
        iconUrl: extensionsTable.iconUrl,
        homepageUrl: extensionsTable.homepageUrl,
        installCount: extensionsTable.installCount,
        vetted: extensionsTable.vetted,
        featured: extensionsTable.featured,
        isSystem: extensionsTable.isSystem,
        publishedAt: extensionsTable.publishedAt,
      })
      .from(extensionsTable)
      .where(and(...conditions))
      .orderBy(desc(extensionsTable.featured), desc(extensionsTable.installCount));

    const results = search
      ? rows.filter(
          (r) =>
            r.name.toLowerCase().includes(search.toLowerCase()) ||
            r.description.toLowerCase().includes(search.toLowerCase()),
        )
      : rows;

    res.json(results);
  } catch (err) {
    // Table may be missing in dev DBs — fail-open with an empty list so the
    // page renders instead of crashing the client filter().
    logger.warn({ err }, "Failed to list extensions — returning empty list");
    res.json([]);
  }
});

// ── GET /extensions/:slug ─────────────────────────────────────────────────────
publicExtensionsRouter.get("/extensions/:slug", async (req, res): Promise<void> => {
  try {
    const [row] = await db
      .select()
      .from(extensionsTable)
      .where(
        and(eq(extensionsTable.slug, req.params.slug), eq(extensionsTable.status, "published")),
      );

    if (!row) {
      res.status(404).json({ error: "Extension not found" });
      return;
    }

    res.json(row);
  } catch (err) {
    logger.error({ err }, "Failed to get extension");
    res.status(500).json({ error: "Failed to load extension" });
  }
});

// ── POST /extensions — submit ─────────────────────────────────────────────────
const submitExtensionSchema = z.object({
  slug: z
    .string()
    .min(3)
    .max(80)
    .regex(/^[a-z0-9-]+$/),
  name: z.string().min(3).max(100),
  description: z.string().min(10).max(500),
  longDescription: z.string().max(5000).optional(),
  version: z.string().default("1.0.0"),
  category: z.string().default("productivity"),
  tags: z.array(z.string().max(30)).max(10).default([]),
  manifestUrl: z.string().url().optional(),
  homepageUrl: z.string().url().optional(),
  repositoryUrl: z.string().url().optional(),
  iconUrl: z.string().url().optional(),
  scopes: z.array(z.string()).default([]),
});

router.post("/extensions", async (req, res): Promise<void> => {
  const userId = (req as { userId?: string }).userId;
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const parsed = submitExtensionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
    return;
  }

  try {
    const existing = await db
      .select({ id: extensionsTable.id })
      .from(extensionsTable)
      .where(eq(extensionsTable.slug, parsed.data.slug));

    if (existing.length > 0) {
      res.status(409).json({ error: "Slug already taken" });
      return;
    }

    const { scopes, ...rest } = parsed.data;
    const [ext] = await db
      .insert(extensionsTable)
      .values({
        ...rest,
        scopes: scopes as ExtensionScope[],
        authorId: userId,
        status: "pending",
      })
      .returning({ id: extensionsTable.id, slug: extensionsTable.slug });

    res.status(201).json({ ok: true, id: ext?.id, slug: ext?.slug });
  } catch (err) {
    logger.error({ err }, "Failed to submit extension");
    res.status(500).json({ error: "Failed to submit extension" });
  }
});

// ── GET /projects/:id/extensions ──────────────────────────────────────────────
router.get("/projects/:id/extensions", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  try {
    const rows = await db
      .select()
      .from(projectExtensionsTable)
      .where(eq(projectExtensionsTable.projectId, projectId));
    res.json(rows);
  } catch (err) {
    logger.error({ err }, "Failed to list project extensions");
    res.status(500).json({ error: "Failed to load extensions" });
  }
});

// ── POST /projects/:id/extensions/install ─────────────────────────────────────
const installExtSchema = z.object({
  slug: z.string().min(1),
  config: z.record(z.unknown()).optional(),
});

router.post(
  "/projects/:id/extensions/install",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const userId = (req as { userId?: string }).userId;
    const projectId = Number(req.params.id);

    const parsed = installExtSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
      return;
    }

    try {
      const [ext] = await db
        .select({
          id: extensionsTable.id,
          slug: extensionsTable.slug,
          status: extensionsTable.status,
          scopes: extensionsTable.scopes,
        })
        .from(extensionsTable)
        .where(eq(extensionsTable.slug, parsed.data.slug));

      if (!ext || ext.status !== "published") {
        res.status(404).json({ error: "Extension not found" });
        return;
      }

      await db
        .insert(projectExtensionsTable)
        .values({
          projectId,
          extensionId: ext.id,
          extensionSlug: ext.slug,
          installedBy: userId,
          config: parsed.data.config ?? {},
          enabled: true,
        })
        .onConflictDoUpdate({
          target: [projectExtensionsTable.projectId, projectExtensionsTable.extensionId],
          set: { enabled: true, config: parsed.data.config ?? {}, updatedAt: new Date() },
        });

      // Increment install count (best-effort)
      await db
        .update(extensionsTable)
        .set({ installCount: sql`${extensionsTable.installCount} + 1` })
        .where(eq(extensionsTable.id, ext.id))
        .catch(() => {});

      // Mint a project-scoped extension token and store it as a project secret.
      // The token is a random 32-byte hex string, encrypted at rest. It is
      // injected into the project environment as EXT_TOKEN_<SLUG> so extension
      // callbacks can authenticate against /api/v1/extensions/context.
      const rawToken = crypto.randomBytes(32).toString("hex");
      const tokenSecretName = `EXT_TOKEN_${ext.slug.toUpperCase().replace(/-/g, "_")}`;
      const encrypted = encryptionService.encrypt(rawToken);
      await db
        .insert(secretsTable)
        .values({
          projectId,
          name: tokenSecretName,
          valueEncrypted: encrypted,
          category: "other",
          environment: "development",
          isPreviewSafe: true,
          exposureType: "server",
        })
        .onConflictDoNothing();

      res.status(201).json({ ok: true, tokenSecretName, scopes: ext.scopes });
    } catch (err) {
      logger.error({ err }, "Failed to install extension");
      res.status(500).json({ error: "Failed to install extension" });
    }
  },
);

// ── DELETE /projects/:id/extensions/:extId ────────────────────────────────────
router.delete(
  "/projects/:id/extensions/:extId",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const extId = Number(req.params.extId);
    if (isNaN(extId)) {
      res.status(400).json({ error: "Invalid extension id" });
      return;
    }

    try {
      await db
        .delete(projectExtensionsTable)
        .where(
          and(
            eq(projectExtensionsTable.projectId, projectId),
            eq(projectExtensionsTable.id, extId),
          ),
        );
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, "Failed to uninstall extension");
      res.status(500).json({ error: "Failed to uninstall extension" });
    }
  },
);

// ── Admin: PATCH /admin/extensions/:id ───────────────────────────────────────
const adminExtPatchSchema = z.object({
  status: z.enum(["draft", "pending", "published", "suspended"]).optional(),
  vetted: z.boolean().optional(),
  featured: z.boolean().optional(),
  vettingNotes: z.string().max(2000).optional(),
});

router.patch("/admin/extensions/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id ?? ""), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const parsed = adminExtPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
    return;
  }

  const adminId = (req as { userId?: string }).userId;

  try {
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (parsed.data.status !== undefined) {
      updates.status = parsed.data.status;
      if (parsed.data.status === "published") updates.publishedAt = new Date();
    }
    if (parsed.data.vetted !== undefined) {
      updates.vetted = parsed.data.vetted;
      if (parsed.data.vetted) {
        updates.vettedAt = new Date();
        updates.vettedBy = adminId;
      }
    }
    if (parsed.data.featured !== undefined) updates.featured = parsed.data.featured;
    if (parsed.data.vettingNotes !== undefined) updates.vettingNotes = parsed.data.vettingNotes;

    const [updated] = await db
      .update(extensionsTable)
      .set(updates)
      .where(eq(extensionsTable.id, id))
      .returning({ id: extensionsTable.id, status: extensionsTable.status });

    if (!updated) {
      res.status(404).json({ error: "Extension not found" });
      return;
    }

    res.json(updated);
  } catch (err) {
    logger.error({ err }, "Failed to update extension");
    res.status(500).json({ error: "Failed to update extension" });
  }
});

export default router;
