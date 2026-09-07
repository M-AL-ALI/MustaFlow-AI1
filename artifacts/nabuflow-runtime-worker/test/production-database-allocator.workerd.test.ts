import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_dev } from "wrangler";

describe("production database provider in workerd", () => {
  let worker: Awaited<ReturnType<typeof unstable_dev>> | undefined;

  beforeAll(async () => {
    worker = await unstable_dev(
      fileURLToPath(new URL("./fixtures/production-database-provider-worker.ts", import.meta.url)),
      {
        config: fileURLToPath(
          new URL("./fixtures/wrangler.provider-contract.jsonc", import.meta.url),
        ),
        local: true,
        ip: "127.0.0.1",
        port: 0,
        inspectorPort: 0,
        persist: false,
        logLevel: "error",
        experimental: {
          disableExperimentalWarning: true,
          disableDevRegistry: true,
          watch: false,
          forceLocal: true,
        },
      },
    );
  }, 30_000);

  afterAll(async () => {
    await worker?.stop();
  }, 30_000);

  it("constructs and dispatches a health request using the actual edge Request API", async () => {
    const response = await worker!.fetch("http://local.test/?status=200");
    expect(await response.json()).toMatchObject({
      ok: true,
      calls: 1,
      redirectMode: "manual",
      authorizationMatches: true,
      health: { provider: "neon-postgres", organizationId: "org-test" },
    });
  });

  it.each([301, 302, 303, 307, 308])(
    "rejects provider redirect %s after one request without forwarding credentials",
    async (status) => {
      const response = await worker!.fetch(`http://local.test/?status=${status}`);
      expect(await response.json()).toMatchObject({
        ok: false,
        calls: 1,
        redirectMode: "manual",
        authorizationMatches: true,
        status: 502,
        code: "production_database_provider_rejected",
        causeClass: "provider_rejected",
        providerStatus: status,
      });
    },
  );
});
