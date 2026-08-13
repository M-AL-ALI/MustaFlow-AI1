import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ZERO_SEALED_GENERATION_GATE_ENV,
  ZERO_PANTRY_PUBLIC_KEYS_ENV,
  ZERO_SEALED_RUNTIME_PORT,
  validateRuntimeArtifactPath,
} from "@workspace/tenant-runtime-contracts";
import {
  ZeroSealedSourceContractError,
  ZeroSealedGenerationConfigurationError,
  prepareZeroSealedNodeSource,
  readZeroPantryPublicKeys,
  requiresDirectProjectDatabaseProvisioning,
  resolveZeroGenerationTarget,
} from "./zero-sealed-generation";

function generatedFiles(sourceOnlyChange = false) {
  return [
    {
      path: "package.json",
      mimeType: "application/json",
      content: JSON.stringify({
        name: "fresh-zero-app",
        private: true,
        scripts: { build: "tsc", start: "node dist/src/index.js" },
        dependencies: { express: "^4.21.0", zod: "^3.23.8" },
        devDependencies: {
          "@types/express": "^4.17.21",
          "@types/node": "^22.0.0",
          typescript: "^5.6.3",
        },
      }),
    },
    {
      path: "src/index.ts",
      mimeType: "application/typescript",
      content: `import express from "express";
import { createNabuFlowDatabase } from "../nabuflow/runtime/index";
const app = express(); const db = createNabuFlowDatabase();
app.get("/healthz", (_request, response) => response.json({ ok: true }));
app.get("/records", async (_request, response) => response.json(await db.query("select 1")));
app.get("/", (_request, response) => response.send(${JSON.stringify(sourceOnlyChange ? "changed" : "fresh")}));
app.listen(Number(process.env.PORT ?? "8080"), "0.0.0.0");`,
    },
    {
      path: "tsconfig.json",
      mimeType: "application/json",
      content: JSON.stringify({
        compilerOptions: { outDir: "dist", rootDir: ".", module: "commonjs" },
      }),
    },
  ];
}

describe("Zero sealed generator integration", () => {
  it("is inert unless every deployment-owned staging lock agrees", () => {
    expect(resolveZeroGenerationTarget({})).toBe("legacy-v1");
    expect(() =>
      resolveZeroGenerationTarget({
        [ZERO_SEALED_GENERATION_GATE_ENV]: "cloudflare-sealed-staging-v1",
        TENANT_RUNTIME_PROVIDER: "fly",
        CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE: "staging",
      }),
    ).toThrow(ZeroSealedGenerationConfigurationError);
    expect(() =>
      resolveZeroGenerationTarget({
        [ZERO_SEALED_GENERATION_GATE_ENV]: "cloudflare-sealed-staging-v1",
        TENANT_RUNTIME_PROVIDER: "cloudflare",
        CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE: "production",
      }),
    ).toThrow(ZeroSealedGenerationConfigurationError);
    expect(
      resolveZeroGenerationTarget({
        [ZERO_SEALED_GENERATION_GATE_ENV]: "cloudflare-sealed-staging-v1",
        TENANT_RUNTIME_PROVIDER: "cloudflare",
        CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE: "staging",
      }),
    ).toBe("cloudflare-sealed-staging-v1");
    expect(requiresDirectProjectDatabaseProvisioning({})).toBe(true);
    expect(
      requiresDirectProjectDatabaseProvisioning({
        [ZERO_SEALED_GENERATION_GATE_ENV]: "cloudflare-sealed-staging-v1",
        TENANT_RUNTIME_PROVIDER: "cloudflare",
        CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE: "staging",
      }),
    ).toBe(false);
  });

  it("injects the vendored SDK and emits a canonical Pantry plan", () => {
    const prepared = prepareZeroSealedNodeSource({
      files: generatedFiles(),
      manifestRevision: "zero-generated-node-v1",
    });
    expect(prepared.files.map((file) => file.path)).toContain("nabuflow/runtime/db.ts");
    expect(prepared.files.map((file) => file.path)).toContain("nabuflow/runtime/index.ts");
    expect(prepared.dependencyPlan.intents.map((intent) => intent.name)).toEqual([
      "@types/express",
      "@types/node",
      "express",
      "typescript",
      "zod",
    ]);
    expect(prepared.manifest.servicePort).toBe(ZERO_SEALED_RUNTIME_PORT);
    expect(prepared.manifest.healthPath).toBe("/healthz");
  });

  it("emits a complete trusted-build-safe tree with resolvable non-hidden SDK imports", () => {
    const prepared = prepareZeroSealedNodeSource({
      files: generatedFiles(),
      manifestRevision: "zero-generated-node-v1",
    });
    expect(
      prepared.files.every((file) => validateRuntimeArtifactPath(file.path) === file.path),
    ).toBe(true);
    expect(validateRuntimeArtifactPath(".nabuflow/runtime/db.ts")).toBeNull();
    expect(prepared.files.some((file) => file.path.startsWith("."))).toBe(false);
    expect(prepared.files.some((file) => file.content.includes(".nabuflow/runtime"))).toBe(false);

    const entry = prepared.files.find((file) => file.path === "src/index.ts");
    const importSpecifier = entry?.content.match(/from\s+"([^"]*nabuflow\/runtime\/index)"/u)?.[1];
    expect(importSpecifier).toBe("../nabuflow/runtime/index");
    const importTarget = posix.normalize(
      posix.join(posix.dirname(entry?.path ?? ""), `${importSpecifier}.ts`),
    );
    expect(prepared.files.some((file) => file.path === importTarget)).toBe(true);
  });

  it("loads public-only Pantry verification material and rejects private keys", () => {
    expect(
      readZeroPantryPublicKeys({
        [ZERO_PANTRY_PUBLIC_KEYS_ENV]: JSON.stringify({
          "pantry-staging-v1": "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
        }),
      }).get("pantry-staging-v1"),
    ).toContain("BEGIN PUBLIC KEY");
    expect(() =>
      readZeroPantryPublicKeys({
        [ZERO_PANTRY_PUBLIC_KEYS_ENV]: JSON.stringify({
          bad: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
        }),
      }),
    ).toThrow(ZeroSealedGenerationConfigurationError);
  });

  it("keeps dependency closure stable for source-only edits", () => {
    const first = prepareZeroSealedNodeSource({
      files: generatedFiles(),
      manifestRevision: "manifest-v1",
    });
    const changed = prepareZeroSealedNodeSource({
      files: generatedFiles(true),
      manifestRevision: "manifest-v2",
    });
    expect(changed.dependencyPlan).toEqual(first.dependencyPlan);
    expect(changed.files.find((file) => file.path === "src/index.ts")?.content).not.toBe(
      first.files.find((file) => file.path === "src/index.ts")?.content,
    );
  });

  it.each([
    ["credential env", "process.env.DATABASE_URL"],
    ["tenant install", "npm install express"],
    ["direct registry", "https://registry.npmjs.org/express"],
  ])("fails closed on %s", (_label, planted) => {
    const files = generatedFiles();
    files.push({ path: "src/unsafe.ts", mimeType: "application/typescript", content: planted });
    try {
      prepareZeroSealedNodeSource({ files, manifestRevision: "manifest-v1" });
      throw new Error("expected sealed source contract rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ZeroSealedSourceContractError);
      expect(error).toMatchObject({
        code: "zero_sealed_source_contract_error",
        reasons: ["credential_or_dependency_egress"],
        path: "src/unsafe.ts",
      });
    }
  });

  it("memorializes the pre-slice legacy Node prompt bytes", async () => {
    const source = await readFile(new URL("./builder.ts", import.meta.url), "utf8");
    const prefix = "const NODE_API_BUILD_SYSTEM_PROMPT = `";
    const start = source.indexOf(prefix);
    const end = source.indexOf("`;\n\nconst NODE_API_REFINE_SYSTEM_PROMPT", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const prompt = source.slice(start + prefix.length, end);
    expect(createHash("sha256").update(prompt).digest("hex")).toBe(
      "e7aaf4f30a4e9852da473c8c073f4f9e748fe8802965c819b5b0a1cc7a42e269",
    );
  });
});
