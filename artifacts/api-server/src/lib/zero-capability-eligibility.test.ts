import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type {
  RuntimeManifestContract,
  ZeroGeneratedDependencyPlan,
} from "@workspace/tenant-runtime-contracts";
import { makeZeroSealedNodeManifest, prepareZeroSealedNodeSource } from "./zero-sealed-generation";
import {
  ZeroCapabilityGapError,
  ZERO_ELIGIBILITY_ASSET_DIRECTORY,
  assertZeroGeneratedEligibility,
  evaluateZeroGeneratedEligibility,
  inferZeroDeclaredCapabilities,
  loadZeroEligibilityInventory,
  resolveZeroEligibilityRepositoryRoot,
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
import { createNabuFlowDatabase, createNabuFlowPayments } from "../nabuflow/runtime/index.js";
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
  it("finds the repository inventory from the bundled deployment layout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zero-eligibility-bundle-"));
    temporaryRoots.push(root);
    const assetRoot = path.join(
      root,
      "artifacts",
      "api-server",
      "dist",
      ZERO_ELIGIBILITY_ASSET_DIRECTORY,
    );
    await mkdir(path.join(assetRoot, "blueprints"), { recursive: true });
    await mkdir(path.join(assetRoot, "skills"), { recursive: true });
    const bundledModuleUrl = pathToFileURL(
      path.join(root, "artifacts", "api-server", "dist", "index.mjs"),
    ).href;

    expect(resolveZeroEligibilityRepositoryRoot(bundledModuleUrl, path.join(root, "runner"))).toBe(
      assetRoot,
    );
  });

  it("returns one deterministic typed inventory error when deployment assets are unavailable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zero-eligibility-missing-"));
    temporaryRoots.push(root);

    await expect(loadZeroEligibilityInventory(root)).rejects.toMatchObject({
      name: "ZeroEligibilityInventoryError",
      code: "zero_eligibility_unclassified",
      entries: ["blueprint:inventory_unavailable", "skill:inventory_unavailable"],
    });
  });

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

  it("allows only literal same-origin fetches in static browser assets", async () => {
    const value = prepared();
    const result = await evaluate({
      files: [
        ...value.files,
        {
          path: "public/index.html",
          mimeType: "text/html",
          content:
            '<script>fetch("/api/incidents"); fetch(\'/api/incidents/active\', { method: "POST" });</script>',
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it.each([
    ["server-side relative fetch", "src/index.ts", 'void fetch("/api/incidents");'],
    ["external browser fetch", "public/index.html", 'void fetch("https://example.test");'],
    ["protocol-relative browser fetch", "public/index.html", 'void fetch("//example.test");'],
    ["dynamic browser fetch", "public/index.html", "void fetch(runtimeTarget);"],
  ])("rejects %s", async (_label, filePath, content) => {
    const value = prepared();
    const files =
      filePath === "src/index.ts"
        ? value.files.map((file) =>
            file.path === filePath ? { ...file, content: `${file.content}\n${content}` } : file,
          )
        : [...value.files, { path: filePath, mimeType: "text/html", content }];
    const result = await evaluate({ files });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected arbitrary runtime fetch rejection");
    expect(result.reasons).toContainEqual({ code: "arbitrary_runtime_fetch", path: filePath });
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

  it("permits pg only behind the exact platform-owned Fly adapter bytes", async () => {
    const value = prepared();
    const tamperedFiles = value.files.map((file) =>
      file.path === "nabuflow/runtime/fly-postgres.ts"
        ? { ...file, content: `${file.content}\n// tampered` }
        : file,
    );
    const result = await evaluate({ files: tamperedFiles });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected the tampered adapter to fail closed");
    expect(result.reasons).toContainEqual({
      code: "raw_database_client",
      path: "package.json",
    });
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
