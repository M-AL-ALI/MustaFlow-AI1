import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canHaveModifiers,
  createSourceFile,
  forEachChild,
  getModifiers,
  isClassDeclaration,
  isEnumDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isImportClause,
  isImportSpecifier,
  isNamespaceImport,
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

const dormantExports = JSON.parse(
  readFileSync(new URL("./dormant-exports.json", import.meta.url), "utf8"),
) as DormantExport[];

function normalizedPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function isProductionTypeScript(filePath: string): boolean {
  const normalized = normalizedPath(filePath);
  return (
    (normalized.endsWith(".ts") || normalized.endsWith(".tsx")) &&
    !normalized.endsWith(".d.ts") &&
    !normalized.includes("/__tests__/") &&
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

  return currentExports
    .filter((entry) => !baselineExports.has(keyOf(entry)))
    .filter((entry) => !input.declaredDormant.has(keyOf(entry)))
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
  ]).filter(isProductionTypeScript);
  return new Map(
    paths.map((filePath) => [filePath, readFileSync(path.join(REPO_ROOT, filePath), "utf8")]),
  );
}

describe("non-test export reachability", () => {
  it("marks every registered dormant export at its definition", () => {
    expect(dormantExports).toHaveLength(6);
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
});
