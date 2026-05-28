import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { isOraSecretConfigured } from "../../lib/public-ai/session";
import sessionRouter from "./session";
import chatRouter from "./chat";

const router = Router();

router.use((req: Request, res: Response, next: NextFunction) => {
  if (process.env.PUBLIC_AI_ENABLED === "false") {
    res.status(503).json({ error: "Ora is currently unavailable" });
    return;
  }
  if (!isOraSecretConfigured()) {
    res.status(503).json({ error: "Ora is currently unavailable" });
    return;
  }
  next();
});

router.use(sessionRouter);
router.use(chatRouter);

export default router;
