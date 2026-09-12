import { describe, expect, it } from "vitest";
import {
  ZERO_SEALED_GENERATION_GATE_VALUE,
  ZERO_SEALED_PRODUCTION_GENERATION_GATE_VALUE,
} from "@workspace/tenant-runtime-contracts";
import { checksForLiveServerCapability, type CheckSpec } from "./check-profiles";
import {
  checkZeroSealedFinalizeContract,
  describeZeroSealedSourceRepairs,
  formatZeroSealedFinalizeFailure,
  withZeroSealedSourceCheck,
  ZERO_SEALED_SOURCE_CHECK_ID,
} from "./zero-sealed-finalize-check";

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
      reasonCodes: ["network_bind"],
      message:
        'zero_sealed_source_contract_error: network_bind (src/index.ts). Required repairs: bind the HTTP server explicitly with app.listen(port, "0.0.0.0", callback)',
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
import { createNabuFlowDatabase } from "../nabuflow/runtime/index.js";
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
import { createNabuFlowDatabase } from "../nabuflow/runtime/index.js";
const app = express(); const db = createNabuFlowDatabase(); void db;
app.get("/healthz", (_request, response) => response.json({ ok: true }));
app.listen(Number(process.env.PORT ?? "8080"), "0.0.0.0");`,
        },
      ],
      manifestRevision: "finalize-regression-v2",
    });
    expect(result).toMatchObject({ passed: true, code: "zero_sealed_source_ready" });
  });

  it("accepts the equivalent single-quoted 0.0.0.0 listen binding", async () => {
    const result = await checkZeroSealedFinalizeContract({
      files: [
        packageFile(),
        tsconfigFile,
        {
          path: "src/index.ts",
          mimeType: "application/typescript",
          content: `import express from "express";
import { createNabuFlowDatabase } from "../nabuflow/runtime/index.js";
const app = express(); const db = createNabuFlowDatabase(); void db;
app.get("/healthz", (_request, response) => response.json({ ok: true }));
app.listen(Number(process.env.PORT ?? "8080"), '0.0.0.0', () => undefined);`,
        },
      ],
      manifestRevision: "finalize-single-quote-regression-v1",
    });

    expect(result).toMatchObject({ passed: true, code: "zero_sealed_source_ready" });
  });

  it("does not accept an unrelated 0.0.0.0 string as a listen binding", async () => {
    const result = await checkZeroSealedFinalizeContract({
      files: [
        packageFile(),
        tsconfigFile,
        {
          path: "src/index.ts",
          mimeType: "application/typescript",
          content: `import express from "express";
import { createNabuFlowDatabase } from "../nabuflow/runtime/index.js";
const app = express(); const db = createNabuFlowDatabase(); void db;
const advertisedHost = "0.0.0.0"; void advertisedHost;
app.get("/healthz", (_request, response) => response.json({ ok: true }));
app.listen(Number(process.env.PORT ?? "8080"));`,
        },
      ],
      manifestRevision: "finalize-unrelated-host-regression-v1",
    });

    expect(result).toMatchObject({
      passed: false,
      code: "zero_sealed_source_contract_error",
      reasonCodes: ["network_bind"],
    });
  });
});

describe("sealed SDK repair feedback", () => {
  it("returns exact SDK guidance for a missing capability binding", async () => {
    const result = await checkZeroSealedFinalizeContract({
      files: [
        packageFile(),
        tsconfigFile,
        {
          path: "src/index.ts",
          mimeType: "application/typescript",
          content: `import express from "express";
const app = express(); const db = createNabuFlowDatabase(); void db;
app.get("/healthz", (_request, response) => response.json({ ok: true }));
app.listen(Number(process.env.PORT ?? "8080"), "0.0.0.0");`,
        },
      ],
    });
    expect(result).toMatchObject({
      passed: false,
      code: "zero_sealed_source_contract_error",
      reasonCodes: ["sdk_import"],
    });
    expect(result.message).toContain("(src/index.ts)");
    expect(result.message).toContain(describeZeroSealedSourceRepairs(["sdk_import"]));
    expect(result.message).toContain('"../nabuflow/runtime/index.js"');
    expect(result.message).toContain('"../../nabuflow/runtime/index.js"');
  });

  it("passes a canonical helper import through source preparation and eligibility", async () => {
    const result = await checkZeroSealedFinalizeContract({
      files: [
        packageFile(),
        tsconfigFile,
        {
          path: "src/index.ts",
          mimeType: "application/typescript",
          content: `import express from "express";
import { db } from "./data/db.js";
const app = express(); void db;
app.get("/healthz", (_request, response) => response.json({ ok: true }));
app.listen(Number(process.env.PORT ?? "8080"), "0.0.0.0");`,
        },
        {
          path: "src/data/db.ts",
          mimeType: "application/typescript",
          content:
            'import { createNabuFlowDatabase } from "../../nabuflow/runtime/index.js"; export const db = createNabuFlowDatabase();',
        },
      ],
    });
    expect(result).toMatchObject({ passed: true, code: "zero_sealed_source_ready" });
  });

  it("retains exact actionable SDK repairs after observation truncation", () => {
    const observation = formatZeroSealedFinalizeFailure(
      {
        passed: false,
        code: "zero_sealed_source_contract_error",
        reasonCodes: ["sdk_import"],
        message: `zero_sealed_source_contract_error: sdk_import (${"long-path/".repeat(2000)})`,
      },
      [`- typecheck: ${"diagnostic ".repeat(2000)}`],
    ).slice(0, 4000);
    expect(observation).toHaveLength(4000);
    expect(observation).toContain(describeZeroSealedSourceRepairs(["sdk_import"]));
    expect(observation).toContain("Fix the failures and call finalize again.");
    expect(observation).toContain("do not use provider clients");
  });

  it("keeps all requested repairs ahead of lengthy unrelated check failures", () => {
    const reasons = ["sdk_import", "runtime_asset_dependency", "network_bind"];
    const observation = formatZeroSealedFinalizeFailure(
      {
        passed: false,
        code: "zero_sealed_source_contract_error",
        reasonCodes: reasons,
        message: "source contract failed",
      },
      ["- typecheck: " + "x".repeat(20000)],
    ).slice(0, 4000);
    expect(observation).toContain(describeZeroSealedSourceRepairs(reasons));
    expect(observation).toContain("Fix the failures and call finalize again.");
  });
});

describe("sealed source check profile", () => {
  const runtimeCheck: CheckSpec = {
    id: "server-start",
    label: "Server",
    runner: "container",
    argv: ["node", "server.js"],
    required: true,
    timeoutMs: 1000,
  };

  it.each([ZERO_SEALED_GENERATION_GATE_VALUE, ZERO_SEALED_PRODUCTION_GENERATION_GATE_VALUE])(
    "keeps source validation required without a live container for %s",
    (target) => {
      const checks = withZeroSealedSourceCheck(
        checksForLiveServerCapability([runtimeCheck], false),
        target,
      );
      expect(checks[0]).toMatchObject({
        id: ZERO_SEALED_SOURCE_CHECK_ID,
        runner: "inprocess",
        required: true,
      });
      expect(checks[1]).toMatchObject({ id: "server-start", required: false });
      expect(runtimeCheck.required).toBe(true);
      expect(withZeroSealedSourceCheck(checks, target)).toEqual(checks);
    },
  );

  it("does not change a non-sealed project's checks", () => {
    const checks = [runtimeCheck];
    expect(withZeroSealedSourceCheck(checks, undefined)).toBe(checks);
  });

  it("identifies a retained browser starter before finalization without changing files", async () => {
    const files = [
      packageFile(),
      {
        ...tsconfigFile,
        content: JSON.stringify({
          compilerOptions: { rootDir: ".", outDir: "dist", module: "NodeNext" },
        }),
      },
      {
        path: "src/index.ts",
        mimeType: "application/typescript",
        content:
          'import express from "express"; const app = express(); app.get("/healthz", (_q, r) => r.json({ok:true})); app.listen(Number(process.env.PORT ?? "8080"), "0.0.0.0");',
      },
      {
        path: "src/main.tsx",
        mimeType: "application/typescript",
        content: 'import "./index.css"; import App from "./App.tsx"; void App;',
      },
    ];
    const before = JSON.stringify(files);
    const result = await checkZeroSealedFinalizeContract({ files });
    expect(result).toMatchObject({
      passed: false,
      code: "zero_sealed_source_contract_error",
      reasonCodes: ["typescript_module_specifier"],
    });
    expect(result.message).toContain("(src/main.tsx)");
    expect(result.message).toContain("retained starter files");
    expect(result.message).toContain("do not just rename CSS imports");
    expect(JSON.stringify(files)).toBe(before);
  });
});
