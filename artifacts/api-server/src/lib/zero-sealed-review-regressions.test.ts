import { describe, expect, it } from "vitest";
import { checkZeroSealedFinalizeContract } from "./zero-sealed-finalize-check";

function source(port: string, extra = "") {
  return [
    {
      path: "package.json",
      mimeType: "application/json",
      content: JSON.stringify({
        name: "sealed-review-regressions",
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

describe("independent review: complete sealed finalizer compatibility", () => {
  it.each([
    ["canonical global", 'Number(process.env.PORT ?? "8080")', ""],
    ["literal bracket", 'Number(process.env["PORT"] ?? "8080")', ""],
    [
      "default import control",
      'Number(nodeProcess.env.PORT ?? "8080")',
      'import nodeProcess from "node:process";',
    ],
    [
      "namespace import control",
      'Number(nodeProcess.env.PORT ?? "8080")',
      'import * as nodeProcess from "node:process";',
    ],
    ["globalThis-qualified process", 'Number(globalThis.process.env.PORT ?? "8080")', ""],
    ["global-qualified process", 'Number(global.process.env.PORT ?? "8080")', ""],
    [
      "named default import",
      'Number(process.env.PORT ?? "8080")',
      'import { default as process } from "node:process";',
    ],
    [
      "aliased named default import",
      'Number(nodeProcess.env.PORT ?? "8080")',
      'import { default as nodeProcess } from "process";',
    ],
    [
      "harmless process availability check",
      'typeof process === "undefined" ? 8080 : Number(process.env.PORT ?? "8080")',
      "",
    ],
    [
      "harmless imported process availability check",
      'typeof proc === "undefined" ? 8080 : Number(proc.env.PORT ?? "8080")',
      'import { default as proc } from "node:process";',
    ],
    [
      "harmless qualified process availability check",
      'typeof globalThis.process === "undefined" ? 8080 : Number(globalThis.process.env.PORT ?? "8080")',
      "",
    ],
    [
      "named environment import",
      'Number(runtimeEnv.PORT ?? "8080")',
      'import { env as runtimeEnv } from "node:process";',
    ],
    ["global object alias", 'Number(root.process.env.PORT ?? "8080")', "const root = globalThis;"],
    [
      "chained global object alias",
      'Number(root.process.env.PORT ?? "8080")',
      "const first = globalThis; const root = first;",
    ],
    [
      "assigned global object alias",
      'Number(root.process.env.PORT ?? "8080")',
      "let root; root = globalThis;",
    ],
    [
      "benign non-process global alias use",
      'Number(process.env.PORT ?? "8080")',
      "const root = globalThis; void root.console;",
    ],
    [
      "shadowed global object in unrelated local code",
      'Number(process.env.PORT ?? "8080")',
      "function local(globalThis: { process: { env: { PORT: string } } }) { return globalThis.process.env.PORT; }",
    ],
  ])("accepts a valid PORT-only application: %s", async (_label, port, extra) => {
    const result = await checkZeroSealedFinalizeContract({ files: source(port, extra) });
    expect(result).toMatchObject({
      passed: true,
      code: "zero_sealed_source_ready",
      reasonCodes: [],
    });
  });

  it.each([
    ["direct bracket control", 'void process.env["DATABASE_URL"];'],
    [
      "named-default process credential read",
      'import { default as proc } from "node:process"; void proc.env["DATABASE_URL"];',
    ],
    [
      "aliased global object credential read",
      'const root = globalThis; void root.process.env["DATABASE_URL"];',
    ],
    [
      "chained global object credential read",
      'const first = globalThis; const root = first; void root.process.env["DATABASE_URL"];',
    ],
    [
      "later assigned global object credential read",
      'let root; root = globalThis; void root.process.env["DATABASE_URL"];',
    ],
    [
      "conditional global object credential read",
      'const root = Math.random() ? globalThis : {}; void root.process.env["DATABASE_URL"];',
    ],
  ])("rejects unsupported environment access: %s", async (_label, extra) => {
    const result = await checkZeroSealedFinalizeContract({
      files: source('Number(process.env.PORT ?? "8080")', extra),
    });
    expect(result.passed).toBe(false);
    expect(result.reasonCodes).toContain("credential_assumption");
  });

  it.each([
    "function fake(globalThis: { process: { env: { PORT: string } } }) { return globalThis.process.env.PORT; }",
    'const root = { process: { env: { PORT: "8080" } } }; void root.process.env.PORT;',
    'import { default as proc } from "node:process"; function fake(proc: { env: { PORT: string } }) { return proc.env.PORT; }',
  ])(
    "does not let shadowed or fake process objects satisfy the runtime port: %s",
    async (extra) => {
      const result = await checkZeroSealedFinalizeContract({ files: source("8080", extra) });
      expect(result.passed).toBe(false);
      expect(result.reasonCodes).toContain("runtime_port");
    },
  );
});

describe("runtime provenance and erased type regressions", () => {
  it.each([
    {
      id: "canonical-control",
      expected: true,
      port: 'Number(process.env.PORT ?? "8080")',
      extra: "",
    },
    {
      id: "erased-process-typeof",
      expected: true,
      port: 'Number(process.env.PORT ?? "8080")',
      extra: "type RuntimeProcess = typeof process;",
    },
    {
      id: "erased-imported-env-typeof",
      expected: true,
      port: 'Number(process.env.PORT ?? "8080")',
      extra:
        'import { env as runtimeEnv } from "node:process"; type Environment = typeof runtimeEnv;',
    },
    {
      id: "unreachable-global-alias-fake-port",
      expected: false,
      port: 'Number(root.process.env["PORT"] ?? "8080")',
      extra:
        'const fake = { process: { env: { PORT: "9090" } } }; const root = false ? globalThis : fake;',
      reason: "runtime_port",
    },
    {
      id: "direct-global-alias-control",
      expected: true,
      port: 'Number(root.process.env["PORT"] ?? "8080")',
      extra: "const root = globalThis;",
    },
    {
      id: "overwritten-global-alias-local-data",
      expected: true,
      port: 'Number(process.env.PORT ?? "8080")',
      extra:
        'let root: any = globalThis; root = { process: { env: { DATABASE_URL: "synthetic-local" } } }; void root.process.env["DATABASE_URL"];',
    },
    {
      id: "conditional-global-is-not-definite",
      expected: false,
      port: 'Number(root.process.env.PORT ?? "8080")',
      extra: 'const root = Math.random() ? globalThis : { process: { env: { PORT: "9090" } } };',
      reason: "runtime_port",
    },
    {
      id: "logical-global-is-not-definite",
      expected: false,
      port: 'Number(root.process.env.PORT ?? "8080")',
      extra:
        'const local = { process: { env: { PORT: "9090" } } }; const root = local || globalThis;',
      reason: "runtime_port",
    },
    {
      id: "type-query-does-not-supply-runtime-port",
      expected: false,
      port: "8080",
      extra: "type Port = typeof process.env.PORT;",
      reason: "runtime_port",
    },
    {
      id: "both-branches-global-control",
      expected: true,
      port: 'Number(root.process.env.PORT ?? "8080")',
      extra: "const root = Math.random() ? globalThis : global;",
    },
    {
      id: "conditional-overwrite-does-not-hide-credentials",
      expected: false,
      port: 'Number(process.env.PORT ?? "8080")',
      extra:
        "let root: any = globalThis; if (Math.random()) root = { process: { env: {} } }; void root.process.env.DATABASE_URL;",
      reason: "credential_assumption",
    },
    {
      id: "deferred-write-remains-conservative",
      expected: false,
      port: 'Number(process.env.PORT ?? "8080")',
      extra:
        "let root: any = {}; function update() { root = globalThis; } root = { process: { env: {} } }; update(); void root.process.env.DATABASE_URL;",
      reason: "credential_assumption",
    },
    {
      id: "ordinary-runtime-whole-env-still-blocked",
      expected: false,
      port: 'Number(process.env.PORT ?? "8080")',
      extra:
        'import { env as runtimeEnv } from "node:process"; type Environment = typeof runtimeEnv; const copied = runtimeEnv;',
      reason: "credential_assumption",
    },
    {
      id: "overwritten-alias-cannot-supply-runtime-port",
      expected: false,
      port: 'Number(root.process.env.PORT ?? "8080")',
      extra: 'let root: any = globalThis; root = { process: { env: { PORT: "9090" } } };',
      reason: "runtime_port",
    },
  ])("$id", async ({ expected, port, extra, reason }) => {
    const result = await checkZeroSealedFinalizeContract({ files: source(port, extra) });
    expect(result.passed).toBe(expected);
    if (reason) expect(result.reasonCodes).toContain(reason);
    else expect(result.reasonCodes).toEqual([]);
  });
});

describe("startup function PORT provenance", () => {
  it.each([
    {
      id: "immutable-alias-inside-startup-function",
      expected: true,
      alias: "const root = globalThis;",
      read: "root.process.env.PORT",
      wrapped: true,
      inside: "",
    },
    {
      id: "direct-global-inside-startup-function-control",
      expected: true,
      alias: "",
      read: "globalThis.process.env.PORT",
      wrapped: true,
      inside: "",
    },
    {
      id: "immutable-top-level-alias-control",
      expected: true,
      alias: "const root = globalThis;",
      read: "root.process.env.PORT",
      wrapped: false,
      inside: "",
    },
    {
      id: "possible-alias-does-not-supply-port",
      expected: false,
      alias: 'const root = Math.random() ? globalThis : { process: { env: { PORT: "9090" } } };',
      read: "root.process.env.PORT",
      wrapped: false,
      inside: "",
    },
    {
      id: "immutable-alias-declared-inside-startup",
      expected: true,
      alias: "",
      inside: "const root = globalThis;",
      read: "root.process.env.PORT",
      wrapped: true,
    },
    {
      id: "immutable-chain-captured-by-startup",
      expected: true,
      alias: "const first = globalThis; const root = first;",
      inside: "",
      read: "root.process.env.PORT",
      wrapped: true,
    },
    {
      id: "conditional-immutable-capture-is-not-definite",
      expected: false,
      alias: 'const root = Math.random() ? globalThis : { process: { env: { PORT: "9090" } } };',
      inside: "",
      read: "root.process.env.PORT",
      wrapped: true,
    },
    {
      id: "overwritten-mutable-capture-is-not-definite",
      expected: false,
      alias: 'let root: any = globalThis; root = { process: { env: { PORT: "9090" } } };',
      inside: "",
      read: "root.process.env.PORT",
      wrapped: true,
    },
  ])("$id", async ({ expected, alias, inside, read, wrapped }) => {
    const files = source("8080");
    const entry = files.find((file) => file.path === "src/index.ts")!;
    const listener = "const port = Number(" + read + ' ?? "8080"); app.listen(port, "0.0.0.0");';
    entry.content = [
      'import express from "express";',
      alias,
      "const app = express();",
      'app.get("/healthz", (_req, res) => res.status(200).send("ok"));',
      wrapped ? "function start() { " + inside + listener + " } start();" : inside + listener,
    ].join("\n");
    const result = await checkZeroSealedFinalizeContract({ files });
    expect(result.passed).toBe(expected);
    if (expected) expect(result.reasonCodes).toEqual([]);
    else expect(result.reasonCodes).toContain("runtime_port");
  });
});

describe("erased TypeScript wrappers preserve runtime provenance", () => {
  const wrappers = [
    ["as assertion", "($value as typeof globalThis)"],
    ["angle assertion", "(<typeof globalThis>$value)"],
    ["non-null assertion", "($value!)"],
    ["satisfies expression", "($value satisfies typeof globalThis)"],
    ["nested assertions", "(($value as unknown as typeof globalThis)!)"],
  ];
  const fake =
    'const fake = { process: { env: { PORT: "9090", DATABASE_URL: "synthetic-local" } } };';

  it.each(wrappers)(
    "accepts an actual global through %s inside startup",
    async (_label, template) => {
      const files = source("8080");
      const entry = files.find((file) => file.path === "src/index.ts")!;
      entry.content = [
        'import express from "express";',
        "const root = " + template.replaceAll("$value", "globalThis") + ";",
        "const app = express();",
        'app.get("/healthz", (_req, res) => res.status(200).send("ok"));',
        'function start() { const port = Number(root.process.env.PORT ?? "8080"); app.listen(port, "0.0.0.0"); }',
        "start();",
      ].join("\n");
      const result = await checkZeroSealedFinalizeContract({ files });
      expect(result).toMatchObject({ passed: true, reasonCodes: [] });
    },
  );

  it.each(wrappers)(
    "does not grant global provenance to a typed fake through %s",
    async (_label, template) => {
      const result = await checkZeroSealedFinalizeContract({
        files: source(
          'Number(root.process.env.PORT ?? "8080")',
          fake + "const root = " + template.replaceAll("$value", "fake") + ";",
        ),
      });
      expect(result.passed).toBe(false);
      expect(result.reasonCodes).toContain("runtime_port");
    },
  );

  it.each(wrappers)(
    "does not turn a possible global into definite evidence through %s",
    async (_label, template) => {
      const result = await checkZeroSealedFinalizeContract({
        files: source(
          'Number(root.process.env.PORT ?? "8080")',
          fake +
            "const root = " +
            template.replaceAll("$value", "(Math.random() ? globalThis : fake)") +
            ";",
        ),
      });
      expect(result.passed).toBe(false);
      expect(result.reasonCodes).toContain("runtime_port");
    },
  );

  it.each(wrappers)("still rejects credential reads through %s", async (_label, template) => {
    const result = await checkZeroSealedFinalizeContract({
      files: source(
        'Number(process.env.PORT ?? "8080")',
        "const root = " +
          template.replaceAll("$value", "globalThis") +
          '; void root.process.env["DATABASE_URL"];',
      ),
    });
    expect(result.passed).toBe(false);
    expect(result.reasonCodes).toContain("credential_assumption");
  });

  it.each(wrappers)("keeps ordinary local data ordinary through %s", async (_label, template) => {
    const result = await checkZeroSealedFinalizeContract({
      files: source(
        'Number(process.env.PORT ?? "8080")',
        fake +
          "const root = " +
          template.replaceAll("$value", "fake") +
          '; void root.process.env["DATABASE_URL"];',
      ),
    });
    expect(result).toMatchObject({ passed: true, reasonCodes: [] });
  });
});
