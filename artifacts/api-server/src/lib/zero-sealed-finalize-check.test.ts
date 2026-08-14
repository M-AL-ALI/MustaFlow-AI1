import { describe, expect, it } from "vitest";
import { checkZeroSealedFinalizeContract } from "./zero-sealed-finalize-check";

function packageFile() {
  return {
    path: "package.json",
    mimeType: "application/json",
    content: JSON.stringify({
      scripts: { build: "tsc", start: "node dist/src/index.js" },
      dependencies: { express: "4.21.2" },
    }),
  };
}

const tsconfigFile = {
  path: "tsconfig.json",
  mimeType: "application/json",
  content: JSON.stringify({ compilerOptions: { rootDir: ".", outDir: "dist" } }),
};

describe("sealed source finalize gate", () => {
  it("keeps a repairable sealed-source miss inside Zero's generation loop", async () => {
    const result = await checkZeroSealedFinalizeContract({
      files: [
        packageFile(),
        tsconfigFile,
        {
          path: "src/index.ts",
          mimeType: "application/typescript",
          content: `import express from "express";
const app = express();
const port = process.env.PORT ?? "3000";
app.get("/healthz", (_request, response) => response.json({ ok: true }));
app.listen(port);`,
        },
      ],
      manifestRevision: "finalize-regression-v1",
    });
    expect(result).toEqual({
      passed: false,
      code: "zero_sealed_source_contract_error",
      reasonCodes: ["sdk_import", "network_bind"],
      message:
        'zero_sealed_source_contract_error: sdk_import, network_bind (src/index.ts). Required repairs: import and use createNabuFlowDatabase/createNabuFlowPayments as needed from "../nabuflow/runtime/index" in src/index.ts; do not use provider clients; bind the HTTP server explicitly with app.listen(port, "0.0.0.0", callback)',
    });
  });

  it("returns actionable repair guidance for every sealed-source reason", async () => {
    const result = await checkZeroSealedFinalizeContract({
      files: [],
      manifestRevision: "manifest-v1",
    });

    expect(result).toMatchObject({
      passed: false,
      code: "zero_sealed_source_contract_error",
      reasonCodes: ["required_files"],
    });
    expect(result.message).toContain("create package.json, tsconfig.json, and src/index.ts");
  });

  it("rejects .env example files before the trusted-build source scan", async () => {
    const result = await checkZeroSealedFinalizeContract({
      files: [
        packageFile(),
        tsconfigFile,
        {
          path: ".env.example",
          mimeType: "text/plain",
          content: "PORT=8080\n",
        },
        {
          path: "src/index.ts",
          mimeType: "application/typescript",
          content: `import express from "express";
import { createNabuFlowDatabase } from "../nabuflow/runtime/index";
const app = express(); const db = createNabuFlowDatabase(); void db;
app.get("/healthz", (_request, response) => response.json({ ok: true }));
app.listen(Number(process.env.PORT ?? "8080"), "0.0.0.0");`,
        },
      ],
      manifestRevision: "finalize-env-file-regression-v1",
    });

    expect(result).toMatchObject({
      passed: false,
      code: "zero_sealed_source_contract_error",
      reasonCodes: ["credential_or_dependency_egress"],
    });
    expect(result.message).toContain("(.env.example)");
    expect(result.message).toContain("remove .env files (including .env.example)");
  });

  it("passes a complete sealed-native candidate", async () => {
    const result = await checkZeroSealedFinalizeContract({
      files: [
        packageFile(),
        tsconfigFile,
        {
          path: "src/index.ts",
          mimeType: "application/typescript",
          content: `import express from "express";
import { createNabuFlowDatabase } from "../nabuflow/runtime/index";
const app = express(); const db = createNabuFlowDatabase(); void db;
app.get("/healthz", (_request, response) => response.json({ ok: true }));
app.listen(Number(process.env.PORT ?? "8080"), "0.0.0.0");`,
        },
      ],
      manifestRevision: "finalize-regression-v2",
    });
    expect(result).toMatchObject({ passed: true, code: "zero_sealed_source_ready" });
  });
});
