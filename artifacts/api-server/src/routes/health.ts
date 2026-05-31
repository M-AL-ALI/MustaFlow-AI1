import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { getContainerSubsystemStatus } from "../lib/container";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const subsystem = getContainerSubsystemStatus();
  const data = HealthCheckResponse.parse({
    status: "ok",
    ...(subsystem !== null ? { containerSubsystem: subsystem } : {}),
  });
  res.json(data);
});

export default router;
