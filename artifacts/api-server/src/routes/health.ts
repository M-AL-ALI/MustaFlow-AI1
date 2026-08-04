import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { getContainerSubsystemStatus } from "../lib/tenant-runtime";
import { getEncryptionKeyStatus } from "../lib/encryption";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const subsystem = getContainerSubsystemStatus();
  const data = HealthCheckResponse.parse({
    status: "ok",
    ...(subsystem !== null ? { containerSubsystem: subsystem } : {}),
    encryptionKey: getEncryptionKeyStatus(),
  });
  res.json(data);
});

export default router;
