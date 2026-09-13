import { describe, expect, it } from "vitest";
import { checkZeroSealedFinalizeContract } from "./zero-sealed-finalize-check";
import {
  prepareZeroSealedNodeSource,
  ZeroSealedSourceContractError,
} from "./zero-sealed-generation";

function source(port: string, extra = "") {
  return [
    {
      path: "package.json",
      mimeType: "application/json",
      content: JSON.stringify({
        name: "runtime-port-regression",
        private: true,
        type: "module",
        scripts: { build: "tsc", start: "node dist/src/index.js" },
        dependencies: { express: "^4.19.2" },
      }),
    },
    {
      path: "tsconfig.json",
      mimeType: "application/json",
      content: JSON.stringify({
        compilerOptions: {
          rootDir: ".",
          outDir: "dist",
          module: "NodeNext",
          moduleResolution: "NodeNext",
        },
      }),
    },
    {
      path: "src/index.ts",
      mimeType: "application/typescript",
      content: `import express from "express";
${extra}
const app = express();
const port = ${port};
app.get("/healthz", (_req, res) => res.status(200).send("ok"));
app.listen(port, "0.0.0.0");`,
    },
  ];
}

describe("sealed runtime port syntax", () => {
  it.each([
    "process.env.PORT",
    "process.env['PORT']",
    'process.env["PORT"]',
    'process["env"]["PORT"]',
    'process [ "env" ] . PORT',
  ])("accepts the real process port through %s", (read) => {
    expect(() =>
      prepareZeroSealedNodeSource({ files: source(`Number(${read} ?? "8080")`) }),
    ).not.toThrow();
  });

  it.each([
    ['import process from "node:process";', "process.env.PORT"],
    ['import nodeProcess from "node:process";', "nodeProcess.env['PORT']"],
    ['import * as nodeProcess from "process";', 'nodeProcess.env["PORT"]'],
  ])("accepts a resolved built-in process import: %s", (declaration, read) => {
    expect(() =>
      prepareZeroSealedNodeSource({
        files: source(`Number(${read} ?? "8080")`, declaration),
      }),
    ).not.toThrow();
  });

  it.each([
    "// process.env.PORT is only a comment",
    'const prose = "process.env.PORT";',
    'const process = { env: { PORT: "8080" } }; void process.env.PORT;',
    "function fake(process: { env: { PORT: string } }) { return process.env.PORT; }",
    'const other = { env: { PORT: "8080" } }; void other.env.PORT;',
    "void process.env.PORTABLE;",
    'void process.env["port"];',
    'const field = "PORT"; void process.env[field];',
  ])("does not count a false port claim: %s", (extra) => {
    expect(() => prepareZeroSealedNodeSource({ files: source("8080", extra) })).toThrow(
      new ZeroSealedSourceContractError(["runtime_port"], "src/index.ts"),
    );
  });

  it("does not let a real port read in another file satisfy the server entry", () => {
    const files = source("8080");
    files.push({
      path: "src/unused.ts",
      mimeType: "application/typescript",
      content: 'export const port = Number(process.env.PORT ?? "8080");',
    });
    expect(() => prepareZeroSealedNodeSource({ files })).toThrow(
      new ZeroSealedSourceContractError(["runtime_port"], "src/index.ts"),
    );
  });

  it("keeps credential reads forbidden alongside a valid bracket-form port", async () => {
    const result = await checkZeroSealedFinalizeContract({
      files: source('Number(process.env["PORT"] ?? "8080")', 'void process.env["DATABASE_URL"];'),
    });
    expect(result.passed).toBe(false);
    expect(result.reasonCodes).toContain("credential_assumption");
  });
});
