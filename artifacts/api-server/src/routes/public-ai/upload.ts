import { Router } from "express";
import multer from "multer";
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
import { scanContent } from "../../lib/public-ai/content-safety";
import {
  storeFile,
  getTotalCharsForSession,
  MAX_TEXT_CHARS_PER_FILE,
  MAX_TOTAL_CHARS_PER_SESSION,
} from "../../lib/public-ai/file-store";
import { oraUploadLimiter, oraImageUploadLimiter } from "../../lib/rateLimit";
import { resolveAuthedOraUser } from "../../lib/public-ai/authed-user";
import { persistOraAsset } from "../../lib/ora-assets";
import { logger } from "../../lib/logger";

const router = Router();

// Multer limit kept at 10 MB to accommodate documents.
// Image-specific 4 MB cap is enforced in validateImage() using the buffer.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

router.post(
  "/public-ai/upload",
  oraUploadLimiter,
  (req, res, next) => {
    upload.single("file")(req, res, (err) => {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({
          error: "File exceeds the 10 MB limit. Please upload a smaller file.",
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
    const sessionToken = req.cookies?.["ora-session"] as string | undefined;
    if (!sessionToken) {
      res.status(401).json({ error: "No active session. Please start a session first." });
      return;
    }

    const session = validateSession(sessionToken);
    if (!session) {
      res.status(401).json({ error: "Session expired. Please start a new session." });
      return;
    }

    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "No file was attached. Please select a file to upload." });
      return;
    }

    // Signed-in users get their uploads copied into the durable Ora asset
    // library so they show up under Library across devices. Best-effort.
    const authed = await resolveAuthedOraUser(req);

    // ── Image branch ────────────────────────────────────────────────────────
    if (isImageExtension(file.originalname)) {
      // Apply image-specific per-IP rate limit inline (middleware already ran oraUploadLimiter)
      // The oraImageUploadLimiter is applied as a separate middleware via a sub-handler.
      await new Promise<void>((resolve) => {
        oraImageUploadLimiter(req, res, () => resolve());
      });
      if (res.headersSent) return;

      // Uploads are unlimited for signed-in users — Ora meters them only by the
      // daily message/image quotas, never by upload counts. Anonymous visitors
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

      // Increment imageCount ONLY after successful validation + store.
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

      if (authed) {
        void persistOraAsset({
          userId: authed.userId,
          kind: "image",
          fileName: validation.sanitizedName,
          mimeType: validation.mimeType,
          base64: processed.base64.replace(/^data:[^;]+;base64,/, ""),
        });
      }

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
        void persistOraAsset({
          userId: authed.userId,
          kind: "file",
          fileName: validation.sanitizedName,
          mimeType: file.mimetype,
          base64: file.buffer.toString("base64"),
        });
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
          error: "This file could not be read. Please try another PDF, DOCX, PPTX, or TXT file.",
        });
      }
      return;
    }

    const safety = scanContent(extractedText);
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
      void persistOraAsset({
        userId: authed.userId,
        kind: "file",
        fileName: validation.sanitizedName,
        mimeType: file.mimetype,
        base64: file.buffer.toString("base64"),
      });
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
