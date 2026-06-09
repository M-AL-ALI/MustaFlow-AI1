/**
 * Image Studio API routes — Phase 9A-1 / Phase 9A-2.
 *
 * Routes:
 *   POST   /images/generate         — enqueue async image generation (variationCount 1/2/4)
 *   POST   /images/upload           — upload a user image (free, MIME + dimension validation)
 *   GET    /images/status/:jobId    — poll job status (pending→generating→completed|failed)
 *   GET    /images                  — list user's generated images (paginated, optional projectId filter)
 *   GET    /images/:id              — get a single generated image
 *   GET    /images/:id/file         — serve dev-mode tmpdir file
 *   POST   /images/:id/edit         — edit an existing image with AI
 *   DELETE /images/:id              — soft-delete an image
 *
 * All routes require authentication (mounted after the auth wall in index.ts).
 * ISOLATION: this file MUST NOT import from builder.ts or any pipeline module.
 */
import { Router, type IRouter } from "express";
import multer from "multer";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import sharp from "sharp";
import { db, generatedImagesTable } from "@workspace/db";
import { EnqueueImageGenerationBody } from "@workspace/api-zod";
import { isImageProviderConfigured } from "../lib/image-provider";
import {
  enqueueImageJob,
  getJob,
  preflightImageJobs,
  enqueueImageEditJob,
} from "../lib/image-generation-jobs";
import { storeUploadedImage, getImageBuffer } from "../lib/image-storage";
import { IMAGE_CREDIT_COSTS } from "./image-credits";
import { logger } from "../lib/logger";
import { resolveTierForUser } from "../lib/public-ai/authed-user";
import { consumeOraQuota, refundOraQuota } from "../lib/public-ai/ora-usage";

const router: IRouter = Router();

// ── Multer for image uploads ──────────────────────────────────────────────────

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_DIMENSION_PX = 4096;

const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        Object.assign(new Error("Unsupported file type. Allowed: JPEG, PNG, WebP"), {
          code: "UNSUPPORTED_FILE_TYPE",
        }),
      );
    }
  },
});

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
    const e = err as {
      code?: string;
      message?: string;
      balance?: number;
      category?: string;
      cap?: number;
      used?: number;
      tier?: string;
    };
    if (e.code === "INSUFFICIENT_CREDITS") {
      res.status(402).json({ error: "Insufficient credits", balance: e.balance });
      return;
    }
    if (e.code === "MONTHLY_CAP_REACHED") {
      res.status(429).json({
        error: e.message ?? "Monthly image limit reached",
        upgradeCta: true,
        cap: e.cap,
        used: e.used,
        tier: e.tier,
      });
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

// ── POST /images/upload ───────────────────────────────────────────────────────
router.post(
  "/images/upload",
  (req, res, next) => {
    uploadMiddleware.single("image")(req, res, (err) => {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: "File too large. Maximum size is 10 MB." });
        return;
      }
      if (err instanceof Error && (err as { code?: string }).code === "UNSUPPORTED_FILE_TYPE") {
        res.status(415).json({ error: err.message });
        return;
      }
      if (err) {
        res.status(400).json({ error: "Upload failed" });
        return;
      }
      next();
    });
  },
  async (req, res): Promise<void> => {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    const file = req.file;
    if (!file) {
      res.status(400).json({
        error:
          "No image file provided. Send a multipart/form-data request with field name 'image'.",
      });
      return;
    }

    try {
      // Validate dimensions using sharp (also strips EXIF automatically on re-encode)
      let metadata: sharp.Metadata;
      try {
        metadata = await sharp(file.buffer).metadata();
      } catch {
        res.status(422).json({ error: "Could not read image. Please upload a valid image file." });
        return;
      }

      const { width = 0, height = 0 } = metadata;
      if (width > MAX_DIMENSION_PX || height > MAX_DIMENSION_PX) {
        res.status(422).json({
          error: `Image too large. Maximum dimensions are ${MAX_DIMENSION_PX}×${MAX_DIMENSION_PX}px.`,
        });
        return;
      }
      if (width < 1 || height < 1) {
        res.status(422).json({ error: "Could not determine image dimensions." });
        return;
      }

      // Convert to WebP (also strips EXIF)
      const webpBuffer = await sharp(file.buffer).webp({ quality: 85 }).toBuffer();

      // Create the DB record first to get an imageId
      const [imageRow] = await db
        .insert(generatedImagesTable)
        .values({
          userId,
          prompt: "[uploaded]",
          quality: "standard",
          aspectRatio: width >= height ? (width / height > 1.3 ? "16:9" : "1:1") : "9:16",
          providerName: "upload",
          status: "pending",
          safetyStatus: "passed",
          creditCost: 0,
          sourceType: "uploaded",
        })
        .returning({ id: generatedImagesTable.id });

      if (!imageRow) {
        res.status(500).json({ error: "Failed to create image record" });
        return;
      }

      const imageId = imageRow.id;

      // Store to R2 (or dev tmpdir)
      const { fileUrl, thumbnailUrl, storageKey } = await storeUploadedImage(
        webpBuffer,
        file.buffer,
        imageId,
      );

      // Update DB to completed
      const [updated] = await db
        .update(generatedImagesTable)
        .set({
          status: "completed",
          fileUrl,
          thumbnailUrl,
          storageKey,
          updatedAt: sql`now()`,
        })
        .where(eq(generatedImagesTable.id, imageId))
        .returning();

      logger.info({ imageId, userId }, "image-gen: upload stored");

      res.status(201).json({
        imageId,
        fileUrl,
        thumbnailUrl,
        creditCost: 0,
        image: updated,
      });
    } catch (err) {
      logger.warn({ err }, "image-gen: unexpected error in /images/upload");
      res.status(500).json({ error: "Upload failed. Please try again." });
    }
  },
);

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
      parentImageId: generatedImagesTable.parentImageId,
      sourceType: generatedImagesTable.sourceType,
      editInstruction: generatedImagesTable.editInstruction,
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
      fileUrl: generatedImagesTable.fileUrl,
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
  const fileUrl = row.fileUrl;
  if (!storageKey && !fileUrl) {
    res.status(404).json({ error: "Image file not available" });
    return;
  }

  try {
    // getImageBuffer resolves the bytes from whichever backend holds them:
    // dev tmpdir (storageKey under tmpdir), R2 (authenticated GetObject), or a
    // public HTTPS URL. Serving through this authenticated route means the
    // browser never has to reach R2 directly — critical when R2 is configured
    // without a public URL (the stored fileUrl is then a private S3 endpoint
    // that an <img src> cannot load).
    const buffer = await getImageBuffer(storageKey, fileUrl ?? "");
    res.set("Content-Type", "image/webp");
    res.set("Cache-Control", "private, max-age=3600");
    res.send(buffer);
  } catch (err) {
    logger.warn({ err, imageId, storageKey }, "image-gen: /file read failed");
    res.status(404).json({ error: "Image file not found" });
  }
});

// ── POST /images/:id/edit ─────────────────────────────────────────────────────

const ImageEditBody = z.object({
  instruction: z.string().min(1).max(4000),
  quality: z.enum(["standard", "high"]).default("standard"),
  projectId: z.number().int().optional(),
  origin: z.enum(["image_studio", "ora"]).optional(),
});

router.post("/images/:id/edit", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  if (!isImageProviderConfigured()) {
    res.status(503).json({
      error: "Image editing is not configured. Set OPENAI_IMAGE_API_KEY or OPENAI_API_KEY.",
    });
    return;
  }

  const parentId = Number(req.params.id);
  if (!Number.isFinite(parentId)) {
    res.status(400).json({ error: "Invalid image id" });
    return;
  }

  const parsed = ImageEditBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { instruction, quality, projectId, origin } = parsed.data;
  const isOraEdit = origin === "ora";

  // Fetch parent image and verify ownership
  const [parent] = await db
    .select({
      id: generatedImagesTable.id,
      fileUrl: generatedImagesTable.fileUrl,
      storageKey: generatedImagesTable.storageKey,
      aspectRatio: generatedImagesTable.aspectRatio,
      status: generatedImagesTable.status,
      projectId: generatedImagesTable.projectId,
      creditCost: generatedImagesTable.creditCost,
      sourceType: generatedImagesTable.sourceType,
    })
    .from(generatedImagesTable)
    .where(
      and(
        eq(generatedImagesTable.id, parentId),
        eq(generatedImagesTable.userId, userId),
        isNull(generatedImagesTable.deletedAt),
      ),
    );

  if (!parent) {
    res.status(404).json({ error: "Image not found" });
    return;
  }

  if (parent.status !== "completed") {
    res.status(422).json({ error: "Cannot edit an image that is not completed." });
    return;
  }

  if (!parent.fileUrl) {
    res.status(422).json({ error: "Image has no file URL — cannot edit." });
    return;
  }

  if (
    isOraEdit &&
    (parent.projectId !== null ||
      parent.creditCost !== 0 ||
      (parent.sourceType !== "generated" && parent.sourceType !== "edited"))
  ) {
    res.status(403).json({ error: "This image is not eligible for Ora inline editing." });
    return;
  }

  let reservedOraImageQuota = false;
  let oraImageCount: number | undefined;
  let oraImageLimit: number | undefined;
  let oraResetsAt: string | null | undefined;
  try {
    if (isOraEdit) {
      const oraUser = await resolveTierForUser(userId);
      const quota = await consumeOraQuota(userId, oraUser.tier, "image");
      if (!quota.allowed) {
        res.status(429).json({
          error: `You've used all ${quota.limit} Ora images in your current window on your plan. Upgrade for a higher limit, or wait for your window to reset.`,
          upgradeCta: true,
          imageCount: quota.used,
          imageLimit: quota.limit,
          resetsAt: quota.resetsAt,
        });
        return;
      }
      reservedOraImageQuota = true;
      oraImageCount = quota.used;
      oraImageLimit = quota.limit;
      oraResetsAt = quota.resetsAt;
    }

    const { jobId, imageId } = await enqueueImageEditJob({
      userId,
      parentImageId: parentId,
      parentStorageKey: parent.storageKey,
      parentFileUrl: parent.fileUrl,
      parentAspectRatio: parent.aspectRatio,
      instruction: instruction.trim(),
      quality,
      projectId,
      billingMode: isOraEdit ? "ora" : "credits",
    });

    res.status(202).json({
      jobId,
      imageId,
      creditCost: isOraEdit ? 0 : (IMAGE_CREDIT_COSTS[quality] ?? 3),
      status: "pending",
      ...(isOraEdit
        ? { imageCount: oraImageCount, imageLimit: oraImageLimit, resetsAt: oraResetsAt }
        : {}),
    });
  } catch (err) {
    if (reservedOraImageQuota) await refundOraQuota(userId, "image");
    const e = err as {
      code?: string;
      message?: string;
      balance?: number;
      category?: string;
      cap?: number;
      used?: number;
      tier?: string;
    };
    if (e.code === "INSUFFICIENT_CREDITS") {
      res.status(402).json({ error: "Insufficient credits", balance: e.balance });
      return;
    }
    if (e.code === "MONTHLY_CAP_REACHED") {
      res.status(429).json({
        error: e.message ?? "Monthly image limit reached",
        upgradeCta: true,
        cap: e.cap,
        used: e.used,
        tier: e.tier,
      });
      return;
    }
    if (e.code === "SAFETY_BLOCKED") {
      res
        .status(422)
        .json({ error: e.message ?? "Instruction failed safety check", category: e.category });
      return;
    }
    logger.warn({ err }, "image-gen: unexpected error in /images/:id/edit");
    res.status(500).json({ error: "Image edit failed. Please try again." });
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
