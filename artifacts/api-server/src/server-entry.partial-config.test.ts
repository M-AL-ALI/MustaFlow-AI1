import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const serverEntryState = vi.hoisted(() => ({
  server: null as Server | null,
  info: [] as unknown[][],
  warn: [] as unknown[][],
}));

vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => {
      const server = actual.createServer(...args);
      serverEntryState.server = server;
      return server;
    },
  };
});

vi.mock("./app", async () => {
  const { default: express } = await import("express");
  const app = express();
  app.get("/api/healthz", (_req, res) => {
    res.status(200).json({ status: "degraded", containerSubsystem: "partial-config" });
  });
  return { default: app };
});

vi.mock("./lib/logger", () => ({
  logger: {
    info: vi.fn((...args: unknown[]) => serverEntryState.info.push(args)),
    warn: vi.fn((...args: unknown[]) => serverEntryState.warn.push(args)),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const upgradeServer = () => ({ handleUpgrade: vi.fn() });

vi.mock("./lib/terminal", () => ({ createTerminalServer: upgradeServer }));
vi.mock("./lib/multiplayer", () => ({ createMultiplayerServer: upgradeServer }));
vi.mock("./lib/support-alerts", () => ({ createSupportAlertsServer: upgradeServer }));
vi.mock("./routes/debug", () => ({ createDebugServer: upgradeServer }));
vi.mock("./middlewares/previewSubdomainGateway", () => ({
  isPreviewSubdomainHost: () => false,
  validatePreviewWebSocketUpgrade: vi.fn(),
}));

vi.mock("./lib/tenant-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/tenant-runtime")>();
  return {
    ...actual,
    ensureFlyApp: vi.fn(async () => undefined),
    resumeContainerLogTailersOnBoot: vi.fn(),
    runContainerSelfCheck: vi.fn(async () => undefined),
  };
});

vi.mock("./lib/checks/semgrep", () => ({ warmSemgrepRuleCache: vi.fn() }));
vi.mock("./lib/cve-scheduler", () => ({ startCveScheduler: vi.fn() }));
vi.mock("./lib/jobs", () => ({ failStuckBackgroundTasksOnBoot: vi.fn(async () => undefined) }));
vi.mock("./lib/provisioning", () => ({
  resumeStuckProvisioningOnBoot: vi.fn(async () => undefined),
}));
vi.mock("./lib/container-log-retention", () => ({
  startContainerLogRetentionScheduler: vi.fn(),
}));
vi.mock("./lib/ora-transcript-retention", () => ({
  startOraTranscriptRetentionScheduler: vi.fn(),
}));
vi.mock("./lib/ora-assets-retention", () => ({ startOraAssetsRetentionScheduler: vi.fn() }));
vi.mock("./lib/public-ai/session", () => ({ isOraSecretConfigured: () => false }));
vi.mock("./lib/public-ai/ora-spend-cap", () => ({ initSpendLedger: vi.fn() }));
vi.mock("./lib/public-ai/repo-workspace", () => ({ startWorkspaceSweeper: vi.fn() }));
vi.mock("./lib/image-provider", () => ({
  auditImageProviderConfig: () => ({ activeProviderPath: "none" }),
}));
vi.mock("./lib/billing-settlement-outbox", () => ({
  startBillingSettlementSweeper: vi.fn(),
}));
vi.mock("./lib/startup-migrations", () => ({
  runStartupMigrations: vi.fn(async () => ({ applied: 0, skipped: 144, failed: 0 })),
}));
vi.mock("./lib/startup-health-state", () => ({
  startupHealthState: { recordMigrations: vi.fn() },
}));
vi.mock("./lib/schema-contract-state", () => ({
  zeroPromptQueueSchemaContractState: {
    verify: vi.fn(async () => ({
      contractId: "zero_prompt_queue_v1",
      status: "ready",
      durationMs: 0,
      violations: [],
    })),
  },
  startSchemaContractVerificationCadence: vi.fn(),
}));

describe("real server entry under partial Cloudflare configuration", () => {
  const originalEnvironment = { ...process.env };

  beforeAll(async () => {
    // These are non-secret test placeholders required by unrelated import-time
    // integration validation. They never dispatch a request.
    process.env.NODE_ENV = "test";
    process.env.PORT = "43192";
    process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/server_entry_partial";
    process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = "http://127.0.0.1:9/v1";
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "test-placeholder";
    process.env.TENANT_RUNTIME_PROVIDER = "cloudflare";
    delete process.env.CLOUDFLARE_RUNTIME_CONTROL_URL;
    delete process.env.CLOUDFLARE_RUNTIME_CONTROL_TOKEN;
    delete process.env.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE;
    delete process.env.CLOUDFLARE_RUNTIME_PREVIEW_URL;
    delete process.env.CLOUDFLARE_RUNTIME_PREVIEW_PRIVATE_KEY;

    await import("./index");
    await vi.waitFor(() => expect(serverEntryState.server?.listening).toBe(true));
  });

  afterAll(async () => {
    const server = serverEntryState.server;
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
  });

  it("imports cleanly and binds its port without resolving a missing runtime capability", () => {
    expect(serverEntryState.server?.listening).toBe(true);
  });

  it("logs the honest incomplete runtime configuration state", () => {
    const incomplete = serverEntryState.warn.find((args) =>
      args.includes("tenant runtime provider configuration is incomplete"),
    );
    expect(incomplete).toBeDefined();
    expect(incomplete?.[0]).toEqual({
      missingRuntimeBindings: [
        "CLOUDFLARE_RUNTIME_CONTROL_URL",
        "CLOUDFLARE_RUNTIME_CONTROL_TOKEN",
        "CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE",
      ],
    });
  });
});
