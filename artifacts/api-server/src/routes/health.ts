import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import {
  getContainerSubsystemStatus,
  getTenantRuntimeConfigurationStatus,
} from "../lib/tenant-runtime";
import { getEncryptionKeyStatus } from "../lib/encryption";
import { zeroPromptQueueSchemaContractState } from "../lib/schema-contract-state";
import { startupHealthState, type StartupCheckStatus } from "../lib/startup-health-state";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const subsystem = getContainerSubsystemStatus();
  const runtimeConfiguration = getTenantRuntimeConfigurationStatus();
  const startup = startupHealthState.read();
  const queueSchemaContract = zeroPromptQueueSchemaContractState.read();
  const queueSchemaContractStatus: StartupCheckStatus =
    queueSchemaContract.status === "starting"
      ? "unknown"
      : queueSchemaContract.status === "ready"
        ? "ok"
        : "error";
  const data = HealthCheckResponse.parse({
    status: runtimeConfiguration.status === "partial-config" ? "partial-config" : "ok",
    containerSubsystem: subsystem ?? "unknown",
    encryptionKey: getEncryptionKeyStatus(),
    startupMigrations: startup.migrations,
    queueSchemaContract: queueSchemaContractStatus,
    ...(runtimeConfiguration.status === "partial-config"
      ? { missingRuntimeBindings: runtimeConfiguration.missingBindings }
      : {}),
  });
  res.status(runtimeConfiguration.status === "partial-config" ? 503 : 200).json(data);
});

export default router;
