import { Router } from "express";
import multer from "multer";
import { and, eq } from "drizzle-orm";
import { assetsTable, db } from "@workspace/db";
import {
  validateSession,
  incrementFileCount,
  incrementImageCount,
  setSessionCookie,
  FILE_LIMIT_VALUE,
  IMAGE_LIMIT_VALUE,
} from "../../lib/public-ai/session";
import { validateFile } from "../../lib/public-ai/file-validate";
import { validateImage, processImage, isImageExtension } from "../../lib/public-ai/image-validate";
import { storeImage } from "../../lib/public-ai/image-store";
import { extractText, ExtractionError } from "../../lib/public-ai/file-extract";
import { extractDataset, DatasetExtractionError } from "../../lib/public-ai/dataset-extract";
import { scanContent, scanCodeContent } from "../../lib/public-ai/content-safety";
import {
  storeFile,
  getTotalCharsForSession,
  MAX_TEXT_CHARS_PER_FILE,
  MAX_TOTAL_CHARS_PER_SESSION,
  MAX_RAW_BYTES_PER_FILE,
} from "../../lib/public-ai/file-store";
import {
  persistFileContext,
  type PersistFileContextInput,
} from "../../lib/public-ai/file-context-store";
import { persistOraAssetStrict, type PersistOraAssetInput } from "../../lib/ora-assets";
import { AssetAdmissionError } from "../../lib/asset-registry";
import { MAX_INLINE_ASSET_ANALYSIS_BYTES } from "../../lib/asset-analysis";
import { readAssetBuffer } from "../../lib/asset-r2";
import { oraUploadLimiter, oraImageUploadLimiter } from "../../lib/rateLimit";
import { logger } from "../../lib/logger";
import { isKillSwitchActive, killSwitchBody } from "../../lib/public-ai/ora-kill-switches";
import { resolveAuthedOraUser } from "../../lib/public-ai/authed-user";
import { checkOraProjectWritable } from "../../lib/public-ai/ora-projects";

const router = Router();

type OfficeRawMemory = {
  rawBase64: string;
  rawSizeBytes: number;
  rawFileType: "docx" | "pptx" | "xlsx";
};

function officeRawMemoryFor(fileType: string, buffer: Buffer): Partial<OfficeRawMemory> {
  if (fileType !== "docx" && fileType !== "pptx" && fileType !== "xlsx") return {};
  if (buffer.length > MAX_RAW_BYTES_PER_FILE) return {};
  return {
    rawBase64: buffer.toString("base64"),
    rawSizeBytes: buffer.length,
    rawFileType: fileType,
  };
}

async function persistUploadMirrors(input: {
  asset: PersistOraAssetInput;
  context: Omit<PersistFileContextInput, "assetId">;
}): Promise<number> {
  const assetId = await persistOraAssetStrict(input.asset);
  try {
    await persistFileContext({ ...input.context, assetId });
  } catch (err) {
    // The raw bytes are safely present in the Library. The in-memory context
    // remains usable for this session, so report the durable mirror problem in
    // logs without pretending the asset write failed.
    logger.error({ component: "ora-upload", err }, "Failed to persist Ora file context");
  }
  return assetId;
}

function sendAssetAdmissionFailure(res: import("express").Response, error: unknown): void {
  if (error instanceof AssetAdmissionError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  logger.error(
    { component: "ora-upload", errorClass: error instanceof Error ? error.name : "unknown" },
    "Failed to persist signed-in Ora upload",
  );
  res.status(503).json({
    error: "Your file could not be saved right now. Please try again.",
    code: "asset_storage_unavailable",
  });
}

/**
 * Finish the signed-in Ora upload after the account asset route has streamed
 * the bytes into private R2. This endpoint creates metadata/context only: it
 * never accepts a multipart body and never writes a second copy of the bytes.
 */
router.post("/public-ai/upload/attach", async (req, res) => {
  if (isKillSwitchActive("file_upload")) {
    res.status(503).json(killSwitchBody("file_upload"));
    return;
  }
  const sessionToken = req.cookies?.["ora-session"] as string | undefined;
  const session = sessionToken ? validateSession(sessionToken) : null;
  if (!session) {
    res.status(401).json({ error: "No active session. Please start a session first." });
    return;
  }
  const authed = await resolveAuthedOraUser(req);
  if (!authed) {
    res.status(401).json({ error: "Please sign in before attaching this saved file." });
    return;
  }
  const assetId = Number((req.body as { assetId?: unknown } | undefined)?.assetId);
  if (!Number.isSafeInteger(assetId) || assetId <= 0) {
    res.status(400).json({ error: "This saved file reference is not valid." });
    return;
  }

  const rawProjectId = (req.body as { oraProjectId?: unknown } | undefined)?.oraProjectId;
  let oraProjectId: number | null = null;
  if (rawProjectId !== undefined && rawProjectId !== null && rawProjectId !== "personal") {
    const parsedProjectId = Number(rawProjectId);
    if (!Number.isSafeInteger(parsedProjectId) || parsedProjectId <= 0) {
      res.status(400).json({ error: "This Ora project reference is not valid." });
      return;
    }
    const writable = await checkOraProjectWritable(authed.userId, parsedProjectId);
    if (!writable.ok) {
      res.status(writable.status).json({ error: writable.error });
      return;
    }
    oraProjectId = parsedProjectId;
  }

  const [asset] = await db
    .select({
      id: assetsTable.id,
      filename: assetsTable.filename,
      mimeType: assetsTable.mimeType,
      sizeBytes: assetsTable.sizeBytes,
      storageKey: assetsTable.storageKey,
      kind: assetsTable.kind,
    })
    .from(assetsTable)
    .where(
      and(
        eq(assetsTable.id, assetId),
        eq(assetsTable.ownerUserId, authed.userId),
        eq(assetsTable.state, "ready"),
      ),
    )
    .limit(1);
  if (!asset) {
    res.status(404).json({ error: "This saved file is not available." });
    return;
  }

  const isImage = asset.kind === "image" || asset.mimeType.startsWith("image/");
  const libraryInput = {
    userId: authed.userId,
    oraProjectId,
    kind: isImage ? ("image" as const) : ("file" as const),
    fileName: asset.filename,
    mimeType: asset.mimeType,
    format: asset.filename.split(".").pop()?.toLowerCase() ?? null,
    unifiedAssetId: asset.id,
  };
  let libraryAssetId: number;
  try {
    libraryAssetId = await persistOraAssetStrict(libraryInput);
  } catch (error) {
    sendAssetAdmissionFailure(res, error);
    return;
  }

  // Storage acceptance is the 500 MB aggregate allowance. Analysis remains a
  // separate bounded operation so one large, valid asset can never consume the
  // application container's memory. The asset stays saved and downloadable.
  if (asset.sizeBytes > MAX_INLINE_ASSET_ANALYSIS_BYTES) {
    res.status(202).json({
      assetId: libraryAssetId,
      filename: asset.filename,
      mimeType: asset.mimeType,
      fileType: isImage ? "image" : (libraryInput.format ?? "file"),
      sizeBytes: asset.sizeBytes,
      analysisStatus: "unavailable",
      analysisMessage:
        "Your file is saved, but it is too large to analyze in chat right now. You can still find it in your Library.",
    });
    return;
  }

  let buffer: Buffer | null;
  try {
    buffer = await readAssetBuffer(asset.storageKey, MAX_INLINE_ASSET_ANALYSIS_BYTES);
  } catch (error) {
    logger.error(
      { component: "ora-upload", errorClass: error instanceof Error ? error.name : "unknown" },
      "Failed to read saved asset for chat analysis",
    );
    res.status(503).json({
      error: "Your file is saved, but its contents could not be prepared for chat right now.",
      code: "asset_analysis_unavailable",
    });
    return;
  }
  if (!buffer) {
    res.status(503).json({
      error: "Your file is saved, but its contents could not be prepared for chat right now.",
      code: "asset_analysis_unavailable",
    });
    return;
  }

  if (isImage) {
    let processed: Awaited<ReturnType<typeof processImage>>;
    try {
      processed = await processImage(buffer, asset.mimeType);
    } catch {
      res.status(422).json({
        error: "Your image is saved, but it could not be prepared for chat analysis.",
        code: "asset_analysis_unavailable",
      });
      return;
    }
    const stored = storeImage({
      sessionId: session.sessionId,
      filename: asset.filename,
      mimeType: asset.mimeType,
      sizeBytes: processed.sizeBytes,
      width: processed.width,
      height: processed.height,
      base64: processed.base64,
    });
    if (!stored.ok) {
      res.status(503).json({
        error: "Your image is saved, but it could not be attached to chat right now.",
        code: "asset_analysis_unavailable",
      });
      return;
    }
    const { token, payload } = incrementImageCount(session);
    setSessionCookie(res, token);
    res.json({
      assetId: libraryAssetId,
      imageRef: stored.imageRef,
      filename: asset.filename,
      mimeType: asset.mimeType,
      fileType: "image",
      sizeBytes: processed.sizeBytes,
      width: processed.width,
      height: processed.height,
      imageCount: payload.imageCount,
      imageLimit: IMAGE_LIMIT_VALUE,
      analysisStatus: "ready",
    });
    return;
  }

  const validation = validateFile(buffer, asset.filename, asset.mimeType);
  if (!validation.ok) {
    res.status(validation.statusCode).json({ error: validation.error });
    return;
  }
  const isDataset = validation.type === "csv" || validation.type === "xlsx";
  let extractedText = "";
  let datasetSummary: Awaited<ReturnType<typeof extractDataset>> | undefined;
  try {
    if (isDataset) {
      datasetSummary = await extractDataset(buffer, validation.type as "csv" | "xlsx");
    } else {
      extractedText = await extractText(
        buffer,
        validation.type as Exclude<typeof validation.type, "csv" | "xlsx">,
      );
    }
  } catch {
    res.status(422).json({
      error: "Your file is saved, but its contents could not be prepared for chat analysis.",
      code: "asset_analysis_unavailable",
    });
    return;
  }
  if (!isDataset) {
    const safety =
      validation.type === "zip" ? scanCodeContent(extractedText) : scanContent(extractedText);
    if (!safety.safe) {
      res.status(422).json({
        error: "Your file is saved, but its contents cannot be analyzed in chat.",
        code: "asset_analysis_unavailable",
      });
      return;
    }
  }
  const charCount = Math.min(extractedText.length, MAX_TEXT_CHARS_PER_FILE);
  const fileRef = storeFile({
    sessionId: session.sessionId,
    filename: asset.filename,
    mimeType: asset.mimeType,
    extractedText: extractedText.slice(0, charCount),
    charCount,
    ...(datasetSummary ? { datasetSummary } : {}),
    ...officeRawMemoryFor(validation.type, buffer),
  });
  try {
    await persistFileContext({
      userId: authed.userId,
      oraProjectId,
      fileRef,
      sessionId: session.sessionId,
      assetId: libraryAssetId,
      filename: asset.filename,
      mimeType: asset.mimeType,
      fileType: validation.type,
      extractedText: extractedText.slice(0, charCount),
      charCount,
      ...(datasetSummary ? { datasetSummary } : {}),
    });
  } catch (error) {
    logger.error({ component: "ora-upload", error }, "Failed to attach saved asset context");
    res.status(503).json({
      error: "Your file is saved, but it could not be attached to chat right now.",
      code: "asset_analysis_unavailable",
    });
    return;
  }
  const { token, payload } = incrementFileCount(session);
  setSessionCookie(res, token);
  res.json({
    assetId: libraryAssetId,
    fileRef,
    filename: asset.filename,
    mimeType: asset.mimeType,
    fileType: validation.type,
    charCount,
    ...(datasetSummary
      ? {
          rowCount: datasetSummary.rowCount,
          colCount: datasetSummary.colCount,
          truncated: datasetSummary.truncated,
          sanitizedCells: datasetSummary.sanitizedCellCount,
          hiddenSheetsSkipped: datasetSummary.hiddenSheetsSkipped,
        }
      : {}),
    fileCount: payload.fileCount,
    fileLimit: FILE_LIMIT_VALUE,
    analysisStatus: "ready",
  });
});

// Anonymous legacy compatibility only. Signed-in users are diverted before
// multer to the aggregate-quota streaming asset flow above, so these historic
// in-memory bounds are not account upload limits.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 1 },
});

router.post(
  "/public-ai/upload",
  // ── Kill switch (before auth + multer for fast, body-safe rejection) ────
  (req, res, next) => {
    if (isKillSwitchActive("file_upload")) {
      req.resume();
      res.status(503).json(killSwitchBody("file_upload"));
      res.once("finish", () => req.socket?.end());
      return;
    }
    next();
  },
  // Auth guard is FIRST — before the rate limiter and multer — so that
  // unauthenticated requests get a fast 401 without any response headers
  // being touched.
  // req.resume() drains the incoming multipart body stream immediately.
  // socket.end() (in the finish handler) half-closes the TCP connection so
  // supertest's ephemeral server.close() resolves in < 10 ms instead of
  // waiting on Node.js's default 5-second keep-alive timeout.
  (req, res, next) => {
    const sessionToken = req.cookies?.["ora-session"] as string | undefined;
    if (!sessionToken) {
      req.resume();
      res.status(401).json({ error: "No active session. Please start a session first." });
      res.once("finish", () => req.socket?.end());
      return;
    }
    const session = validateSession(sessionToken);
    if (!session) {
      req.resume();
      res.status(401).json({ error: "Session expired. Please start a new session." });
      res.once("finish", () => req.socket?.end());
      return;
    }
    next();
  },
  async (req, res, next) => {
    const authed = await resolveAuthedOraUser(req);
    if (!authed) {
      next();
      return;
    }
    // Signed-in uploads must use the account asset reservation + streamed PUT
    // path. Reject before multer so a large body is never accumulated in RAM.
    req.resume();
    res.status(409).json({
      error: "Please retry this upload so it can be saved to your account safely.",
      code: "asset_stream_upload_required",
    });
    res.once("finish", () => req.socket?.end());
  },
  oraUploadLimiter,
  (req, res, next) => {
    upload.single("file")(req, res, (err) => {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({
          error: "File exceeds the 100 MB limit. Please upload a smaller file.",
        });
        return;
      }
      if (err) {
        res.status(400).json({ error: "File upload failed. Please try again." });
        return;
      }
      next();
    });
  },
  async (req, res) => {
    const sessionToken = req.cookies["ora-session"] as string;
    const session = validateSession(sessionToken)!;

    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "No file was attached. Please select a file to upload." });
      return;
    }

    // Signed-in users store one account-wide asset and link Ora Library
    // metadata to it before the response is earned.
    const { resolveAuthedOraUser } = await import("../../lib/public-ai/authed-user");
    const authed = await resolveAuthedOraUser(req);

    // ── Ora project scoping (optional multipart text field) ────────────────
    // Signed-in uploads may target a project space. Invalid targets are
    // rejected up-front (before any byte processing) so an upload is never
    // silently filed into the wrong space. Anonymous sessions have no
    // projects — the field is ignored for them. "personal" / empty = Personal.
    let oraProjectId: number | null = null;
    {
      const rawProjectId = (req.body as Record<string, unknown> | undefined)?.oraProjectId;
      if (
        authed &&
        typeof rawProjectId === "string" &&
        rawProjectId.trim() !== "" &&
        rawProjectId.trim() !== "personal"
      ) {
        const parsedId = Number(rawProjectId);
        if (!Number.isInteger(parsedId) || parsedId <= 0) {
          res.status(400).json({ error: "Invalid project id" });
          return;
        }
        const { checkOraProjectWritable } = await import("../../lib/public-ai/ora-projects");
        const check = await checkOraProjectWritable(authed.userId, parsedId);
        if (!check.ok) {
          res.status(check.status).json({ error: check.error });
          return;
        }
        oraProjectId = parsedId;
      }
    }

    // ── Image branch ────────────────────────────────────────────────────────
    if (isImageExtension(file.originalname)) {
      // Apply the image-specific per-IP rate limit inline (the broader
      // oraUploadLimiter already ran as route middleware). createLimiter is
      // SYNCHRONOUS: it either calls next() (under the limit) or sends a 429
      // itself WITHOUT calling next(). The old `new Promise` that resolved only
      // from the next() callback therefore hung forever on the 429 path. A
      // synchronous "passed" flag captures whether next() fired; if not (or a
      // response was already sent), the limiter handled the 429 and we return.
      let passedImageLimiter = false;
      oraImageUploadLimiter(req, res, () => {
        passedImageLimiter = true;
      });
      if (!passedImageLimiter || res.headersSent) return;

      // Uploads are unlimited for signed-in users — Ora meters them only by the
      // rolling-window message/image quotas, never by upload counts. Anonymous visitors
      // keep the per-session cap. Check BEFORE validating file bytes; only
      // increment after a successful store so rejected files don't consume it.
      if (!authed && session.imageCount >= IMAGE_LIMIT_VALUE) {
        res.status(429).json({
          error: `You have reached the image limit for this session (${IMAGE_LIMIT_VALUE} images). Start a new session to upload more.`,
          imageCount: session.imageCount,
          imageLimit: IMAGE_LIMIT_VALUE,
        });
        return;
      }

      const validation = validateImage(file.buffer, file.originalname);
      if (!validation.ok) {
        res.status(validation.statusCode).json({ error: validation.error });
        return;
      }

      let processed: Awaited<ReturnType<typeof processImage>>;
      try {
        processed = await processImage(file.buffer, validation.mimeType);
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.message
            : "This image could not be processed. Please try a different image file.";
        res.status(422).json({ error: msg });
        return;
      }

      const storeResult = storeImage({
        sessionId: session.sessionId,
        filename: validation.sanitizedName,
        mimeType: validation.mimeType,
        sizeBytes: processed.sizeBytes,
        width: processed.width,
        height: processed.height,
        base64: processed.base64,
      });

      if (!storeResult.ok) {
        res.status(503).json({ error: storeResult.error });
        return;
      }

      let libraryAssetId: number | null = null;
      if (authed) {
        try {
          libraryAssetId = await persistOraAssetStrict({
            userId: authed.userId,
            oraProjectId,
            kind: "image",
            fileName: validation.sanitizedName,
            mimeType: validation.mimeType,
            base64: processed.base64.replace(/^data:[^;]+;base64,/, ""),
          });
        } catch (error) {
          sendAssetAdmissionFailure(res, error);
          return;
        }
      }

      // Increment imageCount only after durable quota admission and storage.
      const { token, payload } = incrementImageCount(session);
      setSessionCookie(res, token);

      logger.info(
        {
          component: "ora-upload",
          fileType: validation.type,
          sizeBytes: processed.sizeBytes,
          width: processed.width,
          height: processed.height,
          wasDownscaled: processed.wasDownscaled,
          imageCount: payload.imageCount,
        },
        "Ora image uploaded and processed",
      );

      res.json({
        imageRef: storeResult.imageRef,
        filename: validation.sanitizedName,
        mimeType: validation.mimeType,
        fileType: "image",
        sizeBytes: processed.sizeBytes,
        width: processed.width,
        height: processed.height,
        imageCount: payload.imageCount,
        imageLimit: IMAGE_LIMIT_VALUE,
        ...(libraryAssetId === null ? {} : { assetId: libraryAssetId }),
      });
      return;
    }

    // ── Document / dataset branch ────────────────────────────────────────────
    // Uploads are unlimited for signed-in users; anonymous visitors keep the cap.
    if (!authed && session.fileCount >= FILE_LIMIT_VALUE) {
      res.status(429).json({
        error: `You have reached the file limit for this session (${FILE_LIMIT_VALUE} files). Start a new session to upload more.`,
        fileCount: session.fileCount,
        fileLimit: FILE_LIMIT_VALUE,
      });
      return;
    }

    const validation = validateFile(file.buffer, file.originalname, file.mimetype);
    if (!validation.ok) {
      res.status(validation.statusCode).json({ error: validation.error });
      return;
    }

    const isDataset = validation.type === "csv" || validation.type === "xlsx";

    if (isDataset) {
      let summary: Awaited<ReturnType<typeof extractDataset>>;
      try {
        summary = await extractDataset(file.buffer, validation.type as "csv" | "xlsx");
      } catch (err) {
        if (err instanceof DatasetExtractionError) {
          const code = err.code;
          if (code === "empty" || code === "no-headers" || code === "no-visible-sheet") {
            res
              .status(422)
              .json({ error: "This file appears to be empty or has no readable data." });
          } else if (code === "parse-timeout") {
            res
              .status(422)
              .json({ error: "This file took too long to process. Please try a smaller file." });
          } else if (code === "too-many-zip-entries") {
            res.status(422).json({
              error:
                "This XLSX file is too complex to analyze. Please simplify it or convert it to CSV.",
            });
          } else {
            res.status(422).json({
              error: `This file could not be read. Please try another ${validation.type.toUpperCase()} file.`,
            });
          }
        } else {
          res.status(422).json({
            error: `This file could not be read. Please try another ${validation.type.toUpperCase()} file.`,
          });
        }
        return;
      }

      const fileRef = storeFile({
        sessionId: session.sessionId,
        filename: validation.sanitizedName,
        mimeType: file.mimetype,
        extractedText: "",
        charCount: 0,
        datasetSummary: summary,
        ...officeRawMemoryFor(validation.type, file.buffer),
      });

      const { token, payload } = incrementFileCount(session);
      setSessionCookie(res, token);

      logger.info(
        {
          component: "ora-upload",
          fileType: validation.type,
          rowCount: summary.rowCount,
          colCount: summary.colCount,
          sanitizedCellCount: summary.sanitizedCellCount,
          hiddenSheetsSkipped: summary.hiddenSheetsSkipped,
          truncated: summary.truncated,
          fileCount: payload.fileCount,
        },
        "Ora dataset uploaded and profiled",
      );

      if (authed) {
        // Chained: asset first, then the context row linked via assetId so the
        // original raw bytes stay reachable for later layout-preserving edits.
        try {
          await persistUploadMirrors({
            asset: {
              userId: authed.userId,
              oraProjectId,
              kind: "file",
              fileName: validation.sanitizedName,
              mimeType: file.mimetype,
              base64: file.buffer.toString("base64"),
              sourceFileRef: fileRef,
            },
            context: {
              userId: authed.userId,
              oraProjectId,
              fileRef,
              sessionId: session.sessionId,
              filename: validation.sanitizedName,
              mimeType: file.mimetype,
              fileType: validation.type,
              extractedText: "",
              charCount: 0,
              datasetSummary: summary,
            },
          });
        } catch (error) {
          sendAssetAdmissionFailure(res, error);
          return;
        }
      }

      res.json({
        fileRef,
        filename: validation.sanitizedName,
        fileType: validation.type,
        charCount: 0,
        rowCount: summary.rowCount,
        colCount: summary.colCount,
        truncated: summary.truncated,
        fileCount: payload.fileCount,
        fileLimit: FILE_LIMIT_VALUE,
      });
      return;
    }

    let extractedText: string;
    try {
      extractedText = await extractText(
        file.buffer,
        validation.type as Exclude<typeof validation.type, "csv" | "xlsx">,
      );
    } catch (err) {
      if (err instanceof ExtractionError) {
        res.status(422).json({
          error:
            err.message === "no-text"
              ? "This file appears to be empty or contains no readable text."
              : err.message,
        });
      } else {
        res.status(422).json({
          error:
            "This file could not be read. Please try another PDF, DOCX, PPTX, TXT, or ZIP file.",
        });
      }
      return;
    }

    // ZIP digests are source code; the document malware-signature scan would
    // false-positive on ordinary code, so they get the injection-only scan.
    const safety =
      validation.type === "zip" ? scanCodeContent(extractedText) : scanContent(extractedText);
    if (!safety.safe) {
      res.status(422).json({
        error: "This document cannot be analyzed. Please upload a different file.",
      });
      return;
    }

    const sessionTotal = getTotalCharsForSession(session.sessionId);
    if (sessionTotal + extractedText.length > MAX_TOTAL_CHARS_PER_SESSION) {
      res.status(429).json({
        error:
          "You have uploaded too much document content in this session. Please start a new session to continue.",
      });
      return;
    }

    const charCount = Math.min(extractedText.length, MAX_TEXT_CHARS_PER_FILE);
    const fileRef = storeFile({
      sessionId: session.sessionId,
      filename: validation.sanitizedName,
      mimeType: file.mimetype,
      extractedText: extractedText.slice(0, charCount),
      charCount,
      ...officeRawMemoryFor(validation.type, file.buffer),
    });

    const { token, payload } = incrementFileCount(session);
    setSessionCookie(res, token);

    logger.info(
      {
        component: "ora-upload",
        fileType: validation.type,
        charCount,
        fileCount: payload.fileCount,
      },
      "Ora file uploaded and extracted",
    );

    if (authed) {
      // Chained: asset first, then the context row linked via assetId so the
      // original raw bytes stay reachable for later layout-preserving edits.
      try {
        await persistUploadMirrors({
          asset: {
            userId: authed.userId,
            oraProjectId,
            kind: "file",
            fileName: validation.sanitizedName,
            mimeType: file.mimetype,
            base64: file.buffer.toString("base64"),
            sourceFileRef: fileRef,
          },
          context: {
            userId: authed.userId,
            oraProjectId,
            fileRef,
            sessionId: session.sessionId,
            filename: validation.sanitizedName,
            mimeType: file.mimetype,
            fileType: validation.type,
            extractedText: extractedText.slice(0, charCount),
            charCount,
          },
        });
      } catch (error) {
        sendAssetAdmissionFailure(res, error);
        return;
      }
    }

    res.json({
      fileRef,
      filename: validation.sanitizedName,
      fileType: validation.type,
      charCount,
      fileCount: payload.fileCount,
      fileLimit: FILE_LIMIT_VALUE,
    });
  },
);

export default router;
