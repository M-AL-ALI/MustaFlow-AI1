import { Router, type IRouter } from "express";
import { GetServedBuildIdentityResponse, HealthCheckResponse } from "@workspace/api-zod";
import {
  getContainerSubsystemStatus,
  getTenantRuntimeConfigurationStatus,
} from "../lib/tenant-runtime";
import { getEncryptionKeyStatus } from "../lib/encryption";
import { zeroPromptQueueSchemaContractState } from "../lib/schema-contract-state";
import { startupHealthState, type StartupCheckStatus } from "../lib/startup-health-state";
import { getServedBuildCommit, getServedBuildIdentity } from "../lib/build-info";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const subsystem = getContainerSubsystemStatus();
  const runtimeConfiguration = getTenantRuntimeConfigurationStatus();
  const startup = startupHealthState.read();
  const startupFailureSteps = startup.failureSteps ?? [];
  const queueSchemaContract = zeroPromptQueueSchemaContractState.read();
  const queueSchemaContractStatus: StartupCheckStatus =
    queueSchemaContract.status === "starting"
      ? "unknown"
      : queueSchemaContract.status === "ready"
        ? "ok"
        : "error";
  const data = HealthCheckResponse.parse({
    status: runtimeConfiguration.status === "partial-config" ? "degraded" : "ok",
    containerSubsystem: subsystem ?? "unknown",
    encryptionKey: getEncryptionKeyStatus(),
    startupMigrations: startup.migrations,
    ...(startup.migrations === "error" && startupFailureSteps.length > 0
      ? { startupMigrationFailureSteps: startupFailureSteps }
      : {}),
    queueSchemaContract: queueSchemaContractStatus,
    ...(queueSchemaContract.status === "unready"
      ? { queueSchemaContractViolations: queueSchemaContract.violations }
      : {}),
    buildCommit: getServedBuildCommit(),
  });
  res.status(200).json(data);
});

router.get("/version", (_req, res) => {
  res.status(200).json(GetServedBuildIdentityResponse.parse(getServedBuildIdentity()));
});

export default router;
