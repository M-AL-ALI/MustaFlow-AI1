import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as ts from "typescript";

const routeSource = readFileSync(new URL("../routes/assets.ts", import.meta.url), "utf8");
const routeIndexSource = readFileSync(new URL("../routes/index.ts", import.meta.url), "utf8");

const routeAst = ts.createSourceFile("assets.ts", routeSource, ts.ScriptTarget.Latest, true);

function findNodes<T extends ts.Node>(scope: ts.Node, matches: (node: ts.Node) => node is T): T[] {
  const nodes: T[] = [];
  function visit(node: ts.Node): void {
    if (matches(node)) nodes.push(node);
    // Inspect the selected executable scope without counting uncalled nested callbacks.
    if (node !== scope && ts.isFunctionLike(node)) return;
    ts.forEachChild(node, visit);
  }
  visit(scope);
  return nodes;
}

function isMethodCall(call: ts.CallExpression, receiver: string, method: string): boolean {
  return (
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === receiver &&
    call.expression.name.text === method
  );
}

function expectTransactionalWrites(scope: ts.Node): ts.Block {
  const transactions = findNodes(scope, ts.isCallExpression).filter(
    (call) =>
      isMethodCall(call, "db", "transaction") &&
      ts.isAwaitExpression(call.parent) &&
      call.parent.expression === call,
  );
  expect(transactions).toHaveLength(1);
  const callback = transactions[0]!.arguments[0];
  if (
    !callback ||
    !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) ||
    !ts.isBlock(callback.body)
  ) {
    throw new Error("Expected an inline transaction callback with a block body");
  }
  expect(callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)).toBe(
    true,
  );
  expect(callback.parameters).toHaveLength(1);
  expect(callback.parameters[0]!.name.getText()).toBe("tx");
  const awaitedCalls = findNodes(callback.body, ts.isAwaitExpression).flatMap((node) =>
    findNodes(node.expression, ts.isCallExpression),
  );
  for (const table of ["projectFilesTable", "assetUsageTable"]) {
    expect(
      awaitedCalls.some(
        (call) =>
          isMethodCall(call, "tx", "insert") &&
          call.arguments.length === 1 &&
          ts.isIdentifier(call.arguments[0]!) &&
          call.arguments[0]!.text === table,
      ),
    ).toBe(true);
  }
  return callback.body;
}

describe("unified asset delivery contract", () => {
  it("keeps unified asset routes reachable through the authenticated API guard", () => {
    const knownPrefixes = routeIndexSource.slice(
      routeIndexSource.indexOf("const KNOWN_PREFIXES"),
      routeIndexSource.indexOf("router.use((req, res, next)"),
    );
    expect(knownPrefixes).toContain('"/assets"');
    expect(routeIndexSource.indexOf("router.use(assetsRouter)")).toBeGreaterThan(
      routeIndexSource.indexOf("const KNOWN_PREFIXES"),
    );
  });

  it("does not describe private storage or structural parsing as a malware scan", () => {
    expect(routeSource).toContain('let scanState: "not-required" | "not-scanned" = "not-scanned"');
    expect(routeSource).toContain('scanState = "not-required"');
    expect(routeSource).toContain('Structurally parsed documents remain honestly "not-scanned"');
    expect(routeSource).not.toContain("private and are structurally parsed before use");
  });

  it("materializes a project file and its usage receipt in one transaction", () => {
    const method = routeAst.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === "materializeProjectAsset",
    );
    if (!method?.body) throw new Error("Missing materializeProjectAsset implementation");
    expectTransactionalWrites(method.body);
  });

  it("replaces every supported reference atomically and refuses unsupported references", () => {
    const endpoints = findNodes(routeAst, ts.isCallExpression).filter(
      (call) =>
        isMethodCall(call, "router", "post") &&
        call.arguments[0] &&
        ts.isStringLiteral(call.arguments[0]) &&
        call.arguments[0].text === "/projects/:id/assets/:assetId/replace",
    );
    expect(endpoints).toHaveLength(1);
    const handler = endpoints[0]!.arguments.at(-1);
    if (
      !handler ||
      !(ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) ||
      !ts.isBlock(handler.body)
    ) {
      throw new Error("Missing asset replacement handler");
    }
    expect(handler.body.getText(routeAst)).toMatch(
      /usages\s*\.some\(\s*\(?usage\)?\s*=>\s*!usage\.filePath\s*\)/,
    );
    const transactionBody = expectTransactionalWrites(handler.body);
    const calls = findNodes(transactionBody, ts.isCallExpression);
    expect(
      calls.some(
        (call) =>
          ts.isIdentifier(call.expression) &&
          call.expression.text === "reconcileProjectFileAssetUsage" &&
          ts.isAwaitExpression(call.parent) &&
          call.arguments[0] &&
          ts.isIdentifier(call.arguments[0]) &&
          call.arguments[0].text === "tx",
      ),
    ).toBe(true);
    expect(
      calls.some(
        (call) =>
          isMethodCall(call, "tx", "delete") &&
          call.arguments[0] &&
          ts.isIdentifier(call.arguments[0]) &&
          call.arguments[0].text === "assetUsageTable",
      ),
    ).toBe(false);
    expect(
      [...findNodes(handler.body, ts.isCallExpression), ...calls].some(
        (call) =>
          ts.isIdentifier(call.expression) && call.expression.text === "materializeProjectAsset",
      ),
    ).toBe(false);
  });

  it("keeps asset metadata private and bounds derivative creation", () => {
    expect(routeSource).toContain('router.patch("/assets/:assetId"');
    expect(routeSource).toContain("eq(assetsTable.ownerUserId, req.userId)");
    expect(routeSource).toContain('router.post("/assets/:assetId/derivatives"');
    expect(routeSource).toContain("presets.length > 20");
    expect(routeSource).toContain("generateAssetDerivatives(bytes, presets)");
  });

  it("lets staff read project assets only through a live project-scoped support grant", () => {
    expect(routeSource).toContain("findLiveSupportGrant({ projectId, staffUserId: userId })");
    expect(routeSource).toContain("mayReadProjectAssets(req.userId, projectId)");
    expect(routeSource).toContain("mayReadProjectAssets(req.userId, asset.projectId)");
    expect(routeSource).not.toContain("findLiveSupportGrant({ staffUserId: userId })");
  });
});
