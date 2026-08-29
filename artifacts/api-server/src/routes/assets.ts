import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import { assetsTable, assetUsageTable, db, projectsTable } from "@workspace/db";
import { checkProjectAccess, requireProjectAccess } from "../lib/auth";
import { analyzeAssetBuffer, MAX_INLINE_ASSET_ANALYSIS_BYTES } from "../lib/asset-analysis";
import { normalizeUploadedImage } from "../lib/asset-image-normalization";
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

const router: IRouter = Router();

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
      }
    }
    await completeAsset({
      assetId,
      ownerUserId: asset.ownerUserId,
      actorUserId: req.userId,
      sha256: finalSha256,
      scanState: detected.startsWith("image/") ? "not-scanned" : "not-scanned",
      textPreview,
      finalMimeType,
      finalSizeBytes,
    });
    res.status(201).json({
      assetId,
      contentUrl: `/api/assets/${assetId}/content`,
      filename: asset.filename,
      mimeType: finalMimeType,
      sizeBytes: finalSizeBytes,
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
    if (
      !Number.isSafeInteger(projectId) ||
      (await checkProjectAccess(req.userId, projectId)) !== "granted"
    ) {
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
    (asset.projectId !== null &&
      (await checkProjectAccess(req.userId, asset.projectId, "viewer")) === "granted");
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
    `${asset.mimeType.startsWith("image/") || asset.mimeType.startsWith("video/") ? "inline" : "attachment"}; filename="${asset.filename.replace(/\"/g, "")}"`,
  );
  object.body.pipe(res);
});

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
