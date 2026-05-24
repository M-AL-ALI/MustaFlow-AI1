/**
 * Prometheus metrics endpoint.
 * Served at GET /api/metrics — protected behind a bearer token when
 * METRICS_TOKEN env var is set (strongly recommended in production).
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { registry, updateCircuitBreakerMetrics } from "../lib/metrics";

const router: IRouter = Router();

router.get("/metrics", async (req: Request, res: Response): Promise<void> => {
  const token = process.env.METRICS_TOKEN;
  if (token) {
    const auth = req.headers.authorization ?? "";
    const provided = auth.startsWith("Bearer ") ? auth.slice(7) : (req.query["token"] as string);
    if (provided !== token) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }

  updateCircuitBreakerMetrics();

  const metrics = await registry.metrics();
  res.set("Content-Type", registry.contentType);
  res.end(metrics);
});

export default router;
