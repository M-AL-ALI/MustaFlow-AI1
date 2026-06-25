/**
 * POST /public-ai/export-file
 *
 * Deterministic, no-charge file export. Takes Markdown the caller already has
 * (e.g. an Ora assistant reply on mobile) and returns a real Microsoft Office
 * file (.docx/.xlsx/.pptx) or PDF as base64, using the same deterministic
 * builders the website-grade chat file generation relies on.
 *
 * Deliberately AI-free: no model calls, no Ora quota consumption, no spend-cap
 * accounting, no asset persistence. It only reformats content into a document,
 * so it is not metered against Ora quotas. Access requires a signed-in Ora user
 * OR a valid anonymous session, and the route is IP-rate-limited upstream
 * (oraExportFileLimiter in routes/index.ts) so the CPU/memory-heavy builders
 * can't be hammered through cheaply-minted anonymous sessions.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { logger } from "../../lib/logger";
import { validateSession } from "../../lib/public-ai/session";

const router = Router();

const bodySchema = z.object({
  format: z.enum(["docx", "xlsx", "pptx", "pdf"]),
  title: z.string().max(200).optional(),
  content: z.string().min(1).max(100_000),
  filename: z.string().max(100).optional(),
});

type ExportFormat = z.infer<typeof bodySchema>["format"];

const MIME_TYPES: Record<ExportFormat, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf",
};

const MAX_OUTPUT_BYTES = 15 * 1024 * 1024;

function safeBaseName(name: string | undefined, fallback: string): string {
  const cleaned = (name ?? "")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || fallback;
}

router.post("/public-ai/export-file", async (req: Request, res: Response) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const { format, title, content, filename } = parsed.data;

  // Require a current Ora user (signed-in bearer) or a valid anonymous session.
  // No charging happens here — this gate only prevents unauthenticated abuse.
  const { resolveAuthedOraUser } = await import("../../lib/public-ai/authed-user");
  const authed = await resolveAuthedOraUser(req);
  const sessionToken = req.cookies?.["ora-session"] as string | undefined;
  const session = sessionToken ? validateSession(sessionToken) : null;
  if (!authed && !session) {
    res.status(401).json({ error: "No active session. Please start a session first." });
    return;
  }

  try {
    const { buildDocx, buildXlsx, buildPptx, buildPdf } =
      await import("../../lib/public-ai/file-builder");
    const { markdownToDocumentData, markdownToPresentationData, markdownToTabularData } =
      await import("../../lib/public-ai/export-content");

    const docTitle = title?.trim() || "Ora Export";

    let buffer: Buffer;
    switch (format) {
      case "xlsx":
        buffer = await buildXlsx(markdownToTabularData(content, docTitle));
        break;
      case "pptx":
        buffer = await buildPptx(markdownToPresentationData(content, docTitle));
        break;
      case "pdf":
        buffer = await buildPdf(markdownToDocumentData(content, docTitle));
        break;
      case "docx":
      default:
        buffer = await buildDocx(markdownToDocumentData(content, docTitle));
        break;
    }

    if (buffer.length > MAX_OUTPUT_BYTES) {
      res.status(413).json({ error: "The exported file is too large." });
      return;
    }

    const fileName = `${safeBaseName(filename, "ora-export")}.${format}`;
    req.log.info(
      { component: "ora-export-file", format, fileName, bytes: buffer.length },
      "Ora file exported",
    );
    res.json({
      fileName,
      fileData: buffer.toString("base64"),
      mimeType: MIME_TYPES[format],
    });
  } catch (err) {
    logger.error({ component: "ora-export-file", format, err }, "Ora file export failed");
    res.status(500).json({ error: "Failed to export file. Please try again." });
  }
});

export default router;
