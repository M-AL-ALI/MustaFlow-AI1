// ─────────────────────────────────────────────────────────────────────────────
// Custom subdomain route
//
//   POST /api/projects/:id/subdomain — validate + set a custom publicSlug
//
// The slug becomes the subdomain on mustaflow.app, e.g. my-app.mustaflow.app.
// Validation: 3–40 chars, alphanumeric + hyphens, no leading/trailing hyphens.
// Uniqueness: checked across all projects; returns 409 if taken.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { db, projectsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";

const router: IRouter = Router();

const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN ?? "mustaflow.app";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const RESERVED = new Set([
  "www", "api", "app", "mail", "smtp", "ftp", "admin", "dashboard",
  "mustaflow", "support", "help", "status", "blog", "docs", "staging",
  "dev", "test", "demo", "sandbox", "internal", "static", "assets",
]);

router.post(
  "/projects/:id/subdomain",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const rawSlug = ((req.body as { slug?: string })?.slug ?? "").toLowerCase().trim();

    // Validate format
    if (!rawSlug || rawSlug.length < 3 || rawSlug.length > 40) {
      res.status(400).json({ error: "Subdomain must be 3–40 characters." });
      return;
    }
    if (!SLUG_RE.test(rawSlug)) {
      res.status(400).json({
        error: "Subdomain may only contain lowercase letters, numbers, and hyphens, and must not start or end with a hyphen.",
      });
      return;
    }
    if (RESERVED.has(rawSlug)) {
      res.status(400).json({ error: "This subdomain is reserved. Please choose another." });
      return;
    }

    // Check uniqueness (exclude this project itself)
    const [taken] = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(
        and(
          eq(projectsTable.publicSlug, rawSlug),
          ne(projectsTable.id, projectId),
          isNull(projectsTable.deletedAt),
        ),
      );

    if (taken) {
      res.status(409).json({ error: "This subdomain is already taken. Please choose another." });
      return;
    }

    // Update the project's publicSlug
    const [updated] = await db
      .update(projectsTable)
      .set({ publicSlug: rawSlug, updatedAt: sql`now()` })
      .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)))
      .returning({ publicSlug: projectsTable.publicSlug, status: projectsTable.status });

    if (!updated) {
      res.status(404).json({ error: "Project not found." });
      return;
    }

    const publicUrl = `https://${rawSlug}.${PLATFORM_DOMAIN}/`;
    const internalPathUrl = `/api/p/${rawSlug}/`;

    res.json({
      ok: true,
      publicSlug: rawSlug,
      publicUrl,
      internalPathUrl,
      note: "Subdomain updated. Your published site is now available at the new URL.",
    });
  },
);

export default router;
