import { Router, type IRouter } from "express";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { assetsTable, db, projectsTable } from "@workspace/db";
import { generateImageBuffer } from "@workspace/integrations-openai-ai-server";
import { requireProjectOwnership } from "../lib/auth";
import { ObjectStorageService } from "../lib/objectStorage";
import { GenerateImageBody, GenerateImageResponse } from "@workspace/api-zod";
import { deleteAssetObject, openAsset, putAssetBuffer } from "../lib/asset-r2";
import {
  AssetAdmissionError,
  beginAssetUpload,
  completeAsset,
  rejectReservedAsset,
  reserveAssetAgainstAvailableQuota,
} from "../lib/asset-registry";
import { holdResponseProjectLifecycleSession } from "../lib/project-lifecycle";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

router.post(
  "/projects/:id/generate-image",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (!Number.isFinite(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }
    const parsed = GenerateImageBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const releaseLifecycleHold = holdResponseProjectLifecycleSession(res);
    try {
      const { prompt, size } = parsed.data;
      const requestedSize =
        (size as "1024x1024" | "1536x1024" | "1024x1536" | undefined) ?? "1024x1024";
      let reservation: Awaited<ReturnType<typeof reserveAssetAgainstAvailableQuota>> | null = null;
      let buffer: Buffer;
      try {
        reservation = await reserveAssetAgainstAvailableQuota({
          productScope: "nabuflow",
          ownerUserId: project.ownerId,
          actorUserId: req.userId!,
          projectId: project.id,
          threadKey: null,
          scope: "project",
          kind: "generated",
          source: "zero-composer",
          filename: "generated.png",
          mimeType: "image/png",
          context: { altText: prompt, brandRole: "none" },
        });
        const uploadClaim = await beginAssetUpload({
          assetId: reservation.id,
          actorUserId: req.userId!,
        });
        if (!uploadClaim) throw new Error("Generated asset reservation is unavailable");
        // Quota is reserved before the provider call, so a full account spends no
        // provider credits and creates no untracked bytes.
        buffer = await generateImageBuffer(prompt, requestedSize as "1024x1024").catch(
          (err: unknown) => {
            req.log.error({ err }, "Image generation failed");
            throw err;
          },
        );
        await putAssetBuffer({
          key: reservation.storageKey,
          body: buffer,
          contentType: "image/png",
        });
        await completeAsset({
          assetId: reservation.id,
          ownerUserId: project.ownerId,
          actorUserId: req.userId!,
          sha256: createHash("sha256").update(buffer).digest("hex"),
          scanState: "not-required",
          finalSizeBytes: buffer.length,
        });
      } catch (error) {
        if (reservation) {
          await deleteAssetObject(reservation.storageKey).catch((cleanupError: unknown) => {
            req.log.warn(
              {
                assetId: reservation?.id,
                errorClass: cleanupError instanceof Error ? cleanupError.name : "unknown",
              },
              "generated image object cleanup remains pending",
            );
          });
          await rejectReservedAsset({
            assetId: reservation.id,
            ownerUserId: project.ownerId,
            actorUserId: req.userId!,
            code: "asset_storage_unavailable",
          });
        }
        if (error instanceof AssetAdmissionError) {
          res.status(error.status).json({ error: error.message, code: error.code });
          return;
        }
        throw error;
      }

      const [w, h] = requestedSize.split("x").map((n) => Number(n));
      res.json(
        GenerateImageResponse.parse({
          attachment: {
            kind: "image",
            assetId: reservation.id,
            url: `/api/assets/${reservation.id}/content`,
            alt: prompt,
            width: w,
            height: h,
            generated: true,
          },
        }),
      );
    } finally {
      await releaseLifecycleHold();
    }
  },
);

export async function fetchAttachmentAsDataUri(
  objectPath: string,
  expectedProjectId?: number,
): Promise<string | null> {
  try {
    const assetMatch = /^\/api\/assets\/(\d+)\/content$/.exec(objectPath);
    if (assetMatch) {
      const assetId = Number(assetMatch[1]);
      const [asset] = await db.select().from(assetsTable).where(eq(assetsTable.id, assetId));
      if (
        !asset ||
        asset.state !== "ready" ||
        asset.storageBackend !== "r2" ||
        expectedProjectId === undefined ||
        asset.projectId !== expectedProjectId ||
        !asset.mimeType.startsWith("image/") ||
        asset.sizeBytes > 20 * 1024 * 1024
      ) {
        return null;
      }
      const object = await openAsset(asset.storageKey);
      if (!object) return null;
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of object.body) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        bytes += buffer.length;
        if (bytes > 20 * 1024 * 1024) return null;
        chunks.push(buffer);
      }
      return `data:${asset.mimeType};base64,${Buffer.concat(chunks).toString("base64")}`;
    }
    const file = await objectStorageService.getObjectEntityFile(objectPath);
    const [metadata] = await file.getMetadata();
    const [bytes] = await file.download();
    const contentType = (metadata.contentType as string) || "image/png";
    return `data:${contentType};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

export default router;
