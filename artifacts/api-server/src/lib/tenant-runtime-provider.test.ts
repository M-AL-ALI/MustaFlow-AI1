import { beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
}));

vi.mock("./container", () => ({
  hasContainerLayerCredentials: vi.fn(() => true),
  isContainerLayerConfigured: vi.fn(async () => true),
  runContainerSelfCheck: vi.fn(async () => "ok"),
  getContainerSubsystemStatus: vi.fn(() => "ok"),
  ensureFlyApp: vi.fn(async () => undefined),
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
  resumeContainerLogTailersOnBoot: vi.fn(),
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn() },
}));

import { FlyRuntimeProvider } from "./fly-runtime-provider";
import type { TenantRuntimeProvider } from "./tenant-runtime-provider";

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
    });
    await expect(provider.exec("runtime-1", ["node", "--version"], 42)).resolves.toEqual({
      ok: true,
      output: "ok",
      stdout: "ok",
      stderr: "",
      exitCode: 0,
      runtimeRestarted: true,
    });
    expect(mocks.createContainer).toHaveBeenCalledWith(42, "node-api", { TOKEN: "value" });
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
    await expect(provider.updateEnvironment("runtime-2", 7, { PORT: "3000" })).resolves.toBe(true);
    await provider.recordLog(7, "system", "ready");
    provider.startLogStream(7, "runtime-2");

    expect(mocks.syncFilesToContainer).toHaveBeenCalledWith(
      "runtime-2",
      7,
      [{ path: "index.js", content: "ok" }],
      true,
    );
    expect(mocks.ensureContainerLogTailer).toHaveBeenCalledWith(7, "runtime-2");
  });

  it("preserves the existing Fly endpoint shape inside the adapter", () => {
    expect(provider.resolveEndpoint("abc123")).toBe(
      "https://mustaflow-containers.fly.dev/container/abc123",
    );
  });

  it("keeps production consumers behind the tenant runtime seam", () => {
    const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const scriptsRoot = join(sourceRoot, "../../../scripts/src");
    const allowed = new Set([
      "lib/container.ts",
      "lib/container-logs.ts",
      "lib/fly-runtime-provider.ts",
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
