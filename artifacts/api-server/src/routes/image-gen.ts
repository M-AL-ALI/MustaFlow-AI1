/**
 * Image Studio API routes — Phase 9A-1.
 *
 * Routes:
 *   POST   /images/generate        — enqueue async image generation (variationCount 1/2/4)
 *   GET    /images/status/:jobId   — poll job status (pending→generating→completed|failed)
 *   GET    /images                 — list user's generated images (paginated, optional projectId filter)
 *   GET    /images/:id             — get a single generated image
 *   DELETE /images/:id             — soft-delete an image
 *
 * All routes require authentication (mounted after the auth wall in index.ts).
 * ISOLATION: this file MUST NOT import from builder.ts or any pipeline module.
 */
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Router, type IRouter } from "express";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db, generatedImagesTable } from "@workspace/db";
import { EnqueueImageGenerationBody } from "@workspace/api-zod";
import { isImageProviderConfigured } from "../lib/image-provider";
import { enqueueImageJob, getJob, preflightImageJobs } from "../lib/image-generation-jobs";
import { IMAGE_CREDIT_COSTS } from "./image-credits";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ── POST /images/generate ─────────────────────────────────────────────────────
router.post("/images/generate", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  if (!isImageProviderConfigured()) {
    res.status(503).json({
      error: "Image generation is not configured. Set OPENAI_IMAGE_API_KEY or OPENAI_API_KEY.",
    });
    return;
  }

  const parsed = EnqueueImageGenerationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const {
    prompt,
    negativePrompt,
    quality,
    aspectRatio,
    style,
    purpose,
    transparentBackground,
    variationCount,
    projectId,
  } = parsed.data;

  // variationCount: DALL-E 3 only supports n=1, so we enqueue multiple separate jobs
  const safeVariationCount = variationCount;

  const baseOpts = {
    userId,
    prompt: prompt.trim(),
    negativePrompt: negativePrompt?.trim() || undefined,
    quality,
    aspectRatio,
    style,
    purpose,
    transparentBackground,
    projectId: typeof projectId === "number" ? projectId : undefined,
  };

  try {
    if (safeVariationCount === 1) {
      const { jobId, imageId } = await enqueueImageJob(baseOpts);
      res.status(202).json({
        jobId,
        imageId,
        creditCost: IMAGE_CREDIT_COSTS[quality] ?? 3,
        status: "pending",
        jobIds: [jobId],
        imageIds: [imageId],
      });
    } else {
      // Atomic preflight: verify rate limits + total credit balance before ANY job is
      // inserted or credits are deducted. This prevents partial-enqueue scenarios
      // (e.g. first variation deducts credits, second fails → half-done state).
      await preflightImageJobs(userId, safeVariationCount, quality);

      const results = await Promise.all(
        Array.from({ length: safeVariationCount }, () => enqueueImageJob(baseOpts)),
      );
      const creditCostPer = IMAGE_CREDIT_COSTS[quality] ?? 3;
      res.status(202).json({
        jobId: results[0]!.jobId,
        imageId: results[0]!.imageId,
        creditCost: creditCostPer * safeVariationCount,
        status: "pending",
        jobIds: results.map((r) => r.jobId),
        imageIds: results.map((r) => r.imageId),
      });
    }
  } catch (err) {
    const e = err as { code?: string; message?: string; balance?: number; category?: string };
    if (e.code === "INSUFFICIENT_CREDITS") {
      res.status(402).json({ error: "Insufficient credits", balance: e.balance });
      return;
    }
    if (e.code === "SAFETY_BLOCKED") {
      res
        .status(422)
        .json({ error: e.message ?? "Prompt failed safety check", category: e.category });
      return;
    }
    if (e.code === "RATE_LIMITED") {
      res
        .status(429)
        .set("Retry-After", "3600")
        .json({ error: e.message ?? "Rate limit exceeded", retryAfterSeconds: 3600 });
      return;
    }
    logger.warn({ err }, "image-gen: unexpected error in /images/generate");
    res.status(500).json({ error: "Image generation failed" });
  }
});

// ── GET /images/status/:jobId ─────────────────────────────────────────────────
router.get("/images/status/:jobId", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const { jobId } = req.params;
  if (!jobId) {
    res.status(400).json({ error: "jobId is required" });
    return;
  }

  const job = getJob(jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found or expired" });
    return;
  }

  if (job.userId !== userId) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  res.json({
    jobId: job.jobId,
    imageId: job.imageId,
    status: job.status,
    fileUrl: job.status === "completed" ? (job.fileUrl ?? null) : null,
    thumbnailUrl: job.status === "completed" ? (job.thumbnailUrl ?? null) : null,
    error: job.status === "failed" ? (job.error ?? null) : null,
  });
});

// ── GET /images ───────────────────────────────────────────────────────────────
router.get("/images", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const limit = Math.min(Number(req.query.limit ?? "20"), 50);
  const offset = Number(req.query.offset ?? "0");
  const projectIdFilter =
    req.query.projectId !== undefined ? Number(req.query.projectId) : undefined;

  const conditions = [
    eq(generatedImagesTable.userId, userId),
    isNull(generatedImagesTable.deletedAt),
    ...(projectIdFilter !== undefined && Number.isFinite(projectIdFilter)
      ? [eq(generatedImagesTable.projectId, projectIdFilter)]
      : []),
  ];

  const rows = await db
    .select({
      id: generatedImagesTable.id,
      prompt: generatedImagesTable.prompt,
      negativePrompt: generatedImagesTable.negativePrompt,
      revisedPrompt: generatedImagesTable.revisedPrompt,
      style: generatedImagesTable.style,
      purpose: generatedImagesTable.purpose,
      quality: generatedImagesTable.quality,
      aspectRatio: generatedImagesTable.aspectRatio,
      transparentBackground: generatedImagesTable.transparentBackground,
      providerName: generatedImagesTable.providerName,
      modelName: generatedImagesTable.modelName,
      status: generatedImagesTable.status,
      fileUrl: generatedImagesTable.fileUrl,
      thumbnailUrl: generatedImagesTable.thumbnailUrl,
      creditCost: generatedImagesTable.creditCost,
      errorMessage: generatedImagesTable.errorMessage,
      createdAt: generatedImagesTable.createdAt,
    })
    .from(generatedImagesTable)
    .where(and(...conditions))
    .orderBy(desc(generatedImagesTable.createdAt))
    .limit(limit)
    .offset(offset);

  const [countResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(generatedImagesTable)
    .where(and(...conditions));

  res.json({
    images: rows,
    total: countResult?.count ?? 0,
    limit,
    offset,
  });
});

// ── GET /images/:id ───────────────────────────────────────────────────────────
router.get("/images/:id", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const imageId = Number(req.params.id);
  if (!Number.isFinite(imageId)) {
    res.status(400).json({ error: "Invalid image id" });
    return;
  }

  const [row] = await db
    .select()
    .from(generatedImagesTable)
    .where(
      and(
        eq(generatedImagesTable.id, imageId),
        eq(generatedImagesTable.userId, userId),
        isNull(generatedImagesTable.deletedAt),
      ),
    );

  if (!row) {
    res.status(404).json({ error: "Image not found" });
    return;
  }

  res.json(row);
});

// ── GET /images/:id/file ─────────────────────────────────────────────────────
// Serves the generated image file from the OS temp directory (dev-only fallback).
// In production, fileUrl points directly to R2 and this endpoint is not used.
// Validates that storageKey is a temp-dir path to prevent path traversal.
router.get("/images/:id/file", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const imageId = Number(req.params.id);
  if (!Number.isFinite(imageId)) {
    res.status(400).json({ error: "Invalid image id" });
    return;
  }

  const [row] = await db
    .select({
      id: generatedImagesTable.id,
      storageKey: generatedImagesTable.storageKey,
      status: generatedImagesTable.status,
    })
    .from(generatedImagesTable)
    .where(
      and(
        eq(generatedImagesTable.id, imageId),
        eq(generatedImagesTable.userId, userId),
        isNull(generatedImagesTable.deletedAt),
      ),
    );

  if (!row) {
    res.status(404).json({ error: "Image not found" });
    return;
  }

  const storageKey = row.storageKey;
  if (!storageKey) {
    res.status(404).json({ error: "Image file not available" });
    return;
  }

  // Security: only serve from the OS temp directory to prevent path traversal
  const sysTmpDir = tmpdir();
  if (!storageKey.startsWith(sysTmpDir)) {
    logger.warn({ imageId, storageKey }, "image-gen: /file storageKey outside tmpdir — rejected");
    res.status(403).json({ error: "File not accessible" });
    return;
  }

  try {
    const buffer = await readFile(storageKey);
    res.set("Content-Type", "image/webp");
    res.set("Cache-Control", "private, max-age=3600");
    res.send(buffer);
  } catch (err) {
    logger.warn({ err, imageId, storageKey }, "image-gen: /file read failed");
    res.status(404).json({ error: "Image file not found on disk" });
  }
});

// ── DELETE /images/:id ────────────────────────────────────────────────────────
router.delete("/images/:id", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const imageId = Number(req.params.id);
  if (!Number.isFinite(imageId)) {
    res.status(400).json({ error: "Invalid image id" });
    return;
  }

  const [existing] = await db
    .select({ id: generatedImagesTable.id })
    .from(generatedImagesTable)
    .where(
      and(
        eq(generatedImagesTable.id, imageId),
        eq(generatedImagesTable.userId, userId),
        isNull(generatedImagesTable.deletedAt),
      ),
    );

  if (!existing) {
    res.status(404).json({ error: "Image not found" });
    return;
  }

  await db
    .update(generatedImagesTable)
    .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(generatedImagesTable.id, imageId));

  res.json({ success: true });
});

export default router;
