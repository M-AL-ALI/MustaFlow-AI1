import { describe, expect, it } from "vitest";
import { CLOUDFLARE_RUNTIME_BINDING_NAMES, parseTenantRuntimeConfig } from "../src/config";

const cloudflareEnvironment = {
  TENANT_RUNTIME_PROVIDER: "cloudflare",
  CLOUDFLARE_RUNTIME_CONTROL_URL: "https://runtime-control.mustaflow.com/",
  CLOUDFLARE_RUNTIME_CONTROL_TOKEN: "0123456789abcdef0123456789abcdef",
  CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE: "production-us-east",
};

describe("tenant runtime configuration", () => {
  it("defaults a missing provider to Fly without requiring Cloudflare config", () => {
    expect(parseTenantRuntimeConfig({})).toEqual({ provider: "fly" });
    expect(parseTenantRuntimeConfig({ TENANT_RUNTIME_PROVIDER: "" })).toEqual({ provider: "fly" });
  });

  it("parses the complete Cloudflare config without activating it", () => {
    expect(parseTenantRuntimeConfig(cloudflareEnvironment)).toEqual({
      provider: "cloudflare",
      cloudflare: {
        controlUrl: "https://runtime-control.mustaflow.com",
        controlToken: cloudflareEnvironment.CLOUDFLARE_RUNTIME_CONTROL_TOKEN,
        deploymentNamespace: "production-us-east",
      },
    });
  });

  it.each(["aws", "", "FLY", "Cloudflare", "cloudflare "])(
    "fails loudly for unsupported nonempty provider %j",
    (provider) => {
      if (provider === "") {
        expect(parseTenantRuntimeConfig({ TENANT_RUNTIME_PROVIDER: provider })).toEqual({
          provider: "fly",
        });
      } else {
        expect(() => parseTenantRuntimeConfig({ TENANT_RUNTIME_PROVIDER: provider })).toThrow(
          "Unsupported TENANT_RUNTIME_PROVIDER",
        );
      }
    },
  );

  it("returns a names-only partial state for every incomplete Cloudflare combination", () => {
    for (let mask = 0; mask < 7; mask += 1) {
      const environment: Record<string, string> = { TENANT_RUNTIME_PROVIDER: "cloudflare" };
      CLOUDFLARE_RUNTIME_BINDING_NAMES.forEach((name, index) => {
        if ((mask & (1 << index)) !== 0) environment[name] = cloudflareEnvironment[name];
      });
      const missingBindings = CLOUDFLARE_RUNTIME_BINDING_NAMES.filter(
        (_name, index) => (mask & (1 << index)) === 0,
      );

      const result = parseTenantRuntimeConfig(environment);

      expect(result).toEqual({
        provider: "cloudflare",
        partialCloudflare: { status: "partial-config", missingBindings },
      });
      const serialized = JSON.stringify(result);
      for (const value of CLOUDFLARE_RUNTIME_BINDING_NAMES.map(
        (name) => cloudflareEnvironment[name],
      )) {
        expect(serialized).not.toContain(value);
      }
    }
  });

  it("validates supplied Cloudflare settings even while Fly remains selected", () => {
    expect(() =>
      parseTenantRuntimeConfig({
        TENANT_RUNTIME_PROVIDER: "fly",
        CLOUDFLARE_RUNTIME_CONTROL_URL: "http://runtime-control.mustaflow.com",
        CLOUDFLARE_RUNTIME_CONTROL_TOKEN: "short",
        CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE: "Prod",
      }),
    ).toThrow("must use HTTPS");
  });

  it.each([
    [
      "non-HTTPS URL",
      { ...cloudflareEnvironment, CLOUDFLARE_RUNTIME_CONTROL_URL: "http://example.com" },
    ],
    ["short token", { ...cloudflareEnvironment, CLOUDFLARE_RUNTIME_CONTROL_TOKEN: "short" }],
    [
      "unnormalized namespace",
      { ...cloudflareEnvironment, CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE: "Production" },
    ],
    [
      "credentials in control URL",
      {
        ...cloudflareEnvironment,
        CLOUDFLARE_RUNTIME_CONTROL_URL: "https://user:password@runtime-control.mustaflow.com",
      },
    ],
  ])("rejects %s", (_name, environment) => {
    expect(() => parseTenantRuntimeConfig(environment)).toThrow();
  });

  it("ignores unrelated process environment names", () => {
    expect(
      parseTenantRuntimeConfig({ HOME: "not-part-of-contract", PATH: "also-ignored" }),
    ).toEqual({
      provider: "fly",
    });
  });
});
