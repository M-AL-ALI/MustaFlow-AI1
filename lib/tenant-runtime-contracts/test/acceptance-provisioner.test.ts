import { describe, expect, it } from "vitest";
import {
  acceptanceLeaseCreateRequestSchema,
  acceptanceLeaseIdentity,
  acceptanceLeaseResponseSchema,
  acceptanceProvisionFlySecretRequestSchema,
  acceptanceWorkloadClaimsSchema,
} from "../src/acceptance-provisioner";

const neonLease = {
  schemaVersion: 1 as const,
  projectId: 42,
  scope: { provider: "neon" as const, organizationId: "org-dedicated-staging" },
  ttlSeconds: 1_800,
  costCeilingMinorUnits: 250,
};

describe("acceptance provisioner contract", () => {
  it("derives one stable content identity from the semantic lease envelope", async () => {
    await expect(acceptanceLeaseIdentity(neonLease)).resolves.toMatch(/^[0-9a-f]{64}$/u);
    expect(await acceptanceLeaseIdentity(structuredClone(neonLease))).toBe(
      await acceptanceLeaseIdentity(neonLease),
    );
    expect(await acceptanceLeaseIdentity({ ...neonLease, costCeilingMinorUnits: 251 })).not.toBe(
      await acceptanceLeaseIdentity(neonLease),
    );
  });

  it("fails closed on live Stripe and non-disposable Fly request shapes", () => {
    expect(
      acceptanceLeaseCreateRequestSchema.safeParse({
        ...neonLease,
        scope: { provider: "stripe", sandboxId: "acct_test", mode: "live" },
      }).success,
    ).toBe(false);
    expect(
      acceptanceLeaseCreateRequestSchema.safeParse({
        ...neonLease,
        scope: { provider: "fly", organizationSlug: "production", disposable: false },
      }).success,
    ).toBe(false);
  });

  it("keeps responses opaque and rejects secret-bearing or host-bearing additions", () => {
    const response = {
      ok: true as const,
      schemaVersion: 1 as const,
      leaseId: `nal_${"a".repeat(40)}`,
      provider: "neon" as const,
      resourceIds: ["project-opaque-id"],
      state: "active" as const,
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:01.000Z",
      expiresAt: "2026-08-11T01:00:00.000Z",
      cost: { currency: "USD" as const, amountMinorUnits: 0, ceilingMinorUnits: 250 },
    };
    expect(acceptanceLeaseResponseSchema.parse(response)).toEqual(response);
    expect(
      acceptanceLeaseResponseSchema.safeParse({
        ...response,
        connectionString: "postgresql://redacted.invalid",
      }).success,
    ).toBe(false);
    expect(
      acceptanceLeaseResponseSchema.safeParse({
        ...response,
        credential: ["rk", "test", "REDACTED"].join("_"),
      }).success,
    ).toBe(false);
  });

  it("bounds workload identity lifetime and cross-lease references", () => {
    expect(
      acceptanceWorkloadClaimsSchema.safeParse({
        iss: "https://identity.example",
        aud: "acceptance",
        sub: "runner:staging",
        iat: 1_000,
        exp: 1_601,
        jti: "workload-token-0001",
      }).success,
    ).toBe(false);
    expect(
      acceptanceProvisionFlySecretRequestSchema.parse({
        schemaVersion: 1,
        databaseLeaseId: `nal_${"b".repeat(40)}`,
      }),
    ).toMatchObject({ schemaVersion: 1 });
  });
});
