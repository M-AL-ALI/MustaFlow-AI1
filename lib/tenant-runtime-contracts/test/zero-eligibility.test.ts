import { describe, expect, it } from "vitest";
import {
  ZERO_ELIGIBILITY_FORMAT,
  ZERO_ELIGIBILITY_SCHEMA_VERSION,
  deriveZeroEligibilityIdentity,
  deriveZeroIntegrationEligibilityIdentity,
  zeroCapabilityEligibilityMetadataContractSchema,
  zeroEligibilityEnvelopeSchema,
  zeroEligibilityResultSchema,
  type ZeroEligibilityEnvelope,
} from "../src";

const FILE_HASH = "1".repeat(64);

function envelope(): ZeroEligibilityEnvelope {
  return zeroEligibilityEnvelopeSchema.parse({
    target: "cloudflare-sealed-staging-v1",
    toolchain: "node-api",
    files: [{ path: "src/index.ts", sha256: FILE_HASH }],
    dependencyPlan: {
      format: "nabu-zero-generation/v1",
      schemaVersion: 1,
      target: "cloudflare-sealed-staging-v1",
      intents: [{ ecosystem: "npm", name: "express", selector: "5.1.0" }],
    },
    runtimeManifest: {
      revision: "manifest-v1",
      runtime: "node-api",
      buildCommand: ["npm", "run", "build"],
      startCommand: ["node", "src/index.js"],
      servicePort: 8080,
      healthPath: "/healthz",
      resourceProfile: "dev",
      public: false,
    },
    declaredCapabilities: ["database"],
    pantryClosureVerified: true,
    dependencyOutputAttested: true,
  });
}

describe("Zero capability eligibility contracts", () => {
  it("parses eligible and typed-ineligible metadata", () => {
    expect(
      zeroCapabilityEligibilityMetadataContractSchema.parse({
        format: ZERO_ELIGIBILITY_FORMAT,
        schemaVersion: ZERO_ELIGIBILITY_SCHEMA_VERSION,
        kind: "blueprint",
        id: "db-postgres",
        legacy: { mode: "direct", behavior: "preserve" },
        cloudflare: {
          status: "eligible",
          resolution: "capability",
          capabilities: ["database"],
          reasons: [],
          sealedGuidance: "Use createNabuFlowDatabase from nabuflow/runtime.",
        },
        build: {
          toolchains: ["node-api"],
          pantryPolicy: "dynamic-demand-driven",
          attestationRequired: true,
        },
      }).cloudflare.status,
    ).toBe("eligible");

    expect(
      zeroCapabilityEligibilityMetadataContractSchema.parse({
        format: ZERO_ELIGIBILITY_FORMAT,
        schemaVersion: ZERO_ELIGIBILITY_SCHEMA_VERSION,
        kind: "skill",
        id: "firebase",
        legacy: { mode: "direct", behavior: "preserve" },
        cloudflare: {
          status: "ineligible",
          resolution: "refuse",
          capabilities: [],
          reasons: [{ code: "credential_assumption" }],
        },
        build: {
          toolchains: [],
          pantryPolicy: "dynamic-demand-driven",
          attestationRequired: true,
        },
      }).cloudflare.status,
    ).toBe("ineligible");
  });

  it("derives content-addressed integration outcomes from canonical metadata", async () => {
    const metadata = zeroCapabilityEligibilityMetadataContractSchema.parse({
      format: ZERO_ELIGIBILITY_FORMAT,
      schemaVersion: ZERO_ELIGIBILITY_SCHEMA_VERSION,
      kind: "blueprint",
      id: "payments-stripe",
      legacy: { mode: "direct", behavior: "preserve" },
      cloudflare: {
        status: "eligible",
        resolution: "capability",
        capabilities: ["stripe-payments"],
        reasons: [],
        sealedGuidance: "Use the vendored payments capability.",
      },
      build: {
        toolchains: ["node-api"],
        pantryPolicy: "dynamic-demand-driven",
        attestationRequired: true,
      },
    });
    const identity = await deriveZeroIntegrationEligibilityIdentity(metadata);
    expect(await deriveZeroIntegrationEligibilityIdentity(structuredClone(metadata))).toBe(
      identity,
    );
    expect(metadata.cloudflare.status).toBe("eligible");
    if (metadata.cloudflare.status !== "eligible") throw new Error("Fixture must be eligible");
    expect(
      await deriveZeroIntegrationEligibilityIdentity({
        ...metadata,
        cloudflare: { ...metadata.cloudflare, sealedGuidance: "Changed semantic guidance." },
      }),
    ).not.toBe(identity);
  });

  it("derives one deterministic, content-sensitive identity with no transient fields", async () => {
    const first = envelope();
    const firstHash = await deriveZeroEligibilityIdentity(first);
    expect(await deriveZeroEligibilityIdentity(structuredClone(first))).toBe(firstHash);
    expect(
      await deriveZeroEligibilityIdentity({
        ...first,
        files: [{ path: "src/index.ts", sha256: "2".repeat(64) }],
      }),
    ).not.toBe(firstHash);
    expect(JSON.stringify(first)).not.toMatch(/timestamp|createdAt|updatedAt/u);
  });

  it("rejects non-canonical file order and preserves typed capability gaps", () => {
    expect(() =>
      zeroEligibilityEnvelopeSchema.parse({
        ...envelope(),
        files: [
          { path: "z.ts", sha256: FILE_HASH },
          { path: "a.ts", sha256: FILE_HASH },
        ],
      }),
    ).toThrow(/canonically sorted/u);

    expect(() =>
      zeroEligibilityEnvelopeSchema.parse({
        ...envelope(),
        target: "cloudflare-sealed-v1",
      }),
    ).toThrow(/generation targets must match/u);

    expect(
      zeroEligibilityResultSchema.parse({
        ok: false,
        code: "zero_capability_gap",
        retryable: false,
        identitySha256: FILE_HASH,
        reasons: [{ code: "arbitrary_runtime_fetch", path: "src/index.ts" }],
      }),
    ).toMatchObject({ ok: false, code: "zero_capability_gap" });
  });
});
