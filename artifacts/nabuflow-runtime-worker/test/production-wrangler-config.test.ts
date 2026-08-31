import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type WranglerConfig = Record<string, unknown> & {
  containers?: Array<Record<string, unknown>>;
  queues: { producers: Array<Record<string, unknown>> };
  r2_buckets: Array<Record<string, unknown>>;
  routes?: Array<Record<string, unknown>>;
  services?: Array<Record<string, unknown>>;
  vars: Record<string, string>;
};

const root = resolve(import.meta.dirname, "..");

function readConfig(name: string): WranglerConfig {
  const jsonc = readFileSync(resolve(root, name), "utf8");
  // These committed production configs use JSONC's trailing-comma allowance.
  // Normalize that single declared extension so the guard reaches the resource
  // identity assertions instead of failing before the first test executes.
  const strictJson = jsonc.replace(/,\s*([}\]])/gu, "$1");
  return JSON.parse(strictJson) as WranglerConfig;
}

const runtime = readConfig("wrangler.runtime.production.jsonc");
const pantry = readConfig("wrangler.pantry.production.jsonc");
const build = readConfig("wrangler.build.production.jsonc");
const replit = readFileSync(resolve(root, "../..", ".replit"), "utf8");

describe("production Wrangler configurations", () => {
  it("use only the cutover plan's production resource identities", () => {
    expect(runtime.name).toBe("nabuflow-runtime-production");
    expect(pantry.name).toBe("nabuflow-pantry-production");
    expect(build.name).toBe("nabuflow-build-production");

    const serialized = JSON.stringify({ runtime, pantry, build });
    expect(serialized).not.toContain("-staging");
    expect(serialized).not.toContain("NABUFLOW_STAGING_");
    expect(serialized).not.toContain("TRUSTED_BUILD_STAGING_");
    expect(serialized).not.toContain("pantry-test-key");

    expect(runtime.r2_buckets[0].bucket_name).toBe("nabuflow-runtime-artifacts-production");
    expect(pantry.r2_buckets[0].bucket_name).toBe("nabuflow-pantry-catalog-production");
    expect(build.r2_buckets[0].bucket_name).toBe("nabuflow-trusted-build-production");
    expect(runtime.queues.producers[0].queue).toBe("nabuflow-artifact-commit-production");
    expect(pantry.queues.producers[0].queue).toBe("nabuflow-pantry-ingest-production");
    expect(build.queues.producers[0].queue).toBe("nabuflow-trusted-build-production");
  });

  it("ships production-namespaced with dedicated production authorities", () => {
    for (const config of [pantry, build]) {
      expect(config.workers_dev).toBe(false);
      expect(config.preview_urls).toBe(false);
      expect(config.routes).toBeUndefined();
    }

    expect(runtime.workers_dev).toBe(false);
    expect(runtime.preview_urls).toBe(false);
    expect(runtime.routes).toEqual([
      { pattern: "runtime.apps.mustaflow.com", custom_domain: true },
      { pattern: "*.apps.mustaflow.com/*", zone_name: "mustaflow.com" },
    ]);

    expect(runtime.vars.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE).toBe("production");
    expect(runtime.vars.NABUFLOW_PRODUCTION_DATABASE_ALLOCATION_ENABLED).toBe("enabled");
    expect(runtime.vars.CLOUDFLARE_RUNTIME_PREVIEW_PUBLIC_KEY).toContain("BEGIN PUBLIC KEY");
    expect(runtime.vars.CLOUDFLARE_RUNTIME_PREVIEW_PUBLIC_KEY).not.toContain("PRIVATE KEY");
    expect(runtime.vars.NABUFLOW_PRODUCTION_NEON_ORGANIZATION_ID).toBe("org-wispy-scene-66237735");
    expect(pantry.vars.PANTRY_INGEST_SIGNING_KEY_ID).toBe("pantry-production-2026-08-v1");
    expect(Object.keys(JSON.parse(pantry.vars.PANTRY_REVISION_PUBLIC_KEYS))).toEqual([
      "pantry-production-2026-08-v1",
    ]);
    expect(build.vars.TRUSTED_BUILD_SIGNING_KEY_ID).toBe("build-production-2026-08-v1");
    const pantryRevisionKeys = JSON.parse(pantry.vars.PANTRY_REVISION_PUBLIC_KEYS);
    const trustedBuildKeys = JSON.parse(build.vars.TRUSTED_BUILD_PUBLIC_KEYS);
    expect(Object.keys(trustedBuildKeys)).toEqual([
      "build-production-2026-08-v1",
      "pantry-production-2026-08-v1",
    ]);
    expect(trustedBuildKeys["pantry-production-2026-08-v1"]).toBe(
      pantryRevisionKeys["pantry-production-2026-08-v1"],
    );
  });

  it("pins scale-to-zero-compatible canary capacity and all service bindings", () => {
    expect(runtime.containers).toMatchObject([
      { class_name: "NabuflowSandbox", instance_type: "basic", max_instances: 5 },
    ]);
    expect(runtime.vars.NABUFLOW_RUNTIME_SLEEP_AFTER).toBe("10m");
    expect(build.containers).toMatchObject([
      { class_name: "TrustedBuildSandbox", instance_type: "standard-1", max_instances: 2 },
    ]);
    expect(build.vars.TRUSTED_BUILD_MAX_ACTIVE).toBe("2");
    expect(runtime.services).toEqual([
      { binding: "PANTRY_CATALOG", service: "nabuflow-pantry-production" },
      { binding: "TRUSTED_BUILD_PLANE", service: "nabuflow-build-production" },
    ]);
    expect(build.services).toEqual([
      { binding: "PANTRY_CATALOG", service: "nabuflow-pantry-production" },
    ]);
  });

  it("declares the atomic production API switch while retaining Fly rollback inputs", () => {
    expect(replit).toContain('TENANT_RUNTIME_PROVIDER = "cloudflare"');
    expect(replit).toContain(
      'CLOUDFLARE_RUNTIME_CONTROL_URL = "https://runtime.apps.mustaflow.com"',
    );
    expect(replit).toContain('CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE = "production"');
    expect(replit).toContain('NABUFLOW_ZERO_GENERATION_TARGET = "cloudflare-sealed-v1"');
    expect(replit).toContain('PLATFORM_DOMAIN = "apps.mustaflow.com"');
    expect(replit).toContain('NABUFLOW_PANTRY_TRUSTED_PUBLIC_KEYS = "{');
    expect(replit).not.toContain("PROD_HEALTH_BASE_URL");

    expect(replit).toContain('FLY_APP_NAME = "mustaflow-containers"');
    expect(replit).toContain('FLY_ORG_SLUG = "personal"');
  });
});
