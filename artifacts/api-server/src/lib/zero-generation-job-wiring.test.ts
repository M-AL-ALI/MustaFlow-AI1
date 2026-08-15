import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const jobs = readFileSync(resolve(here, "jobs.ts"), "utf8");
const messages = readFileSync(resolve(here, "../routes/messages.ts"), "utf8");
const provisioning = readFileSync(resolve(here, "provisioning.ts"), "utf8");
const projects = readFileSync(resolve(here, "../routes/projects.ts"), "utf8");
const backend = readFileSync(
  resolve(here, "../../../nabuflow-runtime-worker/src/runtime-backend.ts"),
  "utf8",
);

describe("Zero sealed generation product wiring", () => {
  it("selects the target from deployment state and never from the public route", () => {
    expect(jobs).toContain("resolveZeroGenerationTarget(process.env)");
    expect(jobs).toContain("isZeroSealedGenerationTarget(zeroGenerationTarget)");
    expect(messages).not.toContain("modelAdapter");
    expect(messages).not.toContain("zeroGenerationTarget");
  });

  it("routes sealed delivery through Pantry and the dock without legacy injection", () => {
    expect(jobs).toContain("runZeroGenerationKitchen(tenantRuntimeProvider");
    expect(jobs).toContain("signal: opts.signal");
    expect(jobs).toContain("supportsZeroGeneration(tenantRuntimeProvider)");
    expect(jobs).toContain("!isZeroSealedGenerationTarget(zeroGenerationTarget)");
    expect(jobs).toContain("syncFilesToContainer");
    expect(jobs).toContain("npmInstallInBackground");
  });

  it("lets an incomplete sealed build continue through the same guarded kitchen path", () => {
    expect(jobs).not.toContain('kind !== "build" || resolvedIsMobile');
    expect(jobs).toContain("prepareZeroSealedNodeRefinement");
    expect(jobs).toContain("zeroSealedGeneration = preparedRefinement");
    expect(jobs).toContain("zeroGenerationTarget,");
  });

  it("injects only the platform-owned non-secret runtime mode after sealing", () => {
    expect(backend).toContain('[TENANT_RUNTIME_MODE_ENV]: "cloudflare-capability-v1"');
    expect(backend).not.toContain("DATABASE_URL:");
    expect(backend).not.toContain("STRIPE_SECRET_KEY:");
  });

  it("keeps sealed runtime provisioning credential-free and accepts a private running descriptor", () => {
    expect(provisioning).toContain("requiresDirectProjectDatabaseProvisioning(process.env)");
    expect(provisioning).toContain("if (!requiresDirectDatabase)");
    expect(projects).toContain("!requiresDirectDatabase || process.env.NEON_API_KEY");
    expect(projects).toContain("deploymentType: sealedDeploymentType");
    expect(jobs).not.toContain('created === null || "error" in created || !created.endpoint');
    expect(jobs).not.toContain("if (!runtimeId || !opts.containerUrl)");
    expect(jobs).not.toContain("zero-task-${taskId}-node-v1");
    expect(jobs).toContain('provisioningStatus: created.endpoint ? "ready" : "provisioning"');
    expect(jobs).toContain("runtimeId = created.runtimeId");
    expect(jobs).toContain("tenantRuntimeProvider.zeroGenerationRuntimeDescriptor(");
    expect(jobs).toContain("tenantRuntimeProvider.zeroGenerationRuntimeDescriptorForProject(");
    expect(jobs).toContain("runtimeId = existingRuntime.identity");
    expect(jobs).toContain(
      "existingRuntime.manifestRevision === opts.zeroSealedGeneration.manifest.revision",
    );
    expect(jobs).toContain("tenantRuntimeProvider.stop(runtimeId");
    expect(jobs).toContain("reused the matching healthy runtime");
    expect(jobs).not.toContain("runtime.start completed without a durable endpoint");
    expect(jobs).toContain('startedRuntime.status !== "running"');
    expect(jobs).toContain("startedRuntime.identity !== result.runtimeId");
    expect(jobs).toContain("signed grant");
    expect(jobs).toContain("containerUrl: startedRuntime.endpoint");
  });
});
