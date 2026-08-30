import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  assetsTable,
  assetAnalysisEventsTable,
  assetUsageTable,
  db,
  projectFilesTable,
  projectsTable,
  type AssetContext,
} from "@workspace/db";
import { checkProjectAccess, requireProjectAccess } from "../lib/auth";
import { findLiveSupportGrant } from "../lib/support-access";
import { analyzeAssetBuffer, MAX_INLINE_ASSET_ANALYSIS_BYTES } from "../lib/asset-analysis";
import { normalizeUploadedImage } from "../lib/asset-image-normalization";
import {
  createAssetAltTextEvent,
  enqueueAutomaticAssetAltText,
  runAssetAltTextAnalysis,
} from "../lib/asset-alt-text-analysis";
import {
  ASSET_DERIVATIVE_PRESETS,
  generateAssetDerivatives,
  type AssetDerivativePreset,
} from "../lib/asset-derivatives";
import { acceptsDeclaredAsset, ASSET_ERROR_MESSAGES, sniffAsset } from "../lib/asset-contract";
import {
  AssetAdmissionError,
  cancelReservedAsset,
  completeAsset,
  deleteReadyAsset,
  getQuota,
  recordAssetDeleted,
  rejectReservedAsset,
  reserveAsset,
} from "../lib/asset-registry";
import {
  assetR2Configured,
  deleteAssetObject,
  openAsset,
  putAssetBuffer,
  putAssetStream,
  readAssetBuffer,
} from "../lib/asset-r2";
import {
  ASSET_STORAGE_PLANS,
  createAssetStorageCheckout,
  isAssetStorageSku,
  listAssetStorageSubscriptions,
} from "../lib/asset-storage-billing";
import { requireStripe } from "../lib/nabuflow-stripe";
import { ensureStripeCustomer } from "./billing";
import { resolveArtifactId } from "../lib/artifacts";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const MAX_MATERIALIZED_ASSET_BYTES = 25 * 1024 * 1024;

async function mayReadProjectAssets(userId: string, projectId: number): Promise<boolean> {
  if ((await checkProjectAccess(userId, projectId, "viewer")) === "granted") return true;
  return (await findLiveSupportGrant({ projectId, staffUserId: userId })) !== null;
}

type MaterializableAsset = {
  id: number;
  filename: string;
  mimeType: string;
  bytes: Buffer;
};

function safeAssetPath(assetId: number, filename: string): string {
  const name = filename
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[-.]+/, "")
    .slice(0, 100);
  return `public/assets/${assetId}-${name || "asset"}`;
}

function requestedAssetPath(value: unknown, assetId: number, filename: string): string | null {
  if (value === undefined || value === null || value === "")
    return safeAssetPath(assetId, filename);
  if (typeof value !== "string") return null;
  const path = value.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (
    path.length < 1 ||
    path.length > 240 ||
    path.split("/").some((part) => part === ".." || part === "." || part.length === 0)
  ) {
    return null;
  }
  return path;
}

async function loadMaterializableAsset(input: {
  userId: string;
  projectId: number;
  assetId: number;
}): Promise<MaterializableAsset> {
  const [asset] = await db.select().from(assetsTable).where(eq(assetsTable.id, input.assetId));
  if (
    !asset ||
    asset.state !== "ready" ||
    asset.storageBackend !== "r2" ||
    (asset.ownerUserId !== input.userId && asset.projectId !== input.projectId)
  ) {
    throw new AssetAdmissionError("asset_not_found", 404);
  }
  if (asset.sizeBytes > MAX_MATERIALIZED_ASSET_BYTES) {
    throw new AssetAdmissionError(
      "asset_content_mismatch",
      413,
      "This file is too large to place directly in a project. Zero can still read it from the private library.",
    );
  }
  const bytes = await readAssetBuffer(asset.storageKey, MAX_MATERIALIZED_ASSET_BYTES);
  if (!bytes) throw new AssetAdmissionError("asset_storage_unavailable", 503);
  return { id: asset.id, filename: asset.filename, mimeType: asset.mimeType, bytes };
}

export async function materializeProjectAsset(input: {
  userId: string;
  projectId: number;
  assetId: number;
  path?: unknown;
}): Promise<{ path: string; src: string; assetId: number }> {
  const asset = await loadMaterializableAsset(input);
  const path = requestedAssetPath(input.path, asset.id, asset.filename);
  if (!path) {
    throw new AssetAdmissionError(
      "asset_content_mismatch",
      400,
      "Choose a safe project file path.",
    );
  }
  const artifactId = await resolveArtifactId(input.projectId, null);
  if (artifactId === null) {
    throw new AssetAdmissionError(
      "asset_content_mismatch",
      409,
      "This project needs a primary app before an asset can be placed in it.",
    );
  }
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: projectFilesTable.id })
      .from(projectFilesTable)
      .where(
        and(
          eq(projectFilesTable.projectId, input.projectId),
          eq(projectFilesTable.artifactId, artifactId),
          eq(projectFilesTable.path, path),
        ),
      );
    if (existing) {
      await tx
        .update(projectFilesTable)
        .set({
          content: asset.bytes.toString("base64"),
          mimeType: asset.mimeType,
          updatedAt: new Date(),
        })
        .where(eq(projectFilesTable.id, existing.id));
    } else {
      await tx.insert(projectFilesTable).values({
        projectId: input.projectId,
        artifactId,
        path,
        content: asset.bytes.toString("base64"),
        mimeType: asset.mimeType,
      });
    }
    await tx
      .insert(assetUsageTable)
      .values({
        assetId: asset.id,
        projectId: input.projectId,
        filePath: path,
        consumer: "project-file",
      })
      .onConflictDoNothing();
  });
  const src = path.startsWith("public/") ? `/${path.slice("public/".length)}` : path;
  return { path, src, assetId: asset.id };
}

function respondError(res: Response, error: unknown): void {
  if (error instanceof AssetAdmissionError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof Error && error.message === "asset_storage_unavailable") {
    res.status(503).json({
      error: ASSET_ERROR_MESSAGES.asset_storage_unavailable,
      code: "asset_storage_unavailable",
    });
    return;
  }
  throw error;
}

async function reserveFromRequest(req: Request, res: Response, projectId: number | null) {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  if (!assetR2Configured()) {
    res.status(503).json({
      error: ASSET_ERROR_MESSAGES.asset_storage_unavailable,
      code: "asset_storage_unavailable",
    });
    return;
  }
  const body = req.body as {
    filename?: string;
    mimeType?: string;
    sizeBytes?: number;
    kind?: "image" | "file" | "snapshot" | "recording";
    source?: string;
    threadKey?: string | null;
    versionId?: number | null;
    taskId?: number | null;
    context?: Record<string, unknown> | null;
  };
  if (
    !body?.filename ||
    !body.mimeType ||
    typeof body.sizeBytes !== "number" ||
    !acceptsDeclaredAsset(body.filename, body.mimeType)
  ) {
    res.status(415).json({
      error: ASSET_ERROR_MESSAGES.asset_format_unsupported,
      code: "asset_format_unsupported",
    });
    return;
  }
  try {
    const ownerUserId =
      projectId === null
        ? req.userId
        : (
            await db
              .select({ ownerUserId: projectsTable.ownerId })
              .from(projectsTable)
              .where(eq(projectsTable.id, projectId))
          )[0]?.ownerUserId;
    if (!ownerUserId) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const reservation = await reserveAsset({
      ownerUserId,
      actorUserId: req.userId,
      projectId,
      threadKey: body.threadKey ?? null,
      scope: projectId !== null ? "project" : body.threadKey ? "thread" : "account",
      kind: body.kind ?? (body.mimeType.startsWith("image/") ? "image" : "file"),
      source: body.source ?? "upload",
      filename: body.filename,
      mimeType: body.mimeType,
      sizeBytes: body.sizeBytes,
      versionId: body.versionId,
      taskId: body.taskId,
      context: body.context,
    });
    res.status(201).json({
      assetId: reservation.id,
      uploadUrl: `/api/assets/${reservation.id}/content`,
      filename: reservation.filename,
      sizeBytes: reservation.sizeBytes,
      mimeType: reservation.mimeType,
    });
  } catch (error) {
    respondError(res, error);
  }
}

router.post("/projects/:id/assets/reserve", requireProjectAccess("member"), (req, res) => {
  void reserveFromRequest(req, res, Number(req.params.id));
});

router.post("/assets/reserve", (req, res) => {
  void reserveFromRequest(req, res, null);
});

router.get("/assets/quota", async (req, res) => {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  res.json(await getQuota(req.userId));
});

router.get("/assets/analysis-usage", async (req, res) => {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  const rows = await db
    .select()
    .from(assetAnalysisEventsTable)
    .where(eq(assetAnalysisEventsTable.userId, req.userId))
    .orderBy(desc(assetAnalysisEventsTable.createdAt))
    .limit(50);
  const [total] = await db
    .select({
      count: sql<number>`count(*)::int`,
      costMicros: sql<number>`coalesce(sum(${assetAnalysisEventsTable.estimatedProviderCostMicros}), 0)::bigint`,
    })
    .from(assetAnalysisEventsTable)
    .where(eq(assetAnalysisEventsTable.userId, req.userId));
  res.json({
    pricing: "meter-only",
    customerCreditPrice: null,
    message: "Image analysis is metered separately. No customer credit price is active yet.",
    total: {
      count: total?.count ?? 0,
      estimatedProviderCostMicros: Number(total?.costMicros ?? 0),
    },
    events: rows,
  });
});

router.post("/assets/:assetId/alt-text-proposal", async (req, res): Promise<void> => {
  const assetId = Number(req.params.assetId);
  if (!req.userId || !Number.isSafeInteger(assetId) || assetId < 1) {
    res.status(400).json({ error: "Choose a valid image." });
    return;
  }
  const [asset] = await db
    .select()
    .from(assetsTable)
    .where(and(eq(assetsTable.id, assetId), eq(assetsTable.ownerUserId, req.userId)))
    .limit(1);
  if (!asset || asset.state !== "ready" || !asset.mimeType.startsWith("image/")) {
    res.status(404).json({ error: "That image is not available." });
    return;
  }
  const eventId = await createAssetAltTextEvent({
    userId: req.userId,
    projectId: asset.projectId,
    assetId,
  });
  const result = await runAssetAltTextAnalysis({ eventId, userId: req.userId, assetId });
  if (result.status === "completed") {
    res.json({
      assetId,
      proposedAltText: result.proposedAltText,
      metering: { customerCreditPrice: null, status: "recorded" },
    });
    return;
  }
  if (result.status === "blocked") {
    res.status(402).json({ error: "Image analysis is paused by the account spending limit." });
    return;
  }
  res.status(503).json({ error: "Zero could not suggest alt text right now. Try again." });
});

router.get("/projects/:id/assets/quota", requireProjectAccess("viewer"), async (req, res) => {
  const [project] = await db
    .select({ ownerUserId: projectsTable.ownerId })
    .from(projectsTable)
    .where(eq(projectsTable.id, Number(req.params.id)));
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  res.json(await getQuota(project.ownerUserId));
});

router.get("/assets/storage-plans", async (req, res) => {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  const [quota, subscriptions] = await Promise.all([
    getQuota(req.userId),
    listAssetStorageSubscriptions(req.userId),
  ]);
  res.json({
    quota,
    plans: Object.values(ASSET_STORAGE_PLANS).map((plan) => ({
      sku: plan.sku,
      label: plan.label,
      allowanceBytes: plan.allowanceBytes,
      monthlyCents: plan.monthlyCents,
    })),
    subscriptions: subscriptions.map((subscription) => ({
      id: subscription.id,
      sku: subscription.sku,
      allowanceBytes: subscription.allowanceBytes,
      status: subscription.status,
      currentPeriodEnd: subscription.currentPeriodEnd,
    })),
  });
});

router.post("/assets/storage-checkout", async (req, res) => {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  const sku = (req.body as { sku?: unknown } | null)?.sku;
  if (!isAssetStorageSku(sku)) {
    res.status(400).json({ error: "Choose one of the available storage options." });
    return;
  }
  if (!process.env.PLATFORM_DOMAIN) {
    res.status(503).json({ error: "Storage checkout is temporarily unavailable." });
    return;
  }
  try {
    const stripe = await requireStripe();
    const customerId = await ensureStripeCustomer(req.userId, stripe);
    const checkout = await createAssetStorageCheckout({
      stripe,
      customerId,
      userId: req.userId,
      sku,
      returnBase: `https://${process.env.PLATFORM_DOMAIN}`,
    });
    res.json({ checkoutUrl: checkout.url, sessionId: checkout.id });
  } catch {
    res.status(503).json({ error: "Storage checkout is temporarily unavailable." });
  }
});

router.put("/assets/:assetId/content", async (req, res) => {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  const assetId = Number(req.params.assetId);
  const [asset] = await db
    .select()
    .from(assetsTable)
    .where(and(eq(assetsTable.id, assetId), eq(assetsTable.actorUserId, req.userId)));
  if (!asset || asset.state !== "reserved") {
    res.status(404).json({ error: ASSET_ERROR_MESSAGES.asset_not_found, code: "asset_not_found" });
    return;
  }
  const declaredLength = Number(req.headers["content-length"] ?? 0);
  if (declaredLength !== asset.sizeBytes) {
    await rejectReservedAsset({
      assetId,
      ownerUserId: asset.ownerUserId,
      actorUserId: req.userId,
      code: "asset_size_mismatch",
    });
    res.status(409).json({
      error: ASSET_ERROR_MESSAGES.asset_size_mismatch,
      code: "asset_size_mismatch",
    });
    return;
  }

  const digest = createHash("sha256");
  const sampleChunks: Buffer[] = [];
  let sampleBytes = 0;
  let received = 0;
  const observer = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      digest.update(chunk);
      if (sampleBytes < 65_536) {
        const part = chunk.subarray(0, Math.min(chunk.length, 65_536 - sampleBytes));
        sampleChunks.push(part);
        sampleBytes += part.length;
      }
      callback(null, chunk);
    },
  });
  req.pipe(observer);
  try {
    await putAssetStream({
      key: asset.storageKey,
      body: observer,
      contentLength: asset.sizeBytes,
      contentType: asset.mimeType,
    });
    const detected = sniffAsset(Buffer.concat(sampleChunks), asset.filename, asset.mimeType);
    if (received !== asset.sizeBytes || !detected) {
      await deleteAssetObject(asset.storageKey);
      const code = received === asset.sizeBytes ? "asset_content_mismatch" : "asset_size_mismatch";
      await rejectReservedAsset({
        assetId,
        ownerUserId: asset.ownerUserId,
        actorUserId: req.userId,
        code,
      });
      res.status(code === "asset_size_mismatch" ? 409 : 415).json({
        error: ASSET_ERROR_MESSAGES[code],
        code,
      });
      return;
    }
    let textPreview: string | null = null;
    let finalMimeType = detected;
    let finalSizeBytes = asset.sizeBytes;
    let finalSha256 = digest.digest("hex");
    // "not-required" is reserved for bytes we decode/re-encode or for bounded
    // plain text. Structurally parsed documents remain honestly "not-scanned"
    // until a malware service is commissioned; private storage is not a scan.
    let scanState: "not-required" | "not-scanned" = "not-scanned";
    const completeBuffer =
      asset.sizeBytes <= MAX_INLINE_ASSET_ANALYSIS_BYTES
        ? await readAssetBuffer(asset.storageKey, MAX_INLINE_ASSET_ANALYSIS_BYTES)
        : null;
    if (completeBuffer) {
      const analysis = await analyzeAssetBuffer({
        buffer: completeBuffer,
        filename: asset.filename,
        mimeType: detected,
      });
      if (!analysis.valid) {
        await deleteAssetObject(asset.storageKey);
        await rejectReservedAsset({
          assetId,
          ownerUserId: asset.ownerUserId,
          actorUserId: req.userId,
          code: "asset_content_mismatch",
        });
        res.status(415).json({
          error: ASSET_ERROR_MESSAGES.asset_content_mismatch,
          code: "asset_content_mismatch",
        });
        return;
      }
      textPreview = analysis.textPreview;
      if (detected.startsWith("image/")) {
        const normalized = await normalizeUploadedImage({
          buffer: completeBuffer,
          mimeType: detected,
        });
        if (normalized.changed) {
          await putAssetBuffer({
            key: asset.storageKey,
            body: normalized.buffer,
            contentType: normalized.mimeType,
          });
          finalMimeType = normalized.mimeType;
          finalSizeBytes = normalized.buffer.length;
          finalSha256 = createHash("sha256").update(normalized.buffer).digest("hex");
        }
        scanState = "not-required";
      } else if (/\.(?:txt|md|json|csv)$/iu.test(asset.filename)) {
        scanState = "not-required";
      }
    }
    await completeAsset({
      assetId,
      ownerUserId: asset.ownerUserId,
      actorUserId: req.userId,
      sha256: finalSha256,
      scanState,
      textPreview,
      finalMimeType,
      finalSizeBytes,
    });
    let analysisEventId: number | null = null;
    if (finalMimeType.startsWith("image/")) {
      try {
        analysisEventId = await enqueueAutomaticAssetAltText({
          userId: asset.ownerUserId,
          projectId: asset.projectId,
          assetId,
        });
      } catch (error) {
        logger.warn(
          { assetId, errorClass: error instanceof Error ? error.name : "unknown" },
          "automatic alt-text queue unavailable; upload remains ready",
        );
      }
    }
    res.status(201).json({
      assetId,
      contentUrl: `/api/assets/${assetId}/content`,
      filename: asset.filename,
      mimeType: finalMimeType,
      sizeBytes: finalSizeBytes,
      analysis: analysisEventId === null ? null : { eventId: analysisEventId, status: "queued" },
    });
  } catch (error) {
    try {
      await deleteAssetObject(asset.storageKey);
    } catch {
      // The durable rejected row still records the failed upload.
    }
    await rejectReservedAsset({
      assetId,
      ownerUserId: asset.ownerUserId,
      actorUserId: req.userId,
      code: "asset_storage_unavailable",
    });
    respondError(res, error);
  }
});

router.delete("/assets/:assetId/reservation", async (req, res) => {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  const [reserved] = await db
    .select({ storageKey: assetsTable.storageKey })
    .from(assetsTable)
    .where(
      and(
        eq(assetsTable.id, Number(req.params.assetId)),
        eq(assetsTable.actorUserId, req.userId),
        eq(assetsTable.state, "reserved"),
      ),
    );
  if (!reserved) {
    res.status(404).json({ error: ASSET_ERROR_MESSAGES.asset_not_found, code: "asset_not_found" });
    return;
  }
  await deleteAssetObject(reserved.storageKey);
  const cancelled = await cancelReservedAsset({
    assetId: Number(req.params.assetId),
    actorUserId: req.userId,
  });
  if (!cancelled.storageKey) {
    res.status(404).json({ error: ASSET_ERROR_MESSAGES.asset_not_found, code: "asset_not_found" });
    return;
  }
  res.json({ cancelled: true, receipt: { assetId: Number(req.params.assetId) } });
});

router.get("/assets", async (req, res) => {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 50)));
  const projectId = req.query.projectId === undefined ? null : Number(req.query.projectId);
  if (projectId !== null) {
    if (!Number.isSafeInteger(projectId) || !(await mayReadProjectAssets(req.userId, projectId))) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
  }
  const conditions = [eq(assetsTable.state, "ready")];
  if (projectId !== null) {
    conditions.push(eq(assetsTable.projectId, projectId));
  } else {
    conditions.push(eq(assetsTable.ownerUserId, req.userId));
  }
  const rows = await db
    .select()
    .from(assetsTable)
    .where(and(...conditions))
    .orderBy(desc(assetsTable.createdAt))
    .limit(limit);
  res.json({
    assets: rows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      scope: row.scope,
      kind: row.kind,
      source: row.source,
      filename: row.filename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
      scanState: row.scanState,
      versionId: row.versionId,
      context: row.context,
      contentUrl: `/api/assets/${row.id}/content`,
      createdAt: row.createdAt,
    })),
  });
});

router.get("/assets/:assetId/content", async (req, res) => {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  const assetId = Number(req.params.assetId);
  const [asset] = await db.select().from(assetsTable).where(eq(assetsTable.id, assetId));
  if (!asset || asset.state !== "ready") {
    res.status(404).json({ error: ASSET_ERROR_MESSAGES.asset_not_found, code: "asset_not_found" });
    return;
  }
  const mayRead =
    asset.ownerUserId === req.userId ||
    (asset.projectId !== null && (await mayReadProjectAssets(req.userId, asset.projectId)));
  if (!mayRead) {
    res.status(404).json({ error: ASSET_ERROR_MESSAGES.asset_not_found, code: "asset_not_found" });
    return;
  }
  if (asset.storageBackend !== "r2") {
    res.status(409).json({ error: "This older upload is still being migrated." });
    return;
  }
  const object = await openAsset(asset.storageKey);
  if (!object) {
    res.status(404).json({ error: ASSET_ERROR_MESSAGES.asset_not_found, code: "asset_not_found" });
    return;
  }
  res.setHeader("Content-Type", asset.mimeType);
  res.setHeader("Content-Length", String(object.sizeBytes));
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Content-Disposition",
    `${asset.mimeType.startsWith("image/") || asset.mimeType.startsWith("video/") ? "inline" : "attachment"}; filename="${asset.filename.replace(/"/g, "")}"`,
  );
  object.body.pipe(res);
});

router.patch("/assets/:assetId", async (req, res): Promise<void> => {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  const body = req.body as { altText?: unknown; brandRole?: unknown } | null;
  const altText = typeof body?.altText === "string" ? body.altText.trim() : "";
  const allowedRoles = ["none", "logo", "icon", "palette", "font", "reference"] as const;
  const requestedRole = typeof body?.brandRole === "string" ? body.brandRole : "none";
  const brandRole = allowedRoles.find((role) => role === requestedRole);
  if (altText.length > 500 || !brandRole) {
    res.status(400).json({ error: "Choose a short description and a valid brand role." });
    return;
  }
  const [asset] = await db
    .select({ context: assetsTable.context })
    .from(assetsTable)
    .where(
      and(
        eq(assetsTable.id, Number(req.params.assetId)),
        eq(assetsTable.ownerUserId, req.userId),
        eq(assetsTable.state, "ready"),
      ),
    );
  if (!asset) {
    res.status(404).json({ error: ASSET_ERROR_MESSAGES.asset_not_found, code: "asset_not_found" });
    return;
  }
  const context: AssetContext = {
    ...((asset.context as AssetContext | null) ?? {}),
    altText: altText || undefined,
    brandRole,
  };
  await db
    .update(assetsTable)
    .set({ context })
    .where(
      and(
        eq(assetsTable.id, Number(req.params.assetId)),
        eq(assetsTable.ownerUserId, req.userId),
        eq(assetsTable.state, "ready"),
      ),
    );
  res.json({ updated: true, assetId: Number(req.params.assetId), context });
});

router.post("/assets/:assetId/derivatives", async (req, res): Promise<void> => {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  const [source] = await db
    .select()
    .from(assetsTable)
    .where(
      and(
        eq(assetsTable.id, Number(req.params.assetId)),
        eq(assetsTable.ownerUserId, req.userId),
        eq(assetsTable.state, "ready"),
      ),
    );
  if (!source || source.storageBackend !== "r2" || !source.mimeType.startsWith("image/")) {
    res.status(404).json({ error: ASSET_ERROR_MESSAGES.asset_not_found, code: "asset_not_found" });
    return;
  }
  const requested = (req.body as { presets?: unknown } | null)?.presets;
  const values = Array.isArray(requested) ? requested : Object.keys(ASSET_DERIVATIVE_PRESETS);
  const presets = values.filter(
    (value): value is AssetDerivativePreset =>
      typeof value === "string" && Object.hasOwn(ASSET_DERIVATIVE_PRESETS, value),
  );
  if (presets.length !== values.length || presets.length < 1 || presets.length > 20) {
    res.status(400).json({ error: "Choose between 1 and 20 supported asset sizes." });
    return;
  }
  const bytes = await readAssetBuffer(source.storageKey, MAX_MATERIALIZED_ASSET_BYTES);
  if (!bytes) {
    res.status(503).json({ error: ASSET_ERROR_MESSAGES.asset_storage_unavailable });
    return;
  }
  const created: Array<{
    id: number;
    storageKey: string;
    sizeBytes: number;
    state: "reserved" | "ready";
    preset: AssetDerivativePreset;
  }> = [];
  try {
    const derivatives = await generateAssetDerivatives(bytes, presets);
    for (const derivative of derivatives) {
      const reserved = await reserveAsset({
        ownerUserId: req.userId,
        actorUserId: req.userId,
        projectId: source.projectId,
        threadKey: source.threadKey,
        scope: source.scope as "account" | "project" | "thread",
        kind: "image",
        source: "derivative",
        filename: `${source.filename.replace(/\.[^.]+$/u, "")}-${derivative.filename}`,
        mimeType: derivative.mimeType,
        sizeBytes: derivative.buffer.length,
        versionId: source.versionId,
        taskId: source.taskId,
        context: {
          derivativeOfAssetId: source.id,
          derivativePreset: derivative.preset,
          altText: (source.context as { altText?: string } | null)?.altText,
          brandRole: (source.context as { brandRole?: string } | null)?.brandRole,
        },
      });
      const tracked: (typeof created)[number] = {
        id: reserved.id,
        storageKey: reserved.storageKey,
        sizeBytes: derivative.buffer.length,
        state: "reserved",
        preset: derivative.preset,
      };
      created.push(tracked);
      await putAssetBuffer({
        key: reserved.storageKey,
        body: derivative.buffer,
        contentType: derivative.mimeType,
      });
      await completeAsset({
        assetId: reserved.id,
        ownerUserId: req.userId,
        actorUserId: req.userId,
        sha256: createHash("sha256").update(derivative.buffer).digest("hex"),
        scanState: "not-required",
      });
      tracked.state = "ready";
    }
    res.status(201).json({
      sourceAssetId: source.id,
      derivatives: created.map((item) => ({
        assetId: item.id,
        preset: item.preset,
        contentUrl: `/api/assets/${item.id}/content`,
      })),
    });
  } catch (error) {
    for (const item of [...created].reverse()) {
      try {
        if (item.state === "ready") {
          const pending = await deleteReadyAsset({ assetId: item.id, userId: req.userId });
          await deleteAssetObject(item.storageKey);
          await recordAssetDeleted({
            assetId: item.id,
            userId: req.userId,
            sizeBytes: pending.sizeBytes,
          });
        } else {
          await deleteAssetObject(item.storageKey);
          await cancelReservedAsset({ assetId: item.id, actorUserId: req.userId });
        }
      } catch {
        // Every attempted cleanup remains represented by its durable registry row.
      }
    }
    if (error instanceof AssetAdmissionError) {
      respondError(res, error);
    } else {
      res.status(422).json({ error: "This image could not be turned into app-ready sizes." });
    }
  }
});

router.post(
  "/projects/:id/assets/:assetId/materialize",
  requireProjectAccess("member"),
  async (req, res): Promise<void> => {
    if (!req.userId) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    try {
      const receipt = await materializeProjectAsset({
        userId: req.userId,
        projectId: Number(req.params.id),
        assetId: Number(req.params.assetId),
        path: (req.body as { path?: unknown } | null)?.path,
      });
      res.status(201).json({
        ...receipt,
        message: "The asset is now available in this project and can be restored with its history.",
      });
    } catch (error) {
      respondError(res, error);
    }
  },
);

router.post(
  "/projects/:id/assets/:assetId/replace",
  requireProjectAccess("member"),
  async (req, res): Promise<void> => {
    if (!req.userId) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    const projectId = Number(req.params.id);
    const assetId = Number(req.params.assetId);
    const replacementAssetId = Number(
      (req.body as { replacementAssetId?: unknown } | null)?.replacementAssetId,
    );
    if (!Number.isSafeInteger(replacementAssetId) || replacementAssetId < 1) {
      res.status(400).json({ error: "Choose a valid replacement asset." });
      return;
    }
    const usages = await db
      .select()
      .from(assetUsageTable)
      .where(and(eq(assetUsageTable.assetId, assetId), eq(assetUsageTable.projectId, projectId)))
      .limit(101);
    if (usages.length > 100 || usages.some((usage) => !usage.filePath)) {
      res.status(409).json({
        error:
          "This asset has references that need Zero's review before they can be replaced safely.",
      });
      return;
    }
    try {
      const replacement = await loadMaterializableAsset({
        userId: req.userId,
        projectId,
        assetId: replacementAssetId,
      });
      const artifactId = await resolveArtifactId(projectId, null);
      if (artifactId === null) {
        throw new AssetAdmissionError(
          "asset_content_mismatch",
          409,
          "This project needs a primary app before its assets can be replaced.",
        );
      }
      const receipts = usages.map((usage) => {
        const path = usage.filePath as string;
        return {
          path,
          src: path.startsWith("public/") ? `/${path.slice("public/".length)}` : path,
          assetId: replacement.id,
        };
      });
      const encoded = replacement.bytes.toString("base64");
      await db.transaction(async (tx) => {
        for (const receipt of receipts) {
          const [existing] = await tx
            .select({ id: projectFilesTable.id })
            .from(projectFilesTable)
            .where(
              and(
                eq(projectFilesTable.projectId, projectId),
                eq(projectFilesTable.artifactId, artifactId),
                eq(projectFilesTable.path, receipt.path),
              ),
            );
          if (existing) {
            await tx
              .update(projectFilesTable)
              .set({ content: encoded, mimeType: replacement.mimeType, updatedAt: new Date() })
              .where(eq(projectFilesTable.id, existing.id));
          } else {
            await tx.insert(projectFilesTable).values({
              projectId,
              artifactId,
              path: receipt.path,
              content: encoded,
              mimeType: replacement.mimeType,
            });
          }
          await tx
            .insert(assetUsageTable)
            .values({
              assetId: replacement.id,
              projectId,
              filePath: receipt.path,
              consumer: "project-file",
            })
            .onConflictDoNothing();
        }
        await tx
          .delete(assetUsageTable)
          .where(
            and(eq(assetUsageTable.assetId, assetId), eq(assetUsageTable.projectId, projectId)),
          );
      });
      res.json({ replaced: true, replacements: receipts });
    } catch (error) {
      respondError(res, error);
    }
  },
);

router.delete("/assets/:assetId", async (req, res) => {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  try {
    const pending = await deleteReadyAsset({
      assetId: Number(req.params.assetId),
      userId: req.userId,
    });
    await deleteAssetObject(pending.storageKey);
    await recordAssetDeleted({
      assetId: Number(req.params.assetId),
      userId: req.userId,
      sizeBytes: pending.sizeBytes,
    });
    res.json({
      deleted: true,
      receipt: { assetId: Number(req.params.assetId), bytes: pending.sizeBytes },
    });
  } catch (error) {
    respondError(res, error);
  }
});

router.get("/assets/:assetId/usage", async (req, res) => {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  const assetId = Number(req.params.assetId);
  const [asset] = await db
    .select({ ownerUserId: assetsTable.ownerUserId })
    .from(assetsTable)
    .where(eq(assetsTable.id, assetId));
  if (!asset || asset.ownerUserId !== req.userId) {
    res.status(404).json({ error: ASSET_ERROR_MESSAGES.asset_not_found, code: "asset_not_found" });
    return;
  }
  const usages = await db
    .select()
    .from(assetUsageTable)
    .where(eq(assetUsageTable.assetId, assetId));
  res.json({ usages });
});

export default router;
