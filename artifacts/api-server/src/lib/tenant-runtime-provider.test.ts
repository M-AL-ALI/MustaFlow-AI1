import { beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLOUDFLARE_RUNTIME_BINDING_NAMES,
  FLY_RUNTIME_BINDING_NAMES,
} from "@workspace/tenant-runtime-contracts";

const mocks = vi.hoisted(() => ({
  createContainer: vi.fn(),
  startContainer: vi.fn(),
  stopContainer: vi.fn(),
  destroyContainer: vi.fn(),
  getContainerStatus: vi.fn(),
  execInContainer: vi.fn(),
  syncFilesToContainer: vi.fn(),
  updateContainerEnv: vi.fn(),
  ensureContainerLogTailer: vi.fn(),
  recordContainerLog: vi.fn(),
  ensureFlyApp: vi.fn(async () => undefined),
  resumeContainerLogTailersOnBoot: vi.fn(async () => undefined),
}));

vi.mock("./container", () => ({
  hasContainerLayerCredentials: vi.fn(() => true),
  isContainerLayerConfigured: vi.fn(async () => true),
  runContainerSelfCheck: vi.fn(async () => "ok"),
  getContainerSubsystemStatus: vi.fn(() => "ok"),
  ensureFlyApp: mocks.ensureFlyApp,
  createContainer: mocks.createContainer,
  startContainer: mocks.startContainer,
  stopContainer: mocks.stopContainer,
  destroyContainer: mocks.destroyContainer,
  getContainerStatus: mocks.getContainerStatus,
  execInContainer: mocks.execInContainer,
  npmInstallInBackground: vi.fn(),
  writeFileToContainer: vi.fn(),
  syncFilesToContainer: mocks.syncFilesToContainer,
  updateContainerEnv: mocks.updateContainerEnv,
  restartContainerWithSecrets: vi.fn(),
  ensureContainerAwake: vi.fn(),
  provisionContainer: vi.fn(),
  hibernateContainer: vi.fn(),
  createProductionContainer: vi.fn(),
  deployProductionContainer: vi.fn(),
  patchMachineAutostop: vi.fn(),
  startContainerHealthServer: vi.fn(),
  stopContainerHealthServer: vi.fn(),
  startContainerKeepalive: vi.fn(),
  mapFlyErrorToMessage: vi.fn((raw: string) => raw),
}));

vi.mock("./container-logs", () => ({
  ensureContainerLogTailer: mocks.ensureContainerLogTailer,
  recordContainerLog: mocks.recordContainerLog,
  stopContainerLogTailer: vi.fn(),
  resumeContainerLogTailersOnBoot: mocks.resumeContainerLogTailersOnBoot,
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn() },
}));

// Provider selection is a pure contract test. Asset resolution has its own
// focused suite and must not pull the database into this boundary.
vi.mock("./project-file-asset-reference", () => ({
  resolveProjectRuntimeFiles: vi.fn(async (_projectId: number, files: unknown[]) => files),
}));

import { FlyRuntimeProvider } from "./fly-runtime-provider";
import { CloudflareRuntimeProvider } from "./cloudflare-runtime-provider";
import { PartialConfigRuntimeProvider } from "./partial-config-runtime-provider";
import {
  RuntimeProviderUnavailableError,
  supportsArtifactDeployment,
  supportsLayeredArtifactDeployment,
  supportsZeroGeneration,
  supportsExternalRuntimeLogTail,
  type TenantRuntimeProvider,
} from "./tenant-runtime-provider";

describe("TenantRuntimeProvider Fly adapter", () => {
  let provider: TenantRuntimeProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new FlyRuntimeProvider();
  });

  it("maps provider-specific create and exec results to neutral runtime shapes", async () => {
    mocks.createContainer.mockResolvedValue({
      containerId: "runtime-1",
      containerUrl: "https://mustaflow-containers.fly.dev/container/runtime-1",
      status: "starting",
      servicePort: 3000,
    });
    mocks.execInContainer.mockResolvedValue({
      ok: true,
      output: "ok",
      stdout: "ok",
      stderr: "",
      exitCode: 0,
      machineWoken: true,
    });

    await expect(provider.create(42, "node-api", { TOKEN: "value" })).resolves.toEqual({
      runtimeId: "runtime-1",
      endpoint: "https://mustaflow-containers.fly.dev/container/runtime-1",
      status: "starting",
      servicePort: 3000,
    });
    await expect(provider.exec("runtime-1", ["node", "--version"], 42)).resolves.toEqual({
      ok: true,
      output: "ok",
      stdout: "ok",
      stderr: "",
      exitCode: 0,
      runtimeRestarted: true,
    });
    expect(mocks.createContainer).toHaveBeenCalledWith(
      42,
      "node-api",
      { TOKEN: "value" },
      undefined,
    );
  });

  it("delegates lifecycle, file, environment, and log operations unchanged", async () => {
    mocks.startContainer.mockResolvedValue(true);
    mocks.stopContainer.mockResolvedValue(true);
    mocks.destroyContainer.mockResolvedValue(true);
    mocks.getContainerStatus.mockResolvedValue("running");
    mocks.syncFilesToContainer.mockResolvedValue(undefined);
    mocks.updateContainerEnv.mockResolvedValue(true);
    mocks.recordContainerLog.mockResolvedValue(undefined);

    await expect(provider.start("runtime-2", 7)).resolves.toBe(true);
    await expect(provider.stop("runtime-2", 7)).resolves.toBe(true);
    await expect(provider.destroy("runtime-2", 7)).resolves.toBe(true);
    await expect(provider.status("runtime-2")).resolves.toBe("running");
    await provider.restoreFiles("runtime-2", 7, [{ path: "index.js", content: "ok" }], true);
    await expect(
      provider.updateEnvironment("runtime-2", 7, { TOKEN: "value" }, { servicePort: 4321 }),
    ).resolves.toBe(true);
    await provider.recordLog(7, "system", "ready");
    provider.startLogStream(7, "runtime-2");

    expect(mocks.syncFilesToContainer).toHaveBeenCalledWith(
      "runtime-2",
      7,
      [{ path: "index.js", content: "ok" }],
      true,
    );
    expect(mocks.ensureContainerLogTailer).toHaveBeenCalledWith(7, "runtime-2");
    expect(mocks.updateContainerEnv).toHaveBeenCalledWith(
      "runtime-2",
      7,
      { TOKEN: "value" },
      { servicePort: 4321 },
    );
  });

  it("preserves the existing Fly endpoint shape inside the adapter", () => {
    expect(provider.resolveEndpoint("abc123")).toBe(
      "https://mustaflow-containers.fly.dev/container/abc123",
    );
  });

  it("advertises layered deployment only through the optional Cloudflare extension", () => {
    expect(supportsArtifactDeployment(provider)).toBe(false);
    expect(supportsLayeredArtifactDeployment(provider)).toBe(false);
    expect(supportsZeroGeneration(provider)).toBe(false);
    const cloudflare = new CloudflareRuntimeProvider({
      controlUrl: "https://runtime.example.test",
      controlToken: "control-token-with-at-least-thirty-two-characters",
      deploymentNamespace: "staging",
    });
    expect(supportsExternalRuntimeLogTail(provider)).toBe(true);
    expect(supportsExternalRuntimeLogTail(cloudflare)).toBe(false);
    expect(supportsArtifactDeployment(cloudflare)).toBe(true);
    expect(supportsLayeredArtifactDeployment(cloudflare)).toBe(true);
    expect(supportsZeroGeneration(cloudflare)).toBe(true);
    expect(typeof cloudflare.zeroGenerationRuntimeDescriptorForProject).toBe("function");
    expect(typeof cloudflare.zeroGenerationStartAcceptedSealedRelease).toBe("function");
  });

  it("keeps the unset provider path constructed as the existing Fly adapter", async () => {
    const { createTenantRuntimeProvider } = await import("./tenant-runtime");
    expect(createTenantRuntimeProvider({})).toBeInstanceOf(FlyRuntimeProvider);
    expect(createTenantRuntimeProvider({ TENANT_RUNTIME_PROVIDER: "" })).toBeInstanceOf(
      FlyRuntimeProvider,
    );
  });

  it("selects the Cloudflare adapter only when the provider and complete config are explicit", async () => {
    const { createTenantRuntimeProvider } = await import("./tenant-runtime");
    expect(
      createTenantRuntimeProvider({
        TENANT_RUNTIME_PROVIDER: "cloudflare",
        CLOUDFLARE_RUNTIME_CONTROL_URL: "https://runtime.example.test",
        CLOUDFLARE_RUNTIME_CONTROL_TOKEN: "control-token-with-at-least-thirty-two-characters",
        CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE: "staging",
      }),
    ).toBeInstanceOf(CloudflareRuntimeProvider);
  });

  it("keeps complete Fly configuration on the existing provider path", async () => {
    const { createTenantRuntimeProvider } = await import("./tenant-runtime");
    const complete = createTenantRuntimeProvider({
      TENANT_RUNTIME_PROVIDER: "fly",
      FLY_API_TOKEN: "runtime-token-value",
      FLY_APP_NAME: "mustaflow-containers",
      FLY_ORG_SLUG: "nabuflow-acceptance-staging",
      FLY_REGION: "iad",
    });

    expect(complete).toBeInstanceOf(FlyRuntimeProvider);
    await expect(complete.ensureInfrastructure()).resolves.toBeUndefined();
    expect(mocks.ensureFlyApp).toHaveBeenCalledTimes(1);
  });

  it("makes Fly infrastructure creation unreachable for every partial token-present config", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const {
      createTenantRuntimeProvider,
      ensureTenantRuntimeInfrastructure,
      resumeTenantRuntimeLogStreamsOnBoot,
    } = await import("./tenant-runtime");
    const completeEnvironment = {
      FLY_API_TOKEN: "runtime-token-value",
      FLY_APP_NAME: "mustaflow-containers",
      FLY_ORG_SLUG: "nabuflow-acceptance-staging",
      FLY_REGION: "iad",
    };
    const requiredAfterToken = FLY_RUNTIME_BINDING_NAMES.filter((name) => name !== "FLY_API_TOKEN");

    for (let presentMask = 0; presentMask < 7; presentMask += 1) {
      const environment: Record<string, string> = {
        TENANT_RUNTIME_PROVIDER: "fly",
        FLY_API_TOKEN: completeEnvironment.FLY_API_TOKEN,
      };
      requiredAfterToken.forEach((name, index) => {
        if ((presentMask & (1 << index)) !== 0) environment[name] = completeEnvironment[name];
      });
      const partial = createTenantRuntimeProvider(environment);

      expect(partial).toBeInstanceOf(PartialConfigRuntimeProvider);
      expect(partial.providerId).toBe("fly");
      expect(partial.hasCredentials()).toBe(false);
      await expect(ensureTenantRuntimeInfrastructure(partial)).resolves.toBeUndefined();
      await expect(resumeTenantRuntimeLogStreamsOnBoot(partial)).resolves.toBeUndefined();
      await expect(partial.ensureInfrastructure()).rejects.toMatchObject({
        code: "runtime_provider_capability_unavailable",
        providerId: "fly",
      });
    }

    expect(mocks.ensureFlyApp).not.toHaveBeenCalled();
    expect(mocks.resumeContainerLogTailersOnBoot).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.createContainer).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it.each([
    { FLY_APP_NAME: "MustaFlow-containers" },
    { FLY_APP_NAME: "mustaflow containers" },
    { FLY_ORG_SLUG: "../personal" },
    { FLY_REGION: "IAD" },
  ])("rejects malformed complete Fly config before provider access", async (override) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { createTenantRuntimeProvider } = await import("./tenant-runtime");

    expect(() =>
      createTenantRuntimeProvider({
        TENANT_RUNTIME_PROVIDER: "fly",
        FLY_API_TOKEN: "runtime-token-value",
        FLY_APP_NAME: "mustaflow-containers",
        FLY_ORG_SLUG: "nabuflow-acceptance-staging",
        FLY_REGION: "iad",
        ...override,
      }),
    ).toThrow();
    expect(mocks.ensureFlyApp).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("boots every partial combination without reaching Fly or Cloudflare", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { createTenantRuntimeProvider } = await import("./tenant-runtime");
    const completeEnvironment = {
      CLOUDFLARE_RUNTIME_CONTROL_URL: "https://runtime.example.test",
      CLOUDFLARE_RUNTIME_CONTROL_TOKEN: "control-token-with-at-least-thirty-two-characters",
      CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE: "staging",
    };

    for (let presentMask = 0; presentMask < 7; presentMask += 1) {
      const environment: Record<string, string> = { TENANT_RUNTIME_PROVIDER: "cloudflare" };
      CLOUDFLARE_RUNTIME_BINDING_NAMES.forEach((name, index) => {
        if ((presentMask & (1 << index)) !== 0) environment[name] = completeEnvironment[name];
      });
      const partial = createTenantRuntimeProvider(environment);

      expect(partial).toBeInstanceOf(PartialConfigRuntimeProvider);
      expect(partial.hasCredentials()).toBe(false);
      await expect(partial.isAvailable()).resolves.toBe(false);
      await expect(partial.runSelfCheck()).resolves.toBe("partial-config");
      expect(partial.getSubsystemStatus()).toBe("partial-config");
      await expect(partial.create(42, "node-api")).rejects.toBeInstanceOf(
        RuntimeProviderUnavailableError,
      );
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.createContainer).not.toHaveBeenCalled();
    expect(mocks.startContainer).not.toHaveBeenCalled();
    expect(mocks.stopContainer).not.toHaveBeenCalled();
    expect(mocks.destroyContainer).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("fails every partial-provider operation through the existing typed unavailable error", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const partial = new PartialConfigRuntimeProvider("cloudflare", [
      "CLOUDFLARE_RUNTIME_CONTROL_TOKEN",
      "CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE",
    ]);
    const file = [{ path: "index.js", content: "safe source" }];
    const asyncOperations: Array<() => Promise<unknown>> = [
      () => partial.ensureInfrastructure(),
      () => partial.start("runtime", 1),
      () => partial.stop("runtime", 1),
      () => partial.destroy("runtime", 1),
      () => partial.status("runtime"),
      () => partial.exec("runtime", ["node", "--version"], 1),
      () => partial.installDependencies("runtime", 1),
      () => partial.writeFile("runtime", "index.js", "safe source", 1),
      () => partial.syncFiles("runtime", 1, file),
      () => partial.restoreFiles("runtime", 1, file),
      () => partial.updateEnvironment("runtime", 1, {}),
      () => partial.restartWithProjectEnvironment(1, {}),
      () => partial.ensureAwake("runtime", 1, null),
      () => partial.provision(1, file),
      () => partial.hibernate(1),
      () => partial.createProduction(1, {}),
      () => partial.deployProduction(1, null, file, {}),
      () => partial.configureIdleBehavior("runtime", 1, "stop"),
      () => partial.startHealthService("runtime", 1),
      () => partial.stopHealthService("runtime", 1),
      () => partial.health("https://runtime.example.test", 1),
      () => partial.isGatewayReachable(),
      () => partial.recordLog(1, "system", "message"),
      () => partial.resumeLogStreamsOnBoot(),
    ];

    for (const operation of asyncOperations) {
      await expect(operation()).rejects.toMatchObject({
        code: "runtime_provider_capability_unavailable",
        providerId: "cloudflare",
      });
    }
    for (const operation of [
      () => partial.startKeepalive("https://runtime.example.test", 1),
      () => partial.resolveEndpoint("runtime"),
      () => partial.getGatewayHostname(),
      () => partial.getGatewayLabel(),
      () => partial.mapErrorToMessage("error"),
      () => partial.startLogStream(1, "runtime"),
      () => partial.stopLogStream(1),
    ]) {
      expect(operation).toThrow(RuntimeProviderUnavailableError);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.createContainer).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("keeps production consumers behind the tenant runtime seam except the narrow legacy retirement adapter", () => {
    const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const scriptsRoot = join(sourceRoot, "../../../scripts/src");
    const legacyRetirementAdapter = readFileSync(
      join(sourceRoot, "lib/project-retirement-legacy-fly.ts"),
      "utf8",
    );
    expect(legacyRetirementAdapter).toContain(
      'const { requestLegacyFlyMachineForRetirement } = await import("./container");',
    );
    expect(legacyRetirementAdapter.match(/import\(["']\.\/container["']\)/gu)).toHaveLength(1);
    const allowed = new Set([
      "lib/container.ts",
      "lib/container-logs.ts",
      "lib/fly-runtime-provider.ts",
      "lib/project-retirement-legacy-fly.ts",
    ]);
    const violations: string[] = [];

    const visit = (directory: string, root: string, prefix: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) {
          visit(absolute, root, prefix);
          continue;
        }
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
        const relative = absolute.slice(root.length + 1).replaceAll("\\", "/");
        const labeled = `${prefix}${relative}`;
        if (prefix === "" && allowed.has(relative)) continue;
        const source = readFileSync(absolute, "utf8");
        if (
          /(?:from\s+|import\()["'][^"']*(?:\/|^)container(?:\.js)?["']/.test(source) ||
          /(?:from\s+|import\()["'][^"']*container-logs["']/.test(source) ||
          source.includes("https://api.machines.dev/v1")
        ) {
          violations.push(labeled);
        }
      }
    };

    visit(sourceRoot, sourceRoot, "");
    visit(scriptsRoot, scriptsRoot, "scripts/");
    expect(violations).toEqual([]);
  });
});
