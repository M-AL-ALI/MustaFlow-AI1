import { generateKeyPairSync } from "node:crypto";
import {
  deriveRuntimeIdentity,
  PREVIEW_GRANT_QUERY_PARAM,
} from "@workspace/tenant-runtime-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  resolveCloudflareLivePreviewLaunchUrl,
  shouldProxyLivePreviewUpgrade,
  shouldRouteToLivePreview,
} from "./livePreviewProxy";

vi.mock("@workspace/db", () => ({}));
vi.mock("./container-secrets", () => ({ getContainerSecretMap: vi.fn(async () => ({})) }));
vi.mock("./project-files-preview", () => ({
  previewFilePathFromUrl: vi.fn(() => "index.html"),
  serveProjectFilesPreview: vi.fn(),
}));
vi.mock("./tenant-runtime", () => ({
  hasContainerLayerCredentials: vi.fn(() => true),
  isContainerLayerConfigured: vi.fn(async () => true),
  provisionContainer: vi.fn(),
  tenantRuntimeProvider: {
    getGatewayHostname: () => "runtime.example.workers.dev",
    getGatewayLabel: () => "Cloudflare runtime gateway",
    isGatewayReachable: vi.fn(async () => true),
  },
}));

function cloudflareEnvironment(privateKey: string) {
  return {
    TENANT_RUNTIME_PROVIDER: "cloudflare",
    CLOUDFLARE_RUNTIME_CONTROL_URL: "https://runtime.example.workers.dev",
    CLOUDFLARE_RUNTIME_CONTROL_TOKEN: "0123456789abcdef0123456789abcdef",
    CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE: "staging",
    CLOUDFLARE_RUNTIME_PREVIEW_URL: "https://runtime.example.workers.dev",
    CLOUDFLARE_RUNTIME_PREVIEW_PRIVATE_KEY: privateKey,
  };
}

describe("Cloudflare live preview handoff", () => {
  it("routes Project 52's exact legacy-labeled running descriptor to a signed grant", async () => {
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const runtimeId = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId: 52,
      role: "preview",
      slot: "primary",
    });
    const project52 = {
      id: 52,
      builderMode: "static-legacy",
      containerId: runtimeId,
      containerStatus: "running",
      containerUrl: null,
      runtimePort: 8080,
      stack: "node-api",
    };

    expect(shouldRouteToLivePreview(project52)).toBe(true);
    const launchUrl = await resolveCloudflareLivePreviewLaunchUrl(
      project52,
      "/api/projects/52/preview/assets/site.js?t=1",
      cloudflareEnvironment(pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString()),
    );

    expect(launchUrl).not.toBeNull();
    const parsed = new URL(launchUrl!);
    expect(parsed.origin).toBe("https://runtime.example.workers.dev");
    expect(parsed.pathname).toBe(`/_nabuflow/preview/v1/${runtimeId}/assets/site.js`);
    expect(parsed.searchParams.get(PREVIEW_GRANT_QUERY_PARAM)).toBeTruthy();
  });

  it("keeps projects without a runtime and stale stopped legacy rows on DB serving", () => {
    expect(
      shouldRouteToLivePreview({
        builderMode: "agentic",
        containerId: null,
        containerStatus: "stopped",
      }),
    ).toBe(false);
    expect(
      shouldRouteToLivePreview({
        builderMode: "static-legacy",
        containerId: "stale-runtime-id",
        containerStatus: "stopped",
      }),
    ).toBe(false);
    expect(
      shouldRouteToLivePreview({
        builderMode: "static-legacy",
        containerId: null,
        containerStatus: "stopped",
      }),
    ).toBe(false);
  });

  it("uses the HTTP live-runtime judgment for direct-container WebSocket upgrades", () => {
    expect(
      shouldProxyLivePreviewUpgrade({
        builderMode: "static-legacy",
        containerId: "legacy-labeled-running-runtime",
        containerStatus: "running",
        containerUrl: "https://direct-runtime.internal",
      }),
    ).toBe(true);
    expect(
      shouldProxyLivePreviewUpgrade({
        builderMode: "static-legacy",
        containerId: "stopped-runtime",
        containerStatus: "stopped",
        containerUrl: "https://direct-runtime.internal",
      }),
    ).toBe(false);
    expect(
      shouldProxyLivePreviewUpgrade({
        builderMode: "static-legacy",
        containerId: "private-cloudflare-runtime",
        containerStatus: "running",
        containerUrl: null,
      }),
    ).toBe(false);
  });

  it("preserves the established agentic container route while it is stopped", () => {
    expect(
      shouldRouteToLivePreview({
        builderMode: "agentic",
        containerId: "agentic-runtime-id",
        containerStatus: "stopped",
      }),
    ).toBe(true);
  });

  it("leaves the established direct-container path unchanged outside Cloudflare", async () => {
    await expect(
      resolveCloudflareLivePreviewLaunchUrl(
        {
          id: 52,
          containerId: "fly-machine-id",
          containerStatus: "running",
          runtimePort: 3000,
          stack: "node-api",
        },
        "/api/projects/52/preview/",
        { TENANT_RUNTIME_PROVIDER: "fly" },
      ),
    ).resolves.toBeNull();
  });
});
