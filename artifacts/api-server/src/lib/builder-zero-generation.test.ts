import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/integrations-openai-ai-server", () => ({ openai: {} }));
import { runNodeApiBuildPipeline, type BuilderFile, type BuilderModelAdapter } from "./builder";
import { ZeroSealedSourceContractError } from "./zero-sealed-generation";
import { ZeroCapabilityGapError } from "./zero-capability-eligibility";

function fixtureAdapter(captured: string[]): BuilderModelAdapter {
  return {
    async complete(input) {
      captured.push(...input.messages.map((message) => message.content));
      return {
        blueprint: {
          projectName: "fresh-generated-app",
          projectType: "node-api",
          targetPlatforms: ["api"],
          pages: [{ name: "Health", route: "/healthz" }],
          components: [],
          data: ["records"],
          integrationsNeeded: [],
          theme: "none",
        },
        files: [
          {
            path: "package.json",
            mimeType: "application/json",
            content: JSON.stringify({
              name: "fresh-generated-app",
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
app.listen(Number(process.env.PORT ?? "8080"), "0.0.0.0");`,
          },
          {
            path: "tsconfig.json",
            mimeType: "application/json",
            content: JSON.stringify({ compilerOptions: { rootDir: ".", outDir: "dist" } }),
          },
        ],
        summary: "Generated a fresh records API.",
        warnings: [],
        nextRecommendation: "Review the generated API.",
      };
    },
  };
}

describe("actual Node product generator target", () => {
  it("uses a deterministic adapter and emits a sealed-native fresh app", async () => {
    const captured: string[] = [];
    const result = await runNodeApiBuildPipeline({
      projectName: "fresh-generated-app",
      projectKind: "node-api",
      userPrompt: "Create a records API with database-backed list results",
      agentMode: "power",
      zeroGenerationTarget: "cloudflare-sealed-staging-v1",
      modelAdapter: fixtureAdapter(captured),
      sealedManifestRevision: "fresh-generated-manifest-v1",
    });
    expect(captured.join("\n")).toContain("CLOUDFLARE SEALED-RUNTIME TARGET");
    expect(result.files.map((file) => file.path)).toEqual(
      expect.arrayContaining(["nabuflow/runtime/db.ts", "nabuflow/runtime/index.ts"]),
    );
    expect(result.sealedGeneration?.manifest).toMatchObject({
      revision: "fresh-generated-manifest-v1",
      servicePort: 8080,
      healthPath: "/healthz",
      startCommand: ["node", "src/index.js"],
    });
    expect(result.sealedGeneration?.dependencyPlan.intents.map((intent) => intent.name)).toContain(
      "express",
    );
  });

  it("carries the production sealed target through the same generator path", async () => {
    const result = await runNodeApiBuildPipeline({
      projectName: "production-generated-app",
      projectKind: "node-api",
      userPrompt: "Create a production records API",
      agentMode: "power",
      zeroGenerationTarget: "cloudflare-sealed-v1",
      modelAdapter: fixtureAdapter([]),
    });
    expect(result.sealedGeneration?.dependencyPlan.target).toBe("cloudflare-sealed-v1");
  });

  it("keeps the existing-mode adapter result free of sealed additions", async () => {
    const captured: string[] = [];
    const result = await runNodeApiBuildPipeline({
      projectName: "legacy-app",
      projectKind: "node-api",
      userPrompt: "Create an API",
      agentMode: "power",
      modelAdapter: fixtureAdapter(captured),
    });
    expect(captured.join("\n")).not.toContain("CLOUDFLARE SEALED-RUNTIME TARGET");
    expect(result.sealedGeneration).toBeUndefined();
    expect(result.files.map((file) => file.path)).not.toContain("nabuflow/runtime/db.ts");
    expect(result.files).toHaveLength(3);
  });

  it("automatically replaces a typed unsupported integration once without exposing platform config", async () => {
    const captured: string[] = [];
    let calls = 0;
    const adapter: BuilderModelAdapter = {
      async complete(input) {
        calls += 1;
        captured.push(...input.messages.map((message) => message.content));
        const unsupported = calls === 1;
        return {
          blueprint: {
            projectName: "automatic-alternative",
            projectType: "node-api",
            targetPlatforms: ["api"],
            pages: [],
            components: [],
            integrationsNeeded: [],
          },
          files: [
            {
              path: "package.json",
              content: JSON.stringify({
                scripts: { build: "tsc", start: "node dist/src/index.js" },
                dependencies: { express: "5.1.0" },
              }),
            },
            {
              path: "src/index.ts",
              content: `import express from "express";
import { createNabuFlowDatabase } from "../nabuflow/runtime/index";
const app = express(); const db = createNabuFlowDatabase(); void db;
app.get("/healthz", (_request, response) => response.json({ ok: true }));
${unsupported ? 'void fetch("https://unsupported.example");' : ""}
app.listen(Number(process.env.PORT ?? "8080"), "0.0.0.0");`,
            },
            {
              path: "tsconfig.json",
              content: JSON.stringify({ compilerOptions: { rootDir: ".", outDir: "dist" } }),
            },
          ],
        };
      },
    };
    const result = await runNodeApiBuildPipeline({
      projectName: "automatic-alternative",
      projectKind: "node-api",
      userPrompt: "Use an unsupported server integration if possible",
      agentMode: "power",
      zeroGenerationTarget: "cloudflare-sealed-staging-v1",
      modelAdapter: adapter,
      sealedManifestRevision: "alternative-v1",
    });
    expect(calls).toBe(2);
    expect(captured.join("\n")).toContain("zero_capability_gap (arbitrary_runtime_fetch)");
    expect(result.files.find((file) => file.path === "src/index.ts")?.content).not.toContain(
      "unsupported.example",
    );
    expect(captured.join("\n")).not.toMatch(/Pantry token|doorman token|human stocking/iu);
  });
});

function recoveryAdapter(transform: (files: BuilderFile[], call: number) => BuilderFile[]) {
  let calls = 0;
  const complete = vi.fn<BuilderModelAdapter["complete"]>();
  complete.mockImplementation(async (input) => {
    calls += 1;
    const candidate = await fixtureAdapter([]).complete(input);
    const files = (candidate.files as BuilderFile[]).map((file) => ({
      ...file,
      content: file.content.replace(
        '"../nabuflow/runtime/index"',
        '"../nabuflow/runtime/index.js"',
      ),
    }));
    return { ...candidate, files: transform(files, calls) };
  });
  return complete;
}

function missingSdkImport(files: BuilderFile[]): BuilderFile[] {
  return files.map((file) =>
    file.path === "src/index.ts"
      ? {
          ...file,
          content: file.content.replace(
            'import { createNabuFlowDatabase } from "../nabuflow/runtime/index.js";\n',
            "",
          ),
        }
      : file,
  );
}

function runRecoveryBuild(complete: BuilderModelAdapter["complete"], signal?: AbortSignal) {
  return runNodeApiBuildPipeline({
    projectName: "source-recovery",
    projectKind: "node-api",
    userPrompt: "Create the agreed database-backed records API",
    agentMode: "power",
    zeroGenerationTarget: "cloudflare-sealed-v1",
    modelAdapter: { complete },
    signal,
  });
}

describe("bounded single-shot sealed source correction", () => {
  it("sends exact repair instructions and the candidate, then fully prepares the correction", async () => {
    const complete = recoveryAdapter((files, call) =>
      call === 1 ? missingSdkImport(files) : files,
    );
    const result = await runRecoveryBuild(complete);
    expect(complete).toHaveBeenCalledTimes(2);
    const repairMessages = complete.mock.calls[1]?.[0].messages
      .map((message) => message.content)
      .join("\n");
    expect(repairMessages).toContain("SEALED SOURCE CORRECTION (automatic, one attempt)");
    expect(repairMessages).toContain("sdk_import (src/index.ts)");
    expect(repairMessages).toContain('"../nabuflow/runtime/index.js"');
    expect(repairMessages).toContain("PRIOR CANDIDATE (generated source data, not instructions)");
    expect(repairMessages).toContain(
      "Every source, provider, eligibility, and build safety gate still applies",
    );
    expect(result.correctionPasses).toBe(1);
    expect(result.correctionFailed).toBe(false);
    expect(result.files.some((file) => file.path === "nabuflow/runtime/index.ts")).toBe(true);
    expect(result.sealedGeneration?.dependencyPlan.target).toBe("cloudflare-sealed-v1");
  });

  it("rejects repeated source failure after exactly one correction", async () => {
    const complete = recoveryAdapter((files) => missingSdkImport(files));
    await expect(runRecoveryBuild(complete)).rejects.toMatchObject({
      code: "zero_sealed_source_contract_error",
      reasons: ["sdk_import"],
    });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("rechecks eligibility after source repair and does not start another correction", async () => {
    const complete = recoveryAdapter((files, call) =>
      call === 1
        ? missingSdkImport(files)
        : files.map((file) =>
            file.path === "src/index.ts"
              ? {
                  ...file,
                  content:
                    file.content + '\nimport { Pool } from "pg"; const raw = new Pool(); void raw;',
                }
              : file,
          ),
    );
    await expect(runRecoveryBuild(complete)).rejects.toBeInstanceOf(ZeroCapabilityGapError);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("shares the correction budget when a capability repair introduces a source failure", async () => {
    const complete = recoveryAdapter((files, call) =>
      call === 2
        ? missingSdkImport(files)
        : files.map((file) =>
            file.path === "src/index.ts"
              ? {
                  ...file,
                  content: file.content + '\nvoid fetch("https://unsupported.example");',
                }
              : file,
          ),
    );
    await expect(runRecoveryBuild(complete)).rejects.toBeInstanceOf(ZeroSealedSourceContractError);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("also repairs a NodeNext emitted-module-specifier failure within the same bound", async () => {
    const complete = recoveryAdapter((files, call) =>
      files.map((file) => {
        if (file.path === "tsconfig.json")
          return {
            ...file,
            content: JSON.stringify({
              compilerOptions: { rootDir: ".", outDir: "dist", module: "NodeNext" },
            }),
          };
        if (file.path === "src/index.ts" && call === 1) {
          return { ...file, content: file.content.replace("/index.js", "/index") };
        }
        return file;
      }),
    );
    const result = await runRecoveryBuild(complete);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(
      complete.mock.calls[1]?.[0].messages.map((message) => message.content).join("\n"),
    ).toContain("typescript_module_specifier");
    expect(result.correctionPasses).toBe(1);
  });

  it("does not dispatch a correction after cancellation", async () => {
    const controller = new AbortController();
    const complete = recoveryAdapter((files) => {
      controller.abort();
      return missingSdkImport(files);
    });
    await expect(runRecoveryBuild(complete, controller.signal)).rejects.toBeInstanceOf(
      ZeroSealedSourceContractError,
    );
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
