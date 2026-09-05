import { describe, expect, it } from "vitest";
import {
  CLOUDFLARE_RUNTIME_BINDING_NAMES,
  TENANT_RUNTIME_PROVIDERS,
  parseTenantRuntimeConfig,
} from "../src/config";

const cloudflareEnvironment = {
  TENANT_RUNTIME_PROVIDER: "cloudflare",
  CLOUDFLARE_RUNTIME_CONTROL_URL: "https://runtime-control.mustaflow.com/",
  CLOUDFLARE_RUNTIME_CONTROL_TOKEN: "0123456789abcdef0123456789abcdef",
  CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE: "production-us-east",
};

const flyEnvironment = {
  TENANT_RUNTIME_PROVIDER: "fly",
  FLY_API_TOKEN: "runtime-token-value",
  FLY_APP_NAME: "mustaflow-containers",
  FLY_ORG_SLUG: "nabuflow-acceptance-staging",
  FLY_REGION: "iad",
};

describe("tenant runtime configuration", () => {
  it("allows only Cloudflare and defaults missing selection to a fail-closed partial state", () => {
    expect(TENANT_RUNTIME_PROVIDERS).toEqual(["cloudflare"]);
    for (const selection of [undefined, "", "   "]) {
      expect(parseTenantRuntimeConfig({ TENANT_RUNTIME_PROVIDER: selection })).toEqual({
        provider: "cloudflare",
        partialCloudflare: {
          status: "partial-config",
          missingBindings: [...CLOUDFLARE_RUNTIME_BINDING_NAMES],
        },
      });
    }
  });

  it("rejects retired Fly selection even when every legacy credential is present", () => {
    expect(() => parseTenantRuntimeConfig(flyEnvironment)).toThrow("Fly runtime is retired");
    expect(() => parseTenantRuntimeConfig({ TENANT_RUNTIME_PROVIDER: "fly" })).toThrow(
      "Fly runtime is retired",
    );
  });

  it("does not use leftover Fly credentials as an active runtime fallback", () => {
    expect(
      parseTenantRuntimeConfig({
        ...flyEnvironment,
        TENANT_RUNTIME_PROVIDER: undefined,
      }),
    ).toEqual({
      provider: "cloudflare",
      partialCloudflare: {
        status: "partial-config",
        missingBindings: [...CLOUDFLARE_RUNTIME_BINDING_NAMES],
      },
    });
  });

  it("uses complete Cloudflare bindings when selection is omitted", () => {
    expect(
      parseTenantRuntimeConfig({ ...cloudflareEnvironment, TENANT_RUNTIME_PROVIDER: undefined }),
    ).toEqual(parseTenantRuntimeConfig(cloudflareEnvironment));
  });

  it.each([
    ["uppercase app", { FLY_APP_NAME: "MustaFlow-containers" }],
    ["spaced app", { FLY_APP_NAME: "mustaflow containers" }],
    ["uppercase org", { FLY_ORG_SLUG: "NabuFlow" }],
    ["path-like org", { FLY_ORG_SLUG: "../personal" }],
    ["long region", { FLY_REGION: "us-east" }],
    ["uppercase region", { FLY_REGION: "IAD" }],
  ])("never lets obsolete Fly settings affect Cloudflare selection: %s", (_name, override) => {
    expect(
      parseTenantRuntimeConfig({ ...flyEnvironment, ...override, ...cloudflareEnvironment }),
    ).toEqual(parseTenantRuntimeConfig(cloudflareEnvironment));
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
          provider: "cloudflare",
          partialCloudflare: {
            status: "partial-config",
            missingBindings: [...CLOUDFLARE_RUNTIME_BINDING_NAMES],
          },
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
      const environment: Record<string, string> = {
        ...flyEnvironment,
        TENANT_RUNTIME_PROVIDER: "cloudflare",
      };
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

  it("does not silently reinterpret explicit Fly selection as Cloudflare", () => {
    expect(() =>
      parseTenantRuntimeConfig({
        TENANT_RUNTIME_PROVIDER: "fly",
        CLOUDFLARE_RUNTIME_CONTROL_URL: "http://runtime-control.mustaflow.com",
        CLOUDFLARE_RUNTIME_CONTROL_TOKEN: "short",
        CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE: "Prod",
      }),
    ).toThrow("Fly runtime is retired");
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
      provider: "cloudflare",
      partialCloudflare: {
        status: "partial-config",
        missingBindings: [...CLOUDFLARE_RUNTIME_BINDING_NAMES],
      },
    });
  });
});
