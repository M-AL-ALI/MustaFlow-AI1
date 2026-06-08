/**
 * Task #631 — Template Gallery routes.
 *
 *   GET  /gallery-templates                   — public list (filterable)
 *   GET  /gallery-templates/:slug             — public detail
 *   POST /gallery-templates                   — submit template (auth)
 *   POST /gallery-templates/:slug/fork        — fork/remix into new project (auth)
 *   POST /gallery-templates/:slug/rate        — rate a template (auth)
 *   POST /gallery-templates/:slug/use         — create project from template (auth)
 *   GET  /projects/:id/gallery-submit         — preflight: summarise project files (auth)
 *   POST /projects/:id/gallery-submit         — submit project as gallery template (auth)
 *
 *   Admin:
 *   GET  /admin/gallery-templates             — full list incl. pending (admin)
 *   PATCH /admin/gallery-templates/:id        — approve / feature / reject (admin)
 */
import { Router, type IRouter } from "express";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import {
  db,
  galleryTemplatesTable,
  templateRatingsTable,
  projectsTable,
  projectFilesTable,
  communityProfilesTable,
} from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { requireAdmin } from "../lib/adminAuth";
import { enqueueProvisionProjectJob } from "../lib/provisioning";
import { logger } from "../lib/logger";
import { z } from "zod";

const router: IRouter = Router();

// Public sub-router — mounted BEFORE attachUser so unauthenticated users can browse
export const publicGalleryRouter: IRouter = Router();

// ── GET /gallery-templates ────────────────────────────────────────────────────
publicGalleryRouter.get("/gallery-templates", async (req, res): Promise<void> => {
  try {
    const {
      category,
      search,
      featured,
      editorsPick,
      platform,
      limit: limitStr,
      offset: offsetStr,
    } = req.query as Record<string, string>;

    const limit = Math.min(parseInt(limitStr ?? "24", 10) || 24, 100);
    const offset = parseInt(offsetStr ?? "0", 10) || 0;

    const conditions = [eq(galleryTemplatesTable.status, "published")];

    if (category && category !== "all") {
      conditions.push(eq(galleryTemplatesTable.category, category));
    }
    if (platform && platform !== "all") {
      conditions.push(eq(galleryTemplatesTable.platform, platform));
    }
    if (featured === "true") {
      conditions.push(eq(galleryTemplatesTable.featured, true));
    }
    if (editorsPick === "true") {
      conditions.push(eq(galleryTemplatesTable.editorsPick, true));
    }
    if (search) {
      const pattern = `%${search.toLowerCase()}%`;
      conditions.push(
        or(
          ilike(galleryTemplatesTable.title, pattern),
          ilike(galleryTemplatesTable.description, pattern),
        )!,
      );
    }

    const rows = await db
      .select({
        id: galleryTemplatesTable.id,
        slug: galleryTemplatesTable.slug,
        title: galleryTemplatesTable.title,
        description: galleryTemplatesTable.description,
        category: galleryTemplatesTable.category,
        tags: galleryTemplatesTable.tags,
        authorId: galleryTemplatesTable.authorId,
        authorName: galleryTemplatesTable.authorName,
        authorUsername: communityProfilesTable.username,
        previewUrl: galleryTemplatesTable.previewUrl,
        thumbnailUrl: galleryTemplatesTable.thumbnailUrl,
        platform: galleryTemplatesTable.platform,
        stack: galleryTemplatesTable.stack,
        rating: galleryTemplatesTable.rating,
        ratingCount: galleryTemplatesTable.ratingCount,
        forkCount: galleryTemplatesTable.forkCount,
        useCount: galleryTemplatesTable.useCount,
        featured: galleryTemplatesTable.featured,
        editorsPick: galleryTemplatesTable.editorsPick,
        isSystem: galleryTemplatesTable.isSystem,
        createdAt: galleryTemplatesTable.createdAt,
        publishedAt: galleryTemplatesTable.publishedAt,
      })
      .from(galleryTemplatesTable)
      .leftJoin(
        communityProfilesTable,
        eq(galleryTemplatesTable.authorId, communityProfilesTable.userId),
      )
      .where(and(...conditions))
      .orderBy(desc(galleryTemplatesTable.editorsPick), desc(galleryTemplatesTable.rating))
      .limit(limit)
      .offset(offset);

    res.json({ templates: rows, limit, offset });
  } catch (err) {
    logger.error({ err }, "Failed to list gallery templates");
    res.status(500).json({ error: "Failed to load templates" });
  }
});

// ── GET /gallery-templates/:slug ──────────────────────────────────────────────
publicGalleryRouter.get("/gallery-templates/:slug", async (req, res): Promise<void> => {
  try {
    const [row] = await db
      .select({
        id: galleryTemplatesTable.id,
        slug: galleryTemplatesTable.slug,
        title: galleryTemplatesTable.title,
        description: galleryTemplatesTable.description,
        category: galleryTemplatesTable.category,
        tags: galleryTemplatesTable.tags,
        previewUrl: galleryTemplatesTable.previewUrl,
        thumbnailUrl: galleryTemplatesTable.thumbnailUrl,
        status: galleryTemplatesTable.status,
        rating: galleryTemplatesTable.rating,
        ratingCount: galleryTemplatesTable.ratingCount,
        forkCount: galleryTemplatesTable.forkCount,
        useCount: galleryTemplatesTable.useCount,
        authorId: galleryTemplatesTable.authorId,
        authorName: galleryTemplatesTable.authorName,
        authorUsername: communityProfilesTable.username,
        editorsPick: galleryTemplatesTable.editorsPick,
        createdAt: galleryTemplatesTable.createdAt,
        updatedAt: galleryTemplatesTable.updatedAt,
      })
      .from(galleryTemplatesTable)
      .leftJoin(
        communityProfilesTable,
        eq(galleryTemplatesTable.authorId, communityProfilesTable.userId),
      )
      .where(
        and(
          eq(galleryTemplatesTable.slug, req.params.slug),
          eq(galleryTemplatesTable.status, "published"),
        ),
      );

    if (!row) {
      res.status(404).json({ error: "Template not found" });
      return;
    }

    res.json(row);
  } catch (err) {
    logger.error({ err }, "Failed to get gallery template");
    res.status(500).json({ error: "Failed to load template" });
  }
});

// ── POST /gallery-templates/:slug/rate ────────────────────────────────────────
const rateSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(1000).optional(),
});

router.post("/gallery-templates/:slug/rate", async (req, res): Promise<void> => {
  const userId = (req as { userId?: string }).userId;
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const parsed = rateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
    return;
  }

  try {
    const [tpl] = await db
      .select({ id: galleryTemplatesTable.id })
      .from(galleryTemplatesTable)
      .where(
        and(
          eq(galleryTemplatesTable.slug, req.params.slug),
          eq(galleryTemplatesTable.status, "published"),
        ),
      );

    if (!tpl) {
      res.status(404).json({ error: "Template not found" });
      return;
    }

    await db
      .insert(templateRatingsTable)
      .values({
        templateId: tpl.id,
        userId,
        rating: parsed.data.rating,
        comment: parsed.data.comment ?? null,
      })
      .onConflictDoUpdate({
        target: [templateRatingsTable.templateId, templateRatingsTable.userId],
        set: {
          rating: parsed.data.rating,
          comment: parsed.data.comment ?? null,
          updatedAt: new Date(),
        },
      });

    // Recompute aggregate rating
    const [agg] = await db
      .select({
        avg: sql<number>`avg(rating)::numeric(3,2)`,
        count: sql<number>`count(*)::int`,
      })
      .from(templateRatingsTable)
      .where(eq(templateRatingsTable.templateId, tpl.id));

    await db
      .update(galleryTemplatesTable)
      .set({
        rating: Number(agg?.avg ?? 0),
        ratingCount: Number(agg?.count ?? 0),
        updatedAt: new Date(),
      })
      .where(eq(galleryTemplatesTable.id, tpl.id));

    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Failed to rate gallery template");
    res.status(500).json({ error: "Failed to submit rating" });
  }
});

// ── POST /gallery-templates/:slug/use ─────────────────────────────────────────
// Creates a new project pre-populated with the template's files snapshot.
router.post("/gallery-templates/:slug/use", async (req, res): Promise<void> => {
  const userId = (req as { userId?: string }).userId;
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    const [tpl] = await db
      .select()
      .from(galleryTemplatesTable)
      .where(
        and(
          eq(galleryTemplatesTable.slug, req.params.slug),
          eq(galleryTemplatesTable.status, "published"),
        ),
      );

    if (!tpl) {
      res.status(404).json({ error: "Template not found" });
      return;
    }

    const [newProject] = await db
      .insert(projectsTable)
      .values({
        ownerId: userId,
        name: tpl.title,
        description: tpl.description,
        kind: tpl.platform === "mobile" ? "mobile-cross" : "web",
        platform: tpl.platform === "mobile" ? "cross" : "web",
        stack: tpl.stack as string,
        status: "draft",
        // Task #738 — gallery-template instances are new projects and must
        // get their own container + Neon DB.
        builderMode: "agentic",
        provisioningStatus: "provisioning",
      })
      .returning({ id: projectsTable.id });

    if (!newProject) {
      res.status(500).json({ error: "Failed to create project" });
      return;
    }
    enqueueProvisionProjectJob(newProject.id);

    // Seed files from snapshot if available
    if (tpl.filesSnapshot && typeof tpl.filesSnapshot === "object") {
      const fileEntries = Object.entries(tpl.filesSnapshot as Record<string, string>);
      if (fileEntries.length > 0) {
        await db.insert(projectFilesTable).values(
          fileEntries.map(([path, content]) => ({
            projectId: newProject.id,
            path,
            content,
          })),
        );
      }
    }

    // Increment use count
    await db
      .update(galleryTemplatesTable)
      .set({ useCount: sql`${galleryTemplatesTable.useCount} + 1`, updatedAt: new Date() })
      .where(eq(galleryTemplatesTable.id, tpl.id));

    res.status(201).json({ projectId: newProject.id });
  } catch (err) {
    logger.error({ err }, "Failed to use gallery template");
    res.status(500).json({ error: "Failed to create project from template" });
  }
});

// ── POST /gallery-templates/:slug/fork ────────────────────────────────────────
router.post("/gallery-templates/:slug/fork", async (req, res): Promise<void> => {
  const userId = (req as { userId?: string }).userId;
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    const [tpl] = await db
      .select()
      .from(galleryTemplatesTable)
      .where(
        and(
          eq(galleryTemplatesTable.slug, req.params.slug),
          eq(galleryTemplatesTable.status, "published"),
        ),
      );

    if (!tpl) {
      res.status(404).json({ error: "Template not found" });
      return;
    }

    const [newProject] = await db
      .insert(projectsTable)
      .values({
        ownerId: userId,
        name: `${tpl.title} (fork)`,
        description: tpl.description,
        kind: tpl.platform === "mobile" ? "mobile-cross" : "web",
        platform: tpl.platform === "mobile" ? "cross" : "web",
        stack: tpl.stack as string,
        status: "draft",
        // Task #738 — forked templates are new infra → auto-provision.
        builderMode: "agentic",
        provisioningStatus: "provisioning",
      })
      .returning({ id: projectsTable.id });

    if (!newProject) {
      res.status(500).json({ error: "Failed to fork template" });
      return;
    }
    enqueueProvisionProjectJob(newProject.id);

    if (tpl.filesSnapshot && typeof tpl.filesSnapshot === "object") {
      const fileEntries = Object.entries(tpl.filesSnapshot as Record<string, string>);
      if (fileEntries.length > 0) {
        await db.insert(projectFilesTable).values(
          fileEntries.map(([path, content]) => ({
            projectId: newProject.id,
            path,
            content,
          })),
        );
      }
    }

    await db
      .update(galleryTemplatesTable)
      .set({ forkCount: sql`${galleryTemplatesTable.forkCount} + 1`, updatedAt: new Date() })
      .where(eq(galleryTemplatesTable.id, tpl.id));

    res.status(201).json({ projectId: newProject.id });
  } catch (err) {
    logger.error({ err }, "Failed to fork gallery template");
    res.status(500).json({ error: "Failed to fork template" });
  }
});

// ── POST /projects/:id/gallery-submit ─────────────────────────────────────────
const submitSchema = z.object({
  title: z.string().min(3).max(100),
  description: z.string().min(10).max(500),
  readme: z.string().max(10000).optional(),
  category: z.enum([
    "web",
    "mobile",
    "saas",
    "ecommerce",
    "portfolio",
    "landing",
    "internal-tools",
    "ai-app",
    "dashboard",
    "blog",
    "social",
    "other",
  ]),
  tags: z.array(z.string().max(30)).max(10).default([]),
});

router.post(
  "/projects/:id/gallery-submit",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const userId = (req as { userId?: string }).userId;
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const parsed = submitSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
      return;
    }

    const projectId = Number(req.params.id);

    try {
      const [project] = await db
        .select({
          name: projectsTable.name,
          platform: projectsTable.platform,
          stack: projectsTable.stack,
        })
        .from(projectsTable)
        .where(eq(projectsTable.id, projectId));

      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }

      const files = await db
        .select({ path: projectFilesTable.path, content: projectFilesTable.content })
        .from(projectFilesTable)
        .where(eq(projectFilesTable.projectId, projectId));

      const snapshot: Record<string, string> = {};
      for (const f of files) {
        snapshot[f.path] = f.content ?? "";
      }

      const slug = `${parsed.data.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")}-${Date.now().toString(36)}`;

      const [tpl] = await db
        .insert(galleryTemplatesTable)
        .values({
          slug,
          title: parsed.data.title,
          description: parsed.data.description,
          readme: parsed.data.readme ?? null,
          category: parsed.data.category,
          tags: parsed.data.tags,
          authorId: userId,
          filesSnapshot: snapshot,
          platform: project.platform === "cross" ? "mobile" : "web",
          stack: project.stack,
          status: "pending",
          sourceProjectId: projectId,
        })
        .returning({ id: galleryTemplatesTable.id, slug: galleryTemplatesTable.slug });

      res.status(201).json({ ok: true, id: tpl?.id, slug: tpl?.slug });
    } catch (err) {
      logger.error({ err }, "Failed to submit gallery template");
      res.status(500).json({ error: "Failed to submit template" });
    }
  },
);

// ── Admin: GET /admin/gallery-templates ───────────────────────────────────────
router.get("/admin/gallery-templates", requireAdmin, async (req, res): Promise<void> => {
  try {
    const { status } = req.query as { status?: string };
    const conditions = status ? [eq(galleryTemplatesTable.status, status)] : [];

    const rows = await db
      .select({
        id: galleryTemplatesTable.id,
        slug: galleryTemplatesTable.slug,
        title: galleryTemplatesTable.title,
        description: galleryTemplatesTable.description,
        category: galleryTemplatesTable.category,
        authorId: galleryTemplatesTable.authorId,
        authorName: galleryTemplatesTable.authorName,
        status: galleryTemplatesTable.status,
        featured: galleryTemplatesTable.featured,
        editorsPick: galleryTemplatesTable.editorsPick,
        rating: galleryTemplatesTable.rating,
        ratingCount: galleryTemplatesTable.ratingCount,
        forkCount: galleryTemplatesTable.forkCount,
        useCount: galleryTemplatesTable.useCount,
        createdAt: galleryTemplatesTable.createdAt,
        publishedAt: galleryTemplatesTable.publishedAt,
      })
      .from(galleryTemplatesTable)
      .where(and(...conditions))
      .orderBy(desc(galleryTemplatesTable.createdAt));

    res.json(rows);
  } catch (err) {
    logger.error({ err }, "Failed to list admin gallery templates");
    res.status(500).json({ error: "Failed to load templates" });
  }
});

// ── Admin: PATCH /admin/gallery-templates/:id ─────────────────────────────────
const adminPatchSchema = z.object({
  status: z.enum(["draft", "pending", "published", "rejected"]).optional(),
  featured: z.boolean().optional(),
  editorsPick: z.boolean().optional(),
  thumbnailUrl: z.string().url().optional(),
  previewUrl: z.string().url().optional(),
});

router.patch("/admin/gallery-templates/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id ?? ""), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const parsed = adminPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
    return;
  }

  try {
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (parsed.data.status !== undefined) {
      updates.status = parsed.data.status;
      if (parsed.data.status === "published") updates.publishedAt = new Date();
    }
    if (parsed.data.featured !== undefined) updates.featured = parsed.data.featured;
    if (parsed.data.editorsPick !== undefined) updates.editorsPick = parsed.data.editorsPick;
    if (parsed.data.thumbnailUrl !== undefined) updates.thumbnailUrl = parsed.data.thumbnailUrl;
    if (parsed.data.previewUrl !== undefined) updates.previewUrl = parsed.data.previewUrl;

    const [updated] = await db
      .update(galleryTemplatesTable)
      .set(updates)
      .where(eq(galleryTemplatesTable.id, id))
      .returning({ id: galleryTemplatesTable.id, status: galleryTemplatesTable.status });

    if (!updated) {
      res.status(404).json({ error: "Template not found" });
      return;
    }

    res.json(updated);
  } catch (err) {
    logger.error({ err }, "Failed to update gallery template");
    res.status(500).json({ error: "Failed to update template" });
  }
});

export default router;
