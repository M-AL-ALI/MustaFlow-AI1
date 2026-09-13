import { describe, expect, it } from "vitest";
import { hasUnsupportedSealedEnvironmentAccess } from "./zero-sealed-environment";

const blocked = (content: string) =>
  hasUnsupportedSealedEnvironmentAccess({
    path: "src/index.ts",
    content,
  });

describe("sealed environment access", () => {
  it.each([
    'Number(process.env.PORT ?? "8080");',
    'Number(process.env["PORT"] ?? "8080");',
    "Number(process['env']['PORT'] ?? '8080');",
    'import proc from "node:process"; Number(proc.env["PORT"] ?? "8080");',
    'import * as proc from "node:process"; void proc.env.PORT;',
    'import { env as runtimeEnv } from "node:process"; void runtimeEnv.PORT;',
    "void globalThis.process.env.PORT;",
    "void import.meta.env.PORT;",
    'process.stdout.write("hello");',
    'const process = { env: { DATABASE_URL: "not a credential" } }; void process.env.DATABASE_URL;',
    '// process.env["DATABASE_URL"] is prose only',
    'const prose = "process.env[DATABASE_URL]";',
  ])("permits a safe or non-environment expression: %s", (content) => {
    expect(blocked(content)).toBe(false);
  });

  it.each([
    "void process.env.DATABASE_URL;",
    'void process.env["DATABASE_URL"];',
    "void process['env']['API_KEY'];",
    "void process.env[key];",
    "const env = process.env; void env.PORT;",
    "const { PORT } = process.env;",
    "const proc = process; void proc.env.PORT;",
    "void process[member];",
    'Reflect.get(process, "env");',
    'import proc from "node:process"; void proc.env["DATABASE_URL"];',
    'import { env as runtimeEnv } from "node:process"; void runtimeEnv["API_KEY"];',
    'void globalThis["process"]["env"]["API_KEY"];',
    'void global.process.env["DATABASE_URL"];',
    'void import.meta.env["API_KEY"];',
    'process.env.PORT = "8080";',
    'process.env["PORT"]++;',
    "delete process.env.PORT;",
    'const proc = require("node:process");',
    'const proc = await import("node:process");',
  ])("rejects unsupported environment access: %s", (content) => {
    expect(blocked(content)).toBe(true);
  });
});
