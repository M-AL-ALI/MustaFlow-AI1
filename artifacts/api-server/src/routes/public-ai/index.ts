import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { isOraSecretConfigured } from "../../lib/public-ai/session";
import { isKillSwitchActive, killSwitchBody } from "../../lib/public-ai/ora-kill-switches";
import sessionRouter from "./session";
import chatRouter from "./chat";
import uploadRouter from "./upload";
import fileAnalysisRouter from "./file-analysis";
import datasetAnalysisRouter from "./dataset-analysis";
import imageAnalysisRouter from "./image-analysis";
import handoffRouter from "./handoff";
import transcribeRouter from "./transcribe";
import ttsRouter from "./tts";
import generateFileRouter from "./generate-file";
import exportFileRouter from "./export-file";
import rememberDocumentRouter from "./remember-document";

const router = Router();

router.use((req: Request, res: Response, next: NextFunction) => {
  if (process.env.PUBLIC_AI_ENABLED === "false") {
    req.resume();
    res.status(503).json({ error: "Ora is currently unavailable" });
    return;
  }
  if (isKillSwitchActive("all")) {
    req.resume();
    res.status(503).json(killSwitchBody("all"));
    return;
  }
  if (!isOraSecretConfigured()) {
    req.resume();
    res.status(503).json({ error: "Ora is currently unavailable" });
    return;
  }
  next();
});

router.use(sessionRouter);
router.use(chatRouter);
router.use(uploadRouter);
router.use(fileAnalysisRouter);
router.use(datasetAnalysisRouter);
router.use(imageAnalysisRouter);
router.use(handoffRouter);
router.use(transcribeRouter);
router.use(ttsRouter);
router.use(generateFileRouter);
router.use(exportFileRouter);
router.use(rememberDocumentRouter);

export default router;
