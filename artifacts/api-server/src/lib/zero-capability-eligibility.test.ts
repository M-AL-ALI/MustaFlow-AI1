import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  RuntimeManifestContract,
  ZeroGeneratedDependencyPlan,
} from "@workspace/tenant-runtime-contracts";
import { makeZeroSealedNodeManifest, prepareZeroSealedNodeSource } from "./zero-sealed-generation";
import {
  ZeroCapabilityGapError,
  assertZeroGeneratedEligibility,
  evaluateZeroGeneratedEligibility,
  inferZeroDeclaredCapabilities,
  loadZeroEligibilityInventory,
  resolveZeroIntegrationEligibility,
} from "./zero-capability-eligibility";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function generatedFiles(source = ""): Array<{ path: string; content: string; mimeType: string }> {
  return [
    {
      path: "package.json",
      mimeType: "application/json",
      content: JSON.stringify({
        scripts: { build: "tsc", start: "node dist/src/index.js" },
        dependencies: { express: "5.1.0" },
      }),
    },
    {
      path: "src/index.ts",
      mimeType: "application/typescript",
      content: `import express from "express";
import { createNabuFlowDatabase, createNabuFlowPayments } from "../nabuflow/runtime/index";
const app = express(); const db = createNabuFlowDatabase(); const payments = createNabuFlowPayments();
void db; void payments;
app.get("/healthz", (_request, response) => response.json({ ok: true }));
${source}
app.listen(Number(process.env.PORT ?? "8080"), "0.0.0.0");`,
    },
    {
      path: "tsconfig.json",
      mimeType: "application/json",
      content: JSON.stringify({ compilerOptions: { rootDir: ".", outDir: "dist" } }),
    },
  ];
}

function prepared(source = "") {
  return prepareZeroSealedNodeSource({
    files: generatedFiles(source),
    manifestRevision: "elig-v1",
    skipEligibilityPrecheck: true,
  });
}

async function evaluate(
  overrides: Partial<Parameters<typeof evaluateZeroGeneratedEligibility>[0]> = {},
) {
  const value = prepared();
  return evaluateZeroGeneratedEligibility({
    files: value.files,
    dependencyPlan: value.dependencyPlan,
    runtimeManifest: value.manifest,
    declaredCapabilities: ["database", "stripe-payments"],
    pantryClosureVerified: true,
    dependencyOutputAttested: true,
    ...overrides,
  });
}

describe("Zero blueprint and skill capability eligibility", () => {
  it("classifies the exhaustive 40-blueprint/31-skill inventory", async () => {
    const inventory = await loadZeroEligibilityInventory();
    expect(inventory.blueprints.size).toBe(40);
    expect(inventory.skills.size).toBe(31);
    expect(inventory.blueprints.get("db-postgres")?.cloudflare).toMatchObject({
      status: "eligible",
      capabilities: ["database"],
    });
    expect(inventory.blueprints.get("payments-stripe")?.cloudflare).toMatchObject({
      status: "eligible",
      capabilities: ["stripe-payments"],
    });
    for (const id of ["ai-openai", "auth-clerk-managed", "storage-s3", "comm-twilio"]) {
      expect(inventory.blueprints.get(id)?.cloudflare.status).toBe("ineligible");
    }
    expect(inventory.skills.get("postgres-drizzle")?.cloudflare.status).toBe("eligible");
    expect(inventory.skills.get("stripe-payments")?.cloudflare.status).toBe("eligible");
  });

  it("fails CI-style inventory loading when any integration is unclassified", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zero-eligibility-"));
    temporaryRoots.push(root);
    await mkdir(path.join(root, "blueprints", "new-blueprint"), { recursive: true });
    await mkdir(path.join(root, "skills", "new-skill"), { recursive: true });
    await writeFile(path.join(root, "blueprints", "new-blueprint", "blueprint.json"), "{}", "utf8");
    await writeFile(path.join(root, "skills", "new-skill", "SKILL.md"), "# test", "utf8");
    await expect(loadZeroEligibilityInventory(root)).rejects.toMatchObject({
      name: "ZeroEligibilityInventoryError",
      code: "zero_eligibility_unclassified",
      entries: ["blueprint:new-blueprint", "skill:new-skill"],
      reasons: [
        { code: "unclassified_integration", path: "blueprint:new-blueprint" },
        { code: "unclassified_integration", path: "skill:new-skill" },
      ],
    });
  });

  it("serves capability guidance only for sealed mode and typed gaps otherwise", async () => {
    const postgres = await resolveZeroIntegrationEligibility("blueprint", "db-postgres");
    const openAi = await resolveZeroIntegrationEligibility("blueprint", "ai-openai");
    expect(postgres.cloudflare).toMatchObject({ status: "eligible", resolution: "capability" });
    expect(JSON.stringify(postgres.cloudflare)).toContain("createNabuFlowDatabase");
    expect(openAi.cloudflare).toMatchObject({ status: "ineligible", resolution: "refuse" });
    expect(JSON.stringify(openAi.cloudflare)).not.toMatch(/human|stock(?:ing)? request/iu);
  });

  it("accepts DB and Stripe capability examples with dynamic Pantry policy", async () => {
    const value = prepared();
    const result = await assertZeroGeneratedEligibility({
      files: value.files,
      dependencyPlan: value.dependencyPlan,
      runtimeManifest: value.manifest,
      declaredCapabilities: inferZeroDeclaredCapabilities(value.files),
      pantryClosureVerified: true,
      dependencyOutputAttested: true,
    });
    expect(result).toMatchObject({
      ok: true,
      code: "zero_generation_eligible",
      capabilities: ["database", "stripe-payments"],
    });
    const inventory = await loadZeroEligibilityInventory();
    expect(
      [...inventory.blueprints.values(), ...inventory.skills.values()].every(
        (item) => item.build.pantryPolicy === "dynamic-demand-driven",
      ),
    ).toBe(true);
  });

  it.each([
    [
      "undeclared_dependency",
      async () => {
        const value = prepared();
        const dependencyPlan: ZeroGeneratedDependencyPlan = {
          ...value.dependencyPlan,
          intents: value.dependencyPlan.intents.filter((intent) => intent.name !== "express"),
        };
        // Keep the plan contract non-empty while creating a semantic mismatch.
        dependencyPlan.intents = [{ ecosystem: "npm", name: "zod", selector: "4.0.0" }];
        return evaluate({ dependencyPlan });
      },
    ],
    ["pantry_unresolvable_dependency", () => evaluate({ pantryClosureVerified: false })],
    [
      "credential_assumption",
      () => evaluate({ files: prepared("const token = process.env.API_TOKEN;").files }),
    ],
    [
      "port_manifest_incompatible",
      () => {
        const manifest = {
          ...makeZeroSealedNodeManifest("elig-v1"),
          servicePort: 9090,
        } as RuntimeManifestContract;
        return evaluate({ runtimeManifest: manifest });
      },
    ],
    ["unsupported_toolchain", () => evaluate({ toolchain: "python-flask" })],
    [
      "raw_database_client",
      () => evaluate({ files: prepared('import pg from "pg"; void pg;').files }),
    ],
    [
      "raw_payment_client",
      () => evaluate({ files: prepared('import Stripe from "stripe"; void Stripe;').files }),
    ],
    [
      "arbitrary_runtime_fetch",
      () => evaluate({ files: prepared('void fetch("https://example.test");').files }),
    ],
    [
      "tenant_package_install",
      () => evaluate({ files: prepared('const command = "npm install left-pad";').files }),
    ],
    ["undeclared_capability", () => evaluate({ declaredCapabilities: [] })],
    ["dependency_output_unattested", () => evaluate({ dependencyOutputAttested: false })],
  ] as const)("returns typed reason %s", async (reason, run) => {
    const result = await run();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected a typed capability gap");
    expect(result.code).toBe("zero_capability_gap");
    expect(result.reasons.map((entry) => entry.code)).toContain(reason);
  });

  it("throws the structured result rather than an untyped eligibility error", async () => {
    await expect(
      assertZeroGeneratedEligibility({
        ...(() => {
          const value = prepared('void fetch("https://example.test");');
          return {
            files: value.files,
            dependencyPlan: value.dependencyPlan,
            runtimeManifest: value.manifest,
          };
        })(),
        declaredCapabilities: ["database", "stripe-payments"],
        pantryClosureVerified: true,
        dependencyOutputAttested: true,
      }),
    ).rejects.toBeInstanceOf(ZeroCapabilityGapError);
  });
});
