import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { getContainerSubsystemStatus } from "../lib/tenant-runtime";
import { getEncryptionKeyStatus } from "../lib/encryption";
import { captureAdmissionProxyTopology } from "../lib/admission-proxy-topology-capture";

const router: IRouter = Router();

router.get("/healthz", (req, res) => {
  captureAdmissionProxyTopology(req, res);
  const subsystem = getContainerSubsystemStatus();
  const data = HealthCheckResponse.parse({
    status: "ok",
    ...(subsystem !== null ? { containerSubsystem: subsystem } : {}),
    encryptionKey: getEncryptionKeyStatus(),
  });
  res.json(data);
});

export default router;
