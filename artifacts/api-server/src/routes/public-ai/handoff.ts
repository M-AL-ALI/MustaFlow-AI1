// Builder handoff is permanently disabled.
// POST /api/public-ai/handoff/create always returns 410 Gone — no token is generated.

import { Router } from "express";

const router = Router();

router.post("/public-ai/handoff/create", (_req, res) => {
  res.status(410).json({ error: "Builder handoff has been permanently disabled." });
});

export default router;
