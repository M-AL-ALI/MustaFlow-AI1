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
import { createHash } from "node:crypto";
import { Router, type IRouter, type Response } from "express";
import multer from "multer";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import sharp from "sharp";
import { assetStorageObjectsTable, assetUsageTable, db, generatedImagesTable } from "@workspace/db";
import { EnqueueImageGenerationBody } from "@workspace/api-zod";
import { isImageProviderConfigured } from "../lib/image-provider";
import {
  enqueueImageJob,
  getJob,
  preflightImageJobs,
  enqueueImageEditJob,
} from "../lib/image-generation-jobs";
import {
  deleteStoredImageObjects,
  getImageBuffer,
  storeUploadedImage,
  type StoredImageObject,
} from "../lib/image-storage";
import { IMAGE_CREDIT_COSTS } from "./image-credits";
import { logger } from "../lib/logger";
import { presentPrivateImage } from "../lib/image-presentation";
import { checkProjectAccess } from "../lib/auth";
import { resolveTierForUser } from "../lib/public-ai/authed-user";
import { consumeOraQuota, refundOraQuota } from "../lib/public-ai/ora-usage";
import { requireActiveProjectLifecycleFor } from "../lib/project-lifecycle";
import {
  AssetAdmissionError,
  beginAssetUpload,
  completeAsset,
  deleteReadyAsset,
  recordAssetDeleted,
  rejectReservedAsset,
  reserveAsset,
} from "../lib/asset-registry";
import { deleteTrackedAssetStorageObjects } from "../lib/asset-storage-cleanup";

const router: IRouter = Router();

// ── Multer for image uploads ──────────────────────────────────────────────────

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_DIMENSION_PX = 4096;

async function admitGeneratedImageProjectLifecycle(
  projectId: number | null,
  res: Response,
): Promise<boolean> {
  if (projectId === null) return true;
  let admitted = false;
  await requireActiveProjectLifecycleFor(projectId, res, () => {
    admitted = true;
  });
  return admitted;
}

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

  if (
    typeof projectId === "number" &&
    (await checkProjectAccess(userId, projectId, "member")) !== "granted"
  ) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  if (typeof projectId === "number") {
    let admitted = false;
    await requireActiveProjectLifecycleFor(projectId, res, () => {
      admitted = true;
    });
    if (!admitted) return;
  }

  if (!isImageProviderConfigured()) {
    res.status(503).json({
      error: "Image generation is not configured. Set OPENAI_IMAGE_API_KEY or OPENAI_API_KEY.",
    });
    return;
  }

  const safeVariationCount = variationCount;
  const imageUser = await resolveTierForUser(userId);

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
    subscriptionTier: imageUser.tier,
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

    let imageId: number | null = null;
    let reservation: Awaited<ReturnType<typeof reserveAsset>> | null = null;
    let storedObjects: StoredImageObject[] = [];
    let completionCommitted = false;
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

      imageId = imageRow.id;

      reservation = await reserveAsset({
        ownerUserId: userId,
        actorUserId: userId,
        projectId: null,
        threadKey: null,
        scope: "account",
        kind: "image",
        source: "image-studio-upload",
        filename: file.originalname || `uploaded-${imageId}.webp`,
        mimeType: "image/webp",
        sizeBytes: webpBuffer.length + Math.min(file.buffer.length, 512 * 1024),
        context: { generatedImageId: imageId },
      });
      const claim = await beginAssetUpload({ assetId: reservation.id, actorUserId: userId });
      if (!claim) throw new Error("Image upload reservation is unavailable");

      // Store to R2 (or dev tmpdir)
      const { fileUrl, thumbnailUrl, storageKey, storageObjects } = await storeUploadedImage(
        webpBuffer,
        file.buffer,
        imageId,
        { assetId: reservation.id, ownerUserId: userId, actorUserId: userId },
      );
      storedObjects = storageObjects;
      if (!storageKey) throw new Error("Image upload storage was not durable");
      await completeAsset({
        assetId: reservation.id,
        ownerUserId: userId,
        actorUserId: userId,
        sha256: createHash("sha256").update(webpBuffer).digest("hex"),
        scanState: "not-required",
        finalSizeBytes: webpBuffer.length,
        finalMimeType: "image/webp",
        finalStorageKey: storageKey,
        generatedImage: {
          imageId,
          fileUrl,
          thumbnailUrl,
          storageKey,
        },
      });
      completionCommitted = true;

      const [updated] = await db
        .select()
        .from(generatedImagesTable)
        .where(eq(generatedImagesTable.id, imageId));

      logger.info({ imageId, userId }, "image-gen: upload stored");

      res.status(201).json({
        imageId,
        fileUrl: `/api/images/${imageId}/file`,
        thumbnailUrl: `/api/images/${imageId}/file?role=thumbnail`,
        creditCost: 0,
        image: presentPrivateImage(updated),
      });
    } catch (err) {
      if (!completionCommitted && storedObjects.length > 0) {
        await deleteStoredImageObjects(storedObjects).catch((cleanupError: unknown) => {
          logger.warn(
            {
              imageId,
              errorClass: cleanupError instanceof Error ? cleanupError.name : "unknown",
            },
            "image-gen: uploaded image cleanup remains pending",
          );
        });
      }
      if (!completionCommitted && reservation) {
        await rejectReservedAsset({
          assetId: reservation.id,
          ownerUserId: userId,
          actorUserId: userId,
          code: "asset_storage_unavailable",
        }).catch((cleanupError: unknown) => {
          logger.error(
            {
              imageId,
              errorClass: cleanupError instanceof Error ? cleanupError.name : "unknown",
            },
            "image-gen: upload reservation cleanup failed",
          );
        });
      }
      if (!completionCommitted && imageId !== null) {
        await db
          .update(generatedImagesTable)
          .set({ status: "failed", errorMessage: "Upload failed", updatedAt: sql`now()` })
          .where(eq(generatedImagesTable.id, imageId));
      }
      logger.warn({ err }, "image-gen: unexpected error in /images/upload");
      if (err instanceof AssetAdmissionError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
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
    fileUrl: job.status === "completed" ? `/api/images/${job.imageId}/file` : null,
    thumbnailUrl:
      job.status === "completed" ? `/api/images/${job.imageId}/file?role=thumbnail` : null,
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
      assetId: generatedImagesTable.assetId,
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
    images: rows.map(presentPrivateImage),
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

  res.json(presentPrivateImage(row));
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
      assetId: generatedImagesTable.assetId,
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

  const requestedRole = req.query.role === "thumbnail" ? "thumbnail" : "primary";
  const [trackedObject] =
    row.assetId === null
      ? []
      : await db
          .select({ storageKey: assetStorageObjectsTable.storageKey })
          .from(assetStorageObjectsTable)
          .where(
            and(
              eq(assetStorageObjectsTable.assetId, row.assetId),
              eq(assetStorageObjectsTable.role, requestedRole),
              eq(assetStorageObjectsTable.state, "ready"),
            ),
          )
          .limit(1);
  const storageKey =
    trackedObject?.storageKey ?? (requestedRole === "primary" ? row.storageKey : null);
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
    res.set("Cache-Control", "private, no-store");
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
  /**
   * Ora project space the edited result should be filed under in the Ora
   * library. Only honored on Ora-origin edits and only when the caller owns
   * the (non-archived) project; anything else degrades to the Personal space.
   */
  oraProjectId: z.number().int().positive().nullable().optional(),
});

router.post("/images/:id/edit", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
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

  const { instruction, quality, projectId, origin, oraProjectId } = parsed.data;
  const isOraEdit = origin === "ora";

  if (
    typeof projectId === "number" &&
    (await checkProjectAccess(userId, projectId, "member")) !== "granted"
  ) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  if (typeof projectId === "number") {
    let admitted = false;
    await requireActiveProjectLifecycleFor(projectId, res, () => {
      admitted = true;
    });
    if (!admitted) return;
  }

  if (!isImageProviderConfigured()) {
    res.status(503).json({
      error: "Image editing is not configured. Set OPENAI_IMAGE_API_KEY or OPENAI_API_KEY.",
    });
    return;
  }

  // Resolve the Ora project the edited result should be filed under. Invalid,
  // foreign, or archived projects silently degrade to Personal (null) — the
  // edit itself must never fail because of a stale project selection.
  let oraLibraryProjectId: number | null = null;
  if (isOraEdit && typeof oraProjectId === "number") {
    const { isOwnedActiveOraProject } = await import("../lib/public-ai/ora-projects");
    oraLibraryProjectId = (await isOwnedActiveOraProject(userId, oraProjectId))
      ? oraProjectId
      : null;
  }

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

  // Ownership is proven before consulting lifecycle state. A foreign image
  // therefore remains indistinguishable from a missing one and cannot trigger
  // project/provider work.
  if (!(await admitGeneratedImageProjectLifecycle(parent.projectId, res))) return;

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
  let oraTier: string | null = null;
  try {
    if (isOraEdit) {
      const oraUser = await resolveTierForUser(userId);
      oraTier = oraUser.tier;
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
      quality: isOraEdit ? undefined : quality,
      projectId,
      subscriptionTier: isOraEdit ? oraTier : undefined,
      billingMode: isOraEdit ? "ora" : "credits",
      oraProjectId: oraLibraryProjectId,
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
    .select({
      id: generatedImagesTable.id,
      assetId: generatedImagesTable.assetId,
      projectId: generatedImagesTable.projectId,
    })
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

  if (!(await admitGeneratedImageProjectLifecycle(existing.projectId, res))) return;

  const softDeleteGeneratedImage = async (): Promise<void> => {
    await db.transaction(async (tx) => {
      const removed = await tx
        .update(generatedImagesTable)
        .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
        .where(
          and(
            eq(generatedImagesTable.id, imageId),
            eq(generatedImagesTable.userId, userId),
            isNull(generatedImagesTable.deletedAt),
          ),
        )
        .returning({ id: generatedImagesTable.id });
      if (removed.length !== 1) throw new Error("image_delete_claim_lost");
      await tx
        .delete(assetUsageTable)
        .where(eq(assetUsageTable.consumer, `generated-image:${imageId}`));
    });
  };

  if (existing.assetId !== null) {
    try {
      // Claim the logical asset first. If this step fails, the gallery row is
      // untouched and the exact same delete remains retryable.
      const pending = await deleteReadyAsset({
        assetId: existing.assetId,
        userId,
        generatedImageIdBeingDeleted: imageId,
      });
      await softDeleteGeneratedImage();
      try {
        await deleteTrackedAssetStorageObjects(pending.storageObjects);
      } catch (error) {
        logger.warn(
          {
            imageId,
            assetId: existing.assetId,
            errorClass: error instanceof Error ? error.name : "unknown",
          },
          "image-gen: deleted image storage cleanup remains pending",
        );
        res.status(202).json({ success: true, storageCleanup: "pending" });
        return;
      }
      await recordAssetDeleted({
        assetId: existing.assetId,
        userId,
        sizeBytes: pending.sizeBytes,
      });
    } catch (error) {
      if (!(error instanceof AssetAdmissionError) || error.code !== "asset_referenced") {
        throw error;
      }
      // The image disappeared from the library, but another durable project or
      // history receipt still owns its bytes.  Keeping those bytes is required.
      await softDeleteGeneratedImage();
      res.json({ success: true, storageCleanup: "retained-while-referenced" });
      return;
    }
  } else {
    await softDeleteGeneratedImage();
  }

  res.json({ success: true, storageCleanup: "complete" });
});

export default router;
