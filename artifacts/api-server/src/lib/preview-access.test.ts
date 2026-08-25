import { describe, expect, it } from "vitest";
import { derivePreviewAccess, isCloudflarePreviewDataPlaneConfigured } from "./preview-access";

describe("derivePreviewAccess", () => {
  it.each([
    {
      name: "Fly running with provider identity and no URL proxy",
      providerId: "fly",
      runtimeId: "fly-runtime",
      runtimeStatus: "running",
      cloudflarePreviewConfigured: false,
      expected: "direct",
    },
    {
      name: "Cloudflare running without a direct endpoint",
      providerId: "cloudflare",
      runtimeId: "nrf-project-preview-primary",
      runtimeStatus: "running",
      cloudflarePreviewConfigured: true,
      expected: "gateway",
    },
    {
      name: "Cloudflare running without its preview data plane",
      providerId: "cloudflare",
      runtimeId: "nrf-project-preview-primary",
      runtimeStatus: "running",
      cloudflarePreviewConfigured: false,
      expected: "unavailable",
    },
    {
      name: "a stopped Cloudflare runtime",
      providerId: "cloudflare",
      runtimeId: "nrf-project-preview-primary",
      runtimeStatus: "stopped",
      cloudflarePreviewConfigured: true,
      expected: "unavailable",
    },
    {
      name: "a running row without runtime identity",
      providerId: "cloudflare",
      runtimeId: null,
      runtimeStatus: "running",
      cloudflarePreviewConfigured: true,
      expected: "unavailable",
    },
    {
      name: "an unknown provider",
      providerId: "unknown",
      runtimeId: "runtime",
      runtimeStatus: "running",
      cloudflarePreviewConfigured: true,
      expected: "unavailable",
    },
  ])("classifies $name", ({ expected, name: _name, ...input }) => {
    expect(derivePreviewAccess(input)).toEqual(expected);
  });

  it("uses explicit provider identity rather than a nullable endpoint", () => {
    const common = {
      runtimeId: "runtime",
      runtimeStatus: "running",
      cloudflarePreviewConfigured: true,
    };
    expect(derivePreviewAccess({ ...common, providerId: "fly" })).toBe("direct");
    expect(derivePreviewAccess({ ...common, providerId: "cloudflare" })).toBe("gateway");
  });
});

describe("isCloudflarePreviewDataPlaneConfigured", () => {
  it("accepts only a public HTTPS origin plus a private signing key", () => {
    expect(
      isCloudflarePreviewDataPlaneConfigured({
        CLOUDFLARE_RUNTIME_PREVIEW_URL: "https://runtime.apps.mustaflow.com",
        CLOUDFLARE_RUNTIME_PREVIEW_PRIVATE_KEY: "private-key",
      }),
    ).toBe(true);
    expect(
      isCloudflarePreviewDataPlaneConfigured({
        CLOUDFLARE_RUNTIME_PREVIEW_URL: "https://runtime.apps.mustaflow.com/path",
        CLOUDFLARE_RUNTIME_PREVIEW_PRIVATE_KEY: "private-key",
      }),
    ).toBe(false);
    expect(
      isCloudflarePreviewDataPlaneConfigured({
        CLOUDFLARE_RUNTIME_PREVIEW_URL: "https://runtime.apps.mustaflow.com",
      }),
    ).toBe(false);
  });
});
