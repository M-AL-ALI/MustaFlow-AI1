import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canHaveModifiers,
  createSourceFile,
  forEachChild,
  getModifiers,
  isClassDeclaration,
  isCallExpression,
  isEnumDeclaration,
  isExportDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isImportClause,
  isImportDeclaration,
  isImportSpecifier,
  isNamedImports,
  isNamespaceImport,
  isObjectLiteralExpression,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isVariableDeclaration,
  isVariableStatement,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
  type Node,
  type SourceFile,
} from "typescript";
import { describe, expect, it } from "vitest";

const REACHABILITY_ANCHOR = "abdb1ab76e3a2fa98d287af94e4027bad347be9f";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const DORMANT_MARKER = "@dormantExport";

type DormantExport = {
  path: string;
  symbol: string;
  reachableWhen: string;
};

type SourceInventory = ReadonlyMap<string, string>;

type ExportedSymbol = {
  path: string;
  symbol: string;
};

const ADMISSION_RECEIPTS_SCHEMA_EXPORT: ExportedSymbol = {
  path: "lib/db/src/schema/production-database-admissions.ts",
  symbol: "productionDatabaseAdmissionReceiptsTable",
};

const dormantExports = JSON.parse(
  readFileSync(new URL("./dormant-exports.json", import.meta.url), "utf8"),
) as DormantExport[];

function normalizedPath(value: string): string {
  return value.replaceAll("\\", "/");
}

// Exact test-only bootstrap seeder consumed by the parent's disposable PG
// harness before startup guards exist. This is not a production-export waiver.
const PROJECT_PURGE_PG_FIXTURE_PATH =
  "artifacts/api-server/src/lib/project-purge-assets-postgres.fixtures.ts";

function isProductionTypeScript(filePath: string): boolean {
  const normalized = normalizedPath(filePath);
  return (
    (normalized.endsWith(".ts") || normalized.endsWith(".tsx")) &&
    !normalized.endsWith(".d.ts") &&
    !normalized.includes("/__tests__/") &&
    !normalized.startsWith("artifacts/nabuflow-runtime-worker/test/") &&
    normalized !== PROJECT_PURGE_PG_FIXTURE_PATH &&
    !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(normalized) &&
    !normalized.includes("/node_modules/")
  );
}

function parseSource(filePath: string, source: string): SourceFile {
  return createSourceFile(
    filePath,
    source,
    ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ScriptKind.TSX : ScriptKind.TS,
  );
}

function hasExportModifier(node: Node): boolean {
  return Boolean(
    canHaveModifiers(node) &&
    getModifiers(node)?.some((modifier) => modifier.kind === SyntaxKind.ExportKeyword),
  );
}

function exportedRuntimeSymbols(filePath: string, source: string): ExportedSymbol[] {
  const sourceFile = parseSource(filePath, source);
  const exported: ExportedSymbol[] = [];
  for (const statement of sourceFile.statements) {
    if (!hasExportModifier(statement)) continue;
    if (
      (isFunctionDeclaration(statement) ||
        isClassDeclaration(statement) ||
        isEnumDeclaration(statement)) &&
      statement.name
    ) {
      exported.push({ path: filePath, symbol: statement.name.text });
      continue;
    }
    if (isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (isIdentifier(declaration.name)) {
          exported.push({ path: filePath, symbol: declaration.name.text });
        }
      }
    }
  }
  return exported;
}

function isDeclarationOrImportName(node: Node): boolean {
  const parent = node.parent;
  return (
    (isVariableDeclaration(parent) && parent.name === node) ||
    ((isFunctionDeclaration(parent) || isClassDeclaration(parent) || isEnumDeclaration(parent)) &&
      parent.name === node) ||
    isImportSpecifier(parent) ||
    isImportClause(parent) ||
    isNamespaceImport(parent)
  );
}

function consumerIdentifiers(filePath: string, source: string): ReadonlySet<string> {
  const sourceFile = parseSource(filePath, source);
  const identifiers = new Set<string>();
  function visit(node: Node): void {
    if (isIdentifier(node) && !isDeclarationOrImportName(node)) identifiers.add(node.text);
    forEachChild(node, visit);
  }
  forEachChild(sourceFile, visit);
  return identifiers;
}

function keyOf(entry: ExportedSymbol): string {
  return `${entry.path}#${entry.symbol}`;
}

function hasNamedRuntimeImport(source: SourceFile, moduleName: string, name: string): boolean {
  return source.statements.some(
    (statement) =>
      isImportDeclaration(statement) &&
      isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === moduleName &&
      !statement.importClause?.isTypeOnly &&
      statement.importClause?.namedBindings !== undefined &&
      isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(
        (entry) =>
          !entry.isTypeOnly &&
          entry.name.text === name &&
          (entry.propertyName?.text ?? entry.name.text) === name,
      ),
  );
}

function exportedInitializer(source: SourceFile, symbol: string) {
  return source.statements
    .filter(isVariableStatement)
    .filter(hasExportModifier)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((declaration) => isIdentifier(declaration.name) && declaration.name.text === symbol)
    ?.initializer;
}

/** This exact table is consumed through Drizzle's live namespace schema registration.
 * Do not exempt schema folders or mere barrel exports: require the full runtime chain. */
function hasRegisteredAdmissionReceiptsSchema(inventory: SourceInventory): boolean {
  const table = parseSource(
    ADMISSION_RECEIPTS_SCHEMA_EXPORT.path,
    inventory.get(ADMISSION_RECEIPTS_SCHEMA_EXPORT.path) ?? "",
  );
  const barrel = parseSource(
    "lib/db/src/schema/index.ts",
    inventory.get("lib/db/src/schema/index.ts") ?? "",
  );
  const runtime = parseSource("lib/db/src/index.ts", inventory.get("lib/db/src/index.ts") ?? "");
  const declaration = exportedInitializer(table, ADMISSION_RECEIPTS_SCHEMA_EXPORT.symbol);
  const registration = exportedInitializer(runtime, "db");
  if (
    !hasNamedRuntimeImport(table, "drizzle-orm/pg-core", "pgTable") ||
    !declaration ||
    !isCallExpression(declaration) ||
    !isIdentifier(declaration.expression) ||
    declaration.expression.text !== "pgTable" ||
    !declaration.arguments[0] ||
    !isStringLiteral(declaration.arguments[0]) ||
    declaration.arguments[0].text !== "production_database_admission_receipts" ||
    !hasNamedRuntimeImport(runtime, "drizzle-orm/node-postgres", "drizzle") ||
    !registration ||
    !isCallExpression(registration) ||
    !isIdentifier(registration.expression) ||
    registration.expression.text !== "drizzle"
  )
    return false;
  const options = registration.arguments[1];
  return (
    barrel.statements.some(
      (statement) =>
        isExportDeclaration(statement) &&
        !statement.isTypeOnly &&
        !statement.exportClause &&
        statement.moduleSpecifier !== undefined &&
        isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === "./production-database-admissions",
    ) &&
    runtime.statements.some(
      (statement) =>
        isImportDeclaration(statement) &&
        isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === "./schema" &&
        !statement.importClause?.isTypeOnly &&
        statement.importClause?.namedBindings !== undefined &&
        isNamespaceImport(statement.importClause.namedBindings) &&
        statement.importClause.namedBindings.name.text === "schema",
    ) &&
    options !== undefined &&
    isObjectLiteralExpression(options) &&
    options.properties.some(
      (property) => isShorthandPropertyAssignment(property) && property.name.text === "schema",
    )
  );
}

/**
 * Deliberately conservative static census: named runtime exports and identifier references only.
 * It cannot prove dynamic/string-keyed dispatch, follow re-export reachability, distinguish an
 * unrelated same-named identifier, or inspect generated/non-TypeScript code.
 */
function findUndeclaredInertExports(input: {
  baseline: SourceInventory;
  current: SourceInventory;
  consumers?: SourceInventory;
  declaredDormant: ReadonlySet<string>;
}): string[] {
  const baselineExports = new Set(
    [...input.baseline].flatMap(([filePath, source]) =>
      exportedRuntimeSymbols(filePath, source).map(keyOf),
    ),
  );
  const currentExports = [...input.current].flatMap(([filePath, source]) =>
    exportedRuntimeSymbols(filePath, source),
  );
  const consumers = new Map(
    [...(input.consumers ?? input.current)].map(([filePath, source]) => [
      filePath,
      consumerIdentifiers(filePath, source),
    ]),
  );
  const admissionSchemaRegistered = hasRegisteredAdmissionReceiptsSchema(
    input.consumers ?? input.current,
  );

  return currentExports
    .filter((entry) => !baselineExports.has(keyOf(entry)))
    .filter((entry) => !input.declaredDormant.has(keyOf(entry)))
    .filter(
      (entry) =>
        !admissionSchemaRegistered || keyOf(entry) !== keyOf(ADMISSION_RECEIPTS_SCHEMA_EXPORT),
    )
    .filter(
      (entry) =>
        ![...consumers].some(
          ([consumerPath, identifiers]) =>
            consumerPath !== entry.path && identifiers.has(entry.symbol),
        ) && !consumers.get(entry.path)?.has(entry.symbol),
    )
    .map(keyOf)
    .sort();
}

function gitLines(args: readonly string[]): string[] {
  return execFileSync("git", [...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  })
    .split(/\r?\n/u)
    .filter(Boolean);
}

function repositoryInventoryAtAnchor(): Map<string, string> {
  const anchorPaths = new Set(
    gitLines([
      "ls-tree",
      "-r",
      "--name-only",
      REACHABILITY_ANCHOR,
      "--",
      "artifacts",
      "lib",
      "scripts",
    ]).filter(isProductionTypeScript),
  );
  const paths = gitLines([
    "diff",
    "--name-only",
    REACHABILITY_ANCHOR,
    "--",
    "artifacts",
    "lib",
    "scripts",
  ]).filter((filePath) => anchorPaths.has(filePath));
  return new Map(
    paths.map((filePath) => [
      filePath,
      execFileSync("git", ["show", `${REACHABILITY_ANCHOR}:${filePath}`], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      }),
    ]),
  );
}

function changedRepositoryInventory(): Map<string, string> {
  const changed = gitLines([
    "diff",
    "--name-only",
    "--diff-filter=ACMR",
    REACHABILITY_ANCHOR,
    "--",
    "artifacts",
    "lib",
    "scripts",
  ]);
  const untracked = gitLines([
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    "artifacts",
    "lib",
    "scripts",
  ]);
  const paths = [...new Set([...changed, ...untracked])].filter(isProductionTypeScript);
  return new Map(
    paths.map((filePath) => [filePath, readFileSync(path.join(REPO_ROOT, filePath), "utf8")]),
  );
}

function currentRepositoryInventory(): Map<string, string> {
  const paths = gitLines([
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    "artifacts",
    "lib",
    "scripts",
  ]).filter(
    (filePath) => isProductionTypeScript(filePath) && existsSync(path.join(REPO_ROOT, filePath)),
  );
  return new Map(
    paths.map((filePath) => [filePath, readFileSync(path.join(REPO_ROOT, filePath), "utf8")]),
  );
}

describe("non-test export reachability", () => {
  it.each([
    ["artifacts/nabuflow-runtime-worker/test/helpers.ts", false],
    ["artifacts\\nabuflow-runtime-worker\\test\\helpers.ts", false],
    ["artifacts/nabuflow-runtime-worker/src/helpers.ts", true],
    ["artifacts/nabuflow-runtime-worker/testing/helpers.ts", true],
    [PROJECT_PURGE_PG_FIXTURE_PATH, false],
    ["artifacts\\api-server\\src\\lib\\project-purge-assets-postgres.fixtures.ts", false],
    ["artifacts/api-server/src/lib/project-purge-assets-postgres.ts", true],
    ["artifacts/api-server/src/lib/other-postgres.fixtures.ts", true],
    ["artifacts/api-server/src/lib/asset-contract.ts", true],
  ] as const)("classifies production inventory membership for %s", (filePath, expected) => {
    expect(isProductionTypeScript(filePath)).toBe(expected);
  });

  it("marks every registered dormant export at its definition", () => {
    expect(dormantExports).toHaveLength(25);
    expect(
      new Set(dormantExports.map(({ path: filePath, symbol }) => `${filePath}#${symbol}`)).size,
    ).toBe(dormantExports.length);
    for (const entry of dormantExports) {
      expect(entry.reachableWhen.trim().length).toBeGreaterThan(0);
      const source = readFileSync(path.join(REPO_ROOT, entry.path), "utf8");
      expect(exportedRuntimeSymbols(entry.path, source).map(({ symbol }) => symbol)).toContain(
        entry.symbol,
      );
      const definition = source.indexOf(entry.symbol);
      expect(definition).toBeGreaterThanOrEqual(0);
      expect(source.slice(Math.max(0, definition - 600), definition)).toContain(DORMANT_MARKER);
    }
  });

  it("requires every new named runtime export to be consumed or declared dormant", () => {
    const undeclared = findUndeclaredInertExports({
      baseline: repositoryInventoryAtAnchor(),
      current: changedRepositoryInventory(),
      consumers: currentRepositoryInventory(),
      declaredDormant: new Set(
        dormantExports.map(({ path: filePath, symbol }) => `${filePath}#${symbol}`),
      ),
    });
    expect(undeclared).toEqual([]);
  });

  it("does not exempt an unused production classifier alongside the test fixture", () => {
    const productionPath = "artifacts/api-server/src/lib/asset-contract.ts";
    const candidates = new Map([
      [productionPath, "export function isCanonicalAssetContentRequest() { return false; }"],
      [
        PROJECT_PURGE_PG_FIXTURE_PATH,
        "export async function seedProjectPurgeAssetPostgresFixtures() {}",
      ],
    ]);
    const production = new Map(
      [...candidates].filter(([filePath]) => isProductionTypeScript(filePath)),
    );
    expect(
      findUndeclaredInertExports({
        baseline: new Map(),
        current: production,
        declaredDormant: new Set(),
      }),
    ).toEqual([`${productionPath}#isCanonicalAssetContentRequest`]);
  });

  it("catches the sixth unconsumed export", () => {
    const filePath = "artifacts/api-server/src/lib/example.ts";
    expect(
      findUndeclaredInertExports({
        baseline: new Map([[filePath, "export const alreadyPresent = 1;"]]),
        current: new Map([
          [filePath, "export const alreadyPresent = 1; export function sixthDormantExample() {}"],
        ]),
        declaredDormant: new Set(),
      }),
    ).toEqual([`${filePath}#sixthDormantExample`]);
  });

  it.each(["registered", "no-table", "no-barrel", "no-namespace", "no-drizzle", "no-options"])(
    "recognizes the admission receipts schema only through live registration: %s",
    (scenario) => {
      const filePath = ADMISSION_RECEIPTS_SCHEMA_EXPORT.path;
      const current = new Map([
        [
          filePath,
          scenario === "no-table"
            ? "export const productionDatabaseAdmissionReceiptsTable = 1;"
            : 'import { pgTable } from "drizzle-orm/pg-core"; export const productionDatabaseAdmissionReceiptsTable = pgTable("production_database_admission_receipts", {});',
        ],
      ]);
      const consumers = new Map([
        ...current,
        [
          "lib/db/src/schema/index.ts",
          scenario === "no-barrel" ? "" : 'export * from "./production-database-admissions";',
        ],
        [
          "lib/db/src/index.ts",
          [
            scenario === "no-drizzle" ? "" : 'import { drizzle } from "drizzle-orm/node-postgres";',
            scenario === "no-namespace" ? "" : 'import * as schema from "./schema";',
            scenario === "no-options"
              ? "export const db = drizzle(pool);"
              : "export const db = drizzle(pool, { schema });",
          ].join("\n"),
        ],
      ]);
      expect(
        findUndeclaredInertExports({
          baseline: new Map(),
          current,
          consumers,
          declaredDormant: new Set(),
        }),
      ).toEqual(scenario === "registered" ? [] : [keyOf(ADMISSION_RECEIPTS_SCHEMA_EXPORT)]);
      current.set(filePath, current.get(filePath) + " export const unrelatedSchemaExport = 1;");
      consumers.set(filePath, current.get(filePath)!);
      expect(
        findUndeclaredInertExports({
          baseline: new Map(),
          current,
          consumers,
          declaredDormant: new Set(),
        }),
      ).toContain(`${filePath}#unrelatedSchemaExport`);
    },
  );
});
