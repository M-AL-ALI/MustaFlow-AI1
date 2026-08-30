import { Router, type IRouter } from "express";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { assetsTable, assetUsageTable, db, projectsTable, projectFilesTable } from "@workspace/db";
import { generateImageBuffer } from "@workspace/integrations-openai-ai-server";
import { requireProjectOwnership } from "../lib/auth";
import { ObjectStorageService } from "../lib/objectStorage";
import { GenerateImageBody, GenerateImageResponse } from "@workspace/api-zod";
import { deleteAssetObject, openAsset, putAssetBuffer } from "../lib/asset-r2";
import {
  AssetAdmissionError,
  completeAsset,
  rejectReservedAsset,
  reserveAsset,
} from "../lib/asset-registry";
import { resolveArtifactId } from "../lib/artifacts";

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

    const { prompt, size, savePath } = parsed.data;
    const requestedSize =
      (size as "1024x1024" | "1536x1024" | "1024x1536" | undefined) ?? "1024x1024";
    // generateImageBuffer types only allow square sizes today; cast to widen.
    const buffer = await generateImageBuffer(prompt, requestedSize as "1024x1024").catch(
      (err: unknown) => {
        req.log.error({ err }, "Image generation failed");
        throw err;
      },
    );

    let reservation: Awaited<ReturnType<typeof reserveAsset>> | null = null;
    try {
      reservation = await reserveAsset({
        ownerUserId: project.ownerId,
        actorUserId: req.userId!,
        projectId: project.id,
        threadKey: null,
        scope: "project",
        kind: "generated",
        source: "zero-composer",
        filename: "generated.png",
        mimeType: "image/png",
        sizeBytes: buffer.length,
        context: { altText: prompt, brandRole: "none" },
      });
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
      });
    } catch (error) {
      if (reservation) {
        await deleteAssetObject(reservation.storageKey).catch(() => undefined);
        await rejectReservedAsset({
          assetId: reservation.id,
          ownerUserId: project.ownerId,
          actorUserId: req.userId!,
          code: "asset_storage_unavailable",
        }).catch(() => undefined);
      }
      if (error instanceof AssetAdmissionError) {
        res.status(error.status).json({ error: error.message, code: error.code });
        return;
      }
      throw error;
    }

    // Also save into project files so generated apps can reference the asset.
    const safeSavePath = (() => {
      const candidate = (savePath ?? "").trim().replace(/^\/+/, "");
      if (!candidate || candidate.includes("..")) {
        return `assets/generated/${Date.now()}.png`;
      }
      return candidate;
    })();

    let savedPath: string | undefined;
    try {
      const artifactId = await resolveArtifactId(project.id, null);
      if (artifactId === null) {
        req.log.warn({ projectId: project.id }, "Generated image has no primary app to save into");
      } else {
        await db.transaction(async (tx) => {
          const [existing] = await tx
            .select({ id: projectFilesTable.id })
            .from(projectFilesTable)
            .where(
              and(
                eq(projectFilesTable.projectId, project.id),
                eq(projectFilesTable.artifactId, artifactId),
                eq(projectFilesTable.path, safeSavePath),
              ),
            );
          if (existing) {
            await tx
              .update(projectFilesTable)
              .set({
                content: buffer.toString("base64"),
                mimeType: "image/png",
                updatedAt: new Date(),
              })
              .where(eq(projectFilesTable.id, existing.id));
          } else {
            await tx.insert(projectFilesTable).values({
              projectId: project.id,
              artifactId,
              path: safeSavePath,
              content: buffer.toString("base64"),
              mimeType: "image/png",
            });
          }
          await tx
            .insert(assetUsageTable)
            .values({
              assetId: reservation.id,
              projectId: project.id,
              filePath: safeSavePath,
              consumer: `project-file:${safeSavePath}`,
            })
            .onConflictDoNothing();
        });
        savedPath = safeSavePath;
      }
    } catch (err) {
      req.log.warn({ err }, "Failed to persist generated image as project file (non-fatal)");
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
          ...(savedPath ? { savedPath } : {}),
        },
      }),
    );
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
