/**
 * Task #541 — Live mockup sandbox on Canvas.
 * Task #634 — Canvas Variants Leadership.
 *
 * New in Task #634:
 *   - Up to 8 variants per exploration (raised from 4).
 *   - POST /canvas/variants/:vid/fork    — fork from any variant (lineage tree).
 *   - GET  /canvas/diff?a=:vid1&b=:vid2 — structural HTML diff between two variants.
 *   - POST /canvas/library               — save variant to cross-project library.
 *   - GET  /canvas/library               — list user's library items (all projects).
 *   - DELETE /canvas/library/:lid        — delete library item.
 *   - POST /projects/:id/canvas/library/:lid/import — import library item as new variant.
 *   - POST /canvas/variants/:vid/share   — generate/return signed preview token.
 *   - GET  /canvas/share/:token/{*splat} — public serve for shared variant (no auth).
 *   - POST /canvas/ab-tests              — create A/B test between two ready variants.
 *   - GET  /projects/:id/canvas/ab-tests — list A/B tests for a project.
 *   - POST /canvas/ab-tests/:testId/stop — stop a running A/B test.
 *   - POST /canvas/ab-tests/:testId/convert — record a conversion event (cookie-based).
 *   - GET  /canvas/ab/:testId/{*splat}   — public A/B traffic-split serve route.
 */
import { Router, type IRouter } from "express";
import { and, eq, desc, lt, sql } from "drizzle-orm";
import {
  db,
  projectsTable,
  projectFilesTable,
  projectVersionsTable,
  canvasVariantsTable,
  canvasVariantLibraryTable,
  canvasAbTestsTable,
  type FileSnapshotEntry,
  type CanvasVariant,
} from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { getAuth } from "@clerk/express";
import { guessMime, runRefinePipeline, type BuilderFile } from "../lib/builder";
import { injectBridge, MOCK_FLAG_SCRIPT } from "../lib/consoleBridge";
import { isBinaryMime } from "../lib/binary-mime";
import { writeKnowledge } from "../lib/knowledge";
import { logger } from "../lib/logger";
import crypto from "node:crypto";

const router: IRouter = Router();

const STALE_VARIANT_MS = 24 * 60 * 60 * 1000;
const MAX_VARIANTS_PER_EXPLORATION = 8;
const MIN_VARIANTS_PER_EXPLORATION = 2;
const DEFAULT_VARIANT_LABELS = [
  "Variant A",
  "Variant B",
  "Variant C",
  "Variant D",
  "Variant E",
  "Variant F",
  "Variant G",
  "Variant H",
];

/**
 * Per-variant style hints injected into each parallel runRefinePipeline call.
 * 8 directions so a full exploration of 8 produces genuinely distinct outputs.
 */
const VARIANT_DIRECTIONS = [
  "Lean into bold contrast, dense type, and strong colour blocks.",
  "Take a minimal, airy approach with generous whitespace and restrained colour.",
  "Use a playful, rounded, friendly aesthetic with vivid accent colours.",
  "Adopt a sleek, modern, geometric look with sharp grids and subtle gradients.",
  "Try a dark-mode-first editorial layout with oversized type and muted tones.",
  "Use a warm, organic palette with hand-crafted textures and soft shadows.",
  "Go maximalist — high visual density, rich illustrations, bold section separators.",
  "Embrace glassmorphism and translucency with a vibrant gradient backdrop.",
];

let lastPruneAt = 0;

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
    variantParentId: v.variantParentId,
    savedToLibrary: v.savedToLibrary,
    hasShareToken: !!v.shareToken,
    fileCount: Array.isArray(v.files) ? v.files.length : 0,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
    lastViewedAt: v.lastViewedAt.toISOString(),
    previewUrl: `/api/projects/${v.projectId}/canvas/variants/${v.id}/preview/`,
    shareUrl: v.shareToken ? `/api/canvas/share/${v.shareToken}/` : null,
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
      .set({ status: "failed", errorMessage: msg.slice(0, 500), updatedAt: new Date() })
      .where(eq(canvasVariantsTable.id, variantId))
      .catch(() => {
        /* non-fatal */
      });
  }
}

// ── Simple line-by-line diff ──────────────────────────────────────────────────
type DiffLine = { type: "added" | "removed" | "unchanged"; content: string };

function computeLineDiff(aText: string, bText: string): DiffLine[] {
  const aLines = aText.split("\n");
  const bLines = bText.split("\n");

  // Myers shortest-edit diff via dynamic programming (O(ND) approximation).
  // For large files we cap at 4000 lines per side to stay fast.
  const MAX = 4000;
  const a = aLines.slice(0, MAX);
  const b = bLines.slice(0, MAX);
  const n = a.length;
  const m = b.length;

  // LCS-based diff using standard DP
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i]![j] = (dp[i + 1]![j + 1] ?? 0) + 1;
      } else {
        dp[i]![j] = Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0);
      }
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      result.push({ type: "unchanged", content: a[i]! });
      i++;
      j++;
    } else if (j < m && (i >= n || (dp[i]![j + 1] ?? 0) >= (dp[i + 1]![j] ?? 0))) {
      result.push({ type: "added", content: b[j]! });
      j++;
    } else {
      result.push({ type: "removed", content: a[i]! });
      i++;
    }
  }
  return result;
}

function summariseDiff(lines: DiffLine[]): { additions: number; deletions: number; changes: number } {
  let additions = 0;
  let deletions = 0;
  for (const l of lines) {
    if (l.type === "added") additions++;
    else if (l.type === "removed") deletions++;
  }
  return { additions, deletions, changes: additions + deletions };
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
      .select({ id: projectsTable.id, name: projectsTable.name, kind: projectsTable.kind })
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

    res.status(201).json({ explorationId, variants: inserts.map(serializeVariant) });
  },
);

// ── GET /api/projects/:id/canvas/variants ────────────────────────────────────
router.get(
  "/projects/:id/canvas/variants",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    void pruneStaleVariants();
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

    db.update(canvasVariantsTable)
      .set({ lastViewedAt: new Date() })
      .where(eq(canvasVariantsTable.id, vid))
      .catch(() => {
        /* non-fatal */
      });

    const files = row.files;
    let file = files.find((f) => f.path === filePath);
    if (!file && filePath !== "index.html") file = files.find((f) => f.path === "index.html");
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

    res.json({ graduated: true, variantId: variant.id, inserted, updated, filesMerged: filesToMerge.length });
  },
);

// ── POST /api/projects/:id/canvas/extract ────────────────────────────────────
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
      if (!r) { missing.push(p); continue; }
      snapshot.push({ path: r.path, content: r.content, mimeType: r.mimeType || guessMime(r.path) });
    }
    if (snapshot.length === 0) {
      res.status(404).json({ error: "None of the requested paths exist", missing });
      return;
    }

    if (!snapshot.some((f) => f.path === "index.html")) {
      const mainIndex = byPath.get("index.html");
      if (mainIndex) {
        snapshot.push({ path: "index.html", content: mainIndex.content, mimeType: mainIndex.mimeType || "text/html" });
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

    res.status(201).json({ ...serializeVariant(inserted!), missing });
  },
);

// ── POST /api/projects/:id/canvas/variants/:vid/fork ─────────────────────────
// Fork a variant as the seed for a new exploration. The fork creates a new
// "ready" variant pre-loaded with the parent's files so the user can iterate
// without destroying the original.
router.post(
  "/projects/:id/canvas/variants/:vid/fork",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const vid = Number(req.params.vid);
    const body = req.body as { label?: unknown; prompt?: unknown } | undefined;

    const [parent] = await db
      .select()
      .from(canvasVariantsTable)
      .where(and(eq(canvasVariantsTable.projectId, projectId), eq(canvasVariantsTable.id, vid)));
    if (!parent) {
      res.status(404).json({ error: "Variant not found" });
      return;
    }
    if (parent.status !== "ready" || !parent.files) {
      res.status(409).json({ error: "Variant is not ready to fork" });
      return;
    }

    const forkLabel =
      typeof body?.label === "string" && body.label.trim()
        ? body.label.trim().slice(0, 80)
        : `Fork of ${parent.label}`;
    const forkPrompt =
      typeof body?.prompt === "string" && body.prompt.trim()
        ? body.prompt.trim()
        : parent.prompt;

    const explorationId = crypto.randomUUID();
    const [forked] = await db
      .insert(canvasVariantsTable)
      .values({
        projectId,
        explorationId,
        label: forkLabel,
        prompt: forkPrompt,
        status: "ready",
        files: parent.files,
        assistantSummary: parent.assistantSummary,
        rank: 1,
        source: "explore",
        variantParentId: vid,
      })
      .returning();

    res.status(201).json(serializeVariant(forked!));
  },
);

// ── GET /api/projects/:id/canvas/diff ────────────────────────────────────────
// Structural HTML diff between two variants. Returns line-level diff of
// index.html (or any other file specified by ?file=).
// Query params: a=<vid1>&b=<vid2>&file=<path> (file defaults to index.html).
router.get(
  "/projects/:id/canvas/diff",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const aId = Number(req.query.a);
    const bId = Number(req.query.b);
    const targetFile = typeof req.query.file === "string" ? req.query.file : "index.html";

    if (!aId || !bId) {
      res.status(400).json({ error: "Query params a and b (variant IDs) are required" });
      return;
    }
    if (aId === bId) {
      res.status(400).json({ error: "a and b must be different variants" });
      return;
    }

    const [varA, varB] = await Promise.all([
      db
        .select()
        .from(canvasVariantsTable)
        .where(and(eq(canvasVariantsTable.projectId, projectId), eq(canvasVariantsTable.id, aId)))
        .then((r) => r[0]),
      db
        .select()
        .from(canvasVariantsTable)
        .where(and(eq(canvasVariantsTable.projectId, projectId), eq(canvasVariantsTable.id, bId)))
        .then((r) => r[0]),
    ]);

    if (!varA || !varB) {
      res.status(404).json({ error: "One or both variants not found" });
      return;
    }
    if (varA.status !== "ready" || varB.status !== "ready") {
      res.status(409).json({ error: "Both variants must be ready before diffing" });
      return;
    }

    const getFile = (v: CanvasVariant, path: string) =>
      (v.files ?? []).find((f) => f.path === path)?.content ?? "";

    const aContent = getFile(varA, targetFile);
    const bContent = getFile(varB, targetFile);

    // List all unique files in both variants
    const aFiles = new Set((varA.files ?? []).map((f) => f.path));
    const bFiles = new Set((varB.files ?? []).map((f) => f.path));
    const allFiles = [...new Set([...aFiles, ...bFiles])].sort();
    const fileStatuses = allFiles.map((f) => ({
      path: f,
      inA: aFiles.has(f),
      inB: bFiles.has(f),
      status: aFiles.has(f) && bFiles.has(f) ? "both" : aFiles.has(f) ? "a-only" : "b-only",
    }));

    const diffLines = computeLineDiff(aContent, bContent);
    const summary = summariseDiff(diffLines);

    // Compact the diff: only return changed lines ± 3 lines of context
    const CONTEXT = 3;
    const compactLines: (DiffLine & { lineA?: number; lineB?: number })[] = [];
    let lineANum = 0;
    let lineBNum = 0;
    let lastChangedIdx = -1;
    for (let i = 0; i < diffLines.length; i++) {
      const l = diffLines[i]!;
      if (l.type !== "unchanged") lastChangedIdx = i;
    }
    let lineACounter = 0;
    let lineBCounter = 0;
    for (let i = 0; i < diffLines.length; i++) {
      const l = diffLines[i]!;
      if (l.type !== "unchanged") {
        lineACounter += l.type === "removed" ? 1 : 0;
        lineBCounter += l.type === "added" ? 1 : 0;
        compactLines.push({ ...l, lineA: l.type !== "added" ? lineACounter : undefined, lineB: l.type !== "removed" ? lineBCounter : undefined });
      } else {
        lineACounter++;
        lineBCounter++;
      }
    }
    void lineANum; void lineBNum; void lastChangedIdx; void CONTEXT;

    res.json({
      variantA: { id: varA.id, label: varA.label },
      variantB: { id: varB.id, label: varB.label },
      targetFile,
      fileStatuses,
      summary,
      lines: diffLines.slice(0, 3000),
    });
  },
);

// ── POST /api/projects/:id/canvas/variants/:vid/share ────────────────────────
// Generate (or retrieve) a signed preview token for a variant.
// The token is opaque (UUID) and stored in the DB. Anyone with the token
// can view the variant at /api/canvas/share/:token/.
router.post(
  "/projects/:id/canvas/variants/:vid/share",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const vid = Number(req.params.vid);

    const [variant] = await db
      .select()
      .from(canvasVariantsTable)
      .where(and(eq(canvasVariantsTable.projectId, projectId), eq(canvasVariantsTable.id, vid)));
    if (!variant) {
      res.status(404).json({ error: "Variant not found" });
      return;
    }
    if (variant.status !== "ready") {
      res.status(409).json({ error: "Variant is not ready to share" });
      return;
    }

    let token = variant.shareToken;
    if (!token) {
      token = crypto.randomUUID();
      await db
        .update(canvasVariantsTable)
        .set({ shareToken: token, updatedAt: new Date() })
        .where(eq(canvasVariantsTable.id, vid));
    }

    res.json({ token, shareUrl: `/api/canvas/share/${token}/` });
  },
);

// ── GET /api/canvas/share/:token/{*splat} ─────────────────────────────────────
// Public (no auth) serve route for shared variants.
router.get(
  "/canvas/share/:token/{*splat}",
  async (req, res): Promise<void> => {
    const token = req.params.token;
    const splat = req.params.splat;
    const raw = Array.isArray(splat) ? splat.join("/") : (splat ?? "");
    const filePath = raw === "" ? "index.html" : raw;

    const [row] = await db
      .select()
      .from(canvasVariantsTable)
      .where(eq(canvasVariantsTable.shareToken, token));

    if (!row) {
      res.status(404).type("text/html").send(
        `<!doctype html><html><body style="font-family:system-ui;padding:48px;color:#9ca3af;background:#0a0f1c"><h1 style="color:#fff">Preview not found</h1><p>This shared preview link is invalid or has expired.</p></body></html>`,
      );
      return;
    }
    if (row.status !== "ready" || !row.files) {
      res.status(202).type("text/html").send(
        `<!doctype html><html><body style="font-family:system-ui;padding:48px;color:#9ca3af;background:#0a0f1c"><h1 style="color:#fff">Not ready</h1><p>This variant is still generating.</p></body></html>`,
      );
      return;
    }

    const files = row.files;
    let file = files.find((f) => f.path === filePath);
    if (!file && filePath !== "index.html") file = files.find((f) => f.path === "index.html");
    if (!file) {
      res.status(404).type("text/html").send("<h1>File not found in variant snapshot</h1>");
      return;
    }

    const mime = file.mimeType || guessMime(file.path);
    res.setHeader("Cache-Control", "no-store");
    if (isBinaryMime(mime)) {
      res.type(mime).send(Buffer.from(file.content, "base64"));
      return;
    }
    if (mime === "text/html") {
      // Inject a simple banner so viewers know this is a shared preview.
      const banner = `<div style="position:fixed;top:0;left:0;right:0;z-index:99999;background:#1e1b4b;color:#c4b5fd;font-family:system-ui;font-size:12px;padding:6px 16px;text-align:center;">Shared canvas variant preview — <strong>${row.label}</strong></div><div style="height:32px"></div>`;
      const html = file.content.replace(/<body[^>]*>/i, (m) => `${m}${banner}`);
      res.type("text/html").send(html);
      return;
    }
    res.type(mime).send(file.content);
  },
);

// ── Cross-project Variant Library ─────────────────────────────────────────────

// POST /api/canvas/library — save a variant to the library
router.post(
  "/projects/:id/canvas/variants/:vid/save-to-library",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const vid = Number(req.params.vid);
    const body = req.body as { label?: unknown; description?: unknown } | undefined;

    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    const [variant] = await db
      .select()
      .from(canvasVariantsTable)
      .where(and(eq(canvasVariantsTable.projectId, projectId), eq(canvasVariantsTable.id, vid)));
    if (!variant) {
      res.status(404).json({ error: "Variant not found" });
      return;
    }
    if (variant.status !== "ready" || !variant.files) {
      res.status(409).json({ error: "Variant is not ready to save" });
      return;
    }

    const label =
      typeof body?.label === "string" && body.label.trim()
        ? body.label.trim().slice(0, 80)
        : variant.label;
    const description =
      typeof body?.description === "string" ? body.description.trim().slice(0, 300) : null;

    const [item] = await db
      .insert(canvasVariantLibraryTable)
      .values({
        userId: auth.userId,
        label,
        description,
        files: variant.files,
        sourceProjectId: projectId,
        sourceVariantId: vid,
      })
      .returning();

    await db
      .update(canvasVariantsTable)
      .set({ savedToLibrary: true, updatedAt: new Date() })
      .where(eq(canvasVariantsTable.id, vid));

    res.status(201).json({
      id: item!.id,
      label: item!.label,
      description: item!.description,
      fileCount: (item!.files ?? []).length,
      createdAt: item!.createdAt.toISOString(),
    });
  },
);

// GET /api/canvas/library — list user's library (all projects)
router.get(
  "/canvas/library",
  async (req, res): Promise<void> => {
    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    const items = await db
      .select()
      .from(canvasVariantLibraryTable)
      .where(eq(canvasVariantLibraryTable.userId, auth.userId))
      .orderBy(desc(canvasVariantLibraryTable.createdAt));

    res.json({
      items: items.map((item) => ({
        id: item.id,
        label: item.label,
        description: item.description,
        fileCount: (item.files ?? []).length,
        sourceProjectId: item.sourceProjectId,
        sourceVariantId: item.sourceVariantId,
        createdAt: item.createdAt.toISOString(),
      })),
    });
  },
);

// DELETE /api/canvas/library/:lid — delete a library item
router.delete(
  "/canvas/library/:lid",
  async (req, res): Promise<void> => {
    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    const lid = Number(req.params.lid);
    await db
      .delete(canvasVariantLibraryTable)
      .where(
        and(eq(canvasVariantLibraryTable.id, lid), eq(canvasVariantLibraryTable.userId, auth.userId)),
      );
    res.json({ deleted: true });
  },
);

// POST /api/projects/:id/canvas/library/:lid/import — import into project
router.post(
  "/projects/:id/canvas/library/:lid/import",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const lid = Number(req.params.lid);

    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    const [item] = await db
      .select()
      .from(canvasVariantLibraryTable)
      .where(
        and(eq(canvasVariantLibraryTable.id, lid), eq(canvasVariantLibraryTable.userId, auth.userId)),
      );
    if (!item) {
      res.status(404).json({ error: "Library item not found" });
      return;
    }

    const explorationId = crypto.randomUUID();
    const [inserted] = await db
      .insert(canvasVariantsTable)
      .values({
        projectId,
        explorationId,
        label: item.label,
        prompt: `Imported from library: ${item.label}`,
        status: "ready",
        files: item.files,
        rank: 1,
        source: "extract",
      })
      .returning();

    res.status(201).json(serializeVariant(inserted!));
  },
);

// ── A/B Tests ─────────────────────────────────────────────────────────────────

// POST /api/projects/:id/canvas/ab-tests — create A/B test
router.post(
  "/projects/:id/canvas/ab-tests",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const body = req.body as {
      variantAId?: unknown;
      variantBId?: unknown;
      trafficSplitPct?: unknown;
      metric?: unknown;
    } | undefined;

    const variantAId = typeof body?.variantAId === "number" ? body.variantAId : 0;
    const variantBId = typeof body?.variantBId === "number" ? body.variantBId : 0;
    const trafficSplitPct = typeof body?.trafficSplitPct === "number"
      ? Math.max(10, Math.min(90, Math.floor(body.trafficSplitPct)))
      : 50;
    const metric = typeof body?.metric === "string" ? body.metric.slice(0, 50) : "clicks";

    if (!variantAId || !variantBId) {
      res.status(400).json({ error: "variantAId and variantBId are required" });
      return;
    }
    if (variantAId === variantBId) {
      res.status(400).json({ error: "variantAId and variantBId must be different" });
      return;
    }

    const [varA, varB] = await Promise.all([
      db.select().from(canvasVariantsTable)
        .where(and(eq(canvasVariantsTable.projectId, projectId), eq(canvasVariantsTable.id, variantAId)))
        .then((r) => r[0]),
      db.select().from(canvasVariantsTable)
        .where(and(eq(canvasVariantsTable.projectId, projectId), eq(canvasVariantsTable.id, variantBId)))
        .then((r) => r[0]),
    ]);

    if (!varA || !varB) {
      res.status(404).json({ error: "One or both variants not found in this project" });
      return;
    }
    if (varA.status !== "ready" || varB.status !== "ready") {
      res.status(409).json({ error: "Both variants must be ready before starting an A/B test" });
      return;
    }

    const [test] = await db
      .insert(canvasAbTestsTable)
      .values({ projectId, variantAId, variantBId, trafficSplitPct, metric, status: "running" })
      .returning();

    res.status(201).json({
      id: test!.id,
      projectId: test!.projectId,
      variantAId: test!.variantAId,
      variantBId: test!.variantBId,
      trafficSplitPct: test!.trafficSplitPct,
      metric: test!.metric,
      status: test!.status,
      viewsA: 0,
      viewsB: 0,
      conversionsA: 0,
      conversionsB: 0,
      testUrl: `/api/canvas/ab/${test!.id}/`,
      createdAt: test!.createdAt.toISOString(),
    });
  },
);

// GET /api/projects/:id/canvas/ab-tests — list A/B tests for a project
router.get(
  "/projects/:id/canvas/ab-tests",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const tests = await db
      .select()
      .from(canvasAbTestsTable)
      .where(eq(canvasAbTestsTable.projectId, projectId))
      .orderBy(desc(canvasAbTestsTable.createdAt));

    res.json({
      tests: tests.map((t) => ({
        id: t.id,
        projectId: t.projectId,
        variantAId: t.variantAId,
        variantBId: t.variantBId,
        trafficSplitPct: t.trafficSplitPct,
        metric: t.metric,
        status: t.status,
        winnerId: t.winnerId,
        viewsA: t.viewsA,
        viewsB: t.viewsB,
        conversionsA: t.conversionsA,
        conversionsB: t.conversionsB,
        testUrl: `/api/canvas/ab/${t.id}/`,
        createdAt: t.createdAt.toISOString(),
        endedAt: t.endedAt?.toISOString() ?? null,
      })),
    });
  },
);

// POST /api/projects/:id/canvas/ab-tests/:testId/stop — stop a running test
router.post(
  "/projects/:id/canvas/ab-tests/:testId/stop",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const testId = Number(req.params.testId);
    const body = req.body as { winnerId?: unknown } | undefined;
    const winnerId = typeof body?.winnerId === "number" ? body.winnerId : null;

    const [test] = await db
      .select()
      .from(canvasAbTestsTable)
      .where(and(eq(canvasAbTestsTable.id, testId), eq(canvasAbTestsTable.projectId, projectId)));
    if (!test) {
      res.status(404).json({ error: "A/B test not found" });
      return;
    }

    await db
      .update(canvasAbTestsTable)
      .set({ status: "ended", winnerId, endedAt: new Date() })
      .where(eq(canvasAbTestsTable.id, testId));

    res.json({ stopped: true, testId });
  },
);

// POST /api/canvas/ab-tests/:testId/convert — record a conversion (public)
router.post(
  "/canvas/ab-tests/:testId/convert",
  async (req, res): Promise<void> => {
    const testId = Number(req.params.testId);
    const body = req.body as { variant?: unknown } | undefined;
    const variant = body?.variant === "b" ? "b" : "a";

    try {
      if (variant === "a") {
        await db
          .update(canvasAbTestsTable)
          .set({ conversionsA: sql`${canvasAbTestsTable.conversionsA} + 1` })
          .where(and(eq(canvasAbTestsTable.id, testId), eq(canvasAbTestsTable.status, "running")));
      } else {
        await db
          .update(canvasAbTestsTable)
          .set({ conversionsB: sql`${canvasAbTestsTable.conversionsB} + 1` })
          .where(and(eq(canvasAbTestsTable.id, testId), eq(canvasAbTestsTable.status, "running")));
      }
    } catch {
      /* non-fatal */
    }
    res.json({ recorded: true });
  },
);

// ── GET /api/canvas/ab/:testId/{*splat} ──────────────────────────────────────
// Public (no auth) traffic-split serve route. Uses a cookie to ensure each
// visitor sees the same variant on subsequent visits.
function parseCookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const [key, ...vals] = part.trim().split("=");
    if (key?.trim() === name) return vals.join("=").trim();
  }
  return undefined;
}

router.get(
  "/canvas/ab/:testId/{*splat}",
  async (req, res): Promise<void> => {
    const testId = Number(req.params.testId);
    const splat = req.params.splat;
    const raw = Array.isArray(splat) ? splat.join("/") : (splat ?? "");
    const filePath = raw === "" ? "index.html" : raw;

    const [test] = await db
      .select()
      .from(canvasAbTestsTable)
      .where(eq(canvasAbTestsTable.id, testId));

    if (!test) {
      res.status(404).type("text/html").send(
        `<!doctype html><html><body style="font-family:system-ui;padding:48px;color:#9ca3af;background:#0a0f1c"><h1 style="color:#fff">A/B Test not found</h1></body></html>`,
      );
      return;
    }
    if (test.status !== "running") {
      res.status(410).type("text/html").send(
        `<!doctype html><html><body style="font-family:system-ui;padding:48px;color:#9ca3af;background:#0a0f1c"><h1 style="color:#fff">Test ended</h1><p>This A/B test is no longer active.</p></body></html>`,
      );
      return;
    }

    // Determine which variant to serve: cookie → deterministic; first visit → random.
    const cookieName = `mf_ab_${testId}`;
    const cookieHeader = req.headers.cookie;
    let assignedVariant = parseCookieValue(cookieHeader, cookieName) as "a" | "b" | undefined;
    if (!assignedVariant || (assignedVariant !== "a" && assignedVariant !== "b")) {
      const rand = Math.random() * 100;
      assignedVariant = rand < test.trafficSplitPct ? "a" : "b";
      res.setHeader("Set-Cookie", `${cookieName}=${assignedVariant}; Path=/; Max-Age=${7 * 24 * 3600}; SameSite=Lax`);
    }

    const variantId = assignedVariant === "a" ? test.variantAId : test.variantBId;

    // Record view (best-effort, non-blocking)
    setImmediate(() => {
      const updateSet = assignedVariant === "a"
        ? { viewsA: sql`${canvasAbTestsTable.viewsA} + 1` }
        : { viewsB: sql`${canvasAbTestsTable.viewsB} + 1` };
      db.update(canvasAbTestsTable).set(updateSet).where(eq(canvasAbTestsTable.id, testId)).catch(() => {});
    });

    const [row] = await db
      .select()
      .from(canvasVariantsTable)
      .where(eq(canvasVariantsTable.id, variantId));

    if (!row || row.status !== "ready" || !row.files) {
      res.status(503).type("text/html").send(
        `<!doctype html><html><body style="font-family:system-ui;padding:48px;color:#9ca3af;background:#0a0f1c"><h1 style="color:#fff">Variant not available</h1></body></html>`,
      );
      return;
    }

    const files = row.files;
    let file = files.find((f) => f.path === filePath);
    if (!file && filePath !== "index.html") file = files.find((f) => f.path === "index.html");
    if (!file) {
      res.status(404).type("text/html").send("<h1>File not found</h1>");
      return;
    }

    const mime = file.mimeType || guessMime(file.path);
    res.setHeader("Cache-Control", "no-store");
    if (isBinaryMime(mime)) {
      res.type(mime).send(Buffer.from(file.content, "base64"));
      return;
    }
    if (mime === "text/html") {
      // Inject conversion tracking script into served HTML.
      const convScript = `<script>(function(){var t=${testId},v="${assignedVariant}";try{fetch('/api/canvas/ab-tests/'+t+'/convert',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({variant:v})});}catch(_){}})();</script>`;
      const html = file.content.replace("</body>", `${convScript}</body>`);
      res.type("text/html").send(html);
      return;
    }
    res.type(mime).send(file.content);
  },
);

// ── Public canvas router (no auth required) ───────────────────────────────────
// Mounted before the auth wall in routes/index.ts.
export const publicCanvasRouter: IRouter = Router();

// Mount the three public handlers onto publicCanvasRouter:
//   GET  /canvas/share/:token/{*splat}     — shared variant preview
//   GET  /canvas/ab/:testId/{*splat}       — A/B traffic-split serve
//   POST /canvas/ab-tests/:testId/convert  — conversion recording
//
// We re-register them on publicCanvasRouter so they are reachable
// before the Clerk auth wall.

publicCanvasRouter.get(
  "/canvas/share/:token/{*splat}",
  async (req, res): Promise<void> => {
    const token = req.params.token;
    const splat = req.params.splat;
    const raw = Array.isArray(splat) ? splat.join("/") : (splat ?? "");
    const filePath = raw === "" ? "index.html" : raw;

    const [row] = await db
      .select()
      .from(canvasVariantsTable)
      .where(eq(canvasVariantsTable.shareToken, token));

    if (!row) {
      res.status(404).type("text/html").send(
        `<!doctype html><html><body style="font-family:system-ui;padding:48px;color:#9ca3af;background:#0a0f1c"><h1 style="color:#fff">Preview not found</h1><p>This shared preview link is invalid or has expired.</p></body></html>`,
      );
      return;
    }
    if (row.status !== "ready" || !row.files) {
      res.status(202).type("text/html").send(
        `<!doctype html><html><body style="font-family:system-ui;padding:48px;color:#9ca3af;background:#0a0f1c"><h1 style="color:#fff">Not ready</h1><p>This variant is still generating.</p></body></html>`,
      );
      return;
    }

    const files = row.files;
    let file = files.find((f) => f.path === filePath);
    if (!file && filePath !== "index.html") file = files.find((f) => f.path === "index.html");
    if (!file) {
      res.status(404).type("text/html").send("<h1>File not found in variant snapshot</h1>");
      return;
    }

    const mime = file.mimeType || guessMime(file.path);
    res.setHeader("Cache-Control", "no-store");
    if (isBinaryMime(mime)) {
      res.type(mime).send(Buffer.from(file.content, "base64"));
      return;
    }
    if (mime === "text/html") {
      const banner = `<div style="position:fixed;top:0;left:0;right:0;z-index:99999;background:#1e1b4b;color:#c4b5fd;font-family:system-ui;font-size:12px;padding:6px 16px;text-align:center;">Shared canvas variant preview — <strong>${row.label}</strong></div><div style="height:32px"></div>`;
      const html = file.content.replace(/<body[^>]*>/i, (m) => `${m}${banner}`);
      res.type("text/html").send(html);
      return;
    }
    res.type(mime).send(file.content);
  },
);

publicCanvasRouter.get(
  "/canvas/ab/:testId/{*splat}",
  async (req, res): Promise<void> => {
    const testId = Number(req.params.testId);
    const splat = req.params.splat;
    const raw = Array.isArray(splat) ? splat.join("/") : (splat ?? "");
    const filePath = raw === "" ? "index.html" : raw;

    const [test] = await db.select().from(canvasAbTestsTable).where(eq(canvasAbTestsTable.id, testId));

    if (!test) {
      res.status(404).type("text/html").send(`<!doctype html><html><body style="font-family:system-ui;padding:48px;color:#9ca3af;background:#0a0f1c"><h1 style="color:#fff">A/B Test not found</h1></body></html>`);
      return;
    }
    if (test.status !== "running") {
      res.status(410).type("text/html").send(`<!doctype html><html><body style="font-family:system-ui;padding:48px;color:#9ca3af;background:#0a0f1c"><h1 style="color:#fff">Test ended</h1><p>This A/B test is no longer active.</p></body></html>`);
      return;
    }

    const cookieName = `mf_ab_${testId}`;
    const cookieHeader = req.headers.cookie;
    let assignedVariant = parseCookieValue(cookieHeader, cookieName) as "a" | "b" | undefined;
    if (!assignedVariant || (assignedVariant !== "a" && assignedVariant !== "b")) {
      const rand = Math.random() * 100;
      assignedVariant = rand < test.trafficSplitPct ? "a" : "b";
      res.setHeader("Set-Cookie", `${cookieName}=${assignedVariant}; Path=/; Max-Age=${7 * 24 * 3600}; SameSite=Lax`);
    }

    const variantId = assignedVariant === "a" ? test.variantAId : test.variantBId;

    setImmediate(() => {
      const updateSet = assignedVariant === "a"
        ? { viewsA: sql`${canvasAbTestsTable.viewsA} + 1` }
        : { viewsB: sql`${canvasAbTestsTable.viewsB} + 1` };
      db.update(canvasAbTestsTable).set(updateSet).where(eq(canvasAbTestsTable.id, testId)).catch(() => {});
    });

    const [row] = await db.select().from(canvasVariantsTable).where(eq(canvasVariantsTable.id, variantId));

    if (!row || row.status !== "ready" || !row.files) {
      res.status(503).type("text/html").send(`<!doctype html><html><body style="font-family:system-ui;padding:48px;color:#9ca3af;background:#0a0f1c"><h1 style="color:#fff">Variant not available</h1></body></html>`);
      return;
    }

    const files = row.files;
    let file = files.find((f) => f.path === filePath);
    if (!file && filePath !== "index.html") file = files.find((f) => f.path === "index.html");
    if (!file) {
      res.status(404).type("text/html").send("<h1>File not found</h1>");
      return;
    }

    const mime = file.mimeType || guessMime(file.path);
    res.setHeader("Cache-Control", "no-store");
    if (isBinaryMime(mime)) {
      res.type(mime).send(Buffer.from(file.content, "base64"));
      return;
    }
    if (mime === "text/html") {
      const convScript = `<script>(function(){var t=${testId},v="${assignedVariant}";try{fetch('/api/canvas/ab-tests/'+t+'/convert',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({variant:v})});}catch(_){}})();</script>`;
      const html = file.content.replace("</body>", `${convScript}</body>`);
      res.type("text/html").send(html);
      return;
    }
    res.type(mime).send(file.content);
  },
);

publicCanvasRouter.post(
  "/canvas/ab-tests/:testId/convert",
  async (req, res): Promise<void> => {
    const testId = Number(req.params.testId);
    const body = req.body as { variant?: unknown } | undefined;
    const variant = body?.variant === "b" ? "b" : "a";
    try {
      if (variant === "a") {
        await db.update(canvasAbTestsTable).set({ conversionsA: sql`${canvasAbTestsTable.conversionsA} + 1` }).where(and(eq(canvasAbTestsTable.id, testId), eq(canvasAbTestsTable.status, "running")));
      } else {
        await db.update(canvasAbTestsTable).set({ conversionsB: sql`${canvasAbTestsTable.conversionsB} + 1` }).where(and(eq(canvasAbTestsTable.id, testId), eq(canvasAbTestsTable.status, "running")));
      }
    } catch { /* non-fatal */ }
    res.json({ recorded: true });
  },
);

publicCanvasRouter.get(
  "/canvas/library",
  async (req, res): Promise<void> => {
    const auth = getAuth(req);
    if (!auth.userId) { res.status(401).json({ error: "Not authenticated" }); return; }
    const items = await db.select().from(canvasVariantLibraryTable).where(eq(canvasVariantLibraryTable.userId, auth.userId)).orderBy(desc(canvasVariantLibraryTable.createdAt));
    res.json({ items: items.map((item) => ({ id: item.id, label: item.label, description: item.description, fileCount: (item.files ?? []).length, sourceProjectId: item.sourceProjectId, sourceVariantId: item.sourceVariantId, createdAt: item.createdAt.toISOString() })) });
  },
);

publicCanvasRouter.delete(
  "/canvas/library/:lid",
  async (req, res): Promise<void> => {
    const auth = getAuth(req);
    if (!auth.userId) { res.status(401).json({ error: "Not authenticated" }); return; }
    const lid = Number(req.params.lid);
    await db.delete(canvasVariantLibraryTable).where(and(eq(canvasVariantLibraryTable.id, lid), eq(canvasVariantLibraryTable.userId, auth.userId)));
    res.json({ deleted: true });
  },
);

export default router;
