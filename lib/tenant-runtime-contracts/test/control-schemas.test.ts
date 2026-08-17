import { beforeAll, describe, expect, it } from "vitest";
import { capabilityDefinitionSchema, routeRecordSchema } from "../src/route-capability";
import { deriveRuntimeIdentity } from "../src/runtime-identity";
import { tenantServicePortSchema } from "../src/service-port";
import {
  CONTROL_API_PREFIX,
  controlEndpointContracts,
  controlEndpointSchemas,
  controlErrorResponseSchema,
  RUNTIME_RECONCILIATION_SEMANTICS_VERSION,
  runtimeDescriptorSchema,
} from "../src/control-schemas";

const locator = { projectId: 42, role: "preview", slot: "primary" } as const;
const manifest = {
  revision: "manifest-42-v7",
  runtime: "node-22",
  buildCommand: ["npm", "run", "build"],
  startCommand: ["npm", "run", "start"],
  servicePort: 8080,
  healthPath: "/healthz",
  resourceProfile: "small",
  public: false,
} as const;
const digest = "a".repeat(64);
let sandboxIdentity = "";
let productionSandboxIdentity = "";

beforeAll(async () => {
  sandboxIdentity = await deriveRuntimeIdentity({
    namespace: "production-us-east",
    ...locator,
  });
  productionSandboxIdentity = await deriveRuntimeIdentity({
    namespace: "production-us-east",
    projectId: 42,
    role: "production",
    slot: "blue",
  });
});

function runtimeDescriptor() {
  return {
    identity: sandboxIdentity,
    projectId: 42,
    role: "preview",
    slot: "primary",
    status: "running",
    servicePort: 8080,
    manifestRevision: "manifest-42-v7",
    deploymentVersion: "worker-2026-08-04.1",
    endpoint: "https://opaque.preview.mustaflow.com",
    readyAt: "2026-08-04T12:00:00.000Z",
    lastError: null,
  } as const;
}

function requestFixtures(): Record<keyof typeof controlEndpointSchemas, unknown> {
  return {
    version: {},
    ensure: {
      locator,
      expectedDeploymentVersion: "worker-2026-08-04.1",
      manifest,
    },
    start: {
      locator,
      expectedDeploymentVersion: "worker-2026-08-04.1",
      artifactRevision: "snapshot-42-v7",
      artifactSha256: digest,
    },
    stop: { locator, reason: "idle policy" },
    destroy: { locator, reason: "project deleted" },
    status: { locator },
    reconcile: {
      locator,
      expectedStatus: "error",
      expectedManifestRevision: manifest.revision,
      reconciliationId: "wall-12-green",
      semanticsVersion: RUNTIME_RECONCILIATION_SEMANTICS_VERSION,
    },
    reconciliationAudit: {},
    exec: { locator, argv: ["npm", "test"], cwd: "/workspace", timeoutMs: 30_000 },
    logs: { locator, cursor: "cursor-10", limit: 200, follow: false },
    files: {
      locator,
      artifactRevision: "snapshot-42-v7",
      files: [{ path: "src/index.ts", content: "export {};", sha256: digest }],
    },
    restore: { locator, artifactRevision: "snapshot-42-v7", artifactSha256: digest },
    environment: {
      locator,
      classification: "non-secret",
      variables: { NODE_ENV: "production", PORT: "8080" },
      restart: true,
    },
    routeActivate: {
      route: {
        hostname: "project.apps.mustaflow.com",
        projectId: 42,
        role: "production",
        activeSlot: "blue",
        manifestRevision: "manifest-42-v7",
        servicePort: 8080,
        sandboxIdentity: productionSandboxIdentity,
      },
      expectedPreviousManifestRevision: "manifest-42-v6",
    },
    routeDeactivate: {
      hostname: "project.apps.mustaflow.com",
      expectedManifestRevision: "manifest-42-v7",
      expectedSandboxIdentity: productionSandboxIdentity,
    },
  };
}

function responseFixtures(): Record<keyof typeof controlEndpointSchemas, unknown> {
  const runtime = runtimeDescriptor();
  const observation = {
    attempt: 1,
    observedAt: "2026-08-04T12:00:00.000Z",
    stage: "health",
    cause: "ready",
    status: 200,
    sources: ["provider-metadata", "process-probe", "health-probe"],
    decisionInputs: {
      storedStatus: "error",
      storedProcessIdentity: "absent",
      providerProcess: "running",
      health: "ready",
    },
    decision: "ready",
    repairAction: "reregister-and-rebind",
  } as const;
  const terminal = {
    at: "2026-08-04T12:00:01.000Z",
    status: 200,
    code: "ok",
    retryable: false,
  } as const;
  const evidence = {
    semanticsVersion: RUNTIME_RECONCILIATION_SEMANTICS_VERSION,
    reconciliationId: "wall-12-green",
    trail: [observation],
    terminal,
  } as const;
  return {
    version: {
      protocolVersion: "1",
      deploymentVersion: "worker-2026-08-04.1",
      provider: "cloudflare",
      supportedRoles: ["preview", "production"],
      features: ["artifact-v1", "manifest-update-v1"],
    },
    ensure: { runtime },
    start: { runtime },
    stop: { runtime: { ...runtime, status: "stopped" } },
    destroy: { ok: true },
    status: { runtime },
    reconcile: {
      ok: true,
      reconciliationId: "wall-12-green",
      outcome: "restored",
      observation: {
        attempts: 1,
        stage: "health",
        cause: "ready",
        status: 200,
        repairAction: "reregister-and-rebind",
      },
      capability: "bound",
      runtime,
      repairJob: null,
      evidence,
    },
    reconciliationAudit: {
      ok: true,
      record: {
        requestId: "reconciliation-request-1",
        reconciliationId: "wall-12-green",
        semanticsVersion: RUNTIME_RECONCILIATION_SEMANTICS_VERSION,
        locator,
        createdAt: "2026-08-04T12:00:00.000Z",
        updatedAt: "2026-08-04T12:00:01.000Z",
        trail: [observation],
        terminal,
      },
    },
    exec: { ok: true, stdout: "ok\n", stderr: "", exitCode: 0, timedOut: false },
    logs: {
      entries: [
        {
          cursor: "cursor-11",
          timestamp: "2026-08-04T12:00:00.000Z",
          level: "stdout",
          message: "ready",
        },
      ],
      nextCursor: "cursor-11",
    },
    files: { ok: true, artifactRevision: "snapshot-42-v7", filesWritten: 1 },
    restore: { ok: true, artifactRevision: "snapshot-42-v7", filesRestored: 1 },
    environment: { runtime },
    routeActivate: {
      ok: true,
      route: {
        hostname: "project.apps.mustaflow.com",
        projectId: 42,
        role: "production",
        activeSlot: "blue",
        manifestRevision: "manifest-42-v7",
        servicePort: 8080,
        sandboxIdentity: productionSandboxIdentity,
      },
    },
    routeDeactivate: { ok: true, hostname: "project.apps.mustaflow.com" },
  };
}

describe("control-plane schemas", () => {
  it("covers the complete approved endpoint set", () => {
    expect(Object.keys(controlEndpointSchemas)).toEqual([
      "version",
      "ensure",
      "start",
      "stop",
      "destroy",
      "status",
      "reconcile",
      "reconciliationAudit",
      "exec",
      "logs",
      "files",
      "restore",
      "environment",
      "routeActivate",
      "routeDeactivate",
    ]);
    expect(Object.keys(controlEndpointContracts)).toEqual(Object.keys(controlEndpointSchemas));
    expect(CONTROL_API_PREFIX).toBe("/_nabuflow/control/v1");
    for (const contract of Object.values(controlEndpointContracts)) {
      expect(contract.path.startsWith(`${CONTROL_API_PREFIX}/`)).toBe(true);
    }
  });

  it("accepts a complete valid request and response for every endpoint", () => {
    const requests = requestFixtures();
    const responses = responseFixtures();
    for (const name of Object.keys(controlEndpointSchemas) as Array<
      keyof typeof controlEndpointSchemas
    >) {
      expect(controlEndpointSchemas[name].request.safeParse(requests[name]).success, name).toBe(
        true,
      );
      expect(controlEndpointSchemas[name].response.safeParse(responses[name]).success, name).toBe(
        true,
      );
    }
  });

  it("rejects unknown top-level fields on every request and response", () => {
    const requests = requestFixtures();
    const responses = responseFixtures();
    for (const name of Object.keys(controlEndpointSchemas) as Array<
      keyof typeof controlEndpointSchemas
    >) {
      expect(
        controlEndpointSchemas[name].request.safeParse({
          ...(requests[name] as Record<string, unknown>),
          unexpected: true,
        }).success,
        `${name} request`,
      ).toBe(false);
      expect(
        controlEndpointSchemas[name].response.safeParse({
          ...(responses[name] as Record<string, unknown>),
          unexpected: true,
        }).success,
        `${name} response`,
      ).toBe(false);
    }
  });

  it("rejects unknown nested fields and invalid role/slot combinations", () => {
    const ensure = requestFixtures().ensure as {
      locator: typeof locator;
      expectedDeploymentVersion: string;
      manifest: typeof manifest;
    };
    expect(
      controlEndpointSchemas.ensure.request.safeParse({
        ...ensure,
        manifest: { ...ensure.manifest, unexpected: true },
      }).success,
    ).toBe(false);
    expect(
      controlEndpointSchemas.status.request.safeParse({
        locator: { projectId: 42, role: "preview", slot: "blue" },
      }).success,
    ).toBe(false);
  });

  it.each(["../secret", "src/../secret", "/absolute/file", "src\\windows.ts", "./dot.ts"])(
    "rejects unsafe runtime file path %j",
    (path) => {
      const files = requestFixtures().files as {
        locator: typeof locator;
        artifactRevision: string;
        files: Array<{ path: string; content: string; sha256: string }>;
      };
      expect(
        controlEndpointSchemas.files.request.safeParse({
          ...files,
          files: [{ ...files.files[0], path }],
        }).success,
      ).toBe(false);
    },
  );

  it("rejects NUL argv entries and non-absolute working directories", () => {
    const exec = requestFixtures().exec as Record<string, unknown>;
    expect(
      controlEndpointSchemas.exec.request.safeParse({ ...exec, argv: ["echo", "bad\0value"] })
        .success,
    ).toBe(false);
    expect(
      controlEndpointSchemas.exec.request.safeParse({ ...exec, cwd: "relative/path" }).success,
    ).toBe(false);
  });

  it("uses a strict, bounded common error envelope", () => {
    const error = {
      ok: false,
      code: "runtime_not_ready",
      message: "Runtime is still waking",
      retryable: true,
      requestId: "request-1",
    };
    expect(controlErrorResponseSchema.safeParse(error).success).toBe(true);
    expect(controlErrorResponseSchema.safeParse({ ...error, stack: "secret" }).success).toBe(false);
  });

  it("rejects descriptors whose identity disagrees with project, role, or slot", () => {
    expect(runtimeDescriptorSchema.safeParse(runtimeDescriptor()).success).toBe(true);
    expect(
      runtimeDescriptorSchema.safeParse({ ...runtimeDescriptor(), projectId: 43 }).success,
    ).toBe(false);
  });
});

describe("route and capability records", () => {
  it("validates an identity-bound route record", () => {
    const route = {
      hostname: "project.apps.mustaflow.com",
      projectId: 42,
      role: "production",
      activeSlot: "blue",
      manifestRevision: "manifest-42-v7",
      servicePort: 8080,
      sandboxIdentity: productionSandboxIdentity,
    };
    expect(routeRecordSchema.safeParse(route).success).toBe(true);
    expect(
      routeRecordSchema.safeParse({ ...route, hostname: "PROJECT.apps.mustaflow.com" }).success,
    ).toBe(false);
    expect(routeRecordSchema.safeParse({ ...route, projectId: 43 }).success).toBe(false);
    expect(routeRecordSchema.safeParse({ ...route, activeSlot: "primary" }).success).toBe(false);
  });

  it("validates a bounded typed connector capability", () => {
    const capability = {
      name: "stripe-test",
      provider: "stripe",
      allowedMethods: ["POST"],
      allowedPaths: [
        { match: "exact", path: "/v1/payment-intents" },
        { match: "prefix", path: "/v1/customers/" },
      ],
      injection: { location: "authorization-header", scheme: "Bearer" },
      limits: {
        timeoutMs: 10_000,
        maxRequestBytes: 1_000_000,
        maxResponseBytes: 1_000_000,
        maxRequestsPerMinute: 60,
        maxConcurrent: 5,
      },
    };
    expect(capabilityDefinitionSchema.safeParse(capability).success).toBe(true);
    expect(
      capabilityDefinitionSchema.safeParse({
        ...capability,
        allowedMethods: ["POST", "POST"],
      }).success,
    ).toBe(false);
    expect(
      capabilityDefinitionSchema.safeParse({ ...capability, allowedMethods: ["CONNECT"] }).success,
    ).toBe(false);
    expect(
      capabilityDefinitionSchema.safeParse({ ...capability, extraCredential: "must-not-pass" })
        .success,
    ).toBe(false);
  });

  it.each([1023, 3000, 65536, 8080.5])("rejects forbidden tenant service port %s", (port) => {
    expect(tenantServicePortSchema.safeParse(port).success).toBe(false);
  });

  it.each([1024, 2999, 3001, 8080, 65535])("accepts tenant service port %s", (port) => {
    expect(tenantServicePortSchema.safeParse(port).success).toBe(true);
  });
});
