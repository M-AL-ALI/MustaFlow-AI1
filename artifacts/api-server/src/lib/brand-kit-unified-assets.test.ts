import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as ts from "typescript";

const knowledgeRoute = readFileSync(new URL("../routes/knowledge.ts", import.meta.url), "utf8");
const assetRoute = readFileSync(new URL("../routes/assets.ts", import.meta.url), "utf8");
const agentLoop = readFileSync(new URL("./agent-loop.ts", import.meta.url), "utf8");

const assetAst = ts.createSourceFile("assets.ts", assetRoute, ts.ScriptTarget.Latest, true);

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

function expectTransactionalWrites(scope: ts.Node, boundary: readonly [string, string]): ts.Block {
  const transactions = findNodes(scope, ts.isCallExpression).filter(
    (call) =>
      ts.isIdentifier(call.expression) &&
      call.expression.text === "withResponseProjectLifecycleTransaction" &&
      ts.isAwaitExpression(call.parent) &&
      call.parent.expression === call,
  );
  expect(transactions).toHaveLength(1);
  expect(transactions[0]!.arguments).toHaveLength(3);
  expect(transactions[0]!.arguments.slice(0, 2).map((argument) => argument.getText())).toEqual(
    boundary,
  );
  const callback = transactions[0]!.arguments[2];
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

describe("unified brand kit asset contract", () => {
  it("keeps place_upload's real materialization inside the active lifecycle callback", () => {
    const start = agentLoop.indexOf('case "place_upload":');
    expect(start).toBeGreaterThan(-1);
    const placement = agentLoop.slice(start, agentLoop.indexOf('case "list_files":', start));
    const ast = ts.createSourceFile(
      "placement.ts",
      "switch (tool) {\n" + placement + "\n}",
      ts.ScriptTarget.Latest,
      true,
    );
    const allCalls: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) allCalls.push(node);
      ts.forEachChild(node, visit);
    };
    visit(ast);
    const lifecycle = allCalls.filter(
      (call) =>
        ts.isIdentifier(call.expression) && call.expression.text === "withActiveProjectLifecycle",
    );
    expect(lifecycle).toHaveLength(1);
    expect(ts.isAwaitExpression(lifecycle[0]!.parent)).toBe(true);
    expect(lifecycle[0]!.arguments[0]?.getText()).toBe("input.projectId");
    const callback = lifecycle[0]!.arguments[1];
    if (!callback || !ts.isArrowFunction(callback))
      throw new Error("Missing active placement callback");
    const materializations = findNodes(callback.body, ts.isCallExpression).filter(
      (call) =>
        ts.isIdentifier(call.expression) && call.expression.text === "materializeProjectAsset",
    );
    expect(materializations).toHaveLength(1);
    expect(ts.isAwaitExpression(materializations[0]!.parent)).toBe(true);
    expect(materializations[0]!.arguments).toHaveLength(1);
    expect(placement).not.toContain("EXPLICIT_MATERIALIZE_ACTION");
  });

  it("accepts only a ready image owned by the caller as the account logo", () => {
    expect(knowledgeRoute).toContain("eq(assetsTable.ownerUserId, userId)");
    expect(knowledgeRoute).toContain('eq(assetsTable.state, "ready")');
    expect(knowledgeRoute).toContain('logo.mimeType.startsWith("image/")');
    expect(knowledgeRoute).toContain("Choose an image from your asset library for the brand logo.");
  });

  it("teaches Zero to discover and place the account logo instead of linking a private URL", () => {
    expect(knowledgeRoute).toContain("Keep brand colours and fonts in shared theme tokens");
    expect(knowledgeRoute).toContain("Use list_uploads, then place_upload");
    expect(agentLoop).toContain('name: "place_upload"');
    expect(agentLoop).toContain("never link a private /api/assets URL from the app");
    expect(agentLoop).toContain("sql`${assetsTable.context}->>'brandRole' = 'logo'`");
  });

  it("places the logo through the same transactional project-history path as every upload", () => {
    expect(assetRoute).toContain("export async function materializeProjectAsset");
    expect(agentLoop).toContain('await import("../routes/assets")');
    expect(agentLoop).toContain("await materializeProjectAsset({");
    const method = assetAst.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === "materializeProjectAsset",
    );
    if (!method?.body) throw new Error("Missing materializeProjectAsset implementation");
    expectTransactionalWrites(method.body, ["lifecycleResponse", "input.projectId"]);
  });
});
