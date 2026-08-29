import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { assetsTable, db, projectsTable, projectFilesTable } from "@workspace/db";
import { generateImageBuffer } from "@workspace/integrations-openai-ai-server";
import { requireProjectOwnership } from "../lib/auth";
import { objectStorageClient, ObjectStorageService } from "../lib/objectStorage";
import { GenerateImageBody, GenerateImageResponse } from "@workspace/api-zod";
import { openAsset } from "../lib/asset-r2";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

function parsePrivateDir(): { bucketName: string; prefix: string } {
  let dir = process.env.PRIVATE_OBJECT_DIR ?? "";
  if (!dir) {
    throw new Error("PRIVATE_OBJECT_DIR not set");
  }
  if (!dir.startsWith("/")) dir = `/${dir}`;
  const parts = dir.split("/").filter(Boolean);
  if (parts.length < 1) throw new Error("PRIVATE_OBJECT_DIR malformed");
  const bucketName = parts[0]!;
  const prefix = parts.slice(1).join("/");
  return { bucketName, prefix };
}

async function uploadBufferToPrivate(
  buffer: Buffer,
  subdir: string,
  contentType: string,
): Promise<{ objectPath: string }> {
  const { bucketName, prefix } = parsePrivateDir();
  const id = randomUUID();
  const objectName = [prefix, subdir, `${id}.png`].filter(Boolean).join("/");
  const file = objectStorageClient.bucket(bucketName).file(objectName);
  await file.save(buffer, { contentType, resumable: false });
  const entityId = [subdir, `${id}.png`].filter(Boolean).join("/");
  return { objectPath: `/objects/${entityId}` };
}

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

    const { objectPath } = await uploadBufferToPrivate(buffer, "generated", "image/png");

    // Also save into project files so generated apps can reference the asset.
    const safeSavePath = (() => {
      const candidate = (savePath ?? "").trim().replace(/^\/+/, "");
      if (!candidate || candidate.includes("..")) {
        return `assets/generated/${Date.now()}.png`;
      }
      return candidate;
    })();

    try {
      const existing = await db
        .select({ id: projectFilesTable.id })
        .from(projectFilesTable)
        .where(eq(projectFilesTable.projectId, project.id));
      const dup = existing.find(() => false); // placeholder — unused
      if (dup) {
        // no-op
      }
      await db.insert(projectFilesTable).values({
        projectId: project.id,
        path: safeSavePath,
        content: buffer.toString("base64"),
        mimeType: "image/png",
      });
    } catch (err) {
      req.log.warn({ err }, "Failed to persist generated image as project file (non-fatal)");
    }

    const [w, h] = requestedSize.split("x").map((n) => Number(n));
    res.json(
      GenerateImageResponse.parse({
        attachment: {
          kind: "image",
          url: objectPath,
          alt: prompt,
          width: w,
          height: h,
          generated: true,
          savedPath: safeSavePath,
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
