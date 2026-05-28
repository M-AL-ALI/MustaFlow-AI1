import { Router } from "express";
import multer from "multer";
import {
  validateSession,
  incrementFileCount,
  setSessionCookie,
  FILE_LIMIT_VALUE,
} from "../../lib/public-ai/session";
import { validateFile } from "../../lib/public-ai/file-validate";
import { extractText, ExtractionError } from "../../lib/public-ai/file-extract";
import { scanContent } from "../../lib/public-ai/content-safety";
import {
  storeFile,
  getTotalCharsForSession,
  MAX_TEXT_CHARS_PER_FILE,
  MAX_TOTAL_CHARS_PER_SESSION,
} from "../../lib/public-ai/file-store";
import { oraUploadLimiter } from "../../lib/rateLimit";
import { logger } from "../../lib/logger";

const router = Router();

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

    if (session.fileCount >= FILE_LIMIT_VALUE) {
      res.status(429).json({
        error: `You have reached the file limit for this session (${FILE_LIMIT_VALUE} files). Start a new session to upload more.`,
        fileCount: session.fileCount,
        fileLimit: FILE_LIMIT_VALUE,
      });
      return;
    }

    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "No file was attached. Please select a file to upload." });
      return;
    }

    const validation = validateFile(file.buffer, file.originalname, file.mimetype);
    if (!validation.ok) {
      res.status(validation.statusCode).json({ error: validation.error });
      return;
    }

    let extractedText: string;
    try {
      extractedText = await extractText(file.buffer, validation.type);
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
          error: "This file could not be read. Please try another PDF, DOCX, or TXT file.",
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
