import { readFileSync } from "fs";
import { join } from "path";
import {
  BLUEPRINT_INSTALL_USER_ERROR,
  DATABASE_DUPLICATE_VALUE_ERROR,
  DATABASE_QUERY_SYNTAX_ERROR,
  DATABASE_REQUIRED_VALUE_ERROR,
  DATABASE_USER_ERROR_FALLBACK,
  GITHUB_CREDENTIALS_ERROR,
  GITHUB_USER_ERROR_FALLBACK,
  WORKFLOW_USER_ERROR_FALLBACK,
  databaseProviderErrorMessage,
  githubProviderErrorMessage,
  workflowProviderErrorMessage,
} from "@workspace/ora-contracts";
import { describe, expect, it } from "vitest";

const ROUTES_DIR = join(__dirname, "..");

function readRoute(filename: string): string {
  return readFileSync(join(ROUTES_DIR, filename), "utf-8");
}

function occurrences(source: string, token: string): number {
  return source.split(token).length - 1;
}

describe("middle-tier error sanitisation", () => {
  it("keeps only useful fixed guidance from provider failures", () => {
    expect(githubProviderErrorMessage(new Error("Bad credentials"))).toBe(GITHUB_CREDENTIALS_ERROR);
    expect(databaseProviderErrorMessage({ code: "23505" })).toBe(DATABASE_DUPLICATE_VALUE_ERROR);
    expect(databaseProviderErrorMessage({ code: "23502" })).toBe(DATABASE_REQUIRED_VALUE_ERROR);
    expect(databaseProviderErrorMessage({ code: "42601" })).toBe(DATABASE_QUERY_SYNTAX_ERROR);
  });

  it("denies identifiers, stack-like text, unknown prose, and over-length messages", () => {
    const repositoryId = ["repo", "internal_example"].join("_");
    const relationId = ["customer", "records"].join("_");
    const hostile = [
      new Error(`Not Found: ${repositoryId}`),
      new Error(`stack at github.ts:71 ${repositoryId}`),
      new Error(`relation ${relationId} does not exist`),
      new Error("x".repeat(500)),
    ];

    for (const value of hostile) {
      expect(githubProviderErrorMessage(value)).toBe(GITHUB_USER_ERROR_FALLBACK);
      expect(databaseProviderErrorMessage(value)).toBe(DATABASE_USER_ERROR_FALLBACK);
      expect(workflowProviderErrorMessage(value)).toBe(WORKFLOW_USER_ERROR_FALLBACK);
    }
  });

  it("sanitises every commissioned server boundary", () => {
    const github = readRoute("github.ts");
    const database = readRoute("database.ts");
    const workflows = readRoute("workflows.ts");
    const blueprints = readRoute("blueprints.ts");

    expect(occurrences(github, "githubProviderErrorMessage(err)")).toBe(5);
    expect(occurrences(database, "databaseProviderErrorMessage(err)")).toBe(2);
    expect(occurrences(workflows, "workflowProviderErrorMessage(err)")).toBe(1);
    expect(occurrences(blueprints, 'emit("failed", BLUEPRINT_INSTALL_USER_ERROR)')).toBe(3);

    expect(blueprints).not.toContain("r.stderr.slice(0, 500)");
    expect(blueprints).not.toContain("Package install error: ${msg}");
    expect(BLUEPRINT_INSTALL_USER_ERROR.length).toBeLessThan(120);
  });
});
