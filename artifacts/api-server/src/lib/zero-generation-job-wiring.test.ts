import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const jobs = readFileSync(resolve(here, "jobs.ts"), "utf8");
const loop = readFileSync(resolve(here, "agent-loop.ts"), "utf8");
const messages = readFileSync(resolve(here, "../routes/messages.ts"), "utf8");
const provisioning = readFileSync(resolve(here, "provisioning.ts"), "utf8");
const projects = readFileSync(resolve(here, "../routes/projects.ts"), "utf8");
const backend = readFileSync(
  resolve(here, "../../../nabuflow-runtime-worker/src/runtime-backend.ts"),
  "utf8",
);

describe("Zero sealed generation product wiring", () => {
  it("propagates classified model failures before post-loop checks or either sealed wrapper", () => {
    const failureThrow = loop.indexOf("throw modelRequestFailure;");
    const postLoopChecks = loop.indexOf("// \u2500\u2500 Post-loop: run required checks");
    expect(failureThrow).toBeGreaterThan(-1);
    expect(postLoopChecks).toBeGreaterThan(failureThrow);
    expect(loop).toContain("runAgentModelRequest({");
    expect(loop).toContain("recovery: modelRequestRecovery");
    expect(loop).toContain("deadlineAt: startedAt + wallClockMs");
    expect(loop).toContain('safeEvent(input.onEvent, "model:request", JSON.stringify(diagnostic))');
    const buildStart = jobs.indexOf("const USE_AGENT_LOOP_BUILD");
    const buildLoop = jobs.indexOf("const loopRes = await runAgentLoop({", buildStart);
    const buildSeal = jobs.indexOf(
      "zeroSealedGeneration = prepareZeroSealedNodeSource({",
      buildLoop,
    );
    expect(buildStart).toBeGreaterThan(-1);
    expect(buildLoop).toBeGreaterThan(buildStart);
    expect(buildSeal).toBeGreaterThan(buildLoop);
    const refineStart = jobs.indexOf("const USE_AGENT_LOOP_REFINE");
    const refineLoop = jobs.indexOf("const loopRes = await runAgentLoop({", refineStart);
    const refineSeal = jobs.indexOf(
      "const preparedRefinement = prepareZeroSealedNodeRefinement({",
      refineLoop,
    );
    expect(refineStart).toBeGreaterThan(-1);
    expect(refineLoop).toBeGreaterThan(refineStart);
    expect(refineSeal).toBeGreaterThan(refineLoop);
  });

  it("persists the loop report with the terminal and retains it in the later report update", () => {
    expect(jobs).toContain("err instanceof AgentModelRequestError");
    expect(jobs).toContain("modelRequestFailure.failureEvidence");
    expect(jobs).toContain("report: failedReport");
    expect(jobs).toContain("...(draft ? { stagingSnapshot: sealedFailureFiles } : {})");
    expect(jobs).toContain("...(modelFailureReport ?? {})");
    expect(jobs).toContain("completionKind: modelRequestFailure.completionKind");
    expect(jobs).toContain("...(modelFailureReport ?? {})");
    expect(jobs).toMatch(
      /warnings:\s*modelFailureReport\?\.warnings\s*\?\?\s*sealedFailureReport\?\.warnings\s*\?\?\s*\[\]/,
    );
    expect(jobs).toMatch(
      /modelFailureReport\?\.suggestions\s*\?\?\s*sealedProjectRecovery\?\.suggestions\s*\?\?\s*buildFailureFixSuggestions\(\)/,
    );
  });

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

  it("routes convertible websites deliberately and keeps incompatible projects typed", () => {
    expect(jobs).toContain("resolveZeroSealedProjectRouting");
    expect(jobs).toContain("projectArtifactsTable");
    expect(jobs).toContain("ZERO_SEALED_PROJECT_TYPE_INCOMPATIBLE");
    expect(jobs).toContain("sealedProjectRecovery");
    expect(jobs).toContain("recoveryAction: sealedProjectRecovery.action");
    expect(jobs).not.toContain("Sealed Zero generation accepts Node API projects only");
  });

  it("keeps source-contract details internal and offers one real repair action", () => {
    expect(jobs).toContain("err instanceof ZeroSealedSourceContractError");
    expect(jobs).toContain("ZERO_SEALED_SOURCE_REPAIR_MESSAGE");
    expect(jobs).toContain("ZERO_SEALED_SOURCE_REPAIR_RECOVERY");
    expect(jobs).not.toContain("generateFixSuggestions(userPrompt, rawMessage)");
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
    // Endpoint-less private runtimes are provisioned when their descriptor is
    // settled. Do not pin the old condition that stranded failed builds.
    expect(jobs.includes("...sealedRuntimeProvisioningState(created.status)")).toBe(true);
    expect(jobs.includes('provisioningStatus: created.endpoint ? "ready" : "provisioning"')).toBe(
      false,
    );
    expect(provisioning.includes("await recoverStaleSealedPreviewProvisioning()")).toBe(true);
    expect(jobs).toContain("healthPath: opts.zeroSealedGeneration.manifest.healthPath");
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
