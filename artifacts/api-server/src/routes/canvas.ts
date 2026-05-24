/**
 * Task #541 — Live mockup sandbox on Canvas.
 *
 * Variant lifecycle (server side):
 *   1. POST /api/projects/:id/canvas/explore  → create N pending rows, kick off
 *      one runRefinePipeline per variant (in parallel via setImmediate). Each
 *      variant gets its own snapshot of generated files stored in
 *      canvas_variants.files (jsonb).
 *   2. GET  /api/projects/:id/canvas/variants  → list (filters out variants
 *      idle > 24h before returning; the periodic sweep also runs here).
 *   3. GET  /api/projects/:id/canvas/variants/:vid/preview/{*splat}  → serves
 *      a file from the variant's frozen snapshot. Used as the iframe src on
 *      the canvas — completely isolated from project_files so the main app
 *      preview is never affected.
 *   4. POST /api/projects/:id/canvas/variants/:vid/graduate  → merges the
 *      variant's files into the main project's project_files table (upsert
 *      by path) and writes a project_versions snapshot for rollback.
 *   5. POST /api/projects/:id/canvas/extract  → creates a "extract"-source
 *      variant pre-seeded with chosen files copied from project_files, so
 *      the user can iterate on a component in isolation.
 *
 * Iframe lifecycle: the UI calls /variants/:vid/touch on visibility to bump
 * lastViewedAt; rows untouched for >24h are deleted by pruneStaleVariants
 * (best-effort, fire-and-forget on every list call).
 */
import { Router, type IRouter } from "express";
import { and, eq, desc, lt } from "drizzle-orm";
import {
  db,
  projectsTable,
  projectFilesTable,
  projectVersionsTable,
  canvasVariantsTable,
  type FileSnapshotEntry,
  type CanvasVariant,
} from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { guessMime, runRefinePipeline, type BuilderFile } from "../lib/builder";
import { injectBridge, MOCK_FLAG_SCRIPT } from "../lib/consoleBridge";
import { isBinaryMime } from "../lib/binary-mime";
import { writeKnowledge } from "../lib/knowledge";
import { logger } from "../lib/logger";
import crypto from "node:crypto";

const router: IRouter = Router();

const STALE_VARIANT_MS = 24 * 60 * 60 * 1000;
const MAX_VARIANTS_PER_EXPLORATION = 4;
const MIN_VARIANTS_PER_EXPLORATION = 2;
const DEFAULT_VARIANT_LABELS = ["Variant A", "Variant B", "Variant C", "Variant D"];

/**
 * Per-variant style hints injected into each parallel runRefinePipeline call,
 * so multiple variants from the same prompt explore genuinely different design
 * directions instead of returning near-identical outputs.
 */
const VARIANT_DIRECTIONS = [
  "Lean into bold contrast, dense type, and strong colour blocks.",
  "Take a minimal, airy approach with generous whitespace and restrained colour.",
  "Use a playful, rounded, friendly aesthetic with vivid accent colours.",
  "Adopt a sleek, modern, geometric look with sharp grids and subtle gradients.",
];

let lastPruneAt = 0;

/** Best-effort deletion of variants idle > 24h. Throttled to once per minute. */
async function pruneStaleVariants(): Promise<void> {
  const now = Date.now();
  if (now - lastPruneAt < 60_000) return;
  lastPruneAt = now;
  try {
    await db
      .delete(canvasVariantsTable)
      .where(lt(canvasVariantsTable.lastViewedAt, new Date(now - STALE_VARIANT_MS)));
  } catch (err) {
    logger.warn({ err }, "canvas: pruneStaleVariants failed");
  }
}

function serializeVariant(v: CanvasVariant): Record<string, unknown> {
  return {
    id: v.id,
    projectId: v.projectId,
    explorationId: v.explorationId,
    label: v.label,
    prompt: v.prompt,
    status: v.status,
    assistantSummary: v.assistantSummary,
    errorMessage: v.errorMessage,
    rank: v.rank,
    source: v.source,
    fileCount: Array.isArray(v.files) ? v.files.length : 0,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
    lastViewedAt: v.lastViewedAt.toISOString(),
    previewUrl: `/api/projects/${v.projectId}/canvas/variants/${v.id}/preview/`,
  };
}

async function runVariantGeneration(args: {
  variantId: number;
  projectId: number;
  projectName: string;
  projectKind: string;
  basePrompt: string;
  direction: string;
  existingFiles: BuilderFile[];
}): Promise<void> {
  const { variantId, projectId, projectName, projectKind, basePrompt, direction, existingFiles } =
    args;
  try {
    await db
      .update(canvasVariantsTable)
      .set({ status: "generating", updatedAt: new Date() })
      .where(eq(canvasVariantsTable.id, variantId));

    const userPrompt = [
      `Produce a UI variant for the following design exploration. This is a sandboxed mockup — do NOT modify any existing files outside the visible set; instead, output a complete, self-contained alternative.`,
      ``,
      `Exploration brief: ${basePrompt}`,
      ``,
      `This variant's design direction: ${direction}`,
      ``,
      `Output a fully working static preview (index.html and any supporting CSS/JS/SVG). Keep it self-contained and visually distinctive from the other variants in this exploration.`,
    ].join("\n");

    const result = await runRefinePipeline({
      projectName,
      projectKind,
      userPrompt,
      agentMode: "power",
      existingFiles,
    });

    // Merge unchanged + changed files into a complete snapshot for the variant.
    const changedByPath = new Map(result.changedFiles.map((f) => [f.path, f]));
    const removed = new Set(result.removedPaths);
    const snapshot: FileSnapshotEntry[] = [];
    for (const f of existingFiles) {
      if (removed.has(f.path)) continue;
      const ch = changedByPath.get(f.path);
      if (ch) {
        snapshot.push({ path: ch.path, content: ch.content, mimeType: ch.mimeType });
        changedByPath.delete(ch.path);
      } else {
        snapshot.push({ path: f.path, content: f.content, mimeType: f.mimeType });
      }
    }
    for (const ch of changedByPath.values()) {
      snapshot.push({ path: ch.path, content: ch.content, mimeType: ch.mimeType });
    }

    await db
      .update(canvasVariantsTable)
      .set({
        status: "ready",
        files: snapshot,
        assistantSummary: result.assistantSummary ?? null,
        errorMessage: null,
        updatedAt: new Date(),
        lastViewedAt: new Date(),
      })
      .where(eq(canvasVariantsTable.id, variantId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err, variantId, projectId }, "canvas: variant generation failed");
    await db
      .update(canvasVariantsTable)
      .set({
        status: "failed",
        errorMessage: msg.slice(0, 500),
        updatedAt: new Date(),
      })
      .where(eq(canvasVariantsTable.id, variantId))
      .catch(() => {
        /* non-fatal */
      });
  }
}

// ── POST /api/projects/:id/canvas/explore ────────────────────────────────────
router.post(
  "/projects/:id/canvas/explore",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const body = req.body as { prompt?: unknown; variantCount?: unknown } | undefined;
    const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
    const variantCount = Math.max(
      MIN_VARIANTS_PER_EXPLORATION,
      Math.min(
        MAX_VARIANTS_PER_EXPLORATION,
        typeof body?.variantCount === "number" ? Math.floor(body.variantCount) : 3,
      ),
    );
    if (!prompt) {
      res.status(400).json({ error: "prompt is required" });
      return;
    }

    const [project] = await db
      .select({
        id: projectsTable.id,
        name: projectsTable.name,
        kind: projectsTable.kind,
      })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const existingRows = await db
      .select()
      .from(projectFilesTable)
      .where(eq(projectFilesTable.projectId, projectId));
    const existingFiles: BuilderFile[] = existingRows.map((r) => ({
      path: r.path,
      content: r.content,
      mimeType: r.mimeType || guessMime(r.path),
    }));

    const explorationId = crypto.randomUUID();
    const inserts = await db
      .insert(canvasVariantsTable)
      .values(
        Array.from({ length: variantCount }, (_, i) => ({
          projectId,
          explorationId,
          label: DEFAULT_VARIANT_LABELS[i] ?? `Variant ${i + 1}`,
          prompt,
          status: "pending" as const,
          rank: i + 1,
          source: "explore",
        })),
      )
      .returning();

    // Kick off each variant in parallel; errors are captured per-variant.
    for (let i = 0; i < inserts.length; i++) {
      const v = inserts[i]!;
      const direction = VARIANT_DIRECTIONS[i % VARIANT_DIRECTIONS.length]!;
      setImmediate(() => {
        void runVariantGeneration({
          variantId: v.id,
          projectId,
          projectName: project.name,
          projectKind: project.kind,
          basePrompt: prompt,
          direction,
          existingFiles,
        });
      });
    }

    res.status(201).json({
      explorationId,
      variants: inserts.map(serializeVariant),
    });
  },
);

// ── GET /api/projects/:id/canvas/variants ────────────────────────────────────
router.get(
  "/projects/:id/canvas/variants",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    void pruneStaleVariants(); // fire-and-forget
    const rows = await db
      .select()
      .from(canvasVariantsTable)
      .where(eq(canvasVariantsTable.projectId, projectId))
      .orderBy(desc(canvasVariantsTable.createdAt));
    res.json({ variants: rows.map(serializeVariant) });
  },
);

// ── GET /api/projects/:id/canvas/variants/:vid ───────────────────────────────
router.get(
  "/projects/:id/canvas/variants/:vid",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const vid = Number(req.params.vid);
    const [row] = await db
      .select()
      .from(canvasVariantsTable)
      .where(and(eq(canvasVariantsTable.projectId, projectId), eq(canvasVariantsTable.id, vid)));
    if (!row) {
      res.status(404).json({ error: "Variant not found" });
      return;
    }
    res.json(serializeVariant(row));
  },
);

// ── POST /api/projects/:id/canvas/variants/:vid/touch ────────────────────────
// Bumps lastViewedAt so the variant survives the 24h idle sweep while visible.
router.post(
  "/projects/:id/canvas/variants/:vid/touch",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const vid = Number(req.params.vid);
    await db
      .update(canvasVariantsTable)
      .set({ lastViewedAt: new Date() })
      .where(and(eq(canvasVariantsTable.projectId, projectId), eq(canvasVariantsTable.id, vid)));
    res.json({ touched: true });
  },
);

// ── DELETE /api/projects/:id/canvas/variants/:vid ────────────────────────────
router.delete(
  "/projects/:id/canvas/variants/:vid",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const vid = Number(req.params.vid);
    await db
      .delete(canvasVariantsTable)
      .where(and(eq(canvasVariantsTable.projectId, projectId), eq(canvasVariantsTable.id, vid)));
    res.json({ deleted: true });
  },
);

// ── GET /api/projects/:id/canvas/variants/:vid/preview/{*splat} ──────────────
// Serves files from the variant's frozen snapshot. Owner-only (mounted under
// the auth wall via routes/index.ts). HTML responses get the bridge script so
// owner previews behave like the main preview tab.
router.get(
  "/projects/:id/canvas/variants/:vid/preview/{*splat}",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const vid = Number(req.params.vid);
    const splat = req.params.splat;
    const raw = Array.isArray(splat) ? splat.join("/") : (splat ?? "");
    const filePath = raw === "" ? "index.html" : raw;

    const [row] = await db
      .select()
      .from(canvasVariantsTable)
      .where(and(eq(canvasVariantsTable.projectId, projectId), eq(canvasVariantsTable.id, vid)));
    if (!row) {
      res.status(404).type("text/html").send("<h1>Variant not found</h1>");
      return;
    }
    if (row.status !== "ready" || !row.files) {
      res
        .status(202)
        .type("text/html")
        .send(
          `<!doctype html><html><body style="font-family:system-ui;padding:32px;color:#9ca3af;background:#0a0f1c"><h2 style="color:#fff">Variant ${row.status === "failed" ? "failed" : "generating"}…</h2><p>${row.status === "failed" ? (row.errorMessage ?? "Generation failed.") : "Waiting for the AI to finish rendering this variant."}</p></body></html>`,
        );
      return;
    }

    // Bump lastViewedAt on view (cheap, keeps the variant alive while shown).
    db.update(canvasVariantsTable)
      .set({ lastViewedAt: new Date() })
      .where(eq(canvasVariantsTable.id, vid))
      .catch(() => {
        /* non-fatal */
      });

    const files = row.files;
    let file = files.find((f) => f.path === filePath);
    if (!file && filePath !== "index.html") {
      // SPA fallback
      file = files.find((f) => f.path === "index.html");
    }
    if (!file) {
      res.status(404).type("text/html").send("<h1>Not found in variant snapshot</h1>");
      return;
    }
    const mime = file.mimeType || guessMime(file.path);
    res.setHeader("Cache-Control", "no-store, must-revalidate");
    if (isBinaryMime(mime)) {
      res.type(mime).send(Buffer.from(file.content, "base64"));
      return;
    }
    if (mime === "text/html") {
      res.type("text/html").send(injectBridge(file.content, MOCK_FLAG_SCRIPT));
      return;
    }
    res.type(mime).send(file.content);
  },
);

// ── POST /api/projects/:id/canvas/variants/:vid/graduate ─────────────────────
// Merges the variant's snapshot into the main project_files table (upsert by
// path) and writes a project_versions snapshot for rollback. Files present in
// the main project but absent from the variant snapshot are left untouched —
// graduation is additive, never destructive.
router.post(
  "/projects/:id/canvas/variants/:vid/graduate",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const vid = Number(req.params.vid);
    const body = req.body as { onlyPaths?: unknown } | undefined;
    const onlyPaths = Array.isArray(body?.onlyPaths)
      ? body.onlyPaths.filter((p): p is string => typeof p === "string")
      : null;

    const [variant] = await db
      .select()
      .from(canvasVariantsTable)
      .where(and(eq(canvasVariantsTable.projectId, projectId), eq(canvasVariantsTable.id, vid)));
    if (!variant) {
      res.status(404).json({ error: "Variant not found" });
      return;
    }
    if (variant.status !== "ready" || !variant.files || variant.files.length === 0) {
      res.status(409).json({ error: "Variant is not ready to graduate" });
      return;
    }

    const filesToMerge = onlyPaths
      ? variant.files.filter((f) => onlyPaths.includes(f.path))
      : variant.files;
    if (filesToMerge.length === 0) {
      res.status(400).json({ error: "No matching files to graduate" });
      return;
    }

    // Snapshot current files into project_versions BEFORE graduation, so the
    // user can roll back if the variant turns out to be a regression.
    const currentRows = await db
      .select()
      .from(projectFilesTable)
      .where(eq(projectFilesTable.projectId, projectId));
    const preSnapshot: FileSnapshotEntry[] = currentRows.map((r) => ({
      path: r.path,
      content: r.content,
      mimeType: r.mimeType || guessMime(r.path),
    }));
    await db.insert(projectVersionsTable).values({
      projectId,
      label: `Pre-graduation: ${variant.label}`,
      note: `Snapshot taken before graduating canvas variant #${variant.id}.`,
      filesSnapshot: preSnapshot,
    });

    // Upsert each variant file into project_files.
    const existingByPath = new Map(currentRows.map((r) => [r.path, r]));
    let inserted = 0;
    let updated = 0;
    for (const f of filesToMerge) {
      const mime = f.mimeType || guessMime(f.path);
      const existing = existingByPath.get(f.path);
      if (existing) {
        await db
          .update(projectFilesTable)
          .set({ content: f.content, mimeType: mime, updatedAt: new Date() })
          .where(eq(projectFilesTable.id, existing.id));
        updated++;
      } else {
        await db
          .insert(projectFilesTable)
          .values({ projectId, path: f.path, content: f.content, mimeType: mime });
        inserted++;
      }
    }

    // Knowledge vault: record what we did so future builds can learn from it.
    writeKnowledge({
      projectId,
      type: "lesson",
      severity: "info",
      title: `Graduated canvas variant "${variant.label}"`,
      content: `User accepted variant "${variant.label}" from exploration ${variant.explorationId} (${filesToMerge.length} files merged into main project).`,
      approvedForReuse: false,
    }).catch(() => {
      /* non-fatal */
    });

    res.json({
      graduated: true,
      variantId: variant.id,
      inserted,
      updated,
      filesMerged: filesToMerge.length,
    });
  },
);

// ── POST /api/projects/:id/canvas/extract ────────────────────────────────────
// Copies a set of files from the main project into a new sandbox variant so
// the user can iterate on them in isolation. Useful for redesigning a single
// component without risking the running app.
router.post(
  "/projects/:id/canvas/extract",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const body = req.body as { paths?: unknown; label?: unknown } | undefined;
    const paths = Array.isArray(body?.paths)
      ? body.paths.filter((p): p is string => typeof p === "string" && p.length > 0)
      : [];
    const label =
      typeof body?.label === "string" && body.label.trim().length > 0
        ? body.label.trim().slice(0, 80)
        : `Extracted ${paths.length} file${paths.length === 1 ? "" : "s"}`;
    if (paths.length === 0) {
      res.status(400).json({ error: "paths must be a non-empty string array" });
      return;
    }

    const rows = await db
      .select()
      .from(projectFilesTable)
      .where(eq(projectFilesTable.projectId, projectId));
    const byPath = new Map(rows.map((r) => [r.path, r]));
    const snapshot: FileSnapshotEntry[] = [];
    const missing: string[] = [];
    for (const p of paths) {
      const r = byPath.get(p);
      if (!r) {
        missing.push(p);
        continue;
      }
      snapshot.push({
        path: r.path,
        content: r.content,
        mimeType: r.mimeType || guessMime(r.path),
      });
    }
    if (snapshot.length === 0) {
      res.status(404).json({ error: "None of the requested paths exist", missing });
      return;
    }

    // Ensure there's an index.html for the iframe to land on. If the user didn't
    // extract one, copy the main project's index.html so the component renders
    // in context.
    if (!snapshot.some((f) => f.path === "index.html")) {
      const mainIndex = byPath.get("index.html");
      if (mainIndex) {
        snapshot.push({
          path: "index.html",
          content: mainIndex.content,
          mimeType: mainIndex.mimeType || "text/html",
        });
      }
    }

    const explorationId = crypto.randomUUID();
    const [inserted] = await db
      .insert(canvasVariantsTable)
      .values({
        projectId,
        explorationId,
        label,
        prompt: `Extracted ${paths.length} file(s) from main app: ${paths.join(", ")}`,
        status: "ready",
        files: snapshot,
        rank: 1,
        source: "extract",
      })
      .returning();

    res.status(201).json({
      ...serializeVariant(inserted!),
      missing,
    });
  },
);

export default router;
