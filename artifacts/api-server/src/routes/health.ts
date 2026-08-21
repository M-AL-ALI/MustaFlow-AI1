import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { getContainerSubsystemStatus } from "../lib/tenant-runtime";
import { getEncryptionKeyStatus } from "../lib/encryption";
import { zeroPromptQueueSchemaContractState } from "../lib/schema-contract-state";
import { startupHealthState, type StartupCheckStatus } from "../lib/startup-health-state";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const subsystem = getContainerSubsystemStatus();
  const startup = startupHealthState.read();
  const queueSchemaContract = zeroPromptQueueSchemaContractState.read();
  const queueSchemaContractStatus: StartupCheckStatus =
    queueSchemaContract.status === "starting"
      ? "unknown"
      : queueSchemaContract.status === "ready"
        ? "ok"
        : "error";
  const data = HealthCheckResponse.parse({
    status: "ok",
    containerSubsystem: subsystem ?? "unknown",
    encryptionKey: getEncryptionKeyStatus(),
    startupMigrations: startup.migrations,
    queueSchemaContract: queueSchemaContractStatus,
  });
  res.json(data);
});

export default router;
