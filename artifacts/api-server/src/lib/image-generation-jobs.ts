/**
 * Image generation job service — Phase 9A-1.
 *
 * In-process async job queue for image generation. Each job:
 *   1. Safety check (zero cost, zero provider call)
 *   2. Rate-limit check (hourly + daily, zero cost)
 *   3. Creates DB row (status=pending)
 *   4. Deducts credits atomically
 *   5. Calls the image provider
 *   6. Stores the result (R2 or dev fallback)
 *   7. Updates DB row (completed | failed)
 *   8. Refunds credits on failure
 *
 * ISOLATION: this file MUST NOT import from builder.ts or any pipeline module.
 */
import { randomUUID } from "node:crypto";
import { and, count, eq, gte, isNull, sql } from "drizzle-orm";
import {
  db,
  generatedImagesTable,
  userCreditsTable,
  userSubscriptionsTable,
  TIER_MONTHLY_IMAGE_CAP,
  type SubscriptionTier,
} from "@workspace/db";
import {
  generateImage,
  editImage,
  type ImageAspectRatio,
  type ImageQuality,
  type ImageStyle,
} from "./image-provider";
import { validateImagePrompt } from "./image-safety";
import { storeGeneratedImage, storeEditedImage, getImageBuffer } from "./image-storage";
import {
  deductCreditsAtomic,
  refundCredits,
  IMAGE_CREDIT_COSTS,
  IMAGE_RATE_LIMIT_PER_HOUR,
  IMAGE_DAILY_LIMIT,
} from "../routes/image-credits";
import { CREDITS_ENFORCEMENT_ENABLED } from "../routes/credits";
import { logger } from "./logger";

export type JobStatus = "pending" | "generating" | "completed" | "failed";

export interface ImageJob {
  jobId: string;
  imageId: number;
  userId: string;
  status: JobStatus;
  fileUrl?: string;
  thumbnailUrl?: string;
  error?: string;
  createdAt: Date;
}

const jobs = new Map<string, ImageJob>();

// Prune completed/failed jobs older than 1 hour to prevent unbounded growth
const JOB_TTL_MS = 60 * 60 * 1000;
setInterval(
  () => {
    const cutoff = Date.now() - JOB_TTL_MS;
    for (const [id, job] of jobs) {
      if (
        (job.status === "completed" || job.status === "failed") &&
        job.createdAt.getTime() < cutoff
      ) {
        jobs.delete(id);
      }
    }
  },
  10 * 60 * 1000,
).unref();

export interface EnqueueImageJobOpts {
  userId: string;
  prompt: string;
  negativePrompt?: string;
  purpose?: string;
  quality?: ImageQuality;
  aspectRatio?: ImageAspectRatio;
  style?: ImageStyle;
  transparentBackground?: boolean;
  projectId?: number;
  /**
   * When true, the completed image is also copied into the signed-in user's
   * durable Ora asset library (best-effort, after the DB row is finalized).
   * Set only for Ora-chat-originated generations — NOT for Image Studio, which
   * has its own gallery backed by `generated_images`.
   */
  persistToOraLibrary?: boolean;
}

export function getJob(jobId: string): ImageJob | undefined {
  return jobs.get(jobId);
}

/**
 * Atomic preflight check for multi-variation image generation.
 *
 * Validates rate limits and credit balance for `count` jobs at once BEFORE
 * any job is inserted or credits are deducted. This prevents partial enqueue
 * (e.g. first variation deducts credits, second fails → half-done state).
 *
 * Callers MUST call this before Promise.all([enqueueImageJob, …]) when count > 1.
 */
/**
 * Resolve the user's active subscription tier (defaults to "free" when no
 * active subscription row exists). Used to enforce the monthly image cap.
 */
async function resolveImageTier(userId: string): Promise<SubscriptionTier> {
  try {
    const [sub] = await db
      .select({ tier: userSubscriptionsTable.tier, status: userSubscriptionsTable.status })
      .from(userSubscriptionsTable)
      .where(eq(userSubscriptionsTable.userId, userId));
    const activeStatuses = new Set(["active", "trialing", "grace_period"]);
    if (sub && activeStatuses.has(sub.status) && sub.tier in TIER_MONTHLY_IMAGE_CAP) {
      return sub.tier as SubscriptionTier;
    }
  } catch {
    // user_subscriptions may be unavailable — fall back to the free cap.
  }
  return "free";
}

/**
 * Enforce the per-tier monthly image-generation cap (calendar month).
 * Throws a MONTHLY_CAP_REACHED error when generating `jobCount` more images
 * would exceed the user's tier allowance.
 */
export async function enforceMonthlyImageCap(userId: string, jobCount: number): Promise<void> {
  const tier = await resolveImageTier(userId);
  const cap = TIER_MONTHLY_IMAGE_CAP[tier];
  const [monthlyResult] = await db
    .select({ c: count() })
    .from(generatedImagesTable)
    .where(
      and(
        eq(generatedImagesTable.userId, userId),
        gte(generatedImagesTable.createdAt, sql`date_trunc('month', now())`),
        isNull(generatedImagesTable.deletedAt),
      ),
    );
  const used = monthlyResult?.c ?? 0;
  if (used + jobCount > cap) {
    throw Object.assign(
      new Error(
        `You've used ${used} of your ${cap} monthly AI images on the ${tier} plan. Upgrade your plan for a higher monthly image allowance.`,
      ),
      { code: "MONTHLY_CAP_REACHED", scope: "monthly", used, cap, tier, upgradeCta: true },
    );
  }
}

export async function preflightImageJobs(
  userId: string,
  jobCount: number,
  quality: string,
): Promise<void> {
  const creditCostPer = IMAGE_CREDIT_COSTS[quality] ?? 3;
  const totalCost = creditCostPer * jobCount;

  // Monthly per-tier cap (calendar month) — checked first so the message is clear.
  await enforceMonthlyImageCap(userId, jobCount);

  // Rate-limit: hourly — ensure existing + new count stays within the limit
  const [hourlyResult] = await db
    .select({ c: count() })
    .from(generatedImagesTable)
    .where(
      and(
        eq(generatedImagesTable.userId, userId),
        gte(generatedImagesTable.createdAt, sql`now() - interval '1 hour'`),
        isNull(generatedImagesTable.deletedAt),
      ),
    );
  if ((hourlyResult?.c ?? 0) + jobCount > IMAGE_RATE_LIMIT_PER_HOUR) {
    throw Object.assign(
      new Error(
        `Generating ${jobCount} image${jobCount > 1 ? "s" : ""} would exceed your hourly limit. Try again later.`,
      ),
      { code: "RATE_LIMITED", retryAfter: 3600, scope: "hourly" },
    );
  }

  // Rate-limit: daily
  const [dailyResult] = await db
    .select({ c: count() })
    .from(generatedImagesTable)
    .where(
      and(
        eq(generatedImagesTable.userId, userId),
        gte(generatedImagesTable.createdAt, sql`now() - interval '24 hours'`),
        isNull(generatedImagesTable.deletedAt),
      ),
    );
  if ((dailyResult?.c ?? 0) + jobCount > IMAGE_DAILY_LIMIT) {
    throw Object.assign(
      new Error(
        `Generating ${jobCount} image${jobCount > 1 ? "s" : ""} would exceed your daily limit. Try again tomorrow.`,
      ),
      { code: "RATE_LIMITED", retryAfter: 86400, scope: "daily" },
    );
  }

  // Credit balance: user must have enough for ALL variations upfront
  const [creditRow] = await db
    .select({ balance: userCreditsTable.balance })
    .from(userCreditsTable)
    .where(eq(userCreditsTable.userId, userId));
  const balance = creditRow?.balance ?? 0;
  if (balance < totalCost) {
    throw Object.assign(
      new Error(
        `Insufficient credits: need ${totalCost} (${jobCount} × ${creditCostPer}) but have ${balance}.`,
      ),
      { code: "INSUFFICIENT_CREDITS", balance, required: totalCost },
    );
  }
}

export async function enqueueImageJob(
  opts: EnqueueImageJobOpts,
): Promise<{ jobId: string; imageId: number }> {
  const {
    userId,
    prompt,
    negativePrompt,
    purpose,
    quality = "standard",
    aspectRatio = "1:1",
    style = "vivid",
    transparentBackground = false,
    projectId,
  } = opts;

  // Step 1: Safety check — zero cost, no provider call
  const safetyResult = validateImagePrompt(prompt);
  if (!safetyResult.safe) {
    throw Object.assign(new Error(safetyResult.reason ?? "Prompt failed safety check"), {
      code: "SAFETY_BLOCKED",
      category: safetyResult.category,
    });
  }

  // Step 2: Monthly per-tier cap + rate-limit check — zero cost
  await enforceMonthlyImageCap(userId, 1);

  const [hourlyResult] = await db
    .select({ c: count() })
    .from(generatedImagesTable)
    .where(
      and(
        eq(generatedImagesTable.userId, userId),
        gte(generatedImagesTable.createdAt, sql`now() - interval '1 hour'`),
        isNull(generatedImagesTable.deletedAt),
      ),
    );
  if ((hourlyResult?.c ?? 0) >= IMAGE_RATE_LIMIT_PER_HOUR) {
    throw Object.assign(new Error("Hourly image generation limit reached. Try again later."), {
      code: "RATE_LIMITED",
      retryAfter: 3600,
      scope: "hourly",
    });
  }

  const [dailyResult] = await db
    .select({ c: count() })
    .from(generatedImagesTable)
    .where(
      and(
        eq(generatedImagesTable.userId, userId),
        gte(generatedImagesTable.createdAt, sql`now() - interval '24 hours'`),
        isNull(generatedImagesTable.deletedAt),
      ),
    );
  if ((dailyResult?.c ?? 0) >= IMAGE_DAILY_LIMIT) {
    throw Object.assign(new Error("Daily image generation limit reached. Try again tomorrow."), {
      code: "RATE_LIMITED",
      retryAfter: 86400,
      scope: "daily",
    });
  }

  // Step 3: Resolve provider / model info
  const providerName = "openai";
  const modelName = process.env.IMAGE_MODEL ?? "gpt-image-1";
  const creditCost = IMAGE_CREDIT_COSTS[quality] ?? 3;

  // Step 4: Create DB row with status=pending
  const [imageRow] = await db
    .insert(generatedImagesTable)
    .values({
      userId,
      projectId: projectId ?? null,
      prompt,
      negativePrompt: negativePrompt ?? null,
      purpose: purpose ?? null,
      quality,
      aspectRatio,
      style: style ?? null,
      transparentBackground,
      providerName,
      modelName,
      status: "pending",
      safetyStatus: "passed",
      creditCost,
    })
    .returning({ id: generatedImagesTable.id });

  if (!imageRow) {
    throw new Error("Failed to create image record");
  }

  const imageId = imageRow.id;

  // Step 5: Deduct credits atomically
  const deduction = await deductCreditsAtomic(userId, creditCost, {
    type: "creative",
    description: `Image generation (${quality} quality) — image #${imageId}`,
  });

  if ("insufficient" in deduction) {
    await db
      .update(generatedImagesTable)
      .set({
        status: "failed",
        errorMessage: "Insufficient credits",
        errorCategory: "credits",
        updatedAt: sql`now()`,
      })
      .where(eq(generatedImagesTable.id, imageId));
    throw Object.assign(new Error("Insufficient credits for image generation"), {
      code: "INSUFFICIENT_CREDITS",
      balance: deduction.balance,
    });
  }

  const jobId = randomUUID();
  const job: ImageJob = {
    jobId,
    imageId,
    userId,
    status: "pending",
    createdAt: new Date(),
  };
  jobs.set(jobId, job);

  // Kick off background processing (fire-and-forget, errors handled internally).
  // creditsWereDeducted is false when CREDITS_ENFORCEMENT_ENABLED is off so that
  // refundCredits is not called unconditionally (which would create free credits).
  void runImageJob(job, opts, creditCost, CREDITS_ENFORCEMENT_ENABLED);

  return { jobId, imageId };
}

// ── Image edit job ────────────────────────────────────────────────────────────

export interface EnqueueImageEditJobOpts {
  userId: string;
  parentImageId: number;
  parentStorageKey: string | null;
  parentFileUrl: string;
  parentAspectRatio: string;
  instruction: string;
  quality?: ImageQuality;
  projectId?: number;
  /** Image Studio edits use credits; Ora inline edits use Ora's daily image quota. */
  billingMode?: "credits" | "ora";
}

export async function enqueueImageEditJob(
  opts: EnqueueImageEditJobOpts,
): Promise<{ jobId: string; imageId: number }> {
  const {
    userId,
    parentImageId,
    instruction,
    quality = "standard",
    parentAspectRatio,
    projectId,
    billingMode = "credits",
  } = opts;

  // Safety check on instruction text
  const safetyResult = validateImagePrompt(instruction);
  if (!safetyResult.safe) {
    throw Object.assign(new Error(safetyResult.reason ?? "Instruction failed safety check"), {
      code: "SAFETY_BLOCKED",
      category: safetyResult.category,
    });
  }

  const creditCost = billingMode === "ora" ? 0 : (IMAGE_CREDIT_COSTS[quality] ?? 3);
  const providerName = "openai";
  const modelName = process.env.IMAGE_MODEL ?? "gpt-image-1";

  // Create DB row with status=pending
  const [imageRow] = await db
    .insert(generatedImagesTable)
    .values({
      userId,
      projectId: projectId ?? null,
      prompt: instruction,
      quality,
      aspectRatio: (parentAspectRatio as ImageAspectRatio) ?? "1:1",
      providerName,
      modelName,
      status: "pending",
      safetyStatus: "passed",
      creditCost,
      parentImageId,
      sourceType: "edited",
      editInstruction: instruction,
    })
    .returning({ id: generatedImagesTable.id });

  if (!imageRow) throw new Error("Failed to create edit image record");
  const imageId = imageRow.id;

  if (billingMode === "credits") {
    // Deduct credits atomically
    const deduction = await deductCreditsAtomic(userId, creditCost, {
      type: "creative",
      description: `Image edit (${quality} quality) — image #${imageId}`,
    });

    if ("insufficient" in deduction) {
      await db
        .update(generatedImagesTable)
        .set({
          status: "failed",
          errorMessage: "Insufficient credits",
          errorCategory: "credits",
          updatedAt: sql`now()`,
        })
        .where(eq(generatedImagesTable.id, imageId));
      throw Object.assign(new Error("Insufficient credits for image editing"), {
        code: "INSUFFICIENT_CREDITS",
        balance: deduction.balance,
      });
    }
  }

  const jobId = randomUUID();
  const job: ImageJob = {
    jobId,
    imageId,
    userId,
    status: "pending",
    createdAt: new Date(),
  };
  jobs.set(jobId, job);

  void runImageEditJob(
    job,
    opts,
    creditCost,
    billingMode === "credits" && CREDITS_ENFORCEMENT_ENABLED,
  );

  return { jobId, imageId };
}

async function runImageEditJob(
  job: ImageJob,
  opts: EnqueueImageEditJobOpts,
  creditCost: number,
  creditsWereDeducted: boolean,
): Promise<void> {
  const { jobId, imageId, userId } = job;
  const {
    parentStorageKey,
    parentFileUrl,
    instruction,
    quality = "standard",
    parentAspectRatio,
  } = opts;

  try {
    job.status = "generating";
    await db
      .update(generatedImagesTable)
      .set({ status: "generating", updatedAt: sql`now()` })
      .where(eq(generatedImagesTable.id, imageId));

    logger.info({ jobId, imageId, quality }, "image-jobs: fetching source image for edit");

    const imageBuffer = await getImageBuffer(parentStorageKey, parentFileUrl);

    logger.info({ jobId, imageId }, "image-jobs: calling edit provider");

    const result = await editImage({
      imageBuffer,
      instruction,
      quality,
      aspectRatio: (parentAspectRatio as ImageAspectRatio) ?? "1:1",
    });

    logger.info({ jobId, imageId }, "image-jobs: storing edit result");

    const { fileUrl, thumbnailUrl, storageKey } = await storeEditedImage(result.openaiUrl, imageId);

    await db
      .update(generatedImagesTable)
      .set({
        status: "completed",
        fileUrl,
        thumbnailUrl,
        storageKey,
        revisedPrompt: result.revisedPrompt,
        updatedAt: sql`now()`,
      })
      .where(eq(generatedImagesTable.id, imageId));

    job.status = "completed";
    job.fileUrl = fileUrl;
    job.thumbnailUrl = thumbnailUrl ?? undefined;

    logger.info({ jobId, imageId }, "image-jobs: edit completed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ jobId, imageId, err }, "image-jobs: edit job failed, refunding credits");

    const errorCategory =
      err instanceof Error && "code" in err
        ? String((err as { code?: string }).code)
        : "provider_error";

    await db
      .update(generatedImagesTable)
      .set({
        status: "failed",
        errorMessage: message,
        errorCategory,
        updatedAt: sql`now()`,
      })
      .where(eq(generatedImagesTable.id, imageId));

    if (creditsWereDeducted) {
      await refundCredits(userId, creditCost, {
        description: `Image edit failed — image #${imageId}: ${message.slice(0, 100)}`,
      });
    }

    job.status = "failed";
    job.error = message;
  }
}

async function runImageJob(
  job: ImageJob,
  opts: EnqueueImageJobOpts,
  creditCost: number,
  creditsWereDeducted: boolean,
): Promise<void> {
  const { jobId, imageId, userId } = job;
  const {
    prompt,
    negativePrompt,
    quality = "standard",
    aspectRatio = "1:1",
    style = "vivid",
    transparentBackground = false,
  } = opts;

  try {
    // Mark as generating
    job.status = "generating";
    await db
      .update(generatedImagesTable)
      .set({ status: "generating", updatedAt: sql`now()` })
      .where(eq(generatedImagesTable.id, imageId));

    logger.info({ jobId, imageId, quality, aspectRatio }, "image-jobs: calling provider");

    // Build the final prompt (incorporate negative prompt as instruction)
    const finalPrompt = negativePrompt?.trim()
      ? `${prompt.trim()}. Do not include: ${negativePrompt.trim()}.`
      : prompt;

    const result = await generateImage({
      prompt: finalPrompt,
      quality,
      aspectRatio,
      style,
      transparentBackground,
    });

    logger.info({ jobId, imageId }, "image-jobs: storing result");

    const { fileUrl, thumbnailUrl, storageKey } = await storeGeneratedImage(
      result.openaiUrl,
      imageId,
    );

    // Update DB — completed
    await db
      .update(generatedImagesTable)
      .set({
        status: "completed",
        fileUrl,
        thumbnailUrl,
        storageKey,
        revisedPrompt: result.revisedPrompt,
        updatedAt: sql`now()`,
      })
      .where(eq(generatedImagesTable.id, imageId));

    job.status = "completed";
    job.fileUrl = fileUrl;
    job.thumbnailUrl = thumbnailUrl ?? undefined;

    // Copy into the durable Ora asset library when requested (Ora-chat path).
    // Best-effort: never let a persist failure affect the job outcome.
    if (opts.persistToOraLibrary) {
      try {
        const buffer = await getImageBuffer(storageKey, fileUrl);
        const { persistOraAsset } = await import("./ora-assets");
        await persistOraAsset({
          userId,
          kind: "image",
          fileName: `ora-image-${Date.now()}.png`,
          mimeType: "image/png",
          format: "png",
          prompt,
          base64: buffer.toString("base64"),
        });
      } catch (persistErr) {
        logger.warn(
          { jobId, imageId, err: persistErr },
          "image-jobs: failed to persist image to Ora library",
        );
      }
    }

    logger.info({ jobId, imageId }, "image-jobs: completed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ jobId, imageId, err }, "image-jobs: job failed, refunding credits");

    const errorCategory =
      err instanceof Error && "code" in err
        ? String((err as { code?: string }).code)
        : "provider_error";

    await db
      .update(generatedImagesTable)
      .set({
        status: "failed",
        errorMessage: message,
        errorCategory,
        updatedAt: sql`now()`,
      })
      .where(eq(generatedImagesTable.id, imageId));

    if (creditsWereDeducted) {
      await refundCredits(userId, creditCost, {
        description: `Image generation failed — image #${imageId}: ${message.slice(0, 100)}`,
      });
    }

    job.status = "failed";
    job.error = message;
  }
}
