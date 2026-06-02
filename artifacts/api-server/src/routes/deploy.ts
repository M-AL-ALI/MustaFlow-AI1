// ─────────────────────────────────────────────────────────────────────────────
// Legacy deploy route — POST /api/projects/:id/deploy
//
// This route has been retired. All production deployments must go through the
// approved-snapshot publish pipeline:
//   POST /api/projects/:id/publish?env=production
//
// The old route published live project_files directly, bypassing the
// testing-approval gate and the snapshot immutability guarantee. It is now a
// hard 410 Gone so existing callers receive a clear migration message.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { requireProjectOwnership } from "../lib/auth";

const router: IRouter = Router();

router.post("/projects/:id/deploy", requireProjectOwnership, (_req, res): void => {
  res.status(410).json({
    error:
      "POST /api/projects/:id/deploy has been retired. " +
      "Use POST /api/projects/:id/publish?env=production instead. " +
      "The publish pipeline enforces snapshot immutability and testing-approval gates.",
    code: "route_retired",
    migrateToRoute: "POST /api/projects/:id/publish?env=production",
  });
});

export default router;
