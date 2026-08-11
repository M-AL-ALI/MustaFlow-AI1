import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/integrations-openai-ai-server", () => ({ openai: {} }));
import { runNodeApiBuildPipeline, type BuilderModelAdapter } from "./builder";

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
});
