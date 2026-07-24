import { Router } from "express";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { db, brandKitsTable, oraAssetsTable, SAFE_FONTS } from "@workspace/db";
import { logger } from "../lib/logger";
import { persistOraAsset } from "../lib/ora-assets";

const router = Router();

const HEX_RE = /^#?[0-9a-fA-F]{6}$/;

const kitBodySchema = z.object({
  primaryColor: z
    .string()
    .regex(HEX_RE, "Must be a 6-digit hex color")
    .transform((v) => `#${v.replace(/^#/, "").toUpperCase()}`)
    .nullable()
    .optional(),
  secondaryColor: z
    .string()
    .regex(HEX_RE, "Must be a 6-digit hex color")
    .transform((v) => `#${v.replace(/^#/, "").toUpperCase()}`)
    .nullable()
    .optional(),
  accentColor: z
    .string()
    .regex(HEX_RE, "Must be a 6-digit hex color")
    .transform((v) => `#${v.replace(/^#/, "").toUpperCase()}`)
    .nullable()
    .optional(),
  headingFont: z
    .enum(SAFE_FONTS)
    .nullable()
    .optional(),
  bodyFont: z
    .enum(SAFE_FONTS)
    .nullable()
    .optional(),
  logoAssetId: z.number().int().positive().nullable().optional(),
  oraProjectId: z.number().int().positive().nullable().optional(),
});

const logoUploadSchema = z.object({
  data: z.string().min(1, "Base64 data required"),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  fileName: z.string().min(1).max(200),
  oraProjectId: z.number().int().positive().nullable().optional(),
});

function buildScopeFilter(userId: string, oraProjectId: number | null | undefined) {
  return oraProjectId != null
    ? and(eq(brandKitsTable.userId, userId), eq(brandKitsTable.oraProjectId, oraProjectId))
    : and(eq(brandKitsTable.userId, userId), isNull(brandKitsTable.oraProjectId));
}

router.get("/ora/brand-kit", async (req, res) => {
  const userId = req.userId!;
  const rawProjectId = req.query.projectId;
  const oraProjectId =
    typeof rawProjectId === "string" && rawProjectId !== "" ? Number(rawProjectId) : null;

  try {
    const [row] = await db
      .select({
        id: brandKitsTable.id,
        primaryColor: brandKitsTable.primaryColor,
        secondaryColor: brandKitsTable.secondaryColor,
        accentColor: brandKitsTable.accentColor,
        headingFont: brandKitsTable.headingFont,
        bodyFont: brandKitsTable.bodyFont,
        logoAssetId: brandKitsTable.logoAssetId,
        oraProjectId: brandKitsTable.oraProjectId,
        createdAt: brandKitsTable.createdAt,
        updatedAt: brandKitsTable.updatedAt,
      })
      .from(brandKitsTable)
      .where(buildScopeFilter(userId, oraProjectId ?? null))
      .limit(1);

    if (!row) {
      res.json({ kit: null });
      return;
    }

    let logoPreviewUrl: string | null = null;
    if (row.logoAssetId != null) {
      logoPreviewUrl = `/api/ora/assets/${row.logoAssetId}/download`;
    }

    res.json({ kit: { ...row, logoPreviewUrl } });
  } catch (err) {
    logger.error({ component: "ora-brand-kit", err }, "GET /ora/brand-kit failed");
    res.status(500).json({ error: "Failed to load brand kit" });
  }
});

router.put("/ora/brand-kit", async (req, res) => {
  const userId = req.userId!;
  const parsed = kitBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
    return;
  }

  const { primaryColor, secondaryColor, accentColor, headingFont, bodyFont, logoAssetId, oraProjectId } =
    parsed.data;

  if (logoAssetId != null) {
    const [asset] = await db
      .select({ id: oraAssetsTable.id, kind: oraAssetsTable.kind })
      .from(oraAssetsTable)
      .where(
        and(
          eq(oraAssetsTable.id, logoAssetId),
          eq(oraAssetsTable.userId, userId),
          isNull(oraAssetsTable.deletedAt),
        ),
      )
      .limit(1);
    if (!asset) {
      res.status(400).json({ error: "Logo asset not found or not owned by you" });
      return;
    }
    if (asset.kind !== "image") {
      res.status(400).json({ error: "Logo asset must be an image" });
      return;
    }
  }

  try {
    const scopeFilter = buildScopeFilter(userId, oraProjectId ?? null);
    const [existing] = await db.select({ id: brandKitsTable.id }).from(brandKitsTable).where(scopeFilter).limit(1);

    const now = new Date();
    if (existing) {
      await db
        .update(brandKitsTable)
        .set({
          primaryColor: primaryColor ?? null,
          secondaryColor: secondaryColor ?? null,
          accentColor: accentColor ?? null,
          headingFont: headingFont ?? null,
          bodyFont: bodyFont ?? null,
          logoAssetId: logoAssetId ?? null,
          updatedAt: now,
        })
        .where(eq(brandKitsTable.id, existing.id));
    } else {
      await db.insert(brandKitsTable).values({
        userId,
        oraProjectId: oraProjectId ?? null,
        primaryColor: primaryColor ?? null,
        secondaryColor: secondaryColor ?? null,
        accentColor: accentColor ?? null,
        headingFont: headingFont ?? null,
        bodyFont: bodyFont ?? null,
        logoAssetId: logoAssetId ?? null,
        createdAt: now,
        updatedAt: now,
      });
    }

    res.json({ ok: true });
  } catch (err) {
    logger.error({ component: "ora-brand-kit", err }, "PUT /ora/brand-kit failed");
    res.status(500).json({ error: "Failed to save brand kit" });
  }
});

router.delete("/ora/brand-kit", async (req, res) => {
  const userId = req.userId!;
  const rawProjectId = req.query.projectId;
  const oraProjectId =
    typeof rawProjectId === "string" && rawProjectId !== "" ? Number(rawProjectId) : null;

  try {
    await db.delete(brandKitsTable).where(buildScopeFilter(userId, oraProjectId));
    res.json({ ok: true });
  } catch (err) {
    logger.error({ component: "ora-brand-kit", err }, "DELETE /ora/brand-kit failed");
    res.status(500).json({ error: "Failed to delete brand kit" });
  }
});

router.post("/ora/brand-kit/logo", async (req, res) => {
  const userId = req.userId!;
  const parsed = logoUploadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
    return;
  }

  const { data: base64Data, mimeType, fileName, oraProjectId } = parsed.data;

  let buf: Buffer;
  try {
    buf = Buffer.from(base64Data, "base64");
  } catch {
    res.status(400).json({ error: "Invalid base64 data" });
    return;
  }

  if (buf.length === 0) {
    res.status(400).json({ error: "Empty file" });
    return;
  }

  const MAX_LOGO_BYTES = 5 * 1024 * 1024;
  if (buf.length > MAX_LOGO_BYTES) {
    res.status(413).json({ error: "Logo must be under 5 MB" });
    return;
  }

  const ext = mimeType.split("/")[1] ?? "png";

  try {
    const assetId = await persistOraAsset({
      userId,
      oraProjectId: oraProjectId ?? null,
      kind: "image",
      fileName: fileName.slice(0, 200),
      mimeType,
      format: ext,
      base64: base64Data,
    });

    if (assetId == null) {
      res.status(507).json({ error: "Storage capacity exceeded — delete some library files and try again" });
      return;
    }

    res.json({ assetId, previewUrl: `/api/ora/assets/${assetId}/download` });
  } catch (err) {
    logger.error({ component: "ora-brand-kit-logo", err }, "POST /ora/brand-kit/logo failed");
    res.status(500).json({ error: "Failed to store logo" });
  }
});

export default router;
